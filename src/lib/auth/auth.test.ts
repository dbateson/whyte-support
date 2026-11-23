import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, verifyTotp } from "./totp";

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(stored);
  });

  it("explains weak passwords", () => {
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("aaaaaaaaaaaaaaa")).toMatch(/repeat/);
    expect(passwordProblem("jo.smith-is-great", "jo.smith@whyte.bike")).toMatch(/email/);
    expect(passwordProblem("a long enough passphrase")).toBeNull();
  });
});

describe("TOTP", () => {
  // RFC 4226 appendix D and RFC 6238 appendix B (SHA-1).
  const rfcSecret = Buffer.from("12345678901234567890");

  it("matches the RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, i) => expect(hotp(rfcSecret, i)).toBe(code));
  });

  it("matches the RFC 6238 TOTP vectors", () => {
    const b32 = base32Encode(rfcSecret);
    expect(totpAt(b32, 59_000, 8)).toBe("94287082");
    expect(totpAt(b32, 1111111109_000, 8)).toBe("07081804");
    expect(totpAt(b32, 2000000000_000, 8)).toBe("69279037");
  });

  it("round-trips base32", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  it("accepts the current code and one step of drift, nothing more", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    expect(verifyTotp(s, totpAt(s, now), now)).toBe(Math.floor(now / 30000));
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(s, totpAt(s, now - 90_000), now)).toBeNull();
    expect(verifyTotp(s, "12345", now)).toBeNull();
    expect(verifyTotp(s, "abcdef", now)).toBeNull();
  });

  it("builds an otpauth address", () => {
    expect(otpauthUri("ABC", "jo@whyte.bike")).toBe(
      "otpauth://totp/Whyte%20Support%3Ajo%40whyte.bike?secret=ABC&issuer=Whyte%20Support&algorithm=SHA1&digits=6&period=30",
    );
  });
});
