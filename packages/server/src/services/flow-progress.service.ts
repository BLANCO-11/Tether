/**
 * Phase 2 — per-step progress, pushed.
 * archive/kestra-migration/progress/phase-2.md 2.8
 *
 * `/runs/[id]` polled `GET …/flow-executions/:id` every 2s. That is fine for the
 * Phase 1 flows, which finish in about a second, and wrong for what Phase 4 adds:
 * an `agent` step decodes for ~5–6 minutes (CLAUDE.md, measured) and a human
 * approval `Pause` can sit for days. Polling that for a whole afternoon means
 * thousands of full re-assemblies — each one a Kestra execution fetch, a log
 * fetch and a graph fetch — to report that nothing has changed.
 *
 * ── Why the poll lives here and not in the browser ───────────────────────────
 *
 * R5: a client cannot reach Kestra, so *someone* has to poll on its behalf. Doing
 * it once per execution on the server also collapses N watchers into one upstream
 * poll — three engineers on the same broken run cost what one costs.
 *
 * ── Why a ticket instead of just an execution id ─────────────────────────────
 *
 * The browser never holds `PARENT_API_KEY`: it calls a same-origin Next route
 * which injects the key server-side (`app/api/foundry/[...path]/route.ts`). A
 * WebSocket opened straight at :4001 skips that entirely, so an id-only socket
 * would be the one unauthenticated read path in the product — strictly weaker
 * than the REST route it mirrors, and it carries the same data.
 *
 * So watching is a two-step handshake: an AUTHENTICATED `POST …/:id/watch` mints
 * a single-use, short-lived ticket bound to exactly one (workspace, execution),
 * and the socket presents that. A leaked ticket is worth one already-authorised
 * subscription to one execution for 60 seconds, and nothing else — no other
 * execution, no other workspace, no write.
 *
 * Tickets are held in memory ON PURPOSE. The socket is served by this process, so
 * a ticket is only ever valid in this process; a table would advertise a
 * durability the socket cannot honour, and would leave rows behind for every page
 * view.
 */
import crypto from "node:crypto";
import { flowVisibilityService, type ExecutionView, type StepView } from "./flow-visibility.service.js";

/** Long enough to survive a page load, short enough that a leaked ticket is stale on arrival. */
const TICKET_TTL_MS = 60_000;

/**
 * How often the engine is asked about a watched execution.
 *
 * Faster than the 2s the page used to poll at, because this is ONE poll shared by
 * every watcher rather than one per browser tab, and because a step that takes
 * 100ms should not be reported 2 seconds late.
 */
const POLL_MS = 1000;

/** A watched execution with nobody watching is dropped after this, so a closed tab stops the poll. */
const IDLE_GRACE_MS = 5_000;

/** Terminal engine states — the poller stops itself here rather than running forever. */
const TERMINAL = new Set(["success", "warning", "failed", "cancelled"]);

export type ProgressEvent =
  | { type: "snapshot"; execution: ExecutionView }
  | { type: "step"; step: StepView }
  | { type: "execution"; engineStatus: string; status: string; durationMs: number | null }
  | { type: "end"; engineStatus: string }
  | { type: "error"; message: string };

interface Ticket {
  workspaceId: string;
  flowExecutionId: string;
  expiresAt: number;
}

interface Watch {
  workspaceId: string;
  subscribers: Set<(e: ProgressEvent) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Last emitted per-step fingerprint, so an unchanged step is not re-sent. */
  lastStep: Map<string, string>;
  lastEngineStatus: string | null;
  /**
   * The most recent full view, kept so a LATE subscriber can be given a snapshot.
   *
   * Without this, the second tab on a shared execution joins a diff stream that
   * has already emitted everything it is going to emit, and renders an empty run
   * until the next step happens — which on a paused approval could be tomorrow.
   */
  lastView: ExecutionView | null;
  emptySince: number | null;
  stopped: boolean;
}

/**
 * What makes a step "changed".
 *
 * Deliberately includes the error and the response code, not just the status: a
 * step that goes FAILED and then has its error log arrive a poll later must send
 * the second version too, or the panel shows a red step with no reason.
 */
function fingerprint(s: StepView): string {
  return JSON.stringify([s.status, s.attempt, s.durationMs, s.responseCode, s.error, s.logs.length, s.output]);
}

const tickets = new Map<string, Ticket>();
const watches = new Map<string, Watch>();

function pruneTickets(now: number) {
  for (const [k, t] of tickets) if (t.expiresAt <= now) tickets.delete(k);
}

export const flowProgressService = {
  /**
   * Mint a watch ticket. The caller must ALREADY have proved it may read this
   * execution — this does not check, it records.
   */
  mintTicket(workspaceId: string, flowExecutionId: string): { ticket: string; expiresAt: string } {
    const now = Date.now();
    pruneTickets(now);
    const ticket = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + TICKET_TTL_MS;
    tickets.set(ticket, { workspaceId, flowExecutionId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  },

  /**
   * Redeem a ticket, once.
   *
   * Deleted on read whatever the outcome, so a replay of a captured URL fails
   * even inside the TTL. Returns null for unknown and for expired alike — a
   * caller that could tell them apart could probe which tickets exist.
   */
  redeemTicket(ticket: string): { workspaceId: string; flowExecutionId: string } | null {
    if (!ticket) return null;
    const found = tickets.get(ticket);
    tickets.delete(ticket);
    if (!found || found.expiresAt <= Date.now()) return null;
    return { workspaceId: found.workspaceId, flowExecutionId: found.flowExecutionId };
  },

  /**
   * Subscribe to one execution. Returns an unsubscribe function.
   *
   * The first subscriber starts the poll; the last one to leave stops it after a
   * short grace period, so a refresh does not tear down and rebuild the loop.
   */
  subscribe(
    workspaceId: string,
    flowExecutionId: string,
    onEvent: (e: ProgressEvent) => void,
  ): () => void {
    let watch = watches.get(flowExecutionId);
    if (!watch) {
      watch = {
        workspaceId,
        subscribers: new Set(),
        timer: null,
        lastStep: new Map(),
        lastEngineStatus: null,
        lastView: null,
        emptySince: null,
        stopped: false,
      };
      watches.set(flowExecutionId, watch);
      void poll(flowExecutionId, watch);
    }
    watch.subscribers.add(onEvent);
    watch.emptySince = null;
    // A subscriber that arrived after the stream started gets the current state
    // straight away rather than waiting for the next thing to change.
    if (watch.lastView) onEvent({ type: "snapshot", execution: watch.lastView });

    return () => {
      watch!.subscribers.delete(onEvent);
      if (watch!.subscribers.size === 0) watch!.emptySince = Date.now();
    };
  },

  /** Test seam: how many executions are being polled right now. */
  _activeWatches(): number {
    return watches.size;
  },

  /** Test seam: drop all state. */
  _reset() {
    for (const w of watches.values()) {
      w.stopped = true;
      if (w.timer) clearTimeout(w.timer);
    }
    watches.clear();
    tickets.clear();
  },
};

async function poll(flowExecutionId: string, watch: Watch): Promise<void> {
  if (watch.stopped) return;

  // Nobody has been listening for a while — stop, and forget, so a re-open starts
  // clean rather than replaying a stale diff.
  if (watch.emptySince !== null && Date.now() - watch.emptySince > IDLE_GRACE_MS) {
    watch.stopped = true;
    watches.delete(flowExecutionId);
    return;
  }

  let view: ExecutionView | null = null;
  try {
    view = await flowVisibilityService.get(watch.workspaceId, flowExecutionId);
  } catch (e) {
    // Do not kill the watch: the engine restarting is exactly when someone is
    // watching. Report it and try again on the next tick.
    emit(watch, { type: "error", message: e instanceof Error ? e.message : String(e) });
  }

  if (view) {
    // The very first tick sends the whole thing. Everything after is a diff, so a
    // paused approval step costs one Kestra fetch and zero bytes to the browser.
    const first = watch.lastEngineStatus === null;
    watch.lastView = view;
    if (first) {
      emit(watch, { type: "snapshot", execution: view });
      for (const s of view.steps) watch.lastStep.set(s.stepId, fingerprint(s));
    } else {
      for (const s of view.steps) {
        const fp = fingerprint(s);
        if (watch.lastStep.get(s.stepId) === fp) continue;
        watch.lastStep.set(s.stepId, fp);
        emit(watch, { type: "step", step: s });
      }
    }

    if (view.engineStatus !== watch.lastEngineStatus) {
      watch.lastEngineStatus = view.engineStatus;
      if (!first)
        emit(watch, {
          type: "execution",
          engineStatus: view.engineStatus,
          status: view.status,
          durationMs: view.durationMs,
        });
    }

    if (TERMINAL.has(view.engineStatus)) {
      emit(watch, { type: "end", engineStatus: view.engineStatus });
      watch.stopped = true;
      watches.delete(flowExecutionId);
      return;
    }
  }

  watch.timer = setTimeout(() => void poll(flowExecutionId, watch), POLL_MS);
  // Do not hold the process open for a poll loop (matters to the test runner and
  // to a clean shutdown).
  watch.timer.unref?.();
}

function emit(watch: Watch, e: ProgressEvent) {
  for (const fn of watch.subscribers) {
    try {
      fn(e);
    } catch {
      // One broken subscriber must not stop the others from being told.
    }
  }
}
