-- Email attachments on foundry_email_send (services/mail-attachments.ts).
-- Ported from release/beta 0075_email_attachments.sql, renumbered: our 0075
-- is revision_goal_spec. Journal tag, column comments and SQL are otherwise
-- the beta file verbatim, except `attachments` also records the generated
-- file's form (see file-builder.service.ts).
--
-- `attachments` is written on EVERY outcome and holds only {name, bytes}:
-- what was attached, never what it said — the failure_reason rule.
-- `captured_attachments` holds the CONTENT and is written on exactly one path,
-- a DRAFT run's captured message — the captured_body rule (migration 0058).
alter table email_sends add column if not exists attachments jsonb not null default '[]'::jsonb;
--> statement-breakpoint
alter table email_sends add column if not exists captured_attachments jsonb;
--> statement-breakpoint
comment on column email_sends.captured_attachments is
  'Attachment content, held ONLY when outcome = ''captured'' (a draft run). A real send stores names and sizes in attachments and never the content.';
