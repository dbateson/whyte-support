import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify App Proxy: Shopify forwards whytebikes.com/apps/support/* to us and
 * signs the query string with the app's API secret. The signature covers every
 * parameter except "signature", sorted, as key=value joined with nothing in
 * between (repeated keys' values joined by commas).
 */
export function verifyProxySignature(params: URLSearchParams, apiSecret: string): boolean {
  const signature = params.get("signature");
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) {
    if (k === "signature") continue;
    grouped.set(k, [...(grouped.get(k) ?? []), v]);
  }
  const message = [...grouped.entries()]
    .map(([k, vs]) => `${k}=${vs.join(",")}`)
    .sort()
    .join("");
  const expected = createHmac("sha256", apiSecret).update(message).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** App Proxy requests carry a timestamp; refuse ones older than 5 minutes (replays). */
export function proxyTimestampFresh(params: URLSearchParams, now = Date.now()): boolean {
  const ts = Number(params.get("timestamp"));
  return Number.isFinite(ts) && Math.abs(now / 1000 - ts) < 300;
}

/**
 * A short-lived token naming the signed-in Shopify customer, handed to the
 * form inside the proxied page and sent back with the submission.
 * key: a server-only secret (derived from the encryption key).
 */
export function issueCustomerToken(customerId: string, key: Buffer, ttlMs = 2 * 60 * 60 * 1000, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ cid: customerId, exp: now + ttlMs })).toString("base64url");
  const sig = createHmac("sha256", key).update(`shopify-customer:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

export function readCustomerToken(token: string | undefined, key: Buffer, now = Date.now()): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", key).update(`shopify-customer:${payload}`).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { cid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { cid?: string; exp?: number };
    if (!cid || !/^\d{1,20}$/.test(cid) || !exp || exp < now) return null;
    return cid;
  } catch {
    return null;
  }
}
