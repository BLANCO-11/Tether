"use client";

/**
 * The mock-data viewer: paged mock rows for one table, ten at a time.
 *
 * The banner is the point — "mock data — never production" — stated on the
 * surface itself rather than in a docblock, because a grid of plausible rows
 * is exactly what production looks like. There is no prod preview anywhere on
 * this surface, and no control here fetches one: the only read is
 * `getDatasourceMockRows`.
 *
 * A native `<table>`, not `DataTable`: mock columns are dynamic per table
 * (whatever the introspected schema holds), and a named fixed-column set for
 * unknown columns would be padding by construction.
 */

import { useState } from "react";
import { getDatasourceMockRows } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";

const PAGE_SIZE = 10;

export function MockViewer({ datasourceId, tables, bare }: { datasourceId: string; tables: string[]; bare?: boolean }) {
  const [table, setTable] = useState(tables[0] ?? "");
  const [page, setPage] = useState(0);
  const current = tables.includes(table) ? table : (tables[0] ?? "");

  const { data, loading, error, reload } = useAsync(
    () => (current ? getDatasourceMockRows(datasourceId, current, page, PAGE_SIZE) : Promise.resolve(null)),
    [datasourceId, current, page],
  );

  if (tables.length === 0) {
    const empty = <p className="mt-2 text-sm text-muted">No tables have been introspected yet, so there is nothing to show.</p>;
    if (bare) return <>{empty}</>;
    return (
      <section aria-label="Mock data viewer" className="min-w-0 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-body font-semibold text-text">Mock data — never production</h2>
        {empty}
      </section>
    );
  }

  const rows = data?.rows ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // min-w-0: this card is a flex item of the detail page's right column, whose
  // default min-width:auto let wide tables push the card past its track — the
  // table "leaking" past the card edge. Contained here, the inner overflow
  // scrolls instead.
  const body = (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="mock-table" className="text-xs text-muted">
          Table
        </label>
        <select
          id="mock-table"
          value={current}
          onChange={(e) => {
            setTable(e.target.value);
            setPage(0);
          }}
          className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-text"
        >
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {total > 0 && (
          <span className="text-xs text-muted">
            {total} row{total === 1 ? "" : "s"} · page {page + 1} of {pageCount}
          </span>
        )}
      </div>

      <div className="mt-3">
        {loading && <p className="text-xs text-muted">Loading mock rows…</p>}
        {error && (
          <p className="text-xs text-warn">
            Mock rows could not be read — so this is not “no rows”, the check did not run. ({error}){" "}
            <button type="button" onClick={reload} className="text-accent hover:underline">
              Try again
            </button>
          </p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="text-sm text-muted">No mock rows were generated for this table.</p>
        )}
        {!loading && !error && rows.length > 0 && (
          <div className="max-w-full overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-left tabular-nums" aria-label={`Mock rows of ${current}`}>
              <thead>
                <tr className="border-b border-line bg-surface-2/40">
                  {columns.map((c, ci) => (
                    <th
                      key={c}
                      scope="col"
                      className={`whitespace-nowrap px-3 py-2 font-mono text-caption uppercase tracking-label text-dim${ci === 0 ? " sticky left-0 bg-surface-2" : ""}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${page}-${i}`} className="border-b border-line last:border-0">
                    {columns.map((c, ci) => {
                      const v = (r as Record<string, unknown>)[c];
                      return (
                        <td key={c} className={`max-w-[240px] truncate whitespace-nowrap px-3 py-2 font-mono text-xs${ci === 0 ? " sticky left-0 bg-surface" : ""}`}>
                          {v == null ? <span className="text-dim">—</span> : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pageCount > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );

  if (bare) return body;
  return (
    <section aria-label="Mock data viewer" className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-body font-semibold text-text">Mock data — never production</h2>
      <p className="mt-1 text-xs text-muted">
        Generated rows for design-time testing. They share the schema, never the records.
      </p>
      {body}
    </section>
  );
}
