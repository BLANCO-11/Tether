// src/components/home/RunsHealth.tsx — the dashboard's "Runs and health" (2026-10-23): a toolbar choosing the period,
// live or test runs and (for those who see beyond their own work) mine or everyone; five figures; the recent runs.
//
// ⚠ Every number is the SERVER's (`flow-executions?view=summary`, runs-health.ts) — this file divides and formats,
// it never counts. "Partly done" is its own outcome: some items failed (6 of 8 emails sent), which is neither a
// success nor a failure, so it is in neither of those figures.
//
// ⚠ "Mine / Everyone" renders only when the server says it is a choice (`choosesScope`). Anybody else's "everyone"
// is already only what they may see; offering them a toggle would promise a wider view that does not exist.
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { FAHealthCounts, FAHealthRange, FARunEnv, FARunScope, FAStartedBy } from "@/lib/foundry-client";
import type { DashboardData, HealthOutcome, HealthRow } from "@/lib/api";
import { MetricTile, Sparkline } from "@/components/ui/MetricTile";
import { fmtDuration, fmtWhen } from "@/lib/stats";
import { describeCron } from "@/lib/cron";

// ── Toolbar ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-line-2">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={`border-r border-line-2 px-3 py-1 text-caption last:border-r-0 transition-colors duration-150 ${
            v === value ? "bg-accent-bg font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export type HealthChoice = { range: FAHealthRange; env: FARunEnv; scope: FARunScope };

/** "Updated a few seconds ago" — from the moment the figures on screen were read, not the moment they were asked for. */
function updatedText(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return "Reading…";
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 10) return "Updated a few seconds ago";
  if (s < 60) return `Updated ${s} seconds ago`;
  const m = Math.round(s / 60);
  return `Updated ${m} minute${m === 1 ? "" : "s"} ago`;
}

export function HealthToolbar({
  choice,
  onChange,
  choosesScope,
  updatedAt,
  now,
}: {
  choice: HealthChoice;
  onChange: (c: HealthChoice) => void;
  choosesScope: boolean;
  updatedAt: number | null;
  now: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id="health-head" className="text-[16px] font-semibold">
        Runs and health
      </h2>
      <span className="text-caption text-dim">{updatedText(updatedAt, now)} · refreshes every 5s while a run is going</span>
      <div className="ml-auto flex flex-wrap gap-2">
        <Segmented
          label="Period"
          value={choice.range}
          options={[
            ["today", "Today"],
            ["7d", "7 days"],
            ["30d", "30 days"],
          ]}
          onChange={(range) => onChange({ ...choice, range })}
        />
        <Segmented
          label="Which runs"
          value={choice.env}
          options={[
            ["live", "Live runs"],
            ["test", "Test runs"],
          ]}
          onChange={(env) => onChange({ ...choice, env })}
        />
        {choosesScope && (
          <Segmented
            label="Whose runs"
            value={choice.scope}
            options={[
              ["mine", "Mine"],
              ["everyone", "Everyone"],
            ]}
            onChange={(scope) => onChange({ ...choice, scope })}
          />
        )}
      </div>
    </div>
  );
}

// ── Figures ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PREVIOUS: Record<FAHealthRange, string> = { today: "yesterday at this time", "7d": "previous 7 days", "30d": "previous 30 days" };

/** succeeded ÷ settled, or null when nothing finished — "0%" would claim every run failed. */
export function rateOf(c: FAHealthCounts): number | null {
  return c.settled ? c.succeeded / c.settled : null;
}

function Delta({ tone, children }: { tone: "good" | "bad" | "plain"; children: ReactNode }) {
  return <span className={tone === "good" ? "text-ok" : tone === "bad" ? "text-danger" : "text-muted"}>{children}</span>;
}

export function HealthFigures({ data }: { data: DashboardData }) {
  const { current: c, previous: p, range } = data.health;
  const series = data.health.series;
  const rate = rateOf(c);
  const prevRate = rateOf(p);
  const pts = rate != null && prevRate != null ? Math.round(rate * 100) - Math.round(prevRate * 100) : null;
  const runsChange = p.runs ? Math.round(((c.runs - p.runs) / p.runs) * 100) : null;
  const failedChange = c.failed - p.failed;
  const { longestRunningMs: longest, medianMs: median } = data.health;

  return (
    <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">
      <MetricTile
        label="Runs"
        value={String(c.runs)}
        href="/history"
        note={
          runsChange == null ? (
            <span className="text-dim">no runs the {PREVIOUS[range]}</span>
          ) : (
            <>
              <Delta tone={runsChange > 0 ? "good" : "plain"}>
                {runsChange > 0 ? "▲" : runsChange < 0 ? "▼" : ""} {Math.abs(runsChange)}%
              </Delta>
              <span className="text-dim">
                vs {PREVIOUS[range]} ({p.runs})
              </span>
            </>
          )
        }
        spark={<Sparkline values={series.map((b) => b.runs)} stroke="text-accent" />}
      />
      <MetricTile
        label="Succeeded"
        value={rate == null ? "—" : `${Math.round(rate * 100)}%`}
        sub={rate == null ? undefined : `${c.succeeded} of ${c.settled}`}
        href="/history"
        note={
          rate == null ? (
            <span className="text-dim">nothing finished yet</span>
          ) : pts == null ? (
            <span className="text-dim">nothing finished the {PREVIOUS[range]}</span>
          ) : (
            <>
              <Delta tone={pts > 0 ? "good" : pts < 0 ? "bad" : "plain"}>
                {pts > 0 ? "▲" : pts < 0 ? "▼" : ""} {pts === 0 ? "no change" : `${Math.abs(pts)} pts`}
              </Delta>
              <span className="text-dim">was {Math.round(prevRate! * 100)}%</span>
            </>
          )
        }
        spark={<Sparkline values={series.filter((b) => b.settled > 0).map((b) => b.succeeded / b.settled)} stroke="text-ok" />}
      />
      <MetricTile
        label="Failed"
        dot="bg-danger"
        value={String(c.failed)}
        valueTone={c.failed > 0 ? "text-danger" : undefined}
        href="/history"
        note={
          <>
            {failedChange !== 0 && (
              <Delta tone={failedChange > 0 ? "bad" : "good"}>
                {failedChange > 0 ? "▲" : "▼"} {Math.abs(failedChange)}
              </Delta>
            )}
            <span className="text-dim">
              {c.failed === 0 ? "nothing failed" : `across ${data.health.failedAutomations} automation${data.health.failedAutomations === 1 ? "" : "s"}`}
            </span>
          </>
        }
        spark={<Sparkline values={series.map((b) => b.failed)} stroke="text-danger" />}
      />
      <MetricTile
        label="Partly done"
        dot="bg-warn"
        value={String(c.partial)}
        valueTone={c.partial > 0 ? "text-warn" : undefined}
        href="/history"
        note={<span className="text-dim">{c.partial === 0 ? "every run did all of its items" : "some of their items failed"}</span>}
      />
      <MetricTile
        label="Running now"
        dot="live-dot bg-accent"
        value={String(data.health.runningNow)}
        href="/history"
        note={
          <span className="text-dim">
            {[longest != null ? `longest ${fmtDuration(longest)}` : "nothing running", median != null ? `median run ${fmtDuration(median)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        }
      />
    </div>
  );
}

// ── Recent runs ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A run's outcome as a dot plus a word — never colour alone. */
export const OUTCOME: Record<HealthOutcome, { label: string; chip: string }> = {
  done: { label: "Succeeded", chip: "bg-ok-bg text-ok" },
  partial: { label: "Partly done", chip: "bg-warn-bg text-warn" },
  stopped: { label: "Failed", chip: "bg-danger-bg text-danger" },
  running: { label: "Running", chip: "bg-accent-bg text-accent" },
};

/**
 * "Schedule · Every Monday at 09:00" — the cron in words. A cron `describeCron` does not know is "custom schedule",
 * never the raw string and never a guess (lib/cron.ts: a wrong description of when something fires is worse than
 * none). Nothing when the run's revision recorded no schedule.
 */
export function startedByTag(s: FAStartedBy): string | null {
  if (s.kind === "schedule") return s.cron ? describeCron(s.cron) ?? "custom schedule" : null;
  return s.detail;
}

export function RecentRunsTable({ rows, now, empty }: { rows: HealthRow[]; now: number; empty: string }) {
  return (
    <section className="pane" aria-labelledby="recent-head">
      <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
        <h2 id="recent-head" className="text-body font-semibold">
          Recent runs
        </h2>
        <span className="text-caption text-dim">most recent first</span>
        <Link href="/history" className="ml-auto text-caption text-accent hover:underline">
          History
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-caption text-muted">{empty}</p>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-line text-left text-caption text-dim">
              <th className="w-[38%] px-4 py-2 font-medium md:w-[36%]">Automation</th>
              <th className="w-[30%] px-4 py-2 font-medium md:w-[13%]">Outcome</th>
              <th className="hidden w-[22%] px-4 py-2 font-medium md:table-cell">Started by</th>
              <th className="hidden w-[12%] px-4 py-2 text-right font-medium sm:table-cell">Time taken</th>
              <th className="w-[32%] px-4 py-2 text-right font-medium md:w-[17%]">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const o = OUTCOME[r.outcome];
              const tag = startedByTag(r.startedBy);
              const took = r.outcome === "running" ? (r.startedAt ? now - Date.parse(r.startedAt) : null) : r.durationMs;
              return (
                <tr key={r.id} className="border-b border-line text-body last:border-0 hover:bg-surface-2">
                  <td className="truncate px-4 py-2.5">
                    <Link href={`/runs/${r.id}`} className="font-medium text-text hover:underline" title={r.automation}>
                      {r.automation}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium ${o.chip}`}>
                      <span className={`h-2 w-2 rounded-full bg-current ${r.outcome === "running" ? "live-dot" : ""}`} aria-hidden />
                      {o.label}
                    </span>
                  </td>
                  <td className="hidden truncate px-4 py-2.5 md:table-cell">
                    <span className={r.startedBy.kind === "unknown" ? "text-dim" : "text-text"}>{r.startedBy.label}</span>
                    {tag && <span className="ml-1.5 whitespace-nowrap rounded border border-line-2 px-1.5 py-px text-[11px] text-muted">{tag}</span>}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted sm:table-cell">{took != null ? fmtDuration(took) : "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-dim">
                    {r.outcome === "running" ? "Now" : r.startedAt ? fmtWhen(r.startedAt, now) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
