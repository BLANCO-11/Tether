// src/lib/work-items.ts — background work, and what CHANGED about it since the
// last look. Pure; `lib/activity.tsx` does the polling and the rendering.
//
// ── ⚠ WHAT COUNTS AS BACKGROUND WORK HERE ───────────────────────────────────
//
// Two things a person starts and then stops watching:
//
//   · a GENERATION — minutes of inference, and `/flows/new` says "you can leave
//     this page, it keeps running", which until now meant you had no way of
//     finding out that it had;
//   · a RUN — including one nobody in this browser started. A scheduled
//     automation firing at 03:00 is the case that has no other surface at all.
//
// ── ⚠ THE FIRST POLL NOTIFIES ABOUT NOTHING, AND THAT IS LOAD-BEARING ───────
//
// `diffWork` is given a previous snapshot. On the first successful poll the
// caller passes `null`, which means *"I have never looked"* — and the answer is
// zero notifications, because everything in the list is new to this browser and
// almost none of it is new to the world. Without that, opening the app pops a
// toast for every run of the last hour, and the tenth time that happens nobody
// reads any of them.
//
// ⚠ `null` is not the same as an empty map. An empty map means *"last time I
// looked there was nothing running"*, and something appearing since IS news.
//
// ── ⚠ AN ITEM THAT DISAPPEARS RAISES NOTHING ────────────────────────────────
//
// The lists are windowed (newest N). A run that was in flight and is no longer
// in the window might have finished, might have been purged, might just have
// been pushed off the end by newer rows. "It vanished" is not an outcome, and
// announcing a completion nobody can verify is exactly the plausible-but-
// unfalsifiable answer this codebase keeps refusing elsewhere.

import type { FlowExecutionSummary, StepStatus } from "@/lib/types";
import { runLabel } from "@/lib/adapters";

/**
 * `generation` went with the generation job (compiled-builder phase 8, D-333):
 * the builder answers inside the conversation, so a run is the only background
 * work left to announce.
 */
export type WorkKind = "run";

/** How a piece of work ended. `unknown` is a real value — see `outcomeOfRun`. */
export type WorkOutcome = "ok" | "refused" | "failed" | "unknown";

export type WorkItem = {
  /** Stable across polls and unique across kinds. */
  key: string;
  kind: WorkKind;
  /** What a person would call it. */
  title: string;
  /** True while it is still going. */
  live: boolean;
  /** Null while `live`. */
  outcome: WorkOutcome | null;
  /** Where to go to see it. Null when there is nowhere. */
  href: string | null;
  startedAt: string | null;
};

export type WorkNotification = {
  /** Same key as the item, so a re-render cannot duplicate one. */
  id: string;
  kind: WorkKind;
  /** `started` goes in the list only; `settled` also raises a toast. See `lib/activity.tsx`. */
  event: "started" | "settled";
  title: string;
  body: string;
  outcome: WorkOutcome | null;
  href: string | null;
};

/**
 * ⚠ Kestra's live state, mapped to an outcome — and `null` maps to `unknown`,
 * never to "fine".
 *
 * `engineStatus` is null when the engine could not be asked. A run whose state
 * nobody could read is not a run that succeeded, and this is the function where
 * that distinction would be easiest to lose.
 */
const TERMINAL: Record<string, WorkOutcome> = {
  success: "ok",
  warning: "ok",
  failed: "failed",
  cancelled: "failed",
  killed: "failed",
};

/**
 * States that genuinely mean "still going". `paused` is one: a gate waiting for
 * a person has not finished, and announcing it as complete would be a batch
 * reported as sent while it sits in an inbox.
 */
const LIVE = new Set<string>(["created", "running", "paused"]);

/**
 * ⚠ THREE cases, and collapsing any two of them loses something.
 *
 *   · `null`      — the engine could not be ASKED. A transport failure, not a
 *                   state. Treated as live so the next poll tries again, and so
 *                   nothing is announced about a run nobody could read.
 *   · in `LIVE`   — still going.
 *   · anything else — the engine answered with a state this build does not
 *                   recognise. It is NOT live (or the item runs forever in the
 *                   bell) and it is NOT `ok` — D-66's rule, that an unrecognised
 *                   state must never read as fine. It settles as `unknown`, and
 *                   the wording says the outcome could not be read.
 *
 * The last branch used to fall into "still live", which made `unknown`
 * unreachable — a control that cannot fire, which is worse than none (I-38). A
 * test pins it.
 */
function outcomeOfRun(status: StepStatus | null): WorkOutcome | null {
  if (status === null || LIVE.has(status)) return null;
  return TERMINAL[status] ?? "unknown";
}

export function workFromRuns(runs: readonly FlowExecutionSummary[]): WorkItem[] {
  return runs.map((r) => {
    const outcome = outcomeOfRun(r.engineStatus);
    return {
      key: `run:${r.id}`,
      kind: "run" as const,
      // Prefer the frozen display name (`flowNameSnapshot`); never the uuid.
      // `runLabel` also maps the draft engine slug `pi-adhoc` to "Draft test".
      title: runLabel(r),
      live: outcome === null,
      outcome,
      href: `/runs/${r.id}`,
      startedAt: r.startedAt,
    };
  });
}

const WORD: Record<WorkOutcome, string> = {
  ok: "finished",
  refused: "came back with a question",
  failed: "did not finish",
  unknown: "stopped, and its outcome could not be read",
};

function bodyFor(item: WorkItem, event: "started" | "settled"): string {
  if (event === "started") return "A run started. Nobody on this screen has to wait for it.";
  switch (item.outcome) {
    case "ok":
      return "It finished. A green run means the steps completed — open it to see what they actually did.";
    case "failed":
      return "The run did not finish. Open it to see which step stopped it.";
    default:
      return "The engine could not be asked how this run ended, so this is not a report that it failed.";
  }
}

/**
 * What is worth telling someone, comparing the last snapshot with this one.
 *
 * `prev === null` means "never looked" ⇒ nothing is news. See the header.
 */
export function diffWork(
  prev: ReadonlyMap<string, WorkItem> | null,
  next: readonly WorkItem[],
): WorkNotification[] {
  if (prev === null) return [];
  const out: WorkNotification[] = [];
  for (const item of next) {
    const before = prev.get(item.key);

    // Newly seen and still going. A run that first appears already finished is
    // deliberately NOT announced: it settled before anyone was watching, so
    // "started" is stale and "settled" would be indistinguishable from the
    // first-poll flood this function exists to prevent.
    if (!before) {
      if (item.live) {
        out.push({
          id: item.key,
          kind: item.kind,
          event: "started",
          title: item.title,
          body: bodyFor(item, "started"),
          outcome: null,
          href: item.href,
        });
      }
      continue;
    }

    if (before.live && !item.live) {
      out.push({
        id: item.key,
        kind: item.kind,
        event: "settled",
        title: item.title,
        body: bodyFor(item, "settled"),
        outcome: item.outcome,
        href: item.href,
      });
    }
  }
  return out;
}

/** One line for a toast: the subject and what happened to it. */
export function toastLine(n: WorkNotification): string {
  if (n.event === "started") return `${n.title} — started`;
  return `${n.title} — ${WORD[n.outcome ?? "unknown"]}`;
}

/**
 * A signature of what is IN FLIGHT, for deciding when a page should refetch.
 *
 * ⚠ It must change only on a TRANSITION, never on every poll. Pages put this in
 * their `useAsync` deps, so a value that changed each tick would turn one shell
 * poller into every open page refetching every few seconds — a load pattern
 * nobody chose and nothing on screen would explain.
 */
export function inFlightSignature(items: readonly WorkItem[]): string {
  return items
    .filter((i) => i.live)
    .map((i) => i.key)
    .sort()
    .join("|");
}
