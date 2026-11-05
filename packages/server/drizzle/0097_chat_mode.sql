-- Chat modes (2026-10-13): each Forge chat is in Workflow Builder ('workflow': builds and changes the chat's one
-- workflow, and answers questions about it) or Forge Agent ('agent': questions, data, files and drafts done now, and
-- never a change to the workflow). Forge Agent is offered only where the workspace allows it (workspaces.assistant).
-- Every existing chat was a workflow chat.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "mode" varchar(16) NOT NULL DEFAULT 'workflow';--> statement-breakpoint
ALTER TABLE "pi_chats" DROP CONSTRAINT IF EXISTS "pi_chats_mode_check";--> statement-breakpoint
ALTER TABLE "pi_chats" ADD CONSTRAINT "pi_chats_mode_check" CHECK ("mode" IN ('workflow', 'agent'));--> statement-breakpoint
-- The mode a person's new chats open in. NULL is Workflow Builder, the product's default.
ALTER TABLE "platform_users" ADD COLUMN IF NOT EXISTS "forge_default_mode" varchar(16);--> statement-breakpoint
ALTER TABLE "platform_users" DROP CONSTRAINT IF EXISTS "platform_users_forge_default_mode_check";--> statement-breakpoint
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_forge_default_mode_check" CHECK ("forge_default_mode" IS NULL OR "forge_default_mode" IN ('workflow', 'agent'));
