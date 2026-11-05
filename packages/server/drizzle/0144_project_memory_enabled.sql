-- Per-project switch: when false, chats do not inject memory and Remember/promote stay off.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "memory_enabled" boolean DEFAULT true NOT NULL;
