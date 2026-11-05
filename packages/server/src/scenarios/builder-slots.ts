/**
 * The one builder's questions, matched to a goal label's slots (compiled-builder phase 4, task 5). PURE — `builder-measure.ts`
 * imports it; tests import it; nothing here touches a database, a gateway or `process`.
 *
 * The old clarifier asked free text, so D-309's matching was done by HAND. The builder's questions are structured — a spec
 * question names a ROLE (`spec:<i>:<role>`), a hole question names a PORT (`… use for \`<port>\` …`) — so the match is code:
 * exact slot name first, then the role's family among the label's own slots, then the family's canonical name. Never `null`:
 * a question with no counterpart in the label scores as `unneeded_question`, which is a finding about the builder, whereas a
 * `null` would score as `unmatched_question`, a harness state that hides it.
 */
import { decideTest, splitSide, type EFlow } from "@foundry/flow-edit";
import { NEUTRAL_SLOTS, type Goal, type Observation, type Outcome } from "./goalset-score.js";

/** The slots a role may be about, most specific first. The first present in the label (or its `stated`) wins. */
const FAMILY: Record<string, string[]> = {
  recipient: ["recipient", "owner_recipient", "list_recipient", "approver"],
  channel: ["channel", "recipient"],
  period: ["period"],
  date: ["as_of", "day"],
  threshold: ["threshold", "lookahead", "bad", "low_response", "vip", "scale_max"],
  count: ["threshold", "lookahead", "scale_max"],
  schedule: ["schedule", "day", "time"],
  subject: ["subject"],
  text: ["text", "action"],
  other: ["data", "action"],
  // Slice 5f: "what should happen with it, and who should get it?" — about whichever of these the label holds.
  delivery: ["recipient", "owner_recipient", "channel", "action", "list_recipient", "approver"],
};

/** A port's role, by its name — the port names are the catalogue's, so this is the harness's reading, not the builder's. */
export function roleOfPort(port: string): string {
  const p = port.toLowerCase();
  if (/^(to|cc|bcc|recipient|recipients|email|address|owner)$|_to$|_email$/.test(p)) return "recipient";
  if (/channel/.test(p)) return "channel";
  if (/^(as_of|date|since|until|day|on)$|_date$|_at$/.test(p)) return "date";
  if (/period|month/.test(p)) return "period";
  if (/threshold|^min|^max|days|hours|limit|pct|percent/.test(p)) return "threshold";
  if (p === "subject" || p === "title") return "subject";
  if (/body|text|message|prompt|content/.test(p)) return "text";
  return p;
}

/**
 * The label slot a builder question is about. `taken` is the row's slots already matched, each to the hole that took it: a
 * DIFFERENT hole in the same family takes the family's next free slot (E5.9: R14's two thresholds and `max_score` all read as
 * `bad`, got `bad`'s answer, and scored as a loop). The SAME hole asked again keeps its slot, so a real repeat is still a loop.
 */
export function slotOf(goal: Goal, q: { holeId: string; ask: string; port?: string }, taken: Map<string, string> = new Map()): string {
  const slot = matchSlot(goal, q, taken);
  if (!taken.has(slot)) taken.set(slot, q.holeId);
  return slot;
}

function matchSlot(goal: Goal, q: { holeId: string; ask: string; port?: string }, taken: Map<string, string>): string {
  const known = new Set([...Object.keys(goal.label.slots), ...goal.label.stated.map((s) => s.split(":")[0]!.replace(/\(.*$/, "").trim())]);
  // `spec:` (older specs), `cond:` "what counts as …?" and `unclear:` "what do you mean by …?" (E5.5) are named by their role.
  // An unclear id is CONTENT-KEYED (`unclear:<the words>:<about>`), never `unclear:<i>:<about>` — the list is re-derived each round.
  const tagged = /^(spec|cond|shape|delivery):\d+(?::\d+)?:(\w+)$/.exec(q.holeId);
  const unclear = /^unclear:(.+):(\w+)$/.exec(q.holeId);
  const spec = tagged ? [tagged[0], tagged[2]!] : unclear ? [unclear[0], UNCLEAR_ROLE[unclear[2]!] ?? "other"] : null;
  const port = q.port ?? /use for `(\w+)`/.exec(q.ask)?.[1];
  const name = spec ? spec[1]! : port ?? null;
  // A hole that is not a port (a reader not chosen, the result, an empty arm) is about the flow's structure: no label slot
  // is ever that, so it is named for what it is and scores as unneeded.
  if (!name) return `structure:${q.holeId}`;
  if (known.has(name)) return name;
  const role = spec ? name : roleOfPort(name);
  const fam = FAMILY[role] ?? [role];
  const present = fam.filter((s) => known.has(s));
  const free = (s: string) => !taken.has(s) || taken.get(s) === q.holeId;
  return present.find(free) ?? present[0] ?? fam[0]!;
}

/** An `unclear:<the words>:<about>` question (E5.5), named by the role of what was unclear: which data, which action, a condition's threshold. */
const UNCLEAR_ROLE: Record<string, string> = { data: "data", action: "action", condition: "threshold", value: "other" };

/** The person's reply to a builder question: the label's scripted answer for its slot, or none (a stated incomplete). */
export function replyFor(goal: Goal, slot: string): string | null {
  // D-324: a NEUTRAL slot (the subject, asked by decision) the label never wrote gets the answer any person would give — plain and
  // generic, one line, so it fits the port and says nothing the goal did not.
  return goal.label.slots[slot]?.answer ?? (NEUTRAL_SLOTS.has(slot) ? NEUTRAL_REPLY[slot] ?? null : null);
}
const NEUTRAL_REPLY: Record<string, string> = { subject: "Automated update" };

/** A build's terminal state, in the vocabulary `scoreBuild` reads. */
export function statusOf(r: { status: "complete" | "incomplete" | "cannot" | "unchanged" } | { error: unknown }): string {
  if ("error" in r) return (r.error as { name?: string })?.name === "GatewayDefect" ? "gateway_defect" : "failed";
  return r.status === "complete" ? "ok" : r.status === "cannot" ? "insufficient_catalogue" : r.status;
}

export type { Outcome };

/**
 * Phase C: the kinds of condition a built flow has, by the engine's own structural rules — a condition whose test is a `keep_if`
 * transform is a Decide, a pair of filters recognised by `splitSide` is a Split, any other condition on a list is a has-rows test.
 * An `otherwise` (no test) adds nothing. Never from the model's words.
 */
/** Phase F: how a built flow acts per item, by structure — a for-each box, a call fanned out over a list, or neither. */
export function perItemKind(f: EFlow): NonNullable<Observation["perItem"]> {
  if (f.steps.some((s) => s.kind === "for_each")) return "loop";
  return f.steps.some((s) => s.kind === "tool" && !!s.over) ? "fanout" : "once";
}
export function conditionKinds(f: EFlow): NonNullable<Observation["conditions"]> {
  const out = new Set<NonNullable<Observation["conditions"]>[number]>();
  for (const s of f.steps) {
    if (s.kind !== "branch") continue;
    for (const c of s.conditions ?? []) out.add(decideTest(f, c.left.stepId) ? "decide" : splitSide(f, c.left.stepId) ? "split" : "has_rows");
  }
  return [...out].sort();
}
