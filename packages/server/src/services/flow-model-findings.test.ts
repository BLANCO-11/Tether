/**
 * ONE list of pure checks, and the guard that keeps it one — foundations 2.10,
 * I-127.
 *
 * ⚠ These tests are not about what any check DOES; each check has its own suite
 * (`flow-expression.service.test.ts`, `flow-output-shape.test.ts`). They are
 * about **the set**: that `pureModelFindings` runs every entry, that nothing has
 * been quietly dropped from the path `authorFlow`, `flowRefineService` and chat
 * share, and that `draftFlow`'s two-group feedback still covers the whole set.
 *
 * The failure mode being guarded is an ABSENCE — a check nobody calls produces no
 * finding — which is why the reachability test is per-check and driven off the
 * list itself, with the I-38 controls the repo insists on: the list is non-empty,
 * and every name in it must have a fixture or the test fails rather than passing
 * over nothing.
 */
import { describe, expect, it } from "vitest";
import {
  ADVISORY_CHECKS,
  EXPRESSION_CHECKS,
  LOCAL_CHECKS,
  PURE_MODEL_CHECKS,
  RELATIONAL_CHECKS,
  SHAPE_CHECKS,
  advisoryFindings,
  localModelFindings,
  pureModelFindings,
  relationalFindings,
  runChecks,
} from "./flow-model-findings.js";

/**
 * One model per check, chosen so that **exactly** that check fires on it. The
 * isolation is what makes this a reachability test: if a check is removed from
 * `PURE_MODEL_CHECKS`, its fixture produces zero findings through
 * `pureModelFindings` and no other entry covers for it.
 */
const FIXTURES: Record<string, Array<Record<string, unknown>>> = {
  /** D-22: `secret(...)` is not on the allowlist — the callback-secret exfiltration. */
  validateModelExpressions: [
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: `[{"to":"a@b.example","token":{{ secret('FOUNDRY_CALLBACK') }}}]`,
    },
  ],
  /** I-44: the `code` shape read off a `datasource` step. Unquoted, so I-11's check stays out. */
  checkOutputShapes: [
    { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: `[{"rows": {{ outputs.fetch.vars.result }} }]`,
    },
  ],
  /** Phase 7 (R03): `.results[0]` of a step that runs once per element. */
  checkFanOutFirstResult: [
    { id: "people", kind: "transform", expr: "{{ 1 }}" },
    { id: "lookup", kind: "tool", ref: "hr_get_employee", over: { stepId: "people", field: "" } },
    { id: "list", kind: "transform", expr: "{{ json(outputs.lookup.body).results[0].data }}" },
  ],
  /** I-11: a whole structure interpolated into a quoted JSON string position. */
  checkJsonPositions: [
    { id: "shape", kind: "transform", expr: ".results[0].data" },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: `[{"rows":"{{ json(outputs.shape.value) }}"}]`,
    },
  ],
  /**
   * ⚠ **I-119, verbatim from the run that produced it** — 11 employees fetched,
   * every step green, and the model told *"the input does not provide any
   * employee attendance data"*. This is the fixture that matters most: it is the
   * one refine was missing.
   */
  checkTextToolInput: [
    { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
    {
      id: "report",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr:
        `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('("Generate a concise report ` +
        `for employees with less than 80 percent attendance for period " + .period + ". Include ` +
        `the evaluated count, below-threshold count, and a short bullet list of affected ` +
        `employees with attendance_rate and min_attendance_rate. Use plain English.") | @json') ` +
        `| first }},"instruction":"Write a concise report."}]`,
    },
  ],
  /**
   * ⚠ **Verbatim from execution `e097b55b` (2026-08-18)**, the first real use of
   * `tether_email_send`. `.data.text` is the LLM's report — a String — and
   * Kestra's `jq` parses its input as JSON, so this failed at RENDER time with
   * "Unable to parse jq value … with type 'java.lang.String'". The step never made
   * an HTTP request, so nothing anywhere reported an email problem.
   *
   * ⚠ The `report_text` step here is the WORKING form of the same idiom, kept in
   * the fixture on purpose: the two differ only in whether a leaf was selected
   * before `jq`, which is exactly why reading the model does not catch this.
   */
  /**
   * ⚠ **Verbatim from execution `fa04cfc3` (2026-08-18)** — the SECOND draft of the
   * same automation, generated after `checkPluckedThenJq`'s prompt rule shipped. The
   * model avoided the shape that rule forbids and took the adjacent one: the prose
   * in quotes, where its newlines made the body invalid JSON. That is why both
   * checks exist and why the prompt now leads with the correct form.
   */
  checkFreeTextInQuotes: [
    {
      id: "report",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr: `[{"input":"x","instruction":"Write a report."}]`,
    },
    {
      id: "send",
      kind: "tool",
      ref: "tether_email_send",
      paramsExpr:
        `[{"body":"{{ json(outputs.report.body).results[0].data.text }}",` +
        `"subject":"Attendance report"}]`,
    },
  ],
  /**
   * ⚠ **Verbatim from execution `a6488641` (2026-08-19)** — the THIRD member of this
   * family in two days, and the closest miss of the three. The expression is
   * `DRAFT_RULES`' own prescribed form for `llm_complete`'s `input`, with the quotes
   * left on. `@json` supplies its own quotes, so the rendered body opened `"input":""{`
   * — invalid JSON at the second quote — and `POST /api/steps/tool` answered 400.
   *
   * ⚠ The `fetch` step is a `tool`, matching the run, so `checkOutputShapes` reads a
   * correct first segment and stays silent. All five other checks passed this model;
   * `checkEncodedInQuotes`'s docblock records the five separate reasons.
   */
  checkEncodedInQuotes: [
    {
      id: "fetch",
      kind: "tool",
      ref: "hr_attendance_summary",
      paramsExpr: `[{"period":"{{ inputs.period }}"}]`,
    },
    {
      id: "report",
      kind: "tool",
      ref: "llm_complete",
      dependsOn: ["fetch"],
      paramsExpr:
        `[{"input":"{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') ` +
        `| first }}","instruction":"Write a concise attendance report for the user based only ` +
        `on the provided data."}]`,
    },
  ],
  checkPluckedThenJq: [
    { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
    {
      /**
       * ⚠ SCAFFOLDING, and its `input` is PROJECTED as of 2026-08-20. The subject
       * of this fixture is `send_email` below, which is verbatim from execution
       * `e097b55b` and untouched. This step's `input` was verbatim too — the
       * unbounded `jq('tostring | @json')` — and `checkBulkToolInput` now
       * correctly reports it, which would make this fixture a case for two checks
       * and break the "no other check covers for it" guard.
       *
       * The right resolution is to project here rather than to weaken that guard:
       * a fixture that trips two checks cannot show which one is reached.
       */
      id: "report_text",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr:
        `[{"input":{{ json(outputs.fetch.body).results[0].data ` +
        `| jq('map({name, rate}) | tostring | @json') | first }},` +
        `"instruction":"Write a concise report."}]`,
    },
    {
      id: "send_email",
      kind: "tool",
      ref: "tether_email_send",
      paramsExpr:
        `[{"body":{{ json(outputs.report_text.body).results[0].data.text | ` +
        `jq('tostring | @json') | first }},"subject":"Employee attendance report"}]`,
    },
  ],
  /**
   * ⚠ **`checkPluckedThenJq`'s known blind spot, quoted.** That check reads
   * unquoted positions only, so `"text":"{{ outputs.rows_step.value |
   * jq('tostring') | first }}"` passed the whole set: the quotes decide the JSON
   * around the value while `jq` chokes one level earlier, on its input.
   *
   * ⚠ The `rows_step` transform is the WORKING filter form on purpose, kept for
   * the same reason the `checkPluckedThenJq` fixture keeps its working step: the
   * two differ only in whether the pipe carries an encoder-only program, which
   * is exactly why reading the model does not catch this. And `tostring`
   * rather than `@json` keeps `checkEncodedInQuotes` out — an `@json` value in
   * quotes is that check's own case, and a fixture tripping two checks cannot
   * show which one is reached.
   */
  checkTextValueThenJq: [
    { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
    {
      id: "rows_step",
      kind: "transform",
      expr: `{{ json(outputs.fetch.body).results[0].data | jq('[.[] | {n: .name}]') | first }}`,
    },
    {
      id: "send",
      kind: "tool",
      ref: "tether_email_send",
      paramsExpr: `[{"text":"{{ outputs.rows_step.value | jq('tostring') | first }}"}]`,
    },
  ],
  /**
   * ⚠ **Verbatim from execution `05aca859` (2026-08-19)** — flow
   * `attendance_report_email_2`. `fetch` called an attendance endpoint with no
   * filter registered and returned **4,722 rows / 7.19 MiB** where the report
   * asked for one month; `input` carried all of it, the step callback was
   * 8,401,233 bytes, and the transport refused it with four words about a request
   * entity.
   *
   * ⚠ The expression is not malformed — it is UNBOUNDED, which is why no check
   * before this one had anything to say about it. The same flow passes on a small
   * month and fails on a large one.
   */
  checkBulkToolInput: [
    { id: "fetch", kind: "tool", ref: "BTO_tool", paramsExpr: `[{"period":"2026-06"}]` },
    {
      id: "report",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr:
        `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') ` +
        `| first }},"instruction":"Write a concise attendance report."}]`,
    },
  ],
  /**
   * Execution `7cwL1ris`. ⚠ `period_start` is deliberately absent from this
   * fixture even though the real step carried it: `"{{ inputs.period }}-01"` is
   * CORRECT and produces no finding, so including it would prove nothing and
   * leaving it out keeps this fixture a case for exactly one check.
   */
  checkConstructedDates: [
    {
      id: "fetch_leave_requests",
      kind: "query",
      ref: "hr_demo.approved_leave_requests",
      paramsExpr: '[{"period_end":"{{ inputs.period }}-31"}]',
    },
  ],
  /**
   * WARNING The reported failure, reduced: a step reading an input the flow never
   * declared. Execution `1ygllnw0XWjPHWo04qarqk` died on exactly this, and six
   * revisions of that flow carried it because nothing looked.
   *
   * `as_of` is deliberately NOT in `FIXTURE_INPUTS` and `period` deliberately
   * IS - otherwise every other fixture above, which reads `inputs.period`,
   * would fire this check too and the "no other check covers for it" half of
   * the guard would be measuring nothing.
   */
  checkDeclaredInputs: [
    {
      id: "fetch_csat_by_team",
      kind: "datasource",
      ref: "support_demo.csat_by_team",
      paramsExpr: '[{"as_of":"{{ inputs.as_of }}"}]',
    },
  ],
  /**
   * WARNING Its twin, from the run that the fix above unblocked: a step reading
   * `outputs.<step>` for a step that is not there. A chat turn removed a
   * transform and left this behind. `dependsOn` was rewired; the expression was
   * not, and only one of the two references was ever checked.
   *
   * Two steps, so the finding is about the MISSING one and not about a model
   * with a single step reading itself.
   */
  checkStepRefs: [
    { id: "fetch", kind: "datasource", ref: "d.q", paramsExpr: "[{}]" },
    {
      id: "summarise",
      kind: "tool",
      ref: "llm_complete",
      dependsOn: ["fetch"],
      paramsExpr:
        '[{"input": {{ json(outputs.gone.value) | jq(\'tostring | @json\') | first }},' +
        '"instruction":"summarise"}]',
    },
  ],
  /**
   * WARNING Its structured twin: a feed bound to a step that is not in the
   * model. A chat turn bound `fetch.period → derive_month.month` with no
   * `derive_month` step, and every check above passed it — they read the
   * display strings, and a typed `Source` names its step outside all of them.
   *
   * No display string at all, so `checkStepRefs` stays silent: a fixture
   * tripping two checks cannot show which one is reached.
   */
  unknown_binding_step: [
    {
      id: "fetch",
      kind: "tool",
      ref: "hr_tool",
      inputs: [{ name: "period", source: { from: "step", stepId: "derive_month", field: "month" } }],
    },
  ],
  /**
   * WARNING Liveness, not shape: a `query` step nothing reads. `tool` would be
   * the wrong kind here — an unread tool stays silent (its effect may be the
   * point) — and there are deliberately no readers at all, so every other
   * check stays silent: a fixture tripping two checks cannot show which one is
   * reached. `paramsExpr` is a plain literal, so neither the expression checks
   * nor `checkConstructedDates` has anything to say about it.
   */
  unused_step: [
    {
      id: "lookup",
      kind: "query",
      ref: "hr_demo.approved_leave_requests",
      paramsExpr: `[{"period":"2026-06"}]`,
    },
  ],
};

/**
 * The inputs every fixture above is checked against.
 *
 * WARNING `period` is here because most fixtures read it and are NOT cases for
 * the undeclared-input check; `as_of` is absent because one fixture is.
 */
const FIXTURE_INPUTS = ["period"];

describe("the pure check set", () => {
  it("is not empty and names each check once — the I-38 control", () => {
    // Without this, every assertion below would pass over an empty list.
    expect(PURE_MODEL_CHECKS.length).toBeGreaterThan(0);
    const names = PURE_MODEL_CHECKS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // Stated, so that dropping one is a deliberate edit to a test rather than a
    // silent narrowing of every path that shares the set.
    // ⚠ **THE ORDER MOVED ON 2026-09-16 and the membership did not.** The four
    // RELATIONAL checks — each one a finding a later edit elsewhere can satisfy
    // — were grouped out of the two local lists and now report LAST. Nothing
    // was added and nothing removed; if this list ever shrinks, a check has
    // fallen out of every group and is enforced nowhere.
    expect(names).toEqual([
      // local — EXPRESSION_CHECKS
      "validateModelExpressions",
      // local — SHAPE_CHECKS
      "checkOutputShapes",
      "checkFanOutFirstResult",
      "checkJsonPositions",
      "checkTextToolInput",
      "checkPluckedThenJq",
      "checkFreeTextInQuotes",
      "checkEncodedInQuotes",
      "checkBulkToolInput",
      "checkConstructedDates",
      "checkTextValueThenJq",
      // relational — deferred to the FINAL model of a unit of work
      "checkDeclaredInputs",
      "checkStepRefs",
      "unknown_binding_step",
      "unused_step",
    ]);
  });

  it("has a fixture for every check in it", () => {
    // A new check with no fixture fails HERE rather than being added untested.
    //
    // ⚠ **This assertion and the literal list above are what catch a REMOVAL**,
    // and the reachability test below cannot: it iterates `PURE_MODEL_CHECKS`, so
    // a check deleted from the list is simply not iterated — a test passing over
    // a shorter set, which is I-38 exactly. Measured: dropping
    // `checkTextToolInput` from `SHAPE_CHECKS` fails this test, the names test and
    // the ordering test, plus the I-119 refine turn in `flow-refine.test.ts` — and
    // NOT the loop below.
    expect(Object.keys(FIXTURES).sort()).toEqual(PURE_MODEL_CHECKS.map((c) => c.name).sort());
  });

  it("runs EVERY check — each fixture's finding survives into pureModelFindings", () => {
    // `unused_step` answers separately, because it is liveness rather than
    // shape: a fixture built as a case for another check is often a single
    // step nothing reads, which is exactly what liveness reports.
    const liveness = PURE_MODEL_CHECKS.find((c) => c.name === "unused_step")!;
    for (const check of PURE_MODEL_CHECKS) {
      const steps = FIXTURES[check.name]!;
      const own = check.run(steps, FIXTURE_INPUTS);
      // The fixture really is a case for this check…
      expect(own.length, `${check.name}'s fixture produced no finding of its own`).toBeGreaterThan(
        0,
      );
      // …and no other check covers for it, so removing it from the set removes
      // these findings from the shared answer.
      for (const other of PURE_MODEL_CHECKS) {
        if (other.name === check.name) continue;
        // Liveness fires on other checks' minimal fixtures by design (an
        // unread step is the fixture), so it is exempt here — and the reverse
        // is NOT exempt: nothing but `unused_step` may fire on its fixture.
        if (other.name === "unused_step") continue;
        expect(other.run(steps, FIXTURE_INPUTS), `${other.name} also fired on ${check.name}'s fixture`).toEqual([]);
      }
      // …and `pureModelFindings` reports exactly them — plus the liveness
      // warning wherever the fixture leaves a step unread. `unused_step` is
      // last in the set, so its warnings come last.
      const live = check.name === "unused_step" ? [] : liveness.run(steps, FIXTURE_INPUTS);
      expect(pureModelFindings(steps, FIXTURE_INPUTS), `${check.name} is not reached`).toEqual([...own, ...live]);
    }
  });

  it("reports the expression findings first, then the shape ones", () => {
    // The order is what a redraft and a canvas form both read, and `draftFlow`
    // reports the expression class on its own — so it is a property, not an
    // accident of how the array was typed.
    const steps = [...FIXTURES.validateModelExpressions!, ...FIXTURES.checkTextToolInput!];
    const all = pureModelFindings(steps, []);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]).toMatch(/secret/);
    expect(all[all.length - 1]).toMatch(/DESCRIPTION of the rows/);
  });

  it("the four groups draftFlow feeds back separately partition the whole set", () => {
    // ⚠ `draftFlow` reports ONE class of finding per attempt, so it calls the
    // groups rather than `pureModelFindings`. This is what stops that staging
    // from silently covering less than the set `authorFlow` and `refine` enforce.
    //
    // ⚠ **THREE since 2026-09-16, and the third is the load-bearing one here.**
    // `RELATIONAL_CHECKS` was split out so a caller part way through a SEQUENCE
    // of edits can judge an intermediate model without it. The moment those
    // four left the other two groups, `draftFlow`'s loop was the only thing
    // still running them on that path — so this assertion is what would catch
    // the split having quietly dropped a check from generation entirely.
    expect(
      [...EXPRESSION_CHECKS, ...SHAPE_CHECKS, ...RELATIONAL_CHECKS, ...ADVISORY_CHECKS].map(
        (c) => c.name,
      ),
    ).toEqual(PURE_MODEL_CHECKS.map((c) => c.name));
    for (const group of [EXPRESSION_CHECKS, SHAPE_CHECKS, RELATIONAL_CHECKS, ADVISORY_CHECKS]) {
      expect(group.length).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠ **`LOCAL_CHECKS` is the complement of `RELATIONAL_CHECKS`, asserted as an
   * exact partition in BOTH directions.**
   *
   * A check that fell out of both groups would be enforced nowhere and nothing
   * else would notice — `pureModelFindings` is built from the two, so it would
   * agree with itself. A check in both would run twice and report a finding
   * twice to a model that is being asked to fix it once.
   */
  it("LOCAL, RELATIONAL and ADVISORY partition the set, with no overlap", () => {
    const local = LOCAL_CHECKS.map((c) => c.name);
    const relational = RELATIONAL_CHECKS.map((c) => c.name);
    const advisory = ADVISORY_CHECKS.map((c) => c.name);
    expect([...local, ...relational, ...advisory].sort()).toEqual(
      PURE_MODEL_CHECKS.map((c) => c.name).sort(),
    );
    for (const [a, b] of [
      [local, relational],
      [local, advisory],
      [relational, advisory],
    ] as const) {
      expect(a.filter((n) => b.includes(n))).toEqual([]);
    }
  });

  /**
   * ⚠ **THE CRITERION, asserted rather than left in a docblock.**
   *
   * A relational finding names two subjects: this step, and something it does
   * or does not connect to — so ADDING A STEP elsewhere can make it go away.
   * That property is the whole reason the group exists, and it is what makes
   * deferring these to the end of a sequence correct rather than merely
   * convenient. A check that does not have it does not belong here.
   *
   * The fixture is the case measured on flow `cd9f339b`: a transform nothing
   * reads, made read by declaring it the flow's result.
   */
  it("every relational finding can be satisfied by an edit elsewhere in the flow", () => {
    // Reads an input the flow does not declare — the case chat's own empty
    // automation message walks into ("add the step…, declare any inputs on the
    // next reply"), and one `declare_input` op away from correct.
    const steps = [
      {
        id: "fetch",
        kind: "datasource",
        ref: "db.rows",
        paramsExpr: '[{"as_of": "{{ inputs.period }}"}]',
      },
    ];
    expect(relationalFindings(steps, []).join("\n")).toContain("period");
    // The very next op makes it false, touching no step.
    expect(relationalFindings(steps, ["period"])).toEqual([]);
    // ⚠ CONTROL: the LOCAL checks say nothing either way, at both states — so
    // the deferral moves this finding and silences nothing else.
    expect(localModelFindings(steps, [])).toEqual([]);
    expect(localModelFindings(steps, ["period"])).toEqual([]);
  });

  /**
   * ⚠ **The advisory group's defining property: a flow that is merely
   * UNFINISHED must produce no relational finding at all.**
   *
   * A one-step read — the commonest thing anybody asks for, and the first
   * message of most conversations — has nothing reading its one step. If that
   * reaches `relationalFindings`, every conversation is refused at message one.
   * That is not hypothetical: it is what this group was split out of, measured.
   */
  it("an unfinished flow is advisory, never relational", () => {
    const steps = [{ id: "fetch", kind: "datasource", ref: "db.rows", paramsExpr: "[{}]" }];
    expect(relationalFindings(steps, [])).toEqual([]);
    expect(localModelFindings(steps, [])).toEqual([]);
    expect(advisoryFindings(steps, []).join("\n")).toContain("unused_step");
    // Declaring the step the flow's result answers it, as it does on a draft.
    expect(advisoryFindings(steps, [], { stepId: "fetch" })).toEqual([]);
  });

  /**
   * ⚠ **THE COPY IS THE CONTROL** (plan Decision 9, same idiom as
   * `policy-copy.test.ts`). This finding is what a model reads on a redraft, and
   * the two remedies are not interchangeable: a projection cannot produce a
   * total, so a model that has only been told about `transform` and needs a
   * ranking reaches for a bigger `input` instead — which is the failure this
   * whole feature exists to stop.
   *
   * Asserted through `pureModelFindings` rather than the check directly: that is
   * the surface generation and refine both read, and a correct string that does
   * not reach it is I-120.
   */
  it("the bulk finding teaches BOTH remedies and never chunk-and-summarise", () => {
    const findings = pureModelFindings(FIXTURES.checkBulkToolInput!, []);
    expect(findings).toHaveLength(1);
    const [finding] = findings;

    // Both remedies, each with the case it is for.
    expect(finding).toContain("`transform`");
    expect(finding).toContain("`code`");
    expect(finding).toMatch(/fewer rows or columns/);
    expect(finding).toMatch(/counts, totals, rankings/);

    // The ceiling, because the drafter cannot infer it from the tool description.
    expect(finding).toContain("32,000");

    /**
     * ⚠ **D-34.** Chunking the rows through repeated `llm_complete` calls and
     * summarising the summaries makes model output load-bearing — the one thing
     * that rule forbids, earned from a digest whose figures were each correct and
     * whose ranking contradicted them. It also costs ~236 calls for the measured
     * payload. It must never appear here, however reasonable it sounds.
     */
    expect(finding).not.toMatch(/chunk|batch|split|piece|summaris\w+ the summar/i);
  });

  it("runChecks over the whole set is pureModelFindings", () => {
    const steps = FIXTURES.checkTextToolInput!;
    expect(runChecks(PURE_MODEL_CHECKS, steps, [])).toEqual(pureModelFindings(steps, []));
  });

  it("a correct model produces nothing", () => {
    // The other half of every one of these: a check set that refused everything
    // would satisfy all of the above.
    //
    // ⚠ **This example CHANGED on 2026-08-20, and the change is the feature.**
    // It used to bind `input` to the whole response with `jq('tostring | @json')`
    // — which was the correct form until execution `05aca859` showed that it is
    // merely the *unbounded* form: correct on a small month, a failed run on a
    // large one. The projection below is what "correct" now means, and it is row
    // 3 of the corridor table in `flow-output-shape.test.ts`: silent from both
    // `checkTextToolInput` and `checkBulkToolInput`.
    expect(
      pureModelFindings([
        {
          id: "fetch",
          kind: "datasource",
          ref: "hr.attendance",
          paramsExpr: `[{"period":"2026-06"}]`,
        },
        {
          id: "report",
          kind: "tool",
          ref: "llm_complete",
          paramsExpr:
            `[{"input":{{ json(outputs.fetch.body).results[0].data ` +
            `| jq('map({name, rate}) | tostring | @json') | first }},"instruction":"Summarise."}]`,
        },
      ], []),
    ).toEqual([]);
  });
});

describe("unknown_binding_step — the rev-2 live shape", () => {
  it("names the reader, the missing step, and the steps that do exist", () => {
    const findings = pureModelFindings(FIXTURES.unknown_binding_step!, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('step "fetch".inputs[period]');
    expect(findings[0]).toContain('"derive_month"');
    expect(findings[0]).toContain("steps: fetch");
    expect(findings[0]).toContain("unknown_binding_step");
  });

  it("stays silent once the derivation step exists — the control", () => {
    const steps = [
      {
        id: "derive_month",
        kind: "code",
        code: "def run(payload):\n    return {'month': '2026-06'}",
        inputExpr: '{"as_of": "{{ inputs.as_of }}"}',
        outputKeys: ["month"],
      },
      ...FIXTURES.unknown_binding_step!,
    ];
    expect(pureModelFindings(steps, ["as_of"])).toEqual([]);
  });
});

describe("unused_step — the dead-step warning", () => {
  /**
   * One unread step per pure kind. Each is silent from every other check on
   * purpose: the warning must be reachable on its own, the way the loop above
   * proves for every other check through its fixture.
   */
  const UNREAD_BY_KIND: Record<string, Record<string, unknown>> = {
    code: {
      id: "prep",
      kind: "code",
      code: "def run(payload):\n    return {'n': 1}",
      inputExpr: '{"period": "2026-06"}',
      outputKeys: ["n"],
    },
    transform: { id: "shape", kind: "transform", expr: ".results[0].data" },
    query: {
      id: "lookup",
      kind: "query",
      ref: "hr_demo.approved_leave_requests",
      paramsExpr: `[{"period":"2026-06"}]`,
    },
    datasource: {
      id: "fetch",
      kind: "datasource",
      ref: "hr.attendance",
      paramsExpr: `[{"period":"2026-06"}]`,
    },
  };

  it("warns on an unread step of each pure kind, through pureModelFindings", () => {
    for (const [kind, step] of Object.entries(UNREAD_BY_KIND)) {
      const findings = pureModelFindings([step], []);
      expect(findings, `unread ${kind} step produced no warning`).toHaveLength(1);
      expect(findings[0]).toContain(`step "${step.id}"`);
      expect(findings[0]).toContain("unused_step");
    }
  });

  it("names the step and suggests removal", () => {
    const [finding] = pureModelFindings([UNREAD_BY_KIND.query!], []);
    expect(finding).toContain('"lookup"');
    expect(finding).toMatch(/[Rr]emove/);
    expect(finding).toContain("unused_step");
  });

  it("stays silent for a terminal tool — sending mail may be the whole point", () => {
    // Verbatim shape of the `e097b55b` follow-up: an email step nothing reads.
    // Its output is unread, but the effect is not waste, so no warning.
    const steps = [
      {
        id: "send",
        kind: "tool",
        ref: "tether_email_send",
        paramsExpr: `[{"to":"ops@example.com","subject":"Report","body":"done"}]`,
      },
    ];
    expect(pureModelFindings(steps, [])).toEqual([]);
  });

  it("stays silent for approval, branch and merge steps — scheduling is not output", () => {
    const steps = [
      { id: "ask", kind: "approval", summaryExpr: '"why?"' },
      { id: "gate", kind: "branch" },
      { id: "join", kind: "merge", sources: ["a", "b"] },
      { id: "a", kind: "query", ref: "q.a", paramsExpr: "[{}]" },
      { id: "b", kind: "query", ref: "q.b", paramsExpr: "[{}]" },
    ];
    // `a` and `b` are read by the merge; the merge itself never warns.
    expect(pureModelFindings(steps, [])).toEqual([]);
  });

  it("a reader through outputs.<id> counts as a read — the control", () => {
    const steps = [
      { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
      {
        id: "report",
        kind: "tool",
        ref: "llm_complete",
        paramsExpr:
          `[{"input":{{ json(outputs.fetch.body).results[0].data ` +
          `| jq('map({name, rate}) | tostring | @json') | first }},"instruction":"Summarise."}]`,
      },
    ];
    expect(pureModelFindings(steps, [])).toEqual([]);
  });

  it("a reader through a from:step binding counts as a read", () => {
    const derive = {
      id: "derive_month",
      kind: "code",
      code: "def run(payload):\n    return {'month': '2026-06'}",
      inputExpr: '{"as_of": "{{ inputs.as_of }}"}',
      outputKeys: ["month"],
    };
    const bound = {
      id: "fetch",
      kind: "tool",
      ref: "hr_tool",
      inputs: [{ name: "period", source: { from: "step", stepId: "derive_month", field: "month" } }],
    };
    // The derivation with no reader warns…
    expect(pureModelFindings([derive], ["as_of"])).toHaveLength(1);
    // …and the binding silences it, with no display string involved.
    expect(pureModelFindings([derive, bound], ["as_of"])).toEqual([]);
  });

  it("a reader through over and branch guards counts as a read", () => {
    const steps = [
      { id: "rows", kind: "query", ref: "q.rows", paramsExpr: "[{}]" },
      {
        id: "each",
        kind: "tool",
        ref: "t",
        over: { stepId: "rows", field: "items" },
        paramsExpr: "[{}]",
      },
      {
        id: "gate",
        kind: "branch",
        test: { left: { from: "step", stepId: "rows", field: "total" }, operator: "field_gt", right: "100" },
      },
    ];
    expect(pureModelFindings(steps, [])).toEqual([]);
  });

  it("a step the flow output comes from is read by definition", () => {
    const steps = [UNREAD_BY_KIND.query!];
    // Legacy single-step output…
    expect(pureModelFindings(steps, [], { stepId: "lookup", description: "the rows" })).toEqual([]);
    // …and the rows form, through both step-naming sources.
    expect(
      pureModelFindings(steps, [], {
        rows: [{ name: "rows", type: "any", source: { from: "whole", stepId: "lookup" } }],
      }),
    ).toEqual([]);
    expect(
      pureModelFindings(steps, [], {
        rows: [{ name: "period", type: "string", source: { from: "step", stepId: "lookup", field: "period" } }],
      }),
    ).toEqual([]);
    // An output naming another step is no cover for this one.
    expect(pureModelFindings(steps, [], { stepId: "elsewhere", description: "other" })).toHaveLength(1);
  });
});
