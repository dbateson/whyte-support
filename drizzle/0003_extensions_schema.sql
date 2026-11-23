-- Extensions live in their own schema, not public (Supabase's security advisor
-- flags extensions in public). Supabase already has an "extensions" schema on
-- every role's search_path; elsewhere (local, CI) it's created here and added
-- to the database's search_path so types like vector resolve unqualified.
CREATE SCHEMA IF NOT EXISTS "extensions";--> statement-breakpoint
DO $$
DECLARE ext text;
BEGIN
  FOREACH ext IN ARRAY ARRAY['vector', 'pg_trgm', 'citext', 'pgcrypto'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ext AND n.nspname = 'public'
    ) THEN
      EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', ext);
    END IF;
  END LOOP;
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
END
$$;
