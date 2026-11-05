// src/components/ops/SignalsPanel.tsx — is the system still doing its job?
//
// GAPS §6.1b, D-71. The human half of giving `/api/signals` a reader; the
// machine half is `pnpm --filter @foundry/server signals`, which exits non-zero
// so a scheduler can page. Both are needed and neither substitutes: a screen
// cannot notice something at 3 a.m., and an exit code cannot explain itself.
//
// ⚠ **This is NOT health.** `/api/health` answers "can this process serve a
// request"; these four answer "is the system still doing its job" — the things
// that fail with nothing raising an error anywhere. A scheduled flow that
// quietly stops firing produces no error, no failed run and no log line.
//
// Each signal's caveat (what it cannot see) is kept, server-verbatim, as the
// check's tooltip rather than body text (2026-10-21): on a dashboard the
// paragraphs read as noise. The row says what was checked and what was found.
"use client";

import { useState } from "react";
import { listSignals } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import type { SignalState } from "@/lib/types";

const MARK: Record<SignalState, { badge: string; label: string }> = {
  // The mock's badge tones, in the client's token language: the label is the
  // word and the tint only reinforces it (colour is never the only carrier).
  ok: { badge: "bg-ok-bg text-ok", label: "ok" },
  warn: { badge: "bg-warn-bg text-warn", label: "warn" },
  alarm: { badge: "bg-danger-bg text-danger", label: "alarm" },
  // ⚠ Its own badge, and deliberately not grey-as-in-fine. `unknown` means the
  // signal had nothing to go on. It ranks BELOW warn server-side so it cannot
  // shout over a real warning, and it must not read as a pass either.
  unknown: { badge: "border border-line bg-surface-2 text-muted", label: "no data" },
};

const HUMAN: Record<string, string> = {
  scheduled_flows_firing: "Scheduled workflows run on time",
  agent_poller: "Waiting steps are being watched",
  staleness_sweep: "Approved workflows are re-checked when what they use changes",
  execution_slots: "No runs are stuck holding a slot",
};

/** The server writes details for engineers (backticked names); show the words, not the markup. */
const plain = (s: string) => s.replace(/`/g, "");

/** Worst-first, so the summary line names the state that needs acting on: `unknown` ranks below `warn` (D-66). */
const RANK: Record<SignalState, number> = { alarm: 3, warn: 2, unknown: 1, ok: 0 };

export function SignalsPanel({ compact = false }: { compact?: boolean } = {}) {
  const { data, loading, error } = useAsync(() => listSignals(), []);
  const [open, setOpen] = useState(false);

  /*
   * ⚠ Compact (the dashboard): calm by default, loud on purpose. When EVERY check is `ok`, one quiet line with
   * "Show details"; anything else — warn, alarm, no data, or the read failing — opens on its own, because a
   * monitoring surface that hides a problem behind a click is the silence this panel exists to break.
   * The mock's lone "All" chip is gone: it filtered nothing and looked like a control.
   */
  const worst = data?.signals.reduce<SignalState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), "ok") ?? null;
  const allOk = !!data && data.signals.length > 0 && worst === "ok";
  const expanded = !compact || !allOk || open;

  return (
    <div className="pane">
      {compact && allOk && (
        <div className={`flex items-center gap-3 px-4 py-3 ${expanded ? "border-b border-line" : ""}`}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />
          <p className="min-w-0 flex-1 text-body">
            All {data!.signals.length} system checks are healthy
            <span className="text-dim"> · Checked {new Date(data!.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          </p>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="shrink-0 rounded-md px-2 py-1 text-caption font-medium text-accent transition-colors duration-150 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {open ? "Hide details" : "Show details"}
          </button>
        </div>
      )}
      {expanded && (
      <div className="divide-y divide-line px-4">
        {loading && !data && <p className="py-3 text-sm text-muted">Reading signals…</p>}

        {/* Reported, never swallowed. A panel that renders an empty list on an
            error is the `faFallback` lie with fewer steps — and here it would be
            the specific lie of a monitoring surface showing nothing wrong. */}
        {error && (
          <p className="py-3 text-sm text-danger">
            Could not read the signals: {error}. That is not the same as the system being
            healthy — nothing here has been checked.
          </p>
        )}

        {data && (
          <>
            {data.signals.map((s) => (
              <div key={s.name} className="flex items-center gap-3 py-2.5">
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-caption ${MARK[s.state].badge}`}>
                  {MARK[s.state].label}
                </span>
                <p className="min-w-0 flex-1 text-body" title={s.caveat}>
                  {HUMAN[s.name] ?? s.name}
                  <span className="text-muted"> — {plain(s.detail)}</span>
                </p>
              </div>
            ))}
            {!(compact && allOk) && (
              <p className="py-2.5 text-caption text-dim">Checked {new Date(data.checkedAt).toLocaleTimeString()}</p>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}
