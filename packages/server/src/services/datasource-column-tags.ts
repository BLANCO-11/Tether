/**
 * Tags a datasource's OWNER declares on its table and view columns (builder-stability 2026-10-02, P5-I11).
 *
 * A column is an ADDRESS (or a key, or an amount in minor units) only by declaration — never by its name, never by its values.
 * Postgres declares it in the schema (`COMMENT … 'foundry:tag=email'`); SQLite has no column comments, so no SQLite column could
 * ever be an address and no per-person send over one could be built. The owner states it here instead, keyed
 * `[schema.]table.column` — the same vocabulary and the same checks as a named query's `column_tags` (`query-column-tags.ts`),
 * because they are the same statement about a column.
 *
 * ⚠ A declaration fills a silence and never contradicts the schema: a column the schema already tags keeps its own tag.
 * ⚠ A VIEW column whose ORIGIN is a declared table column carries the tag too — the view states no tag of its own
 *   (`v.manager_email` selected from `employee.email`), exactly as a declared flag reaches a view (`viewFlags`).
 */
import type { IntrospectedEntity } from "./introspect/types.js";
import { withDeclaredTags } from "./query-column-tags.js";

/** A column's declaration key. */
export const columnKey = (entity: { name: string; schema?: string | null }, column: string) =>
  `${entity.schema ? `${entity.schema}.` : ""}${entity.name}.${column}`;

/** A column as a declaration is checked against: its key, its type, and the tag the SCHEMA gave it (not a declaration's). */
export interface DeclarableColumn { key: string; type: string; tag: string | null }

/** Every declaration that cannot be honoured, as a sentence naming the column — the same checks a query's tags pass. */
export function columnTagProblems(columns: readonly DeclarableColumn[], declared: Record<string, string> | null | undefined): string[] {
  return withDeclaredTags(columns.map((c) => ({ name: c.key, type: c.type, nullable: true, tag: c.tag })), declared).problems;
}

/**
 * The introspected entities with the declarations applied: a declared column takes its tag (when it fits and the schema is
 * silent), then every view column whose origin took one takes it too. Returns the problems, so a refresh can say what it skipped.
 */
export function applyColumnTags(entities: IntrospectedEntity[], declared: Record<string, string> | null | undefined): string[] {
  if (!declared || !Object.keys(declared).length) return [];
  const cols = entities.flatMap((e) => e.columns.map((c) => ({ e, c, key: columnKey(e, c.name) })));
  const { columns, problems } = withDeclaredTags(cols.map(({ c, key }) => ({ name: key, type: c.type, nullable: c.nullable, tag: c.tag ?? null })), declared);
  const tagOf = new Map(columns.map((c) => [c.name, c.tag ?? null]));
  for (const { c, key } of cols) if (!c.tag && tagOf.get(key)) c.tag = tagOf.get(key)!;
  // Through views: a view column with no tag of its own takes its origin's.
  for (const { e, c } of cols) {
    if (c.tag || !c.origin) continue;
    const from = entities.find((x) => x !== e && x.name === c.origin!.table && (c.origin!.schema == null || x.schema === c.origin!.schema))?.columns.find((x) => x.name === c.origin!.column);
    if (from?.tag) c.tag = from.tag;
  }
  return problems;
}
