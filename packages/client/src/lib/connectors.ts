// src/lib/connectors.ts — the connector catalogue.
//
// WHAT THIS IS, AND WHY IT SURVIVED THE MOCK PURGE.
//
// These are FORM SCHEMAS, not data. Each entry says which fields are needed to
// assemble a DSN for one database type, which of them are secret, and which are
// advanced — that is what `components/ui/DynamicForm.tsx` renders on
// /data-sources/new and what `assembleConnectionString()` in `lib/adapters.ts`
// reads to build the connection string the server then encrypts.
//
// It used to live in `src/mocks/data.ts` beside fabricated employees, apps, runs
// and API keys, and it was deleted along with all of them — wrongly. Nothing here
// is pretending to be a fact about a running system: a Postgres connection really
// does need host/port/database/username/password, and the server has no endpoint
// that would tell us so. A static catalogue is the honest representation of
// static knowledge.
//
// The distinction that matters: everything else in `mocks/data.ts` answered
// "what exists in this tenant?" — a question only the server can answer, and
// answering it locally is what let a failed API call render fabricated rows.
// This answers "what does a Postgres DSN need?", which does not vary by tenant.
//
// When the server grows a connector registry, this becomes its fallback or goes
// away. Until then it is not a stub and must not be deleted as one.
//
// ── ⚠ Two entries, because the server can only register two ──────────────────
//
// **MongoDB, Amazon S3 and Google Cloud Storage were removed on 2026-08-04.**
// They were pickable, and picking one got you a form, a DSN and — for Mongo — a
// stored row that could never be used. `datasource.service.ts` states the bound:
// `schemaIntrospectorService.supports()` covers `postgres` and `mysql` alone, so
// only those two can be introspected, only they can host a named query, and only
// a named query is reachable from a `datasource` step. Anything else is
// **inert** once registered.
//
// ⚠ That is the reason to have deleted them rather than to have styled them as
// "coming soon". Inert is worse than refused: S3 and GCS assemble a nonsense DSN
// and Mongo assembles a plausible one, so the failure arrives later, at the first
// flow that tries to read from it, and looks like a broken flow rather than a
// datasource that was never going to work. The catalogue now offers exactly what
// the product can do — the same reason `/apps/connect` was deleted, which named
// ServiceNow, Jira and SAP and connected to none of them.
//
// ⚠ **This list is one half of a pair.** `assembleConnectionString()` in
// `lib/adapters.ts` still maps `mongodb` and still guesses a port for it, and
// `connectors.test.ts` is what stops the two drifting: if a third engine is ever
// supported it goes in BOTH, and if one is dropped it leaves both.
//
// ── ⚠ A THIRD entry, SQLite — and it is not a DSN (2026-10-01) ────────────────
//
// SQLite has no server to dial: the person uploads the database FILE (≤ 50 MB),
// the server stores it encrypted and builds the pointer DSN itself. So it has
// no auth fields, `execution_engine: "file"`, and the wizard renders a file
// picker for it instead of a form (`isFileConnector`). It is registrable — the
// server's `schemaIntrospectorService` now covers `sqlite` — and it is always
// read-only, because the stored file is a snapshot and a write would vanish.
import type { ConnectorManifest } from "@/lib/types";

/** 16 MiB — the server's bound, stated here so the picker refuses before uploading. */
export const MAX_SQLITE_BYTES = 50 * 1024 * 1024;

/** A connector whose "credential" is an uploaded file, not an assembled DSN. */
export function isFileConnector(c: Pick<ConnectorManifest, "execution_engine"> | undefined): boolean {
  return c?.execution_engine === "file";
}

export const CONNECTORS: ConnectorManifest[] = [
  {
    id: "postgres", display_name: "PostgreSQL", description: "Relational database", icon: "🐘",
    category: "StructuredData", auth_type: "basic", capabilities: ["query", "metadata_discovery"],
    execution_engine: "trino", discovery_method: "native_driver",
    onboarding_schema: {
      auth: {
        type: "object",
        properties: {
          host: { type: "string", title: "Host", description: "e.g. hr-db.internal" },
          port: { type: "integer", title: "Port", default: 5432, minimum: 1, maximum: 65535 },
          database: { type: "string", title: "Database", description: "e.g. people" },
          username: { type: "string", title: "Username", description: "A read-only account is best." },
          password: { type: "string", title: "Password", format: "password" },
        },
        required: ["host", "port", "database", "username", "password"],
      },
      advanced: {
        type: "object",
        properties: {
          sslmode: { type: "string", title: "SSL mode", enum: ["require", "verify-full", "verify-ca", "prefer", "disable"], default: "require" },
          // ⚠ A `schema` property WAS HERE ("Optional — defaults to public.") and
          // is deleted, because the wizard now has a field for this that works.
          // `assembleConnectionString` reads only the DSN parts, so this one went
          // into the payload and nowhere else, while the real control is
          // `schemaAllowlist` on the datasource row — which decides what
          // `refreshSchema` introspects AND what `assertReadOnly` checks. Two
          // fields spelling the same intention where one is inert is worse than
          // the single inert field it was, because the working one gets ignored.
          // ⚠ `sslmode` above WAS in that same inert state — I-132 — and is
          // FIXED as of 2026-09-17, the way this comment said it had to be: in
          // the DSN, by `assembleConnectionString`, not by a delete. See
          // `tlsParams` in `lib/adapters.ts` for the measurements.
          //
          // ⚠ **Do not shorten this enum to the two modes that differ in
          // behaviour.** On `pg` 8.23 `prefer`, `require` and `verify-ca` are
          // all aliases for `verify-full`, so today only `disable` and
          // `verify-full` behave distinctly — but that collapse is a stated
          // transitional quirk of this `pg` major, not of Postgres, and pg 9
          // restores libpq semantics to all five. An enum trimmed to today's
          // behaviour would silently change meaning under that upgrade.
          //
          // ⚠ The default is `require` and must stay a value the form SEEDS:
          // `pickConnector` calls `initialValues`, so picking PostgreSQL puts
          // `sslmode: "require"` in `values` without anyone opening "advanced".
          // That is what makes a managed database onboard from credentials
          // alone. A default that lived only in this file's prose would leave
          // the DSN bare for everyone who never opened the section.
        },
      },
    },
    trino: { connector_name: "postgresql", template: "postgresql.properties.j2" },
  },
  {
    id: "mysql", display_name: "MySQL", description: "Relational database", icon: "🐬",
    category: "StructuredData", auth_type: "basic", capabilities: ["query", "metadata_discovery"],
    execution_engine: "trino", discovery_method: "native_driver",
    onboarding_schema: {
      auth: {
        type: "object",
        properties: {
          host: { type: "string", title: "Host" },
          port: { type: "integer", title: "Port", default: 3306 },
          database: { type: "string", title: "Database" },
          username: { type: "string", title: "Username" },
          password: { type: "string", title: "Password", format: "password" },
        },
        required: ["host", "port", "database", "username", "password"],
      },
      advanced: {
        type: "object",
        properties: { require_tls: { type: "boolean", title: "Require TLS", default: true } },
      },
    },
    trino: { connector_name: "mysql", template: "mysql.properties.j2" },
  },
  {
    id: "sqlite", display_name: "SQLite", description: "Upload a database file (up to 50 MB)", icon: "🪶",
    category: "StructuredData", auth_type: "file", capabilities: ["query", "metadata_discovery"],
    execution_engine: "file", discovery_method: "native_driver",
    // No fields: the file is the whole credential, and the wizard asks for it.
    onboarding_schema: { auth: { type: "object", properties: {}, required: [] } },
    trino: null,
  },
];
