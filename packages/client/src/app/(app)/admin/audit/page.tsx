// src/app/(app)/admin/audit/page.tsx — S-68 Audit explorer
//
// Pack route /admin/audit, measure wide, h-screen overflow-hidden shell via (app) layout.
// Super-admin gated — same four states as /organization.
// Two views of ONE immutable record: Plain English (When · Who · What happened · Where · Raw)
// and Raw events (Event ID · Time · Actor · Operation · Entity · Description).
// Filters: search + two native date inputs, all via URL (?view, ?q, ?from, ?to, ?page).
// ⚠ 2026-10-12: filtered and PAGED ON THE SERVER, 50 a page — the page used to load the whole record to show it.
// Every row carries its raw event inline behind a per-row disclosure.
// Empty states: genuinely empty vs filtered-empty (two sentences).
"use client";

import { Suspense } from "react";
import { Fragment, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { AccessHistory } from "@/components/access/AccessHistory";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Search, ChevronDown, ChevronUp } from "@/components/ui/icons";
import { useAsync } from "@/lib/hooks";
import { listAuditPage } from "@/lib/api";
import { formatWhen } from "@/lib/audit";
import type { FDAuditEvent } from "@/lib/audit";
import { AdminGate, ADMIN_EYEBROW } from "@/components/admin/AdminGate";

type View = "plain" | "raw";

function viewFromParam(v: string | null): View {
  return v === "raw" ? "raw" : "plain";
}

const TITLE = "Audit";

function AuditExplorerPageContent() {
  return (
    <AdminGate title={TITLE}>
      {({ workspaceId, workspaces }) => <AuditBody workspaceId={workspaceId} spaces={workspaces} />}
    </AdminGate>
  );
}

/** Events per page. The server caps a page at 200. */
const PAGE_SIZE = 50;

function AuditBody({
  workspaceId,
  spaces,
}: {
  workspaceId: string | null;
  spaces: { data: { id: string; name: string }[] | null; error: string | null };
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const view = viewFromParam(searchParams.get("view"));
  const q = searchParams.get("q") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const activeName = (spaces.data ?? []).find((x) => x.id === workspaceId)?.name ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The box holds what is typed; the URL (and so the server) gets it once typing pauses.
  const [qInput, setQInput] = useState(q);
  useEffect(() => setQInput(q), [q]);

  const toggleRaw = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ⚠ Filtered and paged ON THE SERVER: the record grows without bound, and a page that loaded all of it to show
  // fifty was the complaint. `total` is how many the filter matches — the denominator of "51–100 of 312".
  const audit = useAsync(
    () =>
      workspaceId
        ? listAuditPage(workspaceId, { q, from, to, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
        : Promise.resolve({ events: [] as FDAuditEvent[], total: 0 }),
    [workspaceId, q, from, to, page],
  );
  const events = audit.data?.events ?? [];
  const total = audit.data?.total ?? 0;
  const isFiltered = q.trim() !== "" || from !== "" || to !== "";

  // ⚠ "No events match these filters — the record itself is not empty" is a claim, so it is CHECKED: only when a
  // filtered page comes back empty is the unfiltered record asked whether it holds anything.
  const filteredEmpty = isFiltered && !!audit.data && total === 0;
  const anyAtAll = useAsync(
    () => (workspaceId && filteredEmpty ? listAuditPage(workspaceId, { limit: 1, offset: 0 }).then((r) => r.total) : Promise.resolve(null)),
    [workspaceId, filteredEmpty],
  );

  const writeParams = (edit: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    edit(params);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };
  /** A filter change returns to page 1 — page 4 of a different result set is a page of nothing in particular. */
  const setParam = (key: string, value: string) =>
    writeParams((p) => {
      if (!value) p.delete(key);
      else p.set(key, value);
      p.delete("page");
    });
  const setPage = (n: number) => writeParams((p) => (n <= 1 ? p.delete("page") : p.set("page", String(n))));
  const setView = (next: View) => writeParams((p) => (next === "plain" ? p.delete("view") : p.set("view", next)));
  const clearFilters = () =>
    writeParams((p) => {
      p.delete("q");
      p.delete("from");
      p.delete("to");
      p.delete("page");
    });

  useEffect(() => {
    if (qInput === q) return;
    const t = setTimeout(() => setParam("q", qInput), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  /** The WHOLE filtered record, not the page on screen — fetched when asked for. */
  const downloadCsv = async () => {
    if (!workspaceId) return;
    const { events: rows } = await listAuditPage(workspaceId, { q, from, to });
    if (!rows.length) return;
    const header = ["id", "time", "actor", "operation", "entity", "description", "where"];
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        header
          .map((k) => {
            const v = String((r as Record<string, unknown>)[k] ?? "");
            return `"${v.replace(/"/g, '""')}"`;
          })
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE);

  return (
    <Page measure="wide">
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title={TITLE}
        purpose="Every decision, run and credential change — who did it, and when."
        actions={[{ label: "Download CSV", onClick: () => void downloadCsv(), variant: "ghost" }]}
      />

      <Zone name="notices" gap="tight">
        {spaces.error && <Notice tone="danger" title="Could not load workspaces">{spaces.error}</Notice>}
        {audit.error && (
          <Notice
            tone="warn"
            title="Audit record could not be read"
            action={
              <Button variant="ghost" size="sm" onClick={audit.reload}>
                Try again
              </Button>
            }
          >
            {audit.error} — nothing below is a claim that nothing happened.
          </Notice>
        )}
        {!workspaceId && (
          <p className="text-caption text-muted">No workspace selected — pick one in the workspace switcher, or create one under Workspaces.</p>
        )}
      </Zone>

      <Zone name="controls" gap="tight">
        {/* One row: search, the date range, Clear — and the two views of one record on the right. */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex w-72 items-center">
            <span className="pointer-events-none absolute left-3 text-dim">
              <Search s={14} />
            </span>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search actor, action or exact event id"
              aria-label="Search actor, action or exact event id"
              className="h-9 w-full rounded-md border border-line bg-bg pl-9 pr-3 text-body text-text placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            />
          </label>
          <label className="flex items-center gap-1.5 text-caption text-dim">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setParam("from", e.target.value)}
              aria-label="Start date"
              className="h-9 rounded-md border border-line bg-bg px-2.5 text-body text-text focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-caption text-dim">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setParam("to", e.target.value)}
              aria-label="End date"
              className="h-9 rounded-md border border-line bg-bg px-2.5 text-body text-text focus:border-accent focus:outline-none"
            />
          </label>
          {isFiltered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
          <div role="tablist" aria-label="Audit views" className="ml-auto flex items-center gap-1 rounded-md bg-surface-2 p-0.5">
            {(
              [
                ["plain", "Plain English"],
                ["raw", "Raw events"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`rounded px-2.5 py-1 text-caption transition-colors duration-150 ${
                  view === key ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </Zone>

      <Zone name="content">
        {!audit.data && !audit.error ? (
          <div className="pane p-4"><Skeleton rows={6} /></div>
        ) : events.length === 0 ? (
          !isFiltered ? (
            <EmptyState
              icon={<Search s={16} />}
              title="No audit events yet."
              action={
                <p className="text-sm text-muted">Events appear here as work happens — every decision, run and credential change is recorded.</p>
              }
            />
          ) : (
            <div className="pane px-6 py-10 text-center">
              <p className="text-sm font-medium text-text">No events match these filters.</p>
              {anyAtAll.data != null && anyAtAll.data > 0 && (
                <p className="mt-2 text-sm text-muted">
                  The record itself is not empty — the current search and date range exclude everything in it.
                </p>
              )}
              <div className="mt-4">
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="pane overflow-hidden">
            {view === "plain" ? (
              <div className="overflow-x-auto">
                <table className="w-full text-body" aria-label="Audit explorer">
                  <thead>
                    <tr className="border-b border-line text-caption uppercase tracking-label text-dim">
                      <th className="px-4 py-2.5 text-left font-normal">When</th>
                      <th className="px-4 py-2.5 text-left font-normal">Who</th>
                      <th className="px-4 py-2.5 text-left font-normal">What happened</th>
                      <th className="px-4 py-2.5 text-left font-normal">Where</th>
                      <th className="px-2 py-2.5 text-right font-normal">
                        <span className="sr-only">Raw</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => {
                      const open = expanded.has(e.id);
                      return (
                        <Fragment key={e.id}>
                          <tr className="border-b border-line last:border-0 hover:bg-surface-2/50" data-testid="audit-row">
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{formatWhen(e.time)}</td>
                            <td className="px-4 py-3 text-text">{e.actor}</td>
                            <td className="px-4 py-3 text-text">{e.description}</td>
                            <td className="px-4 py-3 text-muted">
                              <span className="line-clamp-2 leading-snug">{e.where}</span>
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                aria-label={`Raw event ${e.id}`}
                                aria-expanded={open}
                                onClick={() => toggleRaw(e.id)}
                                className="inline-flex items-center gap-1 rounded border border-line bg-bg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
                              >
                                {open ? <ChevronUp s={12} /> : <ChevronDown s={12} />}
                                Raw
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr data-testid="audit-raw-detail">
                              <td colSpan={5} className="border-b border-line bg-surface-2/40 px-4 py-3">
                                <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-3 py-2 font-mono text-xs text-muted">
                                  {JSON.stringify(e.raw ?? { id: e.id, time: e.time, actor: e.actor, operation: e.operation, entity: e.entity, description: e.description, where: e.where }, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body" aria-label="Raw audit events">
                  <thead>
                    <tr className="border-b border-line text-caption uppercase tracking-label text-dim">
                      <th className="px-4 py-2.5 text-left font-normal">Event ID</th>
                      <th className="px-4 py-2.5 text-left font-normal">Time</th>
                      <th className="px-4 py-2.5 text-left font-normal">Actor</th>
                      <th className="px-4 py-2.5 text-left font-normal">Operation</th>
                      <th className="px-4 py-2.5 text-left font-normal">Entity</th>
                      <th className="px-4 py-2.5 text-left font-normal">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id} className="border-b border-line last:border-0" data-testid="audit-raw-row">
                        <td className="px-4 py-3 font-mono text-xs text-muted">{e.id}</td>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{formatWhen(e.time)}</td>
                        <td className="px-4 py-3 text-text">{e.actor}</td>
                        <td className="px-4 py-3 font-mono text-xs text-muted">{e.operation}</td>
                        <td className="px-4 py-3 text-xs text-muted">{e.entity}</td>
                        <td className="px-4 py-3 text-text">{e.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* ── Paging ── */}
            <nav aria-label="Audit pages" className="flex items-center gap-3 border-t border-line bg-surface-2/40 px-4 py-2.5">
              <span className="text-caption tabular-nums text-muted">
                Showing {firstShown}–{lastShown} of {total}
              </span>
              <span className="ml-auto text-caption tabular-nums text-dim">
                Page {page} of {pages}
              </span>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </nav>
          </div>
        )}
        {/* Hidden workspace name for test seam — not rendered differently */}
        {activeName && <span className="sr-only">{activeName}</span>}
      </Zone>

      {/*
        ⚠ FR-038 — grants, revocations and REFUSALS, in one time order across both audit
        stores. Which store a decision landed in is a storage decision and is not
        reader-visible (INV-17). Folded by default: it is a second record, not this page's subject.
      */}
      <Zone name="related">
        <details className="pane px-4 py-3">
          <summary className="cursor-pointer text-body font-medium text-text">Access changes and refusals</summary>
          <p className="mb-3 mt-1 text-caption text-muted">
            Who was granted what, who took it away, and who was refused. A refusal repeated inside one window is a single
            entry with a count.
          </p>
          <AccessHistory />
        </details>
      </Zone>
    </Page>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function AuditExplorerPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <AuditExplorerPageContent />
    </Suspense>
  );
}
