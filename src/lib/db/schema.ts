import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tables in the order they arrived. KB, chat and sync tables come with their phases.
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

/* ============================================================
   Phase 1: staff, roles, sessions; contacts and tickets.
   ============================================================ */

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const SEGMENTS = ["b2c", "b2b"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Staff who sign in to the admin. Customers have no accounts. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    name: text("name").notNull(),
    /** invited: hasn't set a password yet. disabled: can't sign in; sessions ended. */
    status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
    passwordHash: text("password_hash"),
    /** TOTP secret, encrypted like integration secrets (AAD "totp:<user id>"). */
    totpSecret: text("totp_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** The time step of the last accepted code, so a code can't be used twice. */
    totpLastStep: integer("totp_last_step"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/** A named set of permissions over one or both segments. Admins edit these. */
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  /** Which segments the role's ticket and knowledge-base permissions cover. */
  segments: text("segments").array().notNull().default(sql`'{b2c,b2b}'::text[]`),
  /** Seeded roles can be edited but not deleted; Admin keeps every permission. */
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/** Signed-in sessions. The cookie holds a random token; only its SHA-256 is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null until the second factor is passed; until then the session can only finish sign-in. */
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One-time links: accept an invitation, reset a password. Only the token's hash is stored. */
export const authTokens = pgTable("auth_tokens", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose", { enum: ["invite", "reset"] }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Sign-in attempts, for rate limiting. Keys are hashes, never raw emails or IPs. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    emailKey: text("email_key").notNull(),
    ipKey: text("ip_key").notNull(),
    success: boolean("success").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_email_idx").on(t.emailKey, t.at), index("login_attempts_ip_idx").on(t.ipKey, t.at)],
);

/** Customers and dealer staff who contact support. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email"),
    name: text("name").notNull().default(""),
    phone: text("phone"),
    segment: text("segment", { enum: SEGMENTS }).notNull().default("b2c"),
    /** Dealers: the business name. */
    companyName: text("company_name"),
    zohoContactId: text("zoho_contact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when erased on request (GDPR): personal fields are blanked, statistics kept. */
    anonymisedAt: timestamp("anonymised_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("contacts_email_key").on(t.email).where(sql`${t.email} is not null`)],
);

export const TICKET_STATUSES = ["new", "open", "pending_customer", "pending_internal", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_SOURCES = ["form", "chat", "email", "zoho", "staff"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Shown to people as WS-<number>. */
    number: integer("number").notNull().unique().generatedAlwaysAsIdentity({ startWith: 10001 }),
    segment: text("segment", { enum: SEGMENTS }).notNull(),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("new"),
    priority: text("priority", { enum: TICKET_PRIORITIES }).notNull().default("normal"),
    category: text("category"),
    subject: text("subject").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: TICKET_SOURCES }).notNull(),
    productModel: text("product_model"),
    frameNumber: text("frame_number"),
    purchaseDate: date("purchase_date"),
    zohoCaseId: text("zoho_case_id"),
    /** Random; part of the reply-to address so inbound replies find their ticket. */
    replyToken: text("reply_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Maintained by a trigger: subject, reference, frame number, contact and every message. */
    searchVector: tsvector("search_vector"),
  },
  (t) => [
    index("tickets_queue_idx").on(t.segment, t.status, t.updatedAt),
    index("tickets_assignee_idx").on(t.assigneeId, t.status),
    index("tickets_contact_idx").on(t.contactId),
    index("tickets_search_idx").using("gin", t.searchVector),
  ],
);

export const MESSAGE_AUTHORS = ["customer", "agent", "assistant", "system"] as const;
export const MESSAGE_CHANNELS = ["email", "web", "chat", "zoho", "staff"] as const;

/** A ticket's thread: everything said, oldest first. */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    authorType: text("author_type", { enum: MESSAGE_AUTHORS }).notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Name at the time, so the thread reads right after a user is removed. */
    authorName: text("author_name").notNull().default(""),
    body: text("body").notNull(),
    /** Staff-only note. Never emailed, never shown to customers or the bot. */
    internal: boolean("internal").notNull().default(false),
    channel: text("channel", { enum: MESSAGE_CHANNELS }).notNull(),
    /** RFC 5322 Message-ID: ours for outbound mail, the sender's for inbound. */
    emailMessageId: text("email_message_id"),
    emailStatus: text("email_status", { enum: ["sending", "sent", "failed"] }),
    emailError: text("email_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ticket_messages_ticket_idx").on(t.ticketId, t.createdAt),
    uniqueIndex("ticket_messages_email_id_key").on(t.emailMessageId).where(sql`${t.emailMessageId} is not null`),
  ],
);

/** Changes to a ticket, shown between its messages. */
export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull(),
    type: text("type", { enum: ["created", "status", "priority", "assignee", "segment", "category", "reopened"] }).notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.createdAt)],
);
