// src/lib/status.ts — the five status words, and the ONE place their colours live.
//
// ── WHY THIS IS A MODULE AND NOT A PROP TYPE ────────────────────────────────
//
// Before this file, three surfaces each decided for themselves what a status
// looked like. `StatTile` had two tones — `"ok" | "warn"` — and `/dashboard`
// therefore rendered a **40% success rate in amber**, because amber was the
// worst colour it had (`ui-upgrade/issues.md` I-76). `Strip` had five
// cell states under different names. `Badge` had four. Each was defensible
// alone; together they meant the same run could read as three different degrees
// of wrong on three screens.
//
// The vocabulary is fixed at FIVE and comes from the approved mock:
//
//   live      it is armed and doing its job                    --ok
//   running   it is doing it right now                         --accent
//   draft     it exists and is not armed — not a problem       --muted
//   blocked   it needs a person: an approval, a first run      --warn
//   failed    it tried and did not succeed                     --danger
//
// ⚠ `blocked` and `failed` must stay distinct, and this is the reason. `--warn`
// means *this needs your attention*; `--danger` means *this went wrong*. A draft
// waiting for approval is not an incident, and an incident is not a to-do. Merge
// them and one of the two stops being read — which is the same argument D-86
// makes for keeping `--alpha` off `--warn`.
//
// ⚠ `draft` is deliberately NEUTRAL, not amber. Most drafts are drafts on
// purpose. Colouring them as a problem makes the colour meaningless on the
// screens where something actually is one.
//
// ⚠ Colour is never the only carrier. Every consumer renders the word too — five
// hues is past where colour-alone encoding works, and it is the same rule the
// canvas states for its six step kinds.

/** The five, and there are only five. Widening this is a design decision. */
export type StatusWord = "live" | "running" | "draft" | "blocked" | "failed";

export const STATUS_WORDS: readonly StatusWord[] = [
  "live",
  "running",
  "draft",
  "blocked",
  "failed",
] as const;

/**
 * Tailwind classes per status: the foreground, the tint behind it, and the dot.
 *
 * Every value resolves through a token, so both themes follow automatically —
 * see `app/globals.css`. ⚠ Do not inline one of these in a component: a second
 * copy is how the tile and the pill stop agreeing about what amber means.
 */
export const STATUS_STYLE: Record<StatusWord, { text: string; bg: string; dot: string }> = {
  live: { text: "text-ok", bg: "bg-ok-bg", dot: "bg-ok" },
  running: { text: "text-accent", bg: "bg-accent-bg-2", dot: "bg-accent" },
  draft: { text: "text-muted", bg: "bg-surface-2", dot: "bg-muted" },
  blocked: { text: "text-warn", bg: "bg-warn-bg", dot: "bg-warn" },
  failed: { text: "text-danger", bg: "bg-danger-bg", dot: "bg-danger" },
};

/** Sentence-case for display. The words are lowercase in code and capitalised on screen. */
export const STATUS_LABEL: Record<StatusWord, string> = {
  live: "Live",
  running: "Running",
  draft: "Draft",
  blocked: "Blocked",
  failed: "Failed",
};
