import { createHash, randomBytes } from "node:crypto";

/** A random URL-safe token and the SHA-256 we store in its place. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A keyed hash for rate-limit keys, so emails and IPs aren't stored raw. */
export function hashKey(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}
