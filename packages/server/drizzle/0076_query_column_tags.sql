-- compiled-builder: tags a named query's owner declares on computed result columns (services/query-column-tags.ts).
ALTER TABLE "datasource_queries" ADD COLUMN IF NOT EXISTS "column_tags" jsonb DEFAULT '{}'::jsonb NOT NULL;
