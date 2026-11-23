import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Liveness and configuration check for uptime monitoring. Reports states, never values. */
export async function GET() {
  let config = "ok";
  let database = "ok";
  try {
    env();
  } catch (err) {
    config = "invalid";
    log.error("Health: bootstrap configuration invalid", { err });
  }
  if (config === "ok") {
    try {
      await db().execute(sql`select 1`);
    } catch (err) {
      database = "unreachable";
      log.error("Health: database unreachable", { err });
    }
  } else {
    database = "unknown";
  }
  const ok = config === "ok" && database === "ok";
  return Response.json({ ok, config, database }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
