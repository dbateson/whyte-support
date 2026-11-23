ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_segment_check" CHECK ("segment" IN ('b2c', 'b2b'));--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_status_check" CHECK ("status" IN ('open', 'escalated', 'closed'));--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_role_check" CHECK ("role" IN ('user', 'assistant'));--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('answered', 'partial', 'no_answer', 'needs_human', 'declined', 'error'));--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_feedback_check" CHECK ("feedback" IS NULL OR "feedback" IN (-1, 1));--> statement-breakpoint
ALTER TABLE "chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_answer_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "chat_sessions", "chat_messages", "chat_answer_sources" FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE "chat_answer_sources_id_seq" FROM %I', r);
    END IF;
  END LOOP;
END
$$;
