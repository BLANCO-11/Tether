-- Which connection a chat uses for each connected service, chosen by the person (plugins 8.5): { "<piece>": {...} }.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "connection_choices" jsonb NOT NULL DEFAULT '{}'::jsonb;
