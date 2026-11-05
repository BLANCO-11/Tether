-- Chat model (2026-11-03): the model a chat's Forge runs with, chosen in the chat from the models an admin turned on.
-- NULL means the builder's default.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "model" text;
