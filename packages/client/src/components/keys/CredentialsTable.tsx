// src/components/keys/CredentialsTable.tsx — the D-01 grouped table: one pane,
// one table, kinds as section rows, one row per credential.
//
// The frozen mock's `cred-table`. This is deliberately NOT a `DataTable`: the
// closed sets describe FLAT row grids, and a section header row that spans every
// column is not a column role — forcing section rows into a set would mean
// inventing a `section` role the other nine pages would never use. A plain
// semantic table is the honest shape for a grouped list, styled with the same
// tokens the dashboard's table uses.
//
// `Status` is words ("Set" / "Missing"), never colour alone: `StatusPill` is a
// dot AND a word, so the colour-blind safe requirement (mock design rule 6)
// holds without a second rendering.
//
// The per-section counts are recomputed over the FILTERED rows. The mock's
// counts were data literals that stayed stale under search; a count that says
// "· 3" while one row is visible is a count that lies about the filter.
"use client";

import type { CredentialView, CredentialKind } from "@/lib/types";
import { StatusPill } from "@/components/ui/Badge";
import { RowMenu } from "@/components/ui/RowMenu";
import { Skeleton } from "@/components/ui/Skeleton";

/** Section order and eyebrow labels. `generic` is last and unadvertised in the
 * filter (the mock's select has no Generic option) — legacy secrets land there
 * and must still be visible under "All kinds". */
const SECTIONS: Array<{ kind: CredentialKind; label: string; tagNew?: boolean }> = [
  { kind: "tool", label: "Tool credentials" },
  { kind: "database", label: "Database" },
  { kind: "webhook", label: "Webhook" },
  { kind: "api", label: "API", tagNew: true },
  { kind: "llm", label: "LLM" },
  { kind: "generic", label: "Generic" },
];

/** The mock's relative-time idiom ("2h ago", "1d ago"), falling back to a date
 * for anything older than a month. Null/absent → "never" (the honest word for
 * a credential that has never been used — the old tables said the same). */
export function formatLastUsed(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function CredentialsTable({
  credentials,
  loading,
  error,
  query,
  kind,
  onEdit,
  onRotate,
  onRemove,
}: {
  credentials: CredentialView[];
  loading: boolean;
  error: string | null;
  /** Search box value — matched against label AND ref, case-insensitive. */
  query: string;
  /** "all" or one kind; a kind hides every other section. */
  kind: CredentialKind | "all";
  onEdit: (c: CredentialView) => void;
  onRotate: (c: CredentialView) => void;
  onRemove: (c: CredentialView) => void;
}) {
  const q = query.trim().toLowerCase();
  const matches = (c: CredentialView) =>
    (kind === "all" || c.kind === kind) &&
    (!q || c.label?.toLowerCase().includes(q) || c.ref.toLowerCase().includes(q));

  // ⚠ Sections render ONLY while they have visible rows (the mock's filter
  // hides empty sections).
  const visible = credentials.filter(matches);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-caption uppercase tracking-label text-dim">
            <th className="w-[44%] px-4 py-2.5 text-left font-normal">Credential</th>
            <th className="px-4 py-2.5 text-left font-normal">Status</th>
            <th className="px-4 py-2.5 text-left font-normal">Last used</th>
            <th className="w-11 px-4 py-2.5" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {SECTIONS.map((sec) => {
            const rows = visible.filter((c) => c.kind === sec.kind);
            if (rows.length === 0) return null;
            return (
              <SecGroup key={sec.kind} section={sec} count={rows.length}>
                {rows.map((c) => (
                  // The mock's `.tbl tbody tr:hover` — a surface lift, never a
                  // color flood (doc §3.4).
                  <tr key={c.ref} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3 align-top">
                      <div className="text-body text-text">{c.label ?? c.ref}</div>
                      <div className="mt-0.5 font-mono text-caption text-muted">{c.ref}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <StatusPill status={c.hasValue ? "ok" : "danger"}>
                        {c.hasValue ? "Set" : "Missing"}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 align-top text-caption text-dim">
                      {formatLastUsed(c.lastUsedAt)}
                    </td>
                    <td className="px-4 py-3 align-top text-right">
                      <RowMenu
                        actions={[
                          { label: "Edit", icon: "edit", onClick: () => onEdit(c) },
                          { label: "Rotate", icon: "rotate", onClick: () => onRotate(c) },
                          { label: "Remove", icon: "delete", danger: true, onClick: () => onRemove(c) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </SecGroup>
            );
          })}
          {/* ⚠ Only when nothing else is on screen. Loading shows the
              footprint-stable skeleton (mock D-16 — five shimmer rows in the
              table footprint); the words pick the TRUE empty state: failed,
              genuinely none, or hidden by the filters — the mock's single row
              could not say either. */}
          {visible.length === 0 && (
            <tr>
              <td colSpan={4} className="px-5 py-6 text-center text-sm text-muted">
                {loading ? (
                  <Skeleton rows={5} />
                ) : error ? (
                  <span className="text-danger">Could not load credentials: {error}</span>
                ) : credentials.length === 0 ? (
                  "No credentials yet. Add one when a tool or data source needs to sign in."
                ) : (
                  "No credentials match your filters."
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A section header row (eyebrow + count), wrapping its rows so the count can
 * be computed once here rather than by every caller. */
function SecGroup({
  section,
  count,
  children,
}: {
  section: { kind: CredentialKind; label: string; tagNew?: boolean };
  count: number;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* ⚠ No tint and no border on the section row — the mock's `cred-sec`
          is plain with `border-bottom: 0` (a full-width wash or a line on a
          header row is the zebra/border-overlap the doc forbids). The eyebrow
          + count + the 4px-grid padding separate the groups; the item rows'
          own hairlines separate the rows. */}
      <tr>
        <td colSpan={4} className="px-4 pb-1 pt-3">
          <span className="text-caption uppercase tracking-label text-dim">{section.label}</span>
          {section.tagNew && (
            <span className="ml-2 inline-flex items-center rounded border border-alpha-line bg-alpha-bg px-1.5 py-px text-micro font-semibold uppercase tracking-label text-alpha">
              New
            </span>
          )}
          <span className="text-caption text-dim"> · {count}</span>
        </td>
      </tr>
      {children}
    </>
  );
}
