import "server-only";
import { and, count, eq, gt } from "drizzle-orm";
import { db, schema } from "../db";
import { hashKey } from "./tokens";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

/** Whether sign-in is paused for this email or address after too many failures. */
export async function signInBlocked(email: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const failures = (column: typeof schema.loginAttempts.emailKey | typeof schema.loginAttempts.ipKey, key: string) =>
    db()
      .select({ n: count() })
      .from(schema.loginAttempts)
      .where(and(eq(column, key), eq(schema.loginAttempts.success, false), gt(schema.loginAttempts.at, since)))
      .then((r) => r[0]?.n ?? 0);
  const [byEmail, byIp] = await Promise.all([
    failures(schema.loginAttempts.emailKey, hashKey("email", email)),
    failures(schema.loginAttempts.ipKey, hashKey("ip", ip)),
  ]);
  return byEmail >= MAX_PER_EMAIL || byIp >= MAX_PER_IP;
}

export async function recordSignIn(email: string, ip: string, success: boolean): Promise<void> {
  await db().insert(schema.loginAttempts).values({ emailKey: hashKey("email", email), ipKey: hashKey("ip", ip), success });
}
