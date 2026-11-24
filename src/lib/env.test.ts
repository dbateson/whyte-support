import { describe, expect, it } from "vitest";
import { databaseUrl } from "./env";

describe("database address", () => {
  it("prefers DATABASE_URL, falls back to the Supabase integration's POSTGRES_URL, and drops driver-unsafe parameters", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a:b@h:5432/db", POSTGRES_URL: "postgres://x@y/z" })).toBe("postgres://a:b@h:5432/db");
    expect(databaseUrl({ POSTGRES_URL: "postgres://u:p@pooler.example:6543/postgres?sslmode=require&supa=base-pooler.x&pgbouncer=true" })).toBe(
      "postgres://u:p@pooler.example:6543/postgres?sslmode=require",
    );
    expect(databaseUrl({})).toBeUndefined();
  });
});
