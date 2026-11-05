/**
 * Tags a named query's OWNER declares on its result columns (compiled-builder, 2026-09-27).
 *
 * A column comment (`foundry:tag=…`) reaches a query's result only where the database can name a source column. A COMPUTED
 * column — `COALESCE(team.escalation_email, org.fallback) AS notify_email` — has none, so it described as untagged text and no
 * build could send by it. The query's owner states it instead, beside the SQL, exactly as a schema owner states a column's.
 *
 * ⚠ Declared, never inferred: nothing here reads a column NAME. A tag is refused (by name) when the query does not return that
 *   column, when the column is not of the tag's kind (text for an address or a key, a number for minor units), or when the database's own tag says otherwise — a declaration may fill a silence,
 *   never contradict the schema.
 * ⚠ Not in the ref fingerprint, like `described_json`: it changes what TYPES a flow checks against, not what runs.
 */
import type { DescribedQuery } from "./introspect/types.js";

export const QUERY_COLUMN_TAG_VALUES = ["email", "key", "minor_units"] as const;
export type QueryColumnTag = (typeof QUERY_COLUMN_TAG_VALUES)[number];

const TEXT = /^(text|character varying|varchar|char|character|citext|name|bpchar)/i;
const NUMBER = /^(smallint|integer|int|bigint|int2|int4|int8|numeric|decimal|real|double|float|money)/i;
/** What each tag refines: an address and an identity are text; an amount in minor units (cents) is a number. */
const FITS: Record<QueryColumnTag, { re: RegExp; what: string }> = { email: { re: TEXT, what: "text" }, key: { re: TEXT, what: "text" }, minor_units: { re: NUMBER, what: "a number" } };
const fitsTag = (tag: string, type: string) => FITS[tag as QueryColumnTag]?.re.test(type) ?? false;

/** The described columns with the declared tags filled in, and every declaration that could not be honoured. */
export function withDeclaredTags(
  columns: DescribedQuery["columns"],
  declared: Record<string, string> | null | undefined,
): { columns: DescribedQuery["columns"]; problems: string[] } {
  const problems: string[] = [];
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const [name, tag] of Object.entries(declared ?? {})) {
    const c = byName.get(name);
    if (!(QUERY_COLUMN_TAG_VALUES as readonly string[]).includes(tag)) problems.push(`\`${name}\`: “${tag}” is not a tag (${QUERY_COLUMN_TAG_VALUES.join(", ")})`);
    else if (!c) problems.push(`\`${name}\` is declared a ${tag} but the query returns no such column`);
    else if (!fitsTag(tag, c.type)) problems.push(`\`${name}\` is declared a ${tag} but it is ${c.type}, not ${FITS[tag as QueryColumnTag].what}`);
    else if (c.tag && c.tag !== tag) problems.push(`\`${name}\` is declared a ${tag} but its source column says ${c.tag}`);
  }
  const ok = (name: string) => { const t = declared?.[name]; const c = byName.get(name)!; return t && (QUERY_COLUMN_TAG_VALUES as readonly string[]).includes(t) && fitsTag(t, c.type) && (!c.tag || c.tag === t) ? t : null; };
  return { columns: columns.map((c) => (c.tag ? c : ok(c.name) ? { ...c, tag: ok(c.name) } : c)), problems };
}
