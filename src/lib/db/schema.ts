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
    /** Dealers: their Whyte trade account number, as they gave it. */
    accountCode: text("account_code"),
    /** Set when the contact was identified through a signed-in Shopify session. */
    shopifyCustomerId: text("shopify_customer_id"),
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
    /** Where the bike was bought: a dealer's name, or whytebikes.com. */
    purchasedFrom: text("purchased_from"),
    orderNumber: text("order_number"),
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

/**
 * Files customers attach (photos, receipts). Stored in private object
 * storage; a row starts "pending" when an upload slot is issued, and becomes
 * "attached" when the form that uploaded it is submitted. Pending rows older
 * than a day are deleted with their objects.
 */
export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => ticketMessages.id, { onDelete: "set null" }),
    /** The object's path in the bucket. Never shown to customers. */
    storageKey: text("storage_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: ["pending", "attached"] }).notNull().default("pending"),
    /** SHA-256 of the submission key the uploader holds; only that submission can attach it. */
    claimHash: text("claim_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
  },
  (t) => [index("ticket_attachments_ticket_idx").on(t.ticketId), index("ticket_attachments_pending_idx").on(t.status, t.createdAt)],
);

/** Hits on public endpoints, for rate limits. Keys are hashes. Rows older than a day are purged. */
export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limit_events_idx").on(t.bucket, t.key, t.at)],
);

/* ============================================================
   Phase 3: knowledge base and ingestion.
   ============================================================ */

const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1024)",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => (typeof v === "string" ? JSON.parse(v) : (v as number[])),
});

/** B2C, B2B, or both: who an article is for. The chatbot only reads what matches the visitor. */
export const KB_AUDIENCES = ["b2c", "b2b", "both"] as const;
export type KbAudience = (typeof KB_AUDIENCES)[number];

/** An article. Its text lives in versions; `publishedVersionId` is what the chatbot reads. */
export const kbArticles = pgTable(
  "kb_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    audience: text("audience", { enum: KB_AUDIENCES }).notNull(),
    category: text("category"),
    /** Live version (null until first published). */
    publishedVersionId: uuid("published_version_id"),
    /** The version being worked on (draft or in review), if any. */
    workingVersionId: uuid("working_version_id"),
    origin: text("origin", { enum: ["manual", "ingestion", "ticket"] }).notNull().default("manual"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("kb_articles_audience_idx").on(t.audience, t.retiredAt)],
);

export const KB_VERSION_STATUSES = ["draft", "in_review", "published", "superseded", "rejected"] as const;
export type KbVersionStatus = (typeof KB_VERSION_STATUSES)[number];

/** Every version of an article, never edited once published, so citations point at exact text. */
export const kbArticleVersions = pgTable(
  "kb_article_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id").notNull().references(() => kbArticles.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    /** Markdown. */
    body: text("body").notNull(),
    status: text("status", { enum: KB_VERSION_STATUSES }).notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** "Claude (from 6 support emails)" for drafts the pipeline wrote. */
    authorLabel: text("author_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
  },
  (t) => [uniqueIndex("kb_article_versions_number_key").on(t.articleId, t.number), index("kb_article_versions_status_idx").on(t.status)],
);

/** Passages of published versions, for search and the chatbot. Rebuilt on publish. */
export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id").notNull().references(() => kbArticles.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull().references(() => kbArticleVersions.id, { onDelete: "cascade" }),
    audience: text("audience", { enum: KB_AUDIENCES }).notNull(),
    position: integer("position").notNull(),
    heading: text("heading").notNull(),
    content: text("content").notNull(),
    searchVector: tsvector("search_vector"),
    embedding: vector1024("embedding"),
    embeddingModel: text("embedding_model"),
  },
  (t) => [index("kb_chunks_search_idx").using("gin", t.searchVector), index("kb_chunks_article_idx").on(t.articleId)],
);

/** Where an article's content came from: a ticket, an email, a Zoho case, a web page. */
export const kbSources = pgTable(
  "kb_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id").notNull().references(() => kbArticles.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["ticket", "email", "zoho_case", "web"] }).notNull(),
    /** Ticket number, email Message-ID, Zoho case number or URL. */
    reference: text("reference").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("kb_sources_article_idx").on(t.articleId)],
);

export const INGEST_KINDS = ["mbox", "eml", "zoho_csv", "web", "ticket"] as const;

/** One import: a file of emails, a Zoho export, a website crawl, or resolved tickets. */
export const ingestJobs = pgTable("ingest_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: INGEST_KINDS }).notNull(),
  /** queued → importing (reading the source) → extracting → drafting → done. */
  status: text("status", { enum: ["importing", "extracting", "drafting", "done", "failed", "cancelled"] }).notNull().default("importing"),
  label: text("label").notNull(),
  /** Which audience to assume when an item doesn't say. */
  defaultAudience: text("default_audience", { enum: KB_AUDIENCES }).notNull().default("b2c"),
  /** Source location and the reader's progress (file key and byte offset, URL list position). */
  params: jsonb("params").notNull().default({}),
  stats: jsonb("stats").notNull().default({}),
  error: text("error"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * One source document (an email thread, a case, a page) after personal data
 * is removed. Extraction adds a question and answer and a topic; drafting
 * groups items by topic into articles. Unused items are deleted after 90 days.
 */
export const ingestItems = pgTable(
  "ingest_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => ingestJobs.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: INGEST_KINDS }).notNull(),
    /** Message-ID, case number, URL or ticket number: an item is imported once. */
    externalId: text("external_id").notNull(),
    title: text("title").notNull().default(""),
    /** Redacted text. Never contains raw contact details. */
    content: text("content").notNull(),
    status: text("status", { enum: ["pending", "extracted", "skipped", "drafted", "failed"] }).notNull().default("pending"),
    audience: text("audience", { enum: KB_AUDIENCES }),
    topic: text("topic"),
    extraction: jsonb("extraction"),
    articleId: uuid("article_id").references(() => kbArticles.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ingest_items_external_key").on(t.kind, t.externalId),
    index("ingest_items_job_status_idx").on(t.jobId, t.status),
    index("ingest_items_topic_idx").on(t.status, t.topic),
  ],
);
