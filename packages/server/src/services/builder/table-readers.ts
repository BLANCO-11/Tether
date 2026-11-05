/**
 * Readers built from the SCHEMA (compiled-builder D-311, slice 5d): most workspaces have no saved queries or operations, so a
 * table is a reader. For each introspected table this derives ONE typed DB-operation spec — the table's rows, each with the rows
 * it refers to (its foreign keys, two hops) and a count and latest date of the rows that refer to it — and `compileOperation`,
 * the sole SQL emitter, lowers it. The model never writes SQL and never picks a column list: it chooses the table, as it chooses
 * a saved reader.
 *
 * ⚠ AGNOSTIC BY CONSTRUCTION. Everything here is read from the schema rows' own declarations — entity, column, type, nullability,
 * foreign key, tag. No table, column or workspace name is known to this module (`table-readers.test.ts` builds on `t1.c1` …).
 * Aliases are the table's name joined to the column's, which is a spelling, never a meaning.
 *
 * ⚠ NEVER A GUESSED JOIN. A join follows a DECLARED foreign key and nothing else. Where two keys lead to the same table (a row
 * with a requester and an assignee, both people), which one the goal means is not in the schema, so NEITHER is joined — the key
 * columns stay on the row, and nothing is picked silently.
 *
 * ⚠ Nothing is saved to the workspace. The spec travels on the reader step (`sqlSpec`) and compiles to step-local SQL; a saved
 * reader is a person's decision on the datasource page. The save funnel types the step from that same spec
 * (`buildCatalogueSnapshot`), so a built reader is typed exactly as a saved operation is.
 */
import { TypeOf as T, type RefSig, type Ty } from "@foundry/flow-edit";
import type { SchemaRow } from "../../repositories/schema.repo.js";
import { compileOperation, type DbOperationSpec, type SqlDialect } from "../db-operation.service.js";
import { operationFields } from "../flow-typecheck.js";

export interface TableReader {
  /** `<datasource>.table.<table>` (schema-qualified when not the default schema) — never a saved reader's spelling. */
  ref: string;
  datasource: string;
  table: string;
  /** The tables this reader reads, base first — what a label's `expect.tables` is compared with. */
  tables: string[];
  about: string;
  spec: DbOperationSpec;
  sig: RefSig;
  sql: string;
}

/** The ref marker: a saved operation or query is `<datasource>.<name>`, so a table reader can never collide with one. */
export const TABLE_REF = ".table.";
export const isTableRef = (ref: string) => ref.includes(TABLE_REF);

interface Entity { schema: string | null; name: string; columns: Array<{ name: string; type: string | null; fk: { table: string; column: string } | null }> }
interface Edge { from: string; fromColumn: string; to: string; toColumn: string }

const DATE_TYPE = /^(date|timestamp)/i;
/** A field type with no declared part — what the engine refuses in a reader's rows. */
const noType = (t: Ty): boolean => t.t === "Opaque" || t.t === "Json" || ("of" in t && noType(t.of as Ty));

function entitiesOf(rows: SchemaRow[]): Entity[] {
  const by = new Map<string, Entity>();
  for (const r of rows) {
    if (!r.columnName || (r.entityType !== "table" && r.entityType !== "view" && r.entityType !== "materialized_view")) continue;
    const key = `${r.entitySchema ?? ""}.${r.entityName}`;
    if (!by.has(key)) by.set(key, { schema: r.entitySchema, name: r.entityName, columns: [] });
    // `foreign_key_reference` is `table.column` or `schema.table.column`.
    const ref = r.isForeignKey && r.foreignKeyReference ? r.foreignKeyReference.split(".") : null;
    const fk = ref && ref.length >= 2 ? { table: ref[ref.length - 2]!, column: ref[ref.length - 1]! } : null;
    by.get(key)!.columns.push({ name: r.columnName, type: r.columnType, fk });
  }
  return [...by.values()];
}

/** Foreign-key edges out of `table`, keeping only targets exactly ONE key leads to (two keys to one table: which is meant is not declared). */
function singleEdges(edges: Edge[]): Edge[] {
  const n = new Map<string, number>();
  for (const e of edges) n.set(e.to, (n.get(e.to) ?? 0) + 1);
  return edges.filter((e) => n.get(e.to) === 1);
}

/**
 * The spec for one table: base columns; forward FK joins (left, two hops, each table at most once); for each table whose ONE key
 * refers to this one, a summary join with the count of its rows and the latest of each of its dates.
 */
export function tableSpec(e: Entity, all: Entity[]): { spec: DbOperationSpec; tables: string[] } {
  const named = new Map(all.map((x) => [x.name, x]));
  const outOf = (t: Entity): Edge[] => t.columns.flatMap((c) => (c.fk && c.fk.table !== t.name && named.has(c.fk.table) ? [{ from: t.name, fromColumn: c.name, to: c.fk.table, toColumn: c.fk.column }] : []));
  const columns: DbOperationSpec["columns"] = [];
  const aliases = new Set<string>();
  const add = (qualified: string, alias: string) => { if (aliases.has(alias)) return; aliases.add(alias); columns.push({ compute: { column: qualified }, alias }); };
  for (const c of e.columns) add(`${e.name}.${c.name}`, c.name);

  const joined = new Set<string>([e.name]);
  const joins: DbOperationSpec["joins"] = [];
  const hop1 = singleEdges(outOf(e));
  // A table reachable at hop 1 is never also joined at hop 2 (one occurrence per table; the spec has no per-join alias).
  const excluded = new Set<string>(outOf(e).map((x) => x.to));
  for (const h of hop1) { joins.push({ table: h.to, onLeft: `${e.name}.${h.fromColumn}`, onRight: h.toColumn, kind: "left" }); joined.add(h.to); }
  const hop2 = singleEdges(hop1.flatMap((h) => outOf(named.get(h.to)!)).filter((x) => x.to !== e.name && !excluded.has(x.to)));
  for (const h of hop2) { if (joined.has(h.to)) continue; joins.push({ table: h.to, onLeft: `${h.from}.${h.fromColumn}`, onRight: h.toColumn, kind: "left" }); joined.add(h.to); }
  for (const j of joins) for (const c of named.get(j.table)!.columns) if (c.name !== j.onRight) add(`${j.table}.${c.name}`, `${j.table}_${c.name}`);

  // Rows that refer to this one: a count, and the latest of each date — "no shipment yet" is a count that is empty, never a guess.
  const aggregateJoins: NonNullable<DbOperationSpec["aggregateJoins"]> = [];
  for (const child of all) {
    if (joined.has(child.name)) continue;
    const keys = child.columns.filter((c) => c.fk?.table === e.name);
    if (keys.length !== 1) continue;
    const key = keys[0]!;
    const dates = child.columns.filter((c) => c !== key && c.type && DATE_TYPE.test(c.type));
    const aggs = [{ aggregate: "count" as const, alias: `${child.name}_count` }, ...dates.map((d) => ({ aggregate: "max" as const, column: d.name, alias: `${child.name}_latest_${d.name}` }))];
    aggregateJoins.push({ table: child.name, groupBy: key.name, onLeft: `${e.name}.${key.fk!.column}`, kind: "left", aggregates: aggs, filters: [], through: [] });
    for (const a of aggs) add(`${child.name}__totals.${a.alias}`, a.alias);
  }
  const spec: DbOperationSpec = { base: { ...(e.schema ? { schema: e.schema } : {}), table: e.name }, columns, joins, aggregateJoins, filters: [], having: [], sort: [] };
  return { spec, tables: [e.name, ...joins.map((j) => j.table), ...aggregateJoins.map((a) => a.table)] };
}

/** The tables a spec reads: its base, its joins, its summary joins — what a label's `expect.tables` is compared with. */
export function specTables(spec: unknown): string[] {
  const x = spec as Partial<DbOperationSpec> | undefined;
  if (!x?.base?.table) return [];
  return [x.base.table, ...(x.joins ?? []).map((j) => j.table), ...(x.aggregateJoins ?? []).map((a) => a.table)];
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Every table of one datasource as a typed reader. A table whose spec does not compile is left out and named in `skipped`. */
export function tableReaders(datasource: string, rows: SchemaRow[], dialect?: SqlDialect): { readers: TableReader[]; skipped: Array<{ table: string; why: string }> } {
  const all = entitiesOf(rows);
  const readers: TableReader[] = [];
  const skipped: Array<{ table: string; why: string }> = [];
  for (const e of all) {
    const { spec: whole, tables } = tableSpec(e, all);
    try {
      let spec = whole;
      let compiled = compileOperation(spec, rows, { dialect });
      let fields = operationFields(compiled.outputColumns, rows);
      /**
       * A column with NO declared type (a view's computed column in SQLite, which declares none) types as `Opaque`, and the engine
       * refuses a reader with any untyped part — so one such column used to hide the whole table from the builder (2026-10-01:
       * `v_time_account`, for its `balance`). It is left out of the reader, and the reader says so; the mock leaves it out too.
       */
      const untyped = Object.entries(fields).filter(([, t]) => noType(t)).map(([n]) => n);
      if (untyped.length) {
        spec = { ...whole, columns: whole.columns.filter((c) => !untyped.includes(c.alias)) };
        compiled = compileOperation(spec, rows, { dialect });
        fields = operationFields(compiled.outputColumns, rows);
      }
      const ref = `${datasource}${TABLE_REF}${e.schema && e.schema !== "public" ? `${e.schema}.` : ""}${e.name}`;
      const joinedTables = tables.slice(1).filter((t) => spec.joins.some((j) => j.table === t));
      const counted = tables.slice(1).filter((t) => spec.aggregateJoins?.some((a) => a.table === t));
      const about = `each row of the table \`${e.name}\`${joinedTables.length ? `, with the ${list(joinedTables)} row it refers to` : ""}${counted.length ? `; and how many ${list(counted)} rows refer to it (and their latest dates)` : ""}${untyped.length ? ` (without ${list(untyped)}: no declared type)` : ""}`;
      readers.push({ ref, datasource, table: e.name, tables, about, spec, sql: compiled.sql, sig: { kind: "operation", params: [], payload: T.rows(T.record(fields)) } });
    } catch (err) {
      skipped.push({ table: e.name, why: (err as Error).message.slice(0, 200) });
    }
  }
  return { readers, skipped };
}
