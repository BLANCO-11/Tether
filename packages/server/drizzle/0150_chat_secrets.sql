-- A chat's vault: secrets the person gave one Forge chat. Values are encrypted and never read back by any route;
-- a secret is deleted with its chat and stays pending until its owner picks the website it may be sent to.
-- web_fetches also records the method, the secret used (by name) and the chat.
CREATE TABLE IF NOT EXISTS "chat_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "chat_id" uuid NOT NULL REFERENCES "pi_chats"("id") ON DELETE CASCADE,
  "owner_subject" varchar(320) NOT NULL,
  "name" varchar(64) NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "value_enc" text NOT NULL,
  "bound_host" varchar(253),
  "extra_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "placement_kind" varchar(16) DEFAULT 'bearer' NOT NULL,
  "placement_name" varchar(128),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "chat_secrets_status_check" CHECK ("status" IN ('pending','active')),
  CONSTRAINT "chat_secrets_placement_check" CHECK ("placement_kind" IN ('header','query','bearer')),
  CONSTRAINT "chat_secrets_placement_name_check" CHECK ("placement_kind" = 'bearer' OR "placement_name" IS NOT NULL),
  CONSTRAINT "chat_secrets_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT "chat_secrets_host_check" CHECK ("status" = 'pending' OR "bound_host" IS NOT NULL),
  CONSTRAINT "chat_secrets_host_lower_check" CHECK ("bound_host" IS NULL OR "bound_host" = lower("bound_host"))
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_secrets_chat_name" ON "chat_secrets" ("chat_id","name");
ALTER TABLE "web_fetches" ADD COLUMN IF NOT EXISTS "method" varchar(10);
ALTER TABLE "web_fetches" ADD COLUMN IF NOT EXISTS "secret_name" varchar(64);
ALTER TABLE "web_fetches" ADD COLUMN IF NOT EXISTS "chat_id" uuid;
