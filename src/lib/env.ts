import { z } from "zod";

/**
 * Bootstrap configuration: the only values read from the environment.
 * Integration keys never live here; they're entered on the admin settings
 * screen and stored encrypted (see `secrets.ts`).
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
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

let cached: Env | undefined;

/** Reads and validates the environment on first use, so builds don't need it. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
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
