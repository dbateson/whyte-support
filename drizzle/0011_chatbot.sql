CREATE TABLE "chat_answer_sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"article_id" uuid,
	"version_id" uuid,
	"heading" text NOT NULL,
	"content" text NOT NULL,
	"rank" integer NOT NULL,
	"score" text,
	"cited" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"outcome" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"feedback" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"segment" text NOT NULL,
	"shopify_customer_id" text,
	"origin" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"ticket_id" uuid,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_answer_sources" ADD CONSTRAINT "chat_answer_sources_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_answer_sources" ADD CONSTRAINT "chat_answer_sources_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_answer_sources" ADD CONSTRAINT "chat_answer_sources_version_id_kb_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."kb_article_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_answer_sources_message_idx" ON "chat_answer_sources" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_answer_sources_article_idx" ON "chat_answer_sources" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_outcome_idx" ON "chat_messages" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_created_idx" ON "chat_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_status_idx" ON "chat_sessions" USING btree ("status","last_message_at");