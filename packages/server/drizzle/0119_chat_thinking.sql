-- Thinking level (2026-10-29): how hard Forge Agent reasons before it answers, chosen per chat. It reaches the model as
-- reasoning_effort (low / medium / high / xhigh). Workflow Builder turns run with none whatever is stored here.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "thinking" varchar(16) NOT NULL DEFAULT 'balanced';--> statement-breakpoint
ALTER TABLE "pi_chats" DROP CONSTRAINT IF EXISTS "pi_chats_thinking_check";--> statement-breakpoint
ALTER TABLE "pi_chats" ADD CONSTRAINT "pi_chats_thinking_check" CHECK ("thinking" IN ('low', 'balanced', 'high', 'ultra'));
