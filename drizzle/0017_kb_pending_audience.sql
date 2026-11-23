ALTER TABLE "kb_article_versions" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_audience_check" CHECK ("audience" IS NULL OR "audience" IN ('b2c', 'b2b', 'both'));
