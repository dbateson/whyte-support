import "server-only";
import { eq, sql } from "drizzle-orm";
import { decrypt, encrypt, keyRingFromEnv, keyVersionOf, type KeyRing } from "./crypto";
import { db, schema, type Db } from "./db";
import { env } from "./env";
import { SECRETS, isSecretName, type SecretName } from "./integrations";
import { registerSecretValue } from "./logger";

/** Who made a change, for the audit log. */
export interface Actor {
  id?: string;
  label: string;
}

/** What the settings screen may show about a secret. Never the value. */
export interface SecretStatus {
  name: SecretName;
  integration: string;
  label: string;
  configured: boolean;
  hint: string | null;
  updatedAt: Date | null;
}

const HINT_MIN_LENGTH = 20;

function ring(): KeyRing {
  return keyRingFromEnv(env());
}

/** Decrypts a secret for server-side use. Returns null when it hasn't been set. */
export async function getSecret(name: SecretName, database: Db = db(), keys: KeyRing = ring()): Promise<string | null> {
  const [row] = await database
    .select({ ciphertext: schema.integrationSecrets.ciphertext })
    .from(schema.integrationSecrets)
    .where(eq(schema.integrationSecrets.name, name));
  if (!row) return null;
  const value = decrypt(row.ciphertext, name, keys);
  registerSecretValue(value);
  return value;
}

/** Encrypts and stores a secret, and records the change (not the value) in the audit log. */
export async function setSecret(
  name: SecretName,
  value: string,
  actor: Actor,
  database: Db = db(),
  keys: KeyRing = ring(),
): Promise<void> {
  if (!isSecretName(name)) throw new Error("Unknown secret");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A secret can't be blank; clear it instead");
  const ciphertext = encrypt(trimmed, name, keys);
  const hint = trimmed.length >= HINT_MIN_LENGTH ? trimmed.slice(-4) : null;
  await database.transaction(async (tx) => {
    await tx
      .insert(schema.integrationSecrets)
      .values({ name, ciphertext, keyVersion: keys.current.version, hint, updatedBy: actor.id ?? null })
      .onConflictDoUpdate({
        target: schema.integrationSecrets.name,
        set: { ciphertext, keyVersion: keys.current.version, hint, updatedBy: actor.id ?? null, updatedAt: sql`now()` },
      });
    await tx.insert(schema.auditLog).values({
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: "secret.set",
      target: name,
    });
  });
}

export async function clearSecret(name: SecretName, actor: Actor, database: Db = db()): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(schema.integrationSecrets).where(eq(schema.integrationSecrets.name, name));
    await tx.insert(schema.auditLog).values({ actorId: actor.id ?? null, actorLabel: actor.label, action: "secret.clear", target: name });
  });
}

/** The status of every registered secret, for the settings screen. */
export async function listSecretStatus(database: Db = db()): Promise<SecretStatus[]> {
  const rows = await database
    .select({ name: schema.integrationSecrets.name, hint: schema.integrationSecrets.hint, updatedAt: schema.integrationSecrets.updatedAt })
    .from(schema.integrationSecrets);
  const byName = new Map(rows.map((r) => [r.name, r]));
  return (Object.keys(SECRETS) as SecretName[]).map((name) => {
    const row = byName.get(name);
    return {
      name,
      integration: SECRETS[name].integration,
      label: SECRETS[name].label,
      configured: Boolean(row),
      hint: row?.hint ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/** After a key rotation: re-encrypts every value still on an old key. Returns how many changed. */
export async function reencryptSecrets(actor: Actor, database: Db = db(), keys: KeyRing = ring()): Promise<number> {
  const rows = await database.select().from(schema.integrationSecrets);
  let changed = 0;
  for (const row of rows) {
    if (keyVersionOf(row.ciphertext) === keys.current.version) continue;
    const value = decrypt(row.ciphertext, row.name, keys);
    await database
      .update(schema.integrationSecrets)
      .set({ ciphertext: encrypt(value, row.name, keys), keyVersion: keys.current.version })
      .where(eq(schema.integrationSecrets.name, row.name));
    changed++;
  }
  if (changed) {
    await database.insert(schema.auditLog).values({
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: "secret.reencrypt",
      detail: { count: changed, keyVersion: keys.current.version },
    });
  }
  return changed;
}
