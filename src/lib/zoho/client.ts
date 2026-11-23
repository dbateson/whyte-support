import "server-only";
import { sql } from "drizzle-orm";
import { decrypt, encrypt, keyRingFromEnv } from "../crypto";
import { db } from "../db";
import { env } from "../env";
import { log, registerSecretValue } from "../logger";
import { getSecret } from "../secrets";
import { getSettings } from "../settings";
import { ZOHO_ACCOUNTS_DOMAINS, ZOHO_API_DOMAIN } from "./mapping";
import { clearState, readState, writeState } from "./state";

/**
 * Zoho CRM REST API (v8). Credentials come from the encrypted store; the
 * short-lived access token is cached in the database, encrypted, so every
 * server instance shares it (Zoho allows only 10 new tokens per 10 minutes).
 */

export const ZOHO_SCOPES = [
  "ZohoCRM.modules.contacts.ALL",
  "ZohoCRM.modules.accounts.READ",
  "ZohoCRM.modules.cases.ALL",
  "ZohoCRM.modules.notes.ALL",
  // Erasure requests become a task in Zoho for someone to act on (Zoho owns its own records).
  "ZohoCRM.modules.tasks.CREATE",
  "ZohoCRM.notifications.ALL",
  "ZohoCRM.settings.fields.READ",
];

export class ZohoNotConfiguredError extends Error {
  constructor() {
    super("Zoho CRM isn't connected. Add the client ID and secret in Settings → Integrations, then connect it in Settings → Zoho.");
  }
}

export class ZohoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Worth trying again later: rate limits, Zoho outages, network trouble. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface CachedToken {
  token: string;
  apiDomain: string;
  expiresAt: number;
}

const TOKEN_KEY = "zoho.access_token";
const ring = () => keyRingFromEnv(env());

async function credentials() {
  const [clientId, clientSecret, refreshToken] = await Promise.all([getSecret("zoho.client_id"), getSecret("zoho.client_secret"), getSecret("zoho.refresh_token")]);
  const s = await getSettings(["zoho.accounts_domain", "zoho.api_domain"]);
  const accountsDomain = s["zoho.accounts_domain"].replace(/\/$/, "");
  const apiDomain = s["zoho.api_domain"].replace(/\/$/, "");
  // Credentials only ever go to Zoho's own servers, whatever the settings say.
  if (!ZOHO_ACCOUNTS_DOMAINS.includes(accountsDomain) || !ZOHO_API_DOMAIN.test(apiDomain)) throw new ZohoError("The Zoho data centre setting isn't a Zoho address.", "BAD_DOMAIN", 0, false);
  return { clientId, clientSecret, refreshToken, accountsDomain, apiDomain };
}

export async function zohoConnected(): Promise<boolean> {
  const c = await credentials();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
}

/** Zoho's token endpoint: used to refresh, and to swap a sign-in code for a refresh token. */
async function tokenRequest(accountsDomain: string, params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(`${accountsDomain}/oauth/v2/token`, { method: "POST", body: new URLSearchParams(params) });
  } catch {
    throw new ZohoError("Couldn't reach Zoho's sign-in server.", "NETWORK", 0, true);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; api_domain?: string; error?: string };
  if (!res.ok || !body.access_token) {
    const code = body.error ?? `HTTP_${res.status}`;
    // "Access Denied" is Zoho's throttle on new tokens; anything else (invalid_code, invalid_client) needs a person.
    throw new ZohoError(`Zoho refused the sign-in (${code}).`, code, res.status, code === "Access Denied" || res.status >= 500);
  }
  registerSecretValue(body.access_token);
  if (body.refresh_token) registerSecretValue(body.refresh_token);
  return body as { access_token: string; refresh_token?: string; expires_in?: number; api_domain?: string };
}

/** Swaps the code from Zoho's consent screen for a refresh token. */
export async function exchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; apiDomain?: string }> {
  const c = await credentials();
  if (!c.clientId || !c.clientSecret) throw new ZohoNotConfiguredError();
  const t = await tokenRequest(c.accountsDomain, { grant_type: "authorization_code", client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, code });
  if (!t.refresh_token) throw new ZohoError("Zoho didn't return a refresh token. Disconnect the app in Zoho's Connected Apps and try again.", "NO_REFRESH_TOKEN", 400, false);
  await clearState(TOKEN_KEY);
  return { refreshToken: t.refresh_token, apiDomain: t.api_domain };
}

async function accessToken(force = false): Promise<CachedToken> {
  if (!force) {
    const cached = await readCachedToken();
    if (cached) return cached;
  }
  // One refresh at a time across every instance: a transaction-scoped advisory lock.
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('zoho-token'))`);
    if (!force) {
      const again = await readCachedToken();
      if (again) return again;
    }
    const c = await credentials();
    if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new ZohoNotConfiguredError();
    const t = await tokenRequest(c.accountsDomain, { grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken });
    const offered = (t.api_domain ?? "").replace(/\/$/, "");
    const fresh: CachedToken = { token: t.access_token, apiDomain: ZOHO_API_DOMAIN.test(offered) ? offered : c.apiDomain, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    await writeState(TOKEN_KEY, { sealed: encrypt(JSON.stringify(fresh), "zoho:access-token", ring()) });
    return fresh;
  });
}

async function readCachedToken(): Promise<CachedToken | null> {
  const stored = await readState<{ sealed: string }>(TOKEN_KEY);
  if (!stored) return null;
  try {
    const t = JSON.parse(decrypt(stored.sealed, "zoho:access-token", ring())) as CachedToken;
    if (t.expiresAt - Date.now() < 5 * 60 * 1000) return null;
    registerSecretValue(t.token);
    return t;
  } catch {
    return null;
  }
}

export async function forgetAccessToken() {
  await clearState(TOKEN_KEY);
}

export interface ZohoRequest {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A call to /crm/v8. Returns null for 204 (no content). */
export async function zoho<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, req: ZohoRequest = {}): Promise<T | null> {
  let token = await accessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(`${token.apiDomain}/crm/v8${path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Zoho-oauthtoken ${token.token}`, ...(req.body ? { "content-type": "application/json" } : {}), ...req.headers },
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
    } catch {
      throw new ZohoError("Couldn't reach Zoho.", "NETWORK", 0, true);
    }
    if (res.status === 204 || res.status === 304) return null;
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string; status?: string } | null;
    if (res.ok) return body as T;
    const code = body?.code ?? `HTTP_${res.status}`;
    if (res.status === 401 && code === "INVALID_OAUTHTOKEN" && attempt === 0) {
      token = await accessToken(true);
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500 || code === "TOO_MANY_REQUESTS";
    if (!retryable) log.warn("Zoho request failed", { method, path, status: res.status, code });
    throw new ZohoError(`Zoho: ${body?.message ?? code} (${code})`, code, res.status, retryable);
  }
  throw new ZohoError("Zoho kept rejecting the access token.", "INVALID_OAUTHTOKEN", 401, false);
}

/** Zoho write responses: one entry per record, in order. Throws on the first failure. */
export interface WriteResult {
  code: string;
  status: string;
  message: string;
  details: { id?: string; api_name?: string; [k: string]: unknown };
  action?: string;
}

export function firstSuccess(res: { data?: WriteResult[] } | null, what: string): string {
  const r = res?.data?.[0];
  if (!r || r.status !== "success" || !r.details.id) {
    const field = r?.details.api_name ? ` (field ${r.details.api_name})` : "";
    throw new ZohoError(`Zoho didn't accept the ${what}: ${r?.message ?? "no response"}${field}`, r?.code ?? "UNKNOWN", 400, false);
  }
  return r.details.id;
}
