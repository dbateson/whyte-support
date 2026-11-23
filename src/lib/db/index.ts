import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | undefined;
let instance: Db | undefined;

/** One pooled connection per server instance, opened on first use. */
export function db(): Db {
  if (!instance) {
    client = postgres(env().DATABASE_URL, {
      max: 5,
      // Supabase's transaction pooler doesn't support prepared statements.
      prepare: false,
    });
    instance = drizzle(client, { schema });
  }
  return instance;
}

export { schema };
