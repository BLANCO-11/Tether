// src/lib/trigger-groups.ts — one section per automation, and the facts that
// belong on the section rather than on every card in it. ui-upgrade Phase 7.2,
// D-109.
//
// ── ⚠ WHY THIS IS GROUPING AND NOT SORTING ──────────────────────────────────
//
// A trigger card can carry three sentences, and **two of them are facts about
// the AUTOMATION**: gate 1 (*this flow has never completed a run*) and gate 2
// (*this flow has no approved revision*). Neither says anything about the
// trigger it was rendered on. So a flat list printed one automation's approval
// state once per trigger, and three triggers on one unapproved flow read as
// three problems.
//
// Grouping puts each of those where it is true — once, on the automation — and
// leaves the card carrying only what is genuinely its own: its own state, its
// own switch, and its own `inputsWarning` (D-108), which is about the values
// THIS trigger sends and can legitimately differ between two triggers on one
// flow.
//
// ⚠ **The two sentences stay two sentences** (D-88). Moving them onto the group
// header does not merge them: "it has never run" is fixed by running it, "it has
// no approved revision" is fixed by a second person, and one combined sentence
// can only ever be right about one of them.
import type { Trigger } from "./types";
import type { StatusWord } from "./status";

export type TriggerGroup = {
  /** Stable across reloads. The flow id where there is one — never the index. */
  key: string;
  /** The automation's name, or null for the unbound group. */
  automation: string | null;
  flowId: string | null;
  status: StatusWord;
  /** Gate 1. Shown once, on the group. */
  enableBlockedReason: string | null;
  /** Gate 2. A different question with a different fix — never merged with gate 1. */
  approvalBlockedReason: string | null;
  /** The cron on the automation's model, if it declares one (D-18: it lives there). */
  scheduleCron: string | null;
  triggers: Trigger[];
};

/**
 * The automation's own status word.
 *
 * ⚠ **Conservative on purpose.** `status.ts` warns that colouring ordinary
 * drafts as a problem makes the colour meaningless on the screens where
 * something actually is one — and *most* automations here are drafts by choice,
 * newly generated and not yet run. So a flow that merely owes its first run
 * reads **draft**, and the sentence under the heading says what it owes. The
 * word turns to `blocked` only for `suspended`, which is different in kind:
 * something WAS running unattended and has stopped.
 */
export function automationWord(t: Trigger | undefined): StatusWord {
  if (!t) return "draft";
  if (t.approvalStatus === "suspended") return "blocked";
  if (t.armedRevision != null) return "live";
  return "draft";
}

/**
 * Group triggers by the automation they start.
 *
 * ⚠ The automation-level fields are read off the group's FIRST trigger, and
 * that is sound rather than lazy: they are one flow's facts, computed by the
 * server from one row and replicated onto every trigger bound to it. Reducing
 * over all of them would suggest they could disagree, which would be a lie in
 * the other direction.
 *
 * ⚠ A trigger bound to nothing gets **its own group**, not a drop and not a
 * fold into the first. `createForFlow` is the only constructor, so that group
 * should never appear — and a page that hid it would be hiding exactly the row
 * worth seeing.
 */
export function groupByAutomation(triggers: Trigger[]): TriggerGroup[] {
  const byKey = new Map<string, Trigger[]>();
  for (const t of triggers) {
    const key = t.flowId ?? "__unbound";
    const list = byKey.get(key);
    if (list) list.push(t);
    else byKey.set(key, [t]);
  }

  const groups: TriggerGroup[] = [];
  for (const [key, list] of byKey) {
    const first = list[0];
    groups.push({
      key,
      automation: first.automationName ?? null,
      flowId: first.flowId ?? null,
      status: automationWord(first),
      enableBlockedReason: first.enableReady === false ? (first.enableBlockedReason ?? null) : null,
      approvalBlockedReason: first.approvalBlockedReason ?? null,
      scheduleCron: first.scheduleCron ?? null,
      triggers: list,
    });
  }

  // ⚠ By NAME, never by trigger count or by recency (D-109). A list that
  // reorders itself as runs happen is one where the row you were about to click
  // moves. The unbound group sorts last, for the same reason a fixture
  // workspace is badged and sorted last rather than hidden.
  return groups.sort((a, b) => {
    if (!a.automation !== !b.automation) return a.automation ? -1 : 1;
    return (a.automation ?? "").localeCompare(b.automation ?? "");
  });
}
