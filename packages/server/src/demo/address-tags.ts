/**
 * The demo databases' ADDRESS columns, declared as the schema owner declares them (compiled-builder I-278 / I-283).
 *
 * A column is an `Address` to the engine only by a tag its owner declared — `COMMENT ON COLUMN … IS 'foundry:tag=email'`, read by
 * introspection into `schemas.semantic_tag` — never by its name. `fleet_demo` declares its own (heldout/fleet.ts); the tuned demo
 * databases declared none, so every `*_email` column there was plain `Text`, and no build could send one message per row to the
 * people in the data (I-283, owed since phase 2 and measured as 7 of 16 buildable goals failing for it, 2026-09-27).
 *
 * ⚠ Metadata only: a column comment changes no row and no query result, so the oracles and the traps are untouched.
 * ⚠ It never overwrites a comment it did not write — a comment somebody else put there is theirs, and it is refused by name.
 * ⚠ `hr_demo` IS listed, by the person's decision (D-325, 2026-09-27): the standing rule is not to touch the HR demo dataset, and a
 *   column comment was ruled not to count — it changes no row, no trap and no oracle; `demo:verify` and `demo:rehearse` re-prove it.
 *   `hr_demo_alt` has no email column at all.
 */
import type { Client } from "pg";

export const EMAIL_TAG = "foundry:tag=email";
/** A row's identity — what a dedupe key must be (the `Key` type): one incident, never a word typed for all of them. */
export const KEY_TAG = "foundry:tag=key";

/** Database → `table.column` of every column that holds an email address, by reading each seed's own DDL. */
export const ADDRESS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  hr_demo: ["employees.work_email"],
  finance_demo: ["cost_centres.owner_email", "employees.work_email", "vendors.contact_email"],
  itops_demo: ["incidents.assignee_email", "on_call.person_email", "teams.contact_email", "teams.escalation_email"],
  support_demo: ["agents.work_email", "customers.email", "teams.contact_email"],
  orders_demo: ["customers.email", "warehouses.contact_email"],
  hiring_demo: ["candidates.email", "recruiters.work_email", "requisitions.hiring_manager_email"],
  legal_demo: ["contracts.owner_email", "counterparties.contact_email", "obligations.owner_email"],
};

/** Database → `table.column` of every column that IS its row's identity, as the paging service dedupes on it (`dedupe_key`). */
export const KEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  itops_demo: ["incidents.incident_code"],
};

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

/**
 * Declare the address and row-identity tags of `db` over an OWNER connection. Returns what it set and what was already set; throws, naming the column,
 * when a column holds a comment this module did not write.
 */
export async function applyColumnTags(client: Client, db: string): Promise<{ set: string[]; already: string[] }> {
  const set: string[] = [];
  const already: string[] = [];
  const declared: Array<[string, string]> = [...(ADDRESS_COLUMNS[db] ?? []).map((c) => [c, EMAIL_TAG] as [string, string]), ...(KEY_COLUMNS[db] ?? []).map((c) => [c, KEY_TAG] as [string, string])];
  for (const [tc, tag] of declared) {
    const [table, column] = tc.split(".").map(ident) as [string, string];
    const { rows } = await client.query(
      `select col_description(c.oid, a.attnum) as d from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid where n.nspname = 'public' and c.relname = $1 and a.attname = $2`,
      [table, column],
    );
    if (!rows.length) throw new Error(`${db}: no column public.${tc}`);
    const current = rows[0].d as string | null;
    if (current === tag) { already.push(tc); continue; }
    if (current !== null) throw new Error(`${db}.${tc} already has a comment this module did not write: ${JSON.stringify(current)}`);
    await client.query(`COMMENT ON COLUMN public.${table}.${column} IS '${tag}'`);
    set.push(tc);
  }
  return { set, already };
}
