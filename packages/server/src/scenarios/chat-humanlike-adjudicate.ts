/**
 * The pure half of `chat:humanlike` — the probes, the rubric, the judge's
 * prompt, and the scoring. **No database, no gateway, no `process`.**
 *
 * ⚠ It is a separate module for the reason `propose-adjudicate.ts` is: a
 * scenario script's `main()` runs at IMPORT, so a test that imported the runner
 * to reach its scoring would load the repositories, the config and the gateway
 * client, and fire real model calls inside the suite. That happened once
 * already and is written up in CLAUDE.md.
 *
 * ── What this measures, and what it deliberately does not ────────────────────
 *
 * `chat:measure` sends messages its own docblock calls *"scenario 1's own
 * proven messages"* — sentences known to work, chosen because they work. That
 * measures whether the machinery holds together. It cannot measure whether a
 * person who does not already know the answer can get one, because every
 * sentence in it was written by someone who did.
 *
 * This harness sends **underspecified** messages: the thing a person actually
 * types. The clarification channel exists to meet them — `needs_input` (with
 * `questions[]`, `options[]`, `allow_custom`) and `ambiguous_referent` (with
 * `candidates[]`) — bounded by `MAX_CLARIFICATION_ROUNDS`. Neither status is
 * exercised anywhere else in this repository.
 *
 * ── ⚠ THE JUDGE IS THE SYSTEM UNDER TEST, AND THAT WAS A DELIBERATE CHOICE ───
 *
 * The model judging these replies is the model that wrote them. It was asked
 * for, and it is recorded here rather than softened, because a reader who does
 * not know it will over-read every judged number below.
 *
 * A model grading its own output shares its own blind spots: the phrasing it
 * finds natural is the phrasing it rates highly, and a gap it cannot see when
 * writing is one it cannot see when marking. So **the judge agreeing with the
 * system is not independent evidence**, and no judged figure in this report may
 * be quoted as if it were.
 *
 * What stands between that and an unfalsifiable score is `CONTROLS` — planted
 * replies with verdicts declared here, in the commit that created the file,
 * mixed in blind. Three are bad and two are good, in both directions on
 * purpose: a judge that praises everything fails the bad ones, and a judge that
 * damns everything fails the good ones. **If the controls do not separate, the
 * judged half of the report is void and the runner says so** — the observable
 * half stands on its own either way, because it needs no judgement at all.
 *
 * ── ⚠ ASK AND GUESS ARE REPORTED SIDE BY SIDE AND NEITHER IS THE SCORE ───────
 *
 * Asked for explicitly. Both are defensible answers to a vague sentence: a
 * question is right when the reading genuinely cannot be picked, and a stated
 * assumption is right when one reading is obvious and a question would be
 * friction. There is no composite number here and one must not be added — it
 * would encode a preference nobody has expressed, and it would hide exactly the
 * trade a reader of this report is trying to see.
 *
 * `defensibleGuess` is declared per probe BEFORE the run so the two rates can
 * be read against it. It is not a right answer; it is the harness saying which
 * probes had an obvious default available.
 */

/** The kinds of underspecification a person actually produces. */
export type Vagueness =
  | "missing_source"
  | "missing_recipient"
  | "missing_period"
  | "missing_threshold"
  | "ambiguous_referent"
  | "pronoun"
  | "compound"
  | "colloquial"
  | "contradictory"
  | "no_content";

/** Where the conversation stands when the probe lands. */
export type StartState = "empty" | "mid_edit";

export type Probe = {
  id: string;
  vagueness: Vagueness;
  start: StartState;
  /**
   * Which tenant the probe is sent to.
   *
   * ⚠ Per probe, not per run, and it is load-bearing: "the attendance
   * numbers" in a workspace with no attendance reader is a `needs_component`,
   * which is a correct answer to a DIFFERENT question and would be scored here
   * as a failure to ask. The vagueness under test is what the sentence leaves
   * out, never whether the tenant happens to hold the data.
   */
  workspace: "HR" | "Finance";
  /** The sentence, as a person would type it. */
  text: string;
  /**
   * The thing a correct clarifying question would be ABOUT — declared before
   * the run, and the only expectation this file states.
   *
   * ⚠ It is NOT a required answer. It feeds two places: the observable check
   * (did the question mention any of these words) and the judge's rubric. A
   * probe whose reply addresses the gap in words not listed here scores a miss
   * on the cheap check and can still be marked as addressing it by the judge —
   * and the two disagreeing is a finding, which is why both are printed.
   */
  gap: string;
  /** Words that would show the gap was addressed. Lowercased, matched loosely. */
  gapWords: string[];
  /**
   * Was there an obvious default, so that GUESSING is defensible here?
   *
   * ⚠ Not a score. See the docblock — ask and guess are reported side by side
   * and this column is what lets a reader tell a helpful assumption from a
   * lazy one.
   */
  defensibleGuess: boolean;
};

/**
 * Twelve probes, six from an empty flow and six mid-edit.
 *
 * ⚠ The split is structural, not cosmetic: `ambiguous_referent` can only fire
 * when there are existing steps to be ambiguous BETWEEN, so an empty-only run
 * cannot reach that status at all and would report its absence as a finding
 * about the model rather than about the harness.
 */
export const PROBES: Probe[] = [
  {
    id: "P01",
    vagueness: "no_content",
    start: "empty",
    workspace: "Finance",
    text: "help me build something",
    gap: "what the automation should do at all",
    gapWords: ["what", "which", "goal", "achieve", "do"],
    defensibleGuess: false,
  },
  {
    id: "P02",
    vagueness: "missing_source",
    start: "empty",
    workspace: "HR",
    text: "email the team the attendance numbers",
    gap: "which reader supplies the attendance numbers",
    gapWords: ["source", "data", "query", "reader", "where", "which"],
    defensibleGuess: false,
  },
  {
    id: "P03",
    vagueness: "missing_recipient",
    start: "empty",
    workspace: "Finance",
    text: "send a summary of the overdue invoices",
    gap: "who receives it",
    gapWords: ["who", "whom", "recipient", "address", "email", "to"],
    defensibleGuess: false,
  },
  {
    id: "P04",
    vagueness: "missing_period",
    start: "empty",
    workspace: "Finance",
    text: "pull last month's expenses and put them in a report",
    gap: "which month, and whether it is a fixed value or an input",
    gapWords: ["month", "period", "date", "which", "input", "when"],
    defensibleGuess: true,
  },
  {
    id: "P05",
    vagueness: "colloquial",
    start: "empty",
    workspace: "HR",
    text: "can you make it tell me who's slacking off",
    gap: "what measurable thing counts as slacking off",
    gapWords: ["threshold", "mean", "define", "measure", "attendance", "what", "criteria"],
    defensibleGuess: false,
  },
  {
    id: "P06",
    vagueness: "compound",
    start: "empty",
    workspace: "Finance",
    text: "read the invoices, work out who is late, and let finance know",
    gap: "three components in one sentence, which is done first",
    gapWords: ["first", "step", "one", "start", "begin", "which"],
    defensibleGuess: true,
  },
  {
    id: "P07",
    vagueness: "pronoun",
    start: "mid_edit",
    workspace: "Finance",
    text: "send that to the manager",
    gap: "what 'that' refers to, and who the manager is",
    gapWords: ["that", "which", "who", "manager", "refer", "step", "address"],
    defensibleGuess: false,
  },
  {
    id: "P08",
    vagueness: "ambiguous_referent",
    start: "mid_edit",
    workspace: "Finance",
    text: "change the filter",
    gap: "which of the steps is meant",
    gapWords: ["which", "step", "mean", "refer", "two", "both"],
    defensibleGuess: false,
  },
  {
    id: "P09",
    vagueness: "missing_threshold",
    start: "mid_edit",
    workspace: "Finance",
    text: "only flag the ones that are really late",
    gap: "how many days counts as really late",
    gapWords: ["days", "how", "threshold", "number", "many", "define"],
    defensibleGuess: false,
  },
  {
    id: "P10",
    vagueness: "contradictory",
    start: "mid_edit",
    workspace: "HR",
    text: "email everyone, but only the managers",
    gap: "the two halves of the sentence disagree",
    gapWords: ["everyone", "manager", "only", "which", "both", "clarify", "conflict"],
    defensibleGuess: false,
  },
  {
    id: "P11",
    vagueness: "missing_period",
    start: "mid_edit",
    workspace: "Finance",
    text: "actually make it weekly",
    gap: "a schedule is not a step edit — there is no schedule op",
    gapWords: ["schedule", "trigger", "weekly", "cannot", "step"],
    defensibleGuess: false,
  },
  {
    id: "P12",
    vagueness: "colloquial",
    start: "mid_edit",
    workspace: "Finance",
    text: "tidy up the wording on the email so it sounds friendlier",
    gap: "which step, and what the new wording should say",
    gapWords: ["which", "wording", "text", "say", "subject", "body", "step"],
    defensibleGuess: true,
  },
];

// ── The observable half — no judgement anywhere in here ──────────────────────

/** Statuses in which the builder ASKED rather than acted. */
export const ASKED_STATUSES = new Set(["needs_input", "ambiguous_referent"]);
/** Statuses in which it committed to a reading and edited the flow. */
export const GUESSED_STATUSES = new Set(["applied"]);
/**
 * Statuses in which it did neither — it declined, or the machinery failed.
 *
 * ⚠ `answered`, `too_structural` and `needs_component` are all legitimate
 * replies and are counted here rather than as guesses: none of them changed the
 * automation, and filing a correct refusal as a guess would make the guess rate
 * a number about refusals.
 */
export const NEITHER_STATUSES = new Set([
  "answered",
  "too_structural",
  "needs_component",
  "insufficient_contract",
  "policy_reject",
  "policy_transform",
  "failed",
]);

export type Behaviour = "asked" | "guessed" | "neither";

export function behaviourOf(status: string): Behaviour {
  if (ASKED_STATUSES.has(status)) return "asked";
  if (GUESSED_STATUSES.has(status)) return "guessed";
  return "neither";
}

/**
 * Did the reply's own words touch the declared gap?
 *
 * ⚠ **Deliberately cheap and deliberately reported beside the judge**, never
 * instead of it. It cannot tell a question that addresses the gap in different
 * words from one that ignores it, and it will credit a reply that merely uses
 * a gap word in passing. Both errors are visible only when the two columns
 * disagree, which is the reason they are both printed.
 */
export function mentionsGap(reply: string, probe: Probe): boolean {
  const hay = reply.toLowerCase();
  return probe.gapWords.some((w) => hay.includes(w.toLowerCase()));
}

// ── The controls, and they are the whole defence ─────────────────────────────

/**
 * Replies with verdicts declared HERE, in the commit that created this file,
 * and mixed into the judging blind.
 *
 * ⚠ Both directions are represented on purpose. Three are bad, so a judge that
 * praises everything fails. Two are good, so a judge that damns everything
 * fails too. A control set with only one polarity is a control that cannot
 * fail, which is the failure this repository names I-38 and has hit at every
 * scale including a whole dead test layer.
 */
export type Control = {
  id: string;
  probeId: string;
  /** The reply the judge is shown. */
  reply: string;
  /** What a competent judge must say. Declared before any run. */
  expectGapAddressed: boolean;
  /** Why this is the right verdict — printed when a judge disagrees. */
  because: string;
};

export const CONTROLS: Control[] = [
  {
    id: "C1-bad-asks-what-was-said",
    probeId: "P03",
    reply:
      "Before I add this, could you tell me what you would like the automation to summarise? I want to make sure I pick the right subject matter.",
    expectGapAddressed: false,
    because:
      "the sentence already said overdue invoices; the missing thing was the RECIPIENT, and this asks about the one part that was stated",
  },
  {
    id: "C2-bad-identical-options",
    probeId: "P09",
    reply:
      "How late is late? Options: (a) late, (b) quite late, (c) late enough, (d) rather late.",
    expectGapAddressed: false,
    because: "it names the gap but offers four options that are the same option, so nothing is actually decidable",
  },
  {
    id: "C3-bad-invented-source",
    probeId: "P02",
    reply:
      "Added a step that reads from the timesheet_portal.attendance_feed connector and emails the result to the team.",
    expectGapAddressed: false,
    because: "it resolved the gap by inventing a reader that is in no catalogue — a confident answer that cannot run",
  },
  {
    id: "C4-good-names-the-gap",
    probeId: "P03",
    reply:
      "Who should receive the summary? I can send it to a fixed address, or take the address as an input when the automation runs.",
    expectGapAddressed: true,
    because: "it asks exactly the missing thing and offers two usable, genuinely different answers",
  },
  {
    id: "C5-good-states-its-assumption",
    probeId: "P04",
    reply:
      "I have taken the month as an input called period rather than fixing it, so the same automation works every month. Say the word if you want it pinned to one month instead.",
    expectGapAddressed: true,
    because: "it guessed, but named the assumption and the alternative, which is the defensible form of guessing",
  },
];

// ── The judge ────────────────────────────────────────────────────────────────

export type Verdict = {
  gapAddressed: boolean;
  /** 1 unusable … 5 exactly what a person needed. */
  quality: number;
  /** Only meaningful when the reply offered options; null otherwise. */
  optionsUsable: boolean | null;
  note: string;
};

/**
 * ⚠ **The judge is never told which items are controls, nor which probe is
 * "supposed" to be answered how.** It sees the person's sentence, the declared
 * gap, and the reply. A judge shown the expected verdict is a judge marking its
 * own reading comprehension.
 *
 * It is also never told whether asking or guessing is preferred — `quality` is
 * asked for within whichever the reply did. Telling it would put this file's
 * thumb on the one scale the report refuses to rank.
 */
export function buildJudgePrompt(args: { text: string; gap: string; flowSummary: string; reply: string }): string {
  return [
    "You are reviewing one reply from an automation-building assistant.",
    "",
    "A person typed a deliberately underspecified sentence. The assistant either asked a",
    "clarifying question or committed to a reading and made an edit. BOTH can be correct.",
    "Do not reward asking over acting, or acting over asking. Judge only how useful the",
    "reply is to the person who typed the sentence.",
    "",
    `WHAT THE PERSON TYPED: ${args.text}`,
    `WHAT WAS ACTUALLY UNDERSPECIFIED: ${args.gap}`,
    `THE AUTOMATION AS IT STOOD: ${args.flowSummary}`,
    "",
    "THE ASSISTANT'S REPLY:",
    args.reply,
    "",
    "Answer with JSON and nothing else:",
    '{"gap_addressed":<true|false>,"quality":<1-5>,"options_usable":<true|false|null>,"note":"<=140 chars"}',
    "",
    "gap_addressed — did the reply engage with the thing that was underspecified?",
    "  A question about something the sentence already stated is false.",
    "  An edit that resolved the gap by inventing data that was not offered is false.",
    "quality — 1 unusable, 3 workable, 5 exactly what the person needed next.",
    "options_usable — if the reply offered choices, are they genuinely different and",
    "  actionable? null if it offered none.",
  ].join("\n");
}

/** Tolerant parse of the judge's reply. Returns null when it cannot be read. */
export function parseVerdict(raw: string): Verdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const q = Number(o.quality);
  if (typeof o.gap_addressed !== "boolean" || !Number.isFinite(q)) return null;
  return {
    gapAddressed: o.gap_addressed,
    quality: Math.min(5, Math.max(1, Math.round(q))),
    optionsUsable: typeof o.options_usable === "boolean" ? o.options_usable : null,
    note: typeof o.note === "string" ? o.note.slice(0, 140) : "",
  };
}

export type ControlOutcome = { id: string; expected: boolean; got: boolean | null; agreed: boolean };

/**
 * Did the judge discriminate?
 *
 * ⚠ **The bar is BOTH polarities, not a hit rate.** A judge that agrees on
 * every bad control and no good one has a hit rate of 60% and is worthless — it
 * is a judge that always says "no". So the verdict is: at least one good
 * control agreed AND at least one bad control agreed. Anything less and the
 * judged half of the report is void.
 */
export function judgeIsUsable(outcomes: ControlOutcome[], controls: Control[] = CONTROLS): boolean {
  const by = new Map(controls.map((c) => [c.id, c]));
  const good = outcomes.filter((o) => by.get(o.id)?.expectGapAddressed === true);
  const bad = outcomes.filter((o) => by.get(o.id)?.expectGapAddressed === false);
  return good.some((o) => o.agreed) && bad.some((o) => o.agreed);
}

export type ProbeResult = {
  probeId: string;
  round: number;
  status: string;
  behaviour: Behaviour;
  clarificationRounds: number;
  mentionedGap: boolean;
  invented: string[];
  verdict: Verdict | null;
  secs: number;
  reply: string;
};

export type Tally = {
  n: number;
  asked: number;
  guessed: number;
  neither: number;
  /** Of the probes where a default WAS available. */
  askedWhereDefaultExisted: number;
  guessedWhereNoDefault: number;
  mentionedGap: number;
  invented: number;
  meanQuality: number | null;
};

/**
 * ⚠ **No composite score is computed here and one must not be added.** `asked`
 * and `guessed` are returned side by side, and the two cross-tabs against
 * `defensibleGuess` are what a reader needs to tell a helpful assumption from a
 * lazy one. Collapsing them into a single percentage would encode a preference
 * that was explicitly declined.
 */
export function tally(results: ProbeResult[], probes: Probe[] = PROBES): Tally {
  const by = new Map(probes.map((p) => [p.id, p]));
  const q = results.map((r) => r.verdict?.quality).filter((x): x is number => typeof x === "number");
  return {
    n: results.length,
    asked: results.filter((r) => r.behaviour === "asked").length,
    guessed: results.filter((r) => r.behaviour === "guessed").length,
    neither: results.filter((r) => r.behaviour === "neither").length,
    askedWhereDefaultExisted: results.filter(
      (r) => r.behaviour === "asked" && by.get(r.probeId)?.defensibleGuess === true,
    ).length,
    guessedWhereNoDefault: results.filter(
      (r) => r.behaviour === "guessed" && by.get(r.probeId)?.defensibleGuess === false,
    ).length,
    mentionedGap: results.filter((r) => r.mentionedGap).length,
    invented: results.filter((r) => r.invented.length > 0).length,
    meanQuality: q.length ? Math.round((q.reduce((a, b) => a + b, 0) / q.length) * 10) / 10 : null,
  };
}

/**
 * Refs the reply committed to that the workspace cannot serve.
 *
 * ⚠ This is the one observable that catches C3's failure — a confident answer
 * that cannot run. It is computed from the catalogue the turn was actually
 * given, never from a list written here, because a hardcoded catalogue is a
 * second definition of what a workspace offers and it drifts silently.
 */
export function inventedRefs(opRefs: string[], catalogueRefs: Set<string>): string[] {
  return opRefs.filter((r) => r && !catalogueRefs.has(r));
}
