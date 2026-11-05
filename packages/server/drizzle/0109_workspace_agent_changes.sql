-- Plugins, phase 6 (plans/plugins-2026-10-27, decision 2): whether Forge Agent may PROPOSE changes to connected services
-- in this workspace, each performed only by the person's own click on a confirm card. Off by default; a workspace that
-- never chooses keeps Forge Agent read-only.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "agent_changes" boolean DEFAULT false NOT NULL;
