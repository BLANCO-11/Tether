/**
 * The development sandbox, verified against the running engine.
 *
 *   pnpm --filter @foundry/server kestra:sandbox
 *   pnpm --filter @foundry/server kestra:sandbox --authored   (skip the model)
 *
 * ── The exit criterion, and how it is asserted ───────────────────────────────
 *
 * *"A draft run provably reads the sandbox and a live run provably reads
 * production, asserted from the executed SQL rather than from configuration."*
 *
 * So the named query under test is:
 *
 *   SELECT current_database() AS db, current_user AS who, count(*)::int AS n FROM employees
 *
 * `current_database()` and `current_user` are answered by the connection that
 * actually ran the statement. They cannot be produced by a configuration read, a
 * flag, or by this harness — the value travels back through Kestra, through the
 * step callback, into the execution's output, and is read from the run view the
 * UI reads. Two arms of the same flow, same SQL, different answers.
 *
 * ── Every block below is paired with what makes it discriminating ────────────
 *
 * Block 1 runs the flow BEFORE a sandbox exists, so block 3's `sandbox` answer
 * is a change caused by provisioning rather than a property the flow always had.
 * Block 4 is the live arm, and it is also the control for block 3: if both arms
 * named the same database the assertion would pass vacuously, so the harness
 * compares them and says so. Block 5 is the taxonomy's negative control — a
 * deliberately bland fixture that must be REFUSED, and which reports
 * INCONCLUSIVE and fails if it is accepted, because a check that cannot fail is
 * worse than none (I-38, and the trap `backup-verify.sh` was caught by).
 *
 * ── What this harness must NEVER be read as proving ──────────────────────────
 *
 * That a flow which passes against fixtures is correct against production. It is
 * not, and the reason is measured: `hr_demo` stores attendance 0–100 and
 * `hr_demo_alt` as a 0–1 fraction, and the swap rehearsal found three real bugs
 * on its first run. Gate 1 still requires a supervised real run before arming.
 */
import crypto from "node:crypto";
import pg from "pg";
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { datasourceFixtures, datasources, schemas as schemasTable } from "../db/schema.js";
import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceService } from "../services/workspace.service.js";
import { datasourceService } from "../services/datasource.service.js";
import { datasourceQueryService } from "../services/datasource-query.service.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { schemaIntrospectorService } from "../services/schema-introspector.service.js";
import { flowService } from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { inference } from "../services/inference.service.js";
import { SandboxError, sandboxService, sandboxDbName, sandboxRoleName } from "../services/sandbox.service.js";
import { decrypt } from "../utils/encryptor.js";
import { hrDbUrlForScripts, hrRoDbUrl } from "../demo/seed-hr-db.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import type { FixtureRows } from "../services/sandbox-fixture.service.js";
import { systemAuthor } from "../services/revision-author.js";

const AUTHORED_ONLY = process.argv.includes("--authored");

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const pass = String(got) === String(want);
  if (!pass) failures++;
  console.log(
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(56)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}
function checkThat(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(56)} ${c.dim(detail)}`);
}
function note(label: string, detail = "") {
  console.log(`  ${c.warn("NOTE")}  ${label.padEnd(56)} ${c.dim(detail)}`);
}

const WS_NAME = "Sandbox (dev-data rehearsal)";
const DS_NAME = "hr_demo";
const QUERY = "where_am_i";
const FLOW_ID = "sandbox-witness";
const AUTHOR = systemAuthor("sandbox-verify@acme-hr.example");
const APPROVER = "sandbox-approver@acme-hr.example";

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
async function waitFor(executionId: string, timeoutMs = 120_000): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline && !SETTLED.includes(ex.state.current)) {
    await new Promise((r) => setTimeout(r, 1200));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

/**
 * The witness flow: one `datasource` step, one `transform` that projects the
 * answer. No tools, no agent — every additional step is another way for this to
 * fail for a reason that is not the one under test.
 */
const witnessFlow: FlowModel = {
  id: FLOW_ID,
  steps: [
    {
      id: "ask",
      kind: "datasource",
      ref: `${DS_NAME}.${QUERY}`,
      paramsExpr: "[{}]",
    },
    {
      id: "report",
      kind: "transform",
      expr: "{{ json(outputs.ask.body).results[0].data | jq('.[0].db') | first }}",
      dependsOn: ["ask"],
    },
  ],
};

/** What the executed SQL said, read back through the run view the UI reads. */
async function witnessOf(
  workspaceId: string,
  kestraExecutionId: string,
): Promise<{ db: string | null; who: string | null; n: number | null; readFrom: string | null }> {
  // ⚠ Resolved through the repo, because the READ SURFACE deliberately does not
  // publish `kestraExecutionId` (R5) — an execution is addressed by its Foundry
  // id, and there is nothing in the list a client could use to point at Kestra.
  // A server-side harness may hold the join key; `e2e:ui` is the one that may not.
  const row = await flowExecutionRepo.getByKestraId(kestraExecutionId);
  if (!row || row.workspaceId !== workspaceId) {
    return { db: null, who: null, n: null, readFrom: null };
  }
  const view = await flowVisibilityService.get(workspaceId, row.id);
  const ask = view?.steps.find((s) => s.stepId === "ask");
  const body = ask?.output?.body;
  let db_: string | null = null;
  let who: string | null = null;
  let n: number | null = null;
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    const first = (parsed as { results?: Array<{ data?: Array<Record<string, unknown>> }> })
      ?.results?.[0]?.data?.[0];
    db_ = (first?.db as string) ?? null;
    who = (first?.who as string) ?? null;
    n = typeof first?.n === "number" ? first.n : null;
  } catch {
    /* reported as nulls — a witness that cannot be read is a failure, not a pass */
  }
  return { db: db_, who, n, readFrom: ask?.readFrom ?? null };
}

/**
 * A deliberately BLAND fixture — the negative control for the taxonomy.
 *
 * Every value is ASCII, no NULLs, every id referenced, one calendar month,
 * everything distinct, integers a whole unit apart. It is *valid* data: it loads
 * cleanly, satisfies every constraint, and would run a flow green. It is also
 * worthless to test against, and the taxonomy has to be able to say so.
 */
type HarnessTable = {
  key: string;
  columns: Array<{
    name: string;
    kind: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    references: string | null;
    maxLength: number | null;
  }>;
};

/**
 * A text value that FITS.
 *
 * `attendance_monthly.period` is `character(7)`, and the first version of this
 * harness wrote "Value 10" into it — eight characters, refused at row 10 of the
 * first table. Worth keeping as a comment because it is the model generator's
 * most likely real failure too, and it is why `loadFixture` names the table and
 * the row rather than letting `pg`'s message stand on its own.
 */
function blandText(i: number, maxLength: number | null): string {
  if (maxLength != null && maxLength < 12) return String(i).padStart(3, "0");
  return `Value ${i}`;
}

function blandFixture(tables: HarnessTable[]): FixtureRows {
  const out: FixtureRows = {};
  const pkValues = new Map<string, unknown[]>();
  for (const t of tables) {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 10; i++) {
      const row: Record<string, unknown> = {};
      for (const col of t.columns) {
        if (col.references) {
          const parent = pkValues.get(col.references);
          row[col.name] = parent?.length ? parent[(i - 1) % parent.length] : i;
          continue;
        }
        switch (col.kind) {
          case "int":
            row[col.name] = i;
            break;
          case "decimal":
            row[col.name] = i;
            break;
          case "bool":
            row[col.name] = i % 2 === 0;
            break;
          case "date":
            row[col.name] = `2026-06-0${(i % 9) + 1}`;
            break;
          case "timestamp":
            row[col.name] = `2026-06-0${(i % 9) + 1} 09:00:00`;
            break;
          case "time":
            row[col.name] = "09:00:00";
            break;
          case "uuid":
            row[col.name] = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
            break;
          case "json":
            row[col.name] = {};
            break;
          case "array":
            row[col.name] = [];
            break;
          default:
            row[col.name] = blandText(i, col.maxLength);
        }
      }
      rows.push(row);
    }
    out[t.key] = rows;
    for (const col of t.columns) {
      if (col.isPrimaryKey) {
        pkValues.set(`${t.key.split(".").pop()}.${col.name}`, rows.map((r) => r[col.name]));
      }
    }
  }
  return out;
}

/**
 * A RICH authored fixture — the bland one plus, per taxonomy item, the one edit
 * that satisfies it.
 *
 * Used only when the model's fixture fails, so the structural blocks can still
 * run. It is labelled `authored` in the database and the harness says so on
 * screen: an authored fixture proves the sandbox mechanism, and proves nothing
 * about whether a model can write one.
 */
function enrich(bland: FixtureRows, tables: HarnessTable[]): FixtureRows {
  const out: FixtureRows = JSON.parse(JSON.stringify(bland));
  for (const t of tables) {
    const rows = out[t.key]!;
    const free = (cc: HarnessTable["columns"][number]) => !cc.isPrimaryKey && !cc.references;
    // A DECIMAL column first: the boundary case wants a fraction, and 49.6 into
    // an `integer` is not a rounding — `pg` sends the literal and Postgres
    // refuses it.
    const numeric =
      t.columns.find((cc) => cc.kind === "decimal" && free(cc)) ??
      t.columns.find((cc) => cc.kind === "int" && free(cc));
    // Only a column long enough to hold a name. `period char(7)` is a text
    // column and is not one.
    const text = t.columns.find(
      (cc) => cc.kind === "text" && free(cc) && (cc.maxLength === null || cc.maxLength >= 24),
    );
    const nullable = t.columns.find((cc) => cc.nullable && free(cc));
    const dated = t.columns.find((cc) => cc.kind === "date" || cc.kind === "timestamp");
    // near_threshold: two values a hair either side of a round number, on a
    // column whose range makes 10 the step.
    if (numeric) {
      for (let i = 0; i < rows.length; i++) rows[i]![numeric.name] = i * 10;
      rows[0]![numeric.name] = numeric.kind === "decimal" ? 49.6 : 49;
      rows[1]![numeric.name] = numeric.kind === "decimal" ? 50.2 : 50;
    }
    // unicode_text + duplicate: distinct accented names, with exactly one collision.
    if (text) {
      const names = ["Zoë Ashford", "Íñigo Barros", "Chloé Danvers", "Søren Ek", "Márta Fehér",
        "Günther Holm", "Aoife Ivers", "Renée Jarvis", "Kwabena Lartey", "Émile Nyström"];
      rows.forEach((r, i) => (r[text.name] = names[i % names.length]));
      if (rows.length > 1) rows[rows.length - 1]![text.name] = rows[0]![text.name];
    }
    // null_in_optional: present in most rows, absent in one.
    if (nullable && nullable.name !== text?.name) rows[2]![nullable.name] = null;
    // date_span: two months, with rows strictly inside the range.
    if (dated) {
      const suffix = dated.kind === "timestamp" ? " 09:00:00" : "";
      rows.forEach((r, i) => (r[dated.name] = `2026-0${i < 5 ? 5 : 6}-${String((i % 20) + 5).padStart(2, "0")}${suffix}`));
    }
  }
  // empty_group: strip every reference to the LAST parent row of each table
  // that has children, so at least one parent has none.
  for (const child of tables) {
    for (const col of child.columns) {
      if (!col.references) continue;
      const [parentName] = col.references.split(".");
      const parentKey = Object.keys(out).find((k) => k.split(".").pop() === parentName);
      if (!parentKey) continue;
      const parentRows = out[parentKey]!;
      if (parentRows.length < 2) continue;
      const orphaned = parentRows[parentRows.length - 1]![col.references.split(".")[1]!];
      const fallback = parentRows[0]![col.references.split(".")[1]!];
      for (const r of out[child.key]!) if (r[col.name] === orphaned) r[col.name] = fallback;
    }
  }
  return out;
}

async function main() {
  console.log(`\n${"═".repeat(74)}\nThe development sandbox\n${"═".repeat(74)}`);

  // ── 0. the subject ────────────────────────────────────────────────────────
  //
  // Its own workspace, `kind: "fixture"`, for a reason worth stating: provisioning
  // a sandbox on HR or Finance would change what `demo:verify`, `showcase:verify`
  // and `scenarios:verify` measure, because every one of them scores a DRAFT run
  // against an oracle computed from the real dataset. Turning fixtures on under
  // them would make them fail for a correct reason, which is the fastest way to
  // get a control switched off.
  console.log(`\n${"─".repeat(74)}\n0  the subject\n`);
  let ws = (await workspaceRepo.list()).find((w) => w.name === WS_NAME);
  if (!ws) {
    const created = await workspaceService.create({
      name: WS_NAME,
      description: "Stage 4 harness — not a tenant",
    });
    await workspaceRepo.update(created.id, { kind: "fixture" });
    ws = (await workspaceRepo.list()).find((w) => w.id === created.id)!;
    console.log(c.dim(`  created workspace ${ws.id}`));
  }
  check("the harness workspace is marked a fixture", ws.kind, "fixture");

  const existingDs = (await datasourceRepo.listByWorkspace(ws.id)).find((d) => d.name === DS_NAME);
  const dsId = existingDs
    ? (await datasourceService.update(
        ws.id,
        existingDs.id,
        { connectionString: hrDbUrlForScripts() },
        { verifyVia: hrRoDbUrl() },
      ))!.id
    : (
        await datasourceService.create(
          ws.id,
          { name: DS_NAME, type: "postgres", connectionString: hrDbUrlForScripts() },
          // ⚠ D-44: the gate dials from THIS process, and `host.docker.internal`
          // does not resolve on a Linux host. Same credential, host and port only.
          { verifyVia: hrRoDbUrl() },
        )
      ).id;
  await schemaIntrospectorService.refresh(dsId, "postgres", hrRoDbUrl(), { schemas: ["public"] });
  const stored = await schemaIntrospectorService.getStored(dsId);
  console.log(c.dim(`  datasource ${dsId} — ${stored.length} entities introspected from hr_demo`));

  if (!(await datasourceQueryRepo.listByDatasource(dsId)).some((q) => q.name === QUERY)) {
    await datasourceQueryService.create(ws.id, dsId, {
      name: QUERY,
      description:
        "Which database and which role actually served this step. The answer comes from the " +
        "connection that ran the statement, so it cannot be produced by reading configuration.",
      sqlText: "SELECT current_database() AS db, current_user AS who, count(*)::int AS n FROM employees",
      paramOrder: [],
      paramsSchema: {},
    });
  }

  const stale = await flowRepo.getByKestraFlowId(ws.id, FLOW_ID);
  if (stale) await flowService.remove(ws.id, stale.id);
  const { flow } = await flowService.create(ws.id, {
    name: "sandbox witness",
    model: witnessFlow,
    author: AUTHOR,
  });
  console.log(c.dim(`  flow ${flow.id} deployed to the draft namespace`));

  // Start from no sandbox, whatever a previous run left behind — block 1's whole
  // job is to observe the BEFORE state, and inheriting a sandbox would make it
  // pass by accident.
  await sandboxService.teardown(ws.id, dsId);
  await db.delete(datasourceFixtures).where(eq(datasourceFixtures.datasourceId, dsId));

  // ── 1. before: a draft run reads production, and says so ──────────────────
  console.log(`\n${"─".repeat(74)}\n1  with no sandbox, a DRAFT run reads production — and reports it\n`);

  const before = await sandboxService.status(ws.id, dsId);
  checkThat("status reports no sandbox", before?.hasSandbox === false);
  checkThat(
    "…and names the exposure rather than staying silent",
    !!before?.exposure && /DRAFT.*reads PRODUCTION/s.test(before.exposure),
    before?.exposure?.slice(0, 60) ?? "",
  );

  const run1 = await flowService.testRun(ws.id, flow.id, {});
  const ex1 = await waitFor(run1.kestraExecutionId);
  check("the draft run succeeds", ex1.state.current, "SUCCESS");
  const w1 = await witnessOf(ws.id, run1.kestraExecutionId);
  check("the executed SQL names the tenant's database", w1.db, "hr_demo");
  check("the step records what it read", w1.readFrom, "production");
  console.log(c.dim(`        connected as ${w1.who}, ${w1.n} employees`));

  // ── 2. the fixture ────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n2  a fixture written from the SCHEMA ONLY, and verified before it is frozen\n`);

  let generatedBy = "model";
  let taxonomy: Awaited<ReturnType<typeof sandboxService.provision>>["taxonomy"] | null = null;
  let shapeTables: HarnessTable[] = [];

  // The shape is derived first so the authored fallbacks can be built against it.
  {
    const { deriveShape } = await import("../services/sandbox-ddl.service.js");
    const shape = deriveShape(stored as never, { allowlist: ["public"] });
    shapeTables = shape.tables.map((t) => ({
      key: t.key,
      columns: t.columns.map((cc) => ({
        name: cc.name,
        kind: cc.kind,
        nullable: cc.nullable,
        isPrimaryKey: cc.isPrimaryKey,
        references: cc.references,
        maxLength: cc.maxLength,
      })),
    }));
    checkThat("every column of hr_demo has a sandbox equivalent", shape.unsupported.length === 0, shape.unsupported.join("; "));
    for (const n of shape.notes) note("shape note", n);
  }

  if (!AUTHORED_ONLY) {
    const t0 = Date.now();
    console.log(c.dim(`  asking ${config.inference.model || "the configured model"} for ${shapeTables.length} tables…`));
    try {
      const res = await sandboxService.provision({
        workspaceId: ws.id,
        datasourceId: dsId,
        inference,
        modelName: config.inference.model || null,
        onProgress: (m) => console.log(c.dim(`    · ${m}`)),
      });
      taxonomy = res.taxonomy;
      console.log(c.dim(`  the model's fixture passed in ${Math.round((Date.now() - t0) / 1000)}s`));
    } catch (e) {
      // A MEASUREMENT, not a failure of the mechanism. Reported with the reason
      // and the model, because "a model wrote a good fixture" is a reading on one
      // model and not a property of the design — the same framing `kestra:refusal`
      // uses for its own numbers.
      note(
        `the model's fixture was REFUSED after ${Math.round((Date.now() - t0) / 1000)}s`,
        (e as Error).message,
      );
      for (const d of ((e as SandboxError).detail as string[] | undefined) ?? []) {
        console.log(c.dim(`        - ${d}`));
      }
      generatedBy = "authored";
    }
  } else {
    generatedBy = "authored";
  }

  if (generatedBy === "authored") {
    note("falling back to an AUTHORED fixture", "the blocks below test the mechanism, not the model");
    const res = await sandboxService.provision({
      workspaceId: ws.id,
      datasourceId: dsId,
      inference,
      authoredRows: enrich(blandFixture(shapeTables), shapeTables),
    });
    taxonomy = res.taxonomy;
  }

  check("every taxonomy category was checked", taxonomy!.items.length, 7);
  checkThat("…and every one is satisfied", taxonomy!.items.every((i) => i.satisfied));
  checkThat(
    "…each with evidence naming the table, column and values",
    taxonomy!.items.every((i) => !i.satisfied || (i.evidence ?? "").length > 20),
  );
  checkThat("referential integrity holds across the fixture", taxonomy!.integrity.ok, taxonomy!.integrity.problems.join("; "));
  for (const i of taxonomy!.items) {
    console.log(`        ${i.satisfied ? c.ok("✓") : c.bad("✗")} ${i.id.padEnd(17)} ${c.dim(i.evidence ?? i.title)}`);
  }

  // ── 3. after: the same flow, the same SQL, a different database ───────────
  console.log(`\n${"─".repeat(74)}\n3  with a sandbox, the SAME draft flow reads fixtures\n`);

  const run2 = await flowService.testRun(ws.id, flow.id, {});
  const ex2 = await waitFor(run2.kestraExecutionId);
  check("the draft run succeeds", ex2.state.current, "SUCCESS");
  const w2 = await witnessOf(ws.id, run2.kestraExecutionId);
  check("the executed SQL names the SANDBOX database", w2.db, sandboxDbName(dsId));
  check("…and the sandbox's own read-only role", w2.who, sandboxRoleName(dsId));
  check("the step records what it read", w2.readFrom, "sandbox");
  checkThat(
    "…and the row count is the fixture's, not production's",
    w2.n !== null && w2.n !== w1.n,
    `${w2.n} rows in the sandbox vs ${w1.n} in hr_demo`,
  );

  // ── 4. live: approved, and reading production again ───────────────────────
  console.log(`\n${"─".repeat(74)}\n4  a LIVE run reads production — the control that makes block 3 mean something\n`);

  const approved = await flowApprovalService.approve(ws.id, flow.id, {
    revision: flow.draftRevision,
    approverUserId: APPROVER,
    approverKind: "client_admin",
    note: "sandbox-verify",
  });
  check("gate 1 was satisfied by the draft runs, so approval succeeds", approved.flow.armedRevision, flow.draftRevision);

  const ns = await flowService.namespaces(ws.id);
  const liveStart = await kestra.startExecution(ns.live, FLOW_ID, {}, {
    foundry_flow: flow.id,
    foundry_revision: String(flow.draftRevision),
    foundry_env: "live",
  });
  const ex3 = await waitFor(liveStart.id);
  check("the live run succeeds", ex3.state.current, "SUCCESS");
  const w3 = await witnessOf(ws.id, liveStart.id);
  check("the executed SQL names the tenant's database", w3.db, "hr_demo");
  check("the step records what it read", w3.readFrom, "production");
  checkThat(
    "the two arms are DISCRIMINATED — same flow, same SQL, different database",
    !!w2.db && !!w3.db && w2.db !== w3.db,
    `draft → ${w2.db} · live → ${w3.db}`,
  );

  await flowApprovalService.revoke(ws.id, flow.id, { revokedBy: APPROVER, reason: "harness cleanup" });

  // ── 5. the negative control ───────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n5  NEGATIVE CONTROL — a bland fixture must be REFUSED\n`);

  const sandboxDsn = decrypt(
    (await db.select().from(datasources).where(eq(datasources.id, dsId)).limit(1))[0]!.sandboxDsnEnc!,
  );
  // Dialled from THIS process, so the stored container-facing host is swapped
  // for the one a host process can reach — D-44's split, used deliberately.
  const localDsn = sandboxDsn.replace(
    `${config.sandbox.dbHost}:${config.sandbox.dbPort}`,
    new URL(config.databaseUrl).host,
  );

  /** A content hash of every row in the sandbox, order-independent. */
  async function digest(): Promise<string> {
    const client = new pg.Client({ connectionString: localDsn });
    await client.connect();
    try {
      const parts: string[] = [];
      for (const t of shapeTables) {
        const cols = t.columns.map((x) => `coalesce("${x.name}"::text, '~')`).join(" || '|' || ");
        const r = await client.query(
          `SELECT coalesce(string_agg(row_text, E'\\n' ORDER BY row_text), '') AS d
             FROM (SELECT ${cols} AS row_text FROM "${t.key.split(".").pop()}") s`,
        );
        parts.push(`${t.key}\n${(r.rows[0] as { d: string }).d}`);
      }
      return crypto.createHash("sha256").update(parts.join("\n--\n")).digest("hex").slice(0, 16);
    } finally {
      await client.end().catch(() => {});
    }
  }

  const digestBeforeControl = await digest();

  let refusedWith: string[] | null = null;
  try {
    await sandboxService.provision({
      workspaceId: ws.id,
      datasourceId: dsId,
      inference,
      authoredRows: blandFixture(shapeTables),
    });
  } catch (e) {
    refusedWith = ((e as SandboxError).detail as string[] | undefined) ?? [(e as Error).message];
  }
  if (refusedWith === null) {
    // The `backup-verify` lesson, applied: a control that did not fire has told
    // us nothing, and reporting the other assertions as green would be reporting
    // a verification that did not happen.
    failures++;
    console.log(
      `  ${c.bad("INCONCLUSIVE")}  the bland fixture was ACCEPTED — the taxonomy is not discriminating`,
    );
  } else {
    console.log(`  ${c.ok("FIRED")}  the bland fixture was refused, missing:`);
    for (const d of refusedWith) console.log(c.dim(`        - ${d}`));
    checkThat(
      "…for at least three separate categories, not one lucky one",
      refusedWith.length >= 3,
      `${refusedWith.length} categories`,
    );
  }

  // The refusal must not have replaced the good fixture — a failed provision has
  // to leave the previous state intact, or a bad regeneration takes the sandbox
  // down with it.
  const afterControl = await sandboxService.status(ws.id, dsId);
  checkThat("a refused provision leaves the sandbox POINTER intact", afterControl?.hasSandbox === true);
  // ⚠ The assertion that found the real defect. The first version checked only
  // the pointer, and the pointer was fine — the DATA had already been replaced
  // by the bland rows before the taxonomy check could refuse them. Provisioning
  // builds in a staging database and promotes now; this is what proves it.
  check("…and the ROWS a draft run reads are untouched", await digest(), digestBeforeControl);

  // ── 6. the freeze ─────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n6  the fixture is FROZEN — the database rebuilds from it, byte for byte\n`);

  const before6 = await digest();
  await sandboxService.rematerialise(ws.id, dsId);
  const after6 = await digest();
  check("the rebuilt sandbox is identical to the frozen fixture", after6, before6);

  const frozen = (
    await db
      .select()
      .from(datasourceFixtures)
      .where(eq(datasourceFixtures.datasourceId, dsId))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1)
  )[0]!;
  checkThat(
    "the frozen rows live in foundry_parent, so a backup carries them",
    Object.keys(frozen.rowsJson).length === shapeTables.length,
    `${Object.keys(frozen.rowsJson).length} tables`,
  );
  check("it records who wrote it", frozen.generatedBy, generatedBy === "model" ? "model" : "authored");

  // ── 7. schema drift ───────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n7  drift — a source schema that moved makes the sandbox the wrong shape\n`);

  check("no drift while the source is unchanged", (await sandboxService.status(ws.id, dsId))?.drift, null);

  // A real perturbation: one extra column on the SOURCE's stored schema. The
  // fixture cannot possibly have it, which is exactly the state a sandbox must
  // not report as healthy.
  const [planted] = await db
    .insert(schemasTable)
    .values({
      datasourceId: dsId,
      entityType: "table",
      entityName: "employees",
      entitySchema: "public",
      columnName: "drift_probe",
      columnType: "text",
      nullable: true,
    })
    .returning({ id: schemasTable.id });
  const drifted = await sandboxService.status(ws.id, dsId);
  checkThat(
    "a new source column is reported as DRIFT",
    !!drifted?.drift && drifted.drift.was !== drifted.drift.now,
    drifted?.drift ? `${drifted.drift.was} → ${drifted.drift.now}` : "not detected",
  );
  await db.delete(schemasTable).where(eq(schemasTable.id, planted!.id));
  check("…and it clears when the source goes back", (await sandboxService.status(ws.id, dsId))?.drift, null);

  // ── 8. the sandbox credential is read-only ────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n8  the credential a draft run holds cannot write\n`);

  const roClient = new pg.Client({ connectionString: localDsn });
  await roClient.connect();
  let wrote = false;
  let refusal = "";
  try {
    // `SET` first, exactly as `hr-roles.test.ts` does: the control has to be the
    // ABSENT GRANT, not `default_transaction_read_only`, which a session can turn
    // off for itself.
    // ⚠ `SET SESSION default_transaction_read_only`, not `SET
    // transaction_read_only`. The latter applies to the CURRENT transaction, and
    // `pg` autocommits each statement — so the flag was back on by the time the
    // UPDATE ran, and the refusal came from the session default rather than from
    // the grant. The assertion caught it, which is the point of asserting the
    // REASON as well as the refusal.
    await roClient.query("SET SESSION default_transaction_read_only = off");
    // A no-op UPDATE: privilege is checked before the row filter, so this asks
    // exactly "may this role write" without depending on which columns the
    // tenant's table happens to have or which of them are NOT NULL.
    await roClient.query(`UPDATE "${shapeTables[0]!.key.split(".").pop()}" SET ` +
      `"${shapeTables[0]!.columns[0]!.name}" = "${shapeTables[0]!.columns[0]!.name}" WHERE false`);
    wrote = true;
  } catch (e) {
    refusal = (e as Error).message;
  } finally {
    await roClient.end().catch(() => {});
  }
  checkThat("a write through the sandbox DSN is refused", !wrote, refusal.slice(0, 70));
  checkThat(
    "…by an absent privilege, not by the session flag it just turned off",
    /permission denied|insufficient/i.test(refusal),
    refusal.slice(0, 70),
  );

  // ── the ledger ────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(74)}`);
  console.log(
    failures === 0
      ? c.ok(`✓ the sandbox holds — fixture written by ${generatedBy}`)
      : c.bad(`✗ ${failures} assertion(s) failed`),
  );
  if (generatedBy === "authored" && !AUTHORED_ONLY) {
    console.log(
      c.warn(
        "⚠ the MODEL's fixture did not pass the taxonomy, so the mechanism above was proven with " +
          "an authored one. That is a reading on one model, not a defect in the design — and it " +
          "is the honest reason the taxonomy exists.",
      ),
    );
  }
  console.log(`${"═".repeat(74)}\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
