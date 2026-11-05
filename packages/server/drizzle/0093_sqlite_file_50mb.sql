-- An uploaded SQLite file may be up to 50 MB (2026-10-12; was 16 MB). The service checks first and names the size;
-- this is the backstop, kept equal to MAX_SQLITE_BYTES in sqlite-file.service.ts.
ALTER TABLE "datasource_files" DROP CONSTRAINT IF EXISTS "datasource_files_size_check";
--> statement-breakpoint
ALTER TABLE "datasource_files" ADD CONSTRAINT "datasource_files_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 52428800);
