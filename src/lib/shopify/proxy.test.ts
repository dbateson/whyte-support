import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueCustomerToken, proxyTimestampFresh, readCustomerToken, verifyProxySignature } from "./proxy";

describe("App Proxy signature", () => {
  // The worked example from Shopify's App Proxy documentation (secret "hush").
  const query =
    "extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb";

  it("accepts Shopify's documented example", () => {
    expect(verifyProxySignature(new URLSearchParams(query), "hush")).toBe(true);
  });

  it("rejects a changed parameter, a wrong secret or no signature", () => {
    expect(verifyProxySignature(new URLSearchParams(query.replace("customer_id=1", "customer_id=2")), "hush")).toBe(false);
    expect(verifyProxySignature(new URLSearchParams(query), "nope")).toBe(false);
    expect(verifyProxySignature(new URLSearchParams("shop=x&timestamp=1"), "hush")).toBe(false);
  });

  it("refuses stale timestamps", () => {
    const now = 1_800_000_000_000;
    expect(proxyTimestampFresh(new URLSearchParams(`timestamp=${now / 1000 - 60}`), now)).toBe(true);
    expect(proxyTimestampFresh(new URLSearchParams(`timestamp=${now / 1000 - 600}`), now)).toBe(false);
    expect(proxyTimestampFresh(new URLSearchParams(""), now)).toBe(false);
  });
});

describe("customer token", () => {
  const key = randomBytes(32);
  it("round-trips, expires and resists tampering", () => {
    const now = 1_800_000_000_000;
    const t = issueCustomerToken("12345", key, 1000, now);
    expect(readCustomerToken(t, key, now)).toBe("12345");
    expect(readCustomerToken(t, key, now + 2000)).toBeNull();
    expect(readCustomerToken(t, randomBytes(32), now)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ cid: "99", exp: now + 1000 })).toString("base64url");
    expect(readCustomerToken(`${forged}.${sig}`, key, now)).toBeNull();
    expect(readCustomerToken(`${payload}`, key, now)).toBeNull();
    expect(readCustomerToken(undefined, key, now)).toBeNull();
  });
});
