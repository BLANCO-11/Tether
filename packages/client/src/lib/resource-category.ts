/**
 * A resource's CATEGORY — the one definition, per 05-data-model.md § Resource.
 *
 * Derived from `connector_id`, never stored, exactly as the pack's
 * ResourceType → ResourceCategory mapping describes it.
 *
 * ⚠ **This lives in `lib/` because it now has two callers.** It began inside
 * `app/(app)/resources/page.tsx`, where the list uses it for the `?type=` tabs;
 * `app/(app)/resources/[id]/page.tsx` needs the same answer to decide whether a
 * resource gets the Schema and DB operations panes. Two copies of a predicate
 * like this drift in the silent direction — the list keeps calling something a
 * datasource while the detail page stops showing it the panes that make it one.
 * There is one definition and both import it.
 *
 * ⚠ **Category is NOT "can this be introspected".** Amazon S3 and SFTP are
 * datasources and cannot host a named query — only `postgres`/`mysql` can, which
 * is the server's `schemaIntrospectorService.supports()` set. That is deliberately
 * NOT re-decided here: a second engine-specific rule in the client is a mirror
 * that can drift from the server without anything reporting it. The panes handle
 * it by degrading honestly instead — an empty schema tree says nothing was
 * discovered, and the operations builder refuses to open without a schema and
 * says why. A refusal a person can read beats a pane that quietly is not there.
 */
import type { Connection } from "./types";

export type ResourceCategory = "datasource" | "connector" | "tool";

export const VALID_RESOURCE_TYPES: readonly ResourceCategory[] = [
  "datasource",
  "connector",
  "tool",
] as const;

/**
 * ⚠ Order is load-bearing: connector is tested before tool, so an id carrying
 * both words resolves the way the list has always resolved it. Reordering these
 * branches is a behaviour change, not a tidy-up.
 */
export function categoryFor(conn: Connection): ResourceCategory {
  const id = (conn.connector_id ?? "").toLowerCase();
  if (id.includes("email") || id.includes("rest") || id.includes("slack") || id.includes("connector")) {
    return "connector";
  }
  if (id === "tool" || id.includes("tool") || id.includes("app")) return "tool";
  return "datasource";
}

/** Does this resource get the schema / DB-operations panes? */
export function isDatasourceResource(conn: Connection): boolean {
  return categoryFor(conn) === "datasource";
}
