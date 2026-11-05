/**
 * Banded-read code-emit — CASE WHEN from the model's own `band_count` arms.
 *
 * When Intent IR is on, the write path may build the form here for speed — but
 * only when `bandSpecValid` accepts the model's stated structure (contiguous
 * arms, known `counts` selectors). The model's arms are source of truth; code
 * lowers them by position and identity, never by label or weight.
 */
import type { SchemaRow } from "../../repositories/schema.repo.js";
import type { DbOperationSpec } from "../db-operation.service.js";
import { compileOperation } from "../db-operation.service.js";
import { intentIrEnabled } from "./intent-ir.js";
import { bandArmsConsistent } from "./plan.js";
import type { BandArm } from "./plan.js";
import { factName } from "./plan.js";

/** On whenever Intent IR is on — band emit is part of that path, not a stack of flags. */
export function bandEmitEnabled(): boolean {
  return intentIrEnabled();
}

export type BandMeasureIn = {
  words: string;
  field: string | null;
  bands: BandArm[];
  /** The `words` of the single band this measure counts (copied exactly); null/empty sums every band's weight. */
  counts?: string | null;
};

const OP: Record<BandArm["test"], "gt" | "gte" | "lt" | "lte" | "eq"> = {
  above: "gt",
  at_least: "gte",
  below: "lt",
  at_most: "lte",
  equals: "eq",
};

/** Last path segment — `ds.new_read.some_field` / `ds.table.main.t.col` → `col`. */
export const bareField = (f: string | null | undefined) => {
  if (f == null || f === "") return "";
  return f.split(".").filter(Boolean).at(-1) ?? f;
};

const slug = (words: string, i: number) => {
  const s = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40)
    .replace(/_$/, "");
  return s || `band_${i}`;
};

type ColOwner = { table: string; schema: string | null; column: string };

function ownersOf(rows: SchemaRow[], column: string): ColOwner[] {
  const want = column.toLowerCase();
  const out: ColOwner[] = [];
  for (const r of rows) {
    const col = r.columnName;
    if (!col || col.toLowerCase() !== want) continue;
    out.push({ table: r.entityName, schema: r.entitySchema ?? null, column: col });
  }
  return out;
}

function pickOwner(cands: ColOwner[], prefer?: string): ColOwner | null {
  if (!cands.length) return null;
  if (prefer) {
    const hit = cands.find((c) => c.table.toLowerCase() === prefer.toLowerCase());
    if (hit) return hit;
  }
  return cands[0]!;
}

/**
 * Resolve a summary.by field to a real schema column: exact match on the
 * model's `ref.field`, else a compound-name suffix (`a.b.c` → `c`, then
 * progressively shorter suffixes). No name guessing — an unresolvable
 * field is null and the caller refuses.
 */
export function resolveGroupColumn(
  rows: SchemaRow[],
  field: string,
  words: string,
  preferTable?: string,
): ColOwner | null {
  void words;
  const col = bareField(field);
  if (!col || col === "new_read" || col === "any") return null;
  const direct = pickOwner(ownersOf(rows, col), preferTable);
  if (direct) return direct;
  if (col.includes("_")) {
    const parts = col.split("_");
    for (let n = 1; n < parts.length; n++) {
      const cand = parts.slice(n).join("_");
      const o = pickOwner(ownersOf(rows, cand), preferTable);
      if (o) return o;
    }
  }
  return null;
}

/**
 * Locate the banded numeric column from the model's `measures[].field`
 * (source (a)). Exact match first; else the type-based fallback (source (b)
 * — the schema profile) applies ONLY when exactly one numeric column exists:
 * a single candidate is a forced move, never a choice. Several candidates
 * (or none) is ambiguity code must not resolve by guessing — the caller
 * refuses, naming the candidates. No name is ever read: neither the
 * measure's words nor any field-name list.
 */
export function resolveBandFieldOwner(rows: SchemaRow[], field: string | null | undefined): ColOwner | null {
  const name = bareField(field);
  const direct = name ? pickOwner(ownersOf(rows, name)) : null;
  if (direct) return direct;
  const numeric = rows.filter((r) => r.columnName && /int|number|float|double|numeric|decimal/i.test(r.columnType ?? "")
    && !/summar|aggreg|rollup/i.test(r.entityName.toLowerCase()));
  if (numeric.length !== 1) return null;
  const only = numeric[0]!;
  return { table: only.entityName, schema: only.entitySchema ?? null, column: only.columnName! };
}

type Num = { number: number };
/** Nullable numeric band measure: NULL never satisfies >= / <= — coalesce to 0 (floor band). */
type BandLeft = { coalesce: Array<{ column: string } | Num> };
type Arm = {
  op: "gt" | "gte" | "lt" | "lte" | "eq";
  left: BandLeft;
  right: Num;
  then: Num;
};
type Compute = { caseWhen: { arms: Arm[]; else: Num } };

const bandLeft = (column: string): BandLeft => ({ coalesce: [{ column }, { number: 0 }] });

/** First-match weight for one field value — oracle / unit checks against CASE semantics. */
export function evalBandWeight(value: number | null | undefined, bands: BandArm[]): number {
  const h = value == null || Number.isNaN(Number(value)) ? 0 : Number(value);
  for (const b of bands) {
    const edge = Number(b.value);
    const ok =
      b.test === "at_least" ? h >= edge
      : b.test === "below" ? h < edge
      : b.test === "at_most" ? h <= edge
      : b.test === "above" ? h > edge
      : h === edge;
    if (ok) return b.then;
  }
  return 0;
}

/** SUM of first-match weights. */
export function weightCompute(column: string, bands: BandArm[]): Compute {
  return {
    caseWhen: {
      arms: bands.map((b) => ({
        op: OP[b.test],
        left: bandLeft(column),
        right: { number: Number(b.value) },
        then: { number: b.then },
      })),
      else: { number: 0 },
    },
  };
}

/**
 * Count of rows whose first-match arm has `then === want`.
 * Arms before the match yield 0; the matching arm yields 1; else 0.
 */
export function indicatorCompute(column: string, bands: BandArm[], want: number): Compute | null {
  const i = bands.findIndex((b) => b.then === want);
  if (i < 0) return null;
  return indicatorComputeAt(column, bands, i);
}

/**
 * Count of rows that first-match arm `armIndex` — for count-style bands where
 * several arms share a weight, so weight lookup is useless.
 */
export function indicatorComputeAt(column: string, bands: BandArm[], armIndex: number): Compute | null {
  if (armIndex < 0 || armIndex >= bands.length) return null;
  return {
    caseWhen: {
      arms: bands.slice(0, armIndex + 1).map((b, j) => ({
        op: OP[b.test],
        left: bandLeft(column),
        right: { number: Number(b.value) },
        then: { number: j === armIndex ? 1 : 0 },
      })),
      else: { number: 0 },
    },
  };
}


/**
 * Dimension table for the group key (not the banded fact table). Prefer a PK owner so
 * the outer query is one row per key; fact rows stay inside `aggregateJoins`.
 */
export function dimensionOwnerFor(
  rows: SchemaRow[],
  groupKey: string,
  factTable: string,
): ColOwner | null {
  const cands = ownersOf(rows, groupKey).filter((o) => o.table !== factTable);
  if (!cands.length) return null;
  const pk = cands.find((o) =>
    rows.some((r) => r.entityName === o.table && r.columnName === o.column && r.isPrimaryKey));
  return pk ?? cands[0]!;
}

/**
 * Structural validity of the model's banded measures against the emitted
 * spec — no English, no labels, no weights examined: every banded measure
 * has ≥2 arms; every edge parses finite; every arm set is live (no dead
 * arm); every non-empty `counts` names exactly one band's `words`; the
 * emitted spec carries one aggregate per banded measure.
 * Returns `true` when valid, else the structural reason (for the refusal).
 */
export function bandSpecValid(
  spec: {
    aggregateJoins?: Array<{ aggregates?: unknown[] }>;
  },
  measures: BandMeasureIn[],
): true | string {
  const withBands = measures.filter((m) => m.bands?.length);
  if (!withBands.length) return "no banded measure states bands";
  for (const m of withBands) {
    if (m.bands.length < 2) return `“${m.words}” states fewer than two bands`;
    if (m.bands.some((b) => !Number.isFinite(Number(b.value)))) return `“${m.words}” has a band edge that is not a number`;
    if (!bandArmsConsistent(m.bands)) return `the bands for “${m.words}” make a band unreachable (a later band covered by an earlier one)`;
    if (m.counts != null && m.counts !== "" && !m.bands.some((b) => b.words === m.counts)) return `“${m.words}” counts “${m.counts}”, which is not one of its bands`;
  }
  const aggs = (spec.aggregateJoins ?? []).flatMap((j) => j.aggregates ?? []);
  if (aggs.length < withBands.length) return "the emitted read carries fewer aggregates than the stated banded measures";
  return true;
}

/**
 * Build a grouped read: one row per group key, one SUM(caseWhen) per band measure.
 * Returns null when the schema cannot locate the banded column or a group key.
 *
 * Outer `base` is a **dimension** table that owns the group key when one exists
 * (fact stays in `aggregateJoins` only) — never the day/fact table alone, which
 * fans out one result row per fact row. No dimension → `distinct: true`.
 *
 * `dateColumn`: period filters on the fact aggregate join. Row exclusions
 * are the model's `Plan.rows[]` tests applied as `aggregateJoins[].filters`
 * (source (a)) — never a datasource literal read into code.
 */
export function emitBandedSpec(
  rows: SchemaRow[],
  measures: BandMeasureIn[],
  groupBy: Array<{ field: string; words: string }>,
  opts?: {
    dateColumn?: string | null;
    texts?: readonly string[];
    /** When emit refuses, the structural reason is written here (for the refusal). */
    why?: { reason?: string };
  },
): DbOperationSpec | null {
  const refuse = (reason: string): null => {
    if (opts?.why) opts.why.reason = reason;
    return null;
  };
  const banded = measures.filter((m) => m.bands?.length);
  if (!banded.length) return refuse("no banded measure states bands");

  const fieldHint = banded.find((m) => m.field)?.field;
  if (!fieldHint) return refuse("no banded measure names a field");
  // A stated column name that matches no column is a finding, not a guess:
  // refuse rather than emit over a different column.
  const hintBare = bareField(fieldHint).toLowerCase();
  if (hintBare && hintBare !== "new_read" && hintBare !== "any"
    && !rows.some((r) => (r.columnName ?? "").toLowerCase() === hintBare)) return refuse(`the banded field “${hintBare}” matches no column of the schema`);
  const fieldOwner = resolveBandFieldOwner(rows, fieldHint);
  if (!fieldOwner) {
    const cands = rows.filter((r) => r.columnName && /int|number|float|double|numeric|decimal/i.test(r.columnType ?? "")).map((r) => r.columnName!);
    return refuse(cands.length
      ? `the banded field is ambiguous between several numeric columns (${[...new Set(cands)].join(", ")}) — name one`
      : "no numeric column resolves for the banded field");
  }
  const fieldName = fieldOwner.column;
  const factTable = fieldOwner.table;
  const factSchema = fieldOwner.schema ?? undefined;

  // Resolve group key: prefer a key on the fact table, else any resolvable key.
  let groupKey: string | null = null;
  const labelReqs: Array<{ col: string; words: string; owner: ColOwner }> = [];
  let namedUnresolved = 0;
  for (const g of groupBy) {
    const raw = bareField(g.field);
    if (!raw || raw === "new_read" || raw === "any") continue;
    if (!ownersOf(rows, raw).length && /band_count/.test(raw) && !/name/i.test(raw)) continue;
    const owner = resolveGroupColumn(rows, g.field, g.words, factTable) ?? resolveGroupColumn(rows, g.field, g.words);
    if (!owner) { namedUnresolved++; continue; }
    const col = owner.column;
    if (owner.table === factTable || ownersOf(rows, col).some((o) => o.table === factTable)) {
      if (!groupKey) groupKey = col;
      else if (col !== groupKey) {
        // Extra keys on fact are rare; keep first as join key.
      }
    }
    if (owner.table !== factTable || col !== groupKey) {
      labelReqs.push({ col, words: g.words, owner });
    }
  }
  // The PK fallback serves an unnamed grouping only: when the model named
  // group entries but none resolves, grouping by the PK would silently drop
  // everything asked for — refuse, naming what failed.
  if (!groupKey && namedUnresolved > 0) return refuse(`none of the groupings resolves to a column (“${groupBy.map((g) => g.words).join(", ")}”) on ${factTable}`);
  if (!groupKey) {
    const pk = rows.find((r) => r.entityName === factTable && r.isPrimaryKey && r.columnName);
    groupKey = pk?.columnName ?? null;
  }
  if (!groupKey) return refuse(`no group key resolves for “${groupBy.map((g) => g.words).join(", ")}” on ${factTable}`);

  const dim = dimensionOwnerFor(rows, groupKey, factTable);
  const baseTable = dim?.table ?? factTable;
  const baseSchema = (dim?.schema ?? factSchema) ?? undefined;
  const useDistinct = !dim;

  const joins: Array<{ table: string; schema?: string; onLeft: string; onRight: string; kind: "left" }> = [];
  const seenJoin = new Set<string>([baseTable]);
  const labelCols: Array<{ table: string; column: string; alias: string }> = [];
  const groupCols: string[] = [groupKey];

  for (const lab of labelReqs) {
    if (lab.col === groupKey && lab.owner.table === baseTable) continue;
    if (lab.owner.table === baseTable) {
      if (!groupCols.includes(lab.col)) labelCols.push({ table: baseTable, column: lab.col, alias: slug(lab.words, labelCols.length) || lab.col });
      continue;
    }
    // Join label table onto base via shared key (usually the group key).
    const shared = groupKey;
    if (!ownersOf(rows, shared).some((o) => o.table === lab.owner.table)) continue;
    if (!seenJoin.has(lab.owner.table)) {
      seenJoin.add(lab.owner.table);
      joins.push({
        table: lab.owner.table,
        ...(lab.owner.schema ? { schema: lab.owner.schema } : {}),
        onLeft: shared,
        onRight: shared,
        kind: "left",
      });
    }
    labelCols.push({
      table: lab.owner.table,
      column: lab.col,
      alias: slug(lab.words, labelCols.length) || lab.col,
    });
  }

  const aggregates: Array<{ compute: Compute; aggregate: "sum"; alias: string }> = [];
  const usedAlias = new Set<string>();

  // General lowering: the measure names its band by identity (`counts` is
  // that band's `words`); the column counts rows first-matching that arm.
  // Empty `counts` sums every band's weight (a total). An explicit `counts`
  // naming no band refuses — weight-summing it would silently count the
  // wrong rows. No label is read, no weight evaluated.
  for (const m of banded) {
    if (m.counts != null && m.counts !== "" && !m.bands.some((b) => b.words === m.counts)) return refuse(`“${m.words}” counts “${m.counts}”, which is not one of its bands`);
  }
  banded.forEach((m, i) => {
    let alias = `band_${slug(m.words, i)}` || `band_${i}`;
    if (usedAlias.has(alias)) alias = `${alias}_${i}`;
    usedAlias.add(alias);
    const armAt = m.counts ? m.bands.findIndex((b) => b.words === m.counts) : -1;
    const compute: Compute | null = armAt >= 0 ? indicatorComputeAt(fieldName, m.bands, armAt) : weightCompute(fieldName, m.bands);
    if (!compute?.caseWhen.arms.length) return;
    aggregates.push({ compute, aggregate: "sum", alias });
  });
  if (!aggregates.length) return refuse("no banded measure lowered to an aggregate");

  const columns = [
    ...groupCols.map((c) => ({ column: c, alias: c })),
    ...labelCols.map((l) => ({
      column: l.table === baseTable ? l.column : `${l.table}.${l.column}`,
      alias: l.alias === l.column ? l.column : l.alias,
    })),
    ...aggregates.map((a) => ({ column: a.alias, alias: a.alias })),
  ];

  const dateCol = opts?.dateColumn?.trim() || null;
  const periodFilters = dateCol
    ? [
        { column: dateCol, op: "gte" as const, param: "period_start" },
        { column: dateCol, op: "lt" as const, param: "period_end" },
      ]
    : [];

  const spec = {
    base: { table: baseTable, ...(baseSchema ? { schema: baseSchema } : {}) },
    columns,
    joins,
    ...(useDistinct ? { distinct: true as const } : {}),
    aggregateJoins: [
      {
        table: factTable,
        ...(factSchema ? { schema: factSchema } : {}),
        groupBy: groupKey,
        onLeft: groupKey,
        kind: "left" as const,
        aggregates,
        filters: [...periodFilters],
      },
    ],
    filters: [],
    having: [],
    sort: [],
    limit: 10000,
  };

  try {
    compileOperation(spec as never, rows);
  } catch {
    return null;
  }
  return spec as unknown as DbOperationSpec;
}
