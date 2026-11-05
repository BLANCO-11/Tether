/**
 * The development sandbox — provision, freeze, drift, and the DSN a draft run reads.
 * DECISIONS.md D-52…D-54 · ISSUES.md I-54…I-56
 *
 * ── The problem, measured ────────────────────────────────────────────────────
 *
 * `datasourceQueryRepo.resolveRef()` had no draft/live distinction, so a TEST run
 * read the tenant's real database. Gate 1 *requires* a successful run before a
 * flow may be armed — so a flow with an `agent` step sent real rows to an
 * external model **before anyone had approved anything**, at the least
 * supervised moment in the lifecycle. That is the whole of the exposure this
 * module closes.
 *
 * ── Selection is bound to the NAMESPACE ──────────────────────────────────────
 *
 *   foundry.<tenant>.<ws>.draft  →  sandbox DSN   (fixtures)
 *   foundry.<tenant>.<ws>        →  real DSN      (production)
 *
 * Not a request parameter, not a header, not a flag on the flow: no `?mode=` can
 * point a draft run at production, because the namespace **is** the selector and
 * it is written by `POST /api/executions/begin` from Kestra's own record of the
 * execution (I-07), never from a request body. Approval already binds to the
 * live namespace and `flow-approval.service.ts` is its only writer, so this
 * inherits an enforced boundary rather than adding one.
 *
 * ── What a sandbox run may NOT be claimed to prove ───────────────────────────
 *
 * That the flow **executes** and agrees with its fixture. It cannot prove
 * correctness against production, and the reason is measured rather than
 * cautious: `hr_demo` stores attendance as 0–100 and `hr_demo_alt` as a 0–1
 * fraction, and the swap rehearsal found three real bugs on its first run. Same
 * argument Phase 6 uses for imports — *never describe an import as validating a
 * flow.* Gate 1 therefore still requires a supervised real run before arming,
 * and that is deliberate, not an oversight.
 */
import pg from "pg";
import { and, desc, eq } from "drizzle-orm";
import { config, sandboxRoPassword } from "../config/index.js";
import { db } from "../db/index.js";
import { datasourceFixtures, datasources } from "../db/schema.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { schemaIntrospectorService } from "./schema-introspector.service.js";
import type { IntrospectedEntity } from "./introspect/types.js";
import {
  deriveShape,
  isSafeIdentifier,
  renderDdl,
  type SandboxShape,
} from "./sandbox-ddl.service.js";
import {
  generateFixture,
  loadFixture,
  verifyTaxonomy,
  type DateWindow,
  type FixtureRows,
  type TaxonomyReport,
} from "./sandbox-fixture.service.js";
import type { InferenceClient } from "./inference.service.js";

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Where a datasource step's rows came from. Reported on every batch — see D-52. */
// `mock`: the mock-data plan's engine read (PGlite over fixture rows). The
// sandbox member stays until every reader migrates (SliceA owns that retirement).
export type ReadFrom = "sandbox" | "production" | "mock";

// ── names ────────────────────────────────────────────────────────────────────

/**
 * The sandbox database for a datasource. Derived from its uuid, never from its
 * NAME: a name is text somebody edits, and a renamed datasource must not orphan
 * its sandbox — the same reasoning that makes `workspaces.slug` immutable.
 */
export function sandboxDbName(datasourceId: string): string {
  return `${config.sandbox.dbPrefix}${datasourceId.replace(/-/g, "").slice(0, 16)}`;
}

export function sandboxRoleName(datasourceId: string): string {
  return `${config.sandbox.roRolePrefix}${datasourceId.replace(/-/g, "").slice(0, 16)}`;
}

function assertIdentifier(name: string, what: string): string {
  if (!isSafeIdentifier(name)) throw new SandboxError(`unsafe ${what}: ${name}`);
  return name;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The three months ending today — the window generated dates fall in.
 *
 * A fixture is frozen, so this ages: a sandbox provisioned in January and used
 * in June holds dates six months old, and a flow asking for the current period
 * reads zero rows. That is a real limit, surfaced rather than papered over —
 * `SandboxStatus.dateRange` reports the span the fixture actually covers, and
 * regenerating is one command. Silently re-dating a frozen fixture would be
 * worse: it is exactly the "a fixture that moves under a test" failure the
 * freeze exists to prevent.
 */
function recentWindow(): DateWindow {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 2);
  from.setDate(1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** An admin connection to `postgres`, for CREATE/DROP DATABASE only. */
function adminDsn(): string {
  const u = new URL(config.databaseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

/** The provisioning process's own route to a sandbox database — NOT the stored DSN. */
function ownerDsn(dbName: string): string {
  const u = new URL(config.databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * The DSN that gets ENCRYPTED and later dialled by the server container.
 *
 * ⚠ Different host from `ownerDsn` on purpose (D-44). `config.databaseUrl` is
 * `localhost:5433` in a host process and the server reaches Postgres through
 * `host.docker.internal:5433`; storing the former means every draft run fails to
 * connect, and the failure surfaces inside a flow rather than at provisioning.
 */
function storedRoDsn(dbName: string, datasourceId: string): string {
  const role = sandboxRoleName(datasourceId);
  const pw = encodeURIComponent(sandboxRoPassword(datasourceId));
  return `postgres://${role}:${pw}@${config.sandbox.dbHost}:${config.sandbox.dbPort}/${dbName}`;
}

/** The same credential, dialled from THIS process — for verification at provision time. */
function localRoDsn(dbName: string, datasourceId: string): string {
  const u = new URL(config.databaseUrl);
  const role = sandboxRoleName(datasourceId);
  u.username = role;
  u.password = sandboxRoPassword(datasourceId);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// ── database lifecycle ───────────────────────────────────────────────────────

async function withClient<T>(dsn: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * ⚠ The prefix check is the only thing standing between a bad datasource id and
 * `DROP DATABASE foundry_parent`. It is asserted in one place because there is
 * more than one caller.
 */
function assertSandboxDb(dbName: string): string {
  if (!dbName.startsWith(config.sandbox.dbPrefix)) {
    throw new SandboxError(
      `refusing to touch "${dbName}": a sandbox database name must start with ` +
        `"${config.sandbox.dbPrefix}"`,
    );
  }
  return assertIdentifier(dbName, "sandbox database name");
}

/** Kick every other session off a database. A single idle connection blocks DROP. */
async function evict(c: pg.Client, dbName: string): Promise<void> {
  await c.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
}

async function recreateDatabase(dbName: string): Promise<void> {
  assertSandboxDb(dbName);
  await withClient(adminDsn(), async (c) => {
    await evict(c, dbName);
    await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await c.query(`CREATE DATABASE ${dbName}`);
  });
}

/**
 * Where a provision BUILDS, before anything is promoted.
 *
 * ── Found by the harness, and it was a real defect ───────────────────────────
 *
 * The first version built in place: drop the sandbox, create it, load, verify,
 * and throw if the taxonomy failed. `provision`'s docblock claimed a failed
 * provision "leaves a datasource with no sandbox rather than one nobody
 * verified" — and that was false in the worst possible way. The *rows* were
 * already replaced by the time the check ran, and the datasource still pointed
 * at the database, so a refused regeneration left every subsequent draft run
 * reading the fixture that had just been rejected. The check fired, said no, and
 * the damage was done anyway.
 *
 * `kestra:sandbox` block 5 caught it: it refuses a bland fixture and then
 * compares a digest of the sandbox's contents, and the digest had moved.
 */
function stagingDbName(dbName: string): string {
  return `${dbName}_stg`;
}

/**
 * Promote the staging database over the live one.
 *
 * `ALTER DATABASE … RENAME TO` rather than a copy: grants on the database and on
 * every table inside it are catalogue entries that travel with the rename, so
 * the read-only role keeps working without a second round of GRANTs — and a
 * second round is exactly where "the sandbox role is not read-only" would come
 * from.
 */
async function promote(dbName: string): Promise<void> {
  const staging = assertSandboxDb(stagingDbName(dbName));
  assertSandboxDb(dbName);
  await withClient(adminDsn(), async (c) => {
    await evict(c, dbName);
    await evict(c, staging);
    await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await c.query(`ALTER DATABASE ${staging} RENAME TO ${dbName}`);
  });
}

async function dropStaging(dbName: string): Promise<void> {
  const staging = assertSandboxDb(stagingDbName(dbName));
  await withClient(adminDsn(), async (c) => {
    await evict(c, staging);
    await c.query(`DROP DATABASE IF EXISTS ${staging}`);
  }).catch(() => {
    /* best effort — a leftover staging database is untidy, not dangerous */
  });
}

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/**
 * The sandbox's read-only role, created fresh against the loaded schema.
 *
 * A copy of `demo/hr-roles.ts` in shape and in every trap it encodes, and
 * deliberately a copy rather than a shared helper: that module is pinned by
 * `demo:verify` and `hr-roles.test.ts` against the HR dataset's own config, and
 * generalising it to take a database and a role would put the demo's
 * least-privilege guarantee behind a parameter. Two callers, two verifications.
 *
 * ⚠ MUST run AFTER the DDL — table privileges die with the table, so a grant
 * issued before `CREATE TABLE` silently vanishes.
 * ⚠ `REVOKE … FROM PUBLIC` comes first: revoking from the role does not remove a
 * privilege it holds through the pseudo-role PUBLIC. This has bitten twice in
 * this repo (the demo roles, and the Kestra DB boundary — I-04).
 */
async function ensureSandboxRole(
  client: pg.Client,
  dbName: string,
  datasourceId: string,
  schemas: string[],
): Promise<string[]> {
  const role = assertIdentifier(sandboxRoleName(datasourceId), "sandbox role name");
  const database = assertIdentifier(dbName, "sandbox database name");
  const password = sandboxRoPassword(datasourceId);

  const { rows: existing } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const stmt = `LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT`;
  await client.query(existing.length === 0 ? `CREATE ROLE ${role} ${stmt}` : `ALTER ROLE ${role} ${stmt}`);

  await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  for (const s of schemas) {
    const schema = assertIdentifier(s, "sandbox schema name");
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await client.query(
      `REVOKE ${WRITE_PRIVILEGES.join(", ")} ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
    );
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
  }
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${role}`);
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(
    `ALTER ROLE ${role} SET statement_timeout = ${literal(config.sandbox.roStatementTimeout)}`,
  );
  await client.query(
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ${literal(config.sandbox.roIdleTxTimeout)}`,
  );
  const limit = Math.max(1, Math.trunc(config.sandbox.roConnectionLimit || 10));
  await client.query(`ALTER ROLE ${role} CONNECTION LIMIT ${limit}`);

  // Ask the catalogue what is true rather than asserting what was granted — the
  // WS-A.5 check, for the same reason: a GRANT that silently did nothing reads
  // exactly like one that worked.
  const problems: string[] = [];
  const { rows: attrs } = await client.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
    "SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (attrs[0]?.rolsuper) problems.push(`${role} is a superuser`);
  if (attrs[0]?.rolcreatedb) problems.push(`${role} can create databases`);
  const { rows: writable } = await client.query<{ tbl: string; priv: string }>(
    `SELECT (c.table_schema || '.' || c.table_name) AS tbl, p.priv
       FROM information_schema.tables c
       CROSS JOIN unnest($2::text[]) AS p(priv)
      WHERE c.table_schema = ANY($1::text[])
        AND has_table_privilege($3, quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), p.priv)`,
    [schemas, WRITE_PRIVILEGES, role],
  );
  for (const w of writable) problems.push(`${role} holds ${w.priv} on ${w.tbl}`);
  return problems;
}

// ── shape ────────────────────────────────────────────────────────────────────

/** Introspection as this module needs it — stored rows reassembled into entities. */
async function storedShape(datasourceId: string, allowlist: string[]): Promise<SandboxShape> {
  const stored = (await schemaIntrospectorService.getStored(datasourceId)) as Array<{
    entityType: string;
    name: string;
    schema: string | null;
    columns: unknown[];
  }>;
  if (!stored.length) {
    throw new SandboxError(
      "this datasource has no stored schema — refresh it first (a sandbox is a copy of a " +
        "shape, and there is nothing to copy)",
    );
  }
  return deriveShape(stored as unknown as IntrospectedEntity[], { allowlist });
}

// ── the public surface ───────────────────────────────────────────────────────

export interface SandboxStatus {
  datasourceId: string;
  datasourceName: string;
  /** True iff a draft run against this datasource reads fixtures. */
  hasSandbox: boolean;
  dbName: string | null;
  fixtureVersion: number | null;
  frozenAt: Date | null;
  generatedBy: string | null;
  model: string | null;
  taxonomy: TaxonomyReport | null;
  /**
   * The span of dates the fixture actually holds.
   *
   * ⚠ Surfaced because it is the answer to the first confusing thing about a
   * sandbox: a flow asking for a period outside this window reads zero rows and
   * looks broken. Measured on the first real run — the model wrote a valid,
   * taxonomy-passing fixture dated October 2023.
   */
  dateRange: { from: string; to: string } | null;
  /**
   * Set when the SOURCE schema has moved since the fixture was frozen — the
   * sandbox is testing a shape production no longer has. Reported, never
   * auto-repaired: silently regenerating would change what yesterday's test ran
   * against without anybody choosing to.
   */
  drift: { was: string; now: string } | null;
  /**
   * How an AUTOMATIC build went — `building | ready | failed`, or null where
   * none was ever started (a datasource provisioned from the CLI, or one
   * onboarded before this existed).
   *
   * ⚠ **`failed` and null are different facts and neither satisfies
   * `hasSandbox`.** null is "nobody asked"; `failed` is "we asked and here is
   * why not". Rendering the second as the first is an absence standing in for
   * an error. In both cases a draft run reads PRODUCTION and `exposure` below
   * still says so — an automatic build can only ever move a datasource toward
   * fixtures, never quietly claim it got there.
   */
  buildStatus: "building" | "ready" | "failed" | null;
  buildError: string | null;
  buildStartedAt: Date | null;
  /**
   * ⚠ Present when `hasSandbox` is false. A draft run against this datasource
   * reads PRODUCTION, and this is the sentence that says so — on the datasource
   * page, in the step result and on the run.
   */
  exposure: string | null;
}

/**
 * A stored `taxonomy_json` as a report — or null when it is not one.
 *
 * ── ⚠ The cast this replaces was a lie, and it crashed the page ─────────────
 *
 * It read `(fixture?.taxonomyJson as TaxonomyReport | undefined) ?? null`. That
 * asserts a shape nobody checked, and the column legitimately holds `{}`:
 * `mock-dataset.service.ts` writes every fixture with `taxonomyJson: {}`,
 * because a mock dataset runs no taxonomy. `{}` is truthy, so `?? null` never
 * fired, the client received `taxonomy: {}`, and `taxonomy.items.map` threw —
 * taking the whole datasource page down, not just the panel.
 *
 * ⚠ It only surfaced on 2026-09-17 because `hasSandbox` had never been true for
 * a mock fixture before: the block that renders the list is behind it, and the
 * two datasources that HAD a sandbox (hr_demo, legal_demo) both carry a v2
 * written by the model with a real report. A latent defect, exposed rather than
 * caused by the rebuild fix — and the sharpest kind, because the one path that
 * reached it was the one nobody had walked.
 *
 * ⚠ **`null` here means "no report was recorded", NOT "the checks passed".**
 * The panel says so; an absent list must never read as a satisfied one, which
 * is the whole reason every satisfied category carries evidence (D-54).
 */
function taxonomyOf(stored: unknown): TaxonomyReport | null {
  const t = stored as TaxonomyReport | undefined;
  return t && Array.isArray(t.items) ? t : null;
}

export const sandboxService = {
  sandboxDbName,
  sandboxRoleName,

  /**
   * The read-only DSN a DRAFT run should use, or null if there is no sandbox.
   *
   * The only reader is `step-execution.service.ts`, and it is handed the
   * execution's environment rather than deciding one. There is no variant of
   * this that takes a flag.
   */
  async draftDsn(datasourceId: string): Promise<string | null> {
    const rows = await db
      .select({ enc: datasources.sandboxDsnEnc })
      .from(datasources)
      .where(eq(datasources.id, datasourceId))
      .limit(1);
    const enc = rows[0]?.enc;
    return enc ? decrypt(enc) : null;
  },

  async status(workspaceId: string, datasourceId: string): Promise<SandboxStatus | null> {
    const rows = await db
      .select()
      .from(datasources)
      .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
      .limit(1);
    const ds = rows[0];
    if (!ds) return null;

    const fixtures = await db
      .select()
      .from(datasourceFixtures)
      .where(eq(datasourceFixtures.datasourceId, datasourceId))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    const fixture = fixtures[0];
    const hasSandbox = !!ds.sandboxDsnEnc && !!fixture;

    let drift: SandboxStatus["drift"] = null;
    if (fixture) {
      try {
        const shape = await storedShape(datasourceId, ds.schemaAllowlist ?? ["public"]);
        if (shape.fingerprint !== fixture.schemaFingerprint) {
          drift = { was: fixture.schemaFingerprint, now: shape.fingerprint };
        }
      } catch {
        // A datasource whose stored schema has been cleared cannot be compared.
        // Not a drift finding — an unknown, and saying "no drift" would be a lie.
        drift = { was: fixture.schemaFingerprint, now: "(schema unavailable)" };
      }
    }

    return {
      datasourceId,
      datasourceName: ds.name,
      hasSandbox,
      dbName: ds.sandboxDbName ?? null,
      fixtureVersion: fixture?.version ?? null,
      frozenAt: fixture?.frozenAt ?? null,
      generatedBy: fixture?.generatedBy ?? null,
      model: fixture?.model ?? null,
      taxonomy: taxonomyOf(fixture?.taxonomyJson),
      dateRange: taxonomyOf(fixture?.taxonomyJson)?.dateRange ?? null,
      drift,
      buildStatus: (ds.sandboxBuildStatus as SandboxStatus["buildStatus"]) ?? null,
      buildError: ds.sandboxBuildError ?? null,
      buildStartedAt: ds.sandboxBuildStartedAt ?? null,
      exposure: hasSandbox
        ? null
        : `no sandbox is provisioned for "${ds.name}", so a DRAFT (test) run of any flow that ` +
          `reads it reads PRODUCTION data — including any agent or llm_complete step downstream ` +
          `of it. Provision one with: pnpm --filter @foundry/server sandbox:provision ` +
          `--workspace=${workspaceId} --datasource=${ds.name}`,
    };
  },

  /**
   * Build a sandbox: derive the shape, generate rows, load, verify, freeze.
   *
   * The order is the argument. The fixture is written to `datasource_fixtures`
   * **only after** the taxonomy check has passed against the loaded database, and
   * the datasource's `sandbox_dsn_enc` is set only after that. So a failed
   * provision leaves a datasource with no sandbox — which reads PRODUCTION and
   * says so — rather than one with a sandbox nobody verified.
   */
  async provision(opts: {
    workspaceId: string;
    datasourceId: string;
    inference: InferenceClient;
    /** Bypasses generation. Only a test's negative control passes this. */
    authoredRows?: FixtureRows;
    /** Overrides the default three-month window. A test pins it; nothing else passes one. */
    window?: DateWindow;
    rows?: number;
    modelName?: string | null;
    onProgress?: (msg: string) => void;
  }): Promise<{ status: SandboxStatus; shape: SandboxShape; taxonomy: TaxonomyReport }> {
    const { workspaceId, datasourceId } = opts;
    const log = opts.onProgress ?? (() => {});

    const dsRows = await db
      .select()
      .from(datasources)
      .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
      .limit(1);
    const ds = dsRows[0];
    if (!ds) throw new SandboxError("datasource not found in this workspace");
    if (ds.type !== "postgres") {
      // MySQL sandboxes are not built. Refused by name rather than attempted:
      // the DDL emitter, the role model and every taxonomy query above are
      // Postgres, and a half-working sandbox is the failure mode this stage is
      // about.
      throw new SandboxError(`a sandbox is only implemented for postgres datasources, not "${ds.type}"`);
    }

    const shape = await storedShape(datasourceId, ds.schemaAllowlist ?? ["public"]);
    if (shape.unsupported.length) {
      throw new SandboxError("this datasource's shape cannot be reproduced", shape.unsupported);
    }
    const ddl = renderDdl(shape);
    log(`shape: ${shape.tables.length} table(s), fingerprint ${shape.fingerprint}`);
    for (const n of shape.notes) log(`note: ${n}`);

    const rows: FixtureRows =
      opts.authoredRows ??
      (
        await generateFixture({
          shape,
          client: opts.inference,
          rows: opts.rows,
          window: opts.window ?? recentWindow(),
          onProgress: log,
        })
      ).rows;

    // ── build in staging, verify there, promote only if it passes ───────────
    //
    // ⚠ Never in place. See `stagingDbName` — the in-place version replaced the
    // rows BEFORE the taxonomy check could refuse them, so a rejected fixture
    // still became what every draft run read.
    const dbName = sandboxDbName(datasourceId);
    const staging = stagingDbName(dbName);
    log(`materialising ${staging}`);
    await recreateDatabase(staging);

    let taxonomy: TaxonomyReport;
    try {
      taxonomy = await withClient(ownerDsn(staging), async (c) => {
        await c.query(ddl);
        await loadFixture(c, shape, rows);
        const rolePro = await ensureSandboxRole(c, staging, datasourceId, shape.schemas);
        if (rolePro.length) {
          throw new SandboxError("the sandbox read-only role is not read-only", rolePro);
        }
        return verifyTaxonomy(c, shape);
      });

      if (!taxonomy.integrity.ok) {
        throw new SandboxError("the fixture has dangling references", taxonomy.integrity.problems);
      }
      if (!taxonomy.passed) {
        const missing = taxonomy.items
          .filter((i) => !i.satisfied)
          .map((i) => `${i.id} — ${i.title}`);
        throw new SandboxError(
          "the fixture is too bland to test against: it does not contain every required edge case",
          missing,
        );
      }
    } catch (e) {
      await dropStaging(dbName);
      throw e;
    }

    await promote(dbName);

    // Prove the STORED credential is the one that works, by dialling it — from
    // this process, at this process's own hostname. `assertSameCredential`'s rule
    // (D-44): a value that is stored must resolve for its future reader, and a
    // value used now must resolve for the current process.
    await withClient(localRoDsn(dbName, datasourceId), async (c) => {
      await c.query(`SELECT 1 FROM ${shape.tables[0]!.schema ? `"${shape.tables[0]!.schema}".` : ""}"${shape.tables[0]!.name}" LIMIT 1`);
    });

    const priorRows = await db
      .select({ version: datasourceFixtures.version })
      .from(datasourceFixtures)
      .where(eq(datasourceFixtures.datasourceId, datasourceId))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    const version = (priorRows[0]?.version ?? 0) + 1;

    await db.insert(datasourceFixtures).values({
      datasourceId,
      version,
      rowsJson: rows,
      ddlSql: ddl,
      schemaFingerprint: shape.fingerprint,
      taxonomyJson: taxonomy,
      generatedBy: opts.authoredRows ? "authored" : "model",
      model: opts.authoredRows ? null : (opts.modelName ?? null),
    });

    await db
      .update(datasources)
      .set({
        sandboxDsnEnc: encrypt(storedRoDsn(dbName, datasourceId)),
        sandboxDbName: dbName,
        sandboxFixtureVersion: version,
        updatedAt: new Date(),
      })
      .where(eq(datasources.id, datasourceId));

    const status = await this.status(workspaceId, datasourceId);
    return { status: status!, shape, taxonomy };
  },

  /**
   * Rebuild the sandbox database from the FROZEN fixture. No inference.
   *
   * This is what makes freezing real: the database can be dropped, lost with the
   * volume, or restored on another host, and the rows come back byte-identical
   * because they live in `foundry_parent` and are replayed from there.
   */
  async rematerialise(workspaceId: string, datasourceId: string): Promise<TaxonomyReport> {
    const dsRows = await db
      .select()
      .from(datasources)
      .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
      .limit(1);
    const ds = dsRows[0];
    if (!ds) throw new SandboxError("datasource not found in this workspace");
    const fixtures = await db
      .select()
      .from(datasourceFixtures)
      .where(eq(datasourceFixtures.datasourceId, datasourceId))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    const fixture = fixtures[0];
    if (!fixture) throw new SandboxError("this datasource has no frozen fixture to rebuild from");

    const shape = await storedShape(datasourceId, ds.schemaAllowlist ?? ["public"]);
    const dbName = sandboxDbName(datasourceId);
    const staging = stagingDbName(dbName);
    // Staging here too — a rebuild that fails half way through must not be the
    // reason a working sandbox stops working. `ddlSql` is replayed from the
    // fixture rather than re-derived: the shape it was written for is the shape
    // it must be loaded into, even if the source has since drifted.
    await recreateDatabase(staging);
    let report: TaxonomyReport;
    try {
      report = await withClient(ownerDsn(staging), async (c) => {
        await c.query(fixture.ddlSql);
        await loadFixture(c, shape, fixture.rowsJson);
        const problems = await ensureSandboxRole(c, staging, datasourceId, shape.schemas);
        if (problems.length) throw new SandboxError("the sandbox role is not read-only", problems);
        return verifyTaxonomy(c, shape);
      });
    } catch (e) {
      await dropStaging(dbName);
      throw e;
    }
    await promote(dbName);

    /**
     * ── ⚠ REGISTER WHAT WAS JUST PROMOTED. WITHOUT THIS, REBUILD IS A NO-OP ──
     *
     * `rematerialise` built the database, loaded the frozen rows, created the
     * read-only role, verified the taxonomy, promoted it — and wrote **nothing
     * back to the datasource row**. `hasSandbox` is `!!ds.sandboxDsnEnc &&
     * !!fixture`, so the product went on reporting *"no sandbox is provisioned"*
     * over a sandbox that was sitting there, fully built, one line away.
     *
     * ⚠ **It broke the ONE recovery path the CLI documents.** `teardown` sets
     * `sandboxDsnEnc`, `sandboxDbName` and `sandboxFixtureVersion` to null and
     * then says, in its own success message, *"the frozen fixture is KEPT —
     * `sandbox:rebuild` restores it without asking a model again."* It did not.
     * Teardown forgot the pointer, rebuild never wrote one, and the pair left a
     * datasource permanently at *fixture present, no DSN* — which is exactly the
     * state four datasources on this deployment were found in on 2026-09-17.
     *
     * ⚠ **And that state is a DEAD END from the product**, which is what made it
     * worth chasing rather than tidying: `provisionIfAbsent` refuses a
     * datasource that already has a fixture (`already_has_fixture` is the whole
     * of its "purely additive" argument), so the automatic path can never retry,
     * and the panel's only advice is a terminal command. A green `✓ rebuilt`
     * over a sandbox nothing can use is the worst shape a CLI has — I-38 from
     * the far end, where the control reports success and does nothing.
     *
     * The three fields are the same three `provision` writes, deliberately: one
     * definition of "this datasource now has a sandbox" (D-197). `version` comes
     * from the fixture being replayed, never from a counter — a rebuild restores
     * a fixture, it does not mint a new one.
     */
    await db
      .update(datasources)
      .set({
        sandboxDsnEnc: encrypt(storedRoDsn(dbName, datasourceId)),
        sandboxDbName: dbName,
        sandboxFixtureVersion: fixture.version,
        /**
         * ⚠ The stale verdict is cleared too. `sandboxBuildStatus` records how
         * the last build went, and a build has just succeeded — leaving `failed`
         * and its reason in place would be a lie waiting for a trigger: the
         * panel hides that block while `hasSandbox` is true, so it would sit
         * there invisibly and reappear, months out of date, the next time
         * somebody ran `teardown`.
         */
        sandboxBuildStatus: "ready",
        sandboxBuildError: null,
        updatedAt: new Date(),
      })
      .where(eq(datasources.id, datasourceId));

    return report;
  },

  /** Drop the sandbox and forget the DSN. The frozen fixture SURVIVES — it is the record. */
  async teardown(workspaceId: string, datasourceId: string): Promise<void> {
    const dbName = sandboxDbName(datasourceId);
    await db
      .update(datasources)
      .set({ sandboxDsnEnc: null, sandboxDbName: null, sandboxFixtureVersion: null })
      .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)));
    if (!dbName.startsWith(config.sandbox.dbPrefix)) return;
    await withClient(adminDsn(), async (c) => {
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
    });
  },
};
