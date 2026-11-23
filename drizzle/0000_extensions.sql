-- Extensions the platform relies on. All are available on Supabase.
-- vector: KB embeddings (Phase 3). pg_trgm: fuzzy matching on names and refs.
-- citext: case-insensitive emails. pgcrypto: gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
