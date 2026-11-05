"use client";

/**
 * Mock-data readiness for one datasource, off the fixture row.
 *
 * Three real states — `building`, `ready`, `failed` — plus "no fixture row
 * yet" (null status: never onboarded, distinct from failed). An unreadable
 * read is its own fourth state: "could not be read" is never rendered as any
 * of the other three.
 *
 * ⚠ **There IS a rebuild button now — 2026-09-17.** This said rebuilding was
 * CLI/ops-triggered "deliberately: a rebuild drops and regenerates rows, so
 * there is no browser rebuild button here — only the sentence saying so."
 *
 * Dropping and regenerating rows is a reason to CONFIRM, not a reason to
 * withhold. What the sentence actually produced was a dead end: a datasource
 * whose build had failed showed a red panel, told the reader test runs would
 * refuse until it was fixed, and then offered no way to fix it short of shell
 * access to the server. That is worse than the risk it was avoiding — these are
 * rows generated from the SCHEMA ALONE (D-54), so a rebuild destroys nothing
 * anybody authored and no production data is involved either way.
 *
 * The button asks first, reports what the server actually answered, and is
 * `datasources.write` at the route — the same tier as `/schema/refresh`, which
 * is the closest analogue.
 *
 * `bare` renders the status sentences without the card shell, for surfaces
 * that own the card themselves (the datasource detail page merges this status
 * line and the mock-rows viewer under one "Mock data — never production"
 * header instead of stacking two near-identical cards).
 */

import { useState } from "react";
import { getDatasourceMock, rebuildDatasourceMock } from "@/lib/api";
import { useAsync } from "@/lib/hooks";

/**
 * Why a rebuild did not start, in the reader's words.
 *
 * ⚠ Every one of these is a STATE of the datasource, not a failure of the
 * request, and the server returns them with a 200 for that reason. Rendering
 * them as "rebuild failed" would send somebody to retry a button that can never
 * work on this datasource.
 *
 * ⚠ An unrecognised `why` falls back to naming the raw code rather than to a
 * friendly sentence. A build this screen has never heard of must not read as one
 * it understands, and the code is the thing worth pasting into a bug report.
 */
function declineText(why: string): string {
  switch (why) {
    case "already_building":
      return "A build is already running for this source.";
    case "not_postgres":
      return "Mock data is only built for PostgreSQL and SQLite sources.";
    case "no_schema":
      return "This source has no introspected schema yet — refresh the schema first.";
    case "unsupported_shape":
      return "The schema holds a column type the mock generator cannot represent.";
    default:
      return `The build did not start (${why}).`;
  }
}

export function MockPanel({
  datasourceId,
  bare,
  tableCount,
}: {
  datasourceId: string;
  bare?: boolean;
  /**
   * How many tables the rebuild covers, for the LABEL only — see the control
   * below. Optional because the count is the page's to know, not this panel's:
   * `MockPanel` reads the fixture's status and has no table list of its own, and
   * fetching one here would be a second reader of the schema that could
   * disagree with the viewer beneath it.
   */
  tableCount?: number;
}) {
  const { data, loading, error, reload } = useAsync(() => getDatasourceMock(datasourceId), [datasourceId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  /**
   * ⚠ **The label names the SCOPE, because the control's scope was being
   * misread — 2026-09-17.** Reported from use as *"we only regenerate using a
   * button for a selected table"*. It never was: `POST /:dsId/mock/rebuild` is
   * the only mock route in the product and it takes no table, rebuilding the
   * whole fixture from the whole schema.
   *
   * What made it read that way is the layout rather than the words. This panel
   * renders directly above `MockViewer`, whose first control is a `Table ▾`
   * picker — so "Rebuild mock data" sat one line above a table selector and was
   * taken to mean the selected one.
   *
   * ⚠ **A second, table-scoped control was the wrong answer** and is deliberately
   * not what this is: a per-table rebuild would need its own route, and a
   * fixture rebuilt one table at a time has no single fingerprint and no moment
   * at which it is coherent — `generateMockRows` seeds foreign keys ACROSS
   * tables, so regenerating a child alone detaches it from a parent that was not
   * regenerated. The capability was never missing; only the sentence was.
   */
  // ⚠ ONE spelling of the scope, shared by the label and the confirmation.
  // Written twice first, and they drifted immediately — the label said
  // "1 tables" while the confirm said "1 table". A control whose button and
  // whose confirmation describe different things is worse than either.
  const scope =
    tableCount == null ? "this source" : `all ${tableCount} table${tableCount === 1 ? "" : "s"}`;

  const rebuild = async () => {
    // ⚠ Confirmed, because it discards the current fixture. Not guarded beyond
    // that: the rows are generated from the schema alone, so there is nothing
    // here a person authored and nothing from production to lose.
    if (
      !window.confirm(
        `Rebuild the mock data for ${scope}? The current mock rows are replaced.`,
      )
    )
      return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await rebuildDatasourceMock(datasourceId);
      // ⚠ The server's own answer, not an assumption that pressing the button
      // worked. A decline is the common case on a source that cannot have a mock.
      setNote(
        outcome.started
          ? { tone: "ok", text: `Mock data rebuilt (version ${outcome.version}).` }
          : { tone: "warn", text: declineText(outcome.why) },
      );
    } catch (e) {
      setNote({ tone: "warn", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      // Re-read regardless: a build that started changed the row, and one that
      // declined may have done so because another already had.
      reload();
    }
  };

  /**
   * ⚠ ONE control, rendered by every state that can have one — including
   * `failed`, which is the state it exists for. Four copies of a button is four
   * chances for one of them to stop matching the others (the `spliceApproval`
   * argument), and the state where it is most needed is the one most likely to
   * be forgotten.
   */
  const rebuildControl = (
    <button
      type="button"
      onClick={rebuild}
      disabled={busy}
      className="text-accent hover:underline disabled:cursor-not-allowed disabled:text-dim"
    >
      {busy ? "Rebuilding…" : tableCount == null ? "Rebuild mock data" : `Rebuild mock data for ${scope}`}
    </button>
  );

  let body: React.ReactNode;
  if (loading) {
    body = <p className="mt-2 text-sm text-muted">Checking mock data…</p>;
  } else if (error) {
    body = (
      <p className="mt-2 text-sm text-warn">
        Mock state could not be read — so this is not “no mock data”, the check did not run. ({error}){" "}
        <button type="button" onClick={reload} className="text-accent hover:underline">
          Try again
        </button>
      </p>
    );
  } else if (!data || data.status === null) {
    body = (
      <>
        <p className="mt-2 text-sm text-muted">
          No mock data has been built for this source yet. Test runs refuse until one is — they never
          silently read production.
        </p>
        <p className="mt-2 text-xs text-muted">
          Mock data is built at onboarding from the schema alone. {rebuildControl}
        </p>
      </>
    );
  } else if (data.status === "building") {
    body = (
      <>
        <p className="mt-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
          Building mock data from the schema alone — around two minutes. Until it lands, test runs
          refuse rather than read production.
        </p>
        <p className="mt-2 text-xs text-muted">{rebuildControl}</p>
      </>
    );
  } else if (data.status === "failed") {
    body = (
      <>
        <p className="mt-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-xs text-danger">
          <strong>The mock data could not be built.</strong> {data.error ?? "No reason was recorded."}{" "}
          Test runs refuse until this is fixed — they never silently read production.
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
          {rebuildControl}
          <button type="button" onClick={reload} className="text-accent hover:underline">
            Check again
          </button>
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p className="mt-2 text-sm text-muted">
          Mock data is ready
          {data.version != null ? (
            <>
              {" "}(version <span className="font-mono">{data.version}</span>)
            </>
          ) : (
            ""
          )}{" "}
          — generated from the schema alone, never from production rows. Test runs read this copy.
        </p>
        <p className="mt-2 text-xs text-muted">{rebuildControl}</p>
      </>
    );
  }

  // ⚠ What the SERVER said, rendered under every state rather than per branch.
  // `warn` covers both a decline and a thrown error: neither is a success, and
  // the text already distinguishes them.
  const withNote = (
    <>
      {body}
      {note && (
        <p className={`mt-2 text-xs ${note.tone === "ok" ? "text-muted" : "text-warn"}`}>{note.text}</p>
      )}
    </>
  );

  if (bare) return withNote;
  return (
    <section aria-label="Mock data" className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-body font-semibold text-text">Mock data</h2>
      {withNote}
    </section>
  );
}
