-- Per-user AI provider connection (personal thin): each subject brings their own OpenAI-compatible key.
CREATE TABLE IF NOT EXISTS "user_llm_providers" (
  "subject" text PRIMARY KEY,
  "provider_id" varchar(32) NOT NULL DEFAULT 'custom',
  "base_url" text NOT NULL,
  "api_key_enc" text,
  "default_model" text NOT NULL DEFAULT '',
  "allowed_models" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_user_llm_providers_updated" ON "user_llm_providers" ("updated_at");
