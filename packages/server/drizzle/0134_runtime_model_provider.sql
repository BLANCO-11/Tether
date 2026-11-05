-- The runtime model's settings move from ops-api into Foundry (2026-10-30, plans/builtin-tools-2026-10-30): the gateway,
-- key and models the `llm_complete` tool uses. One row; none means the environment's LLM_* values. The key is
-- encrypted under CREDENTIAL_ENC_KEY. `runtime-model:import` copies the row ops-api held, once.
CREATE TABLE IF NOT EXISTS "runtime_model_provider" (
  "id" integer PRIMARY KEY NOT NULL,
  "base_url" text NOT NULL,
  "api_key_enc" text,
  "default_model" text DEFAULT '' NOT NULL,
  "allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" varchar(255),
  CONSTRAINT "runtime_model_provider_one_row" CHECK ("id" = 1)
);
