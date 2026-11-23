import "server-only";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { hashKey } from "./auth/tokens";
import { db, schema } from "./db";

/**
 * Counts a hit and says whether it's within the limit (a sliding window).
 * Keys are hashed before they're stored.
 */
export async function allow(bucket: string, rawKey: string, limit: number, windowMs: number): Promise<boolean> {
  const key = hashKey(bucket, rawKey);
  const since = new Date(Date.now() - windowMs);
  const [row] = await db()
    .select({ n: count() })
    .from(schema.rateLimitEvents)
    .where(and(eq(schema.rateLimitEvents.bucket, bucket), eq(schema.rateLimitEvents.key, key), gt(schema.rateLimitEvents.at, since)));
  if ((row?.n ?? 0) >= limit) return false;
  await db().insert(schema.rateLimitEvents).values({ bucket, key });
  return true;
}

export async function purgeRateLimits() {
  await db().delete(schema.rateLimitEvents).where(lt(schema.rateLimitEvents.at, new Date(Date.now() - 24 * 60 * 60 * 1000)));
}
