import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { KeyRing } from "./crypto";
import { schema, type Db } from "./db";
import { clearSecret, getSecret, listSecretStatus, reencryptSecrets, setSecret } from "./secrets";

// Runs against a real Postgres with migrations applied (CI provides one).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("secrets store", () => {
  const client = postgres(url ?? "", { max: 1, onnotice: () => {} });
  const database = drizzle(client, { schema }) as unknown as Db;
  const k1 = randomBytes(32);
  const ring1: KeyRing = { current: { version: 1, key: k1 } };
  const actor = { label: "Test admin" };

  beforeEach(async () => {
    await client`truncate integration_secrets, audit_log`;
  });
  afterAll(async () => {
    await client.end();
  });

  it("stores only ciphertext and returns the value to the server", async () => {
    await setSecret("anthropic.api_key", "  sk-ant-api03-thisisatestkey9876  ", actor, database, ring1);
    const [row] = await client`select ciphertext, hint, key_version from integration_secrets`;
    expect(row?.ciphertext).not.toContain("sk-ant");
    expect(row?.hint).toBe("9876");
    expect(await getSecret("anthropic.api_key", database, ring1)).toBe("sk-ant-api03-thisisatestkey9876");
  });

  it("gives no hint for short values", async () => {
    await setSecret("zoho.client_id", "short-id", actor, database, ring1);
    const status = await listSecretStatus(database);
    expect(status.find((s) => s.name === "zoho.client_id")).toMatchObject({ configured: true, hint: null });
  });

  it("lists every registered secret without values", async () => {
    await setSecret("voyage.api_key", "pa-0123456789abcdefghij", actor, database, ring1);
    const status = await listSecretStatus(database);
    expect(status.length).toBeGreaterThan(5);
    expect(JSON.stringify(status)).not.toContain("pa-0123");
    expect(status.find((s) => s.name === "anthropic.api_key")?.configured).toBe(false);
  });

  it("audits changes without recording values", async () => {
    await setSecret("email.server_token", "server-token-value-123456", actor, database, ring1);
    await clearSecret("email.server_token", actor, database);
    const rows = await client`select action, target, detail::text from audit_log order by id`;
    expect(rows.map((r) => r.action)).toEqual(["secret.set", "secret.clear"]);
    expect(JSON.stringify(rows)).not.toContain("server-token-value");
    expect(await getSecret("email.server_token", database, ring1)).toBeNull();
  });

  it("re-encrypts values onto the new key after a rotation", async () => {
    await setSecret("shopify.api_secret", "shopify-secret-value-xyz", actor, database, ring1);
    const ring2: KeyRing = { current: { version: 2, key: randomBytes(32) }, previous: [{ version: 1, key: k1 }] };
    expect(await reencryptSecrets(actor, database, ring2)).toBe(1);
    expect(await reencryptSecrets(actor, database, ring2)).toBe(0);
    expect(await getSecret("shopify.api_secret", database, { current: ring2.current })).toBe("shopify-secret-value-xyz");
  });

  it("refuses blank values", async () => {
    await expect(setSecret("turnstile.secret_key", "   ", actor, database, ring1)).rejects.toThrow();
  });
});
