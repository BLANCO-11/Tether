import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * ops-api's own tables, in its own database.
 *
 * These are the four tables that used to live in `foundry_parent` as
 * `stub_mail_outbox`, `stub_chat_messages`, `stub_tickets` and `stub_call_log`.
 * The `stub_` prefix is gone with the process: they are the operational record
 * of a real service now, not fixtures inside the control plane.
 *
 * ── Why the move is the point, and not a rename ─────────────────────────────
 *
 * The old placement meant a tool call terminated in the process holding
 * `PARENT_API_KEY`, `TETHER_API_KEY` and `CREDENTIAL_ENC_KEY`, on a connection
 * to the database holding `workspace_secrets`. A SQL-injection or path-traversal
 * bug in a mail handler was therefore a bug in the control plane. Now the worst
 * a tool handler can reach is this database and a read-only view of `hr_demo` —
 * `ops-db-init` revokes `CONNECT ON DATABASE foundry_parent` from the `ops` role,
 * and `kestra:check` asserts it by attempting the connection.
 *
 * ⚠ ALL DATA HERE IS SYNTHETIC. Recipients are invented names on RFC 2606
 * reserved domains (`acme-hr.example`, `acme-hr-bounce.example`) that cannot
 * resolve or receive mail. Nothing here sends anything anywhere.
 */

/** Every message the mail service accepted. Nothing leaves this table. */
export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: varchar("message_id", { length: 128 }).notNull(),
    sender: varchar("sender", { length: 256 }).notNull(),
    recipients: jsonb("recipients").notNull(),
    cc: jsonb("cc"),
    subject: text("subject"),
    body: text("body"),
    attachments: jsonb("attachments"),
    templateKey: varchar("template_key", { length: 64 }),
    // sent | bounced — a hard bounce is returned for the reserved bounce domain
    // so an automation has something real to detect and report.
    status: varchar("status", { length: 16 }).notNull().default("sent"),
    bounceReason: text("bounce_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({ sentIdx: index("idx_mail_outbox_sent").on(t.sentAt) }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: varchar("channel", { length: 64 }).notNull(),
    author: varchar("author", { length: 128 }).notNull(),
    text: text("text"),
    blocks: jsonb("blocks"),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({ postedIdx: index("idx_chat_messages_posted").on(t.postedAt) }),
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketKey: varchar("ticket_key", { length: 32 }).notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    priority: varchar("priority", { length: 16 }).default("normal"),
    status: varchar("status", { length: 16 }).default("open"),
    assignee: varchar("assignee", { length: 256 }),
    labels: jsonb("labels"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({ createdIdx: index("idx_tickets_created").on(t.createdAt) }),
);

/**
 * Every call this service served — the audit trail that makes "did the
 * automation call the right tools, with the right parameters, in the right
 * order?" objectively checkable instead of a reading of generated source.
 *
 * ⚠ `query` and `body` are written through `redactSecrets` from
 * `@foundry/redact`, and that is load-bearing. A key sent as `?api_key=…` was
 * being persisted verbatim here, where it survived for 2000 rows and appeared
 * in screenshots. Never remove it to debug a 401 — `auth_presented` /
 * `auth_ok` / `auth_via` exist precisely so a credential problem is diagnosable
 * without the credential.
 */
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolName: varchar("tool_name", { length: 64 }),
    method: varchar("method", { length: 8 }).notNull(),
    path: varchar("path", { length: 256 }).notNull(),
    query: jsonb("query"),
    body: jsonb("body"),
    statusCode: integer("status_code").notNull(),
    resultCount: integer("result_count"),
    durationMs: integer("duration_ms"),
    authPresented: boolean("auth_presented"),
    authOk: boolean("auth_ok"),
    /** WHERE the credential arrived (header name / `query:<param>` / `bearer`). Never the value. */
    authVia: varchar("auth_via", { length: 64 }),
    /**
     * The Foundry execution that made this call — platform-coherence Phase 7.2.
     *
     * ⚠ Read from the `x-foundry-run` request header, which
     * `step-execution.service.ts` sets on every tool call. NULL for a call made
     * by a person, a harness, or any Foundry older than this — inventing one
     * would be a fabrication, and a timestamp correlation would be a plausible
     * one, which is worse.
     */
    runId: uuid("run_id"),
    calledAt: timestamp("called_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    calledIdx: index("idx_api_call_log_called").on(t.calledAt),
    runIdx: index("idx_api_call_log_run").on(t.runId),
  }),
);

/**
 * Pages — what an automation did when it decided somebody had to be WOKEN UP.
 *
 * ⚠ A SEPARATE TABLE FROM `mail_outbox`, AND THAT IS THE POINT. A page is not a
 * message with an urgent subject line: it is an interrupt, it is the most
 * expensive thing an automation in this product can do, and it is the one action
 * whose cost is paid by a person rather than by the system. Keeping it in its own
 * table means "how many times did this automation wake somebody" is a row count
 * rather than a `LIKE '%URGENT%'` over an outbox.
 *
 * ⚠ `dedupe_key` IS THE LOAD-BEARING COLUMN. A flow on a fifteen-minute schedule
 * pages the same unresolved incident four times an hour, and every one of those
 * pages is correct in isolation. Real paging services suppress repeats, so this
 * one does too — a second page for the same key inside the window is recorded as
 * `suppressed` and NOT delivered. Without it the demonstration would be teaching
 * an automation pattern that gets somebody's phone taken off them.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageKey: varchar("page_key", { length: 32 }).notNull().unique(),
    /** ⚠ The suppression key. Usually an incident code; never a timestamp. */
    dedupeKey: varchar("dedupe_key", { length: 128 }).notNull(),
    target: varchar("target", { length: 256 }).notNull(),
    severity: varchar("severity", { length: 8 }).notNull(),
    summary: text("summary").notNull(),
    /** `delivered` | `suppressed` | `no_responder`. See `routes/ops.ts`. */
    status: varchar("status", { length: 16 }).notNull(),
    /** Set on `suppressed`: the page this one was a repeat of. */
    supersededBy: varchar("superseded_by", { length: 32 }),
    /** Set on `no_responder` when an escalation address was supplied and used. */
    escalatedTo: varchar("escalated_to", { length: 256 }),
    reason: text("reason"),
    pagedAt: timestamp("paged_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    dedupeIdx: index("idx_pages_dedupe").on(t.dedupeKey),
    pagedIdx: index("idx_pages_paged").on(t.pagedAt),
  }),
);

/**
 * ⚠ There is a FIFTH table, `llm_provider`, and it deliberately has no Drizzle
 * definition here.
 *
 * It is a singleton row read and written by four statements in
 * `llm/provider.ts`, all naming their columns explicitly, and it holds an
 * encrypted credential. A query-builder entry for it would make
 * `db.select().from(llmProvider)` a one-liner from anywhere in the service —
 * including from the `READABLE` allowlist in `routes/admin.ts`, which exists to
 * bound exactly that. Keeping it out of this file means reaching the sealed key
 * requires writing SQL on purpose. Its DDL is in `db/migrate.ts` with the rest.
 */
