"use client";

/**
 * Compact live watch for one execution (personal Phase 2).
 *
 * Reuses `openFlowStream` (ticket + poll fallback) — no new socket. Shows engine
 * status, the current step, the last finished step's short outcome, Stop, and a
 * link to the full run page for artifacts.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { openFlowStream, isLive } from "@/lib/flow-stream";
import { cancelFlowExecution } from "@/lib/api";
import type { FlowExecutionDetail } from "@/lib/types";
import { Button } from "@/components/ui/Button";

function shortOutcome(step: FlowExecutionDetail["steps"][number]): string {
  if (step.error) return step.error.slice(0, 120);
  if (step.outcome) return String(step.outcome).slice(0, 120);
  if (step.status === "success") return "ok";
  return step.status;
}

export function LiveRunPanel({
  runId,
  onSettled,
}: {
  runId: string;
  /** Fired once when the stream reports a non-live engine status (optional refresh hook). */
  onSettled?: (execution: FlowExecutionDetail) => void;
}) {
  const [run, setRun] = useState<FlowExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<"socket" | "poll" | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let settled = false;
    const stream = openFlowStream(runId, {
      onUpdate: (next) => {
        setRun(next);
        if (!isLive(next.engineStatus) && !settled) {
          settled = true;
          onSettled?.(next);
        }
      },
      onError: (message) => setError(message),
      onTransport: setTransport,
    });
    return () => stream.close();
  }, [runId, onSettled]);

  const live = run ? isLive(run.engineStatus) : true;
  const current = useMemo(
    () => run?.steps.find((s) => s.status === "running" || s.status === "paused") ?? null,
    [run],
  );
  const lastDone = useMemo(() => {
    const done = (run?.steps ?? []).filter((s) => !["running", "created", "paused"].includes(s.status));
    return done.length ? done[done.length - 1]! : null;
  }, [run]);

  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await cancelFlowExecution(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  return (
    <section
      data-testid="live-run-panel"
      className="rounded-lg border border-line bg-surface px-3 py-2.5 text-sm shadow-sm"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
            live ? "bg-accent-bg-2 text-accent" : run?.engineStatus === "success" ? "bg-ok-bg text-ok" : "bg-danger-bg text-danger"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-accent animate-pulse" : run?.engineStatus === "success" ? "bg-ok" : "bg-danger"}`} />
          {live ? "Running" : run?.engineStatus === "success" ? "Succeeded" : run?.engineStatus === "cancelled" ? "Stopped" : "Ended"}
        </span>
        {transport ? <span className="text-caption text-dim">{transport === "socket" ? "live" : "polling"}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {live ? (
            <Button size="xs" variant="danger" disabled={stopping} onClick={() => void stop()} data-testid="live-run-stop">
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          <Link href={`/runs/${runId}`} className="text-caption text-accent hover:underline">
            Full run
          </Link>
        </span>
      </div>
      <dl className="mt-2 grid gap-1 text-caption">
        <div className="flex gap-2">
          <dt className="shrink-0 text-dim">Now</dt>
          <dd className="min-w-0 truncate text-text">{current ? `${current.stepId} · ${current.status}` : live ? "starting…" : "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-dim">Last</dt>
          <dd className="min-w-0 truncate text-text">{lastDone ? `${lastDone.stepId}: ${shortOutcome(lastDone)}` : "—"}</dd>
        </div>
      </dl>
      {error ? <p className="mt-1.5 text-caption text-danger">{error}</p> : null}
    </section>
  );
}
