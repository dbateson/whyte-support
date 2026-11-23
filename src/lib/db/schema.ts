import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Phase 0 baseline. Tickets, KB, chat and sync tables arrive with their phases.
 */

/** Integration keys and tokens, encrypted at rest (see lib/crypto.ts). */
export const integrationSecrets = pgTable(
  "integration_secrets",
  {
    /** Registry name, e.g. "anthropic.api_key". Also the AAD for its ciphertext. */
    name: text("name").primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** Last 4 characters, only for values long enough that this gives nothing away. */
    hint: text("hint"),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("integration_secrets_hint_len", sql`${t.hint} is null or char_length(${t.hint}) <= 4`)],
);

/** Non-secret configuration edited on the settings screen (chatbot model, Zoho data centre...). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who did what: settings changes, exports, deletions, permission changes. Append-only. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    /** "system", "cron:zoho-sync", or a staff member's name at the time. */
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    /** Never secret values: names, counts and ids only. */
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_target_idx").on(t.target)],
);
