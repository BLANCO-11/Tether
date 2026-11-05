"use client";

import { useState } from "react";
import type { PiProposal, PiSurface } from "@/lib/pi-builder";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/Badge";

const STATE: Record<PiProposal["status"], { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  pending: { label: "Waiting for you", tone: "warn" },
  running: { label: "Working…", tone: "neutral" },
  done: { label: "Done", tone: "ok" },
  partial: { label: "Partly done", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  declined: { label: "Cancelled", tone: "neutral" },
};

const TONE: Record<NonNullable<PiSurface["items"][number]["tone"]>, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-text",
  muted: "text-muted",
};

export type SurfaceDecide = (
  id: string,
  decision: "run" | "decline",
  scope?: undefined,
  choice?: undefined,
  surfaceAct?: { actionId?: string; selected?: string[] },
) => Promise<void>;

/**
 * Forge-authored list or choice card in chat — structured info, or a pick that pauses like MCQs.
 */
export function SurfaceCard({ p, onDecide }: { p: PiProposal; onDecide: SurfaceDecide | null }) {
  const s = p.surface!;
  const ask = s.mode === "ask" || s.type === "choice";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const state = ask && p.status === "pending" ? STATE.pending : p.status === "pending" && !ask ? { label: "Listed", tone: "neutral" as const } : STATE[p.status];

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (s.multi) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const act = async (decision: "run" | "decline", surfaceAct?: { actionId?: string; selected?: string[] }) => {
    if (!onDecide) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(p.id, decision, undefined, undefined, surfaceAct);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const footerActions = (s.actions ?? []).filter((a) => !a.itemId);
  const rowActions = (itemId: string) => (s.actions ?? []).filter((a) => a.itemId === itemId);

  return (
    <section aria-label={`${ask ? "Choice" : "List"}: ${s.title}`} className="pc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pc-eyebrow">{ask ? "Choose" : "Info"}</span>
        <span className="ml-auto">
          <StatusPill status={state.tone}>{state.label}</StatusPill>
        </span>
      </div>
      <p className="text-body font-medium text-text">{s.title}</p>
      {s.subtitle ? <p className="text-xs text-muted">{s.subtitle}</p> : null}
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {s.items.map((it) => {
          const selected = ask ? picked.has(it.id) || (p.surface?.selected?.includes(it.id) ?? false) : false;
          const donePick = p.status !== "pending" && (p.surface?.selected?.includes(it.id) ?? false);
          return (
            <li key={it.id} className="flex items-start gap-3 px-3 py-2.5">
              {ask && p.status === "pending" ? (
                <button
                  type="button"
                  aria-label={it.title}
                  aria-pressed={selected}
                  disabled={busy || !onDecide}
                  onClick={() => toggle(it.id)}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] ${
                    selected ? "border-accent bg-accent text-white" : "border-line text-transparent"
                  }`}
                >
                  ✓
                </button>
              ) : donePick ? (
                <span className="mt-0.5 text-ok" aria-hidden>
                  ✓
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${it.tone ? TONE[it.tone] : "text-text"}`}>{it.title}</p>
                {it.subtitle ? <p className="text-caption text-muted">{it.subtitle}</p> : null}
                {it.meta ? <p className="text-caption text-dim">{it.meta}</p> : null}
              </div>
              {!ask && p.status === "pending" && rowActions(it.id).length > 0 ? (
                <div className="flex shrink-0 flex-wrap gap-1">
                  {rowActions(it.id).map((a) => (
                    <Button key={a.id} size="sm" variant={a.style === "ghost" ? "ghost" : undefined} disabled={busy || !onDecide} onClick={() => void act("run", { actionId: a.id })}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {ask && p.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button size="sm" disabled={busy || !onDecide || picked.size === 0} onClick={() => void act("run", { selected: [...picked] })}>
            {busy ? "Sending…" : s.multi ? "Submit" : "Choose"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || !onDecide} onClick={() => void act("decline")}>
            Cancel
          </Button>
          <span className="text-caption text-dim">{s.multi ? "Select any that apply." : "Pick one to continue."}</span>
        </div>
      ) : null}
      {!ask && p.status === "pending" && footerActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {footerActions.map((a) => (
            <Button key={a.id} size="sm" variant={a.style === "ghost" ? "ghost" : undefined} disabled={busy || !onDecide} onClick={() => void act("run", { actionId: a.id })}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
      {(p.status === "done" || p.status === "failed") && p.result ? (
        <p className={`pt-2 text-caption ${p.status === "done" ? "text-ok" : "text-danger"}`}>{p.result}</p>
      ) : null}
      {p.decidedBy && p.status !== "pending" && ask ? (
        <p className="text-caption text-dim">
          {p.status === "declined" ? "Cancelled" : "Chose"} by {p.decidedBy}
          {p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString()}` : ""}
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </section>
  );
}
