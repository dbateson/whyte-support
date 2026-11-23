import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { SETTINGS, type SettingKey } from "./integrations";
import type { Actor } from "./secrets";

/** Non-secret settings, with registry defaults for anything not saved yet. */
export async function getSettings<K extends SettingKey>(keys: readonly K[]): Promise<Record<K, string>> {
  const rows = await db().select().from(schema.appSettings).where(inArray(schema.appSettings.key, keys as unknown as string[]));
  const saved = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(keys.map((k) => [k, typeof saved.get(k) === "string" ? (saved.get(k) as string) : SETTINGS[k]])) as Record<K, string>;
}

export async function getSetting(key: SettingKey): Promise<string> {
  return (await getSettings([key]))[key];
}

/** Saves settings and records which keys changed (values too: these aren't secret). */
export async function saveSettings(values: Partial<Record<SettingKey, string>>, actor: Actor): Promise<void> {
  const entries = Object.entries(values) as [SettingKey, string][];
  if (entries.length === 0) return;
  const before = await getSettings(entries.map(([k]) => k));
  const changed = entries.filter(([k, v]) => before[k] !== v);
  if (changed.length === 0) return;
  await db().transaction(async (tx) => {
    for (const [key, value] of changed) {
      await tx
        .insert(schema.appSettings)
        .values({ key, value, updatedBy: actor.id ?? null })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedBy: actor.id ?? null, updatedAt: sql`now()` } });
    }
    await tx.insert(schema.auditLog).values({
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: "settings.update",
      detail: Object.fromEntries(changed.map(([k, v]) => [k, { from: before[k], to: v }])),
    });
  });
}
