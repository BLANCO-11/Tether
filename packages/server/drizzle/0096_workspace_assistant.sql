-- Assistant mode (2026-10-12): a workspace may let Forge do more than build workflows — everyday tasks in the same
-- chat (answering, writing, summarising, making files) and read-only answers from the workspace's real data. Chosen at
-- creation, changeable by a super admin, every change audited. Off for every existing workspace.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "assistant" boolean NOT NULL DEFAULT false;
