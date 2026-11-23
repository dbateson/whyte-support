import { afterEach, describe, expect, it, vi } from "vitest";
import { log, redact, redactString, registerSecretValue } from "./logger";

describe("logger redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces sensitive fields wholesale", () => {
    expect(redact({ apiKey: "abc", headers: { Authorization: "Bearer x" }, refresh_token: "y", name: "Zoho" })).toEqual({
      apiKey: "[redacted]",
      headers: { Authorization: "[redacted]" },
      refresh_token: "[redacted]",
      name: "Zoho",
    });
  });

  it("masks credential shapes in free text", () => {
    const out = redactString(
      "failed with sk-ant-api03-abcdefgh1234 and Bearer abc.def.ghi123 and 1000.0123456789abcdef0123.fedcba9876543210fedc",
    );
    expect(out).not.toMatch(/sk-ant-api03|abc\.def|1000\.0123/);
  });

  it("masks any registered secret value whatever its shape", () => {
    registerSecretValue("plain-looking-value-42");
    expect(redactString("upstream said plain-looking-value-42 was invalid")).toBe("upstream said [redacted] was invalid");
  });

  it("partly masks email addresses", () => {
    expect(redactString("ticket from jane.doe@example.co.uk")).toBe("ticket from j***@example.co.uk");
  });

  it("redacts errors and context on the way out", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("Zoho call failed", { err: new Error("token sk-ant-zzzzzzzzzz1 rejected"), accessToken: "t" });
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).not.toContain("sk-ant-zzzz");
    expect(JSON.parse(line).accessToken).toBe("[redacted]");
  });
});
