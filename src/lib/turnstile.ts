import "server-only";
import { log } from "./logger";
import { getSecret } from "./secrets";

export type TurnstileResult = "passed" | "failed" | "not-configured";

/**
 * Checks a Cloudflare Turnstile token. Without a secret key (not set up yet)
 * it reports "not-configured" and the caller decides; the rate limits still apply.
 */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<TurnstileResult> {
  const secret = await getSecret("turnstile.secret_key");
  if (!secret) return "not-configured";
  if (!token) return "failed";
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const body = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!body.success) log.info("Turnstile check failed", { codes: body["error-codes"] });
    return body.success ? "passed" : "failed";
  } catch (err) {
    log.error("Turnstile unreachable", { err });
    // Fail open on a Cloudflare outage: the rate limits and honeypot still stand.
    return "passed";
  }
}
