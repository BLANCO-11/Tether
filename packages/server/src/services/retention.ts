/**
 * Retention IS the replay window — GAPS §6.3, and this module is where that
 * stops being a fact you have to already know.
 *
 * ── The coupling ─────────────────────────────────────────────────────────────
 *
 * Kestra OSS has no `kestra.retention.*`, so retention is a scheduled flow
 * (`kestra/retention.flow.yml`, deployed by `kestra:system`) that purges
 * terminal executions older than `KESTRA_RETENTION_DAYS`. Replay needs the
 * ENGINE's copy of the upstream step outputs — Foundry keeps the pointer, not
 * the data (R6) — so the moment the purge takes an execution, that run stops
 * being replayable. One number, two consequences, and only one of them is
 * obvious from the variable's name.
 *
 * The number stays in ONE place, `config.kestra.retentionDays`. Two independent
 * defaults would eventually promise 30 days while the purge ran at 7, which is
 * the failure this file exists to keep impossible: everything that quotes the
 * window — the replay refusal, the replay control in the browser, the deploy
 * script's own output, the flow's description in the Kestra UI — computes it
 * from here.
 *
 * ── What this module is NOT ──────────────────────────────────────────────────
 *
 * It is not a second source for the number, and `days` must never become a
 * parameter with a default. It reads `config` and nothing else, it holds no
 * database handle, and it imports no repository — which is what lets a host
 * script (`deploy-system-flows.ts`) use it without pulling in a connection
 * pool.
 */
import { config } from "../config/index.js";

const DAY_MS = 86_400_000;

/**
 * When "soon" starts, as a fraction of the window.
 *
 * A fraction rather than a fixed 7 days, because the whole point of §6.3 is
 * that the window MOVES. Hard-coding a week means a deployment that shortens
 * retention to 5 days warns nobody until the run is already gone, and one that
 * lengthens it to a year warns from day 358 — in both cases the warning has
 * quietly stopped tracking the thing it is warning about.
 */
const WARN_FRACTION = 0.25;

export interface ReplayWindow {
  /** `KESTRA_RETENTION_DAYS`. The retention window and the replay window — one number. */
  days: number;
  /** When the purge becomes eligible to take this run. `null` if the run has no start time. */
  expiresAt: string | null;
  /** Floored at 0, so an already-purgeable run reads `0` rather than a negative. */
  daysRemaining: number | null;
  /** Close enough to the edge to say so before somebody plans around it. */
  expiringSoon: boolean;
  /**
   * The coupling, in one sentence, written for whoever is reading it at the
   * point of use. Served WITH the numbers rather than kept in a doc — a person
   * deciding whether to replay tomorrow is not going to open `archive/GAPS.md`.
   */
  note: string;
}

/** The configured window. The single reader of the config key outside `config` itself. */
export function retentionDays(): number {
  return config.kestra.retentionDays;
}

/**
 * The sentence every surface quoting the window uses.
 *
 * One phrasing, imported everywhere. A second copy is a second thing to keep
 * true, and the way that fails is that one surface goes on promising the old
 * number after somebody changes it.
 */
export function retentionCoupling(days = retentionDays()): string {
  return (
    `Executions are retained for ${days} days, and that IS the replay window — ` +
    `KESTRA_RETENTION_DAYS is one number with both meanings. Replay needs the engine's copy ` +
    `of the upstream step outputs and Tether keeps the pointer, not the data, so shortening ` +
    `retention shortens how far back a run can be replayed.`
  );
}

/**
 * How much of the window this particular run has left.
 *
 * Measured from when the run STARTED, because that is what
 * `PurgeExecutions`'s `endDate` compares against — a long-running execution is
 * purged on its start date, not on when it finished, and using `endedAt` here
 * would over-promise on exactly the runs most likely to be replayed.
 */
export function replayWindow(
  startedAt: Date | string | null | undefined,
  now: Date = new Date(),
): ReplayWindow {
  const days = retentionDays();
  const note = retentionCoupling(days);
  if (!startedAt) return { days, expiresAt: null, daysRemaining: null, expiringSoon: false, note };

  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(started.getTime())) {
    return { days, expiresAt: null, daysRemaining: null, expiringSoon: false, note };
  }

  const expires = new Date(started.getTime() + days * DAY_MS);
  const remaining = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / DAY_MS));
  return {
    days,
    expiresAt: expires.toISOString(),
    daysRemaining: remaining,
    // A run that is already past the window is not "expiring soon" — it has
    // expired, and the plan's own refusal says so with the 410's wording. Two
    // warnings about the same thing, one of them wrong about the tense, is how
    // people stop reading either.
    expiringSoon: remaining > 0 && remaining <= Math.max(1, Math.ceil(days * WARN_FRACTION)),
    note,
  };
}
