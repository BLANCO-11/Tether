-- Cache WRITES are billed (P-OBS, measured 2026-10-10: gpt-6-luna $0.125/M) and a Forge reply's cost includes them;
-- without the count a row's cost cannot be checked against the gateway's prices.
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "tokens_cache_write" integer;
