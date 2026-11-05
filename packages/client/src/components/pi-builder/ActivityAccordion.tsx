"use client";

import { useState } from "react";
import type { PiActivity } from "@/lib/pi-builder";

const KIND_LABEL: Record<PiActivity["kind"], string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Shell",
  grep: "Search",
  think: "Think",
  other: "Tool",
};

const STATUS_NOTE: Record<PiActivity["kind"], string> = {
  read: "Reading…",
  write: "Writing…",
  edit: "Editing…",
  bash: "Working on it…",
  grep: "Searching…",
  think: "Thinking it through…",
  other: "Working on it…",
};

/** The step a path belongs to, in words: `steps/send_report/main.py` → "send report". */
const stepWords = (path: string) => /steps\/([^/]+)\//.exec(path)?.[1]?.replace(/_/g, " ") ?? null;

/**
 * What Forge is doing right now, as a sentence a person reads (2026-10-11) — from the file it is touching, never the
 * file's name: "Writing the send report step…", not "WRITE steps/send_report/main.py".
 */
export function activityStatusNote(activities: PiActivity[]): string | null {
  if (!activities.length) return null;
  const a = [...activities].reverse().find((x) => x.status === "running");
  if (!a) return null;
  const t = `${a.title} ${a.detail}`;
  const writing = a.kind === "write" || a.kind === "edit";
  const step = stepWords(t);
  if (/catalogue\.json/.test(t)) return "Looking at what this workspace has…";
  if (/questions\.json|answers\.json/.test(t)) return writing ? "Preparing a question for you…" : "Reading your answers…";
  if (/GOAL\.md/.test(t)) return "Noting down what you asked for…";
  if (/workflow\.json/.test(t)) return writing ? "Laying out the steps…" : "Going over the workflow…";
  if (step) return writing ? `Writing the “${step}” step…` : `Checking the “${step}” step…`;
  if (/verify/.test(t)) return "Checking the workflow…";
  return STATUS_NOTE[a.kind] ?? "Working on it…";
}

/** Collapsed Actions header: latest one-liner + quiet count — e.g. `$ npm install · 3`. */
export function activityHeaderLine(activities: PiActivity[]): string {
  if (!activities.length) return "";
  const last = activities[activities.length - 1]!;
  const title = last.kind === "bash" && last.title !== "…" ? `$ ${last.title}` : last.title;
  const n = activities.length;
  return n === 1 ? title : `${title} · ${n}`;
}

/**
 * One expandable "Actions" block between chat lines — not an accordion per tool.
 */
export function ActivityStack({ activities }: { activities: PiActivity[] }) {
  const [open, setOpen] = useState(false);
  const running = activities.some((a) => a.status === "running");
  const err = activities.some((a) => a.status === "error");

  if (!activities.length) return null;

  const summary = activityHeaderLine(activities);

  return (
    <div className="my-1.5">

      <div
        // A quiet row, not a bordered box (2026-10-10): what Pi did is secondary to what it said. Tint only for a live or
        // failed action — the states worth a glance.
        className={`rounded-lg text-[12px] ${err ? "bg-danger/10" : running ? "bg-accent/10" : ""}`}
      >
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-surface-2"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              running ? "animate-pulse bg-accent" : err ? "bg-danger" : "bg-muted/40"
            }`}
            aria-hidden
          />
          <span className="text-[11px] font-medium text-muted">What Forge did</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={summary}>
            {summary}
          </span>
          <span className="shrink-0 text-[10px] text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
        {open ? (
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto rounded-md bg-sunken px-2 py-1.5">
            {activities.map((a) => (
              <li key={a.id} className="flex items-start gap-2 py-0.5 font-mono text-[11px]">
                <span className="shrink-0 text-muted">{KIND_LABEL[a.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-text">
                  {a.kind === "bash" && a.title !== "…" ? `$ ${a.title}` : a.title}
                </span>
                {a.status === "error" ? (
                  <span className="shrink-0 text-danger">!</span>
                ) : a.status === "running" ? (
                  <span className="shrink-0 text-accent">…</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
