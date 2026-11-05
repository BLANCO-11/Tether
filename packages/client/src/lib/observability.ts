/** Pure helpers for Dashboards & Reports (pi-runtime P-OBS) — kept out of the page so they can be tested. */
import type { Observability, UsagePurpose } from "@/lib/types";

/** A dollar figure at the precision it needs: tiny model costs keep four places, anything over a cent two. */
export function usd(n: number | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001"; // real, and too small to print — never "$0.0000", which reads as free
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Every day in the window, so a quiet day is a gap and not a missing bar. */
export function dayRange(since: string, days: number): string[] {
  const start = new Date(since);
  return Array.from({ length: days + 1 }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

/** One row per workflow: its runs and success, and (for admins) its cost per purpose. */
export function flowRows(data: Observability) {
  const rows = new Map<string, { flowId: string | null; name: string | null; runs: number; succeeded: number; cost: Record<UsagePurpose, number> }>();
  const get = (id: string | null, name: string | null) => {
    const k = id ?? "∅";
    if (!rows.has(k)) rows.set(k, { flowId: id, name, runs: 0, succeeded: 0, cost: { building: 0, test: 0, live: 0 } });
    const r = rows.get(k)!;
    if (!r.name && name) r.name = name;
    return r;
  };
  for (const f of data.runsByFlow) {
    const r = get(f.flowId, f.name);
    r.runs += f.total;
    r.succeeded += f.succeeded;
  }
  for (const f of data.byFlow) get(f.flowId, f.flowName).cost[f.purpose] += f.costUsd ?? 0;
  const total = (r: { cost: Record<UsagePurpose, number> }) => r.cost.building + r.cost.test + r.cost.live;
  return [...rows.values()].sort((a, b) => total(b) - total(a) || b.runs - a.runs);
}
