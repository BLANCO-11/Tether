"use client";

/**
 * Background watcher — edge jobs this chat started, so long work continues
 * while the person keeps chatting. Popover beside Tools; chip above the composer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "@/components/ui/icons";
import {
  cancelPiBackgroundJob,
  listPiBackground,
  type PiBackgroundJob,
} from "@/lib/pi-builder";

const OPEN = new Set(["awaiting_approval", "approved", "running"]);

function statusLabel(s: string): string {
  if (s === "awaiting_approval") return "Needs approve";
  if (s === "approved") return "Queued";
  if (s === "running") return "Running";
  if (s === "succeeded") return "Done";
  if (s === "failed") return "Failed";
  if (s === "revoked") return "Stopped";
  return s;
}

function elapsed(iso: string | null | undefined, finished: string | null): string {
  const start = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(start)) return "";
  const end = finished ? Date.parse(finished) : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s`;
}

export function useChatBackground(workspaceId: string, sessionId: string | null) {
  const [jobs, setJobs] = useState<PiBackgroundJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const tick = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const next = await listPiBackground(workspaceId, sessionId);
      setJobs(next);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    const id = window.setInterval(() => {
      tick.current += 1;
      void refresh();
    }, 3_000);
    return () => window.clearInterval(id);
  }, [sessionId, refresh]);

  const live = jobs.filter((j) => j.open || OPEN.has(j.status));

  const stop = useCallback(
    async (jobId: string) => {
      if (!sessionId) return;
      await cancelPiBackgroundJob(workspaceId, sessionId, jobId);
      await refresh();
    },
    [workspaceId, sessionId, refresh],
  );

  return { jobs, live, err, refresh, stop };
}

export function BackgroundToggle({
  live,
  open,
  onOpen,
}: {
  live: number;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      aria-label={live ? `Background · ${live} running` : "Background"}
      title={live ? `${live} running in the background` : "Background jobs"}
      className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        open || live ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <Activity s={16} />
      {live > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">
          {live > 9 ? "9+" : live}
        </span>
      ) : null}
    </button>
  );
}

export function BackgroundPanel({
  jobs,
  live,
  err,
  onStop,
  onClose,
}: {
  jobs: PiBackgroundJob[];
  live: PiBackgroundJob[];
  err: string | null;
  onStop: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const shown = live.length ? live : jobs.slice(0, 8);
  return (
    <div
      className="absolute right-0 top-full z-40 mt-1 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-raised"
      role="dialog"
      aria-label="Background jobs"
    >
      <div className="flex h-10 items-center justify-between border-b border-line px-3">
        <span className="text-sm font-medium text-text">Background</span>
        <button type="button" onClick={onClose} className="text-xs text-muted hover:text-text" aria-label="Close background">
          Close
        </button>
      </div>
      {err ? (
        <p className="px-3 py-2 text-xs text-warn" role="alert">
          {err}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted">Nothing running. Long edge work shows up here so chat stays free.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {shown.map((j) => (
            <li key={j.id} className="flex items-start gap-2 px-3 py-2.5">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  OPEN.has(j.status) ? "bg-accent animate-pulse" : j.status === "succeeded" ? "bg-ok" : j.status === "failed" ? "bg-danger" : "bg-dim"
                }`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-text">{j.summary}</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {statusLabel(j.status)}
                  {j.deviceName ? ` · ${j.deviceName}` : ""}
                  {j.startedAt || j.createdAt ? ` · ${elapsed(j.startedAt ?? j.createdAt, j.finishedAt)}` : ""}
                </div>
                {j.error && !OPEN.has(j.status) ? <div className="mt-1 truncate text-[11px] text-warn">{j.error}</div> : null}
              </div>
              {OPEN.has(j.status) ? (
                <button
                  type="button"
                  disabled={busyId === j.id}
                  className="shrink-0 text-xs text-muted underline hover:text-warn disabled:opacity-50"
                  onClick={() => {
                    setBusyId(j.id);
                    void onStop(j.id).finally(() => setBusyId(null));
                  }}
                >
                  Stop
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact chip above the composer while something is running in the background. */
export function BackgroundChip({
  live,
  onOpen,
}: {
  live: PiBackgroundJob[];
  onOpen: () => void;
}) {
  if (!live.length) return null;
  const first = live[0]!;
  const more = live.length - 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-2 flex w-full items-center gap-2 rounded-md border border-accent/30 bg-accent-bg/40 px-3 py-1.5 text-left text-xs text-text hover:bg-accent-bg/70"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {first.summary}
        {more > 0 ? ` · +${more} more` : ""}
      </span>
      <span className="shrink-0 text-accent">{statusLabel(first.status)}</span>
    </button>
  );
}
