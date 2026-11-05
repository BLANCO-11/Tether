-- rbac-observability (2026-10-15): model prices, per 1M input and per 1M output tokens. Insert-only history; cost is
-- computed at read from the price in effect when the usage happened, so a price change never rewrites the past.
CREATE TABLE IF NOT EXISTS "model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model" text NOT NULL,
  "input_per_1m" numeric(14, 6),
  "output_per_1m" numeric(14, 6),
  "effective_from" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "model_prices_not_negative" CHECK (
    ("input_per_1m" IS NULL OR "input_per_1m" >= 0) AND ("output_per_1m" IS NULL OR "output_per_1m" >= 0)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_model_prices_model_from" ON "model_prices" ("model", "effective_from");
