ALTER TABLE "ticket_events" DROP CONSTRAINT "ticket_events_type_check";--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_type_check" CHECK ("type" IN ('created', 'status', 'priority', 'assignee', 'segment', 'category', 'reopened', 'zoho'));--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_entity_check" CHECK ("entity" IN ('contact', 'ticket'));--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_direction_check" CHECK ("direction" IN ('out', 'in'));--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_level_check" CHECK ("level" IN ('info', 'warning', 'error'));--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "accounts", "sync_outbox", "sync_state", "sync_log" FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE "sync_outbox_id_seq", "sync_log_id_seq" FROM %I', r);
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
-- Queue a ticket for Zoho whenever its synced fields change or it gets a message,
-- in the same transaction. Off until Zoho sync is switched on; skipped for
-- changes the sync itself is applying from Zoho (app.sync_origin = 'zoho').
CREATE OR REPLACE FUNCTION "queue_ticket_for_zoho"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  tid uuid;
BEGIN
  IF current_setting('app.sync_origin', true) = 'zoho' THEN
    RETURN NULL;
  END IF;
  IF coalesce((SELECT value #>> '{}' FROM app_settings WHERE key = 'zoho.sync_enabled'), 'false') <> 'true' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'tickets' THEN
    tid := NEW.id;
  ELSE
    tid := NEW.ticket_id;
  END IF;
  INSERT INTO sync_outbox (entity, entity_id) VALUES ('ticket', tid)
  ON CONFLICT (entity, entity_id) DO UPDATE SET changed_at = now(), next_attempt_at = least(sync_outbox.next_attempt_at, now()), attempts = 0;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "tickets_queue_for_zoho_insert" AFTER INSERT ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION "queue_ticket_for_zoho"();--> statement-breakpoint
CREATE TRIGGER "tickets_queue_for_zoho_update" AFTER UPDATE ON "tickets"
  FOR EACH ROW WHEN (
    OLD.subject IS DISTINCT FROM NEW.subject OR OLD.status IS DISTINCT FROM NEW.status OR
    OLD.priority IS DISTINCT FROM NEW.priority OR OLD.segment IS DISTINCT FROM NEW.segment OR
    OLD.category IS DISTINCT FROM NEW.category OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
  ) EXECUTE FUNCTION "queue_ticket_for_zoho"();--> statement-breakpoint
CREATE TRIGGER "ticket_messages_queue_for_zoho" AFTER INSERT ON "ticket_messages"
  FOR EACH ROW WHEN (NEW.zoho_note_id IS NULL) EXECUTE FUNCTION "queue_ticket_for_zoho"();
