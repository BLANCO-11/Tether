import pg from "pg";
import { config } from "../config.js";

/**
 * ops-api's schema, as idempotent DDL run by a one-shot compose service.
 *
 * ── Why hand-written SQL and not drizzle-kit ────────────────────────────────
 *
 * The parent uses generated migrations because its schema has eighteen versions
 * of history behind it and rows that must survive each one. This service has
 * four tables holding synthetic capture data with no history worth preserving —
 * `ops:reset` truncates all of it on purpose. A migration toolchain here would
 * add a second `drizzle/` directory, a second `drizzle.config.ts` and a second
 * snapshot lineage to keep straight, to manage data whose retention policy is
 * "delete it whenever".
 *
 * `db/schema.ts` stays as the Drizzle *query* schema and this file is the DDL.
 * Two descriptions of four tables can drift, so the drift is made loud rather
 * than tolerated: every column below is selected by the query layer on the first
 * request to each table, so a mismatch is a startup-adjacent error naming the
 * column, not a silent null.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS mail_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    varchar(128) NOT NULL,
  sender        varchar(256) NOT NULL,
  recipients    jsonb NOT NULL,
  cc            jsonb,
  subject       text,
  body          text,
  attachments   jsonb,
  template_key  varchar(64),
  status        varchar(16) NOT NULL DEFAULT 'sent',
  bounce_reason text,
  sent_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_sent ON mail_outbox (sent_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel   varchar(64) NOT NULL,
  author    varchar(128) NOT NULL,
  text      text,
  blocks    jsonb,
  posted_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_posted ON chat_messages (posted_at);

CREATE TABLE IF NOT EXISTS tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_key  varchar(32) NOT NULL UNIQUE,
  title       text NOT NULL,
  description text,
  priority    varchar(16) DEFAULT 'normal',
  status      varchar(16) DEFAULT 'open',
  assignee    varchar(256),
  labels      jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets (created_at);

CREATE TABLE IF NOT EXISTS api_call_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name      varchar(64),
  method         varchar(8) NOT NULL,
  path           varchar(256) NOT NULL,
  query          jsonb,
  body           jsonb,
  status_code    integer NOT NULL,
  result_count   integer,
  duration_ms    integer,
  auth_presented boolean,
  auth_ok        boolean,
  auth_via       varchar(64),
  called_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_call_log_called ON api_call_log (called_at);

-- Which RUN made the call — platform-coherence Phase 7.2, I-110.
--
-- ⚠ The point of the column is that the answer is EXACT. The call log is the
-- only evidence in this product that an automation actually did something —
-- CLAUDE.md names it as the answer to "the run went green, but did it do
-- anything?" — and moving it onto a run page needed the calls of THAT run.
-- Correlating by timestamp was the alternative and it is the wrong kind of
-- wrong: on an instance where harnesses run concurrently it silently attributes
-- another run's emails to the one on screen, which is a plausible answer nobody
-- can falsify from the page.
--
-- Nullable, and that is honest rather than lax: a call made by a person with
-- curl, by a harness, or by any Foundry version before this one has no run, and
-- inventing one would be the same fabrication from the other end.
--
-- ADD COLUMN IF NOT EXISTS is used because this file is idempotent DDL run on every
-- boot, not a migration lineage — see this module's header.
ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS run_id uuid;
CREATE INDEX IF NOT EXISTS idx_api_call_log_run ON api_call_log (run_id);

-- Pages. A separate table from mail_outbox on purpose — see db/schema.ts.
--
-- ⚠ dedupe_key is NOT unique, and that is deliberate rather than an omission. A
-- suppressed repeat is RECORDED, not rejected: the row is what proves the
-- automation tried and was held back, and a unique constraint would make the
-- second attempt vanish with nothing to show a reviewer. Suppression is decided
-- by a windowed query, so the window can change without a migration.
CREATE TABLE IF NOT EXISTS pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_key       varchar(32) NOT NULL UNIQUE,
  dedupe_key     varchar(128) NOT NULL,
  target         varchar(256) NOT NULL,
  severity       varchar(8) NOT NULL,
  summary        text NOT NULL,
  status         varchar(16) NOT NULL,
  superseded_by  varchar(32),
  escalated_to   varchar(256),
  reason         text,
  paged_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pages_dedupe ON pages (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_pages_paged ON pages (paged_at);

-- The LLM provider: exactly one row, enforced by the CHECK rather than by
-- convention. A second row would mean two configurations and a silent race over
-- which credential is billed; a singleton the database refuses to duplicate is
-- cheaper than every reader remembering to ORDER BY.
--
-- api_key_enc is AES-256-GCM under a key derived from OPS_API_KEY. NULL means
-- "fall back to the LLM_API_KEY environment variable", which is what lets an
-- operator change the default model without re-pasting a credential.
CREATE TABLE IF NOT EXISTS llm_provider (
  id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base_url       text NOT NULL,
  api_key_enc    text,
  default_model  text NOT NULL DEFAULT '',
  allowed_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);


-- Ticket and page keys are handed out by the DATABASE, one number per insert (2026-09-30). They used to be "count the rows, add one",
-- read and inserted in two statements, so two calls at once got the same key and the second died on the UNIQUE constraint as an
-- opaque 500 — which a flow's for-each, running several items at once, does on every run (a held-out ticket loop, 1 of 5 items
-- failed). A reset or a deleted row collided the same way. OWNED BY: ops:reset's TRUNCATE … RESTART IDENTITY restarts them with
-- their tables, so a reset still starts at HR-1001 / PG-2001; the setval lifts each above any key already stored (never down).
CREATE SEQUENCE IF NOT EXISTS ticket_key_seq START WITH 1001 OWNED BY tickets.ticket_key;
CREATE SEQUENCE IF NOT EXISTS page_key_seq START WITH 2001 OWNED BY pages.page_key;
SELECT setval('ticket_key_seq', m) FROM (SELECT max(substring(ticket_key from '[0-9]+$')::bigint) AS m FROM tickets) x
  WHERE m IS NOT NULL AND m >= (SELECT last_value FROM ticket_key_seq);
SELECT setval('page_key_seq', m) FROM (SELECT max(substring(page_key from '[0-9]+$')::bigint) AS m FROM pages) x
  WHERE m IS NOT NULL AND m >= (SELECT last_value FROM page_key_seq);
`;

async function main() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(DDL);
    console.log(
      "[ops-api] schema ready: mail_outbox, chat_messages, tickets, pages, api_call_log, llm_provider",
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[ops-api] migrate failed:", (e as Error).message);
  process.exit(1);
});
