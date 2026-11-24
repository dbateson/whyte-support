import { z } from "zod";

/**
 * Bootstrap configuration: the only values read from the environment.
 * Integration keys never live here; they're entered on the admin settings
 * screen and stored encrypted (see `secrets.ts`).
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL (or POSTGRES_URL from the Supabase integration) is required"),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, "APP_ENCRYPTION_KEY is required")
    .refine((v) => Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  APP_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY_PREVIOUS must be 32 bytes, base64-encoded"),
});

export type Env = z.infer<typeof schema>;

/**
 * The database address. DATABASE_URL wins; otherwise POSTGRES_URL, which
 * Vercel's Supabase integration sets (the transaction pooler). Query
 * parameters the Postgres driver would forward to the server as settings
 * (Supabase's "supa", "pgbouncer") are removed; sslmode is kept.
 */
export function databaseUrl(source: { DATABASE_URL?: string; POSTGRES_URL?: string }): string | undefined {
  const raw = source.DATABASE_URL || source.POSTGRES_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) if (key !== "sslmode") u.searchParams.delete(key);
    return u.toString();
  } catch {
    return raw;
  }
}

let cached: Env | undefined;

/** Reads and validates the environment on first use, so builds don't need it. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse({ ...process.env, DATABASE_URL: databaseUrl({ DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL }) });
    if (!parsed.success) {
      // List which variables are wrong, never their values.
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment: ${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
