-- rbac-observability (2026-10-15): cached prompt tokens have their own prices. `usage_events.tokens_cached` (a cache
-- read) and `tokens_cache_write` are already recorded and are INCLUDED in `tokens_in`; without these columns both were
-- charged at the full input price. NULL = charge them at the input price, as before.
ALTER TABLE "model_prices" ADD COLUMN IF NOT EXISTS "cached_input_per_1m" numeric(14, 6);
--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN IF NOT EXISTS "cache_write_per_1m" numeric(14, 6);
--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_cache_not_negative" CHECK (
  ("cached_input_per_1m" IS NULL OR "cached_input_per_1m" >= 0) AND ("cache_write_per_1m" IS NULL OR "cache_write_per_1m" >= 0)
);
