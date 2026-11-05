ALTER TABLE "tools" ALTER COLUMN "auth_style" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "token_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "client_id_secret_ref" varchar(255);--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "client_secret_secret_ref" varchar(255);