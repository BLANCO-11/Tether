/**
 * Scoring for the labelled goal set (compiled-builder programme, D-308 / D-309).
 *
 * PURE — no database, no gateway, no `process`. `goalset-measure.ts` observes a
 * build and hands the observation here; tests import this file only (a
 * `scenarios/*.ts` script runs `main()` at import, so it must never be imported
 * by a test).
 *
 * ⚠ Questions are scored in BOTH directions (D-309). An `asks` label alone would
 * reward a builder that asks everything, because it never guesses:
 *   - a question for a slot the goal already STATED, or that the label says is
 *     determined (data, identity, catalogue) and not askable → `redundant_question`
 *   - a needed ask-only slot filled without asking        → `silent_guess`
 *   - a question for a slot the label does not know at all → `unneeded_question`
 *   - the same slot asked twice                           → `loop`
 * A question is matched to a slot by HAND for today's free-text clarifier
 * (`slot: null` = not yet matched, which is a harness state, never a score).
 */

export type Outcome = "builds" | "asks" | "cannot";

export interface SlotLabel {
  /** How the slot may legitimately be filled. `ask` alone means only a question will do. */
  accept: string[];
  answer?: string;
}

export interface GoalLabel {
  outcome: Outcome;
  /** Slots the goal already states — asking about one is redundant. Free text, `slot: …` prefix. */
  stated: string[];
  slots: Record<string, SlotLabel>;
  expect: { readers?: string[]; sinks?: string[]; [k: string]: unknown };
  missing?: string;
}

export interface Goal {
  id: string;
  workspace: string;
  goal: string;
  label: GoalLabel;
}

/** What the harness saw. */
export interface Observation {
  /** Terminal status of the build: `ok`, `insufficient_catalogue`, `insufficient_contract`, `failed`, … */
  status: string;
  /** Every question the builder asked, each matched to a slot (or null while unmatched). */
  questions: Array<{ text: string; slot: string | null }>;
  /** Slots a refusal named as missing, matched the same way. */
  refusedFor?: Array<string | null>;
  /** Refs the built flow calls, as `ref` strings. */
  refs?: string[];
  /** Kestra state of the draft run, when one ran. */
  run?: string;
  /** Tables the built flow's schema-built readers read (D-311), when it has any. */
  tables?: string[];
  /**
   * Phase C: the kinds of condition the built flow has — `decide` (one value compared), `split` (rows divided), `has_rows` (a list
   * tested for rows). Read off the flow by the engine's own structural rules (`conditionKinds`), never from the model's words.
   */
  conditions?: Array<"decide" | "split" | "has_rows">;
  /**
   * Phase F: how the built flow does something per item — `loop` (a for-each box), `fanout` (one call over a list, one per row), or
   * `once` (neither). Read off the flow's structure (`perItemKind`), never from the model's words.
   */
  perItem?: "loop" | "fanout" | "once";
}

export type Failure =
  | "redundant_question"
  | "silent_guess"
  | "unneeded_question"
  | "loop"
  | "unmatched_question"
  | "built_anyway"
  | "wrong_refusal"
  | "refused_for_missing"
  | "build_failed"
  | "run_failed"
  | "wrong_reader"
  | "wrong_sink"
  | "wrong_table"
  | "wrong_condition"
  | "wrong_per_item";

export interface Score {
  pass: boolean;
  failures: Array<{ kind: Failure; detail: string }>;
  questions: number;
  expectedQuestions: number;
}

const REFUSED_CATALOGUE = new Set(["insufficient_catalogue", "needs_component"]);
const GREEN = new Set(["SUCCESS", "PAUSED"]);

/** The slot name a `stated` entry is about: `"recipient: me (the requester)"` → `"recipient"`. */
export function statedSlot(entry: string): string {
  return entry.split(":")[0]!.replace(/\(.*$/, "").trim();
}

/** A slot only a question can fill — nothing else in `accept` would do. */
export function askOnly(s: SlotLabel): boolean {
  return s.accept.length > 0 && s.accept.every((m) => m === "ask");
}

/**
 * Slots a question may name without counting for OR against (D-324, the person's decision 2026-09-27): the email subject is ASKED by
 * decision (nobody states one, and composing one is a guess), while the labels were written blind and hold no subject slot. A label
 * that DOES name one still scores it normally — this only stops an unlabelled subject question reading as a fault.
 */
export const NEUTRAL_SLOTS: ReadonlySet<string> = new Set(["subject"]);

export function scoreBuild(goal: Goal, obs: Observation): Score {
  const L = goal.label;
  const failures: Score["failures"] = [];
  const fail = (kind: Failure, detail: string) => failures.push({ kind, detail });
  const expectedQuestions = Object.values(L.slots).filter(askOnly).length;
  const stated = new Set(L.stated.map(statedSlot));

  // ── Questions, both directions ──────────────────────────────────────────
  const seen = new Map<string, number>();
  for (const q of obs.questions) {
    if (q.slot === null) { fail("unmatched_question", q.text); continue; }
    seen.set(q.slot, (seen.get(q.slot) ?? 0) + 1);
    const known = L.slots[q.slot];
    // Redundant: the goal states it, or the label says it is determined (data, identity, catalogue) and not askable.
    if ((stated.has(q.slot) || known) && !known?.accept.includes("ask")) fail("redundant_question", q.slot);
    else if (!(q.slot in L.slots) && !stated.has(q.slot) && !NEUTRAL_SLOTS.has(q.slot)) fail("unneeded_question", q.slot);
  }
  for (const [slot, n] of seen) if (n > 1) fail("loop", `${slot} asked ${n}×`);

  // ── Outcome ─────────────────────────────────────────────────────────────
  if (L.outcome === "cannot") {
    if (obs.status === "ok") fail("built_anyway", `built a flow; the workspace lacks ${L.missing ?? "a component"}`);
    else if (!REFUSED_CATALOGUE.has(obs.status)) fail("wrong_refusal", `ended ${obs.status}, not a missing-component refusal`);
    return { pass: failures.length === 0, failures, questions: obs.questions.length, expectedQuestions };
  }

  if (REFUSED_CATALOGUE.has(obs.status)) fail("wrong_refusal", `refused as missing a component; label is ${L.outcome}`);
  else if (obs.status === "insufficient_contract") fail("refused_for_missing", (obs.refusedFor ?? []).map((s) => s ?? "?").join(", ") || "unnamed");
  else if (obs.status !== "ok") fail("build_failed", obs.status);

  // An ask-only slot must have been asked (or named by a refusal); otherwise the flow was built without it.
  const refused = new Set((obs.refusedFor ?? []).filter((s): s is string => !!s));
  for (const [slot, s] of Object.entries(L.slots)) {
    if (askOnly(s) && !seen.has(slot) && !refused.has(slot) && obs.status === "ok") fail("silent_guess", slot);
  }

  if (obs.status === "ok") {
    if (obs.run !== undefined && !GREEN.has(obs.run)) fail("run_failed", obs.run);
    const refs = new Set(obs.refs ?? []);
    const readers = L.expect.readers ?? [];
    const sinks = L.expect.sinks ?? [];
    if (readers.length && !readers.some((r) => refs.has(r))) fail("wrong_reader", `used ${[...refs].join(", ") || "none"}`);
    if (sinks.length && !sinks.some((r) => refs.has(r))) fail("wrong_sink", `used ${[...refs].join(", ") || "none"}`);
    // D-311, the frozen schema-only labels: a flow that reads from the schema must read at least one table the label says holds
    // the data (the same "any" rule as `readers`). Only where the label names no reader — a curated label is judged by its readers.
    const tables = (L.expect.tables as string[] | undefined) ?? [];
    if (!readers.length && tables.length && obs.tables && !tables.some((t) => obs.tables!.includes(t))) fail("wrong_table", `read ${obs.tables.join(", ") || "no table"}`);
    // Phase C: the condition the goal states, as the shape it must be — a Decide for one value, a Split for "these here, the rest
    // there", a has-rows test for "if there are any". `none`: the goal states no condition and the flow must build none.
    const want = (L.expect.conditions as Array<"decide" | "split" | "has_rows" | "none"> | undefined) ?? [];
    if (want.length && obs.conditions) {
      const built = obs.conditions.join(", ") || "none";
      for (const k of want) if (k === "none" ? obs.conditions.length > 0 : !obs.conditions.includes(k)) fail("wrong_condition", `expected ${k === "none" ? "no condition" : `a ${k}`}; built ${built}`);
    }
    // Phase F: "for each …" as the shape it must be — `loop` when more than one send happens per item (a condition on the item, a
    // look-up, two actions); `per_item` when a loop or today's fan-out both do it (one send per row); `once` for one message to all.
    const per = L.expect.perItem as "loop" | "per_item" | "once" | undefined;
    if (per && obs.perItem) {
      const ok = per === "per_item" ? obs.perItem !== "once" : obs.perItem === per;
      if (!ok) fail("wrong_per_item", `expected ${per === "per_item" ? "a loop or a fan-out" : per === "loop" ? "a for-each loop" : "one call for all"}; built ${obs.perItem}`);
    }
  }

  return { pass: failures.length === 0, failures, questions: obs.questions.length, expectedQuestions };
}

/**
 * The value a draft run gets for a declared input: the label's scripted answer
 * for a slot whose name matches, else null. The caller records a null as a
 * `harness-default` — never a silent invented value (the old harness gave every
 * number input `80`, which is the hardcoded-threshold failure by another road).
 */
export function labelInputValue(goal: Goal, inputId: string): string | null {
  const id = inputId.toLowerCase();
  for (const [slot, s] of Object.entries(goal.label.slots)) {
    if (!s.answer || !s.accept.includes("input")) continue;
    if (id === slot || id.includes(slot) || slot.includes(id)) return s.answer;
  }
  return null;
}

/** Coerce a label answer to what a declared input of this type accepts. */
export function coerce(answer: string, type: string | undefined): string {
  const t = String(type ?? "").toUpperCase();
  if (t.includes("DATETIME") && /^\d{4}-\d{2}-\d{2}$/.test(answer)) return `${answer}T00:00:00Z`;
  // A month answer into a DATE input: the month's LAST day, the labels' own `as_of` convention.
  const month = /^(\d{4})-(\d{2})$/.exec(answer);
  if (month && (t === "DATE" || t.includes("DATETIME"))) {
    const last = new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).toISOString().slice(0, 10);
    return t === "DATE" ? last : `${last}T00:00:00Z`;
  }
  if (t === "INT" || t === "FLOAT" || t === "NUMBER") return /-?\d+(\.\d+)?/.exec(answer)?.[0] ?? answer;
  return answer;
}

/** The old harness's fallback, kept only so a run can start; every use is recorded. */
export function harnessDefault(i: { id: string; type?: string }): string {
  const t = String(i.type ?? "").toUpperCase(), id = i.id.toLowerCase();
  // ⚠ An RFC 2606 reserved address, NEVER the deployment's allowed domain: `tether_email_send`
  // really delivers, and a harness must not be able to mail a real mailbox (D-267 accepts
  // reserved recipients on draft runs).
  if (/email|recipient|address|owner|^to$|_to$/.test(id)) return "requester@harness.example";
  if (t.includes("DATETIME")) return "2026-06-30T12:00:00Z";
  if (t === "DATE" || /date|as_of|since|until/.test(id)) return "2026-06-30";
  if (t === "INT" || t === "FLOAT" || t === "NUMBER") return "7";
  return "2026-06";
}
