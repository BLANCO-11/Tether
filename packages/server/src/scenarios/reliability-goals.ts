/**
 * T5 — THE RELIABILITY EXIT CRITERION. Twelve goals, committed BEFORE the fix.
 *
 * ── Why this file exists and why it is committed first ───────────────────────
 *
 * The measured complaint is a **52% refusal rate** on goal-mode generation
 * (9 `ok` · 14 `insufficient_catalogue` · 4 `failed` in `flow_generation_jobs`).
 * The drafter changes T1–T4 fix it (builder programme, closed; record removed 2026-09-11). A set of
 * goals written AFTER those changes could be chosen — even honestly, even
 * unconsciously — to suit what the fix happens to do. So the set lands in its own
 * commit, before a line of T1–T4 is written, and every expectation below is
 * declared here rather than judged at the end of a run.
 *
 * ⚠ **A REFUSAL IS NOT AUTOMATICALLY A FAILURE, and two of the twelve are
 * refusals that MUST hold.** Without them "never refuses" scores 100% and the
 * measurement rewards exactly the regression that would hurt most: a drafter that
 * invents a ref rather than saying it cannot see one. `#7` and `#12` are those
 * controls. If a change makes them draft, the change is bad however good the
 * headline number looks.
 *
 * ── Written against the HR catalogue AS IT ACTUALLY IS ───────────────────────
 *
 * Measured 2026-09-02: **16 tools · 1 datasource** (`hr_demo`, 7 introspected
 * tables). Four tools read attendance, so most attendance goals are servable
 * without the datasource; `leave_requests` and `offices` are reachable only
 * through it, which is why goals over them are the honest refusals. A set that
 * ignored this would measure a workspace nobody has.
 *
 * ⚠ **THE NAMED-QUERY COUNT MOVES, AND THIS FILE MUST NOT ASSERT IT.** It said
 * "0 named queries · 0 DB operations" until 2026-09-02 and HR now carries
 * **three** named queries (`policy_thresholds`, `attendance_excluded`,
 * `attendance_below_threshold`) — created by `e2e:ui`, which authors into this
 * very workspace, as do `showcase:seed`, `kestra:phase3/4/6`, `kestra:expect`
 * and `kestra:canvas`. That is the documented cost of the harnesses sharing one
 * deployment and it is not a bug in either.
 *
 * ⚠ **So a before/after is only comparable when BOTH HALVES RAN AGAINST THE SAME
 * CATALOGUE.** Re-read the counts at the time of each run and record them beside
 * the numbers; a set that quotes a stale shape reports a catalogue change as a
 * reliability change.
 *
 * ⚠ **`expect` is a DECLARATION, not a prediction.** `draft` means the catalogue
 * can serve it and a draft is the right answer. `refuse` means it cannot and
 * `insufficient_catalogue` is the right answer. Anything else — a `failed`, a
 * refusal where a draft was declared, a draft where a refusal was declared — is
 * a miss, and the harness reports the three buckets separately rather than
 * collapsing them into a score.
 *
 * ⚠ **PURE DATA. No imports, no repos, no gateway, no `process`.** The same rule
 * `propose-adjudicate.ts` follows: a scenario script's `main()` runs at import,
 * so anything a test may want to read has to live somewhere it cannot drag the
 * live stack in behind it.
 */

export type ReliabilityExpectation = "draft" | "refuse";

export interface ReliabilityGoal {
  /** Stable id — quoted in results, so it must never be renumbered. */
  id: string;
  /** What a person would actually type. */
  goal: string;
  /** Declared before the run. See the ⚠ above. */
  expect: ReliabilityExpectation;
  /** Why this goal is in the set, and why that expectation is the right one. */
  why: string;
}

export const RELIABILITY_GOALS: ReliabilityGoal[] = [
  {
    id: "R01",
    goal: "Every month, email employees whose attendance is below 80 percent a reminder",
    expect: "draft",
    why:
      "THE headline case, and the one the 52% is mostly made of. A threshold is a filter " +
      "over rows a tool already returns — `hr_attendance_summary` emits a per-row numeric " +
      "rate — so the answer is a transform, never a refusal. C1/C5's dead marker string is " +
      "what taught the model otherwise.",
  },
  {
    id: "R02",
    goal:
      "Each month, find employees whose attendance is below their own department's " +
      "threshold, and email each of them a warning",
    expect: "draft",
    why:
      "The same shape with the threshold coming from a second source rather than a literal. " +
      "It needs a join across two tool outputs in a transform — harder than R01 and still " +
      "entirely servable. Deliberately the trap employee #14 sits in (80.95%: above the " +
      "org-wide 80, below Engineering's 85).",
  },
  {
    id: "R03",
    goal: "List everyone in the Engineering department with their manager and work email",
    expect: "draft",
    why:
      "The floor. One tool, no filtering, no arithmetic, no delivery. If this ever refuses " +
      "or fails, nothing above it is worth reading — it is the control that says the " +
      "workspace and the gateway were both actually working when the set ran.",
  },
  {
    id: "R04",
    goal: "Send the HR ops channel a weekly summary of how many people are below 80 percent attendance",
    expect: "draft",
    why:
      "A COUNT rather than a list, delivered to a channel rather than to each person. The " +
      "same filter as R01 feeding an aggregate — it catches a fix that special-cases " +
      "'threshold → email each row' and does not generalise to 'threshold → count'.",
  },
  {
    id: "R05",
    goal:
      "Every month, write a short plain-English summary of the attendance situation and " +
      "post it to the HR ops channel",
    expect: "draft",
    why:
      "`llm_complete` as a LEAF (D-34). The model's paragraph is the deliverable and nothing " +
      "downstream consumes it. Present so a reliability fix cannot quietly make the drafter " +
      "avoid the one tool whose output is terminal by design.",
  },
  {
    id: "R06",
    goal:
      "Each month, email employees below 80 percent attendance — but let a person review " +
      "the list before anything is sent",
    expect: "draft",
    why:
      "`approval` is a step kind, and the drafter was not told so until I-46 — a goal asking " +
      "for a human decision produced a `tool` step named after a pause that does not pause. " +
      "It survived because gate 3 was only ever spliced in by `FlowReview`. Kept in the set " +
      "so it cannot regress silently a second time.",
  },
  {
    id: "R07",
    goal:
      "Post to the HR ops channel every approved leave request that starts in a period I " +
      "give, with the employee's name and the type of leave",
    expect: "refuse",
    why:
      "⚠ CONTROL 1 — the honest refusal, and the reason the headline number means anything. " +
      "There is no leave tool in this workspace. `hr_demo.leave_requests` is the only source " +
      "and it is a TABLE, which is not callable (FR-001/D-176). The right answer is " +
      "`insufficient_catalogue` NAMING THE DATASOURCE, on attempt one. A draft here is the " +
      "invented-ref failure, and it would look like an improvement in every other column.",
  },
  {
    id: "R08",
    goal: "Email each employee their own attendance figure for last month",
    expect: "draft",
    why:
      "Fan-out with no filter at all. One message per row, personalised. It separates 'can " +
      "it fan out' from 'can it filter', which R01 conflates — a fix that repaired filtering " +
      "and broke per-row delivery would still pass R01 on the count.",
  },
  {
    id: "R09",
    goal:
      "Find employees with no work email recorded and tell the HR ops channel who they are",
    expect: "draft",
    why:
      "A NULL/absence filter rather than a numeric one. The dataset has a deliberate " +
      "NULL-email contractor. Filtering on a missing value is the case a threshold-shaped " +
      "fix is most likely to miss, because it is not a comparison.",
  },
  {
    id: "R10",
    goal:
      "Every month, check attendance against each department's threshold, ask a person to " +
      "confirm, then email the people who are below it and post a count to the HR ops channel",
    expect: "draft",
    why:
      "The long one — datasource read, per-row threshold, a gate, fan-out delivery AND a " +
      "channel post. It is where the redraft loop hurts most: one bad expression today costs " +
      "a whole re-emission of six steps (C3), so this is the arm T2 should move furthest.",
  },
  {
    id: "R11",
    goal: "Notify the HR ops channel when someone's attendance drops below 80 percent",
    expect: "draft",
    why:
      "The same rule as R01 phrased as an EVENT rather than a schedule. Foundry has no " +
      "row-level change trigger, so the honest reading is a periodic check — and the " +
      "interesting question is whether the phrasing alone flips a servable goal into a " +
      "refusal. If it does, the problem is comprehension, not capability.",
  },
  {
    id: "R12",
    goal:
      "Look up which office each employee sits in and post the desk occupancy per floor " +
      "to the HR ops channel",
    expect: "refuse",
    why:
      "⚠ CONTROL 2 — a SECOND honest refusal, deliberately unlike R07. R07 fails on a table " +
      "with no reader; this one asks for a derived quantity (occupancy per floor) that no " +
      "tool computes and no table records — `offices` carries no floor. Two refusals with " +
      "different causes, because one control is one way of being wrong and a fix can route " +
      "around a single shape.",
  },
];

/** Declared draft/refuse split, so a run states the shape of its own set. */
export const RELIABILITY_SPLIT = {
  total: RELIABILITY_GOALS.length,
  draft: RELIABILITY_GOALS.filter((g) => g.expect === "draft").length,
  refuse: RELIABILITY_GOALS.filter((g) => g.expect === "refuse").length,
};
