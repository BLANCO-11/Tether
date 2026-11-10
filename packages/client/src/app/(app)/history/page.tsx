// src/app/(app)/history/page.tsx — History. The audit trail for this workspace's
// runs, newest first; Details opens the run's steps.
//
// ── "Fix & retry" IS GONE ────────────────────────────────────────────────────
//
// It called `retryRun(id)`, which was mock-only and did something considerably
// worse than nothing: it unshifted a NEW run row into localStorage reading "retried
// and completed", with every step rewritten to `done`. One click turned a failed
// run into a fabricated success in the audit trail — on the page whose footer
// promises "every run is recorded forever, ready for any audit".
//
// There is no equivalent single button, deliberately. Re-running a flow is either a
// TEST RUN against the draft namespace or FIRING its trigger against the approved
// live revision, and those are not the same act — one is a rehearsal, the other
// does the work for real. The row therefore links to the flow, where both are
// available and labelled.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listRunsPage } from "@/lib/api";
import { startOfDay } from "@/lib/stats";
import { runWorkflowId } from "@/lib/adapters";
import { useAsync } from "@/lib/hooks";
import { useActivityEpoch } from "@/lib/activity";
import type { Run } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { DataTable, type DataRow } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { CopyableId } from "@/components/ui/CopyableId";
import { Modal } from "@/components/ui/Modal";
import { Strip } from "@/components/ui/Strip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Activity, Check, ChevronDown, Close, CircleSlash, Search } from "@/components/ui/icons";

export default function HistoryPage() {
  // Runs are the thing this page is about, so it is the page most obviously
  // wrong when it does not move. `epoch` changes on a transition only — see
  // `lib/activity.tsx`.
  const epoch = useActivityEpoch();
  const [auto, setAuto] = useState("all");
  const [when, setWhen] = useState("all");
  const [q, setQ] = useState("");
  // The search is sent once typing pauses, not on every key.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const [detail, setDetail] = useState<Run | null>(null);

  // PAGED (2026-10-11): 50 runs per request, newest first, and the filters run on the SERVER over every run — the
  // page used to fetch 200 runs and then each one's full detail (one request per run) and filter what it had loaded.
  // Search matches the workflow name and the run's or workflow's id (the same id the Workflow ID column shows).
  const filters = { name: auto === "all" ? undefined : auto, from: when === "today" ? new Date(startOfDay(Date.now())).toISOString() : undefined, q: query || undefined };
  const { data: first, loading, error, reload } = useAsync(() => listRunsPage(filters), [epoch, auto, when, query]);
  const [more, setMore] = useState<{ runs: Run[]; next: string | null } | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    setMore(null);
    setMoreError(null);
    if (first?.labels) setLabels(first.labels);
  }, [first]);
  const runs = first ? [...first.runs, ...(more?.runs ?? [])] : null;
  const next = more ? more.next : (first?.next ?? null);
  const loadMore = async () => {
    if (!next || moreLoading) return;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const page = await listRunsPage({ ...filters, before: next });
      setMore((m) => ({ runs: [...(m?.runs ?? []), ...page.runs], next: page.next }));
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoreLoading(false);
    }
  };

  const names = labels.length ? labels : Array.from(new Set((runs ?? []).map((r) => r.automation)));
  const list = runs ?? [];
  const filtered = auto !== "all" || when !== "all" || !!query;

  // The Status column, derived from what the run actually did: a badge whose
  // tone follows the page's existing outcome colours (ok / warn / danger).
  // ⚠ Plain words (`completed`/`stopped`/`running`), not the internal event
  // spelling (`run.completed`/…) that used to render here — see spec.md User
  // Story 6.
  const statusBadge = (r: Run) => {
    const shape =
      r.outcome === "done"
        ? { label: "completed", cls: "bg-ok-bg text-ok" }
        : r.outcome === "running"
          ? { label: "running", cls: "bg-warn-bg text-warn" }
          : { label: "stopped", cls: "bg-danger-bg text-danger" };
    return (
      <span className={`rounded-full px-2.5 py-0.5 font-mono text-caption ${shape.cls}`}>
        {shape.label}
      </span>
    );
  };

  const rows: DataRow<"run">[] = list.map((r) => {
    // `runWorkflowId` prefers the frozen snapshot over the live `flowId`
    // pointer, so deleting the workflow afterward cannot blank the Workflow
    // ID cell — User Story 5. Computed once per row and reused for both the
    // id shown and the link it points to.
    const workflowId = runWorkflowId(r);
    return {
      key: r.id,
      cells: {
        time: <span className="text-sm text-muted">{r.when}</span>,
        // The workflow's display name, frozen at the moment THIS run started
        // (`runLabel`'s snapshot-then-slug-then-placeholder chain) — no longer
        // sharing a cell with either id, per User Story 4.
        workflowName: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm">{r.automation}</span>
            {r.autoTest && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-caption text-muted" title="Run by the builder after a build turn, on test data">
                automatic test
              </span>
            )}
          </span>
        ),
        // Links to the workflow's own page when a target exists (User Story
        // 7); an orphaned run's `null` skips the link, same as the copy button.
        workflowId: <CopyableId id={workflowId} href={workflowId ? `/flows/${workflowId}` : undefined} />,
        // The run's own id always exists, so its link is unconditional.
        runId: <CopyableId id={r.id} href={`/runs/${r.id}`} />,
        status: statusBadge(r),
        actions: <Button variant="ghost" size="sm" onClick={() => setDetail(r)}>Details</Button>,
      },
    };
  });

  return (
    <Page>
      <PageHeader
        title="History"
        purpose="The audit trail — every decision, run and credential change."
      />

      <Zone name="notices">
        {error && (
          <Notice
            tone="danger"
            title="Could not load the run history"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        )}
      </Zone>

      {/* Zone 3. The two selects were in the header's action slot beside the
          title, which is the second of the two cases D-93 names (the other is
          /apps). The mock adds a search box; the actor filter it shows needs
          server audit data `Run` does not carry, so the automation + time
          selects stay (see the slice report). */}
      <Zone name="controls">
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search s={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search history…"
              aria-label="Search history"
              className="h-9 w-64 rounded-md border border-line bg-transparent pl-8 pr-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            />
          </span>
          <Filter label="Filter by automation" value={auto} onChange={setAuto} options={[["all", "All automations"], ...names.map((n) => [n, n] as [string, string])]} />
          <Filter label="Filter by time" value={when} onChange={setWhen} options={[["all", "All time"], ["today", "Today"]]} />
        </div>
      </Zone>

      {!error && (
        <Zone name="content">
          <DataTable
            set="run"
            caption="Run history"
            heads={{ time: "When", workflowName: "Workflow name", workflowId: "Workflow ID", runId: "Run ID", status: "Status", actions: "" }}
            rows={rows}
            empty={
              loading ? (
                // The table's footprint while history loads: shimmer bars that
                // occupy the same space as the rows that are coming (D-16).
                <Skeleton rows={4} />
              ) : !filtered && (runs ?? []).length === 0 ? (
                <span className="block space-y-1 text-left">
                  <span className="block">No runs yet — they&apos;ll appear here after an automation runs.</span>
                  {/* The sentence that used to live in the related aside. The
                      mock has no aside, so the promise lives where an empty
                      table is actually read. */}
                  <span className="block text-xs text-muted">
                    Every run is recorded. What it did and what it touched, readable by anyone.
                    Tether keeps the record of each run; the engine keeps each step&apos;s inputs
                    and outputs for 30 days, which is also how far back a run can be replayed.
                  </span>
                </span>
              ) : query ? (
                // The mock's search empty state (D-23): a query that matched
                // nothing. No action — there is no plausible one for a search
                // with no hits, so EmptyState's action slot stays empty.
                <EmptyState icon={<Activity s={16} />} title="No history entries match your search." />
              ) : (
                // Runs exist, but the automation/time selects excluded them all
                // (no search typed). Pre-dates the mock, which has no selects.
                "No runs match your filters."
              )
            }
          />
          {next || moreError ? (
            <div className="flex items-center justify-center gap-3 py-4">
              {moreError ? <span className="text-sm text-danger">Could not load more runs: {moreError}</span> : null}
              <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={moreLoading}>
                {moreLoading ? "Loading…" : moreError ? "Try again" : "Load more"}
              </Button>
            </div>
          ) : list.length > 0 ? (
            <p className="py-4 text-center text-xs text-muted">That is every run{filtered ? " that matches" : ""}.</p>
          ) : null}
        </Zone>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? detail.automation : ""}>
        {detail && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              {detail.when} · {detail.outcome === "done" ? "Done" : detail.outcome === "running" ? "Running" : "Stopped"} ·{" "}
              {detail.outcome === "running" ? "still going" : `took ${detail.timeTaken}`}
            </p>
            <p>{detail.text}</p>

            {/* The step-by-step plain-English record of this run. */}
            {detail.steps?.length ? (
              <div className="space-y-2 pt-1">
                <p className="text-caption uppercase tracking-label text-dim">What each step did</p>
                {/* Where the run got to, in one line, before the detail below it. */}
                <Strip
                  cells={detail.steps.map((s, i) => ({
                    key: `${i}-${s.title}`,
                    label: s.title,
                    // `stopped` is the only remaining arm, and it means failed —
                    // the cell used to be called `blocked`, which is what
                    // `lib/status.ts` calls "needs a person" (ui-upgrade D-92).
                    state:
                      s.outcome === "done"
                        ? "done"
                        : s.outcome === "running"
                          ? "active"
                          : s.outcome === "skipped"
                            ? "skipped"
                            : "failed",
                    title: s.note,
                  }))}
                />
                {detail.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border border-line bg-bg px-3 py-2">
                    {s.outcome === "done" && <span className="mt-0.5 text-ok"><Check s={13} /></span>}
                    {s.outcome === "stopped" && <span className="mt-0.5 text-danger"><Close s={13} /></span>}
                    {s.outcome === "skipped" && <span className="mt-0.5 text-muted" aria-label="skipped"><CircleSlash s={13} /></span>}
                    {s.outcome === "running" && (
                      <span className="relative mt-1.5 flex h-2 w-2 shrink-0" aria-label="running">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block">{s.title}{s.outcome === "skipped" && <span className="text-muted"> — skipped</span>}</span>
                      {s.note && <span className="block text-xs text-muted">{s.note}</span>}
                    </span>
                    {/* Per-step time, right-aligned. "—" when it never ran, "skipped" when skipped. */}
                    {s.durationLabel && <span className="mt-0.5 shrink-0 font-mono text-xs text-muted">{s.durationLabel}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">This run predates step-by-step records.</p>
            )}

            {detail.error && (
              <p className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger">{detail.error}</p>
            )}
            <div className="flex items-center justify-between pt-2">
              {/* Flow runs have a step graph with per-step I/O and engine logs.
                  Script runs have one stdout and an exit code, and nothing to link to. */}
              {detail.kind === "flow" ? (
                <Link href={`/runs/${detail.id}`} className="text-sm text-accent hover:underline">
                  Open the step graph →
                </Link>
              ) : <span />}
              <Button onClick={() => setDetail(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </Page>
  );
}

/** Filter styled like the PDF chevron button, backed by a native select. */
function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <span className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="h-9 appearance-none rounded-md border border-line bg-transparent pl-3 pr-8 text-sm text-muted hover:bg-surface-2 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        {options.map(([v, label]) => <option key={v} value={v} className="bg-surface text-text">{label}</option>)}
      </select>
      <ChevronDown s={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}
