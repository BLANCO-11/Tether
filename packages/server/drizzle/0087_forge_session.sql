-- Forge's conversation for a workflow (2026-10-10): the session file Pi resumes from, so a process that exited
-- (idle, page closed, server restart) comes back with its history. Beside the visible chat, same lifetime.
ALTER TABLE "pi_flow_chats" ADD COLUMN IF NOT EXISTS "forge_session" text;
