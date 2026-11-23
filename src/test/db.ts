import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * For tests that use the app's own db(): point it at the test database and
 * give it an encryption key. Call at the top of the test file, before any
 * test runs (the app reads the environment lazily).
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function useTestDatabase() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  const sql = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  const reset = () =>
    sql`truncate chat_answer_sources, chat_messages, chat_sessions, ingest_items, ingest_jobs, kb_sources, kb_chunks, kb_article_versions, kb_articles, rate_limit_events, ticket_attachments, ticket_events, ticket_messages, tickets, contacts, sessions, auth_tokens, login_attempts, user_roles, users, audit_log, app_settings, integration_secrets restart identity cascade`;
  return { sql, reset };
}
