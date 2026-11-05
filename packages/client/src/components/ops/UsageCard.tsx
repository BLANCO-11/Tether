"use client";

/**
 * The dashboard's glance at usage (pi-runtime P-OBS): this month's cost — to those who may see it — or tokens, and
 * how live runs went. The breakdowns are on Dashboards & Reports. Unreadable says so; it never shows zeros it did
 * not read.
 */
import Link from "next/link";
import { useAsync } from "@/lib/hooks";
import { getObservability } from "@/lib/api";
import { usd } from "@/lib/observability";

export function UsageCard() {
  const { data, error } = useAsync(() => getObservability(30), []);
  const tokens = data ? data.byPurpose.reduce((a, p) => a + p.tokensIn + p.tokensOut, 0) : 0;
  const building = data?.byPurpose.find((p) => p.purpose === "building");
  const live = data?.runs.live;
  return (
    <section className="pane p-4" aria-labelledby="usage-head" data-testid="usage-card">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="usage-head" className="text-body font-semibold">Usage</h2>
        <Link href="/reports" className="text-xs text-accent hover:underline">
          Reports
        </Link>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-muted">Usage could not be read: {error}</p>
      ) : !data ? (
        <p className="mt-2 text-sm text-muted">Reading…</p>
      ) : (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-caption text-dim">{data.costVisible ? "Cost, 30 days" : "Tokens, 30 days"}</dt>
            <dd className="text-lg font-semibold tabular-nums">{data.costVisible ? usd(data.costUsd) : tokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-caption text-dim">Building</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {data.costVisible ? usd(building?.costUsd ?? 0) : String(building?.modelCalls ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-dim">Live runs succeeded</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {live?.successRate == null ? "—" : `${Math.round(live.successRate * 100)}%`}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
