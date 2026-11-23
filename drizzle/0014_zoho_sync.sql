CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zoho_account_id" text NOT NULL,
	"name" text NOT NULL,
	"account_number" text,
	"account_type" text,
	"website" text,
	"email_domain" text,
	"phone" text,
	"is_dealer" boolean DEFAULT true NOT NULL,
	"zoho_modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_zoho_account_id_unique" UNIQUE("zoho_account_id")
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"zoho_id" text,
	"message" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "zoho_note_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "zoho_case_number" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "zoho_hash" text;--> statement-breakpoint
CREATE INDEX "accounts_number_idx" ON "accounts" USING btree (lower("account_number"));--> statement-breakpoint
CREATE INDEX "accounts_domain_idx" ON "accounts" USING btree ("email_domain");--> statement-breakpoint
CREATE INDEX "sync_log_at_idx" ON "sync_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sync_log_level_idx" ON "sync_log" USING btree ("level","at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_outbox_entity_key" ON "sync_outbox" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "sync_outbox_due_idx" ON "sync_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_zoho_key" ON "contacts" USING btree ("zoho_contact_id") WHERE "contacts"."zoho_contact_id" is not null;--> statement-breakpoint
CREATE INDEX "contacts_account_idx" ON "contacts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_zoho_key" ON "ticket_messages" USING btree ("zoho_note_id") WHERE "ticket_messages"."zoho_note_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_zoho_key" ON "tickets" USING btree ("zoho_case_id") WHERE "tickets"."zoho_case_id" is not null;