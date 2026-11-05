// src/app/(app)/dashboard/page.tsx — Home for the active workspace: start something, then "Runs and health" — how
// this workspace's runs went over a period, and the last few. Every number comes from `api.dashboardSummary()`, which
// the server computes from the real flow executions; if it cannot be read the page says so and never substitutes
// figures.
//
// ── The 2026-10-23 pass ─────────────────────────────────────────────────────────────────────────────────────────
//
// - **"Runs and health" replaced the week figures and four cards.** A period (today / 7 days / 30 days), live or test
//   runs, and — only for those who see beyond their own work — mine or everyone. "Partly done" is its own figure.
// - **Removed**: "Needs you" (it counted failing automations and linked to approvals, which it did not count),
//   "Running now" and "Coming up" as cards, "Needs your attention", Signals (still on /admin) and Usage
//   (/observability). The detailed analysis belongs on a reports page, not here.
//
// ── Kept from the 2026-10-11 pass (docs/design/README.md) ────────────────────────────────────────────────────────
//
// - ⚠ **A refresh never blanks the page.** The live poll (every 5s while a run is going), every activity change and
//   every toolbar choice call the read again, and `useAsync` sets `loading` on each one. The page used to branch on
//   `loading`, so the whole page flashed to its skeleton every five seconds while anything ran. The skeleton is the
//   FIRST load only.
// - **One primary action**: the composer.
//
// `lib/runstream.ts` is gone and stays gone: it invented a live run on a timer. What replaced it is the real in-flight
// runs, re-read while any is still going; the poll stops when the last one settles.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { dashboardSummary } from "@/lib/api";
import { NO_WORKSPACE_MESSAGE } from "@/lib/foundry-client";
import { useAsync } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { useActivityEpoch } from "@/lib/activity";
import { Page, Zone } from "@/components/layout/Page";
import { Notice } from "@/components/ui/Notice";
import { HomeComposer } from "@/components/home/HomeComposer";
import { HealthFigures, HealthToolbar, RecentRunsTable, type HealthChoice } from "@/components/home/RunsHealth";
import { useCan } from "@/components/access/Can";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";

const LIVE_POLL_MS = 5000;

function greeting(now: number): string {
  const h = new Date(now).getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** The date, in words, as the header's eyebrow (`MONDAY, 11 AUGUST 2026` once uppercased). */
function todayEyebrow(now: number): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(now),
  );
}

/** "himanshu saini" → "Himanshu". Empty when the session carries no name — then the greeting stands alone. */
function firstName(name: string | undefined): string {
  const w = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : "";
}

/** A clock that ticks only while something on screen is counting (elapsed time of a live run). */
function useNow(tickMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tickMs == null) return;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}

function Header({ now, name }: { now: number; name: string }) {
  return (
    <Zone name="header" as="header" gap="none">
      <p className="text-caption uppercase tracking-[0.07em] text-dim">{todayEyebrow(now)}</p>
      <h1 className="mt-1 text-xl font-medium">
        {greeting(now)}
        {name ? `, ${name}` : ""}
      </h1>
    </Zone>
  );
}

/** What the empty table says — for the runs that were asked for, not a generic "no runs". */
function emptyText(c: HealthChoice, mineOnly: boolean): string {
  if (c.env === "test") return mineOnly ? "None of your test runs yet." : "No test runs yet. Describe an automation above and run it once — it will appear here.";
  return mineOnly ? "None of your live runs yet." : "No live runs yet. An automation runs live once it is approved.";
}

export default function DashboardPage() {
  const epoch = useActivityEpoch();
  const { user } = useAuth();
  const name = firstName(user?.name);
  const [choice, setChoice] = useState<HealthChoice>({ range: "7d", env: "live", scope: "everyone" });
  const { data, error, reload } = useAsync(() => dashboardSummary(choice), [epoch, choice.range, choice.env, choice.scope]);
  // When the figures on screen were read. Set when a read ARRIVES — a refresh in flight keeps the old time.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (data) setUpdatedAt(Date.now());
  }, [data]);

  const runningNow = data?.running.length ?? 0;
  // Re-read while anything is in flight; the last run to settle removes the condition and the poll stops.
  useEffect(() => {
    if (runningNow === 0) return;
    const t = setTimeout(reload, LIVE_POLL_MS);
    return () => clearTimeout(t);
  }, [runningNow, reload, data]);
  // Every second while a run's time is counting up; otherwise often enough to keep "Updated … ago" honest.
  const now = useNow(runningNow > 0 ? 1000 : 15_000);

  if (error === NO_WORKSPACE_MESSAGE) {
    return (
      <Page>
        <Zone name="notices">
          <Notice
            tone="info"
            title="There is no workspace yet"
            action={
              <Link
                href="/organization"
                className="rounded-md border border-line px-2.5 py-1 text-caption text-muted hover:bg-surface-2 hover:text-text"
              >
                Manage workspaces
              </Link>
            }
          >
            {/* ⚠ Deliberately does NOT claim the reader may create one — creation is super-admin-only, and
                `/organization` renders all four answers to that question, including "we could not check". */}
            A workspace holds your automations, connections and runs. This deployment has none yet, so there is
            nothing for this page to report.
          </Notice>
        </Zone>
      </Page>
    );
  }

  // First load failed: nothing to show but the failure and a way out.
  if (error && !data) {
    return (
      <Page>
        <Zone name="notices">
          <Notice
            tone="danger"
            title="Could not read this workspace's runs"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        </Zone>
      </Page>
    );
  }

  /*
   * ⚠ ONE tree for both the first load and the loaded page. The header and the composer need no data, and they sit
   * at the same place in both — if the loading branch rendered its own copy, React would mount a NEW composer when
   * the data arrived and wipe whatever the person had started typing.
   */
  return (
    <Page>
      <Header now={now} name={name} />

      {/* A refresh that failed AFTER a good read: keep the figures, say they may be stale. */}
      {error && (
        <Zone name="notices">
          <Notice tone="warn" title="Could not refresh — these figures may be out of date" action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}>
            {error}
          </Notice>
        </Zone>
      )}

      {/* The page's one primary action. */}
      <Zone name="controls">
        <BuildOrObserve />
      </Zone>

      <Zone name="content">
        <section aria-labelledby="health-head" className="flex flex-col gap-4">
          {/* The toolbar stays while a new choice is read, so the choice does not vanish under the click. */}
          <HealthToolbar choice={choice} onChange={setChoice} choosesScope={data?.choosesScope ?? false} updatedAt={updatedAt} now={now} />
          {/* ⚠ `!data`, NEVER `loading` — see the file header. A background refresh keeps what is on screen. */}
          {!data ? (
            <>
              <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5" aria-hidden>
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} rows={2} className="pane p-4" />
                ))}
              </div>
              <Skeleton rows={6} className="pane p-4" />
            </>
          ) : (
            <>
              <HealthFigures data={data} />
              <RecentRunsTable rows={data.recent} now={now} empty={emptyText(choice, data.scope === "mine")} />
            </>
          )}
        </section>
      </Zone>
    </Page>
  );
}

/**
 * The composer — or, for an Observer (rbac-observability), what they may do here instead. An Observer holds no
 * `flows.write`: the composer would only lead to a refusal. Unreadable shows the composer; the server decides.
 */
function BuildOrObserve() {
  const write = useCan("flows.write");
  if (!write.denied) return <HomeComposer />;
  return (
    <Notice tone="info" title="You are an Observer in this workspace">
      You can see what is in its Workspace and in the projects you are in, how their runs went, and your own usage. Building or changing a workflow
      needs a Creator role: ask an Admin of this workspace.
    </Notice>
  );
}
