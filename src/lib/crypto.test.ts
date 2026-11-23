import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, keyRingFromEnv, keyVersionOf, type KeyRing } from "./crypto";

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ring1: KeyRing = { current: { version: 1, key: k1 } };
const ring2: KeyRing = { current: { version: 2, key: k2 }, previous: [{ version: 1, key: k1 }] };

describe("crypto", () => {
  it("round-trips a value", () => {
    const stored = encrypt("sk-ant-example-123", "anthropic.api_key", ring1);
    expect(stored).not.toContain("sk-ant");
    expect(decrypt(stored, "anthropic.api_key", ring1)).toBe("sk-ant-example-123");
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("same", "n", ring1)).not.toBe(encrypt("same", "n", ring1));
  });

  it("rejects a ciphertext moved to another secret's name", () => {
    const stored = encrypt("value", "zoho.client_secret", ring1);
    expect(() => decrypt(stored, "anthropic.api_key", ring1)).toThrow();
  });

  it("rejects tampering", () => {
    const stored = encrypt("value", "n", ring1);
    const parts = stored.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64url");
    expect(() => decrypt(parts.join("."), "n", ring1)).toThrow();
  });

  it("decrypts values on the previous key during a rotation", () => {
    const old = encrypt("value", "n", ring1);
    expect(keyVersionOf(old)).toBe(1);
    expect(decrypt(old, "n", ring2)).toBe("value");
    expect(keyVersionOf(encrypt("value", "n", ring2))).toBe(2);
  });

  it("fails clearly without the key a value needs", () => {
    const stored = encrypt("value", "n", ring2);
    expect(() => decrypt(stored, "n", ring1)).toThrow("No encryption key for version 2");
  });

  it("builds a key ring from the environment", () => {
    const ring = keyRingFromEnv({
      APP_ENCRYPTION_KEY: k2.toString("base64"),
      APP_ENCRYPTION_KEY_VERSION: 2,
      APP_ENCRYPTION_KEY_PREVIOUS: k1.toString("base64"),
    });
    expect(ring.current.version).toBe(2);
    expect(ring.previous?.[0]?.version).toBe(1);
  });
});
