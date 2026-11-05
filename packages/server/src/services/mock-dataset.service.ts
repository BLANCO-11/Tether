/**
 * Mock dataset builder — deterministic synthetic rows on datasource onboarding.
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * Onboarding (`refreshSchema`, every seeder) ends with a fixtures row plus a
 * JSON file: 10 deterministic rows per table, FK-coherent, generated from the
 * STORED introspection shape. The model NEVER sees real rows — drafts are drawn
 * from schemas alone — and generation never SELECTs a production ROW.
 *
 * ⚠ **One narrow exception since 2026-09-24 (D-268, I-230):** a free-text column
 * that is a CATEGORY (few distinct values, each repeated, not named like
 * anything identifying) takes its values from the real column's DISTINCT set,
 * and values the workspace already wrote down (named-query literals, literals
 * flows bind to an operation's filter) are added. See `mock-value-hints.ts` for
 * the bounds, and `taxonomyJson.valueHints` on the fixture row for what a given
 * build used. Without it a draft run filtering `status = 'active'` read 0 rows.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 * Not the sandbox (`sandbox.service.ts` + `sandbox-autoprovision.service.ts`):
 * that path asks a model for rows (minutes, async, LLM-taxonomy verified) and
 * stays exactly as it is. This path is seeded-RNG per datatype (milliseconds,
 * awaited in seeders, fire-and-forget in the wizard route), with no taxonomy
 * gate — taxonomy reconciliation happens in Verification, not in slices. The
 * hook name is deliberately NOT `provisionIfAbsent`, so
 * `sandbox-autoprovision-seeders.test.ts` keeps pinning the sandbox asymmetry
 * it was written for.
 *
 * ── Shape source ─────────────────────────────────────────────────────────────
 * Stored introspection via `schemaIntrospectorService.getStored` + re-derived
 * `deriveShape` — the private `storedShape` in `sandbox.service.ts` is NOT
 * imported, and `SafeDataStudio` (a client toy) is NOT ported. FK order comes
 * from `topoOrder` in `sandbox-fixture.service.ts`.
 *
 * ── Readiness ────────────────────────────────────────────────────────────────
 * Lives on the fixtures row (`mock_status building|ready|failed` + `mock_error`,
 * migration 0062, SliceA-owned). NULL-vs-failed follows the sandbox discipline:
 * no row is "nobody asked"; `failed` names why. Guards mirror
 * `provisionIfAbsent` — non-postgres, no schema, unsupported shape all land as
 * loud `failed` rows, never silent skips. `already_has_fixture` keeps the build
 * purely additive (re-provisioning stays a rebuild command).
 *
 * ⚠ **THAT LIST READ ">25 TABLES" UNTIL 2026-09-17 AND NO LONGER DOES.** The
 * table ceiling is gone; a schema of any width builds automatically, bounded
 * only by `MOCK_ROWS_PER_TABLE`. (It briefly said "bounded instead by
 * MAX_MOCK_COLUMNS_PER_TABLE" — that cap existed for hours and is deleted; the
 * note at the constant says why.) The reasoning and the measured
 * failure that removed it are at the constant below — read it before adding any
 * table-count refusal back, because the refusal it replaced took every draft run
 * on that datasource down with it.
 *
 * ── Files ────────────────────────────────────────────────────────────────────
 * The JSON file is a derived projection built FROM `rows_json` (fingerprint in
 * the envelope, mismatch fails closed). `update()` credential/allowlist edits
 * rebuild-or-invalidate via `rebuildMockDataset`; `test()` stays a dial-only
 * check and is never hooked.
 */

import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { supportsMockType } from "./mock-engine/registry.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  datasourceFixtures,
  datasourceOperations,
  datasourceQueries,
  datasources,
  flowRevisions,
  flows,
} from "../db/schema.js";
import { decryptDsnIfPresent } from "../repositories/datasource.repo.js";
import {
  authoredLiteralsFromFlows,
  authoredLiteralsFromSql,
  dateRangeFor,
  EMPTY_HINTS,
  hintFor,
  mergeHints,
  nameWords,
  numberRangeFor,
  postgresSampler,
  readRangeHints,
  sqliteSampler,
  domainCategories,
  withFallbackRange,
  type DateRange,
  type NumberRange,
  type ValueHints,
} from "./mock-value-hints.js";
import { isSqliteType } from "./sqlite-file.service.js";
import { schemaIntrospectorService } from "./schema-introspector.service.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import type { IntrospectedEntity } from "./introspect/types.js";
import {
  deriveShape,
  renderDdl,
  type SandboxColumn,
  type SandboxShape,
  type SandboxTable,
} from "./sandbox-ddl.service.js";
import { topoOrder } from "./sandbox-fixture.service.js";
import { applyLinks, countsSql, inferLinks, profileShape, weightByFrequency, type InferredLink } from "./mock-links.js";
import {
  deleteMockFile,
  readMockFile,
  writeMockFile,
  type MockFileTable,
} from "./mock-file-store.js";

/** Rows per table — fixed. Taxonomy reconciliation happens in Verification. */
export const MOCK_ROWS_PER_TABLE = 10;

/**
 * ⚠ **THE TABLE CEILING IS GONE — 2026-09-17.** `MAX_MOCK_TABLES = 25` stood
 * here, and its reasoning is kept verbatim rather than deleted, because it names
 * what was traded away:
 *
 *   > Automatic-build table ceiling. Same value as the sandbox's
 *   > `MAX_AUTO_TABLES`: a mock covering some of a schema is a test that reads
 *   > as empty, so a big schema refuses and is rebuilt deliberately from the CLI.
 *
 * What removed it is the measured consequence of that refusal, not a
 * disagreement with it. A real 46-table datasource onboarded and was refused
 * with *"an automatic mock build is capped at 25 — rebuild it deliberately once
 * the shape is narrowed"*; every draft run against it then refused too. So the
 * cap did not produce a deliberate rebuild, it produced a datasource nobody
 * could test at all — and "the shape is narrowed" is not an action a person
 * onboarding somebody else's database can take. A partial mock that RUNS is
 * worth more than a whole mock that never exists, and a missing column is
 * visible in the stored DDL and the mock file where a refused build was visible
 * nowhere.
 *
 * ⚠ **The sandbox's `MAX_AUTO_TABLES` is UNCHANGED and must stay that way.**
 * That path costs ONE MODEL CALL PER TABLE, so its ceiling is a spend bound; this
 * path is seeded RNG at milliseconds per table, so its bound is per-table width
 * instead. The two numbers are no longer "the same value", and the sentence above
 * that said they were is exactly why this note replaces the constant rather than
 * the constant simply disappearing.
 */

/**
 * ⚠ **`MAX_MOCK_COLUMNS_PER_TABLE = 5` STOOD HERE AND IS DELETED — 2026-09-17.**
 * Kept as a note rather than removed silently, because it shipped, it broke
 * draft runs on a real tenant, and the reason it was wrong is worth one reading.
 *
 * It was introduced as the per-table WIDTH bound that replaced the table ceiling
 * above, and it selected columns by primary key, then foreign key, then
 * declaration order. The selection rule was sound; capping columns at all was
 * not.
 *
 * ⚠ **A MOCK THAT DROPS COLUMNS IS NOT A NARROWER SCHEMA — IT IS A DIFFERENT
 * ONE.** Every query in the product is written against the introspected schema
 * and then executed, on a draft run, against this fixture. Drop a column and
 * that query does not return less; it FAILS, with `column "approvalStatus" does
 * not exist`, on a statement that is correct everywhere else. Measured on
 * execution `23S9l7tIo2VCmy5p8L2vOt`: a correctly drafted three-join read of a
 * 46-table tenant died because the mock's `offer_and_fitment` held five columns
 * — `addressDetails, allowances, applicantId, applicationId, id` — and none of
 * the eight the query named. Declaration order is arbitrary with respect to
 * usefulness, so the cap systematically kept metadata blobs and dropped every
 * business column.
 *
 * ⚠ **AND THE BOUND WAS NEVER NEEDED.** The cost argument for it is in the
 * table-ceiling note above and it refutes this cap: generation here is seeded
 * RNG at milliseconds per table, with no model call anywhere. The real bound is
 * `MOCK_ROWS_PER_TABLE`, which has always existed and is what a "cap" on mock
 * data means — rows are what a fixture has too many of, columns are what it IS.
 * The whole 46-table, 667-column fixture is 86 kB.
 *
 * ⚠ **Do not reintroduce a column cap.** If mock size ever genuinely needs
 * bounding, lower `MOCK_ROWS_PER_TABLE` or bound the table count — both leave
 * every surviving table a faithful copy of its source shape, which is the one
 * property a draft run depends on.
 */

export type FixtureRows = Record<string, Array<Record<string, unknown>>>;

export type MockBuildOutcome =
  | { started: true; version: number }
  | {
      started: false;
      why:
        | "already_has_fixture"
        | "already_building"
        | "not_postgres"
        // ⚠ "too_many_tables" was here until 2026-09-17 and is deliberately NOT
        // kept as a dead union member: a status nothing can return is a branch a
        // caller writes and never exercises. The table ceiling is gone.
        | "no_schema"
        | "unsupported_shape"
        | "build_failed";
      detail?: string;
    };

/** In-flight builds in this process, so two callers cannot start the same one. */
const mockInFlight = new Set<string>();

// ── deterministic RNG ────────────────────────────────────────────────────────
// mulberry32 + FNV-1a: small, stable across Node versions (no `crypto` float
// formatting drift), and seeded per table so adding a table never reshuffles
// another's rows.

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicUuid(rng: () => number): string {
  const hex = () =>
    Math.floor(rng() * 256)
      .toString(16)
      .padStart(2, "0");
  const b = Array.from({ length: 16 }, hex).join("");
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-4${b.slice(13, 16)}-8${b.slice(17, 20)}-${b.slice(20, 32)}`;
}

const MOCK_DATE_BASE = Date.UTC(2024, 0, 15, 8, 30, 0);

function isoDate(offsetDays: number): string {
  return new Date(MOCK_DATE_BASE + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function isoTimestamp(offsetDays: number, rng: () => number): string {
  const ms =
    MOCK_DATE_BASE +
    offsetDays * 86_400_000 +
    Math.floor(rng() * 10 * 3_600_000) +
    Math.floor(rng() * 60_000);
  return new Date(ms).toISOString();
}

function isoTime(rng: () => number): string {
  const h = String(Math.floor(rng() * 24)).padStart(2, "0");
  const m = String(Math.floor(rng() * 60)).padStart(2, "0");
  const s = String(Math.floor(rng() * 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function clampText(value: string, maxLength: number | null): string {
  if (maxLength && maxLength > 0 && value.length > maxLength) {
    return value.slice(0, Math.max(1, maxLength));
  }
  return value;
}

/** Unique-per-row primary-key value for any kind (bool/char(1) PKs with 10 rows are unrepresentable — pathological, best-effort). */
function pkValue(
  table: SandboxTable,
  col: SandboxColumn,
  index: number,
  rng: () => number,
  hints?: ValueHints,
): unknown {
  // 2026-10-10: a DATE key inside the real column's span — still one distinct day per row, which is what a key needs.
  if (col.kind === "date") {
    const span = hints?.dateRanges?.[`${table.name}.${col.name}`];
    if (span) return distinctDayIn(span, index);
  }
  switch (col.kind) {
    case "int":
      return index + 1;
    case "decimal":
      return index + 1;
    case "bool":
      return index % 2 === 0;
    case "uuid":
      return deterministicUuid(rng);
    case "date":
      return isoDate(index * 6);
    case "timestamp":
      return isoTimestamp(index * 6, rng);
    case "time":
      return `${String(8 + (index % 12)).padStart(2, "0")}:30:00`;
    case "json":
      return { id: index + 1, key: `${table.name}.${col.name}.${index + 1}` };
    case "array":
      return arrayValue(col, table, index, rng);
    case "enum":
      // Cycled, not sampled, so a key column made of an enum is as distinct as
      // the member list allows — the same best-effort bound `pkValue` already
      // states for bool and char(1) keys.
      return enumValue(col, index);
    case "text":
    default:
      return clampText(`${table.name}_${col.name}_${index + 1}`, col.maxLength);
  }
}

function scalarValue(
  table: SandboxTable,
  col: SandboxColumn,
  index: number,
  rng: () => number,
  hints?: ValueHints,
): unknown {
  // Nullable non-key columns go NULL on every 5th row — deterministic null
  // coverage that never touches PKs or FK picks (handled by the caller).
  if (col.nullable && !col.isPrimaryKey && !col.references && index % 5 === 4) return null;
  // A column of undeclared type holds no values — anything else would be a guess at what it holds.
  if (col.kind === "unknown") return null;
  // D-268: a hinted text column CYCLES its hints, as an enum cycles its members —
  // so a filter naming any one of them matches some row. The RNG is still drawn,
  // so the columns after it keep the values they had without hints.
  const hinted = col.kind === "text" ? hintFor(hints, table, col) : undefined;
  if (hinted) {
    rng();
    return hinted[columnOrder(table, col)[index]! % hinted.length]!;
  }
  // D-268 A/B: a date inside the real column's span. Same number of RNG draws
  // as the unhinted path (1 for a date, 2 for a timestamp).
  const range = dateRangeFor(hints, table, col);
  if (range) return spreadDate(range, index, rng, col.kind === "timestamp");
  // 2026-10-10: a number inside the real column's typical span (one RNG draw, as the unhinted int/decimal path).
  const span = numberRangeFor(hints, table, col);
  if (span) {
    const v = span.min + rng() * (span.max - span.min);
    return span.integer || col.kind === "int" ? Math.round(v) : Math.round(v * 100) / 100;
  }
  // A column NAMED for an address gets a reserved-domain address, never a
  // `mock_…` string a recipient check refuses (I2: "assignee is not a valid
  // address"). `.example` cannot receive mail and passes a draft run (D-267).
  if (col.kind === "text" && nameWords(col.name).some((w) => w === "email" || w === "mail")) {
    const addr = `${col.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index + 1}@mock.example`;
    if (col.maxLength === null || addr.length <= col.maxLength) {
      rng();
      return addr;
    }
  }
  switch (col.kind) {
    case "int":
      return Math.floor(rng() * 90_000) + 1_000;
    case "decimal":
      return Math.floor(rng() * 1_000_000) / 100;
    case "bool":
      return rng() < 0.5;
    case "text":
      return clampText(`mock_${col.name}_${Math.floor(rng() * 100_000)}`, col.maxLength);
    case "date":
      return isoDate(index * 6 + Math.floor(rng() * 3));
    case "timestamp":
      return isoTimestamp(index * 6, rng);
    case "time":
      return isoTime(rng);
    case "uuid":
      return deterministicUuid(rng);
    case "json":
      return { mock: `${table.name}.${col.name}.${index + 1}`, n: Math.floor(rng() * 1000) };
    case "array":
      return arrayValue(col, table, index, rng);
    case "enum":
      return enumValue(col, index);
    default:
      return clampText(`mock_${col.name}_${index + 1}`, col.maxLength);
  }
}

/**
 * A fixed shuffle of the row indices, per column. ⚠ Hints used to cycle by
 * the bare row index, which made every hinted column move IN LOCKSTEP with
 * every other one reached through the same index — attendance row i joins
 * employee i, `period` and `status` both have 3 values, so every June row
 * belonged to an `on_leave` employee and R02's "June, not on leave" read 0
 * rows (build:measure r6). A permutation keeps every value present (it
 * covers all indices) while decorrelating columns. Seeded by the column's
 * own key, so a rebuild is byte-identical.
 */
function columnOrder(table: SandboxTable, col: SandboxColumn): number[] {
  const r = mulberry32(fnv1a(`order:${table.key}.${col.name}`));
  const order = Array.from({ length: MOCK_ROWS_PER_TABLE }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Row `index` of MOCK_ROWS_PER_TABLE, spread evenly across `range` (inclusive). */
/**
 * Row `index`'s day for a date KEY: spread across the span when it holds a distinct day per row, else consecutive days
 * from its start — a key must never repeat, so uniqueness wins over staying inside a span too short to hold every row.
 */
export function distinctDayIn(range: DateRange, index: number): string {
  const lo = Date.parse(`${range.min}T00:00:00Z`);
  const days = Math.max(0, Math.round((Date.parse(`${range.max}T00:00:00Z`) - lo) / 86_400_000));
  const step = MOCK_ROWS_PER_TABLE > 1 && days >= MOCK_ROWS_PER_TABLE - 1 ? Math.floor(days / (MOCK_ROWS_PER_TABLE - 1)) : 1;
  return new Date(lo + index * step * 86_400_000).toISOString().slice(0, 10);
}

function spreadDate(range: DateRange, index: number, rng: () => number, timestamp: boolean): string {
  const lo = Date.parse(`${range.min}T00:00:00Z`);
  const span = Math.max(0, Date.parse(`${range.max}T00:00:00Z`) - lo);
  const frac = MOCK_ROWS_PER_TABLE > 1 ? index / (MOCK_ROWS_PER_TABLE - 1) : 0;
  const day = lo + Math.floor((frac * span) / 86_400_000) * 86_400_000;
  const jitter = rng();
  if (!timestamp) return new Date(day).toISOString().slice(0, 10);
  return new Date(day + Math.floor(jitter * 10 * 3_600_000) + Math.floor(rng() * 60_000)).toISOString();
}

/**
 * A value for an enum column — always one of its declared members.
 *
 * ⚠ **Cycled by row index, never sampled from the RNG.** Ten rows over a
 * three-member enum then hold every member at least three times, which is what
 * makes the fixture useful: a draft filtering `WHERE status = '<member>'`
 * matches something whichever member it names. Sampling would leave a member
 * absent perfectly often, and the symptom is a flow that reads zero rows and
 * looks broken.
 *
 * ⚠ The generator never invents a value here, which is the property the old
 * refusal protected and this preserves — the DDL carries a matching
 * `CHECK (col IN (…))`, so an invented one would not even load.
 */
function enumValue(col: SandboxColumn, index: number): string {
  const members = col.enumValues ?? [];
  // Unreachable via `mapColumn`, which only emits `kind: "enum"` with a
  // non-empty list — but a kind and its payload living in two fields is exactly
  // where a future caller gets it wrong, so this fails visibly rather than
  // returning `undefined` into a NOT NULL column.
  if (members.length === 0) throw new Error(`enum column ${col.name} has no members`);
  return members[index % members.length]!;
}

function arrayValue(
  col: SandboxColumn,
  table: SandboxTable,
  index: number,
  rng: () => number,
): unknown[] {
  const t = col.sqlType.toLowerCase();
  if (t.includes("int")) return [index + 1, index + 2];
  if (t.includes("numeric") || t.includes("double") || t.includes("real"))
    return [Math.floor(rng() * 1000) / 100 + index, Math.floor(rng() * 1000) / 100];
  if (t.includes("bool")) return [index % 2 === 0, rng() < 0.5];
  return [`${table.name}_${col.name}_a${index + 1}`, `${table.name}_${col.name}_b${index + 1}`];
}

/**
 * Split a derived shape into the tables a mock can actually be built from and
 * the ones left with nothing.
 *
 * Pure and exported so the RULE is testable rather than only greppable: the
 * decision it encodes — an unreproducible column is dropped, an empty table is
 * skipped, and only "nothing survived" refuses — is the one that changed on
 * 2026-09-17, and a source-grep asserting the string `unsupported_shape` still
 * appears would pass against either behaviour (I-38).
 */
export function partitionMockTables(shape: SandboxShape): {
  usable: SandboxShape["tables"];
  empty: SandboxShape["tables"];
} {
  return {
    usable: shape.tables.filter((t) => t.columns.length > 0),
    // A table whose every column was unreproducible cannot be created — there is
    // no `CREATE TABLE x ()` worth emitting — so it is skipped rather than
    // failing the build for the tables around it.
    empty: shape.tables.filter((t) => t.columns.length === 0),
  };
}


/**
 * Deterministic rows for a shape: parents first via `topoOrder`, FK children
 * picking `parentVals[row % parentVals.length]` so every reference resolves.
 * Pure — no DB, no fs, no clock — so tests pin it byte-identically.
 */
export function generateMockRows(shape: SandboxShape, hints?: ValueHints): FixtureRows {
  const ordered = topoOrder(shape.tables);
  const referenced = new Set(
    shape.tables.flatMap((t) =>
      t.columns.filter((c) => c.references).map((c) => c.references!),
    ),
  );
  const parentValues: Record<string, unknown[]> = {};
  const out: FixtureRows = {};

  for (const table of ordered) {
    const rng = mulberry32(fnv1a(`${shape.fingerprint}:${table.key}`));
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MOCK_ROWS_PER_TABLE; i++) {
      const row: Record<string, unknown> = {};
      for (const col of table.columns) {
        if (col.references) {
          const [parentTable, parentCol] = col.references.split(".");
          const pool = parentValues[`${parentTable}.${parentCol}`];
          if (pool && pool.length > 0) {
            row[col.name] = pool[i % pool.length];
            continue;
          }
          // Parent outside the allowlist (stated in shape.notes) or an
          // unresolved cycle: standalone value, same as a non-FK column.
          row[col.name] = col.isPrimaryKey
            ? pkValue(table, col, i, rng, hints)
            : scalarValue(table, col, i, rng, hints);
          continue;
        }
        row[col.name] = col.isPrimaryKey
          ? pkValue(table, col, i, rng, hints)
          : scalarValue(table, col, i, rng, hints);
      }
      rows.push(row);
    }
    out[table.key] = rows;

    for (const c of table.columns) {
      const ref = `${table.name}.${c.name}`;
      if (!c.isPrimaryKey && !referenced.has(ref)) continue;
      parentValues[ref] = rows
        .map((r) => r[c.name])
        .filter((v) => v !== null && v !== undefined);
    }
  }
  // Links measured from the real data, which no declaration names (`mock-links.ts`): a join on them finds rows.
  if (hints?.links?.length) applyLinks(shape, out, hints.links);
  return out;
}

// ── fixtures-row helpers (mock_status/mock_error are SliceA-owned, migration 0062) ──

async function nextVersion(datasourceId: string): Promise<number> {
  const prior = await db
    .select({ version: datasourceFixtures.version })
    .from(datasourceFixtures)
    .where(eq(datasourceFixtures.datasourceId, datasourceId))
    .orderBy(desc(datasourceFixtures.version))
    .limit(1);
  return (prior[0]?.version ?? 0) + 1;
}

async function existingVersion(datasourceId: string): Promise<number | null> {
  const rows = await db
    .select({ version: datasourceFixtures.version })
    .from(datasourceFixtures)
    .where(eq(datasourceFixtures.datasourceId, datasourceId))
    .limit(1);
  return rows[0]?.version ?? null;
}

/** Loud failed state: a fixtures row carrying the reason, never a silent skip. */
async function writeFailedFixture(opts: {
  datasourceId: string;
  fingerprint: string;
  reason: string;
}): Promise<number> {
  const version = await nextVersion(opts.datasourceId);
  await db.insert(datasourceFixtures).values({
    datasourceId: opts.datasourceId,
    version,
    rowsJson: {},
    ddlSql: `-- mock build failed: ${opts.reason}`,
    schemaFingerprint: opts.fingerprint || "unknown",
    taxonomyJson: {},
    generatedBy: "mock",
    model: null,
    // SliceA-owned readiness columns (migration 0062) — cast so this file
    // typechecks identically before/after schema.ts lands them.
    ...( { mockStatus: "failed", mockError: opts.reason } as Record<string, unknown> ),
  } as typeof datasourceFixtures.$inferInsert);
  return version;
}

function fileTablesFor(shape: SandboxShape, rows: FixtureRows): MockFileTable[] {
  return shape.tables.map((t) => ({
    name: t.key,
    columns: t.columns.map((c) => ({ name: c.name, type: c.sqlType })),
    rows: rows[t.key] ?? [],
  }));
}

async function runMockBuild(opts: {
  workspaceId: string;
  datasourceId: string;
  fingerprint: string;
  ddlSql: string;
  shape: SandboxShape;
}): Promise<MockBuildOutcome> {
  const { workspaceId, datasourceId, fingerprint, ddlSql, shape } = opts;
  const hints = await collectValueHints(workspaceId, datasourceId, shape);
  const key = `${workspaceId}:${datasourceId}`;
  mockInFlight.add(key);
  const version = await nextVersion(datasourceId);
  await db.insert(datasourceFixtures).values({
    datasourceId,
    version,
    rowsJson: {},
    ddlSql,
    schemaFingerprint: fingerprint,
    // What this build's hints were made of — per column, how many values from
    // each source, and why a source gave none. Never the values themselves
    // (those are in rows_json, where they belong).
    taxonomyJson: { valueHints: { provenance: hints.provenance, notes: hints.notes } },
    generatedBy: "mock",
    model: null,
    ...( { mockStatus: "building", mockError: null } as Record<string, unknown> ),
  } as typeof datasourceFixtures.$inferInsert);

  try {
    const rows = generateMockRows(shape, hints);
    await writeMockFile({
      workspaceId,
      datasourceId,
      version,
      fingerprint,
      tables: fileTablesFor(shape, rows),
    });
    await db
      .update(datasourceFixtures)
      .set({
        rowsJson: rows,
        ...( { mockStatus: "ready", mockError: null } as Record<string, unknown> ),
      } as Partial<typeof datasourceFixtures.$inferInsert>)
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.version, version),
        ),
      );
    return { started: true, version };
  } catch (e) {
    const message = (e as Error).message;
    await db
      .update(datasourceFixtures)
      .set({
        ...( { mockStatus: "failed", mockError: message } as Record<string, unknown> ),
      } as Partial<typeof datasourceFixtures.$inferInsert>)
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.version, version),
        ),
      )
      .catch(() => {});
    await deleteMockFile(workspaceId, datasourceId, version);
    return { started: false, why: "build_failed", detail: message };
  } finally {
    mockInFlight.delete(key);
  }
}

/**
 * The value hints for one build (D-268): the categories the schema recorded, the
 * typical spans of dates and numbers, plus literals the workspace authored
 * against it. Never throws — a hint problem must not become a mock problem.
 */
async function collectValueHints(
  workspaceId: string,
  datasourceId: string,
  shape: SandboxShape,
): Promise<ValueHints> {
  try {
    const [ds] = await db.select().from(datasources).where(eq(datasources.id, datasourceId)).limit(1);
    if (!ds) return EMPTY_HINTS;
    const notes: string[] = [];
    const dsn = decryptDsnIfPresent(ds.connectionStringEnc);
    // CATEGORIES are the values the schema recorded when it was read (introspect/choice-set.ts) — one rule, every engine,
    // no second reader here. Before 2026-10-10 a Postgres-only, name-keyed reader lived here, so `dept` or `division`, and
    // every SQLite column, kept `mock_<column>_<n>` and every test filter on them matched nothing.
    // SPANS (2026-10-10): every date and number column's typical range, for Postgres AND SQLite, through one sampling
    // path — only the rounded summaries leave it, never a row (readRangeHints).
    let dateRanges: Record<string, DateRange> = {};
    let links: InferredLink[] = [];
    const categories = domainCategories(shape, await schemaRepo.listByDatasource(datasourceId));
    let numberRanges: Record<string, NumberRange> = {};
    if (!dsn) notes.push("ranges not read: the datasource stores no credential");
    else if (ds.type === "postgres" || isSqliteType(ds.type)) {
      try {
        const sampler = ds.type === "postgres" ? await postgresSampler(dsn) : await sqliteSampler(dsn);
        try {
          const r = await readRangeHints(shape, sampler.sample);
          dateRanges = r.dateRanges;
          numberRanges = r.numberRanges;
          notes.push(...r.notes);
          // Links the schema does not declare, measured from the data (`mock-links.ts`) — only the link leaves.
          try {
            links = inferLinks(await profileShape(shape, sampler.query));
            for (const l of links) notes.push(`linked ${l.child} → ${l.parent} (${l.shared} values in common in the real data)`);
          } catch (e) {
            notes.push(`links not measured: ${(e as Error).message}`);
          }
          // Category values in the real data's proportions — counts per value, never a row (`weightByFrequency`).
          for (const [key, values] of Object.entries(categories)) {
            const [tname, ...rest] = key.split(".");
            const table = shape.tables.find((t) => t.name === tname);
            const col = table?.columns.find((c) => c.name === rest.join("."));
            if (!table || !col) continue;
            try {
              const counts = new Map((await sampler.query(countsSql(table, col))).map((r) => [String(r.v), Number(r.n)]));
              categories[key] = weightByFrequency(values, counts, MOCK_ROWS_PER_TABLE);
            } catch (e) {
              notes.push(`${key} proportions not read: ${(e as Error).message}`);
            }
          }
        } finally {
          await sampler.close();
        }
      } catch (e) {
        notes.push(`ranges not read: the datasource was unreachable (${(e as Error).message})`);
      }
    }
    const authored: Array<{ table: string | null; column: string; value: string }> = [];
    const queries = await db
      .select({ sqlText: datasourceQueries.sqlText })
      .from(datasourceQueries)
      .where(eq(datasourceQueries.datasourceId, datasourceId));
    for (const q of queries) for (const l of authoredLiteralsFromSql(q.sqlText)) authored.push({ table: null, ...l });

    const ops = await db
      .select({ name: datasourceOperations.name, spec: datasourceOperations.specJson })
      .from(datasourceOperations)
      .where(eq(datasourceOperations.datasourceId, datasourceId));
    const opFilters = ops.map((o) => {
      const spec = o.spec as { base?: { table?: string }; filters?: Array<{ column: string; param?: string }> };
      return { ref: `${ds.name}.${o.name}`, table: spec.base?.table ?? null, filters: spec.filters ?? [] };
    });
    if (opFilters.some((o) => o.filters.length)) {
      // Each flow's DRAFT revision — what somebody is working on now.
      const live = await db
        .select({ id: flows.id, rev: flows.draftRevision })
        .from(flows)
        .where(eq(flows.workspaceId, workspaceId));
      const revs = live.length
        ? await db
            .select({ flowId: flowRevisions.flowId, revision: flowRevisions.revision, model: flowRevisions.modelJson })
            .from(flowRevisions)
            .where(inArray(flowRevisions.flowId, live.map((f) => f.id)))
        : [];
      const draftOf = new Map(live.map((f) => [f.id, f.rev]));
      const models = revs.filter((r) => draftOf.get(r.flowId) === r.revision).map((r) => r.model);
      authored.push(...authoredLiteralsFromFlows(models, opFilters));
    }
    const merged = mergeHints(categories, authored, notes);
    for (const k of [...Object.keys(dateRanges), ...Object.keys(numberRanges)]) merged.provenance[k] = { ...(merged.provenance[k] ?? {}), range: 1 };
    return withFallbackRange({ ...merged, dateRanges, numberRanges, ...(links.length ? { links } : {}) }, new Date());
  } catch (e) {
    return withFallbackRange({ ...EMPTY_HINTS, notes: [`value hints not collected: ${(e as Error).message}`] }, new Date());
  }
}

async function guardShape(opts: {
  workspaceId: string;
  datasourceId: string;
  allowlist: string[];
}): Promise<
  | { ok: true; shape: SandboxShape; ddlSql: string }
  | { ok: false; outcome: Extract<MockBuildOutcome, { started: false }> }
> {
  const { datasourceId, allowlist } = opts;
  const storedRows: unknown = await schemaIntrospectorService.getStored(datasourceId);
  const stored = (storedRows as IntrospectedEntity[]).filter(
    (e) => Array.isArray(e.columns),
  );
  if (stored.length === 0) {
    await writeFailedFixture({
      datasourceId,
      fingerprint: "unknown",
      reason: "no stored schema — refresh the schema first (a mock is a copy of a shape, and there is nothing to copy)",
    }).catch(() => {});
    return { ok: false, outcome: { started: false, why: "no_schema" } };
  }
  // ⚠ No table-count refusal and NO COLUMN CAP. A 46-table schema builds, and
  // every table keeps every column `deriveShape` could reproduce — see the
  // deleted-constant note above for the draft run that the column cap broke.
  const shape = deriveShape(stored, { allowlist });
  /**
   * ⚠ **AN UNREPRODUCIBLE COLUMN NO LONGER SINKS THE WHOLE MOCK — 2026-09-17.**
   *
   * This used to refuse on `shape.unsupported.length > 0`, i.e. one column
   * anywhere in the schema meant no mock data at all. Measured against a real
   * tenant's Prisma database: 46 tables, every one of them reproducible, and
   * **14 enum columns** — so the whole datasource had no mock, and the message
   * was a 14-clause wall listing types nobody can change.
   *
   * ⚠ The important part is that `deriveShape` **already excluded those
   * columns**: `mapColumn` records the reason and returns `null`, so the table
   * in `shape.tables` is the table minus the column. The shape was usable the
   * whole time; this guard was refusing a shape it had in its hand.
   *
   * ⚠ **This is the ONLY reason a mock column is ever absent now.** The argument
   * here used to lean on `MAX_MOCK_COLUMNS_PER_TABLE` dropping columns anyway,
   * which made refusing over an unreproducible one "two answers to one
   * question". That cap is deleted, so the argument stands on its own and is
   * narrower: a column whose TYPE the generator cannot represent is excluded by
   * `mapColumn` with a recorded reason, and one such column must not cost a
   * tenant every other table. A draft run reading one still finds nothing
   * there — that residue is real, and it is now measured in columns rather
   * than in most of the schema.
   *
   * ⚠ **The SANDBOX keeps the strict rule and must.** That copy is a substitute
   * for production, so D-53's argument holds there — a widened enum accepts
   * values the real column rejects. This is the MOCK: pglite, design-time, never
   * a stand-in for the real database. Different artefact, different bargain.
   *
   * What is still refused: a schema with no reproducible table at all, and any
   * table left with NO columns, which cannot be created.
   */
  const { usable, empty } = partitionMockTables(shape);
  if (usable.length === 0) {
    const detail =
      shape.unsupported.length > 0
        ? `unsupported shape: ${shape.unsupported.join("; ")}`
        : "no reproducible tables in the stored schema";
    await writeFailedFixture({ datasourceId, fingerprint: shape.fingerprint, reason: detail }).catch(
      () => {},
    );
    return { ok: false, outcome: { started: false, why: "unsupported_shape", detail } };
  }
  // ⚠ Never silent, same rule as the width cap above: what was dropped is
  // logged with the reason, because a mock build persists no notes and this is
  // the only place a dropped column can be read back from at build time.
  if (shape.unsupported.length > 0 || empty.length > 0) {
    console.warn(
      `[mock] datasource ${datasourceId}: ${shape.unsupported.length} column(s) could not be ` +
        `reproduced and were left out of the mock` +
        (empty.length > 0 ? `, and ${empty.length} table(s) kept none at all and were skipped` : "") +
        ` — ${shape.unsupported.join("; ")}`,
    );
  }
  /**
   * ⚠ `unsupported` is CLEARED for the mock's own shape, and the reasons move
   * into `notes` — they are not discarded.
   *
   * `renderDdl` throws on a non-empty `unsupported`, and that guard must stay:
   * it is shared with the SANDBOX path, where a shape that cannot be reproduced
   * faithfully must not be rendered at all. For the mock the question is already
   * answered — those columns are absent from `usable`, so the DDL about to be
   * rendered is complete with respect to the tables it describes.
   *
   * ⚠ Clearing the list without carrying the reasons forward would be the real
   * mistake: the record of what this mock does NOT contain is exactly what a
   * person needs when a query against it returns nothing.
   */
  const built = {
    ...shape,
    tables: usable,
    notes: [
      ...shape.notes,
      ...shape.unsupported.map((u) => `left out of the mock: ${u}`),
      ...empty.map((t) => `${t.key}: skipped — no column could be reproduced`),
    ],
    unsupported: [],
  };
  return { ok: true, shape: built, ddlSql: renderDdl(built) };
}

/**
 * Start a mock build if — and only if — this datasource has none. The
 * onboarding entry point (`refreshSchema`, every seeder). Refuses rather than
 * throwing for every expected case, and every refusal except
 * already-has/already-building lands as a loud `failed` fixtures row.
 */
export async function requestMockBuild(
  workspaceId: string,
  datasourceId: string,
): Promise<MockBuildOutcome> {
  const key = `${workspaceId}:${datasourceId}`;
  if (mockInFlight.has(key)) return { started: false, why: "already_building" };

  const rows = await db
    .select()
    .from(datasources)
    .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
    .limit(1);
  const ds = rows[0];
  if (!ds) return { started: false, why: "no_schema" };
  if (!supportsMockType(ds.type)) {
    const detail = `mock datasets are only built for postgres and sqlite datasources, not "${ds.type}"`;
    await writeFailedFixture({ datasourceId, fingerprint: "unknown", reason: detail }).catch(
      () => {},
    );
    return { started: false, why: "not_postgres", detail };
  }

  const has = await existingVersion(datasourceId);
  if (has !== null) {
    // The file is a projection of the row: a missing file with a ready row
    // (wiped dir, undeployed volume) rebuilds deterministically rather than
    // refusing — same seed, same rows, new version.
    try {
      await readMockFile(workspaceId, datasourceId, has);
    } catch {
      return rebuildMockDataset(workspaceId, datasourceId);
    }
    // ⚠ A mock of an OLDER shape is not "a mock": a schema refresh that added `v_absence.days` left the frozen mock without it, so a
    // read checked against today's schema failed every draft run with "no such column" (2026-10-02, H02). The rows are synthetic
    // and the build deterministic, so a moved fingerprint rebuilds — never a silent run against the wrong shape.
    const current = await guardShape({ workspaceId, datasourceId, allowlist: ds.schemaAllowlist ?? ["public"] });
    const latest = await datasourceFixtureRepo.latestReady(datasourceId);
    if (current.ok && latest && latest.schemaFingerprint !== current.shape.fingerprint) return rebuildMockDataset(workspaceId, datasourceId);
    return { started: false, why: "already_has_fixture" };
  }

  const guarded = await guardShape({
    workspaceId,
    datasourceId,
    allowlist: ds.schemaAllowlist ?? ["public"],
  });
  if (!guarded.ok) return guarded.outcome;

  return runMockBuild({
    workspaceId,
    datasourceId,
    fingerprint: guarded.shape.fingerprint,
    ddlSql: guarded.ddlSql,
    shape: guarded.shape,
  });
}

/**
 * Force a fresh mock version over an existing one. The `update()`
 * credential/allowlist path and the CLI rebuild trigger. Same guards as the
 * initial build except the already-has check — a rebuild over a fixture is the
 * point, not the destructive case (rows are synthetic and the file is derived).
 */
export async function rebuildMockDataset(
  workspaceId: string,
  datasourceId: string,
): Promise<MockBuildOutcome> {
  const key = `${workspaceId}:${datasourceId}`;
  if (mockInFlight.has(key)) return { started: false, why: "already_building" };

  const rows = await db
    .select()
    .from(datasources)
    .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
    .limit(1);
  const ds = rows[0];
  if (!ds) return { started: false, why: "no_schema" };
  if (!supportsMockType(ds.type)) {
    const detail = `mock datasets are only built for postgres and sqlite datasources, not "${ds.type}"`;
    await writeFailedFixture({ datasourceId, fingerprint: "unknown", reason: detail }).catch(
      () => {},
    );
    return { started: false, why: "not_postgres", detail };
  }

  const guarded = await guardShape({
    workspaceId,
    datasourceId,
    allowlist: ds.schemaAllowlist ?? ["public"],
  });
  if (!guarded.ok) return guarded.outcome;

  return runMockBuild({
    workspaceId,
    datasourceId,
    fingerprint: guarded.shape.fingerprint,
    ddlSql: guarded.ddlSql,
    shape: guarded.shape,
  });
}
