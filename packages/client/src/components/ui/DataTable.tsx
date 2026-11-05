// src/components/ui/DataTable.tsx — one table, with columns declared by ROLE.
//
// ── THE MEASURED PROBLEM (plan.md §0, D-94) ─────────────────────────────────
//
// Nine bespoke row grids in the tree today, no two agreeing, for the same shape
// of row:
//
//   /tools              grid-cols-[2.4fr_1.2fr_1.1fr_1.1fr_1.4fr_auto]
//   /data-sources       grid-cols-[1.8fr_1fr_2fr_1.3fr_auto]
//   /approvals          grid-cols-[1.4fr_1.4fr_1.3fr_2.4fr_auto]
//   /dashboard          grid-cols-[2fr_0.7fr_0.9fr_0.9fr_1.1fr]
//   /apps               grid-cols-[2fr_1.1fr_0.7fr_1.6fr_1fr_auto_auto]
//   /keys               grid-cols-[1.4fr_1.6fr_0.9fr_1fr_auto]   (and a second one)
//   /history            grid-cols-[1.1fr_1.5fr_3fr_0.9fr_auto]
//   /data-sources/[id]  grid-cols-[1.4fr_1.2fr_0.7fr_1fr]
//
// Each was written by someone who could not see the other eight. The fix is not a
// generic table — a `columns={[…]}` prop is the same nine templates with a shared
// renderer — it is a **closed list of named sets**, so the second page to show a
// secret finds the first page's answer instead of inventing a tenth grid.
//
// A page that genuinely needs a new shape adds a set HERE, where the next page
// can find it. That is the only supported way to get a new grid, and it is a
// deliberately visible edit.
//
// ⚠ The sets are grounded in the PAGES, not in the mock. The mock defines four
// and instantiates two (`cols-plugin` and `cols-run` are dead CSS), has no `tool`
// set at all, and overrides its own rule inline in 19 rows. D-94 has the counts.
"use client";

import type { ReactNode } from "react";

/**
 * The sets. Phase 2 opened with five; Phase 4 added `datasource` and `approval`
 * as their pages migrated, which is the intended way this list grows — a
 * deliberately visible edit, in the one file where the next page can find it.
 *
 * Each column carries a `key` (its ROLE — what the cell holds, not what the page
 * calls it) and a width. The page supplies the words; see `heads` below.
 *
 * ⚠ Order is owned here. A page cannot show `state` before `identity`, which is
 * the property that makes two pages showing secrets actually look alike.
 */
const SETS = {
  /**
   * A named, stored thing whose value is not readable: a secret, a data-source
   * sign-in. `/keys` needs this twice.
   */
  secret: {
    minWidth: "min-w-[720px]",
    grid: "grid-cols-[1.5fr_1.7fr_0.9fr_1fr_132px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "state", align: "start" },
      { key: "time", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /** A trigger: what it is, when it fires, what it hands over, whether it is armed. */
  trigger: {
    minWidth: "min-w-[680px]",
    grid: "grid-cols-[1.7fr_1.2fr_1fr_0.9fr_96px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "when", align: "start" },
      { key: "supplies", align: "start" },
      { key: "state", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * A connected app or engine plugin.
   *
   * ⚠ SIX columns, where the mock's unused `cols-plugin` has five. `/apps` shows
   * **Last checked** and the mock's grid has no slot for it. A column dropped in
   * silence is a fact the page stops telling, so the set grew instead (D-94).
   */
  /**
   * One capability the execution engine supplies — a task type, a trigger, a
   * runner.
   *
   * ⚠ **RESHAPED in ui-upgrade Phase 9, not added.** It used to be
   * `identity · auth · count · state · time · actions`, written for `/apps`'s
   * connected-app placeholder (`SEED_APPS`: ServiceNow, Jira, Microsoft 365 —
   * a sign-in method and an action count). That page and those rows are gone;
   * `/apps` now lists what the engine registers, which has no sign-in and no
   * action count and does have a plugin and a version. Keeping the old columns
   * would have meant padding two of them with "—", and D-94's own rule is that
   * a set which has to be padded is a set the page should not be using.
   *
   * `actions` is deliberately absent: installing a plugin is a deployment
   * change (D-85), so there is no per-row control and a column reserving space
   * for one would promise otherwise.
   */
  plugin: {
    minWidth: "min-w-[820px]",
    grid: "grid-cols-[1.8fr_1.8fr_0.8fr_1.2fr_1fr_0.8fr]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "kind", align: "start" },
      { key: "state", align: "start" },
      { key: "source", align: "start" },
      { key: "time", align: "start" },
    ],
  },
  /**
   * ONE capability, read INSIDE the plugin it belongs to.
   *
   * ⚠ Added rather than reusing `plugin`, and the difference is two columns.
   * `plugin` carries `source` (which plugin) and `time` (its version); once
   * you have opened Slack, both are constant down the whole table and belong in
   * the heading above it, not repeated on 45 rows. D-94's own rule is that a set
   * which has to repeat itself or be padded is the wrong set — so `/apps` uses
   * `plugin` for a search ACROSS plugins, where the source genuinely varies, and
   * this one for the drill-in.
   *
   * No `actions`: installing a plugin is a deployment change (D-85), and there
   * is nothing to do to a capability from here.
   */
  capability: {
    minWidth: "min-w-[640px]",
    grid: "grid-cols-[1.6fr_2fr_0.8fr_1.2fr]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "kind", align: "start" },
      { key: "state", align: "start" },
    ],
  },
  /**
   * One run in a list of runs: when, the workflow it belongs to (name and id,
   * as separate columns), the run's own id, what happened, and what you can do.
   *
   * ⚠ RESHAPED for flow-history-name-snapshot User Story 4/6: `subject` (name +
   * id stacked in one cell) split into `workflowName`/`workflowId`, `duration`
   * dropped in favor of a `runId` column, and `summary` renamed `status` (the
   * badge text also changed — see history/page.tsx's `actionBadge`). Time taken
   * still renders, inside the Details modal, so nothing here is a data loss —
   * see the spec's User Story 4/6 acceptance scenarios.
   */
  run: {
    minWidth: "min-w-[860px]",
    grid: "grid-cols-[110px_1.3fr_140px_140px_0.6fr_88px]",
    columns: [
      { key: "time", align: "start" },
      { key: "workflowName", align: "start" },
      { key: "workflowId", align: "start" },
      { key: "runId", align: "start" },
      { key: "status", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * A registered database: its name, the engine, whether it answers, when it
   * last answered, and what you can do to it.
   *
   * ⚠ RESHAPED in the D-21 round to the new frozen mock's columns:
   * Name / Engine / Status / Last tested / Actions. The `tables` role is gone
   * with it — the list endpoint carries no per-connection schema count, and
   * D-94's own rule is that a set which has to be padded with "—" is a set the
   * page should not be using. The `auth` role (the credential's env-var NAME,
   * "Injected as") stays dropped from the row — it survives on the detail
   * page, which is where the manifest identifier matters.
   */
  datasource: {
    minWidth: "min-w-[700px]",
    grid: "grid-cols-[1.6fr_1fr_0.9fr_1.2fr_128px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "kind", align: "start" },
      { key: "state", align: "start" },
      { key: "time", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * A decision waiting for a person: since when, on what, of which kind, about
   * what.
   *
   * ⚠ Added in Phase 4 rather than bending `run` to fit, and the difference is
   * one role: an approval has a **kind** (a gate, or an agent's question) and no
   * duration, because it has not finished — that is the whole reason it is on
   * the screen. Reusing `run` would have meant a `duration` column reading "—"
   * on every row, which is a set being padded to fit rather than chosen, and a
   * `kind` fact with nowhere to go. D-94's rule: a page needing a shape adds it
   * here, where the next page can find it.
   */
  approval: {
    minWidth: "min-w-[760px]",
    grid: "grid-cols-[1.4fr_1.4fr_1.3fr_2.4fr_96px]",
    columns: [
      { key: "time", align: "start" },
      { key: "subject", align: "start" },
      { key: "kind", align: "start" },
      { key: "summary", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * A per-subject rollup: one line of aggregate about a thing, over a window.
   *
   * ⚠ **The one set with NO actions column** (D-98). Everything else here is a
   * list of things you operate; this is a list of things you have MEASURED, and
   * there is nothing to do to a row of it. An `actions` role padded with an empty
   * cell would be a column that exists to satisfy a rule — and the rule (actions
   * go last, right-aligned) is about consistency where actions exist, not about
   * every table having some.
   */
  rollup: {
    minWidth: "min-w-[560px]",
    grid: "grid-cols-[2fr_0.7fr_0.9fr_0.9fr_1.1fr]",
    columns: [
      { key: "identity", align: "start" },
      { key: "count", align: "start" },
      { key: "rate", align: "start" },
      { key: "duration", align: "start" },
      { key: "time", align: "start" },
    ],
  },
  /**
   * One column of an introspected table: its name, its type, whether it may be
   * null, what key it is.
   *
   * ⚠ Narrow on purpose — this renders inside a dialog, not across a page. A
   * column is a fact about someone else's database, so nothing here changes it;
   * the one thing a person may do is DECLARE what it holds (`holds`: an email
   * address, P5-I11) — a statement Foundry keeps, never a write to the database.
   */
  column: {
    minWidth: "min-w-[520px]",
    grid: "grid-cols-[1.4fr_1.1fr_0.6fr_1fr_1.1fr]",
    columns: [
      { key: "identity", align: "start" },
      { key: "kind", align: "start" },
      { key: "nullable", align: "start" },
      { key: "keyRole", align: "start" },
      { key: "holds", align: "start" },
    ],
  },
  /**
   * A callable tool: its name, one line of description, how it signs in, its
   * parameters as chips, how many automations use it, and what you can do to it.
   *
   * ⚠ RESHAPED in Phase 3 to the frozen mock's columns (D-02):
   * Name / Description / Auth / Parameters / Used by / Actions. The App and
   * Type columns are gone — App was derived from the endpoint's host and every
   * tool in a workspace mostly shared one host, and Type was derived from the
   * method; neither carried a fact the row did not already state. The freed
   * weight goes to Description and Parameters, which the mock puts on the row
   * (they used to live only in the expanded detail).
   *
   * ⚠ `usedBy` is BACK, and only because the data is real (Phase 7, I-104
   * landing). It was removed in platform-coherence Phase 2.3 because
   * `toolFromFA` hardcoded "—" on every row — a header promising information
   * nobody was going to get. The server now computes the count (distinct flows
   * referencing the tool, from `flow_steps.manifest_refs_json`), so the column
   * renders a number, and the "—" a zero-count row shows is a rendering of a
   * genuine zero, not a placeholder. `ui-honesty-check.sh` pins the page to the
   * real `usedBy` field and to the `> 0` guard that makes the dash data-derived.
   */
  tool: {
    minWidth: "min-w-[960px]",
    grid: "grid-cols-[1.4fr_2fr_0.9fr_1.6fr_0.6fr_128px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "auth", align: "start" },
      { key: "params", align: "start" },
      { key: "usedBy", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * A governed resource: datasource, connector or tool. `S-48` — pack 09.
   *
   * ⚠ SEVEN columns; the pack's order is NAME · TYPE · STATUS · OWNER ·
   * DEPENDENTS · HEALTH · ⋯. `HEALTH` is a chip with variable-length text,
   * not a bare word (S-48 § Layout — opposite to S-37's RISK). `DEPENDENTS`
   * is "N workflows" with the unit in the cell (pack 09, build-guide rule 10:
   * derive what is derivable). `NAME` may carry a `Not visible to AI` badge
   * line (spec § Two rules).
   *
   * No counts on the tabs; no result count line — unlike S-28 (S-48 § Layout).
   * The set lives here so the next resource screen can find it (D-94).
   */
  resource: {
    minWidth: "min-w-[980px]",
    grid: "grid-cols-[1.7fr_1.1fr_0.9fr_1.1fr_0.9fr_1.4fr_40px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "kind", align: "start" },
      { key: "state", align: "start" },
      { key: "owner", align: "start" },
      { key: "count", align: "start" },
      { key: "health", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /**
   * The published field mapping of a resource — S-52.
   *
   * Four columns: Source field · Type · Mapped field · AI visibility (per field).
   * AI visibility is plain words Masked/Mock (no badge chrome, S-52 § Open).
   * This is the one place the per-field safety guarantee is legible — collapsing
   * it to a resource-level flag loses the guarantee.
   */
  mapping: {
    minWidth: "min-w-[640px]",
    grid: "grid-cols-[1.2fr_0.9fr_1.2fr_1fr]",
    columns: [
      { key: "identity", align: "start" },
      { key: "kind", align: "start" },
      { key: "meaning", align: "start" },
      { key: "safety", align: "start" },
    ],
  },
  /** An incident: what it is, how bad, where it is in its lifecycle, who owns it. */
  incident: {
    minWidth: "min-w-[900px]",
    grid: "grid-cols-[1.4fr_1.6fr_1fr_1fr_1.1fr_120px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "state", align: "start" },
      { key: "time", align: "start" },
      { key: "subject", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
  /** One publish gate: what it is, what satisfies it, whether it blocks. */
  gate: {
    minWidth: "min-w-[820px]",
    grid: "grid-cols-[1.5fr_2.6fr_1fr_150px]",
    columns: [
      { key: "identity", align: "start" },
      { key: "meaning", align: "start" },
      { key: "state", align: "start" },
      { key: "actions", align: "end" },
    ],
  },
} as const;
export type ColumnSet = keyof typeof SETS;
export const COLUMN_SETS = SETS;

/** The roles a given set declares — `"identity" | "meaning" | …`. */
export type Role<S extends ColumnSet> = (typeof SETS)[S]["columns"][number]["key"];

/**
 * One row's content, keyed by role.
 *
 * Keyed rather than positional on purpose: a positional tuple lets a page pass
 * the right NUMBER of cells in the wrong order, and the result is a table that
 * looks fine until you read it.
 */
export type Cells<S extends ColumnSet> = Record<Role<S>, ReactNode>;

export type DataRow<S extends ColumnSet> = {
  /** Stable across reloads — an id, never an array index. */
  key: string;
  cells: Cells<S>;
  /**
   * A full-width panel under this row, when the row is expanded.
   *
   * ⚠ **`DataTable` holds no expansion state, deliberately.** The page passes
   * `detail` only for the rows it wants open, so "which row is expanded" lives
   * in the page — the same seam rule the canvas follows (it reports intents and
   * never writes). A table owning its own open/closed set would be a second
   * place that decides what a page shows.
   *
   * ⚠ It is NOT an escape hatch for more columns. It spans the whole row and is
   * outside the grid, so nothing put here can line up with a heading — which is
   * precisely what stops it becoming the free-form template the named sets
   * replaced. `/tools` uses it for parameter chips and the endpoint.
   */
  detail?: ReactNode;
};

/**
 * A collection, in the set's shape.
 *
 * `heads` gives each role its word ON THIS PAGE. `/keys` calls the `time` column
 * *"Last used"* and a data-source table calls it *"Checked"*; those are different
 * facts and the system has no business picking one. What the system does own is
 * that `time` is the fourth column in both.
 *
 * `empty` is REQUIRED. A collection with nothing in it has to say why — several
 * of the nine grids this replaces render an empty box and leave the reader to
 * decide whether that means "none yet" or "it failed".
 *
 * ⚠ There is no `href` or `onClick` on a row. The mock styles `a.tr`/`button.tr`,
 * which puts the actions cell's buttons inside the row's own interactive element:
 * invalid HTML, and a tab order nobody can use. Put the link in the identity cell.
 */
export function DataTable<S extends ColumnSet>({
  set,
  heads,
  rows,
  empty,
  caption,
  className = "",
  maxHeight,
}: {
  set: S;
  heads: Record<Role<S>, string>;
  rows: readonly DataRow<S>[];
  empty: ReactNode;
  /** Names the table for a screen reader. Required — "a table" is not a name. */
  caption: string;
  className?: string;
  /**
   * Cap the table's height and scroll the rows inside it, keeping the header
   * fixed — e.g. `"32rem"`.
   *
   * ⚠ **Opt-in, and it must stay opt-in.** Most tables in this product are short
   * and a scroll region around six rows is a worse read than six rows. The case
   * this exists for is a table whose length is set by someone else's data:
   * `/apps` renders one row per class a plugin registers, which is **102 for
   * `core` and 45 for Slack** on this engine — a page that scrolls for a full
   * screen and buries everything under it.
   *
   * ⚠ The header goes `sticky` and becomes OPAQUE when this is set. It is
   * normally a 40%-alpha tint, which is correct over the card and wrong over
   * rows sliding underneath it — the column names would be legible through the
   * data and vice versa.
   */
  maxHeight?: string;
}) {
  const spec = SETS[set];
  const columns = spec.columns as readonly { key: Role<S>; align: "start" | "end" }[];
  const rowClass = `grid items-center gap-4 px-5 ${spec.grid}`;
  const scrolls = Boolean(maxHeight);

  return (
    <div
      className={`${scrolls ? "overflow-auto" : "overflow-x-auto"} rounded-lg border border-line bg-surface ${className}`}
      style={scrolls ? { maxHeight } : undefined}
    >
      <div className={spec.minWidth} role="table" aria-label={caption} data-set={set}>
        <div
          role="row"
          className={`${rowClass} border-b border-line py-3 text-caption uppercase tracking-label text-dim ${
            scrolls ? "sticky top-0 z-10 bg-surface-2" : "bg-surface-2/40"
          }`}
        >
          {columns.map((c) => (
            <span key={c.key} role="columnheader" className={c.align === "end" ? "text-right" : ""}>
              {heads[c.key]}
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-muted">{empty}</div>
        ) : (
          rows.map((r) => (
            // The border moves to the GROUP when a row has a detail panel open,
            // so the panel reads as part of its row rather than as the next one.
            <div key={r.key} className="border-b border-line last:border-0">
              <div role="row" className={`${rowClass} py-3 text-sm`}>
                {columns.map((c) => (
                  <span
                    key={c.key}
                    role="cell"
                    className={c.align === "end" ? "flex items-center justify-end gap-2" : "min-w-0"}
                  >
                    {r.cells[c.key]}
                  </span>
                ))}
              </div>
              {r.detail && (
                <div className="border-t border-line bg-surface-2/40 px-5 py-3">{r.detail}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
