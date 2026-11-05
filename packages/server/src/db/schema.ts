// Foundry Parent App — Drizzle schema.
// Mirrors IMPLEMENTATION_PLAN.md §9 (Database Schema — Parent App).
// All data-service tables are defined up front so later sprints only add
// business logic, not migrations for tables that were always going to exist.
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  doublePrecision,
  numeric,
  index,
  unique,
  uniqueIndex,
  primaryKey,
  check,
  type AnyPgColumn,
  date,
  interval,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Workspaces: top-level isolation boundary.
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  /**
   * IMMUTABLE slugs — the Kestra namespace is `<prefix>.<tenantSlug>.<slug>`
   * (§5.0). Assigned at creation and never changed: a renamed workspace must
   * keep its namespace, or its deployed flows and execution history detach.
   *
   * The TENANT segment is mandatory, not cosmetic. Two clients will both have a
   * workspace called "HR", and a namespace collision across tenants is a
   * cross-tenant data leak.
   *
   * Slugs rather than UUIDs because `kestra-ui` is the internal debugging
   * surface (R5) and UUID namespaces would make it unreadable.
   */
  slug: varchar("slug", { length: 128 }),
  tenantSlug: varchar("tenant_slug", { length: 128 }),
  description: text("description"),
  /**
   * `null` for a real tenant workspace; `"fixture"` for one that exists to
   * serve a harness.
   *
   * `HR (alt — swap rehearsal)` is provisioned by `demo:seed-alt` so
   * `demo:rehearse` has a differently-shaped dataset to prove the platform has
   * no knowledge of any particular one. It is not a customer tenant, and shown
   * as a peer of HR and Finance it reads as one — a demo viewer sees two HR
   * workspaces and asks why.
   *
   * A COLUMN rather than a name prefix, because a name is display text somebody
   * will eventually edit, and the answer to "is this real?" must not depend on
   * how it is spelled.
   */
  kind: varchar("kind", { length: 32 }),
  /**
   * Assistant mode (0096): Forge also does everyday tasks in this workspace's chats — answering, writing, summarising,
   * making files — and answers questions from its real data, read-only (`/api/forge/data`, which checks this column
   * on every call). Off: Forge builds workflows only. Chosen at creation; a super admin may change it, audited.
   */
  assistant: boolean("assistant").notNull().default(false),
  /** Forge Agent may PROPOSE changes to connected services, each run only by the person's click (0109). Off by default. */
  agentChanges: boolean("agent_changes").notNull().default(false),
  /**
   * Members may switch on their own PRIVATE automations that use only their own things, with no reviewer (0112,
   * plugins phase 9). On by default. Off: none can be switched on that way, and those already on stop running.
   */
  selfEnable: boolean("self_enable").notNull().default(true),
  /**
   * Web access (0133): the built-in `web_fetch` tool may read public web addresses for this workspace's workflows and
   * for Forge while it builds. On by default; its admins may switch it off. Private, internal and metadata addresses are
   * refused whatever this says (`web-fetch.service.ts`).
   */
  webAccess: boolean("web_access").notNull().default(true),
  /**
   * Restricted (0113, restricted-workspaces): closed to everyone above it. Only the people its own admins add get in —
   * platform admins see its name and admins only, and a super admin gets in only through a time-bound, audited
   * emergency access (`workspace_emergency_access`). `workspace-restriction.service.ts` is the one rule.
   */
  restricted: boolean("restricted").notNull().default(false),
  restrictedBy: text("restricted_by"),
  restrictedAt: timestamp("restricted_at", { withTimezone: true }),
  /**
   * Optional NARROWING of who this workspace's flows may email.
   * email-send-tool · US2 · contracts/mail-send.md §3
   *
   *   `null` — no narrowing. The deployment's `MAIL_ALLOWED_RECIPIENT_DOMAINS` is
   *            the only gate. This is the default and what every existing row has.
   *   `[]`   — the person who started the run and NOBODY else, however wide the
   *            deployment list is.
   *   entries — full addresses (`her@example.com`) or bare domains (`example.com`).
   *
   * ⚠ **It narrows, it never widens.** Both gates must pass, so a workspace admin
   * cannot reach a domain the operator excluded from
   * `MAIL_ALLOWED_RECIPIENT_DOMAINS`. That containment is asserted in
   * `services/mail-recipients.test.ts`, not merely intended here.
   *
   * ⚠ `null` and `[]` are DIFFERENT and both are meaningful, which is why this is
   * nullable rather than defaulting to `[]`. Defaulting to `[]` would silently
   * turn "not configured" into "requester only" for every existing workspace, and
   * the resulting refusals would name a list nobody had ever set.
   *
   * The person who started the run is exempt from this list, as they are from the
   * deployment one — otherwise "email me my own result" would need an entry.
   */
  mailRecipientAllowlist: jsonb("mail_recipient_allowlist").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Tools: registered HTTP endpoints a flow's `tool` steps call.
 *
 * `is_dummy` and `dummy_response_template` were dropped here. A "dummy" tool's
 * response came from `routes/stubs.ts`, which interpolated request fields into a
 * stored template — so it returned one fixed shape however it was called, and an
 * agent given one learnt nothing about whether its parameters were right. Nothing
 * in this repo ever created one; every row had `is_dummy = false`.
 *
 * ⚠ `refFingerprints()` in `manifest-builder.service.ts` still emits
 * `isDummy: false` into its hash payload on purpose. Read the note there before
 * touching it — removing the key would change every tool's fingerprint and the
 * staleness sweep would suspend every armed flow.
 */
export const tools = pgTable("tools", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 2048 }),
  method: varchar("method", { length: 10 }),
  description: text("description"),
  paramsSchema: jsonb("params_schema"),
  /**
   * The DECLARED shape of what this tool returns (compiled-builder phase 2c, E0.7 G1), in `OutputShape`'s vocabulary.
   * NULL ⇒ the endpoint registry (`tool-output-shapes.ts`) is consulted, and failing that the output is `Opaque`, which
   * cannot feed a typed port. A tenant's own tool declares its shape here, as data.
   */
  outputSchema: jsonb("output_schema"),
  // Secret env-var NAME only (never a value); surfaced in the manifest as <secretRef>.
  // The VALUE lives in `workspace_secrets`, keyed by this name (WS-B.3).
  secretEnvName: varchar("secret_env_name", { length: 255 }),
  // WS-B.4 — HOW to present the credential. `<secretRef env="K"/>` said a key
  // exists but not where it goes, so the agent had to guess between
  // `Authorization: Bearer`, `X-API-Key`, a query param and basic auth — and a
  // wrong guess is a 401 the audit calls `clean`.
  //   bearer → Authorization: Bearer <value>
  //   header → <authParamName>: <value>
  //   query  → ?<authParamName>=<value>
  //   basic  → Authorization: Basic base64(<value>)   [value is "user:pass"]
  // "oauth2_client_credentials" is 25 chars, so the column outgrew its old 16.
  authStyle: varchar("auth_style", { length: 32 }),
  // Header or query-param name; required for `header` and `query`, ignored otherwise.
  authParamName: varchar("auth_param_name", { length: 128 }),
  /**
   * OAuth2 client-credentials exchange (Phase 7). Only meaningful when
   * `auth_style = 'oauth2_client_credentials'`; the tool.service.ts superRefine
   * refuses the trio on every other style.
   *
   * `token_url` is HTTPS-only (http allowed for localhost/127.0.0.1 dev
   * endpoints). The other two are env-var NAMES of workspace_secrets rows
   * holding the client id and client secret — the same store `secret_env_name`
   * points at, deliberately: an OAuth2 client credential is a credential like
   * any other, so it lives where the others do. The exchanged bearer token is
   * cached in-process per (workspace_id, tool_id) with a short TTL and
   * presented as auth style `bearer`.
   */
  tokenUrl: varchar("token_url", { length: 2048 }),
  clientIdSecretRef: varchar("client_id_secret_ref", { length: 255 }),
  clientSecretSecretRef: varchar("client_secret_secret_ref", { length: 255 }),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/**
 * WS-B.3 — where secret VALUES live.
 *
 * `tools` carried only `secret_env_name` ("never a value"), while `datasources`
 * carried `connection_string_enc`. So there was nowhere to put a tool's API key,
 * and a tool that declared one produced a script that KeyError'd at run time.
 *
 * A workspace-level store rather than a `tools.secret_value_enc` column, because
 * one credential is commonly shared by several tools of the same vendor, and this
 * removes the tool/datasource asymmetry: both reference an entry by its env-var
 * NAME, which is also what the manifest renders.
 *
 * `name` IS the environment-variable name. That is deliberate — the manifest, the
 * prompt, the executor's `-e` flag and this row must all agree, and one identifier
 * makes disagreement impossible.
 */
export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Env-var name, e.g. TICKETING_API_KEY.
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /**
     * Phase 5 — unified credentials. Which credential surface this row serves:
     * `tool` | `database` | `webhook` | `api` | `llm` | `generic`.
     * NULL for rows written before the column existed; the credential provider
     * renders those as `generic`. Display/grouping metadata only — resolution
     * still happens by `name` (the env-var ref), never by kind.
     */
    kind: varchar("kind", { length: 32 }),
    /**
     * Human-readable name for the Credentials page. The identifier stays `name`
     * (the env-var ref tools and datasources resolve by); a label is display
     * text and nothing resolves by it.
     */
    label: varchar("label", { length: 255 }),
    // AES-256-GCM via utils/encryptor.ts, same as datasource credentials.
    valueEnc: text("value_enc").notNull(),
    /**
     * Optional SANDBOX-scoped value used at GENERATION time instead of `valueEnc`
     * (WS-B.2, §13 Q1). When this is set, a production key is never handed to a
     * generation-time smoke test: the sandbox gets the throwaway credential and
     * production connectivity is proven at execution time instead.
     */
    sandboxValueEnc: text("sandbox_value_enc"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // One value per env-var name per workspace — two would make injection
    // order-dependent.
    nameUnique: unique("uq_workspace_secrets_name").on(t.workspaceId, t.name),
  }),
);

// B-13 · S-48 Resource list — ResourceStatus 9 + Health + ResourceCategory
// Status: setup·draft·pending-review·approved·published·paused·failed·deprecated·archived (06-status-vocabularies §5)
export const RESOURCE_STATUSES = [
  "setup",
  "draft",
  "pending-review",
  "approved",
  "published",
  "paused",
  "failed",
  "deprecated",
  "archived",
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const RESOURCE_HEALTHS = [
  "healthy",
  "waiting_review",
  "expires_soon",
  "not_connected",
  "superseded",
] as const;
export type ResourceHealth = (typeof RESOURCE_HEALTHS)[number];

export const RESOURCE_CATEGORIES = ["datasource", "connector", "tool"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

// Datasources: database connections. Credentials encrypted at rest.
export const datasources = pgTable(
  "datasources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(), // postgres, mysql, mongodb, redis, elasticsearch
    /**
     * Nullable for mock-only-until-linked rows: a datasource may exist with
     * mock fixtures before any production credential is attached. NULL means
     * "no production credential" — every decrypt() call-site must handle it
     * and refuse prod paths rather than throwing a malformed-ciphertext error.
     */
    connectionStringEnc: text("connection_string_enc"),
    // Env-var name the workspace injects the connection string under (manifest <secretRef>).
    secretEnvName: varchar("secret_env_name", { length: 255 }),
    /**
     * WS-C.1 — which schemas to introspect. Postgres schemas / MySQL databases.
     * Defaults to ["public"] so existing datasources behave exactly as before.
     *
     * An ALLOWLIST rather than "every non-system schema": a production database may
     * hold hundreds of irrelevant tables, and the manifest is already ~60% of the
     * generation prompt.
     */
    schemaAllowlist: jsonb("schema_allowlist").$type<string[]>().default(["public"]),
    /**
     * Tags the OWNER declares on table/view columns, keyed `[schema.]table.column` → `email` | `key` | `minor_units`
     * (migration 0080). What a SQLite schema cannot say as a comment. Applied at every schema refresh; fills a silence, never
     * contradicts the schema's own tag (`services/datasource-column-tags.ts`).
     */
    columnTags: jsonb("column_tags").$type<Record<string, string>>().notNull().default({}),
    testStatus: varchar("test_status", { length: 20 }), // connected, disconnected, error
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    /**
     * ── The development sandbox (Programme 3 Stage 4) ─────────────────────────
     *
     * A **read-only** DSN for a Foundry-owned database holding generated
     * fixtures, with the same schemas, tables and columns as this datasource.
     * A run in the DRAFT namespace reads it instead of `connection_string_enc`.
     *
     * ⚠ Selection is bound to the NAMESPACE, never to a request or to a column
     * here (`step-execution.service.ts`). This column answers *"does a sandbox
     * exist"* and nothing else — there is deliberately no `use_sandbox` flag,
     * because a flag is a thing somebody turns off for one run.
     *
     * NULL means no sandbox has been provisioned, and a draft run against this
     * datasource therefore reads **production**. That is not silent: the step
     * result carries `readFrom: "production"` and a warning, and the run view
     * renders it. See DECISIONS.md D-52.
     */
    sandboxDsnEnc: text("sandbox_dsn_enc"),
    /** The Foundry-owned database the sandbox lives in. Derived, never user input. */
    sandboxDbName: varchar("sandbox_db_name", { length: 63 }),
    /** Which frozen `datasource_fixtures` row the sandbox database was materialised from. */
    sandboxFixtureVersion: integer("sandbox_fixture_version"),
    /**
     * Provisioning state, for the automatic build at onboarding — migration
     * `0056`, CHECK-constrained to `building | ready | failed` in the DATABASE
     * and not only here (the discipline `workspace_members.role` and
     * `flow_expectation_results.status` already follow).
     *
     * ⚠ `failed` and NULL are DIFFERENT and must stay so. NULL is "nobody has
     * asked"; `failed` is "we asked, it did not work, and `sandboxBuildError`
     * says why". Rendering the second as the first is an absence standing in
     * for an error. **Neither satisfies `hasSandbox`** — a draft run still
     * reads production in both cases and still says so, which is the property
     * that makes a failed build safe rather than merely visible.
     */
    /**
     * What this datasource is ALLOWED to do — `read` | `read_write` | `full`.
     *
     * ⚠ **A decision, and `credentialCanWrite` below is an observation.** They
     * are deliberately two columns because the case this feature exists for is
     * the one where they DISAGREE: an administrator credential on a datasource
     * declared `read`. Collapsing them into "is it read-only" loses exactly
     * that, and it is the state a tenant who cannot create a role arrives in.
     *
     * ⚠ **This is not a promise, it is enforced where it cannot be argued
     * with.** A `read` datasource runs its statements inside
     * `BEGIN READ ONLY` (`step-execution.service.ts`), so Postgres refuses the
     * write itself whatever the credential is granted. A column that only
     * documented an intention would be the `faFallback` shape applied to a
     * security boundary — the screen says read-only and nothing makes it true.
     *
     * CHECK-constrained in `0067`, VALID rather than NOT VALID. A value outside
     * the set is neither a policy nor a refusal, and the gate reads this column
     * to decide whether to open the transaction.
     */
    accessPolicy: varchar("access_policy", { length: 16 }).notNull().default("read"),
    /**
     * Whether the CREDENTIAL could write, measured at registration.
     *
     * Nullable on purpose: null is "not known" — a row registered before this
     * column, or a target that could not be probed — and must never read as
     * "cannot write". Recorded rather than refused (see `accessPolicy`), so the
     * onboarding screen can say what the credential can actually do beside what
     * the policy allows.
     */
    credentialCanWrite: boolean("credential_can_write"),
    sandboxBuildStatus: varchar("sandbox_build_status", { length: 16 }),
    sandboxBuildError: text("sandbox_build_error"),
    sandboxBuildStartedAt: timestamp("sandbox_build_started_at", { withTimezone: true }),
    // B-13 — widened read: ResourceStatus + owner + health + category + safe-data
    resourceStatus: text("resource_status"),
    ownerSubject: text("owner_subject"),
    ownerName: varchar("owner_name", { length: 255 }),
    ownerAvatarUrl: text("owner_avatar_url"),
    health: text("health"),
    healthNote: text("health_note"),
    resourceCategory: text("resource_category"),
    hasMockData: boolean("has_mock_data").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    resourceStatusIdx: index("idx_datasources_resource_status").on(t.resourceStatus),
    healthIdx: index("idx_datasources_health").on(t.health),
    categoryIdx: index("idx_datasources_resource_category").on(t.resourceCategory),
    ownerIdx: index("idx_datasources_owner_subject").on(t.ownerSubject),
    mockIdx: index("idx_datasources_has_mock").on(t.hasMockData),
  }),
);

/** Raw bytes. Drizzle has no built-in `bytea`; this is the whole of one. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * An uploaded database FILE — today only a SQLite database behind a `sqlite`
 * datasource (migration 0078).
 *
 * ⚠ **The file IS the credential for a sqlite datasource**, so it is stored the
 * way a DSN is: encrypted with `CREDENTIAL_ENC_KEY` (`encryptBytes`), never
 * served back. The datasource's `connection_string_enc` holds only
 * `sqlite:file/<id>`, a pointer into this table, and the file is materialised
 * to a private temp path at read time (`sqlite-file.service.ts`).
 *
 * ⚠ `workspace_id` is NOT NULL and is what registration checks: a pointer to
 * another workspace's file is refused, because the pointer is a string a
 * caller could otherwise type. `datasource_id` is null between upload and
 * registration; an unclaimed upload is swept after a day.
 */
export const datasourceFiles = pgTable(
  "datasource_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    datasourceId: uuid("datasource_id").references(() => datasources.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull().default("sqlite"),
    filename: varchar("filename", { length: 255 }),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    contentEnc: bytea("content_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("idx_datasource_files_workspace").on(t.workspaceId),
    datasourceIdx: index("idx_datasource_files_datasource").on(t.datasourceId),
  }),
);

/**
 * A workspace's FILES (Resources → Files, 2026-10-12): documents, sheets, images and text a workflow reads when it
 * RUNS — a rate card, a policy, a template. Not chat attachments (context for Forge while building) and not a SQLite
 * data source (read by queries). A step declares `file:<name>` in its uses and opens it with `foundry.file(name)`.
 *
 * Encrypted like an uploaded datasource file. 50 MB per file, 1 GB per workspace (`config.workspaceFiles`). A name is
 * unique in its workspace: a step names the file, so two with one name would make that name mean either.
 */
export const workspaceFiles = pgTable(
  "workspace_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    contentEnc: bytea("content_enc").notNull(),
    uploadedBy: varchar("uploaded_by", { length: 320 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("uq_workspace_files_name").on(t.workspaceId, t.name),
  }),
);

/**
 * A file a running STEP saved — the Excel report it built, say — so a tool call can carry it by id rather than as
 * rows inside a JSON body (2026-10-12: a 103k-row email died at the 5 MB step-call limit as a broken pipe).
 *
 * Scoped to one execution: only the run that saved a file can attach it. Encrypted like an uploaded datasource file,
 * because it is tenant data. Short-lived — swept a day after it is saved (`stepFileRepo.sweep`); what was delivered
 * is in the recipient's mailbox and the sender's Sent Items.
 */
export const stepFiles = pgTable(
  "step_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowExecutionId: uuid("flow_execution_id").notNull(),
    stepId: varchar("step_id", { length: 200 }),
    name: varchar("name", { length: 255 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    executionIdx: index("idx_step_files_execution").on(t.flowExecutionId),
    createdIdx: index("idx_step_files_created").on(t.createdAt),
  }),
);

/**
 * A FROZEN set of generated fixture rows for one datasource.
 * DECISIONS.md D-53 (the programme's own VERIFICATION.md was deleted 2026-08-04)
 *
 * ── Why the rows live HERE and not only in the sandbox database ──────────────
 *
 * The plan asks for fixtures "generated once and frozen, versioned like a `code`
 * fragment", and a materialised database is the wrong home for that: it is
 * mutable by anything holding its owner credential, it is outside `pnpm backup`'s
 * core list, and a re-provision that silently produced different rows would make
 * yesterday's passing test fail for a reason nobody could reconstruct.
 *
 * So the fixture is DATA in `foundry_parent` — insert-only, versioned, hashed —
 * and the sandbox database is a **projection** of it that can be dropped and
 * rebuilt byte-identically. That also means the sandbox needs no backup entry of
 * its own; restoring the parent restores the fixture, and `sandbox:provision`
 * rebuilds the rest.
 *
 * ⚠ Insert-only. There is no update path and there must not be one: a fixture
 * that moves under a test is the failure this table's whole shape exists to
 * prevent. Regeneration writes a NEW version and re-points the datasource.
 */
export const MOCK_STATUSES = ["building", "ready", "failed"] as const;
export type MockStatus = (typeof MOCK_STATUSES)[number];

export const datasourceFixtures = pgTable(
  "datasource_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasourceId: uuid("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** `{ "<schema>.<table>": [ { column: value, … }, … ] }` — the rows themselves. */
    rowsJson: jsonb("rows_json").$type<Record<string, Array<Record<string, unknown>>>>().notNull(),
    /** The DDL derived from introspection at generation time, replayed verbatim on provision. */
    ddlSql: text("ddl_sql").notNull(),
    /**
     * A hash of the introspected SHAPE this fixture was generated against.
     *
     * Drift detection (plan item 5): the source schema moving means the sandbox
     * is testing a shape production no longer has. Compared, never assumed —
     * a stale sandbox is wrong in the direction that reads as a passing test.
     */
    schemaFingerprint: varchar("schema_fingerprint", { length: 80 }).notNull(),
    /** The taxonomy report as VERIFIED FROM SQL against the materialised database. */
    taxonomyJson: jsonb("taxonomy_json").notNull(),
    /** `model` or `authored`. An authored fixture is only ever a test's negative control. */
    generatedBy: varchar("generated_by", { length: 20 }).notNull(),
    /** Which model wrote the rows, when one did. A reading is only quotable with its subject. */
    model: varchar("model", { length: 120 }),
    /**
     * Mock-data build readiness: `building` | `ready` | `failed`.
     * Defaults to `building` so a freshly inserted row never reads as usable.
     * `failed` and "no row" are DIFFERENT — neither satisfies hasMock.
     */
    mockStatus: varchar("mock_status", { length: 16 }).notNull().default("building"),
    /** Why the mock build failed, when `mockStatus` is `failed`. NULL otherwise. */
    mockError: text("mock_error"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    versionUnique: unique("uq_datasource_fixtures_version").on(t.datasourceId, t.version),
    dsIdx: index("idx_datasource_fixtures_ds").on(t.datasourceId),
  }),
);

// Schemas: extracted metadata (normalized). Structure + aggregate stats only.
export const schemas = pgTable(
  "schemas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasourceId: uuid("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    // WS-C.2: table | view | materialized_view | foreign_table | collection | key_space
    entityType: varchar("entity_type", { length: 20 }).notNull(),
    entityName: varchar("entity_name", { length: 255 }).notNull(),
    // WS-C.1: NULL means "the datasource's default schema". Set when the entity
    // lives in a named schema, so generated SQL can qualify it.
    entitySchema: varchar("entity_schema", { length: 255 }),
    columnName: varchar("column_name", { length: 255 }), // NULL for entity-level metadata
    // ⚠ `text`, not varchar: a type name plus an enum's MEMBERS has no honest
    // upper bound. varchar(100) overflowed on a real schema and 500d
    // `/schema/refresh` — see migration 0068.
    columnType: text("column_type"),
    isPrimaryKey: boolean("is_primary_key").default(false),
    isForeignKey: boolean("is_foreign_key").default(false),
    foreignKeyReference: varchar("foreign_key_reference", { length: 255 }),
    nullable: boolean("nullable").default(true),
    /**
     * A semantic tag the SCHEMA OWNER declared on the column, as a Postgres comment `foundry:tag=<tag>[;k=v…]`
     * (compiled-builder D-313, I-278). Stored verbatim after the prefix. Never inferred from a column name (§5 rule 3).
     */
    semanticTag: text("semantic_tag"),
    /**
     * The values this column can hold, when known (compiled-builder I-301): `declared` by the schema (an enum type, a
     * `CHECK (col IN (…))`), or `observed` — the distinct values of a set-of-choices column, read at every introspection
     * (services/introspect/choice-set.ts; the opt-in `observe_values` switch was dropped in 0091). NULL means UNKNOWN, never "any": a filter on such a column is read back as unchecked.
     */
    valueDomain: jsonb("value_domain").$type<{ values: string[]; source: "declared" | "observed" }>(),
    characterMaximumLength: integer("character_maximum_length"),
    rowCountEstimate: bigint("row_count_estimate", { mode: "number" }),
    nullPercentage: numeric("null_percentage", { precision: 5, scale: 2 }),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // WS-C.1: entitySchema is part of the key. Without it, `hr.staff` and
    // `public.staff` collide on insert — which is exactly the case a schema
    // allowlist exists to support, so the constraint would fail the first time
    // anyone used the feature.
    uq: unique().on(t.datasourceId, t.entityType, t.entitySchema, t.entityName, t.columnName),
    dsIdx: index("idx_schemas_datasource").on(t.datasourceId),
    entityIdx: index("idx_schemas_entity").on(t.entityType, t.entityName),
  }),
);

// Workspace Manifests: single versioned XML descriptor per workspace.
export const workspaceManifests = pgTable(
  "workspace_manifests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    hash: varchar("hash", { length: 80 }).notNull(),
    manifestXml: text("manifest_xml").notNull(),
    summaryXml: text("summary_xml").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.workspaceId, t.version),
    wsIdx: index("idx_manifests_workspace").on(t.workspaceId, t.version),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// DELETED IN PHASE 4 (task 4.11): `scripts`, `script_versions`, `test_results`,
// `execution_results`.
//
// The monolithic path they served — one prompt in, one ~8-10k-token Python
// program out, run in Foundry's own Docker runner — is replaced by `flows`,
// `flow_revisions`, `flow_steps`, `flow_executions` and `flow_step_runs`. No
// backward compatibility is owed; nothing was in production.
//
// Two columns are worth naming as they go, because they are the design being
// abandoned rather than incidental fields:
//
//   scripts.requirements / .requirements_filename
//       Per-script dependency resolution. Replaced by ONE pinned base image
//       (`foundry/fragment-base:py3.12-pandas2.2.3`), which is what makes a
//       fragment's import set knowable at generation time instead of at pip's.
//
//   test_results.audit_verdict / .audit_json
//       `generation-audit.service.ts`, deleted with them. It verified
//       PLAUSIBILITY, not correctness, and it marked `clean` the script that
//       hardcoded `period="2023-10"` and emailed 0 of 11 people. Its structural
//       replacement is manifest compliance plus R9 — a fragment that cannot
//       reach the network cannot call a host the audit would have flagged.
//
// It was deletable only because `datasource` steps run NAMED QUERIES rather
// than generated SQL. If a generated-SQL step kind is ever introduced,
// resurrect the audit for that kind alone — and keep its `attempted_write`
// negative tests, which exist because ordinary prose ("Rows to insert into the
// spreadsheet") otherwise matches.
// ────────────────────────────────────────────────────────────────────────────

// Triggers: fire a FLOW at runtime.
export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Every trigger binds to a flow. Still NULLABLE: it had to be while
     * `script_id` existed beside it, and dropping `scripts` in Phase 4 did not
     * make the column NOT NULL retroactively. `triggerService.createForFlow` is
     * the only constructor, and `fire()` refuses a trigger bound to nothing
     * rather than treating it as a no-op success.
     */
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(), // manual, schedule, poll, webhook
    config: jsonb("config"),
    webhookToken: varchar("webhook_token", { length: 128 }),
    enabled: boolean("enabled").default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    flowIdx: index("idx_triggers_flow").on(t.flowId),
  }),
);

// Trigger fires: audit of each firing → the execution it launched.
export const triggerFires = pgTable(
  "trigger_fires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    /**
     * The `execution_results` row this fire started. That table was dropped in
     * Phase 4 (4.11) and the FK went with it, so the column is now a plain uuid
     * that a flow fire always leaves NULL — a flow execution is linked the other
     * way round, by `flow_executions.trigger_fire_id`.
     *
     * Kept rather than dropped because `trigger_fires` is an audit trail and
     * rewriting history to match a new schema is the one thing an audit trail
     * must not do.
     */
    executionId: uuid("execution_id"),
    firedBy: varchar("fired_by", { length: 20 }).notNull(), // manual, schedule, poll, webhook
    payload: jsonb("payload"),
    firedAt: timestamp("fired_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    triggerIdx: index("idx_trigger_fires_trigger").on(t.triggerId, t.firedAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// KESTRA MIGRATION — Phase 0
// (archive/kestra-migration/08-scale-and-phasing.md §M3, §M4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * M3 — per-tenant concurrency budget, plus M4's cost ceiling.
 *
 * Kestra OSS has no per-tenant resource quotas (Worker Isolation is EE), so on a
 * shared instance one client's runaway flow starves every other client. Kestra's
 * own flow-level `concurrency` only stops a flow overlapping ITSELF; nothing in
 * the engine stops one tenant monopolising the pool. This table is the only
 * control that does, and the plan is explicit that it is built at client #1, not
 * client #20 — it is cheap now and an expensive retrofit later.
 *
 * Keyed by WORKSPACE despite the name. §7.4 specifies `workspace_id`, and the
 * workspace is what actually shares a credential and therefore a rate limit
 * (§5.0). There is no `tenants` table in this schema yet; the per-tenant ceiling
 * that §5.0 also calls for needs one first. See DECISIONS.md D-03.
 *
 * Enforced in `POST /api/executions/begin` — the flow's FIRST task — not in the
 * scheduler, because from §5.4 onward Kestra initiates scheduled executions and
 * Foundry no longer has a pre-flight hook. A refused `begin` fails the execution
 * at step 1 with nothing downstream having run.
 */
export const tenantBudgets = pgTable(
  "tenant_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Concurrent Kestra executions this workspace may have in flight (M3).
    maxConcurrentExecutions: integer("max_concurrent_executions").notNull().default(5),
    /**
     * M4 — spend, not concurrency. Agent steps are the expensive ones: measured
     * ~37 tok/s decode and 5–6 min per run, so "one agent run per business
     * entity" caps in the low hundreds per day (§9). This makes that ceiling
     * explicit instead of discovered.
     */
    maxTokensPerDay: bigint("max_tokens_per_day", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // One budget per workspace. Two would make enforcement order-dependent, the
    // same failure shape as a duplicated secret name (WS-B).
    wsUnique: unique("uq_tenant_budgets_workspace").on(t.workspaceId),
  }),
);

/**
 * Named datasource queries — the replacement for generated SQL.
 * (07 §7.0: "`datasource` steps use named queries, not generated SQL.")
 *
 * This kills a measured failure mode outright — "missing `COALESCE` to a policy
 * default in hand-written SQL" — and it is what makes
 * `generation-audit.service.ts` deletable: if no SQL is ever generated, there is
 * no generated SQL to audit for manifest compliance or `attempted_write`.
 *
 * Ad-hoc shaping becomes a `code` step over what a named query fetched — pure,
 * contract-bound, and structurally unable to write. If genuinely ad-hoc SQL is
 * needed later, add a separate `query` step kind and resurrect the audit for
 * that kind alone rather than loosening this one.
 *
 * A flow references a query as `<datasource-name>.<query-name>`.
 */
export const datasourceQueries = pgTable(
  "datasource_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasourceId: uuid("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /**
     * Parameterised SQL using positional placeholders ($1, $2 …). NEVER
     * interpolated — `paramOrder` names which declared parameter fills each
     * position, so a step's params cannot become SQL.
     */
    sqlText: text("sql_text").notNull(),
    /** Ordered parameter names, index i → $\{i+1\}. */
    paramOrder: jsonb("param_order").$type<string[]>().notNull().default([]),
    /** Per-parameter JSON-schema-ish descriptors, rendered into the manifest. */
    paramsSchema: jsonb("params_schema"),
    /**
     * What the database says this query takes and returns, described at registration without reading a row
     * (compiled-builder I-271, G13): `{ params: [{name, type}], columns: [{name, type, nullable, tag}] }`. NULL when it
     * could not be described. ⚠ NOT in the ref fingerprint: it is derived from `sql_text`, which already is.
     */
    describedJson: jsonb("described_json"),
    /**
     * Tags the query's OWNER declares on result columns no column comment reaches — a computed `COALESCE(…) AS notify_email`
     * (`services/query-column-tags.ts`): column name → `email` | `key`. Declared, never inferred; checked against the described
     * columns. ⚠ NOT in the ref fingerprint, like `described_json`: it changes what a flow is type-checked against, not what runs.
     */
    columnTags: jsonb("column_tags").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    nameUnique: unique("uq_datasource_queries_name").on(t.datasourceId, t.name),
  }),
);

/**
 * Named DATABASE OPERATIONS — the `query` step kind's callable, 07 §7.0.
 *
 * A named query (`datasource_queries` above) holds hand-written SQL that was
 * reviewed once, by a human, in a file. A DB operation is the other half of the
 * design-sanctioned path: the author builds a `DbOperationSpec` VISUALLY — base
 * table, columns with optional aggregates, joins from the FK graph,
 * parameterized filters, sort, limit — and the server COMPILES it to a read-only
 * `SELECT`. The author never writes SQL, so the file-review argument is replaced
 * by the compiler's own shape rules (`checkSqlShape`), and only schema metadata
 * is ever exposed to the author or the manifest.
 *
 * A flow references an operation as `<datasource-name>.<operation-name>`, the
 * same ref grammar as a named query. `spec_json` is the source of truth (the
 * visual builder round-trips it); `compiled_sql` is the projection the executor
 * runs, parameterized positionally ($1..$n in filter order); `params_schema`
 * describes exactly the filter `param` names, in the same flat vocabulary as
 * `tools.paramsSchema`.
 */
export const datasourceOperations = pgTable(
  "datasource_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    datasourceId: uuid("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    // The ref suffix. The name IS the ref, so a rename is a delete plus a
    // create — the same rule as `datasource_queries` (see routes/datasources.ts).
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /** The visual spec — `DbOperationSpec`, zod-validated in db-operation.service.ts. */
    specJson: jsonb("spec_json").notNull(),
    /** The compiled read-only SELECT with positional $1..$n placeholders. */
    compiledSql: text("compiled_sql").notNull(),
    /** Flat `{param: {type, required, description}}` map — tool paramsSchema vocabulary. */
    paramsSchema: jsonb("params_schema").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    nameUnique: unique("uq_datasource_operations_name").on(t.datasourceId, t.name),
    wsIdx: index("idx_datasource_operations_workspace").on(t.workspaceId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// KESTRA MIGRATION — Phase 3: flows, revisions, and the approval gate
// (archive/kestra-migration/05-lifecycle-and-flows.md §6.5, 07 §7.4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * An automation, as a flow of declared steps.
 *
 * `kestra_flow_id` is the id the flow carries in BOTH namespaces — the same flow
 * exists in `<prefix>.<tenant>.<ws>.draft` (the working revision) and, once
 * approved, in `<prefix>.<tenant>.<ws>` (the approved one). Two namespaces, one
 * flow id, so promotion is a deploy rather than a rename.
 *
 * `armed_revision` is the revision currently deployed LIVE. It is deliberately
 * separate from `draft_revision`: editing an armed flow moves the draft and
 * leaves this alone, which is the whole of §6.5's guarantee.
 */
export const flows = pgTable(
  "flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /** Slug-shaped; the flow's id inside both Kestra namespaces. Immutable. */
    kestraFlowId: varchar("kestra_flow_id", { length: 255 }).notNull(),
    /** Highest revision that exists. Always deployed to the draft namespace. */
    draftRevision: integer("draft_revision").notNull().default(0),
    /** The approved revision deployed live, or NULL when nothing is armed. */
    armedRevision: integer("armed_revision"),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    /**
     * What this automation was DESIGNED against — platform-coherence Phase 3.3,
     * I-105. `{datasourceIds: uuid[], toolRefs: string[]}`, or NULL.
     *
     * ⚠ NULL means *nobody chose*, not *everything was chosen*. The flow was
     * designed against the whole workspace, or it predates the column. Migration
     * 0030 deliberately backfills nothing: writing the then-current catalogue
     * into every row would record a decision nobody made, and later nothing
     * could tell a deliberate scope from a migration's guess.
     *
     * ⚠ Design-time intent, NOT part of what runs. It does not compile to YAML,
     * it is not in `refFingerprints()`, and editing it moves no fingerprint and
     * suspends nothing. That is why it lives on the flow rather than on the
     * immutable revision an approval binds to (§6.5) — a scope change is not a
     * behaviour change, and making it produce a revision would tell the approval
     * screen otherwise.
     */
    designSelection: jsonb("design_selection"),
    /**
     * Per-flow chat configurability (Phase 5) — `{model, instructions,
     * suggestions}`, or NULL when nobody configured the chat.
     *
     * ⚠ NULL means *nobody chose*, not *the default was chosen*, and the read
     * path (`parseChatConfig`) treats an unparseable row the same way. Same
     * posture as `designSelection` above it: design-time intent, NOT part of
     * what runs — it is not in `refFingerprints()`, and editing it writes no
     * revision and suspends nothing, which is why `updateMeta` owns it.
     */
    chatConfig: jsonb("chat_config"),
    /**
     * The flow's INCOMPLETE working copy (compiled-builder D-319) — `{basedOnRevision, model, savedAt}`, where `model` is the
     * legal-move engine's state WITH its holes, or NULL when there is none.
     *
     * ⚠ On the flow, never a revision. A revision is complete by construction (`gateRevisionModel` refuses holes), and
     * approvals, runs, replays and triggers all name a revision — so a working copy cannot be approved or run because
     * nothing can address it, not because each of those paths checks. Written only by `flowService.saveIncomplete`, which
     * refuses any state the engine's `checkState` calls an error: incomplete is allowed, invalid is not.
     */
    incompleteModel: jsonb("incomplete_model"),
    /**
     * Which engine runs this flow (migration 0083, pi-runtime P3). `kestra`: a compiled FlowModel.
     * `foundry`: a Pi bundle in `flow_revisions.model_json`, run by flow-runner. Every Kestra seam branches on it once.
     */
    runtime: varchar("runtime", { length: 16 }).notNull().default("kestra"),
    /**
     * Whose automation this is (migration 0101, rbac-observability) — an identity SUBJECT, never a name. A draft is
     * private to its owner (and to whoever holds `content.read.others`) until its owner makes it public. NULL is an
     * automation nobody can be shown to own: Admins (and Reviewers) see it, Creators do not.
     */
    ownerSubject: text("owner_subject"),
    /**
     * Who sees it (migration 0112, plugins phase 9): `private` — its owner (and Admins and Reviewers); `public` — the
     * whole workspace. The OWNER chooses, and it is separate from approval: approving switches an automation on, it
     * no longer publishes it. Backfilled `public` for every automation that had been approved, which is what
     * published meant before.
     */
    visibility: varchar("visibility", { length: 16 }).notNull().default("private"),
    /**
     * The owner asked a reviewer to approve this revision (migration 0120, sharing-boundaries). A reviewer sees a
     * PRIVATE workflow only while this is set or once it is live; approving any revision clears it.
     */
    reviewRequestedRevision: integer("review_requested_revision"),
    /**
     * When it is shared (public), may its members EDIT it (migration 0123, sharing-boundaries D2)? Default yes; its owner
     * can make it view-only. Deleting it, making it private, whose account it acts as, switching it on/off and asking
     * for approval stay its owner's (or an Admin's) whatever this says.
     */
    othersMayEdit: boolean("others_may_edit").notNull().default(true),
    /** The project it lives in (sharing-boundaries 0128); NULL = My space or the Workspace (`visibility`). */
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
    reviewRequestedBy: text("review_requested_by"),
    reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    ownerIdx: index("idx_flows_owner_subject").on(t.workspaceId, t.ownerSubject),
    // One flow id per workspace: the pair is what a Kestra namespace addresses.
    flowIdUnique: unique("uq_flows_workspace_flow_id").on(t.workspaceId, t.kestraFlowId),
    wsIdx: index("idx_flows_workspace").on(t.workspaceId),
  }),
);

/**
 * An IMMUTABLE snapshot of a flow's model.
 *
 * Immutable is the point. Approval binds to a revision (§6.5), so if a revision
 * could be edited in place, approving one would be a blank cheque over whatever
 * it later became — privilege escalation by editing. Editing creates a new row;
 * nothing ever updates `model_json`.
 *
 * `model_json` is Foundry's MODEL, never YAML (§7.4). The YAML is derived by
 * `flow-compiler.service.ts`, which is the only emitter in the system (R8), and
 * only its hash is kept here — enough to detect that the same model compiled to
 * something different, without making Foundry a second system of record for
 * content Kestra already versions (R6).
 */
export const flowRevisions = pgTable(
  "flow_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    modelJson: jsonb("model_json").notNull(),
    compiledYamlHash: varchar("compiled_yaml_hash", { length: 71 }).notNull(),
    /**
     * Structural digest of the model — steps, kinds, refs, dependencies. Two
     * revisions differing ONLY in a code fragment share it.
     *
     * §6.5's asymmetry rests on this: a structure change needs human
     * re-approval, a fragment-body change needs only a re-test. At 1-of-3
     * first-pass accuracy every regeneration would otherwise become an approval
     * cycle, and that friction is what gets the gate switched off.
     */
    structureHash: varchar("structure_hash", { length: 71 }).notNull(),
    /** Author identity, recorded so an approver can be checked against it. */
    createdBy: varchar("created_by", { length: 255 }),
    /**
     * Whether anything verified `created_by` — `user` | `system` | `unknown`.
     * archive/GAPS.md §1.2 · ISSUES.md I-32 · `services/revision-author.ts`
     *
     * The name alone was the defect. It came from a verified identity through
     * the browser and from a body field everywhere else, and the row did not
     * say which — so gate 2's self-approval refusal compared one value the
     * server established against one it may merely have been told, and a caller
     * holding the API key could author as `someone-else@…` and approve as
     * themselves.
     *
     * ⚠ **NOT NULL with no database default, deliberately.** A default would let
     * a new writer omit the column and silently acquire a provenance; drizzle's
     * `$inferInsert` makes omitting it a compile error instead. The cost is that
     * `insertRevision` cannot be called without an answer, which is the cost
     * being bought.
     *
     * ⚠ It is NOT part of any fingerprint. `refFingerprints()` hashes tools and
     * named queries only, and `structureHash` hashes the model — neither reads
     * this table, so adding the column moved no ref fingerprint and suspended no
     * armed flow.
     */
    createdByKind: varchar("created_by_kind", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /**
     * When somebody hid this revision from the version list — migration 0055.
     *
     * ⚠ **`hidden_at`, not `deleted_at`, and the name is the point.** The row is
     * never removed: an approval points at a revision, a replay re-runs its
     * model, and a diff reads it as the `from` side. Calling the column
     * `deleted_at` would invite a future `WHERE deleted_at IS NULL` on
     * `getRevision`, which is precisely the read that must NOT be filtered —
     * and the damage would appear as a replay failing on a run that used to
     * work, a long way from the column that caused it.
     *
     * Only `listRevisions` filters on it. `flow_revisions` therefore remains
     * insert-only for every purpose D-37 cares about.
     */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /**
     * The GoalSpec the person CONFIRMED for this revision (compiled-builder D-304), and the build's trace — every decision
     * with its alternatives and its chooser (phase 4 exit gate). Migration 0075. NULL for every writer other than the new
     * builder. ⚠ Neither is in `structureHash`: the spec is what the flow is checked AGAINST (P8), not what runs.
     */
    goalSpec: jsonb("goal_spec"),
    buildTrace: jsonb("build_trace"),
  },
  (t) => ({
    revUnique: unique("uq_flow_revisions_revision").on(t.flowId, t.revision),
  }),
);
/**
 * B-11 · `flow_phases` — background frames for the builder canvas (S-07).
 *
 * Phases are per-revision background frames, not collapsible groups (flows/02:48):
 * `APPLY POLICY · 1 item needs attention`, `CHECK EXCEPTIONS`, `NOTIFY`, `PUBLISH`
 * each as a labelled frame with attention mark. S-10 repeats them as `PHASE N`
 * eyebrow + title + description in the Steps outline; S-29 is prose-only but
 * defines the same 7 phases implicitly. Lane gap 56px is CSS only.
 *
 * Why per-revision (FK → `flow_revisions.id`, CASCADE): approval binds to a
 * revision (§6.5), so a phase that could change under an approval would defeat
 * it — same immutability as `flow_steps`. Background frames, not groups: the
 * builder still renders derived grouping from `flow_steps.phase_id` when present,
 * but the revision now carries its own frames (Phase 2 builder canvas will read
 * them via `GET /workspaces/:ws/flows/:id/phases`).
 */
export const flowPhases = pgTable(
  "flow_phases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowRevisionId: uuid("flow_revision_id")
      .notNull()
      .references(() => flowRevisions.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    summary: text("summary"),
    lane: integer("lane").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => ({
    revisionIdx: index("idx_flow_phases_revision").on(t.flowRevisionId, t.ordinal),
    revisionIdIdx: index("idx_flow_phases_revision_id").on(t.flowRevisionId),
  }),
);


/**
 * One step of one revision.
 *
 * Keyed by `(flow_id, revision, step_id)` rather than mutated in place, for the
 * same reason `flow_revisions` is immutable: approval is revision-scoped, so a
 * step definition that could change under an approval would defeat it (§7.4).
 *
 * Denormalised out of `flow_revisions.model_json` on purpose — `manifest_refs_json`
 * is queried per step to detect approval staleness, and digging it out of a JSON
 * blob per flow per sweep is the sort of thing that quietly stops being run.
 */
export const flowSteps = pgTable(
  "flow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    stepId: varchar("step_id", { length: 255 }).notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // tool|datasource|query|transform|code|agent|approval|branch
    configJson: jsonb("config_json").notNull(),
    generatedCode: text("generated_code"),
    /**
     * `{ "<ref>": "<fingerprint>" }` for every tool / datasource / named query
     * this step uses, captured at the moment the revision was written.
     *
     * Compared against the current manifest to detect staleness (§6.5): a client
     * approved a flow against a tool with three parameters, and if that tool
     * gains a required fourth the approved flow is now wrong. Per REF, not per
     * manifest version — a manifest bump that touches nothing this flow uses
     * must not suspend it.
     */
    manifestRefsJson: jsonb("manifest_refs_json").$type<Record<string, string>>().notNull().default({}),
    /**
     * A `code` step's **contract** — `{purpose, input[], output[]}`. NULL for
     * every other kind. 04 §5.3 · phase-4.md 4.10
     *
     * Stored beside `generated_code` rather than inside `config_json` because
     * the two have different lifetimes and different audiences. The contract is
     * what a human reads and approves and what a regeneration is driven FROM;
     * the code is derived from it and is re-derivable at any time. Losing the
     * code costs one inference call. Losing the contract means a fragment can
     * only ever be regenerated from a prompt somebody reconstructs by hand.
     *
     * It is also why regenerating one step cannot disturb its siblings
     * (assertion 19): a fragment is a function of this column and nothing else,
     * so there is no shared state for a regeneration to touch.
     */
    contractJson: jsonb("contract_json"),
    /**
     * B-11: which background phase frame this step sits in, if any.
     * FK → `flow_phases.id` SET NULL so deleting a phase does not delete its
     * steps — phases are frames, not groups. Nullable so existing rows stay
     * valid and unphased steps remain honest-empty.
     */
    phaseId: uuid("phase_id").references(() => flowPhases.id, { onDelete: "set null" }),
  },
  (t) => ({
    stepUnique: unique("uq_flow_steps_step").on(t.flowId, t.revision, t.stepId),
    revIdx: index("idx_flow_steps_revision").on(t.flowId, t.revision),
    phaseIdx: index("idx_flow_steps_phase").on(t.phaseId),
  }),
);

/**
 * A step's hand-arranged canvas position, OUTSIDE the revision.
 *
 * This is the plan's decision ② / D-150: full free positioning, persisted
 * outside the revision, because the revision write path is what an approval
 * binds to — a cosmetic drag must never create a revision and invalidate an
 * approval. Row counts on this table therefore say nothing about approval
 * semantics: it is a MIRROR of the human arrangement, never an audit log.
 *
 * Reconciliation lives CLIENT-side at save time (D-150): rows are dropped when
 * a step is deleted, re-keyed when a step is renamed (rename IS a new id in
 * `@foundry/flow-edit`), and written only when the user actually drags. The
 * server is deliberately dumb — GET returns the rows, PUT replaces the flow's
 * set wholesale — and neither path ever reads or writes `flow_revisions` or
 * `writeRevision` (pinned by test).
 */
export const flowStepPositions = pgTable(
  "flow_step_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    stepId: varchar("step_id", { length: 255 }).notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * The key: one row per (flow, step) — D-150(a). No workspace column: a
     * flow id is a globally-unique uuid, so a workspace column would
     * denormalise a fact the flow row already owns. Workspace-scoping happens
     * at the API layer, exactly as it does for every flow route.
     */
    flowStepUnique: unique("uq_flow_step_positions_flow_step").on(t.flowId, t.stepId),
  }),
);

/**
 * A human's approval of ONE revision to run unattended (§6.5, gate 2).
 *
 * Rows are never deleted and never rewritten except to close them: revoking
 * stamps `revoked_at`, going stale stamps `stale_at`. An approval history that
 * can be edited is not an approval history.
 *
 * `manifest_fingerprint` is the aggregate of every ref the revision touched, at
 * the moment of approval — the thing a staleness sweep compares against.
 */
export const flowApprovals = pgTable(
  "flow_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    /**
     * Who approved. Checked against `flow_revisions.created_by` so an author
     * cannot approve their own revision.
     *
     * **VERIFIED since Stage 9.1** — it comes from a signed identity token, not
     * from the request body, and the route refuses a body that carries the
     * field at all. Holding `PARENT_API_KEY` no longer lets a caller name an
     * approver, which is the specific thing I-13 recorded.
     *
     * ⚠ Still not separation of duties — but no longer for the reason this line
     * used to give. Roles EXIST since GAPS §1.1 (`workspace_members`, and
     * `requireWorkspaceRole("approver")` on the route), so a signed-in person
     * who was never granted the role in this workspace is refused. What remains
     * is that anything holding `RUNTIME_JWT_SECRET` mints any identity, and the OTHER side
     * of the self-approval check — `flow_revisions.created_by` — is verified
     * only when the flow was authored through the browser (I-32). What is no
     * longer true is the last half of that sentence: `revision_author_kind`
     * below records which, so a system-authored approval is a state rather than
     * a name nobody checked.
     */
    approverUserId: varchar("approver_user_id", { length: 255 }).notNull(),
    approverKind: varchar("approver_kind", { length: 20 }).notNull().default("client_admin"),
    /**
     * The approver wrote this revision AND was a super admin, so the
     * self-approval refusal was overridden — migration 0041.
     *
     * ⚠ **The exemption exists because it was asked for, and the column exists
     * because an exemption with no trace is worse than no exemption.** Without
     * it, *"a second pair of eyes approved this"* and *"its own author approved
     * it under an override"* would be the same row, and the approval history —
     * which IS the audit artefact — would silently stop meaning the first.
     *
     * `false` on every pre-existing row and on every ordinary approval, so the
     * stronger reading still holds wherever this is false.
     */
    selfApprovedOverride: boolean("self_approved_override").notNull().default(false),
    /**
     * Switched on by its OWNER, with no reviewer, because the revision uses only the owner's own things (migration
     * 0112, plugins phase 9 — `automation-reach.ts` decides, from the revision itself). Distinct from
     * `self_approved_override`: that is a super admin approving their own work; this is nobody approving, by design.
     */
    selfEnabled: boolean("self_enabled").notNull().default(false),
    /**
     * What `flow_revisions.created_by_kind` said about the revision being
     * approved, AT THE MOMENT OF APPROVAL — archive/GAPS.md §1.2.
     *
     * The refusal is unchanged: it still compares the approver against the
     * recorded author, and it still fires for a `system` author whose name
     * happens to match, because `kestra:phase3` and every seeded flow depend on
     * that and refusing every system-authored revision outright would break the
     * regression net for a control nobody could then leave on.
     *
     * What this column adds is the part that was missing: a reader of the
     * approval history can now tell *"a second pair of eyes was possible and it
     * happened"* from *"there was nobody to be the first pair"*. Denormalised
     * rather than joined because the approval row IS the audit artefact, and a
     * control that leaves no trace of what it could not check is the
     * flag-with-no-consumer failure I-32 was worried about — inverted. It cannot
     * drift: `flow_revisions` is insert-only, so this is a copy of a value that
     * can never change.
     *
     * ⚠ Still not separation of duties, in any combination of values.
     */
    revisionAuthorKind: varchar("revision_author_kind", { length: 16 }).notNull(),
    note: text("note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    /**
     * Who revoked, verified the same way (Stage 9.1).
     *
     * Nullable because every row written before Stage 9 has no answer, and
     * because a revocation can also be automatic — `checkStaleness` suspends a
     * flow with no person involved, and inventing one there would be worse than
     * the NULL.
     */
    revokedBy: varchar("revoked_by", { length: 255 }),
    manifestFingerprint: varchar("manifest_fingerprint", { length: 71 }).notNull(),
    /** Set when a referenced tool/datasource changed shape; suspends the schedule. */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    staleReason: text("stale_reason"),
  },
  (t) => ({
    // Hot path: "is THIS revision currently approved?" runs on every `begin`
    // against the live namespace.
    revIdx: index("idx_flow_approvals_revision").on(t.flowId, t.revision),
  }),
);

/**
 * One Kestra execution, from Foundry's side.
 *
 * Kestra is the system of record for the execution itself (R6); this row is the
 * POINTER plus the domain metadata Kestra cannot hold — which workspace it
 * belongs to, and which trigger fired it.
 */
export const flowExecutions = pgTable(
  "flow_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The Foundry flow this execution ran, and WHICH REVISION.
     *
     * Nullable because Phase 1's three flows are deployed straight to Kestra
     * with no `flows` row behind them, and their executions are still real
     * history. A run whose flow is unknown is a run Foundry saw but does not
     * own — worth keeping visible rather than refusing to record.
     *
     * The revision is copied, not looked up through the flow: `flows.armed_revision`
     * moves on the next approval, and an execution has to keep saying which
     * revision actually ran (§6.5 — that is the whole point of binding approval
     * to a revision).
     */
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    flowRevision: integer("flow_revision"),
    kestraNamespace: varchar("kestra_namespace", { length: 255 }).notNull(),
    kestraFlowId: varchar("kestra_flow_id", { length: 255 }).notNull(),
    /**
     * The flow's `name` at the moment THIS run began. Nullable — every row before
     * this column existed has no answer, and there is no way to reconstruct one.
     *
     * Copied, never looked up: `flows.name` is editable, so a live join would
     * relabel every past run the moment somebody renames the flow. Same rule as
     * `flowRevision` and `requestedBy` above — read at `begin`, never through the
     * pointer afterward.
     */
    flowNameSnapshot: varchar("flow_name_snapshot", { length: 255 }),
    /**
     * The flow's `id` (its own uuid) at the moment THIS run began. Same rule
     * as `flowNameSnapshot` immediately above, applied to the id instead of
     * the name — copied, never looked up, and deliberately carrying no FK
     * back to `flows.id`: a foreign key would itself need `onDelete: "set
     * null"` to avoid blocking the flow's deletion, which is exactly the
     * failure mode this column exists to survive. Nullable — every row
     * before this column existed has no answer.
     */
    flowIdSnapshot: uuid("flow_id_snapshot"),
    // Unique: one Foundry row per Kestra execution. Also the join key the UI
    // uses to fetch per-step detail, so it is indexed by the constraint.
    kestraExecutionId: varchar("kestra_execution_id", { length: 255 }).notNull(),
    // Coarse lifecycle for list views. Detailed per-task state stays in Kestra.
    status: varchar("status", { length: 20 }).notNull().default("running"),
    triggerFireId: uuid("trigger_fire_id").references(() => triggerFires.id, {
      onDelete: "set null",
    }),
    inputsJson: jsonb("inputs_json"),
    /**
     * The execution this one is a REPLAY of, and the step it resumed from
     * (§6.3, phase 6.1). NULL for an ordinary run.
     *
     * A pointer rather than a copy of the original's inputs, for the usual R6
     * reason — but also because the pair answers the question a replay actually
     * raises: *"did this succeed on its own, or on the third attempt?"* Two
     * `succeeded` rows with no link between them read as two working runs, and
     * that is precisely the reading Phase 2's D-14 work exists to prevent.
     *
     * `ON DELETE SET NULL`, so retention purging the original (30 days, O4)
     * leaves the replay's own history intact rather than cascading it away.
     */
    replayOfId: uuid("replay_of_id").references((): AnyPgColumn => flowExecutions.id, {
      onDelete: "set null",
    }),
    /**
     * The step id the replay restarted from, as the CLIENT named it — never a
     * Kestra taskrun id. Kestra's identifier is resolved server-side from this
     * (R5: a client is never given, and never sends, anything that addresses
     * Kestra directly).
     */
    replayFromStep: varchar("replay_from_step", { length: 255 }),
    /**
     * Who asked for this run — archive/GAPS.md §1.1b, D-70.
     *
     * Gate 2 refuses self-approval because a revision records an author; gate 3
     * had nobody to compare a decider against, because an execution recorded
     * nobody. These three columns are that subject.
     *
     * ⚠ **Copied onto the row at `begin`, never read through the pointer
     * later.** Deriving it from `flow_run_requests` at read time would let a
     * deleted request row rewrite the history of a run that already happened —
     * the same rule as `read_from` (D-53) and `flow_revision`.
     */
    requestedBy: text("requested_by"),
    /** The identity `sub`. What the self-decision refusal compares on — emails move. */
    requestedBySubject: text("requested_by_subject"),
    /** Whose own account this run acted as (sharing-boundaries 0124); NULL = only the workspace's connections. */
    actsAsSubject: text("acts_as_subject"),
    /** `user` | `replay` | `trigger` | `schedule` | `system` | `unknown`. */
    requestedByKind: varchar("requested_by_kind", { length: 16 }),
    /**
     * Per-run prod opt-in for test runs (mock-data plan §4). Default OFF.
     * Row-carried, never a Kestra label. Live runs ignore it and always read prod.
     */
    useProdOverride: boolean("use_prod_override").notNull().default(false),
    /** The Pi builder's automatic test after a build turn — not a run a person started (0086). */
    autoTest: boolean("auto_test").notNull().default(false),
    /** A runner run's job, minus its token (0088) — what a run paused at an approval is started again from. */
    runnerJob: jsonb("runner_job"),
    /** Step outputs so far while a runner run waits for an approval (0088). Unredacted; cleared when it ends. */
    runnerMemo: jsonb("runner_memo"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    kestraUnique: unique("uq_flow_executions_kestra").on(t.kestraExecutionId),
    wsIdx: index("idx_flow_executions_workspace").on(t.workspaceId, t.startedAt),
    // "what were the replays of this run" — read by the run page's lineage strip.
    replayIdx: index("idx_flow_executions_replay_of").on(t.replayOfId),
  }),
);

/**
 * One step of one execution — a POINTER, not a copy.
 *
 * ⚠ Deliberately stores NO status, timing, inputs or outputs. Those live in
 * Kestra and are read through its API (R6, §7.4, verification assertion 26). A
 * duplicated field here is a divergence waiting to happen: the moment Kestra
 * retries a task, a copied status is wrong and nothing detects it.
 *
 * What it does hold is the metadata Kestra has no concept of — Foundry's own
 * verdicts about the step.
 *
 * Note the pinned design contradicts itself here: 08 §10's Phase 1 exit
 * criterion says "`flow_step_runs` holds per-step I/O", while §7.4 and assertion
 * 26 forbid exactly that. §7.4 wins — it agrees with R6, which is a rule. Read
 * the exit criterion as "per-step I/O is RETRIEVABLE via this pointer". See
 * progress/DECISIONS.md D-05.
 */
export const flowStepRuns = pgTable(
  "flow_step_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowExecutionId: uuid("flow_execution_id")
      .notNull()
      .references(() => flowExecutions.id, { onDelete: "cascade" }),
    // The step's id in the flow model, e.g. "fetch_attendance".
    stepId: varchar("step_id", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // tool|datasource|query|transform|code|agent|approval|branch
    kestraTaskrunId: varchar("kestra_taskrun_id", { length: 255 }),
    /**
     * The Kestra task to resume when the wait ends — `<stepId>_await`.
     *
     * Sent by the compiler in the step body rather than derived here, so the
     * resume path never has to reproduce the naming convention. If the two ever
     * disagreed, the execution would stay PAUSED until its `pauseDuration`
     * expired, which is the failure that looks most like work still in flight.
     */
    resumeTaskId: varchar("resume_task_id", { length: 255 }),
    /**
     * When Foundry told Kestra to un-pause. **Foundry's own fact**, not a copy
     * of anything Kestra holds — which is why it can live here without breaking
     * R6 (assertion 26).
     */
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    /**
     * §6.9's classification and routing decision for this step's failure, and
     * how many times the fragment has been regenerated (06 §6.12).
     *
     * `attempt` is a column rather than a variable because the ladder's one
     * history-dependent rule lives on it: the same `contract_violation` means
     * "regenerate this fragment" at attempt 0 and "the boundary is wrong,
     * redraft the flow" at attempt 2.
     */
    failureClass: varchar("failure_class", { length: 32 }),
    triageRoute: varchar("triage_route", { length: 24 }),
    attempt: integer("attempt").notNull().default(0),
    auditVerdict: varchar("audit_verdict", { length: 10 }),
    oracleScore: doublePrecision("oracle_score"),
    /**
     * `sandbox` | `production` — which database a `datasource` step actually
     * read (Stage 4, D-52). NULL for every other kind, and for history predating
     * the sandbox.
     *
     * ⚠ Persisted rather than recomputed. The answer depends on whether a
     * sandbox existed *at the time of the run*, and provisioning one later would
     * silently rewrite the history of every draft run that read production —
     * turning the record of an exposure into a record of there never having been
     * one. Same reason `flow_executions.flow_revision` is copied and not looked
     * up through the flow.
     */
    readFrom: varchar("read_from", { length: 12 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    taskrunUnique: unique("uq_flow_step_runs_taskrun").on(t.kestraTaskrunId),
    // Hot join path for the step-graph UI.
    execStepIdx: index("idx_flow_step_runs_exec_step").on(t.flowExecutionId, t.stepId),
  }),
);

/**
 * A Pi workflow's step results, written by flow-runner (plans/pi-runtime-2026-10-09, migration 0082).
 *
 * Foundry is the system of record here — Kestra kept outputs for its own runs and Foundry a pointer (R6); the
 * runner keeps nothing. Outputs are redacted BEFORE the write. `scope` is the loop item ('' outside a loop).
 */
export const runnerStepResults = pgTable(
  "runner_step_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowExecutionId: uuid("flow_execution_id")
      .notNull()
      .references(() => flowExecutions.id, { onDelete: "cascade" }),
    stepId: varchar("step_id", { length: 255 }).notNull(),
    scope: varchar("scope", { length: 64 }).notNull().default(""),
    status: varchar("status", { length: 16 }).notNull(), // succeeded | failed | skipped (CHECK in 0082)
    outputJson: jsonb("output_json"),
    /** What the step was given — `{params, inputs}` after binding (0084). Redacted on write. */
    inputJson: jsonb("input_json"),
    /** What the step printed (its stderr, capped), redacted on write (0084). */
    logs: text("logs"),
    /** What the step returned, checked against what it declared — the runner's checks.py findings (0086). */
    checksJson: jsonb("checks_json"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stepScopeUnique: unique("uq_runner_step_results").on(t.flowExecutionId, t.stepId, t.scope),
    execIdx: index("ix_runner_step_results_exec").on(t.flowExecutionId),
  }),
);
export type RunnerStepResult = typeof runnerStepResults.$inferSelect;

/**
 * A Forge conversation (migration 0095) — saved from the person's first message, whether or not it ever builds a
 * workflow; listed for the whole workspace and kept until someone deletes it. `flowId` is the workflow it built (the
 * chat outlives it). `draftBundle` holds an UNSAVED workflow's files, so a draft chat reopens with what it built.
 */
/**
 * A notice to ONE person in one workspace, kept until they have seen it (migration 0121, sharing-boundaries). First
 * use: an Admin opened your private chat, workflow or test run — the owner is shown it, not only audited.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The recipient — an identity subject, never an email. */
    subject: text("subject").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    recipient: index("idx_notifications_recipient").on(t.workspaceId, t.subject, t.createdAt),
  }),
);

/**
 * "Turn on for me" (sharing-boundaries 0125): a person running a shared, each-person workflow on their own schedule, on
 * the approved revision they confirmed. Paused (derived, never written) while the workflow's approved revision is newer.
 */
export const flowActivations = pgTable(
  "flow_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /** The person — an identity subject. Their runs act as them. */
    subject: text("subject").notNull(),
    /** How their runs are labelled (their email), copied at the time they turned it on. */
    actor: text("actor").notNull(),
    confirmedRevision: integer("confirmed_revision").notNull(),
    /** Their own schedule; NULL = the workflow's. */
    cron: text("cron"),
    timezone: text("timezone"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    person: uniqueIndex("uq_flow_activations_person").on(t.flowId, t.subject),
  }),
);

/** Which of their own connections a person's runs use for a service, when they have several (sharing-boundaries 0127). */
export const personAccountChoices = pgTable(
  "person_account_choices",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    piece: text("piece").notNull(),
    connectionId: uuid("connection_id").notNull(),
    chosenAt: timestamp("chosen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.subject, t.piece] }) }),
);

/**
 * Projects (sharing-boundaries 0128): a smaller circle inside a workspace, with shared context every Forge chat in it
 * sees. Membership IS the access — removing someone takes everything in it from them at once.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions").notNull().default(""),
    /** When false, chats skip memory inject and Remember / Compact promote stay off (cheap; no LLM). */
    memoryEnabled: boolean("memory_enabled").notNull().default(true),
    ownerSubject: text("owner_subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.projectId, t.subject] }) }),
);

/** A file a project's members share (0132). Seen by the project's members and Admins; deleted with the project. */
/**
 * The RUNTIME model's settings (0134): the gateway, key and models `llm_complete` uses, set on the AI models page.
 * One row (`id` = 1); none means the environment's `LLM_*` values. The key is encrypted under `CREDENTIAL_ENC_KEY`
 * and never returned by any route — a fingerprint is. Moved here from ops-api's `llm_provider` (2026-10-30).
 */
export const runtimeModelProvider = pgTable("runtime_model_provider", {
  id: integer("id").primaryKey(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc"),
  defaultModel: text("default_model").notNull().default(""),
  allowedModels: jsonb("allowed_models").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 255 }),
});

/**
 * Per-user AI provider (personal thin, 0141): each signed-in subject owns one OpenAI-compatible connection.
 * The deployment singleton `runtime_model_provider` stays as the env/harness fallback only.
 */
export const userLlmProviders = pgTable("user_llm_providers", {
  subject: text("subject").primaryKey(),
  providerId: varchar("provider_id", { length: 32 }).notNull().default("custom"),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc"),
  defaultModel: text("default_model").notNull().default(""),
  allowedModels: jsonb("allowed_models").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 255 }),
});

/**
 * Every web fetch (0133): by a workflow step (`executionId`) or by Forge while it builds (`sessionId`). The address is
 * stored with credential-shaped query values redacted. A refusal is a row too (`ok` false, `error` says why).
 */
export const webFetches = pgTable(
  "web_fetches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id"),
    stepId: varchar("step_id", { length: 255 }),
    sessionId: varchar("session_id", { length: 64 }),
    actor: varchar("actor", { length: 255 }),
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    status: integer("status"),
    contentType: varchar("content_type", { length: 255 }),
    bytes: integer("bytes"),
    durationMs: integer("duration_ms"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsAt: index("ix_web_fetches_ws_at").on(t.workspaceId, t.at), execution: index("ix_web_fetches_execution").on(t.executionId) }),
);

export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    contentEnc: bytea("content_enc").notNull(),
    uploadedBy: text("uploaded_by"),
    uploadedByEmail: text("uploaded_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ nameIdx: uniqueIndex("uq_project_files_name").on(t.projectId, t.name) }),
);

/**
 * Per-person read shares (personal thin product Phase 5): a People-listed member may READ a chat or a run
 * without moving it to the Workspace or a project. No public links. Owner / Admin grants; sharee cannot continue a chat.
 */
export const itemShares = pgTable(
  "item_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    itemId: uuid("item_id").notNull(),
    subject: text("subject").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("uq_item_shares_item_subject").on(t.kind, t.itemId, t.subject),
    bySubject: index("ix_item_shares_subject").on(t.workspaceId, t.subject, t.kind),
  }),
);

/**
 * Edge agent devices (personal thin Phase 6): OTP legacy, or setup-link → awaiting_connect → owner approves → active.
 * Device token hash at rest; `connectTokenOnce` holds the plaintext only until the agent collects it after approve.
 */
export const edgeDevices = pgTable(
  "edge_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ownerSubject: text("owner_subject").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pairing"),
    pairingCodeHash: varchar("pairing_code_hash", { length: 64 }),
    pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
    waitSecretHash: varchar("wait_secret_hash", { length: 64 }),
    connectTokenOnce: text("connect_token_once"),
    agentLabel: text("agent_label"),
    /** Last-reported OS home dir from the edge agent (so Forge does not invent /workspaces). */
    hostHome: text("host_home"),
    hostCwd: text("host_cwd"),
    hostPlatform: text("host_platform"),
    tokenHash: varchar("token_hash", { length: 64 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    byOwner: index("ix_edge_devices_ws_owner").on(t.workspaceId, t.ownerSubject),
    token: uniqueIndex("uq_edge_devices_token_hash").on(t.tokenHash),
  }),
);

/** Short-lived setup links: curl fetches instructions; registering only requests connect (owner must Approve). */
export const edgeSetupLinks = pgTable(
  "edge_setup_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerSubject: text("owner_subject").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    label: text("label").notNull().default("This computer"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    token: uniqueIndex("uq_edge_setup_links_token_hash").on(t.tokenHash),
    byOwner: index("ix_edge_setup_links_owner").on(t.workspaceId, t.ownerSubject),
  }),
);

/** Jobs for an edge device: run_command / read_path / write_path. Write/command require approval before running. */
export const edgeJobs = pgTable(
  "edge_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => edgeDevices.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    approvalId: uuid("approval_id"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    /** Forge chat session that enqueued this job (Background watcher / result post-back). */
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    byDevice: index("ix_edge_jobs_device_status").on(t.deviceId, t.status),
    bySession: index("ix_edge_jobs_session").on(t.workspaceId, t.sessionId),
  }),
);


/** Per-user edge allow/deny + directory grants (0142). Evaluated in edgeJobNeedsApproval. */
export const edgeTrustRules = pgTable(
  "edge_trust_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerSubject: text("owner_subject").notNull(),
    effect: varchar("effect", { length: 16 }).notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    pattern: text("pattern").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("uq_edge_trust_rules").on(t.workspaceId, t.ownerSubject, t.effect, t.scope, t.pattern),
    byOwner: index("ix_edge_trust_rules_owner").on(t.workspaceId, t.ownerSubject),
  }),
);

/**
 * Project memory ledger (personal thin product Phase 4) — curated facts a project's chats start with.
 * Not vectors: each row is an accepted decision / preference / open loop / note. Active rows inject into
 * `projectService.contextOf`; superseded/discarded stay for history. Deleted with the project.
 */
export const projectMemories = pgTable(
  "project_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    sourceChatId: uuid("source_chat_id"),
    sourceMessageId: varchar("source_message_id", { length: 64 }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    projectStatus: index("ix_project_memories_project_status").on(t.projectId, t.status),
  }),
);

export const piChats = pgTable(
  "pi_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    title: varchar("title", { length: 200 }).notNull(),
    goal: text("goal").notNull().default(""),
    createdBySubject: varchar("created_by_subject", { length: 320 }),
    createdByName: varchar("created_by_name", { length: 320 }),
    messages: jsonb("messages").notNull().default([]),
    /** Forge's session file — the conversation Pi resumes from. Null until a turn has run. */
    forgeSession: text("forge_session"),
    draftBundle: jsonb("draft_bundle"),
    /** Workflow Builder (`workflow`) or Forge Agent (`agent`), 0097. CHECK-constrained. */
    mode: varchar("mode", { length: 16 }).notNull().default("workflow"),
    /** How hard Forge Agent thinks: `low` / `balanced` / `high` / `ultra` (0119). CHECK-constrained. */
    thinking: varchar("thinking", { length: 16 }).notNull().default("balanced"),
    /** The model this chat's Forge runs with (0135); null = the builder's default. */
    model: text("model"),
    /**
     * Who reads it (migration 0122, sharing-boundaries): `private` — its owner and Admins; `public` — every member reads
     * the conversation. Only its owner (or an Admin) ever continues, renames or deletes it.
     */
    visibility: varchar("visibility", { length: 16 }).notNull().default("private"),
    /** The project it lives in (sharing-boundaries 0128); NULL = My space or shared with the Workspace (`visibility`). */
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
    /** Which connection this chat uses per connected service, chosen by the person (plugins 8.5). */
    connectionChoices: jsonb("connection_choices").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index("ix_pi_chats_workspace").on(t.workspaceId, t.updatedAt),
    flowIdx: index("ix_pi_chats_flow").on(t.flowId),
  }),
);
export type PiChatRow = typeof piChats.$inferSelect;

/** A chat's files (0095): what the person attached, and what Forge made. Encrypted, 50 MB each. */
export const piChatFiles = pgTable(
  "pi_chat_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => piChats.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    origin: varchar("origin", { length: 16 }).notNull().default("person"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex("uq_pi_chat_files_name").on(t.chatId, t.name),
  }),
);

/**
 * A saved workflow a Workflow Builder chat learns from (0099). Pins ONE saved revision: nothing but the person moves
 * it. `card_md` and `bundle_json` are that revision's card and code, kept here so the reference stays readable after
 * the workflow is deleted (`flow_id` goes NULL). Never data files — code only.
 */
export const piChatReferences = pgTable(
  "pi_chat_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => piChats.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    flowNameSnapshot: varchar("flow_name_snapshot", { length: 200 }).notNull(),
    revision: integer("revision").notNull(),
    cardMd: text("card_md").notNull(),
    bundleJson: jsonb("bundle_json").notNull(),
    addedBySubject: varchar("added_by_subject", { length: 320 }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flowIdx: uniqueIndex("uq_pi_chat_references_flow").on(t.chatId, t.flowId).where(sql`flow_id IS NOT NULL`),
    chatIdx: index("ix_pi_chat_references_chat").on(t.chatId),
  }),
);
export type PiChatReferenceRow = typeof piChatReferences.$inferSelect;

/**
 * A saved flow BUNDLE — the per-tenant template library (phase 6.4).
 *
 * ── It stores a bundle, not a flow id, and that is the whole design ───────────
 *
 * A template that pointed at a live flow would change every time that flow was
 * edited: "create from template" would then mean *"whatever that automation
 * happens to be right now"*, which is the same class of mistake as approving a
 * flow rather than a revision (§6.5). A template is a SNAPSHOT by definition, so
 * `bundle_json` is the immutable export — the same bytes
 * `flow-portability.service.ts` would hand to another tenant.
 *
 * ── Per-tenant, and it has to be ─────────────────────────────────────────────
 *
 * `workspace_id` is NOT NULL and every read is scoped by it. There is
 * deliberately no "global" or "shared" library: a template carries ref NAMES and
 * a step contract written against one tenant's data, so a cross-tenant listing
 * would be a slow leak of the origin tenant's schema vocabulary through
 * autocomplete. Sharing between tenants happens by exporting a bundle and
 * importing it — an explicit act, by a human, with revalidation (6.3).
 *
 * `bundle_json` contains no generated code and no secret VALUES. That is enforced
 * where the bundle is built, not here; see `flow-portability.service.ts`.
 */
/**
 * Gate 3 — one human decision on one execution.
 * 05 §6.5 (the gate `flow-approval.service.ts` described and did not have)
 *
 * ── Why this is not `flow_approvals` ─────────────────────────────────────────
 *
 * `flow_approvals` binds to a REVISION and answers *"may this automation run
 * unattended at all"*, once, before it is armed. This binds to an EXECUTION and
 * answers *"may this particular batch proceed"*, every run. Putting both in one
 * table would make the two questions look interchangeable, and the failure mode
 * of that confusion is one-way: someone reasons that the flow is approved, so
 * the step is too.
 *
 * ── Insert-only, closed by timestamp ─────────────────────────────────────────
 *
 * Same discipline as `flow_approvals`: a decision is never rewritten and never
 * deleted. A row with `decided_at` NULL is pending; deciding stamps it. An
 * approval history that can be edited is not an approval history.
 *
 * ⚠ `decided_by` is **self-asserted**. One shared `PARENT_API_KEY`, no user
 * model — exactly the caveat that applies to `flow_approvals.approver_user_id`
 * (I-13). This records WHO SAID they decided and when; it does not authenticate
 * them. Never describe gate 3 as separation of duties either.
 */
export const flowStepApprovals = pgTable(
  "flow_step_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowExecutionId: uuid("flow_execution_id")
      .notNull()
      .references(() => flowExecutions.id, { onDelete: "cascade" }),
    /** The step's id in the flow model, e.g. "confirm_send". */
    stepId: varchar("step_id", { length: 255 }).notNull(),
    /**
     * The Kestra task to resume once decided — `<stepId>_await`.
     *
     * Stored rather than derived, for the reason `flow_step_runs.resume_task_id`
     * gives: if the stored value and the naming convention ever disagreed, the
     * execution would sit PAUSED until `pauseDuration` expired, which is
     * indistinguishable from "nobody has approved it yet".
     */
    resumeTaskId: varchar("resume_task_id", { length: 255 }).notNull(),
    /** The one-line question, rendered by the flow at the moment it paused. */
    /** The member the approval step names as its decider (0126), resolved when the run paused; NULL = nobody named. */
    deciderSubject: text("decider_subject"),
    summary: text("summary").notNull(),
    /**
     * The evidence the decision is about — the rows about to be acted on.
     *
     * ⚠ Redacted on the way OUT, not on the way in, and deliberately: this is
     * the same rule as D-07. The value is already inside Foundry's own database
     * and Kestra already persisted the task output that produced it, so
     * scrubbing at write time would lose the audit trail without closing
     * anything. `step-approval.service.ts` owns the read-side redaction.
     */
    context: jsonb("context"),
    /** `approved` | `rejected`. NULL while pending. */
    decision: varchar("decision", { length: 16 }),
    /** ⚠ Self-asserted — see the table comment. */
    decidedBy: varchar("decided_by", { length: 255 }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
    /**
     * When the paused execution was actually un-paused (or killed, on a reject).
     *
     * Separate from `decided_at` because they can genuinely differ: the decision
     * is a database write and the resume is a call to Kestra, and the second can
     * fail. A row with `decided_at` set and this NULL is a decision that was
     * recorded but never delivered — which is a state worth being able to find,
     * rather than one hidden behind a single boolean.
     */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /**
     * ⚠ **`gate` is the only value, and the column stays.** It carried a second
     * kind — an agent runtime's own question, parked at `awaiting_input` and
     * answered by posting to that runtime rather than by resuming Kestra — which
     * went with the runtime. It is kept as a COLUMN rather than collapsed away
     * because the decide path branching on a FACT rather than on the presence of
     * a JSON key is the I-14 lesson, and a second thing that waits for a person
     * is a shape this table should be able to take again.
     */
    kind: varchar("kind", { length: 16 }).notNull().default("gate"),
    /**
     * builder-behaviour P7 (P4-I4): WHICH ITEM of a loop this request is about — the item's row number, as the flow sent it; `''` for a
     * gate outside a loop (one request per step, as always). Part of the uniqueness: an approval inside a loop is one row PER ITEM.
     */
    scope: varchar("scope", { length: 64 }).notNull().default(""),
    /** The registering taskrun — inside a loop, its parent is the item's own branch, where that item's paused task is found. */
    taskrunId: varchar("taskrun_id", { length: 255 }),
    /** What the person supplied. Recorded because it changed what happened next. */
    answers: jsonb("answers"),
    /**
     * Closed WITHOUT a decision, because the thing being waited on stopped
     * waiting — the poller hit its deadline, or the run died.
     *
     * A separate column rather than a third `decision` value, deliberately: the
     * decision vocabulary is what a PERSON said, and writing `expired` into it
     * with a `decided_by` of "system" would make the audit trail's central
     * column sometimes-not-a-person. `listPending` selects on both being NULL.
     */
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    /**
     * One pending request per (execution, step).
     *
     * Kestra retries a failed `http.Request` task, so the registration endpoint
     * can legitimately be called twice for the same taskrun. Without this the
     * second call creates a second pending row, an approver sees the same
     * question twice, and approving one leaves the other pending for ever.
     *
     * It holds for questions too, and for the same reason: the agent poller
     * re-observes `awaiting_input` on every tick, so registration is called once
     * per five seconds until somebody answers.
     */
    stepUnique: unique("uq_flow_step_approvals_step").on(t.flowExecutionId, t.stepId, t.scope),
    /** The inbox query: everything still waiting. */
    pendingIdx: index("idx_flow_step_approvals_pending").on(t.decidedAt),
  }),
);

export const flowTemplates = pgTable(
  "flow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /** The exported bundle, verbatim. Foundry's model format — never Kestra YAML (R8). */
    bundleJson: jsonb("bundle_json").notNull(),
    /**
     * The flow it was captured from, for provenance only. `ON DELETE SET NULL`:
     * deleting the source flow must not delete the template, or the library
     * empties itself exactly when someone tidies up.
     */
    sourceFlowId: uuid("source_flow_id").references(() => flows.id, { onDelete: "set null" }),
    sourceRevision: integer("source_revision"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    nameUnique: unique("uq_flow_templates_name").on(t.workspaceId, t.name),
    wsIdx: index("idx_flow_templates_workspace").on(t.workspaceId),
  }),
);

/**
 * One `POST …/flows/generate` that a browser started and is polling.
 * Stage 7.1.
 *
 * ── Why a table and not an in-memory map ─────────────────────────────────────
 *
 * Generation is decode-bound at ~37 tok/s and a five-step flow costs three
 * inference calls, so **minutes is normal, not a hang**. That is far too long to
 * hold an HTTP request open through the Next proxy, and far too long to lose
 * because someone reloaded the tab or the API container restarted mid-draft.
 *
 * ── Why polling and not a socket ─────────────────────────────────────────────
 *
 * `/ws/generation` existed for exactly this and was authorised by **nothing** —
 * `?scriptId=<uuid>` and you were subscribed. It was deleted with the monolithic
 * path. Anything replacing it would have to redeem a single-use ticket from an
 * API-key-authenticated route the way flow progress does (D-15); polling a
 * normal authenticated route is the cheap answer that needs no new auth surface
 * at all.
 *
 * The row holds the OUTCOME, never a partial one: `status` moves from `running`
 * to exactly one terminal value, and `result_json` is written in the same
 * update. A poller therefore cannot observe a half-written flow.
 */
export const flowGenerationJobs = pgTable(
  "flow_generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The sentence a person typed. Kept so a refusal can be read beside its cause. */
    goal: text("goal").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /**
     * `running` → one of `ok` | `insufficient_contract` | `insufficient_catalogue` |
     * `policy_reject` | `policy_transform` | `failed`.
     *
     * ⚠ `insufficient_contract` and `insufficient_catalogue` are each a SUCCESS
     * of the system and deliberately their own status rather than a flavour of
     * `failed`. The first is a fragment refusing to invent a value it was not
     * given; the second is the drafter refusing to guess a ref for a tool or
     * named query the goal needs and the workspace does not have. §6.7: a
     * refusal ends the loop and is never retried, and filing the most useful
     * diagnosis this system produces under "error" is how a client renders it
     * as a failure and offers a Retry button — which is literally the
     * mechanism that turns a correct refusal into an invented
     * `period="2023-10"` or a guessed ref on attempt 2.
     *
     * `policy_reject`/`policy_transform` (guardrail-port V4/V5/V8) are the same
     * shape of thing one step earlier — the request-policy engine refusing
     * before a manifest is even built, D-38's "a refusal is a 200, its own
     * terminal status" rule applied identically.
     */
    status: varchar("status", { length: 32 }).notNull().default("running"),
    /**
     * The human's ordered steps, when the flow was authored in OUTLINE mode.
     *
     * Kept beside the goal for the same reason the goal is kept: a refusal has
     * to be readable next to what was actually asked for, and in outline mode
     * what was asked for is mostly here rather than in the sentence.
     */
    outlineJson: jsonb("outline_json").$type<string[] | null>(),
    /**
     * Where the run has got to — `{phase, done, total, stepId}`.
     *
     * ⚠ Advisory, never authoritative. It is written fire-and-forget from inside
     * the generation, so a dropped write leaves it stale; `status` is the field
     * that decides anything. A poller that stopped when `done === total` would
     * stop before the flow row exists.
     */
    progressJson: jsonb("progress_json"),
    /** Set on success. The flow the browser should navigate to. */
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    /**
     * The terminal payload — the refusals and the draft for
     * `insufficient_contract`, the missing capability and reason for
     * `insufficient_catalogue`, the notes and inference count for `ok`, the
     * findings for `failed`. Byte-identical to what the synchronous route
     * returns, because both come from the same function.
     */
    resultJson: jsonb("result_json"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    wsIdx: index("idx_flow_generation_jobs_workspace").on(t.workspaceId, t.createdAt),
  }),
);

/**
 * R3 — execution-scoped tokens. Tenant identity never travels in a payload.
 *
 * Kestra presents one of these on every step callback and Foundry resolves
 * tenancy FROM THE TOKEN. Kestra never receives, stores, or asserts a tenantId,
 * so compromising Kestra exposes in-flight executions only, not the tenant
 * space. That is what makes an engine with no tenant model safe to run at all.
 *
 * HASHES ONLY — never the raw token (§7.4). Kestra persists flow inputs in its
 * execution history, so the token is already at rest in one place we do not
 * control; it must not also be at rest in a readable form here.
 */
export const executionTokens = pgTable(
  "execution_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // sha256 of the raw token. Unique so a lookup is a point read.
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowExecutionId: uuid("flow_execution_id")
      .notNull()
      .references(() => flowExecutions.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * §7.4 calls these "single use". Taken literally that is unimplementable:
     * ONE token authenticates EVERY step callback of an execution, so burning it
     * on first use would fail step 2. It is single-use per EXECUTION — minted
     * once by `begin`, burned when the execution completes. See DECISIONS.md D-06.
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    hashUnique: unique("uq_execution_tokens_hash").on(t.tokenHash),
    execIdx: index("idx_execution_tokens_exec").on(t.flowExecutionId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// The four side-effect capture tables — `stub_mail_outbox`, `stub_chat_messages`,
// `stub_tickets` and `stub_call_log` — WERE HERE, and are GONE from this
// database (Stage 5, migration 0018).
//
// They are `mail_outbox`, `chat_messages`, `tickets` and `api_call_log` in
// `packages/ops-api`'s own database now, reached over HTTP through
// `services/ops-client.service.ts`. Nothing in this package holds a credential
// for that database, and that is the point of the move rather than a side
// effect of it.
//
// The property their old placement bought is UNCHANGED and worth restating,
// because it is easy to read the move as weakening it: a generated script gets a
// DSN for `hr_demo`, so it cannot reach the capture tables with SQL and the only
// way to put a row in one is to call the tool. "Did the automation actually send
// the mail?" therefore stays a real question with a real answer. Stage 5 moved
// them further out of reach, not closer — a script would now need a network hop
// AND a credential it is not given.
//
// Do not re-add a capture table to this schema. A tool side effect landing in
// `foundry_parent` means the tool ran in the control plane.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Who may do what in a workspace — archive/GAPS.md §1.1.
 *
 * ── What this is, and what it is honestly not ───────────────────────────────
 *
 * Gate 2 and gate 3 refused SELF-approval and nothing else. There were no
 * roles, so anyone who could sign in could approve anything and "a second pair
 * of eyes" meant only "a different string". This is the roles.
 *
 * ⚠ **It is still not separation of duties against the SIGNING SECRET.**
 * Anything holding `RUNTIME_JWT_SECRET` can mint any identity — `e2e:ui` does —
 * and a minted identity with an `approver` row approves. What this adds is real
 * and smaller: *a person who has not been granted the approver role in this
 * workspace cannot approve in it*, which was previously false for every signed-in
 * person. The claim to make is that one, never "authenticated user" and never
 * "separation of duties" unqualified (I-13).
 *
 * ── Every existing workspace starts with ZERO members ───────────────────────
 *
 * Migration 0027 does not backfill, deliberately. Backfilling every signed-in
 * identity as an admin produces a role model that grants the role to everybody —
 * the control it replaces, with a table. Zero members means approvals over HTTP
 * are refused on that workspace until it is claimed, which fails closed, is
 * visible on the first attempt, and is one call to fix.
 *
 * ⚠ **Claiming is its own endpoint and never happens implicitly.** An earlier
 * shape auto-granted admin to the first signed-in caller who tried to *approve*
 * on a member-less workspace, which would have made the gate grant the role to
 * whoever arrived — a control that cannot refuse. The claim is an explicit act,
 * recorded with `granted_by = 'bootstrap'` so it stays distinguishable from a
 * grant for ever, and on a deployment where anyone can sign in the first person
 * to claim an unclaimed workspace owns it. That is stated rather than hidden.
 */
/**
 * A super admin's emergency access to a RESTRICTED workspace (0113, restricted-workspaces phase 2): a reason, a few
 * hours, recorded in that workspace's audit log and shown to its admins, who can end it. Insert-only apart from ending.
 */
export const workspaceEmergencyAccess = pgTable(
  "workspace_emergency_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    email: text("email"),
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
  },
  (t) => ({
    activeIdx: index("idx_workspace_emergency_access_ws").on(t.workspaceId, t.subject),
  }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The JWT `sub` — the stable identifier.
     *
     * ⚠ Not the email. An address can be reassigned, and a person who changes
     * theirs must not silently become a different member (or inherit the
     * previous holder's role).
     */
    subject: text("subject").notNull(),
    /**
     * For display, and for gate 2's comparison against
     * `flow_revisions.created_by` — which records a name, not a subject.
     * Never used to decide identity.
     */
    email: text("email").notNull(),
    /** `author` | `approver` | `admin`. CHECK-constrained in the migration. */
    role: text("role").notNull(),
    /** Who granted it; the literal `bootstrap` for a claim. */
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // One row per person per workspace: two would be two answers to "what may
    // this person do here", decided by row order.
    uniq: uniqueIndex("idx_workspace_members_unique").on(t.workspaceId, t.subject),
    wsIdx: index("idx_workspace_members_workspace").on(t.workspaceId),
  }),
);
export const workspaceMemberCapabilities = pgTable(
  "workspace_member_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    capability: text("capability").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("idx_workspace_member_capabilities_unique").on(
      t.workspaceId,
      t.subject,
      t.capability,
    ),
    wsIdx: index("idx_workspace_member_capabilities_workspace").on(t.workspaceId),
    subjIdx: index("idx_workspace_member_capabilities_subject").on(t.workspaceId, t.subject),
  }),
);


/**
 * Identities that have presented a verified token to this API — migration 0040.
 *
 * ── Why this table exists ───────────────────────────────────────────────────
 *
 * Membership is keyed on the identity **subject**, which for an Entra sign-in is
 * an OID — a GUID nobody can type from memory. Assigning somebody to a
 * workspace therefore meant transcribing an opaque identifier out of a token,
 * and the grant form asked for it as free text. This is the list that makes
 * assignment a choice instead of a transcription.
 *
 * ── ⚠ WHAT A ROW MEANS, EXACTLY ─────────────────────────────────────────────
 *
 * *This subject made at least one request carrying an identity token that
 * verified against `RUNTIME_JWT_SECRET`.* That is all. It is **not** an account,
 * **not** an entitlement, and **not** proof of who anybody is — anything holding
 * the signing secret mints any identity (I-13), and `e2e:ui` deliberately does.
 * It is deliberately **not named `users`** for that reason, and both the route
 * and the screen carry the bound.
 *
 * ⚠ It records being SEEN, never being signed in. There is no session here: a
 * row does not expire, and a person who signed out this morning is still in it.
 *
 * ── Why it is written from `resolveIdentity` and not from sign-in ───────────
 *
 * Auth.js runs in the Next process, which holds no database credential — so
 * recording at sign-in would need a new write route, and a route that records a
 * person on the caller's word is the shape this codebase refuses everywhere
 * else (`authorOf`, `createdBy`). `resolveIdentity` has already verified the
 * signature, so the write is a side effect of a check that had to happen anyway
 * and no new trust boundary appears.
 *
 * The cost, stated: somebody appears here on their first API call rather than at
 * the instant they sign in. In practice the browser calls the API to render any
 * page, and the honest reading of the list is the one above — identities this
 * API has seen — which is exactly what it is used for.
 */
/**
 * When two ids turn out to be one person (admin simplify, phase 1), access and ownership move to the current id and
 * the old one is recorded here, so history written under it still names the person. Insert-only (0130).
 */
export const platformUserAliases = pgTable(
  "platform_user_aliases",
  {
    oldSubject: text("old_subject").primaryKey(),
    subject: text("subject").notNull(),
    email: text("email"),
    reason: varchar("reason", { length: 32 }).notNull(),
    mergedBy: text("merged_by"),
    mergedAt: timestamp("merged_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ bySubject: index("idx_platform_user_aliases_subject").on(t.subject) }),
);

/**
 * A person invited by email before they have signed in, with their workspaces and roles chosen in advance (admin
 * simplify, phase 2; 0131). Redeemed at first sign-in by `invitationService.redeem`. One open invitation per email.
 */
export const personInvitations = pgTable("person_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  platformRoleKey: varchar("platform_role_key", { length: 64 }),
  invitedBy: text("invited_by").notNull(),
  invitedByEmail: text("invited_by_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedSubject: text("accepted_subject"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
});

export const personInvitationWorkspaces = pgTable(
  "person_invitation_workspaces",
  {
    invitationId: uuid("invitation_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.invitationId, t.workspaceId] }) }),
);

export const platformUsers = pgTable(
  "platform_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The JWT `sub`. The key, for the same reason `workspace_members.subject`
     * is: an email can be reassigned, and a person changing theirs must not
     * become a second row.
     */
    subject: text("subject").notNull(),
    /** For display and for picking. Never used to decide identity. */
    email: text("email").notNull(),
    name: text("name"),
    /** The mode this person's new Forge chats open in (0097); null is Workflow Builder. */
    forgeDefaultMode: varchar("forge_default_mode", { length: 16 }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The upsert's conflict target, so UNIQUE rather than merely indexed.
    uniq: uniqueIndex("idx_platform_users_subject").on(t.subject),
    seen: index("idx_platform_users_last_seen").on(t.lastSeenAt),
  }),
);

/**
 * What a flow CLAIMED about its own output, and whether the run bore it out —
 * archive/GAPS.md §2.3.
 *
 * The claims themselves live on `flow_revisions.model_json.expectations`; this
 * is one row per (run, claim). See `drizzle/0028_flow_expectations.sql` for why
 * `expectation_key` is a content hash and why `unevaluable` is a third state
 * rather than a failure or a pass.
 */
export const flowExpectationResults = pgTable(
  "flow_expectation_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowExecutionId: uuid("flow_execution_id")
      .notNull()
      .references(() => flowExecutions.id, { onDelete: "cascade" }),
    /** Nullable exactly as `flow_executions.flow_id` is — deleted flows keep their history. */
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    expectationId: varchar("expectation_id", { length: 63 }).notNull(),
    /** sha256 over (stepId, select, assert) — WHAT was claimed, not which revision said it. */
    expectationKey: varchar("expectation_key", { length: 64 }).notNull(),
    stepId: varchar("step_id", { length: 255 }).notNull(),
    /**
     * `passed` | `failed` | `unevaluable`. Only `passed` satisfies gate 1, and
     * CHECK-constrained in `drizzle/0038_expectation_status_check.sql` — same
     * discipline as `workspace_members.role` above.
     *
     * ⚠ The constraint is not decoration. The gate reads `status = 'passed'`, so
     * a typo'd value (`'pass'`) is a row that can never satisfy gate 1 and never
     * says why — and a value outside the union is neither a pass, a failure, nor
     * the deliberate third state that must NOT satisfy the gate.
     */
    status: varchar("status", { length: 16 }).notNull(),
    /** Always populated, including on a pass — a "yes" with no values is unfalsifiable. */
    detail: text("detail").notNull(),
    observedJson: jsonb("observed_json"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("flow_expectation_results_run_expectation_idx").on(
      t.flowExecutionId,
      t.expectationId,
    ),
    gate: index("flow_expectation_results_gate_idx").on(t.flowId, t.expectationKey, t.status),
  }),
);

/**
 * Who asked for a run, recorded BEFORE the run exists — archive/GAPS.md §1.1b, D-70.
 *
 * A route that starts an execution knows the person; `begin` — which creates the
 * `flow_executions` row — does not, because it is called by Kestra. So the route
 * writes a row here first and passes its **uuid** to Kestra as a label, exactly
 * the way `foundry_trigger_fire` already works.
 *
 * ⚠ **A uuid and not the person**, and the reason is sharper than for triggers:
 * a Kestra label lives in Kestra's database and renders in `kestra-ui`, which
 * has no tenant isolation and is documented internal-engineers-only. An email or
 * an identity subject in a label would push person-data into it.
 */
export const flowRunRequests = pgTable(
  "flow_run_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    /** The identity `sub`, when a person asked. Null for a harness or a trigger. */
    subject: text("subject"),
    /** For display and for the refusal message. Never used to decide identity. */
    actor: text("actor").notNull(),
    /** `user` | `replay` | `trigger` | `system`. CHECK-constrained in the migration. */
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ wsIdx: index("flow_run_requests_workspace_idx").on(t.workspaceId) }),
);

/**
 * The model that DESIGNS automations — settable without a redeploy.
 * `breaking-2026-08-07/plan-provider-and-scope.md` Part A · F2
 *
 * ⚠ **Deliberately NOT ops-api's `llm_provider` row**, which configures the
 * `llm_complete` TOOL. D-35: *"runtime and generation inference must not be
 * merged — different credentials, different processes, no shared abstraction."*
 * One row for both is that merge by another road.
 *
 * ⚠ **It holds a MODEL and nothing else.** Endpoint and key stay in
 * `config.inference` (`LLM_BASE_URL`/`LLM_API_KEY`), read in `config/index.ts`
 * and nowhere else — `kestra:check` asserts that. The two paths share a
 * *gateway*, not a *credential*: a parent that fetched its generation key from
 * the tool layer would invert the boundary Stage 5 exists to draw.
 *
 * ⚠ **No row means "use the environment"**, which is today's behaviour exactly —
 * not "no model". See `0031_generation_llm.sql` for the singleton constraint and
 * for why a `base_url` override was deliberately not built.
 */
export const generationLlm = pgTable("generation_llm", {
  /** Singleton. `CHECK (id)` in the migration refuses a second row at the database. */
  id: boolean("id").primaryKey().default(true).notNull(),
  defaultModel: text("default_model").notNull(),
  allowedModels: jsonb("allowed_models").default([]).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  /** The signed identity's `sub`. Nullable rather than defaulted to a plausible name. */
  updatedBy: text("updated_by"),
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CHAT MODE — the third way to build an automation (Phase 2, D-119/D-120)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A conversation that builds and edits a flow **one component at a time**, and
 * says which component it changed.
 *
 * ── ⚠ WHAT THE CONVERSATION'S STATE ACTUALLY IS ────────────────────────────
 *
 * **The flow model is the state. The thread is the audit record.** Every turn
 * reads the current revision, applies exactly one op, and routes the result
 * through `authorFlow` — so a chat edit inherits every check a generated flow
 * gets, and nothing here is a second write path.
 *
 * That is why there is **no `draft_model_json` on the thread** and must not be:
 * a flow model living outside `writeRevision` has no D-22 expression allowlist,
 * no `FLOW_CAPS` and no ref check, which is three controls turned off by one
 * convenience column.
 *
 * ── ⚠ WHY NOT `flow_generation_jobs` ───────────────────────────────────────
 *
 * Its `goal` is `NOT NULL`, so every chat turn would have to fabricate a
 * sentence — and more importantly it *has* a goal column, which is the retry
 * channel by another name: a stored goal is a thing a button can resubmit, and
 * §6.7's whole point is that a refusal is never re-asked.
 */
export const flowChatThreads = pgTable(
  "flow_chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * ⚠ **NULL until the first APPLIED turn**, and that is the empty-flow seed
     * (D-120). `POST /threads` creates no flow, no revision, no Kestra call and
     * no inference — turn 1 operates on `{id: slugify(name), steps: []}` derived
     * per request and persisted nowhere, and only when an op actually applies
     * does `flowService.create` run and set this.
     *
     * So a thread whose every turn was refused leaves a thread row and **no
     * flow**, which is the honest outcome: nothing was designed.
     */
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "set null" }),
    /** Becomes `flows.name` at the seed. */
    name: varchar("name", { length: 255 }).notNull(),
    /**
     * ⚠ **There is deliberately NO `goal` column.** See the table note above:
     * a stored goal is a resubmittable sentence, and chat has nothing to retry
     * because no turn designs a flow.
     *
     * `design_selection` is a pre-flow holding place only — copied into
     * `flows.design_selection` at the seed and never read again. It exists
     * because a person can pick which tools to prioritise before turn 1, when
     * there is no flow row to hang it on.
     */
    designSelection: jsonb("design_selection"),
    /**
     * Whether authorship was attested (`user`/`system`/`unknown`), same
     * vocabulary as `flow_revisions.created_by_kind` and — deliberately — with
     * **no default**. A default is how a row whose origin nobody recorded comes
     * to claim one; §1.2's backfill is `unknown` for exactly that reason.
     */
    createdByKind: varchar("created_by_kind", { length: 16 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    wsIdx: index("idx_flow_chat_threads_workspace").on(t.workspaceId, t.createdAt),
  }),
);

/**
 * One turn: what a person said, the single op it produced, and what happened.
 *
 * ── ⚠ THERE IS NO `assistant_text` COLUMN, AND A TEST ASSERTS ITS ABSENCE ──
 *
 * Chat renders **no model prose**. What the screen says is computed by pure code
 * from the op that was actually applied (`describeOp`) plus the diff
 * `flowApprovalService.diff` produces — the same function the approval screen
 * reads, so "what changed" has exactly one answer.
 *
 * A prose column would make the model's *narration* the thing a person believes,
 * which is precisely the failure `llm_complete`'s leaf rule exists for (D-34: a
 * digest whose figures were all correct ranked two departments in an order its
 * own numbers contradicted). Here it would be worse — the narration would sit
 * beside a diff it could disagree with.
 *
 * The absence test carries a control that this same schema slice *does* contain
 * `op_json`, so it cannot pass by reading nothing (I-38).
 */
export const flowChatTurns = pgTable(
  "flow_chat_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => flowChatThreads.id, { onDelete: "cascade" }),
    /** 1-based, per thread. */
    seq: integer("seq").notNull(),
    /**
     * What the person typed, bounded at **2000** — the same bound
     * `refineFlowSchema` uses, so a message cannot become a pasted
     * specification. A turn is one instruction about one component.
     */
    message: varchar("message", { length: 2000 }).notNull(),
    /** The ONE op the model returned, as applied. Null on a refusal. */
    opJson: jsonb("op_json"),
    /**
     * Which step the op turned out to be about, and **how that was decided** —
     * `selection` (the client sent `targetStepId`) or `model`.
     *
     * ⚠ Storing `resolved_by` is what makes mis-resolution **measurable** rather
     * than anecdotal. The 2.0 spike resolved 15/15 named+described referents
     * with an empty selection, so every number it produced was `model`; that is
     * a reading on one flow, and this column is how the real rate gets known.
     */
    resolvedStepId: varchar("resolved_step_id", { length: 255 }),
    resolvedBy: varchar("resolved_by", { length: 16 }),
    /** The revision this turn wrote, when it applied. */
    revision: integer("revision"),
    /** Non-blocking findings, shown beside the diff. */
    findingsJson: jsonb("findings_json"),
    /**
     * The terminal refusal payload, when the turn refused.
     *
     * ⚠ A refusal is **HTTP 200 with a status**, following `/generate` — filing
     * the most useful diagnosis this system produces under "error" is how a
     * client renders it as a failure and offers a Retry.
     */
    refusalJson: jsonb("refusal_json"),
    /**
     * `sha256(stepId + canonical(contract) + sorted(declaredInputIds))` — the
     * cached-refusal key (D-118's substitute for a retry).
     *
     * A turn that would put the **same contract with the same declared inputs**
     * to `generateFragment` again returns the stored refusal verbatim with
     * `attempts: 0`. The only way past it is a change to the flow's **declared
     * boundary**, which is data the system can see — so *"`missing: ["period"]`
     * → declare `period` as an input"* is legitimate progress and a reworded
     * resubmission is not.
     */
    refusalKey: varchar("refusal_key", { length: 64 }),
    /** Inference attempts spent. `0` when a cached refusal was served. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * WHY THE `more` CONTINUATION LOOP STOPPED — `done` | `declined` |
     * `unparseable` | `refused` | `no_change` | `cap`. NULL when the loop never
     * ran, which is a single-op turn.
     *
     * ⚠ **Only `done` means the instruction was fully carried out.** It is the
     * model's own `more: false`; the other five all mean the loop ended with
     * work still owed, and until this column the turn recorded `applied` for
     * every one of them identically.
     *
     * Measured across 11 rebuilt UAT conversations on `gpt-5.6-luna`: six flows
     * stopped at a `transform` having been asked to *"email me"*, and there was
     * no way to tell which bound fired. That is I-120's shape — a value
     * computed and discarded, so the check was correct, its tests passed, and
     * nothing depended on the answer.
     */
    /**
     * What the DECISION seam answered for this turn — every question, every
     * `confidence`, and whether the op that was applied agreed with it.
     *
     * ⚠ NULL means the seam did not run (every turn before migration 0071, and
     * every turn with the flag off). An empty object would claim it ran and
     * answered nothing. `resolved_by` says which PATH a turn took; this says
     * what that path said, which is what makes a disagreement measurable rather
     * than anecdotal — the same argument `resolvedBy` itself carries.
     */
    jevJson: jsonb("jev_json"),
    moreStopReason: varchar("more_stop_reason", { length: 24 }),
    /**
     * `running` → `applied` | `ambiguous_referent` | `too_structural` |
     * `insufficient_contract` | `insufficient_catalogue` | `needs_component` |
     * `policy_reject` | `policy_transform` | `answered` | `needs_input` | `failed`.
     *
     * ⚠ **Written `running` BEFORE the inference call** and finished after, so a
     * lost response still leaves a readable record. `GET /turns/:id` reconciles
     * a stale `running` past the timeout, exactly as
     * `flowGenerationJobService.get` does — no poller required.
     *
     * ⚠ `policy_reject`/`policy_transform` (guardrail-port V4/V5/V8) are the
     * ONE exception to "written running before the inference call" — the
     * request-policy check runs before `running` is ever written, so these two
     * statuses go straight from nothing to their terminal value.
     *
     * ⚠ **`needs_component` (proposed-db-operations, D-179) is a SUCCESS**, and
     * this column is deliberately the only place it is recorded. The turn's op
     * named a real, introspected datasource that has nothing readable — so the
     * flow is missing a component rather than being wrong — and the turn
     * finishes with the finding in `findingsJson` and **no revision written**.
     *
     * ⚠ **There is no `proposalJson`, and adding one would be a mistake twice
     * over.** A persisted proposal is a half-created ref with a lifecycle, and
     * the review it waits on is exactly what makes it safe (D-170); and it would
     * need a migration for a column whose contents are transient. The client
     * fetches the proposal from `POST …/operations/propose`, so re-opening an
     * old thread **re-proposes** rather than replaying a stale spec.
     *
     * ⚠ **No migration accompanies `needs_component`, nor `answered`** — this is
     * `varchar(32)` with no database enum and no CHECK. A `0042` in either
     * feature's diff means the decision was reversed without being rewritten.
     */
    status: varchar("status", { length: 32 }).notNull().default("running"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    seqUnique: unique("uq_flow_chat_turns_seq").on(t.threadId, t.seq),
    threadIdx: index("idx_flow_chat_turns_thread").on(t.threadId, t.createdAt),
  }),
);

/**
 * Every attempt to deliver a REAL email — sent, refused or failed.
 * email-send-tool · US1, US4 · contracts/mail-send.md §4
 *
 * ── Why this table exists ────────────────────────────────────────────────────
 *
 * `foundry_email_send` is the first capability in Foundry that leaves the
 * building, and it is invisible on every surface that already exists.
 * `ToolActivity.tsx` answers "did this run actually do anything?" by reading
 * `api_call_log` **through ops-api** — and ops-api is the simulation. A Foundry
 * route writes no row there, so without this table a real message to a real
 * mailbox appears **nowhere** on the run page.
 *
 * That is precisely the failure the run page was built to end: a script that
 * emailed 0 of 11 people and exited `clean`. Shipping a sender that reports
 * nothing would restage it with a live blast radius, so the row is written on
 * every path including the refusals — a refusal that leaves no trace is
 * indistinguishable from a send that never happened.
 *
 * ── ⚠ There is deliberately NO body column ──────────────────────────────────
 *
 * The body is the script's output. It may carry tenant PII, payroll figures, an
 * extract of a customer table — whatever the flow computed. This record exists to
 * answer **"was a message sent, to whom, and did it work"**, and it answers all
 * three without storing any of that. Adding a body column later would turn an
 * audit table into a copy of every report the platform has ever emailed, sitting
 * in a database whose backups have a different retention policy from the mailbox.
 *
 * The `subject` is kept, and only the subject: it is the one human-readable handle
 * on "which message was that", and it is written by the flow author rather than
 * extracted from data.
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Nullable, because a **bare tool test call** has no execution — the tools
     * page can exercise a registered tool without running a flow, and that call
     * must still be recorded. `null` here means "not from a flow run", never
     * "we lost track of which run".
     */
    flowExecutionId: uuid("flow_execution_id").references(() => flowExecutions.id, {
      onDelete: "cascade",
    }),
    /** The step within the flow, when the caller identified one. Text, matching how step ids travel. */
    stepId: text("step_id"),
    /** Post-resolution, post-dedup, lowercased — what was actually handed to Graph. */
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    /**
     * `requester` — no `to` was given, so it went to the person who started the run.
     * `explicit`  — the caller named the addresses and they passed the allowlist.
     *
     * Recorded rather than inferred, because "why did it go there?" is the first
     * question asked about an unexpected email, and reconstructing the answer from
     * the flow definition is exactly the archaeology this column removes.
     */
    resolvedFrom: varchar("resolved_from", { length: 16 }),
    subject: text("subject"),
    /**
     * `sent` | `refused` | `failed` | `captured` — and the four are NOT
     * interchangeable.
     *
     *   `refused`  — Foundry declined before contacting Microsoft. Nothing left
     *                the building; the fix is a recipient, a cap or a config
     *                variable.
     *   `failed`   — Graph was contacted and did not accept it. The fix is at
     *                the provider, and a retry is meaningful.
     *   `captured` — Foundry deliberately did not contact Microsoft, because the
     *                run is a DRAFT run (migration 0058). Nothing was refused
     *                and nothing failed: the message is complete, addressed and
     *                rendered, and it is held in the Email box.
     *
     * Collapsing them would send someone whose allowlist is wrong to go read
     * Azure logs. CHECK-constrained so a future writer cannot invent a fifth
     * value that every reader then has to guess about.
     *
     * ⚠ **Every reader that means "a person received this" must test for `sent`
     * alone.** `captured` is a success and is not a delivery, so a check written
     * as `outcome !== 'failed'` now counts a held message as a delivered one.
     */
    outcome: varchar("outcome", { length: 16 }).notNull(),
    /**
     * ⚠ **Not an RFC 5322 Message-ID.** Graph answers `sendMail` with `202
     * Accepted` and an EMPTY body — there is no provider-side message id to store.
     * This is the correlation id from the `request-id` / `client-request-id`
     * response headers, which is what a Microsoft support case is opened against.
     */
    graphMessageId: text("graph_message_id"),
    /** Why it was refused or how it failed. Never the body, and never the credential. */
    failureReason: text("failure_reason"),
    /**
     * The rendered message, held ONLY when `outcome = 'captured'`.
     *
     * ⚠ This does not weaken `failureReason`'s rule above. That column is
     * written on every refusal and every failure, including for real
     * deliveries. This one is written on exactly one path — a draft run, whose
     * recipients are a test address and whose content is precisely what the
     * person testing needs to read. **A real send still stores no body**, which
     * is checkable by grepping the single writer in `routes/mail.ts`.
     */
    capturedBody: text("captured_body"),
    /**
     * `[{name, bytes}]` for every attachment the message carried, on EVERY
     * outcome — what was attached, never what it said. Same rule as
     * `failureReason`: a real send stores no content.
     */
    attachments: jsonb("attachments").$type<Array<{ name: string; bytes: number }>>().notNull().default([]),
    /**
     * The attachments' CONTENT, held ONLY when `outcome = 'captured'` — the
     * `capturedBody` rule above, for the files: a draft run's person testing
     * needs to open exactly what the live run would have sent. Text files hold
     * their text; a generated `.xlsx` holds base64 and says so with `encoding`.
     */
    capturedAttachments: jsonb("captured_attachments").$type<
      Array<{
        name: string;
        contentType: string;
        content: string;
        bytes: number;
        encoding?: "text" | "base64";
      }>
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // The run page reads by execution — the access path that has to be fast.
    executionIdx: index("idx_email_sends_execution").on(t.flowExecutionId, t.createdAt),
    workspaceIdx: index("idx_email_sends_workspace").on(t.workspaceId, t.createdAt),
    outcomeCheck: check(
      "ck_email_sends_outcome",
      sql`${t.outcome} in ('sent', 'refused', 'failed', 'captured')`,
    ),
  }),
);

/**
 * A HELD message's attachments, as files (migration 0098, 2026-10-13). `email_sends.captured_attachments` kept their
 * content inline, which the Email box returned with every message in the list — so anything past 5 MB was dropped,
 * and the person testing a report saw its name with nothing to open. Here each file is its own encrypted row, read
 * one at a time when someone downloads or previews it. Only a `captured` message holds any: a real send keeps none.
 */
export const emailHeldFiles = pgTable(
  "email_held_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailSendId: uuid("email_send_id")
      .notNull()
      .references(() => emailSends.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Position in the message's `attachments` — two files may share a name. */
    position: integer("position").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sendIdx: uniqueIndex("uq_email_held_files_send_position").on(t.emailSendId, t.position),
  }),
);

/**
 * B-12 · Builder flags the readiness sheet resolves (S-10, S-13, law 6).
 *
 * Six flags on the flagship draft cover five kinds — `restricted`,
 * `assumption`, `low-confidence`, `missing-input` (×2), `unresolved-decision` —
 * plus a draft-level `No successful test run` row where `stepNumber` is NULL
 * (blocking). Honours D-37 insert-only revisions: flags are keyed to a
 * `flowRevisionId` (FK → `flow_revisions`) and never to a mutable draft.
 *
 * `consequence` is NOT NULL — a flag without a quantified consequence
 * ("14 of 142", "Up to 27 emails") invents the sentence the reviewer decides on.
 * The service enforces it; the DB enforces NOT NULL. `options` holds per-option
 * consequences for `unresolved-decision` (2 options each with consequence).
 *
 * B-29 note: `operations` table does not yet exist (per backend-required B-29).
 * This table does NOT invent `consequence` sentences — the UI keeps findings
 * local via `useLocalFindings` until this lands, and only persisted
 * consequences here drive readiness. When `operations` lands, per-operation
 * safety badges (`masked`/`mock`/`restricted`) will be the source of the
 * `restricted` kind's consequence, still authored, never generated.
 */
export const flowStepFlags = pgTable(
  "flow_step_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowRevisionId: uuid("flow_revision_id")
      .notNull()
      .references(() => flowRevisions.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    consequence: text("consequence").notNull(),
    blocking: boolean("blocking").notNull(),
    options: jsonb("options").$type<{ label: string; consequence: string }[] | null>(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    kindCheck: check(
      "ck_flow_step_flags_kind",
      sql`${t.kind} in ('restricted','assumption','low-confidence','missing-input','unresolved-decision')`,
    ),
    statusCheck: check("ck_flow_step_flags_status", sql`${t.status} in ('open','resolved','deferred')`),
    revisionIdx: index("idx_flow_step_flags_revision").on(t.flowRevisionId),
    statusIdx: index("idx_flow_step_flags_status").on(t.flowRevisionId, t.status),
    uniq: uniqueIndex("uq_flow_step_flags_revision_step_kind").on(
      t.flowRevisionId,
      t.stepNumber,
      t.kind,
    ),
  }),
);
/**
 * B-14 · S-37 Approvals inbox — unified `approval_requests` queue (one queue, six types).
 *
 * ⚠ `approval_requests is not flow_approvals` — separate table (phases/10).
 * `flow_approvals` binds a **revision** (the blank-cheque guard, §6.5 gate 2).
 * This table is the **queue** over six request types backed by four sources
 * (`flow_approvals` for Publication, `flow_run_requests` for Recovery,
 * `flow_step_approvals` for gate-3, plus three new: exception, access, policy).
 *
 * Six types share one queue: `exception` (EXC-), `publication` (PUB-),
 * `access_request` (ACC-), `resource_change` (RES-), `recovery` (REC-),
 * `policy_exception` (POL-). `subject` is `{entityType, entityId}` never prose,
 * with a rendered `subject_label`. `approval_policy` is `all|any|quorum` (UX-005)
 * — the policy is a column, not a convention.
 *
 * Workspace-scoped: every read filters `WHERE workspace_id = ?` (phases/10).
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    subjectEntityType: text("subject_entity_type").notNull(),
    subjectEntityId: text("subject_entity_id").notNull(),
    subjectLabel: text("subject_label").notNull(),
    requesterSubject: text("requester_subject").notNull(),
    risk: text("risk").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).defaultNow().notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    approvalPolicy: text("approval_policy").notNull(),
  },
  (t) => ({
    wsStatusIdx: index("idx_approval_requests_workspace_status").on(t.workspaceId, t.status),
    wsRequesterIdx: index("idx_approval_requests_workspace_requester").on(
      t.workspaceId,
      t.requesterSubject,
    ),
    typeCheck: check(
      "ck_approval_requests_type",
      sql`${t.type} in ('exception','publication','access_request','recovery','policy_exception','resource_change')`,
    ),
    riskCheck: check("ck_approval_requests_risk", sql`${t.risk} in ('low','medium','high')`),
    statusCheck: check(
      "ck_approval_requests_status",
      sql`${t.status} in ('pending','approved','rejected','withdrawn')`,
    ),
    policyCheck: check(
      "ck_approval_requests_policy",
      sql`${t.approvalPolicy} in ('all','any','quorum')`,
    ),
  }),
);

/**
 * One decision on one `approval_requests` row.
 *
 * Append-only in practice (a request may collect multiple decisions under
 * `all`/`quorum`); `status` is `approved|rejected` and `comment` is the
 * "comment for the requester" (S-39 names the reader).
 */
export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    approverSubject: text("approver_subject").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    comment: text("comment"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestIdx: index("idx_approval_decisions_request").on(t.requestId),
    statusCheck: check(
      "ck_approval_decisions_status",
      sql`${t.status} in ('approved','rejected')`,
    ),
  }),
);
/**
 * B-15 · S-68 Audit explorer — audit_events immutable record.
 *
 * Two views of ONE immutable record: Plain English and Raw events are
 * projections of the same rows. Append-only — no UPDATE or DELETE is
 * granted (see drizzle/0046_audit_events.sql REVOKE + COMMENT).
 * Workspace-scoped: every read filters `WHERE workspace_id = ?`.
 *
 * `operation` — create | update | delete | publish | approve | reject | access | execute
 * `entity` — workflow | version | resource | run | incident | approval | policy | datasource | tool | trigger | secret | member | flow | execution | template
 * `where_text` is the breadcrumb the Plain view renders; `where_entity_type`/`where_entity_id`
 * is the typed reference alongside it (never prose).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    time: timestamp("time", { withTimezone: true }).defaultNow().notNull(),
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    description: text("description").notNull(),
    whereText: text("where_text").notNull(),
    whereEntityType: text("where_entity_type"),
    whereEntityId: text("where_entity_id"),
    raw: jsonb("raw"),
  },
  (t) => ({
    workspaceTimeIdx: index("idx_audit_events_workspace_time").on(t.workspaceId, t.time),
    workspaceActorIdx: index("idx_audit_events_workspace_actor").on(t.workspaceId, t.actor),
    workspaceOperationIdx: index("idx_audit_events_workspace_operation").on(t.workspaceId, t.operation),
    operationCheck: check(
      "ck_audit_events_operation",
      sql`${t.operation} in ('create','update','delete','publish','approve','reject','access','execute')`,
    ),
    entityCheck: check(
      "ck_audit_events_entity",
      sql`${t.entity} in ('workflow','version','resource','run','incident','approval','policy','datasource','tool','trigger','secret','member','flow','execution','template')`,
    ),
  }),
);
/**
 * B-16 · S-58/S-59/S-60 Break-glass & incidents — incidents, break_glass_sessions.
 *
 * `incidents` — workspace-scoped incident record (text PK e.g. INC-2026-08-0004).
 * Status machine: reported→triaged→investigating→contained→recovering→monitoring→resolved→post-incident-review→closed
 * (append-only timeline jsonb holds transitions; closed requires post-incident-review to have been reached — enforced in service).
 *
 * `break_glass_sessions` — emergency access session bound to an incident.
 * SEV1 gate: duration=4 only if incident.severity=sev1 (server-enforced, 400 otherwise).
 * expires_at is GENERATED ALWAYS AS (activated_at + duration_hours * interval '1 hour') STORED.
 * Workspace-scoped indexes: incidents (workspace_id, status), break_glass_sessions (workspace_id, incident_id).
 * 5 concurrent active max enforced in service (per workspace).
 */
export const incidents = pgTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("reported"),
    ownerSubject: text("owner_subject"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    timeline: jsonb("timeline").$type<unknown>(),
  },
  (t) => ({
    workspaceStatusIdx: index("idx_incidents_workspace_status").on(t.workspaceId, t.status),
    severityCheck: check("ck_incidents_severity", sql`${t.severity} in ('sev1','sev2','sev3')`),
    statusCheck: check(
      "ck_incidents_status",
      sql`${t.status} in ('reported','triaged','investigating','contained','recovering','monitoring','resolved','post-incident-review','closed')`,
    ),
  }),
);

export const breakGlassSessions = pgTable(
  "break_glass_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    durationHours: integer("duration_hours").notNull(),
    justification: text("justification").notNull(),
    acknowledged: boolean("acknowledged").notNull().default(false),
    activatedBySubject: text("activated_by_subject").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).generatedAlwaysAs(
      sql`("activated_at" AT TIME ZONE 'UTC' + "duration_hours" * interval '1 hour') AT TIME ZONE 'UTC'`,
    ),
    status: text("status").notNull().default("active"),
  },
  (t) => ({
    workspaceIncidentIdx: index("idx_break_glass_workspace_incident").on(t.workspaceId, t.incidentId),
    workspaceStatusIdx: index("idx_break_glass_workspace_status").on(t.workspaceId, t.status),
    scopeCheck: check("ck_break_glass_scope", sql`${t.scope} in ('hris-unmasked','payroll-restricted')`),
    durationCheck: check("ck_break_glass_duration", sql`${t.durationHours} in (1,2,4)`),
    justificationCheck: check("ck_break_glass_justification", sql`char_length(${t.justification}) >= 20`),
    statusCheck: check("ck_break_glass_status", sql`${t.status} in ('active','expired','revoked')`),
  }),
);
/**
 * B-19 · `release_gates` — publish review 4 gates (S-24).
 *
 * S-24 Publish review gates: Successful test required / No open blockers / All resources published / Publication approval
 * Three-state ✓/✗/◷: enabled gates enforce met/unmet/pending; disabled = not enforced (still returned so UI can render "not enforced").
 * `satisfiedBy` quoted verbatim when blocked (AC-07-5). `flowId null` = workspace default, non-null = per-flow override.
 * `policy_id` refs `policies` (Phase 13) — nullable until that table lands.
 *
 * Workspace-scoped indexes: (workspace_id), (workspace_id, flow_id), (workspace_id, flow_id, name).
 * Honours D-37 insert-only revisions via the evaluation helper (flags + runs + resources) — this table stores configuration only.
 */
export const releaseGates = pgTable(
  "release_gates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id").references(() => flows.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    satisfiedBy: text("satisfied_by").notNull(),
    policyId: text("policy_id"),
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("idx_release_gates_workspace").on(t.workspaceId),
    workspaceFlowIdx: index("idx_release_gates_workspace_flow").on(t.workspaceId, t.flowId),
    workspaceFlowNameIdx: index("idx_release_gates_workspace_flow_name").on(t.workspaceId, t.flowId, t.name),
  }),
);
/**
 * B-08 reviewed_templates + B-09 chips most-used derived, 5 concurrent max.
 *
 * Platform table, not workspace-scoped: the 34 reviewed templates are the
 * platform catalogue from which a workspace picks. The workspace's copies live
 * in `flow_templates` (existing). `is_curated` marks the three surfaced on
 * S-03 START FROM A REVIEWED TEMPLATE. `usage_count` drives mostUsed ranking
 * (per user decision) and `GET /templates/suggestions` reuses the same ordering
 * for chips (S-01 + S-03 share one PromptComposer component when wired).
 * `review_status` is reviewed | pending; only reviewed rows are listed.
 */
export const reviewedTemplates = pgTable(
  "reviewed_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    eyebrow: text("eyebrow"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    includes: text("includes").array(),
    usageCount: integer("usage_count").notNull().default(0),
    isCurated: boolean("is_curated").notNull().default(false),
    reviewStatus: text("review_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    slugUnique: unique("uq_reviewed_templates_slug").on(t.slug),
    curatedIdx: index("idx_reviewed_templates_curated").on(t.isCurated),
    usageIdx: index("idx_reviewed_templates_usage").on(t.usageCount),
    nameIdx: index("idx_reviewed_templates_name").on(t.name),
  }),
);
/**
 * B-10 · S-04 catalogue picker — virtual catalogue safety marker.
 *
 * Catalogue is a workspace-scoped UNION of `flow_templates` + `datasources` + `tools` + `schemas`
 * with per-access safety `masked|mock|restricted` computed via `real-data` capability + datasource sandbox.
 * This table is a marker for migration compliance — the union remains virtual, but the safety vocabulary
 * and owner tracking are persisted here for audit if a static catalogue entry is ever needed.
 * Workspace-scoped indexes ensure `GET /workspaces/:ws/catalogue?q=` can be scoped.
 */
export const catalogueItems = pgTable(
  "catalogue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    icon: text("icon").notNull(),
    kind: text("kind").notNull(),
    safety: text("safety").notNull(),
    owner: text("owner"),
    ownerName: text("owner_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("idx_catalogue_items_workspace").on(t.workspaceId),
    safetyCheck: check("ck_catalogue_items_safety", sql`${t.safety} in ('masked','mock','restricted')`),
    kindCheck: check("ck_catalogue_items_kind", sql`${t.kind} in ('workflow','datasource','tool','table','file','report','policy')`),
  }),
);
/**
 * B-02 pins per-person oid, unique workspace_id,subject,flow_id, idx54.
 * Per-person not per-workspace: a pin is somebody's shortlist, subject is oid ?? sub per identity.middleware.
 * No shared pin: subject is part of PK uniqueness. FK cascade to flows.
 */
export const pins = pgTable(
  "pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    wsSubjectFlowUnique: unique("uq_pins_workspace_subject_flow").on(t.workspaceId, t.subject, t.flowId),
    wsSubjectIdx: index("idx_pins_workspace_subject").on(t.workspaceId, t.subject),
    flowIdx: index("idx54").on(t.flowId),
  }),
);
/**
 * B-18 · flow_test_scenarios — scenario picker data for S-20.
 *
 * S-20 Test this workflow: five equal radio cards Saved/Edge/AI/Manual/Real.
 * `real` is NOT a kind — real is namespace D-52 (draft vs live), never a fixture.
 * `saved` is a fixture binding (fixture_id → datasource_fixtures SET NULL).
 * `edge-case` carries reason = why worth running (population line + because).
 * `ai-generated` stores the description that built the fixture; `manual` stores row JSON.
 * `population` e.g. "142 employees · normal month" is required, never faked — honest-empty when none.
 * Indexes: (workspace_id, flow_id) + (flow_id, kind). Migration idx 52.
 * B-24: datasource_fixtures already exists with isMock/masked; this table reuses it via fixture_id.
 * B-26: inferred threshold 90 lives in field_mappings/inference; not duplicated here.
 */
export const SCENARIO_KINDS = ["saved", "edge-case", "ai-generated", "manual"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const flowTestScenarios = pgTable(
  "flow_test_scenarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    population: text("population").notNull(),
    reason: text("reason"),
    fixtureId: uuid("fixture_id").references(() => datasourceFixtures.id, { onDelete: "set null" }),
    createdBySubject: text("created_by_subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceFlowIdx: index("idx_flow_test_scenarios_workspace_flow").on(t.workspaceId, t.flowId),
    flowKindIdx: index("idx_flow_test_scenarios_flow_kind").on(t.flowId, t.kind),
    kindCheck: check("ck_flow_test_scenarios_kind", sql`${t.kind} in ('saved','edge-case','ai-generated','manual')`),
  }),
);
/**
 * B-17 · S-42 My attendance status — per-employee attendance aggregation (consumer).
 *
 * workspace_id fk cascade, subject text, date date, hours_in_office numeric, source text,
 * primary key (workspace_id, subject, date). Workspace-scoped, subject is identity subject (oid|sub).
 * attendance_compliance holds the monthly rollup evaluated at 02:00 IST (Asia/Kolkata).
 * period is text "YYYY-MM" (e.g. 2026-07), days_in_office/required_days int, avg_hours interval,
 * last_calculated_at/next_calculation_at timestamptz, compliant bool, history jsonb (six-month grid).
 * Refresh by cron 02:00 IST stub — nextCalculationAt is always first of next month 02:00 IST.
 * Indexes on (workspace_id, subject) + (period) for per-person period reads.
 * Migration idx 53.
 */
export const attendanceDaily = pgTable(
  "attendance_daily",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    date: date("date").notNull(),
    hoursInOffice: numeric("hours_in_office").notNull(),
    source: text("source"),
  },
  (t) => ({
    pk: unique("pk_attendance_daily").on(t.workspaceId, t.subject, t.date),
    workspaceSubjectIdx: index("idx_attendance_daily_workspace_subject").on(t.workspaceId, t.subject),
    dateIdx: index("idx_attendance_daily_date").on(t.date),
  }),
);
export const attendanceCompliance = pgTable(
  "attendance_compliance",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    period: text("period").notNull(),
    daysInOffice: integer("days_in_office").notNull(),
    requiredDays: integer("required_days").notNull(),
    avgHours: interval("avg_hours").notNull(),
    lastCalculatedAt: timestamp("last_calculated_at", { withTimezone: true }).notNull(),
    nextCalculationAt: timestamp("next_calculation_at", { withTimezone: true }).notNull(),
    compliant: boolean("compliant").notNull(),
    history: jsonb("history").$type<Array<{ month: string; compliant: boolean }>>(),
  },
  (t) => ({
    pk: unique("pk_attendance_compliance").on(t.workspaceId, t.subject, t.period),
    workspaceSubjectIdx: index("idx_attendance_compliance_workspace_subject").on(t.workspaceId, t.subject),
    periodIdx: index("idx_attendance_compliance_period").on(t.period),
  }),
);

/**
 * Local accounts — a username and password for a person with no AD identity.
 *
 * ⚠ **NO ROLE AND NO SUPER-ADMIN COLUMN, and both absences are the design.** A
 * local account is an identity and nothing else. Workspace rights live in
 * `workspace_members` keyed on the subject this table issues, so a person's
 * rights are read from ONE place whether they arrived through Entra or through
 * here; platform rights stay in `SUPER_ADMIN_EMAILS` on the server, so creating
 * an account is not a privilege-escalation path. See `drizzle/0060` for the
 * long form, including why the create path also refuses an email already on
 * that allowlist.
 */
export const localUsers = pgTable(
  "local_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The sign-in name, stored lower-case.
     *
     * ⚠ Case-folded by the SERVICE, never by a functional index — so the value
     * read back is the value compared. A raw column plus a `lower()` index is
     * two spellings of one identity, and the one that loses is whichever the
     * login path happens to use.
     */
    username: varchar("username", { length: 128 }).notNull().unique(),
    /**
     * Display only.
     *
     * ⚠ **NOT a login identifier and deliberately NOT unique** — two people can
     * share a mailbox, and a unique constraint would refuse a legitimate second
     * account. It still travels in the identity token, which is why the create
     * path checks it against the super-admin allowlist.
     */
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 255 }),
    /**
     * `scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>` — the PARAMETERS travel with
     * the hash, so raising the cost later re-hashes on next sign-in and needs
     * no migration and no second column to disagree with.
     */
    passwordHash: text("password_hash").notNull(),
    /**
     * ⚠ Deactivate, never delete. A deleted row frees its username, and the
     * `workspace_members` rows keyed on the old subject would then apply to
     * whoever took the name.
     */
    isActive: boolean("is_active").notNull().default(true),
    /** The super admin who created it, by identity subject. Attribution only. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Stamped by the verify path on success. Never a gate. */
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index("local_users_active_idx").on(t.isActive),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — custom workspace roles, the platform tier, and the platform audit
// record. Migrations 0062–0065.
//
// ⚠ `workspaceMembers` and `auditEvents` above are DELIBERATELY UNTOUCHED
// (INV-16). Membership stays the single answer to "is this person in this
// workspace" and a custom role only adds to what they may do; an untouched
// `workspace_members` is also what makes FR-028 cheap to prove. Do not add a
// permission column to either.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A named role composed from the permission catalogue, scoped to ONE workspace.
 *
 * ⚠ Retiring is a timestamp, never a delete (INV-7). A deleted role leaves audit
 * entries referencing a name nobody can look up, and FR-033 forbids editing the
 * audit to repair that.
 */
export const workspaceRoles = pgTable(
  "workspace_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Display name, e.g. "Finance Reviewer".
     * ⚠ INV-6 — may not collide with a preset name (`author`/`approver`/`admin`),
     * or a grant becomes ambiguous between code and data.
     */
    name: text("name").notNull(),
    description: text("description"),
    /** Identity **subject**, never an email. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft retire. NULL means live. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => ({
    wsIdx: index("idx_workspace_roles_workspace").on(t.workspaceId),
  }),
);

/**
 * Which permissions a custom role carries.
 *
 * ⚠ INV-8 — a `platform.*` permission may not appear here, CHECK-enforced rather
 * than merely validated in the service. A workspace role granting a
 * deployment-wide permission is privilege escalation by role authoring, and the
 * service is one refactor away from forgetting to look.
 */
export const workspaceRolePermissions = pgTable(
  "workspace_role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => workspaceRoles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permission] }),
  }),
);

/**
 * Who holds which custom role.
 *
 * ⚠ INV-9 — an assignment requires a `workspace_members` row for the same
 * `(workspace_id, subject)`. A custom role adds to what a member may do; it never
 * smuggles a non-member in. Enforced in the service, because the membership row
 * and this row have no shared key a foreign key could use.
 *
 * A person may hold SEVERAL custom roles, unlike the single preset in
 * `workspace_members.role`. The effective set is the union (FR-011), so two roles
 * can never conflict — which is exactly what grant-only (D-3) bought.
 */
export const workspaceRoleAssignments = pgTable(
  "workspace_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => workspaceRoles.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("idx_workspace_role_assignments_unique").on(
      t.workspaceId,
      t.subject,
      t.roleId,
    ),
    subjIdx: index("idx_workspace_role_assignments_subject").on(t.workspaceId, t.subject),
  }),
);

/**
 * Deployment-wide roles — the tier above a workspace.
 *
 * ⚠ INV-13 — no row here can confer super admin. `config.isSuperAdmin` reads the
 * environment and nothing else; there is no `platform.superadmin` permission and
 * no code path from a row to that predicate. The allowlist stays the un-grantable
 * root.
 */
export const platformRoles = pgTable("platform_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable key — `platform-admin` | `auditor` | `support` | a custom one. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** ⚠ CHECK: every element is in the catalogue AND is `platform.*`-prefixed. */
  permissions: text("permissions").array().notNull(),
  /** ⚠ INV-15 — a built-in role refuses edit and delete. */
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformRoleAssignments = pgTable(
  "platform_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: text("subject").notNull(),
    /** Display only. Never used to decide identity. */
    email: text("email").notNull(),
    roleKey: text("role_key").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("idx_platform_role_assignments_unique").on(t.subject, t.roleKey),
    subjIdx: index("idx_platform_role_assignments_subject").on(t.subject),
  }),
);

/**
 * The platform-tier audit record.
 *
 * ⚠ A SECOND store, and that is a storage decision that must never be
 * reader-visible (INV-17). `GET /api/platform/audit` unions this with
 * `audit_events` in one time order, because "where is it written" is not a
 * question a reader of an audit trail should have to answer.
 *
 * ⚠ Workspace-scoped access events do NOT come here — they go to `audit_events`
 * with `operation: "access"`, whose existing values already permit it, so no
 * migration alters that table.
 */
export const platformAuditEvents = pgTable(
  "platform_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
    /** Who did it, by identity subject. */
    actor: text("actor").notNull(),
    actorEmail: text("actor_email"),
    /** `grant` | `revoke` | `role.create` | `role.update` | `role.retire` | `deny`. */
    action: text("action").notNull(),
    /** Who or what it was done to. */
    subject: text("subject"),
    /** `platform_role` | `workspace_role` | `member` | `permission`. */
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    /**
     * ⚠ Before and after, never the protected resource itself (FR-034). A denial
     * entry records that somebody was refused `flows.read` on a workspace — never
     * any part of the flow they were refused.
     */
    before: jsonb("before"),
    after: jsonb("after"),
    /** For a bounded denial record: how many identical refusals this row stands for. */
    repeatCount: integer("repeat_count").notNull().default(1),
  },
  (t) => ({
    timeIdx: index("idx_platform_audit_events_time").on(t.time),
    actorIdx: index("idx_platform_audit_events_actor").on(t.actor),
  }),
);

/**
 * A cost report somebody emailed (migration 0106). An emailed report goes to people who may hold no access to the
 * workspaces it covers, so every send leaves a row: who sent it, to whom, which workspaces and period, and whether it
 * went. There is no body and no workbook here, only what was shared and with whom. Insert-only apart from the one
 * outcome write after the provider answers.
 */
export const reportShares = pgTable(
  "report_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    senderSubject: text("sender_subject").notNull(),
    senderEmail: text("sender_email"),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    workspaceIds: jsonb("workspace_ids").$type<string[]>().notNull().default([]),
    workspaceNames: jsonb("workspace_names").$type<string[]>().notNull().default([]),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    /** The drill filters the sender had applied, if any: `{ flowId?, subject? }`. */
    filters: jsonb("filters").$type<Record<string, string>>().notNull().default({}),
    filename: text("filename").notNull(),
    bytes: integer("bytes").notNull().default(0),
    runCount: integer("run_count").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull().default("0"),
    /** Pessimistic until the provider answers, so a crash mid-send reads as "attempted", never as "sent". */
    outcome: varchar("outcome", { length: 16 }).notNull().default("failed"),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    createdIdx: index("idx_report_shares_created").on(t.createdAt),
    outcomeCheck: check("ck_report_shares_outcome", sql`${t.outcome} in ('sent', 'refused', 'failed')`),
  }),
);
export type ReportShare = typeof reportShares.$inferSelect;

/**
 * Observability (pi-runtime P-OBS, migration 0089): one row per model call, tool call or read — who, which workflow,
 * building / test / live, tokens, cost, duration, outcome. Run outcomes stay on flow_executions.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    purpose: varchar("purpose", { length: 16 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    subject: varchar("subject", { length: 255 }),
    actor: varchar("actor", { length: 255 }),
    flowId: uuid("flow_id"),
    flowName: text("flow_name"),
    sessionId: varchar("session_id", { length: 64 }),
    executionId: uuid("execution_id"),
    stepId: varchar("step_id", { length: 255 }),
    model: varchar("model", { length: 255 }),
    tool: varchar("tool", { length: 255 }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** Prompt tokens read from the gateway's cache — billed at the cache-read price. Included in `tokensIn`. */
    tokensCached: integer("tokens_cached"),
    /** Prompt tokens written to the cache (0090) — billed at the cache-write price. Included in `tokensIn`. */
    tokensCacheWrite: integer("tokens_cache_write"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
    durationMs: integer("duration_ms"),
    ok: boolean("ok").notNull().default(true),
  },
  (t) => ({ wsAt: index("ix_usage_events_ws_at").on(t.workspaceId, t.at) }),
);
export type UsageEvent = typeof usageEvents.$inferSelect;


/**
 * Model prices (rbac-observability, migration 0102): what one million input tokens and one million output tokens of a
 * model cost, in US dollars. INSERT-ONLY history — a change is a new row with a later `effective_from`, so a price
 * change never rewrites what past usage cost. Cost is computed at read from the price in effect when the usage
 * happened; a row with NULL prices removes the price from then on (the producer's reported cost is used again).
 * Cached input tokens are charged at the input price.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    model: text("model").notNull(),
    inputPer1m: numeric("input_per_1m", { precision: 14, scale: 6 }),
    outputPer1m: numeric("output_per_1m", { precision: 14, scale: 6 }),
    /** A cache READ (`usage_events.tokens_cached`). Null: the input price (0104). */
    cachedInputPer1m: numeric("cached_input_per_1m", { precision: 14, scale: 6 }),
    /** A cache WRITE (`usage_events.tokens_cache_write`). Null: the input price (0104). */
    cacheWritePer1m: numeric("cache_write_per_1m", { precision: 14, scale: 6 }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  (t) => ({ modelFrom: index("ix_model_prices_model_from").on(t.model, t.effectiveFrom) }),
);
export type ModelPrice = typeof modelPrices.$inferSelect;

// ── Plugins (plans/plugins-2026-10-27; migration 0106) ───────────────────────────────────────────────────────────────

/**
 * A connector installed for the whole deployment. The connector service keeps its own runtime manifest; this is the
 * record of who installed what, at which exact version and integrity, and which hosts it was approved to reach.
 */
export const pluginInstalls = pgTable(
  "plugin_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    piece: text("piece").notNull(),
    version: text("version").notNull(),
    integrity: text("integrity").notNull(),
    license: text("license"),
    displayName: text("display_name").notNull(),
    logoUrl: text("logo_url"),
    hosts: text("hosts").array().notNull().default(sql`'{}'::text[]`),
    installedBy: text("installed_by").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ piece: uniqueIndex("idx_plugin_installs_piece").on(t.piece) }),
);

/**
 * One workspace's connection to one installed piece. ⚠ Names only: the value is encrypted in `workspace_secrets`
 * under `secretName`, where a plugin tool's `secret_env_name` finds it — there is no column here a value could go in.
 */
export const pluginConnections = pgTable(
  "plugin_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    piece: text("piece").notNull(),
    label: text("label").notNull(),
    authType: text("auth_type").notNull(),
    secretName: text("secret_name").notNull(),
    fieldNames: text("field_names").array().notNull().default(sql`'{}'::text[]`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestOk: boolean("last_test_ok"),
    lastTestMessage: text("last_test_message"),
    /** A connection owned by ONE person ("as me", migration 0108). NULL is the workspace's. Never used by an automation. */
    ownerSubject: text("owner_subject"),
  },
  (t) => ({
    // The real index (0108) is on (workspace, piece, COALESCE(owner_subject, ''), label); drizzle cannot express it.
    secret: uniqueIndex("idx_plugin_connections_secret").on(t.workspaceId, t.secretName),
  }),
);

/**
 * A declared API call (migration 0114, plans/declared-api-calls-2026-10-29): a piece's raw call fixed in advance. The
 * tool's address is `plugin://<piece>@<version>/call_<hash>`; the connector rebuilds the request from `declaration`
 * and refuses one that does not hash to the address. Kept after an edit — an edit is a new hash, a new row.
 */
export const pluginDeclaredCalls = pgTable(
  "plugin_declared_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    piece: text("piece").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    declaration: jsonb("declaration").notNull(),
    hash: varchar("hash", { length: 16 }).notNull(),
    /** The curated pack it came from, or null for one a person wrote. */
    pack: text("pack"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hash: uniqueIndex("idx_plugin_declared_calls_hash").on(t.workspaceId, t.piece, t.hash),
  }),
);
export type PluginDeclaredCall = typeof pluginDeclaredCalls.$inferSelect;

/**
 * A connector action a member switched on for THEMSELVES (migration 0118, plans/personal-actions-2026-10-29): usable in
 * their own Forge chats and in workflows they own, always through their own connection. `action` is the piece's action
 * name, or `call_<hash>` for a declared call.
 */
export const pluginPersonalActions = pgTable(
  "plugin_personal_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    piece: text("piece").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    one: uniqueIndex("idx_plugin_personal_actions_one").on(t.workspaceId, t.subject, t.piece, t.action),
  }),
);
export type PluginPersonalAction = typeof pluginPersonalActions.$inferSelect;

/** Whether members may switch a connector's actions on for themselves (0118). No row = allowed. */
export const pluginPersonalPolicy = pgTable(
  "plugin_personal_policy",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    piece: text("piece").notNull(),
    allowed: boolean("allowed").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.piece] }),
  }),
);

/**
 * Per connector, the OAuth client Foundry signs in with (migration 0108): a platform administrator's client id and
 * ENCRYPTED secret, or Foundry's own sign-in app (`useSignInApp`, Microsoft Entra). `scopes` may only narrow the
 * connector's own list.
 */
export const pluginOauthApps = pgTable(
  "plugin_oauth_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    piece: text("piece").notNull(),
    useSignInApp: boolean("use_sign_in_app").notNull().default(false),
    clientId: text("client_id"),
    clientSecretEnc: text("client_secret_enc"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ piece: uniqueIndex("idx_plugin_oauth_apps_piece").on(t.piece) }),
);

/** A sign-in that has started and not come back. Single use; only a HASH of the `state` is kept. */
export const pluginOauthStates = pgTable(
  "plugin_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateHash: text("state_hash").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    piece: text("piece").notNull(),
    label: text("label").notNull(),
    connectionId: uuid("connection_id"),
    ownerSubject: text("owner_subject"),
    subject: text("subject").notNull(),
    subjectEmail: text("subject_email"),
    codeVerifierEnc: text("code_verifier_enc"),
    propsEnc: text("props_enc"),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({ hash: uniqueIndex("idx_plugin_oauth_states_hash").on(t.stateHash) }),
);
