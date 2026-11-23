-- Value checks for the text "enums" (Drizzle doesn't emit them).
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('invited', 'active', 'disabled'));--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_purpose_check" CHECK ("purpose" IN ('invite', 'reset'));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_segments_check" CHECK ("segments" <@ ARRAY['b2c', 'b2b']::text[]);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_segment_check" CHECK ("segment" IN ('b2c', 'b2b'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_segment_check" CHECK ("segment" IN ('b2c', 'b2b'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_check" CHECK ("status" IN ('new', 'open', 'pending_customer', 'pending_internal', 'resolved', 'closed'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_check" CHECK ("source" IN ('form', 'chat', 'email', 'zoho', 'staff'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_check" CHECK ("author_type" IN ('customer', 'agent', 'assistant', 'system'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_channel_check" CHECK ("channel" IN ('email', 'web', 'chat', 'zoho', 'staff'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_email_status_check" CHECK ("email_status" IS NULL OR "email_status" IN ('sending', 'sent', 'failed'));--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_type_check" CHECK ("type" IN ('created', 'status', 'priority', 'assignee', 'segment', 'category', 'reopened'));--> statement-breakpoint

-- Full-text search over a ticket: reference, subject and frame number weigh
-- most, then the contact, then every message (internal notes included: only
-- staff search). Recomputed before each write to the ticket; a new or edited
-- message touches its ticket so the search document follows.
CREATE OR REPLACE FUNCTION tickets_search_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE
  contact_text text;
  messages_text text;
BEGIN
  SELECT concat_ws(' ', c.name, c.email::text, c.company_name) INTO contact_text
    FROM contacts c WHERE c.id = NEW.contact_id;
  SELECT string_agg(m.body, ' ' ORDER BY m.created_at) INTO messages_text
    FROM ticket_messages m WHERE m.ticket_id = NEW.id;
  NEW.search_vector :=
    setweight(to_tsvector('simple', concat_ws(' ', 'WS-' || NEW.number, NEW.number::text, NEW.frame_number)), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(contact_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.product_model, '') || ' ' || coalesce(NEW.category, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(messages_text, ''), 500000)), 'C');
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER tickets_search_document BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION tickets_search_document();--> statement-breakpoint

CREATE OR REPLACE FUNCTION ticket_messages_touch_ticket() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE tickets SET updated_at = now() WHERE id = COALESCE(NEW.ticket_id, OLD.ticket_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER ticket_messages_touch_ticket AFTER INSERT OR UPDATE OF body OR DELETE ON ticket_messages
  FOR EACH ROW EXECUTE FUNCTION ticket_messages_touch_ticket();--> statement-breakpoint

-- Server-only access, as for every table (see 0002_lockdown).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "login_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
  END IF;
END
$$;--> statement-breakpoint

-- The seeded roles (src/lib/auth/permissions.ts, SYSTEM_ROLES).
INSERT INTO "roles" ("name", "description", "permissions", "segments", "is_system") VALUES
  ('Admin', 'Everything, in both segments.', ARRAY['tickets.view', 'tickets.reply', 'tickets.note', 'tickets.update', 'tickets.assign', 'tickets.create', 'kb.view', 'kb.edit', 'kb.approve', 'chat.view', 'analytics.view', 'users.manage', 'settings.manage', 'audit.view', 'gdpr.process']::text[], ARRAY['b2c', 'b2b']::text[], true),
  ('Agent', 'Works B2C and B2B tickets.', ARRAY['tickets.view', 'tickets.reply', 'tickets.note', 'tickets.update', 'tickets.assign', 'tickets.create', 'kb.view', 'chat.view']::text[], ARRAY['b2c', 'b2b']::text[], true),
  ('B2B Agent', 'Works dealer (B2B) tickets only.', ARRAY['tickets.view', 'tickets.reply', 'tickets.note', 'tickets.update', 'tickets.assign', 'tickets.create', 'kb.view', 'chat.view']::text[], ARRAY['b2b']::text[], true),
  ('Read-only', 'Sees tickets, articles, conversations and analytics; changes nothing.', ARRAY['tickets.view', 'kb.view', 'chat.view', 'analytics.view']::text[], ARRAY['b2c', 'b2b']::text[], true),
  ('KB Editor', 'Writes, approves and retires knowledge-base articles.', ARRAY['kb.view', 'kb.edit', 'kb.approve', 'tickets.view', 'chat.view']::text[], ARRAY['b2c', 'b2b']::text[], true)
ON CONFLICT ("name") DO NOTHING;
