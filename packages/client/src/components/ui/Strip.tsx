// src/components/ui/Strip.tsx — a horizontal ladder of stages: "A › B › C", with
// each cell coloured by where the work has got to.
//
// Extracted from `components/automation/GenStageStrip.tsx` for phase-2.md 2.7.
// There are now two ladders in the product — the generation stages and a
// flow's declared steps — and they must look identical, because to the person
// reading them they mean the same thing: *how far has this got, and did anything
// go wrong.* Two copies of this markup would drift on the first restyle.
//
// Purely presentational: no data fetching, no status vocabulary of its own. The
// caller decides what a cell means; this decides what it looks like.
//
// ── WHY THIS IS NOT `lib/status.ts` (ui-upgrade D-92) ───────────────────────
//
// The five status words describe **a thing that can be armed and run** — an
// automation, a trigger — over its whole life. A cell here describes **one step
// inside one run**. A finished step is not `live`; a step nobody has reached yet
// is not a `draft`. Two subjects, two vocabularies, kept apart deliberately.
//
// ⚠ What is NOT allowed is one word meaning two things, and that had already
// happened: this file's `blocked` meant *reached and failed* while `status.ts`'s
// `blocked` means *it needs a person* and is amber for that reason. It is now
// `failed`, in the same red both vocabularies use for it, and a test asserts that
// any word appearing in both lists carries the same colour in both.
"use client";

import type { ReactNode } from "react";

/**
 * What a cell is currently doing.
 *
 * Seven, because the server distinguishes seven and collapsing them here throws
 * away something a person needs:
 *
 * - `done`    — it finished and did its job
 * - `active`  — it is running now
 * - `waiting` — it is **paused on a person**: gate 3, or an agent's question.
 *               Amber, because that is what `--warn` means everywhere else. Until
 *               D-92 this rendered as `active`, so a run parked in somebody's
 *               inbox for a week looked exactly like a run doing work (`I-82`)
 * - `warning` — it finished and did NOT fully do its job. Until D-92 this
 *               rendered as a failure, which is a different claim
 * - `failed`  — it was reached and it failed
 * - `skipped` — it deliberately did not run
 * - `todo`    — it has not been reached
 */
export type CellState = "done" | "active" | "waiting" | "warning" | "failed" | "skipped" | "todo";

/**
 * Colour per cell.
 *
 * ⚠ `failed` must stay byte-identical to `STATUS_STYLE.failed` in `lib/status.ts`
 * — it is the one word the two vocabularies share, and `primitives.test.tsx`
 * fails if they drift. Everything else here has no counterpart there.
 */
const CELL: Record<CellState, string> = {
  done: "bg-ok-bg text-ok",
  active: "bg-accent-bg-2 text-accent",
  waiting: "bg-warn-bg text-warn",
  warning: "bg-orange-bg text-orange",
  failed: "bg-danger-bg text-danger",
  skipped: "bg-surface-2 text-dim line-through decoration-1",
  todo: "text-dim",
};

export type StripCell = {
  key: string;
  label: string;
  state: CellState;
  /** Hover text — where a per-cell detail (duration, HTTP status, error) belongs. */
  title?: string;
};

export function Strip({
  cells,
  selectedKey,
  onSelect,
}: {
  cells: StripCell[];
  /** Renders the current cell with a ring. Only meaningful alongside `onSelect`. */
  selectedKey?: string | null;
  /** When given, cells become buttons. Omit for a read-only strip. */
  onSelect?: (key: string) => void;
}): ReactNode {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {cells.map((c, i) => {
        const cls =
          "rounded-md px-2 py-0.5 text-caption font-medium tracking-label uppercase " +
          CELL[c.state] +
          (c.key === selectedKey ? " ring-1 ring-accent-line" : "");
        return (
          <li key={c.key} className="flex items-center gap-1.5">
            {onSelect ? (
              <button
                type="button"
                title={c.title}
                data-state={c.state}
                onClick={() => onSelect(c.key)}
                className={cls + " hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"}
              >
                {c.label}
              </button>
            ) : (
              <span title={c.title} data-state={c.state} className={cls}>
                {c.label}
              </span>
            )}
            {i < cells.length - 1 && <span className="text-dim">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The colour classes for one cell state. Exported so a test can compare vocabularies. */
export function cellStyle(state: CellState): string {
  return CELL[state];
}
