import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for values stored at rest (integration keys and tokens).
 *
 * AES-256-GCM with a fresh 96-bit IV per value. The secret's name is bound in
 * as additional authenticated data, so a ciphertext copied onto another row
 * fails to decrypt. Stored form: `v<keyVersion>.<iv>.<tag>.<ciphertext>`, each
 * part base64url.
 */

export interface KeyRing {
  /** The key new values are encrypted with. */
  current: { version: number; key: Buffer };
  /** Older keys, still accepted for decryption during a rotation. */
  previous?: { version: number; key: Buffer }[];
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export function encrypt(plaintext: string, aad: string, ring: KeyRing): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, ring.current.key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [`v${ring.current.version}`, iv, tag, ciphertext]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decrypt(stored: string, aad: string, ring: KeyRing): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || !parts[0]?.startsWith("v")) throw new Error("Malformed encrypted value");
  const version = Number(parts[0].slice(1));
  const key = keyFor(version, ring);
  const [iv, tag, ciphertext] = parts.slice(1).map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** The key version a stored value was encrypted with, for re-encryption after a rotation. */
export function keyVersionOf(stored: string): number {
  const v = Number(stored.split(".")[0]?.slice(1));
  if (!Number.isInteger(v)) throw new Error("Malformed encrypted value");
  return v;
}

function keyFor(version: number, ring: KeyRing): Buffer {
  if (version === ring.current.version) return ring.current.key;
  const old = ring.previous?.find((k) => k.version === version);
  if (!old) throw new Error(`No encryption key for version ${version}`);
  return old.key;
}

/** Builds the key ring from the bootstrap environment. */
export function keyRingFromEnv(e: {
  APP_ENCRYPTION_KEY: string;
  APP_ENCRYPTION_KEY_VERSION: number;
  APP_ENCRYPTION_KEY_PREVIOUS?: string;
}): KeyRing {
  const ring: KeyRing = {
    current: { version: e.APP_ENCRYPTION_KEY_VERSION, key: Buffer.from(e.APP_ENCRYPTION_KEY, "base64") },
  };
  if (e.APP_ENCRYPTION_KEY_PREVIOUS) {
    ring.previous = [{ version: e.APP_ENCRYPTION_KEY_VERSION - 1, key: Buffer.from(e.APP_ENCRYPTION_KEY_PREVIOUS, "base64") }];
  }
  return ring;
}
