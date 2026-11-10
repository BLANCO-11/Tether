-- OpenCode Go / Zen / Custom on the model connection (2026-11-10). The singleton gets a provider column; the
-- per-user rows already have provider_id, and the old single `opencode` preset becomes opencode_go or opencode_zen.
ALTER TABLE "runtime_model_provider" ADD COLUMN IF NOT EXISTS "provider" varchar(32) DEFAULT 'custom' NOT NULL;
UPDATE "runtime_model_provider" SET "provider" = CASE WHEN "base_url" LIKE '%/go/%' THEN 'opencode_go' ELSE 'opencode_zen' END WHERE "base_url" LIKE 'https://opencode.ai/%' AND "provider" = 'custom';
UPDATE "user_llm_providers" SET "provider_id" = CASE WHEN "base_url" LIKE '%/go/%' THEN 'opencode_go' ELSE 'opencode_zen' END WHERE "provider_id" = 'opencode';
