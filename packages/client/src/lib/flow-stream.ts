// src/lib/flow-stream.ts — live step progress for one flow execution.
// archive/kestra-migration/progress/phase-2.md 2.8
//
// `/runs/[id]` used to re-fetch the whole execution every 2 seconds. This
// subscribes instead: the server polls Kestra once per execution and pushes only
// what changed (`services/flow-progress.service.ts`).
//
// ── Polling is kept, as the fallback ─────────────────────────────────────────
//
// The socket needs :4001 reachable from the browser, which is true in compose and
// need not be true everywhere — and `FOUNDRY_WS_URL` may simply be unset. A
// missing socket must degrade to a slower view of the same data, never to a page
// that shows nothing. So: try the socket, and if it does not open (or it drops
// before the run ends), fall back to polling the REST endpoint. Both paths read
// the SAME server-side assembly, so neither can show something the other cannot.
"use client";

import { getFlowExecution, watchFlowExecution } from "@/lib/api";
import type { FlowExecutionDetail, StepRun } from "@/lib/types";

/** Fallback cadence. Only used when the socket is unavailable. */
const POLL_MS = 2000;

/** Engine states that mean the run is still going. */
const LIVE = ["running", "created", "paused"];

export function isLive(engineStatus: string): boolean {
  return LIVE.includes(engineStatus);
}

type ServerEvent =
  | { type: "snapshot"; execution: FlowExecutionDetail }
  | { type: "step"; step: StepRun }
  | { type: "execution"; engineStatus: string; status: string; durationMs: number | null }
  | { type: "end"; engineStatus: string }
  | { type: "error"; message: string };

export type FlowStreamHandlers = {
  /** Called with the complete execution every time it changes. */
  onUpdate: (execution: FlowExecutionDetail) => void;
  onError: (message: string) => void;
  /** Which transport ended up being used, for the "live" indicator. */
  onTransport?: (t: "socket" | "poll") => void;
};

/**
 * Apply one pushed step to the execution we are holding.
 *
 * A step that arrives for an id we have not seen is APPENDED rather than dropped:
 * during a live run, steps appear as the engine reaches them, and the first
 * anyone hears of `notify` is the event saying it started.
 */
function withStep(prev: FlowExecutionDetail, step: StepRun): FlowExecutionDetail {
  const i = prev.steps.findIndex((s) => s.stepId === step.stepId);
  const steps = i === -1 ? [...prev.steps, step] : prev.steps.map((s, j) => (j === i ? step : s));
  return { ...prev, steps };
}

async function socketUrl(): Promise<string | null> {
  try {
    const res = await fetch("/api/foundry-config", { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as { wsUrl?: string | null };
    return cfg.wsUrl?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Watch one execution until it finishes or the caller stops.
 *
 * Returns a `close()`. Safe to call more than once.
 */
export function openFlowStream(id: string, h: FlowStreamHandlers): { close: () => void } {
  let closed = false;
  let socket: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let current: FlowExecutionDetail | null = null;

  const push = (next: FlowExecutionDetail) => {
    current = next;
    if (!closed) h.onUpdate(next);
  };

  // ── The fallback ───────────────────────────────────────────────────────────
  const startPolling = () => {
    if (closed || pollTimer) return;
    h.onTransport?.("poll");
    const tick = async () => {
      if (closed) return;
      try {
        const next = await getFlowExecution(id);
        push(next);
        if (!isLive(next.engineStatus)) return; // settled: stop
      } catch (e) {
        h.onError(e instanceof Error ? e.message : String(e));
      }
      if (!closed) pollTimer = setTimeout(tick, POLL_MS);
    };
    void tick();
  };

  void (async () => {
    // The first read is always REST. It renders the page immediately rather than
    // after a socket handshake, and — because it 404s for another workspace — it
    // is also what proves the run is ours before a ticket is minted.
    try {
      const first = await getFlowExecution(id);
      push(first);
      if (!isLive(first.engineStatus)) return; // already finished; nothing to stream
    } catch (e) {
      h.onError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (closed) return;

    const base = await socketUrl();
    if (!base) return startPolling();

    let ticket: string;
    try {
      ticket = (await watchFlowExecution(id)).ticket;
    } catch {
      // The mint is authenticated and workspace-scoped; if it fails, the socket
      // would have failed too. Poll.
      return startPolling();
    }
    if (closed) return;

    try {
      socket = new WebSocket(`${base.replace(/\/$/, "")}/ws/flow-execution?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      return startPolling();
    }

    let everOpened = false;

    socket.onopen = () => {
      everOpened = true;
      h.onTransport?.("socket");
    };

    socket.onmessage = (ev) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(String(ev.data)) as ServerEvent;
      } catch {
        return;
      }
      switch (msg.type) {
        case "snapshot":
          return push(msg.execution);
        case "step":
          return current ? push(withStep(current, msg.step)) : undefined;
        case "execution":
          return current
            ? push({
                ...current,
                engineStatus: msg.engineStatus as FlowExecutionDetail["engineStatus"],
                status: msg.status,
                durationMs: msg.durationMs,
              })
            : undefined;
        case "end":
          // One last REST read. The stream carried the diffs; this guarantees the
          // final view is byte-for-byte what the server would serve — including
          // the fields a diff never touches, like `endedAt`.
          void getFlowExecution(id).then(push).catch(() => {});
          return;
        case "error":
          return h.onError(msg.message);
      }
    };

    socket.onclose = () => {
      if (closed) return;
      socket = null;
      // A socket that closes while the run is still live has dropped, not
      // finished — the server closes only on a terminal state, and by then the
      // `end` handler has already refreshed. Either way, polling from here cannot
      // be wrong; at worst it is one redundant fetch.
      if (!everOpened || (current && isLive(current.engineStatus))) startPolling();
    };

    socket.onerror = () => {
      // `onclose` always follows, and it owns the fallback. Doing it here too
      // would start two poll loops.
    };
  })();

  return {
    close: () => {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      socket?.close();
      socket = null;
    },
  };
}
