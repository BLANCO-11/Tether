-- Edge agent reports home/cwd/platform on claim so Forge does not invent paths like /workspaces.
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "host_home" text;
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "host_cwd" text;
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "host_platform" text;
