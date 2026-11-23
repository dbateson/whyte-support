ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_status_check" CHECK ("status" IN ('pending', 'attached'));--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_attached_check" CHECK ("status" = 'pending' OR "ticket_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ticket_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "ticket_attachments", "rate_limit_events" FROM anon';
    EXECUTE 'REVOKE ALL ON SEQUENCE "rate_limit_events_id_seq" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "ticket_attachments", "rate_limit_events" FROM authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE "rate_limit_events_id_seq" FROM authenticated';
  END IF;
END
$$;
