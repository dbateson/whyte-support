-- Checks for the text "enums".
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_audience_check" CHECK ("audience" IN ('b2c', 'b2b', 'both'));--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_origin_check" CHECK ("origin" IN ('manual', 'ingestion', 'ticket'));--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_status_check" CHECK ("status" IN ('draft', 'in_review', 'published', 'superseded', 'rejected'));--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_audience_check" CHECK ("audience" IN ('b2c', 'b2b', 'both'));--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_kind_check" CHECK ("kind" IN ('ticket', 'email', 'zoho_case', 'web'));--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_kind_check" CHECK ("kind" IN ('mbox', 'eml', 'zoho_csv', 'web', 'ticket'));--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_status_check" CHECK ("status" IN ('importing', 'extracting', 'drafting', 'done', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_audience_check" CHECK ("default_audience" IN ('b2c', 'b2b', 'both'));--> statement-breakpoint
ALTER TABLE "ingest_items" ADD CONSTRAINT "ingest_items_kind_check" CHECK ("kind" IN ('mbox', 'eml', 'zoho_csv', 'web', 'ticket'));--> statement-breakpoint
ALTER TABLE "ingest_items" ADD CONSTRAINT "ingest_items_status_check" CHECK ("status" IN ('pending', 'extracted', 'skipped', 'drafted', 'failed'));--> statement-breakpoint
ALTER TABLE "ingest_items" ADD CONSTRAINT "ingest_items_audience_check" CHECK ("audience" IS NULL OR "audience" IN ('b2c', 'b2b', 'both'));--> statement-breakpoint

-- An article points at its live and working versions.
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_published_version_fk" FOREIGN KEY ("published_version_id") REFERENCES "kb_article_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_working_version_fk" FOREIGN KEY ("working_version_id") REFERENCES "kb_article_versions"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Chunk search text: the heading weighs more than the passage.
CREATE OR REPLACE FUNCTION kb_chunks_search_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.heading, '')), 'A') || setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER kb_chunks_search_document BEFORE INSERT OR UPDATE OF heading, content ON kb_chunks
  FOR EACH ROW EXECUTE FUNCTION kb_chunks_search_document();--> statement-breakpoint

-- Nearest-neighbour index for the chatbot's semantic search (cosine distance).
CREATE INDEX "kb_chunks_embedding_idx" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

ALTER TABLE "kb_articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "kb_articles", "kb_article_versions", "kb_chunks", "kb_sources", "ingest_jobs", "ingest_items" FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION kb_chunks_search_document() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
