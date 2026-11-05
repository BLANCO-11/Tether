-- Sharing boundaries phase 3 (plans/sharing-boundaries-2026-10-30, D4): whose OWN account a run acted as — the person who
-- started it when the workflow runs on each person's account, the owner (or a test's starter) when it runs on a personal
-- connection, NULL when it used only the workspace's connections. What such a run did is that person's to see (and an
-- Admin's); others see that it ran and its status.
ALTER TABLE "flow_executions" ADD COLUMN IF NOT EXISTS "acts_as_subject" text;
