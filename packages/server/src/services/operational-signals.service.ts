import { and, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowStepRuns } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { tenantBudgetService } from "./tenant-budget.service.js";
import { schedulerObservability } from "./trigger-scheduler.js";

/**
 * Is the system still doing its job? — archive/GAPS.md §6.1
 *
 * ── What this is, and what `/api/health` already is ─────────────────────────
 *
 * D-62's `/api/health` answers *"can this process serve a request"* — database,
 * migrations, Kestra, ops-api, mail. Every one of those can be green while the
 * product has quietly stopped working, because the failures §6.1 names are not
 * reachability failures. They are **things that should be happening and are
 * not**, and none of them raises an error anywhere:
 *
 *   * a scheduled flow stops firing — Kestra is up, the flow is armed, nothing runs
 *   * the staleness sweep stops — armed flows keep firing against unchecked refs
 *   * M3 slots leak — a workspace is refused by a fairness control, truthfully
 *
 * ⚠ **Every one of these was found by a person running a harness by hand**, which
 * is the whole of §6.1's complaint. This does not add alerting; it adds the
 * ANSWERS an alert would need, at one endpoint, so wiring a probe to it is
 * configuration rather than code. Choosing the alerting stack needs a deployment
 * target and remains §6.1b.
 *
 * ── The four states, and why `unknown` is one of them ───────────────────────
 *
 * `ok` · `warn` · `alarm` · **`unknown`**. The fourth is load-bearing and is the
 * difference between this and a dashboard that lies: a signal with nothing to go
 * on must not report `ok`. Two of these calibrate from history and have nothing
 * to say until there is some; the sweep signal is in-memory and knows nothing
 * for the first interval after a restart. Saying "fine" in those windows is how
 * a monitor teaches people to ignore it.
 *
 * ⚠ **Every signal carries a `caveat` naming what it cannot detect**, the same
 * rule `/api/health` follows. A signal read as stronger than it is does more
 * damage than no signal, because it displaces the manual check that was working.
 *
 * ── This endpoint does no Kestra round trips, deliberately ──────────────────
 *
 * `reconcileRunning` is the authority on whether a `running` row is really
 * running, and it costs one Kestra call per in-flight row — its own docblock
 * says *"call it ONLY on the refusal path"*. A monitoring endpoint polled every
 * 30 s must not be that path. So the slot signal reports the shape of a leak
 * (old rows, at the cap) and says plainly that it has not asked the engine.
 */

export type SignalState = "ok" | "warn" | "alarm" | "unknown";

export interface Signal {
  name: string;
  state: SignalState;
  /** One sentence a person can act on. */
  detail: string;
  /** ⚠ What this signal cannot see. Never omitted. */
  caveat: string;
  facts?: Record<string, unknown>;
}

export interface SignalsReport {
  /** The worst state across all signals — `unknown` never outranks `warn`. */
  state: SignalState;
  checkedAt: string;
  signals: Signal[];
}

const RANK: Record<SignalState, number> = { ok: 0, unknown: 1, warn: 2, alarm: 3 };

/**
 * How long a `running` execution row has to sit before it is worth mentioning.
 * Generous: an `agent` step legitimately pauses for a human, and gate 3 exists
 * to make a run wait as long as a person takes.
 */
const STALE_EXECUTION_MS = 6 * 60 * 60 * 1000;

/**
 * A scheduled flow's expected period, learned from what it actually did.
 *
 * ⚠ **Deliberately not parsed from the cron.** Parsing needs a dependency and a
 * timezone-correct evaluator, and it would answer the wrong question anyway: it
 * tells you what the flow was *configured* to do, and the failure being looked
 * for is a flow that is not doing it. Observed gaps also catch the case a cron
 * parser cannot — a schedule that has been firing at the wrong cadence all along.
 *
 * The bound is stated rather than hidden: this needs **two** executions before
 * it can say anything, and it uses the **widest** observed gap rather than the
 * median, because a weekday-only schedule has a legitimate 3-day gap every
 * weekend and a median-based threshold would page somebody every Monday.
 */
function expectedPeriodMs(startedAt: number[]): number | null {
  if (startedAt.length < 3) return null; // 3 timestamps ⇒ 2 gaps ⇒ a comparison
  const sorted = [...startedAt].sort((a, b) => a - b);
  let widest = 0;
  for (let i = 1; i < sorted.length; i++) widest = Math.max(widest, sorted[i]! - sorted[i - 1]!);
  return widest > 0 ? widest : null;
}

/** 1 — armed flows with a schedule that have stopped firing. */
async function scheduledFlowsSignal(now: number, closed: ReadonlyMap<string, string>): Promise<Signal> {
  const caveat =
    "The period is LEARNED from a flow's own execution history (>= 3 runs) and the " +
    "cron is never parsed, so a flow that has always fired at the wrong cadence looks " +
    "healthy, and a flow with fewer than 3 runs is reported as unknown rather than ok. " +
    "It also cannot tell a schedule that stopped from one an operator revoked seconds ago.";

  const live = await flowRepo.listLive();
  const scheduled: Array<{ id: string; name: string; overdueBy: number; expected: number }> = [];
  let unknown = 0;
  let checked = 0;

  for (const flow of live) {
    if (flow.armedRevision === null) continue;
    const rev = await flowRepo.getRevision(flow.id, flow.armedRevision);
    const model = rev?.modelJson as { schedule?: { cron?: string } } | undefined;
    if (!model?.schedule?.cron) continue; // not a scheduled flow; nothing to expect
    checked++;

    const runs = await flowExecutionRepo.listByFlow(flow.id, 12);
    const times = runs
      .map((r) => (r.startedAt ? new Date(r.startedAt).getTime() : NaN))
      .filter(Number.isFinite);
    const expected = expectedPeriodMs(times);
    if (expected === null || times.length === 0) {
      unknown++;
      continue;
    }
    const since = now - Math.max(...times);
    // 2x the widest observed gap. A schedule is not late until it has missed
    // roughly a whole extra period — one late tick is a slow engine, not an
    // outage, and a threshold that fires on it fires constantly.
    if (since > expected * 2) {
      // ⚠ A restricted workspace the reader is outside of: its name, never its workflow's (restricted-workspaces phase 3).
      const outside = closed.get(flow.workspaceId);
      scheduled.push(
        outside === undefined
          ? { id: flow.id, name: flow.name, overdueBy: since - expected, expected }
          : { id: "", name: `a workflow in restricted workspace "${outside}"`, overdueBy: since - expected, expected },
      );
    }
  }

  if (checked === 0) {
    return {
      name: "scheduled_flows_firing",
      state: "ok",
      detail: "no armed flow declares a schedule, so nothing is expected to fire",
      caveat,
      facts: { armedWithSchedule: 0 },
    };
  }
  if (scheduled.length) {
    return {
      name: "scheduled_flows_firing",
      state: "alarm",
      detail:
        `${scheduled.length} of ${checked} scheduled flow(s) have not fired in more than twice ` +
        `their observed period: ${scheduled.map((f) => f.name).join(", ")}`,
      caveat,
      facts: { armedWithSchedule: checked, overdue: scheduled, uncalibrated: unknown },
    };
  }
  return {
    name: "scheduled_flows_firing",
    state: unknown === checked ? "unknown" : "ok",
    detail:
      unknown === checked
        ? `${checked} scheduled flow(s), none with enough history to calibrate a period yet`
        : `${checked - unknown} scheduled flow(s) firing on schedule` +
          (unknown ? `; ${unknown} not yet calibrated` : ""),
    caveat,
    facts: { armedWithSchedule: checked, uncalibrated: unknown },
  };
}

/** 2 — the approval staleness sweep, which is silent when it works. */
function stalenessSweepSignal(now: number): Signal {
  const o = schedulerObservability;
  const caveat =
    "In-memory and single-process: a restart resets it, so it reports unknown rather " +
    "than alarm until one sweep interval has passed since boot. It says the sweep RAN, " +
    "never that it reached every flow — `sweepStaleness` swallows nothing, but a sweep " +
    "that checked 0 armed flows and one that checked 40 both look like a sweep.";

  if (o.startedAt === null) {
    return {
      name: "staleness_sweep",
      state: "alarm",
      detail: "the trigger scheduler was never started in this process, so nothing sweeps staleness",
      caveat,
      facts: { startedAt: null },
    };
  }
  const facts = {
    startedAt: new Date(o.startedAt).toISOString(),
    lastSweepAt: o.lastSweepAt ? new Date(o.lastSweepAt).toISOString() : null,
    lastSweepChecked: o.lastSweepChecked,
    lastSweepSuspended: o.lastSweepSuspended,
    lastSweepError: o.lastSweepError,
    sweepIntervalMs: o.sweepIntervalMs,
    ticks: o.ticks,
  };
  // Two intervals of grace: one for the sweep that has not come round yet, one
  // so a single slow tick is not an incident.
  const grace = o.sweepIntervalMs * 2;
  if (o.lastSweepAt === null) {
    const sinceBoot = now - o.startedAt;
    return {
      name: "staleness_sweep",
      state: sinceBoot < grace ? "unknown" : "alarm",
      detail:
        sinceBoot < grace
          ? "the scheduler started recently and has not reached its first sweep yet"
          : `the scheduler has been up for ${Math.round(sinceBoot / 1000)}s and has never completed a sweep`,
      caveat,
      facts,
    };
  }
  const since = now - o.lastSweepAt;
  if (since > grace) {
    return {
      name: "staleness_sweep",
      state: "alarm",
      detail:
        `the last staleness sweep completed ${Math.round(since / 1000)}s ago, more than twice ` +
        `its interval — armed flows are firing against refs nobody is re-checking` +
        (o.lastSweepError ? ` (last error: ${o.lastSweepError})` : ""),
      caveat,
      facts,
    };
  }
  return {
    name: "staleness_sweep",
    state: o.lastSweepError ? "warn" : "ok",
    detail: o.lastSweepError
      ? `sweeping, but the last attempt errored: ${o.lastSweepError}`
      : `last sweep ${Math.round(since / 1000)}s ago — checked ${o.lastSweepChecked}, suspended ${o.lastSweepSuspended}`,
    caveat,
    facts,
  };
}

/** 3 — M3 concurrency slots held by rows that will never be closed. */
async function executionSlotsSignal(now: number): Promise<Signal> {
  const caveat =
    "It does NOT ask Kestra. `reconcileRunning` is the authority on whether a `running` " +
    "row is really running and costs one engine call per row — its own docblock says to " +
    "call it only on the refusal path, and a monitoring endpoint must not be that path. " +
    "So this reports the SHAPE of a leak (old rows, at the cap), not a confirmed one: a " +
    "genuinely long-running flow and a leaked slot look identical from here.";

  const workspaces = await workspaceRepo.list();
  const at: Array<{ workspace: string; running: number; limit: number; oldestHours: number }> = [];
  const stale: Array<{ workspace: string; running: number; oldestHours: number }> = [];

  for (const ws of workspaces) {
    const rows = await flowExecutionRepo.listRunning(ws.id);
    if (rows.length === 0) continue;
    const ages = rows.map((r) => (r.startedAt ? now - new Date(r.startedAt).getTime() : 0));
    const oldest = ages.length ? Math.max(...ages) : 0;
    const oldestHours = Math.round(oldest / 3600_000);
    const budget = await tenantBudgetService.resolve(ws.id);
    const limit = budget.maxConcurrentExecutions;
    if (rows.length >= limit && oldest > STALE_EXECUTION_MS) {
      at.push({ workspace: ws.name, running: rows.length, limit, oldestHours });
    } else if (oldest > STALE_EXECUTION_MS) {
      stale.push({ workspace: ws.name, running: rows.length, oldestHours });
    }
  }

  if (at.length) {
    return {
      name: "execution_slots",
      state: "alarm",
      detail:
        `${at.length} workspace(s) are AT their concurrency limit with an execution older than ` +
        `${STALE_EXECUTION_MS / 3600_000}h: ${at.map((w) => `${w.workspace} (${w.running}/${w.limit})`).join(", ")}. ` +
        `The next run there is refused by a fairness control, which is exactly how I-10 presented.`,
      caveat,
      facts: { atLimit: at, stale },
    };
  }
  if (stale.length) {
    return {
      name: "execution_slots",
      state: "warn",
      detail:
        `${stale.length} workspace(s) hold an execution older than ${STALE_EXECUTION_MS / 3600_000}h ` +
        `but are below their limit: ${stale.map((w) => `${w.workspace} (${w.oldestHours}h)`).join(", ")}`,
      caveat,
      facts: { atLimit: at, stale },
    };
  }
  return {
    name: "execution_slots",
    state: "ok",
    detail: "no workspace is holding an old `running` execution",
    caveat,
    facts: { atLimit: [], stale: [] },
  };
}

/** `closed`: restricted workspaces the reader is outside of (`closedTo`) — named, their workflows never. */
export async function operationalSignals(closed: ReadonlyMap<string, string> = new Map()): Promise<SignalsReport> {
  const now = Date.now();
  // Sequential, not parallel: this is a monitoring endpoint and the database it
  // reads is the one serving the product. Three short queries in a row cost less
  // than three connections held at once, and nothing here is latency-sensitive.
  const signals: Signal[] = [];
  for (const check of [
    () => scheduledFlowsSignal(now, closed),
    () => Promise.resolve(stalenessSweepSignal(now)),
    () => executionSlotsSignal(now),
  ]) {
    try {
      signals.push(await check());
    } catch (e) {
      // ⚠ A signal that threw is `unknown`, never omitted and never `ok`. A
      // report that silently drops the check that broke is the exact failure
      // this endpoint exists to prevent, one level up.
      signals.push({
        name: "unavailable",
        state: "unknown",
        detail: `a signal could not be computed: ${(e as Error).message}`,
        caveat: "This entry means a check FAILED, not that it passed. Which check is in the message.",
      });
    }
  }

  return {
    state: signals.reduce<SignalState>((worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst), "ok"),
    checkedAt: new Date(now).toISOString(),
    signals,
  };
}
