import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";

/** Small JSON values kept between sync runs (cursors, the notification channel, the history import). */
export async function readState<T>(key: string): Promise<T | null> {
  const [row] = await db().select({ value: schema.syncState.value }).from(schema.syncState).where(eq(schema.syncState.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function writeState(key: string, value: unknown): Promise<void> {
  await db()
    .insert(schema.syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: sql`now()` } });
}

export async function clearState(key: string): Promise<void> {
  await db().delete(schema.syncState).where(eq(schema.syncState.key, key));
}

/** A line on the sync health page. Never put personal data in `message`: record ids only. */
export async function logSync(entry: { direction: "in" | "out"; entity: string; message: string; level?: "info" | "warning" | "error"; entityId?: string | null; zohoId?: string | null }) {
  await db()
    .insert(schema.syncLog)
    .values({ direction: entry.direction, entity: entry.entity, message: entry.message.slice(0, 1000), level: entry.level ?? "info", entityId: entry.entityId ?? null, zohoId: entry.zohoId ?? null });
}
