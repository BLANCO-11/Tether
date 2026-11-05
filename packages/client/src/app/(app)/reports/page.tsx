"use client";

// Cost & usage (2026-10-26, replaces Dashboards & Reports): what the model calls behind each workspace, workflow, run
// and person cost. One page, four lenses, and a drill: click a workspace to see its workflows, a workflow to see its
// runs, a person to see the workflows they used. The trail above the numbers is the drill; removing a chip widens it.
//
// Who sees it: only Admins and super admins. The server decides: it answers 403 to anybody else, and limits the
// answer to the workspaces the caller administers (every workspace for a super admin). This page shows what came back
// and offers nothing the server did not.
//
// Cost is model (LLM) cost only, priced at the rate in effect when each call happened. Download and Email are two
// separate acts (see ReportDialog): the first saves a file for a person who can already see the numbers, the second
// sends a snapshot to people who may hold no access to these workspaces.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { Button } from "@/components/ui/Button";
import { ReportDialog } from "@/components/reports/ReportDialog";
import { DailyCostChart } from "@/components/reports/DailyCostChart";
import { RankedBars } from "@/components/reports/RankedBars";
import { getReportRuns, getReportSummary } from "@/lib/api";
import { FoundryApiError } from "@/lib/foundry-client";
import {
  KIND_WORD,
  NO_DRILL,
  drillInto,
  drillQuery,
  tokens,
  usd,
  workspaceColour,
  type Drill,
  type Lens,
  type ReportGroup,
  type ReportRun,
  type ReportSummary,
  type RunSort,
} from "@/lib/reports";

/**
 * ⚠ THE LOOP THAT REDREW THIS PAGE FOR EVER (2026-10-26). Every response carries a FRESH `workspaces` array, and
 * `offered` feeds `pickedIds`, which feeds `query`, which the loading effect depends on. Choosing "everything" built a
 * new `[]` each time, so each answer made a new query, which fetched again, which made another: continuous refetching.
 * `EVERYTHING` (below) is the fix that matters: one shared empty array, so the query only changes when the person
 * changes something. `sameOffer` keeps the previous list when nothing visible changed, which only saves a re-render.
 */
const sameOffer = (a: ReportSummary["workspaces"], b: ReportSummary["workspaces"]) =>
  a.length === b.length && a.every((w, i) => w.id === b[i]!.id && w.name === b[i]!.name);

/** One shared "no workspace narrowing" value, so choosing everything never makes a new array and so a new query. */
const EVERYTHING: string[] = [];

const PERIODS = [7, 30, 90] as const;
const PAGE_SIZE = 50;
const LENSES: Array<{ id: Lens; label: string }> = [
  { id: "workspaces", label: "Workspaces" },
  { id: "workflows", label: "Workflows" },
  { id: "people", label: "People" },
  { id: "runs", label: "Runs" },
];

export default function ReportsPage() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [picked, setPicked] = useState<string[] | null>(null); // null = everything the server offered
  const [drill, setDrill] = useState<Drill>(NO_DRILL);
  const [lens, setLens] = useState<Lens>("workspaces");
  const [dialog, setDialog] = useState<"download" | "email" | null>(null);

  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState<{ status: number; message: string } | null>(null);
  // Remembered from the last answer so the picker keeps its options while the drill narrows the summary.
  const [offered, setOffered] = useState<ReportSummary["workspaces"]>([]);

  const pickedIds = useMemo(() => (picked && picked.length < offered.length ? picked : EVERYTHING), [picked, offered]);
  const nothingPicked = picked !== null && picked.length === 0;
  const query = useMemo(() => drillQuery({ days, workspaces: pickedIds }, drill), [days, pickedIds, drill]);

  useEffect(() => {
    if (nothingPicked) return;
    let live = true;
    setLoading(true);
    getReportSummary(query)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setRefusal(null);
        setOffered((cur) => (drill.workspace || drill.flow || drill.person || sameOffer(cur, s.workspaces) ? cur : s.workspaces));
      })
      .catch((e) => {
        if (!live) return;
        setSummary(null);
        setRefusal({ status: e instanceof FoundryApiError ? e.status : 0, message: e?.message ?? "Something went wrong" });
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, nothingPicked, drill.workspace, drill.flow, drill.person]);

  // The picker needs the whole list even when the first answer already carried a drill.
  useEffect(() => {
    if (summary && !offered.length) setOffered(summary.workspaces);
  }, [summary, offered.length]);

  const go = useCallback((l: Exclude<Lens, "runs">, g: ReportGroup) => {
    const next = drillInto(l, g, drill);
    setDrill(next.drill);
    setLens(next.lens);
  }, [drill]);

  const remove = (k: keyof Drill) => {
    const next = { ...drill, [k]: null };
    if (k === "workspace") next.flow = null; // a workflow belongs to a workspace
    setDrill(next);
    if (lens === "runs" && !next.flow) setLens("workflows");
  };

  const denied = refusal?.status === 403;
  const workspacesForDialog = offered.map((w) => ({ id: w.id, name: w.name }));

  return (
    <Page>
      <PageHeader
        eyebrow="Reports"
        title="Cost & usage"
        purpose="What the model calls behind your workspaces, workflows, runs and people cost."
        actions={
          denied || !summary
            ? undefined
            : [
                { label: "Download report", onClick: () => setDialog("download"), variant: "ghost" },
                { label: "Email report", onClick: () => setDialog("email"), variant: "ghost" },
              ]
        }
      />

      {denied ? (
        <Zone name="content">
          <Notice tone="warn" title="Cost reports are for Admins">
            {refusal?.message} Ask an Admin of the workspace if you need these figures.
          </Notice>
        </Zone>
      ) : (
        <>
              <Zone name="controls">
                <div className="flex flex-wrap items-center gap-3">
                  {offered.length > 0 ? (
                    <MultiSelect
                      label="Workspaces"
                      options={offered.map((w) => ({ id: w.id, label: w.name }))}
                      selected={picked ?? offered.map((w) => w.id)}
                      onChange={(next) => {
                        setPicked(next.length === offered.length ? null : next);
                        setDrill(NO_DRILL);
                        if (lens === "runs") setLens("workflows");
                      }}
                    />
                  ) : null}
                  <div className="inline-flex overflow-hidden rounded-md border border-line" role="group" aria-label="Period">
                    {PERIODS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={days === d}
                        onClick={() => setDays(d)}
                        className={`h-8 px-3 text-sm ${days === d ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}
                      >
                        {d} days
                      </button>
                    ))}
                  </div>
                  {offered.length > 0 ? (
                    <span className="text-xs text-muted">
                      {picked && picked.length < offered.length ? `Viewing ${picked.length} of ${offered.length} workspaces` : `All ${offered.length} workspaces you can report on`}
                    </span>
                  ) : null}
                </div>
                <Trail drill={drill} onRemove={remove} onClear={() => { setDrill(NO_DRILL); setLens("workspaces"); }} />
              </Zone>

              <Zone name="content">
                {nothingPicked ? (
                  <Notice tone="info" title="Pick at least one workspace">The report needs a workspace to cover.</Notice>
                ) : refusal ? (
                  <Notice tone="danger" title="The report could not be read">{refusal.message}</Notice>
                ) : loading && !summary ? (
                  <Skeleton rows={6} />
                ) : summary ? (
                  <Report summary={summary} lens={lens} setLens={setLens} onDrill={go} query={query} stale={loading} />
                ) : null}
              </Zone>
        </>
      )}

      <ReportDialog
        mode={dialog ?? "download"}
        open={dialog !== null}
        onClose={() => setDialog(null)}
        workspaces={workspacesForDialog}
        start={query}
      />
    </Page>
  );
}

function Trail({ drill, onRemove, onClear }: { drill: Drill; onRemove: (k: keyof Drill) => void; onClear: () => void }) {
  const steps = ([["workspace", "Workspace"], ["flow", "Workflow"], ["person", "Person"]] as const).filter(([k]) => drill[k]);
  return (
    <div className="flex min-h-[30px] flex-wrap items-center gap-1.5 text-sm" aria-label="Current selection">
      <span className="mr-1 text-xs text-muted">Showing</span>
      {steps.length === 0 ? (
        <span className="rounded-full border border-line bg-accent/10 px-3 py-0.5">Everything you can report on</span>
      ) : (
        steps.map(([k, label], i) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            {i > 0 ? <span className="text-muted" aria-hidden>›</span> : null}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-accent/10 py-0.5 pl-3 pr-1">
              <small className="text-[11px] uppercase tracking-wide text-muted">{label}</small>
              {drill[k]!.name}
              <button type="button" onClick={() => onRemove(k)} aria-label={`Remove ${label} filter`} className="h-5 w-5 rounded-full text-muted hover:bg-line hover:text-text">×</button>
            </span>
          </span>
        ))
      )}
      {steps.length ? <Button variant="ghost" size="xs" type="button" onClick={onClear}>Clear all</Button> : null}
    </div>
  );
}

function Report({ summary, lens, setLens, onDrill, query, stale }: {
  summary: ReportSummary;
  lens: Lens;
  setLens: (l: Lens) => void;
  onDrill: (l: Exclude<Lens, "runs">, g: ReportGroup) => void;
  query: import("@/lib/reports").ReportQuery;
  stale: boolean;
}) {
  const t = summary.tiles;
  const counts: Record<Lens, number> = { workspaces: t.workspaces, workflows: t.workflows, people: t.people, runs: t.runs };
  // A workspace keeps its colour whatever else is selected: the index is its place in the full list the server offered.
  const colourOfWorkspace = (id: string | undefined) => workspaceColour(Math.max(0, summary.workspaces.findIndex((w) => w.id === id)));
  const colourOf = (g: ReportGroup) => (lens === "workspaces" ? colourOfWorkspace(g.id ?? undefined) : lens === "workflows" ? colourOfWorkspace(g.workspaceId) : "var(--accent)");
  const title = { workspaces: "Cost by workspace", workflows: "Cost by workflow", people: "Cost by person", runs: "Runs" }[lens];
  return (
    <div className={`space-y-5 ${stale ? "opacity-70" : ""}`} aria-busy={stale}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure main label="Total cost" value={usd(t.costUsd)} note={`${tokens(t.tokens)} tokens · ${summary.window.fromDay} to ${summary.window.toDay}`} />
        <Figure label="Workspaces" value={String(t.workspaces)} note="with usage" />
        <Figure label="Workflows" value={String(t.workflows)} note="with usage" />
        <Figure label="Runs" value={String(t.runs)} note={t.runs ? `${usd(t.costUsd / t.runs)} average` : "—"} />
        <Figure label="People" value={String(t.people)} note={t.people ? `${usd(t.costUsd / t.people)} average` : "—"} />
      </div>

      <DailyCostChart byDay={summary.byDay} byPurpose={summary.byPurpose} />

      <div className="space-y-5">
        <section className="pane min-w-0 p-4" aria-label={title}>
          <h2 className="text-body font-semibold text-text">{title}</h2>
          <p className="mb-3 text-caption text-dim">{lens === "runs" ? "Each row is one run." : "Click a bar to drill in."}</p>
          <div role="tablist" aria-label="Group the report by" className="mb-3 flex flex-wrap gap-2">
            {LENSES.map((l) => (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={lens === l.id}
                onClick={() => setLens(l.id)}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${lens === l.id ? "border-accent bg-accent/10 font-medium" : "border-line bg-surface hover:bg-surface-2"}`}
              >
                {l.label}
                <span className="font-mono text-xs text-muted">{counts[l.id]}</span>
              </button>
            ))}
          </div>
          {lens === "runs" ? (
            <RunsTable query={query} />
          ) : (
            <>
              <RankedBars
                groups={summary.lenses[lens]}
                noun={lens === "workspaces" ? "workspace" : lens === "workflows" ? "workflow" : "person"}
                colourOf={colourOf}
                onOpen={(g) => onDrill(lens, g)}
              />
            </>
          )}
        </section>
      </div>
      <p className="text-xs text-muted">Cost is model (LLM) spend only, priced at the rate in effect when each call happened.</p>
    </div>
  );
}

function Figure({ label, value, note, main }: { label: string; value: string; note?: string; main?: boolean }) {
  return (
    <div className={`pane min-w-0 p-4 ${main ? "border-accent sm:col-span-2 lg:col-span-1" : ""}`}>
      <div className="truncate text-caption text-dim">{label}</div>
      <div className={`mt-1 font-semibold tabular-nums ${main ? "text-3xl text-accent" : "text-2xl text-text"}`}>{value}</div>
      {note ? <div className="mt-0.5 truncate text-xs text-muted">{note}</div> : null}
    </div>
  );
}

const RUN_HEADS: Array<{ key: RunSort; label: string; num?: boolean }> = [
  { key: "at", label: "When" },
  { key: "workflow", label: "Workflow" },
  { key: "workspace", label: "Workspace" },
  { key: "person", label: "Person" },
  { key: "status", label: "Outcome" },
  { key: "tokens", label: "Tokens", num: true },
  { key: "cost", label: "Cost", num: true },
];

function RunsTable({ query }: { query: import("@/lib/reports").ReportQuery }) {
  const [sort, setSort] = useState<{ key: RunSort; dir: "asc" | "desc" }>({ key: "at", dir: "desc" });
  const [rows, setRows] = useState<ReportRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getReportRuns(query, { sort: sort.key, dir: sort.dir, offset: 0, limit: PAGE_SIZE })
      .then((r) => live && (setRows(r.rows), setTotal(r.total), setError(null)))
      .catch((e) => live && setError(e?.message ?? "The runs could not be read"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, sort]);

  async function loadMore() {
    setMore(true);
    try {
      const r = await getReportRuns(query, { sort: sort.key, dir: sort.dir, offset: rows.length, limit: PAGE_SIZE });
      setRows((cur) => [...cur, ...r.rows]);
      setTotal(r.total);
    } catch (e) {
      setError((e as Error)?.message ?? "More runs could not be read");
    } finally {
      setMore(false);
    }
  }

  if (error) return <Notice tone="danger" title="The runs could not be read">{error}</Notice>;
  if (loading && !rows.length) return <Skeleton rows={4} />;
  if (!rows.length) return <p className="pane px-4 py-3 text-sm text-muted">No runs in this period for this selection.</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-caption text-dim">
              {RUN_HEADS.map((h) => (
                <th key={h.key} scope="col" className={`px-4 py-2 font-medium ${h.num ? "text-right" : "text-left"}`} aria-sort={sort.key === h.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => setSort((s) => ({ key: h.key, dir: s.key === h.key ? (s.dir === "asc" ? "desc" : "asc") : h.key === "at" || h.num ? "desc" : "asc" }))}>
                    {h.label}{sort.key === h.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={`${r.workspaceId}:${r.key}`}>
                <td className="whitespace-nowrap px-4 py-2 text-muted">{r.at.slice(0, 16).replace("T", " ")}</td>
                <td className="px-4 py-2 font-medium text-text">{r.flowName}<span className="ml-2 text-xs font-normal text-dim">{KIND_WORD[r.purpose]}</span></td>
                <td className="px-4 py-2 text-muted">{r.workspaceName}</td>
                <td className="px-4 py-2">{r.person}</td>
                <td className="px-4 py-2 text-muted">{r.status === "session" ? "Build session" : r.status}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">{tokens(r.tokens)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-text">{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Showing {rows.length} of {total} runs. The download carries all of them.</span>
        {rows.length < total ? <Button variant="ghost" size="sm" type="button" disabled={more} onClick={loadMore}>{more ? "Loading…" : "Load more"}</Button> : null}
      </div>
    </div>
  );
}
