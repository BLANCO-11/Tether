import crypto from "node:crypto";
import { guardedFetch, STRICT } from "@foundry/shared";
import { config } from "../config/index.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { triggerService } from "./trigger.service.js";
import { flowApprovalService } from "./flow-approval.service.js";

/**
 * What is LEFT of the in-process scheduler after Phase 3.
 * archive/kestra-migration/03-architecture.md §5.4 · 07 §7.2
 *
 * ── What went, and why the poll loop stayed ─────────────────────────────────
 *
 * Cron handling is gone. Kestra owns schedule triggers from §5.4 on, and it
 * brings timezone handling, catch-up and overlap policy — all of which this
 * loop approximated with `intervalMinutes` and a `lastFiredAt` comparison, i.e.
 * not a cron at all. A flow's schedule now lives on its model and is deployed
 * into the live namespace at approval.
 *
 * The poll loop survives because it has no Kestra equivalent: "fire when the
 * content at this URL changes since I last looked" is a hash Foundry holds, and
 * Kestra's polling triggers do not express it (§5.4).
 *
 * ── And it gained a job ──────────────────────────────────────────────────────
 *
 * 08 §10 says the scheduler "checks approval validity + staleness each tick",
 * written when Foundry owned schedules. There is no longer a per-flow tick to
 * hang that on, so the sweep runs here — the one loop still turning. See
 * DECISIONS.md D-17 for what that costs: divergence is detected within a tick
 * rather than before the next firing, so `begin` carries the fingerprint check
 * as well.
 *
 * ⚠ SINGLE NODE. Both passes assume one process: `lastPollHash` is in memory,
 * and two replicas would sweep and poll twice. Fine while Foundry runs one
 * container; it is the same in-process assumption `pollRun` makes, and Phase 4
 * has to solve it once for both.
 */
const TICK_MS = 20_000;
/** Staleness is a slow-moving property; sweeping every tick is wasted queries. */
const SWEEP_EVERY_TICKS = 3;

const lastPollHash = new Map<string, string>();
const lastPollAt = new Map<string, number>();
let tickCount = 0;

/**
 * What this loop last did — read by `operational-signals.service.ts` (GAPS §6.1).
 *
 * ⚠ The sweep is a control whose SILENCE is indistinguishable from success, by
 * design: it logs only when it suspends something, because "0 of 0" once a
 * minute is how a log stops being read. That was the right call for the log and
 * it left "the sweep stopped running" invisible — the loop can die (an unhandled
 * rejection, a `setInterval` cleared, a boot path that never called
 * `startTriggerScheduler`) and every armed flow keeps firing against refs
 * nobody re-checked.
 *
 * ⚠ In-memory, so a restart resets it — which is why the signal reports
 * `unknown` rather than `alarm` until an interval has passed since boot. Saying
 * "the sweep has never run" one second after start is a false alarm, and false
 * alarms are how a signal gets muted.
 */
export const schedulerObservability = {
  startedAt: null as number | null,
  lastTickAt: null as number | null,
  lastSweepAt: null as number | null,
  lastSweepChecked: null as number | null,
  lastSweepSuspended: null as number | null,
  lastSweepError: null as string | null,
  ticks: 0,
  tickMs: TICK_MS,
  sweepEveryTicks: SWEEP_EVERY_TICKS,
  /** How long between sweeps when everything is healthy. */
  get sweepIntervalMs() {
    return TICK_MS * SWEEP_EVERY_TICKS;
  },
};

function due(lastMs: number | null | undefined, everyMs: number, nowMs: number): boolean {
  if (!everyMs || everyMs <= 0) return false;
  if (!lastMs) return true;
  return nowMs - lastMs >= everyMs;
}

/** Exported for the test — same convention as datasource-target.service.ts's `_addressClass`. */
export async function _tick() {
  const now = Date.now();
  tickCount++;
  schedulerObservability.ticks = tickCount;
  schedulerObservability.lastTickAt = now;

  // --- Forge workflows' schedules (pi-runtime P5): Kestra keeps compiled flows' crons; these are Foundry's own ---
  try {
    const { flowRunnerService } = await import("./flow-runner.service.js");
    await flowRunnerService.tickSchedules(new Date(now));
  } catch (e) {
    console.warn(`[scheduler] Forge schedule tick failed: ${(e as Error).message}`);
  }

  // --- poll triggers: fetch config.url every config.intervalSeconds; fire on change ---
  try {
    const polls = await triggerRepo.listEnabledByType("poll");
    // ── How many URLs one tick may dial ────────────────────────────────────────
    //
    // The loop below is SEQUENTIAL and each dial waits up to 8s, so N due poll
    // triggers make a tick take up to 8N seconds — and the approval-staleness
    // sweep runs after it, in this same tick. So enough poll triggers do not just
    // slow polling down: they starve the sweep, which is one of the four
    // silent-failure signals precisely because its silence looks like success
    // (`/api/signals`, D-66). Unbounded work in front of a watchdog is the
    // failure being bounded here.
    //
    // ⚠ Fairness needs no rotation state, and that is why the cap sits here
    // rather than inside the loop: `lastPollAt` is only stamped for triggers this
    // tick actually polls, so a skipped one stays due and is taken next tick.
    // Moving this below the `lastPollAt.set` would mark skipped triggers as
    // polled and starve the tail permanently.
    const dueNow = polls.filter((t) => {
      const cfg = (t.config ?? {}) as { url?: string; intervalSeconds?: number };
      if (!cfg.url) return false;
      return due(lastPollAt.get(t.id), (cfg.intervalSeconds ?? 60) * 1000, now);
    });
    const batch = dueNow.slice(0, config.pollTriggersPerTick);
    // ⚠ Never a silent cap. A tick that quietly dropped work reads exactly like a
    // tick with nothing to do, and the symptom is "my trigger sometimes doesn't
    // fire" with nothing in the log to point at.
    if (dueNow.length > batch.length) {
      console.warn(
        `[scheduler] ${dueNow.length} poll triggers due, polling ${batch.length} this tick ` +
          `(POLL_TRIGGERS_PER_TICK=${config.pollTriggersPerTick}); the rest stay due and are ` +
          `taken next tick`,
      );
    }
    for (const t of batch) {
      const cfg = (t.config ?? {}) as { url?: string; intervalSeconds?: number };
      if (!cfg.url) continue;
      lastPollAt.set(t.id, now);
      try {
        // FR-008 (research.md Decision 2) — `cfg.url` is tenant-supplied and
        // re-classified against the STRICT profile immediately before dialing.
        //
        // ⚠ That NARROWS the registration-to-dial window; it does not close it.
        // `guardedFetch` resolves the host and then `fetch` resolves it again to
        // open the socket, so the address classified is not provably the address
        // dialled — closing that needs a dispatcher-level hook (see
        // `guardedFetch`'s own docblock). What it does close outright: every
        // alternate encoding of a reserved address, and an unresolvable host,
        // both of which were reachable here in a single request.
        const res = await guardedFetch(cfg.url, { signal: AbortSignal.timeout(8000) }, STRICT);
        const body = await res.text();
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        const prev = lastPollHash.get(t.id);
        lastPollHash.set(t.id, hash);
        if (prev !== undefined && prev !== hash) {
          console.log(`[scheduler] poll change detected for ${t.name} (${t.id}) → firing`);
          await triggerService.fire(t.id, "poll", { url: cfg.url, changed: true });
        }
      } catch (e) {
        console.warn(`[scheduler] poll ${t.id} failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("[scheduler] poll pass error:", (e as Error).message);
  }

  // --- approval staleness: suspend any armed flow whose refs changed shape ---
  if (tickCount % SWEEP_EVERY_TICKS === 0) {
    try {
      const { checked, suspended } = await flowApprovalService.sweepStaleness();
      schedulerObservability.lastSweepAt = Date.now();
      schedulerObservability.lastSweepChecked = checked;
      schedulerObservability.lastSweepSuspended = suspended;
      schedulerObservability.lastSweepError = null;
      // Only when something happened. A line per minute saying "0 of 0" is how a
      // log stops being read, and this is a control whose output has to be.
      if (suspended > 0) {
        console.warn(`[scheduler] approval sweep: suspended ${suspended} of ${checked} armed flow(s)`);
      }
    } catch (e) {
      // Recorded as well as logged. A sweep that throws every tick logs a line
      // nobody greps for and otherwise looks exactly like a sweep that is
      // running clean — `lastSweepAt` stays stale and the signal says so.
      schedulerObservability.lastSweepError = (e as Error).message;
      console.warn("[scheduler] approval sweep error:", (e as Error).message);
    }
  }
}

export function startTriggerScheduler(): NodeJS.Timeout {
  schedulerObservability.startedAt = Date.now();
  console.log("[scheduler] poll + approval-staleness loop started (tick 20s; cron is Kestra's)");
  return setInterval(() => void _tick(), TICK_MS);
}
