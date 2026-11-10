import { describe, it, expect } from "vitest";
import {
  OUTPUT_SHAPES,
  outputExprFor,
  checkOutputShapes,
  checkJsonPositions,
  checkPluckedThenJq,
  checkFreeTextInQuotes,
  checkEncodedInQuotes,
  type StepKind,
  checkTextToolInput,
  checkBulkToolInput,
  checkTextValueThenJq,
} from "./flow-output-shape.js";
import { SHAPE_CHECKS } from "./flow-model-findings.js";

describe("outputExprFor", () => {
  it("substitutes every occurrence of the placeholder", () => {
    expect(outputExprFor("code", "rank")).toBe("outputs.rank.vars.result");
    expect(outputExprFor("datasource", "fetch")).toBe("json(outputs.fetch.body)");
  });

  /** A gate has no output. Returning `""` here would render as a pickable field. */
  it("an approval step yields nothing to read", () => {
    expect(outputExprFor("approval", "gate")).toBeNull();
  });

  it("every kind is present — a missing entry would silently offer nothing", () => {
    const kinds: StepKind[] = ["datasource", "transform", "code", "tool", "approval"];
    for (const k of kinds) expect(OUTPUT_SHAPES[k]).toBeDefined();
  });
});

describe("checkOutputShapes — the control the prompt could not be", () => {
  /**
   * ⚠ The regression, from a real draft. `llm_complete` FEELS like generation,
   * so the drafter read a `tool` step's output with the `code` step's shape —
   * with the rule stated three ways in `DRAFT_RULES` directly above it. That
   * compiles, deploys, passes every other static check, and dies at execution
   * with ``Unable to find `vars` ``.
   */
  it("catches a tool step read as if it were a code step", () => {
    const f = checkOutputShapes([
      { id: "draft_report", kind: "tool", ref: "llm_complete", paramsExpr: "[{}]" },
      { id: "post", kind: "tool", ref: "chat_post_message", paramsExpr: '[{"text": "{{ outputs.draft_report.vars.result }}"}]' },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("json(outputs.draft_report.body)");
  });

  it("catches a code step read as if it were a transform", () => {
    const f = checkOutputShapes([
      { id: "rank", kind: "code", inputExpr: "{}" },
      { id: "send", kind: "tool", paramsExpr: "{{ json(outputs.rank.value) }}" },
    ]);
    expect(f[0]).toContain("outputs.rank.vars.result");
  });

  /**
   * ⚠ Measured 2026-09-28: `outputs.headcount_csv.vars | jq('… .csv_text …')`
   * read every field as null and the email went out with `attachments: [{}]`.
   * `vars` is the right FIRST segment, so the comparison below it never fired.
   */
  it("catches a code step read one level short, as `.vars` without `.result`", () => {
    const f = checkOutputShapes([
      { id: "headcount_csv", kind: "code", inputExpr: "{}" },
      {
        id: "email_payload",
        kind: "transform",
        expr: "{{ outputs.headcount_csv.vars | jq('[{attachments: [{name: .filename, content: .csv_text}]}]') | first }}",
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("outputs.headcount_csv.vars.result");
  });

  it("THE CONTROL — `.vars.result`, and a non-code step's `.vars`, are not this finding", () => {
    expect(
      checkOutputShapes([
        { id: "rank", kind: "code", inputExpr: "{}" },
        { id: "send", kind: "tool", paramsExpr: "{{ outputs.rank.vars.result | jq('[.]') | first }}" },
      ]),
    ).toEqual([]);
    // `outputs.rank.variables` is a different segment, not a short `.vars`.
    expect(
      checkOutputShapes([
        { id: "rank", kind: "code", inputExpr: "{}" },
        { id: "send", kind: "tool", paramsExpr: "{{ outputs.rank.variables }}" },
      ]).some((x) => x.includes("one level down")),
    ).toBe(false);
  });

  it("a gate produces nothing, and reading it says so", () => {
    const f = checkOutputShapes([
      { id: "gate", kind: "approval", summaryExpr: '"ok?"' },
      { id: "send", kind: "tool", paramsExpr: "{{ json(outputs.gate.body) }}" },
    ]);
    expect(f[0]).toMatch(/produces no output/);
  });

  it("says nothing about correct references", () => {
    expect(
      checkOutputShapes([
        { id: "fetch", kind: "datasource", paramsExpr: "[{}]" },
        { id: "shape", kind: "transform", expr: "{{ json(outputs.fetch.body).results[0].data }}" },
        { id: "rank", kind: "code", inputExpr: "{{ json(outputs.shape.value) }}" },
        { id: "send", kind: "tool", paramsExpr: "{{ outputs.rank.vars.result }}" },
      ]),
    ).toEqual([]);
  });

  /**
   * ⚠ The stated bound. `.body` is right and only the tenant's data knows
   * whether `employees` exists — a check that fired on unknown sub-paths would
   * reject every legitimate `.results[0].data`.
   */
  it("cannot see an invented sub-field, and does not pretend to", () => {
    expect(
      checkOutputShapes([
        { id: "fetch", kind: "datasource", paramsExpr: "[{}]" },
        { id: "sum", kind: "tool", paramsExpr: "{{ json(outputs.fetch.body.employees) }}" },
      ]),
    ).toEqual([]);
  });

  it("ignores a reference to a step it does not know", () => {
    expect(
      checkOutputShapes([{ id: "a", kind: "tool", paramsExpr: "{{ outputs.ghost.vars.result }}" }]),
    ).toEqual([]);
  });
});

describe("checkJsonPositions — a structure in a string position", () => {
  /** ⚠ The measured failure. Kestra's own message names a character offset and nothing else. */
  it("catches a whole output interpolated into a quoted JSON string", () => {
    const f = checkJsonPositions([
      { id: "fetch", kind: "tool", paramsExpr: "[{}]" },
      {
        id: "draft",
        kind: "tool",
        paramsExpr: '[{ "instruction": "Summarise this.", "input": "{{ json(outputs.fetch.body) }}" }]',
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("@json");
  });

  /**
   * ⚠ Measured 2026-09-28: the old pattern paired the CLOSING quote of one key
   * with the OPENING quote of the next, so a correct multi-input code feed —
   * a structure in every value position, none of them quoted — was refused.
   */
  it("says NOTHING about unquoted structures between keys of a multi-key object", () => {
    expect(
      checkJsonPositions([
        {
          id: "days_worked",
          kind: "code",
          inputExpr:
            '{"employees": {{ json(outputs.fetch_employees.body).results[0].data }}, ' +
            '"absences": {{ json(outputs.fetch_absences.body).results[0].data }}, ' +
            '"period": {{ json(outputs.period.value) }}}',
        },
      ]),
    ).toEqual([]);
  });

  it("THE CONTROL — still catches a quoted structure when it is NOT the last key", () => {
    const f = checkJsonPositions([
      {
        id: "draft",
        kind: "tool",
        paramsExpr:
          '[{"input": "{{ json(outputs.fetch.body) }}", "instruction": "x", "other": {{ json(outputs.t.value) }}}]',
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("json(outputs.fetch.body)");
  });

  it("a quote inside a template's jq program never flips the JSON string state", () => {
    expect(
      checkJsonPositions([
        {
          id: "a",
          kind: "tool",
          paramsExpr:
            "{{ json(outputs.f.body).results[0].data | jq('[.[] | {subject: \"x\"}]') | first }}" +
            ' {"n": {{ json(outputs.t.value) }}}',
        },
      ]),
    ).toEqual([]);
  });

  it("catches the code and transform forms too", () => {
    expect(
      checkJsonPositions([{ id: "a", kind: "tool", paramsExpr: '[{"x": "{{ outputs.r.vars.result }}"}]' }]),
    ).toHaveLength(1);
    expect(
      checkJsonPositions([{ id: "a", kind: "tool", paramsExpr: '[{"x": "{{ json(outputs.t.value) }}"}]' }]),
    ).toHaveLength(1);
  });

  /**
   * ⚠ The bound, and the reason the pattern is anchored. A SCALAR plucked out of
   * an output belongs in quotes, and a check that flagged it would fire on
   * almost every correct flow — which is a check people turn off.
   */
  it("says nothing about a scalar read out of an output", () => {
    expect(
      checkJsonPositions([
        { id: "a", kind: "tool", paramsExpr: '[{"to": "{{ json(outputs.f.body).results[0].data[0].email }}"}]' },
        { id: "b", kind: "tool", paramsExpr: '[{"p": "{{ inputs.period }}"}]' },
      ]),
    ).toEqual([]);
  });

  it("says nothing when the structure is in an unquoted position, which is correct", () => {
    expect(
      checkJsonPositions([
        { id: "a", kind: "code", inputExpr: '{"rows": {{ json(outputs.f.body).results[0].data }}}' },
      ]),
    ).toEqual([]);
  });
});

/**
 * ── ⚠ I-115 — the finding was CORRECT and its advice was WRONG ──────────────
 *
 * A real generation (job `d4f13e76`, 2026-08-07, goal *"generate a comprehensive
 * report for employees with less than 80 percent avg attendance for last
 * quarter"*) failed all three attempts against ONE finding, which said:
 *
 *     …its output is `json(outputs.summary_text.body)`. Use that exactly.
 *
 * The step was `llm_complete`, whose own catalogue description — which the
 * drafter also reads — says *"it returns `{text}`"*. So the model wanted the
 * text, and was told to write the envelope **and nothing more**. The correct
 * expression was `json(outputs.summary_text.body).text`, which this check has
 * always accepted; the advice steered away from the one answer that would have
 * passed.
 *
 * Two true statements the prompt never joined: *the tool returns `{text}`* and
 * *a tool's output is reached through `.body`*.
 */
describe("I-115 — the finding has to be actionable, not merely correct", () => {
  const shape = (steps: Array<Record<string, unknown>>) => checkOutputShapes(steps);

  it("tells a TOOL field guess where the field actually lives", () => {
    const [f] = shape([
      { id: "summary_text", kind: "tool" },
      { id: "report_channel", kind: "tool", paramsExpr: "{{ outputs.summary_text.text }}" },
    ]);
    /**
     * ⚠ **This assertion was WRONG for an hour and passed anyway.**
     *
     * It read `toContain("json(outputs.summary_text.body).text")`, which was
     * the advice I-115 shipped — and that advice was also wrong: a tool's
     * `{text}` is not at the top of the body, it is at `.results[0].data.text`
     * (I-117, found by a real run failing at execution). When the advice was
     * corrected, this assertion kept passing because the new message contains
     * the same string inside the clause *"never
     * `json(outputs.summary_text.body).text`"*.
     *
     * A test that passes on the NEGATION of what it means to assert is worse
     * than no test. It now checks the full corrected path.
     */
    expect(f).toContain("json(outputs.summary_text.body).results[0].data.text");
    // ⚠ And the old advice is gone: "use that exactly" over an envelope-only
    // expression is what cost three attempts.
    expect(f).not.toContain("Use that exactly");
  });

  it("⚠ REJECTS the answer I-115 wrongly recommended", () => {
    // `.text` at the top of a body was I-115's advice and it was a second wrong
    // answer — the body is Foundry's envelope, not the call's payload. The
    // control that would have caught it did not exist until I-117.
    const [f] = shape([
      { id: "summary_text", kind: "tool" },
      { id: "r", kind: "tool", paramsExpr: "{{ json(outputs.summary_text.body).text }}" },
    ]);
    expect(f).toContain("there is no `.text` there");
  });

  it("accepts the answer it now recommends", () => {
    // The control. If the check rejected its own advice, the redraft loop would
    // be unwinnable — which is what "correct finding, three failures" looks like
    // from the inside.
    expect(
      shape([
        { id: "summary_text", kind: "tool" },
        { id: "r", kind: "tool", paramsExpr: "{{ json(outputs.summary_text.body).results[0].data.text }}" },
      ]),
    ).toEqual([]);
  });

  it("⚠ does NOT relocate an invented field on a datasource", () => {
    // A named query's envelope is fixed — rows are always `.results[0].data` —
    // so `json(outputs.fetch.body).employees` is the same fabrication one level
    // deeper. The first version of the fix produced exactly that, and it was
    // caught by running the four cases rather than by reading them.
    const [f] = shape([
      { id: "fetch", kind: "datasource" },
      { id: "t", kind: "transform", expr: "{{ outputs.fetch.employees }}" },
    ]);
    expect(f).not.toContain("body).employees");
    expect(f).toContain("results[0].data");
  });

  it("offers no rewrite when the guess was another KIND's envelope", () => {
    // `.vars` on a tool step is the code-step shape. There is no field to
    // relocate, and `json(outputs.d.body).vars` is not a thing.
    const [f] = shape([
      { id: "d", kind: "tool" },
      { id: "s", kind: "tool", paramsExpr: "{{ outputs.d.vars.result }}" },
    ]);
    expect(f).not.toContain("body).vars");
    expect(f).toContain("different step kind's shape");
  });

  it("keeps I-44's spelling correction intact", () => {
    const [f] = shape([
      { id: "rank", kind: "code" },
      { id: "s", kind: "tool", paramsExpr: "{{ outputs.rank.value }}" },
    ]);
    expect(f).toContain("outputs.rank.vars.result");
  });
});

/**
 * ── ⚠ I-117 — the body is FOUNDRY's envelope, and that is statically knowable ─
 *
 * Found by a real run: `json(outputs.fetch_attendance.body).employees` compiled,
 * deployed, and failed at execution with ``Unable to find `employees` `` —
 * **an expression `DRAFT_RULES` warns against by name.** A prompt rule the model
 * can ignore is not a control; this is the control.
 *
 * The check that existed said of its own bound: *"an invented response field is
 * not detectable here — only the tenant's data says whether `employees` exists."*
 * That was false. `POST /api/steps/{tool,datasource}` answers `StepBatchResult`
 * — `{results, succeeded, failed, warnings, readFrom?}` — and the tenant's data
 * is always at `.results[i].data`. Nothing about the tenant is needed.
 */
describe("I-117 — an invented key at the top of a step body", () => {
  const shape = (steps: Array<Record<string, unknown>>) => checkOutputShapes(steps);

  it("catches the real run failure", () => {
    const [f] = shape([
      { id: "fetch_attendance", kind: "datasource" },
      { id: "summary_text", kind: "tool", paramsExpr: '[{ "input": {{ json(outputs.fetch_attendance.body).employees }} }]' },
    ]);
    expect(f).toContain("there is no `.employees` there");
    expect(f).toContain("json(outputs.fetch_attendance.body).results[0].data");
    // The runtime error it prevents, quoted so the connection is legible to
    // whoever sees the finding and then greps the logs.
    expect(f).toContain("Unable to find `employees`");
  });

  it("accepts every key the envelope really has", () => {
    // ⚠ The other half. A check that rejected `succeeded` or `warnings` would be
    // I-57 again: a validator wrong about correct expressions, fed to a redraft.
    for (const key of ["results", "succeeded", "failed", "warnings", "readFrom"]) {
      expect(shape([
        { id: "s", kind: "tool" },
        { id: "p", kind: "tool", paramsExpr: `{{ json(outputs.s.body).${key} }}` },
      ])).toEqual([]);
    }
  });

  it("accepts a whole-body read", () => {
    expect(shape([
      { id: "s", kind: "tool" },
      { id: "p", kind: "tool", paramsExpr: "{{ json(outputs.s.body) }}" },
    ])).toEqual([]);
  });

  it("says nothing about a step whose kind it does not know", () => {
    // An unknown target is `validateModel`'s problem. Guessing here would make
    // two checks disagree about the same step.
    expect(shape([
      { id: "p", kind: "tool", paramsExpr: "{{ json(outputs.mystery.body).whatever }}" },
    ])).toEqual([]);
  });
});

/**
 * ⚠ **I-119 — the green failure.** A real run: 11 employees fetched, every step
 * succeeded, and the report said there was no data. The `input` expression read
 * the upstream step and then emitted a sentence describing it.
 *
 * These tests are a PAIR and neither is optional. Rejecting the instruction form
 * is worthless if the legitimate forms go with it — `llm_complete` as a leaf is
 * how the Finance digest works, and a check that broke it would be reverted
 * within the day. The bound is a heuristic (see MIN_INSTRUCTION_LITERAL), so the
 * accepted side is where a widening would show up.
 */
describe("I-119 — an llm_complete `input` that describes the data instead of carrying it", () => {
  const step = (paramsExpr: string) => [{ id: "report", kind: "tool", ref: "llm_complete", paramsExpr }];

  it("rejects the literal instruction that produced a green run with no data", () => {
    const real =
      `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('("Generate a concise report ` +
      `for employees with less than 80 percent attendance for period " + .period + ". Include ` +
      `the evaluated count, below-threshold count, and a short bullet list of affected ` +
      `employees with attendance_rate and min_attendance_rate. Use plain English.") | @json') ` +
      `| first }},"instruction":"Write a concise report."}]`;
    const findings = checkTextToolInput(step(real));
    expect(findings).toHaveLength(1);
    // Asserted on the ADVICE — the finding goes into the redraft prompt, and a
    // correct diagnosis the model cannot act on is I-115's whole lesson.
    expect(findings[0]).toContain("tostring | @json");
    expect(findings[0]).toContain("instruction");
  });

  /**
   * ⚠ Renamed 2026-08-20. This used to be called *"the form the fix teaches"*,
   * and it is no longer that form — `checkBulkToolInput` refuses it, because it
   * is unbounded (execution `05aca859`). What this test asserts is unchanged and
   * still required: **this check** stays silent on it. The corridor both checks
   * leave open is asserted together in the block at the end of this file.
   */
  it("stays silent on the whole upstream value serialised — checkBulkToolInput's case, not this one", () => {
    expect(
      checkTextToolInput(
        step(`[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }},"instruction":"Summarise."}]`),
      ),
    ).toEqual([]);
  });

  it("accepts a projection that is then serialised", () => {
    expect(
      checkTextToolInput(
        step(
          `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('[.employees[] | {n: .full_name, r: .attendance_rate}] | tostring | @json') | first }},"instruction":"Summarise."}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("accepts a LABEL in front of the data — the case the length bound exists to spare", () => {
    expect(
      checkTextToolInput(
        step(
          `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('("Attendance report for " + .period + ": " + tostring) | @json') | first }},"instruction":"Summarise."}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("does not police mail_send's body, which legitimately IS assembled prose", () => {
    expect(
      checkTextToolInput([
        {
          id: "mail",
          kind: "tool",
          ref: "mail_send",
          paramsExpr: `[{"input":{{ json(outputs.x.body).results[0].data | jq('("Dear colleague, your attendance for this period is below the threshold your department has set. Please speak to your manager.") | @json') | first }}}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("does not fire on a short literal with no data — that is a different mistake", () => {
    expect(
      checkTextToolInput(
        step(`[{"input":{{ json(outputs.fetch.body).results[0].data | jq('("No rows") | @json') | first }},"instruction":"Summarise."}]`),
      ),
    ).toEqual([]);
  });
});

describe("checkPluckedThenJq — a leaf selected in Pebble and then piped into jq", () => {
  /** Local, because the I-119 block's helper is scoped to that block. */
  const step = (paramsExpr: string, id = "send_email") => [
    { id, kind: "tool", ref: "tether_email_send", paramsExpr },
  ];

  /**
   * ── The failure, measured on a real run ────────────────────────────────────
   *
   * Execution `e097b55b` (2026-08-18), the first real use of `tether_email_send`.
   * The drafter wrote, for the tool's `body` parameter:
   *
   *   {{ json(outputs.report_text.body).results[0].data.text | jq('tostring | @json') | first }}
   *
   * `results[0].data` is an object; `.data.text` is the LLM's report — a plain
   * String. Kestra's `jq` filter parses its input AS JSON, so handed a raw
   * multi-line String it throws:
   *
   *   PebbleException: Unable to parse jq value 'Attendance report for 2026-06 …'
   *   with type 'java.lang.String'
   *
   * The step never made an HTTP request at all — `responseCode: null`. So the
   * failure is not visible as a tool problem, the message names no step and no
   * parameter, and nothing had flagged the model. The flow's PREVIOUS step uses
   * the identical idiom and works, because there the value is still an object —
   * which is exactly why this is hard to see by reading.
   *
   * ⚠ Why this is not covered by `checkJsonPositions`: that check is
   * deliberately narrow about the opposite case — a WHOLE output read inside
   * quotes. Its docblock states "a scalar plucked out of one belongs in quotes
   * and must not be reported". This is the inverse: a plucked leaf, unquoted,
   * piped into jq.
   *
   * ⚠ The fix the finding teaches is to move the selection INSIDE jq, so jq
   * receives the JSON-parseable object:
   *
   *   {{ json(outputs.report_text.body).results[0].data | jq('.text | @json') | first }}
   *
   * That advice is correct whether the leaf turns out to be a scalar or a
   * structure, which is what lets this check be a static one at all.
   */
  it("flags the exact expression that failed execution e097b55b", () => {
    const findings = checkPluckedThenJq(
      step(
        `[{"body":{{ json(outputs.report_text.body).results[0].data.text | jq('tostring | @json') | first }},"subject":"Report"}]`,
      ),
    );
    expect(findings).toHaveLength(1);
    // Asserted on the ADVICE, not just the diagnosis — the finding goes into the
    // redraft prompt, and a correct diagnosis the model cannot act on is I-115's
    // whole lesson.
    expect(findings[0]).toContain("send_email");
    expect(findings[0]).toContain(".text");
    expect(findings[0]).toContain("jq('.text | @json')");
  });

  it("names the field so the advice is specific to what was plucked", () => {
    const findings = checkPluckedThenJq(
      step(
        `[{"input":{{ json(outputs.a.body).results[0].data.summary | jq('tostring | @json') | first }}}]`,
      ),
    );
    expect(findings[0]).toContain("jq('.summary | @json')");
  });

  it("accepts the whole `data` piped into jq — the working form", () => {
    // The idiom the prompt teaches, and the one the step ABOVE the broken one used.
    expect(
      checkPluckedThenJq(
        step(
          `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("accepts a selection already made inside jq", () => {
    expect(
      checkPluckedThenJq(
        step(
          `[{"body":{{ json(outputs.report_text.body).results[0].data | jq('.text | @json') | first }}}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("accepts a plucked scalar in QUOTES, which needs no jq at all", () => {
    // ⚠ The false positive worth avoiding: a leaf in a quoted position is the
    // correct, documented form and `checkJsonPositions` explicitly permits it.
    expect(
      checkPluckedThenJq(
        step(`[{"to":["{{ json(outputs.a.body).results[0].data[0].email }}"]}]`),
      ),
    ).toEqual([]);
  });

  it("accepts a projection built inside jq from the whole value", () => {
    expect(
      checkPluckedThenJq(
        step(
          `[{"input":{{ json(outputs.f.body).results[0].data | jq('[.employees[] | {n: .full_name}] | tostring | @json') | first }}}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("flags a deep pluck too, not only a single field", () => {
    const findings = checkPluckedThenJq(
      step(
        `[{"input":{{ json(outputs.a.body).results[0].data.report.text | jq('tostring | @json') | first }}}]`,
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("jq('.report.text | @json')");
  });

  it("is in SHAPE_CHECKS, so refine and generate both run it", () => {
    // ⚠ I-119's lesson: a check that exists but is not wired into the redraft
    // path enforces nothing. `flow-refine.service.ts` records the time three of
    // these were missing from refine and were therefore enforced on a generated
    // model but not on an edited one.
    expect(SHAPE_CHECKS.map((c) => c.name)).toContain("checkPluckedThenJq");
  });
});
describe("checkTextValueThenJq — a TEXT .value piped straight into jq", () => {
  const step = (paramsExpr: string, id = "send_email") => [
    { id, kind: "tool", ref: "tether_email_send", paramsExpr },
  ];

  it("flags the QUOTED blind spot: text piped into jq('@json')", () => {
    // `checkPluckedThenJq` reads unquoted positions only, so this exact shape —
    // the documented form for a scalar, with a pipe into jq — passed every
    // check. Quoted decides the JSON around the value; jq chokes on its input.
    const findings = checkTextValueThenJq(
      step(`[{"text":"{{ outputs.rows_step.value | jq('@json') | first }}"}]`),
    );
    expect(findings).toHaveLength(1);
    expect(checkPluckedThenJq(step(`[{"text":"{{ outputs.rows_step.value | jq('@json') | first }}"}]`))).toEqual([]);
    expect(findings[0]).toContain("send_email");
    expect(findings[0]).toContain(`"text"`);
    expect(findings[0]).toContain("Unable to parse jq value");
  });

  it("flags every encoder spelling, quoted or bare", () => {
    for (const program of ["@json", "tostring", "tojson", "tostring | @json"]) {
      expect(
        checkTextValueThenJq(step(`[{"text":"{{ outputs.a.value | jq('${program}') | first }}"}]`)),
        program,
      ).toHaveLength(1);
    }
    expect(
      checkTextValueThenJq(step(`[{"text":{{ outputs.a.value | jq('tostring') | first }}}]`)),
    ).toHaveLength(1);
  });

  it("accepts a .value jq that descends — the sanctioned filter form", () => {
    expect(
      checkTextValueThenJq(step(`[{"rows":{{ outputs.rows_step.value | jq('[.[] | select(.rate < 80)]') | first }}}]`)),
    ).toEqual([]);
  });

  it("accepts a non-.value jq — the whole-payload form other checks own", () => {
    expect(
      checkTextValueThenJq(
        step(`[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}}]`),
      ),
    ).toEqual([]);
  });

  it("fires for non-tool kinds too — the data, not the kind, is opaque", () => {
    expect(
      checkTextValueThenJq([
        { id: "q", kind: "datasource", ref: "d.q", paramsExpr: `[{"q":"{{ outputs.rows_step.value | jq('tostring') | first }}"}]` },
      ]),
    ).toHaveLength(1);
  });

  it("stays silent when the encoder word is only inside a string literal", () => {
    expect(
      checkTextValueThenJq(step(`[{"rows":{{ outputs.rows_step.value | jq('[.[] | {note: "tostring"}]') | first }}}]`)),
    ).toEqual([]);
  });

  it("is in SHAPE_CHECKS, so refine and generate both run it", () => {
    expect(SHAPE_CHECKS.map((c) => c.name)).toContain("checkTextValueThenJq");
  });
});

describe("checkFreeTextInQuotes — an LLM's prose interpolated into a quoted JSON string", () => {
  /**
   * ── The failure, measured on a real run ────────────────────────────────────
   *
   * Execution `fa04cfc3` (2026-08-18) — the SECOND draft of the same automation,
   * generated after `checkPluckedThenJq` and its prompt rule had shipped. The
   * drafter avoided the shape that rule forbids and took the adjacent one:
   *
   *   "body":"{{ json(outputs.report.body).results[0].data.text }}"
   *
   * The leaf is plucked in Pebble and placed INSIDE quotes with no encoding. The
   * value is the model's report, which contains newlines, so Kestra threw:
   *
   *   JsonParseException: Illegal unquoted character ((CTRL-CHAR, code 10)):
   *   has to be escaped using backslash to be included in string value
   *
   * ⚠ Again `request: null` — the step never made a call, so nothing reported an
   * email problem and no `email_sends` row existed.
   *
   * ── Why nothing caught it ─────────────────────────────────────────────────
   *
   * This is the form `checkJsonPositions` **deliberately permits**: its docblock
   * states "a scalar plucked out of one belongs in quotes and must not be
   * reported". That is true of an address, a date or a count — and false of model
   * prose, which is the one leaf that is certain to contain newlines.
   * `checkPluckedThenJq` skips quoted positions for the same reason.
   *
   * So the blind spot was shared by both checks, and it is narrow: not "a plucked
   * scalar in quotes", but "a FREE-TEXT leaf in quotes".
   *
   * ── The fix it teaches ────────────────────────────────────────────────────
   *
   *   "body":{{ json(outputs.report.body).results[0].data | jq('.text | @json') | first }}
   *
   * Unquoted, because `@json` supplies the quotes AND escapes the newlines. Same
   * destination as `checkPluckedThenJq`'s advice, reached from the other side.
   */
  const twoStep = (sendExpr: string) => [
    { id: "report", kind: "tool", ref: "llm_complete", paramsExpr: `[{"input":"x"}]` },
    { id: "send", kind: "tool", ref: "tether_email_send", paramsExpr: sendExpr },
  ];

  it("flags the exact expression that failed execution fa04cfc3", () => {
    const findings = checkFreeTextInQuotes(
      twoStep(`[{"body":"{{ json(outputs.report.body).results[0].data.text }}","subject":"Report"}]`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("send");
    // Asserted on the ADVICE — a finding the model cannot act on is I-115's lesson.
    expect(findings[0]).toContain("jq('.text | @json')");
    expect(findings[0]).toContain("newline");
  });

  it("accepts the encoded, unquoted form — the fix", () => {
    expect(
      checkFreeTextInQuotes(
        twoStep(
          `[{"body":{{ json(outputs.report.body).results[0].data | jq('.text | @json') | first }}}]`,
        ),
      ),
    ).toEqual([]);
  });

  it("stays silent on a single-line scalar in quotes — the form checkJsonPositions permits", () => {
    // ⚠ The false positive that would get this check reverted. An address, a
    // period, a count all belong in quotes and this must not report them.
    expect(
      checkFreeTextInQuotes([
        { id: "fetch", kind: "datasource", ref: "hr.attendance", paramsExpr: `[{"period":"2026-06"}]` },
        {
          id: "send",
          kind: "tool",
          ref: "tether_email_send",
          paramsExpr: `[{"to":["{{ json(outputs.fetch.body).results[0].data[0].email }}"],"subject":"Hi"}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("stays silent on an llm_complete leaf that is not free text", () => {
    // `.model` and `.finish_reason` are single-line identifiers. Flagging them
    // would make the check about llm_complete rather than about newlines.
    expect(
      checkFreeTextInQuotes(
        twoStep(`[{"subject":"Model {{ json(outputs.report.body).results[0].data.model }}"}]`),
      ),
    ).toEqual([]);
  });

  it("only fires when the SOURCE step is an llm_complete", () => {
    // The same leaf name off a datasource step is not model prose.
    expect(
      checkFreeTextInQuotes([
        { id: "q", kind: "datasource", ref: "hr.notes", paramsExpr: `[{}]` },
        {
          id: "send",
          kind: "tool",
          ref: "tether_email_send",
          paramsExpr: `[{"body":"{{ json(outputs.q.body).results[0].data.text }}"}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("says nothing when the source step is unknown", () => {
    // An unknown ref is `validateModel`'s problem. Guessing here would make two
    // checks disagree about the same step.
    expect(
      checkFreeTextInQuotes([
        {
          id: "send",
          kind: "tool",
          ref: "tether_email_send",
          paramsExpr: `[{"body":"{{ json(outputs.mystery.body).results[0].data.text }}"}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("is in SHAPE_CHECKS, so refine and generate both run it", () => {
    expect(SHAPE_CHECKS.map((c) => c.name)).toContain("checkFreeTextInQuotes");
  });
});

describe("checkEncodedInQuotes — an already-@json-encoded value in a quoted position", () => {
  /**
   * ── The failure, measured on a real run ────────────────────────────────────
   *
   * Execution `a6488641` (2026-08-19), the `report` step of a three-step attendance
   * automation. The drafter wrote, for `llm_complete`'s `input`:
   *
   *   "input":"{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}"
   *
   * ⚠ That is `DRAFT_RULES`' OWN prescribed expression with the quotes left on.
   * `@json` supplies its own quotes, so the rendered body opened:
   *
   *   "input":""{\"period\":\"2026-06\",\"counts\":{…
   *            ↑↑ an empty string, closed — and the object starts where a comma must go
   *
   * `POST /api/steps/tool` answered **400**, correctly. Reproduced byte-for-byte
   * against that run's own `fetch` output: invalid at **line 6, column 17**, which is
   * exactly the position Kestra's Jackson error named.
   *
   * ⚠ **And Foundry's message never reached the log.** Kestra re-parses the REQUEST
   * body to attach it to the failure exception, so it threw on the malformed JSON a
   * second time and printed a `JsonParseException` stack trace over the top of the
   * 400. The trace names no step, no parameter and no reason — see the docblock on
   * `checkEncodedInQuotes` for the call chain.
   *
   * ── Why all five other checks passed it ───────────────────────────────────
   *
   * Five different reasons, each individually correct — the module docblock lists
   * them. The tests below pin the two that are easiest to break by "widening" a
   * neighbouring check: the encoded-and-UNQUOTED form must stay silent (it is the
   * fix), and a plain scalar in quotes must stay silent (it is the common case).
   */
  const twoStep = (reportExpr: string) => [
    {
      id: "fetch",
      kind: "tool",
      ref: "hr_attendance_summary",
      paramsExpr: `[{"period":"{{ inputs.period }}"}]`,
    },
    { id: "report", kind: "tool", ref: "llm_complete", dependsOn: ["fetch"], paramsExpr: reportExpr },
  ];

  /** The expression as it shipped, minus the surrounding quotes. */
  const ENCODED = `{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}`;

  it("flags the exact expression that failed execution a6488641", () => {
    const findings = checkEncodedInQuotes(
      twoStep(`[{"input":"${ENCODED}","instruction":"Write a concise attendance report."}]`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("report");
    // Names the parameter, so the finding points at a field on screen.
    expect(findings[0]).toContain(`"input"`);
    // Asserted on the ADVICE — I-115's lesson. The corrected expression is quoted
    // back verbatim, so a redraft can act on it without re-deriving anything.
    expect(findings[0]).toContain(`"input": ${ENCODED}`);
    expect(findings[0]).toContain("@json");
  });

  it("accepts the same expression unquoted — the fix, and it must never be flagged", () => {
    // ⚠ The false positive that would revert this check. This is the form
    // `DRAFT_RULES` prescribes and `checkPluckedThenJq`'s fixture already uses.
    expect(
      checkEncodedInQuotes(
        twoStep(`[{"input":${ENCODED},"instruction":"Write a concise attendance report."}]`),
      ),
    ).toEqual([]);
  });

  it("stays silent on a plain scalar in quotes — the form checkJsonPositions permits", () => {
    // A period, an address, a count. Flagging these would make the check about
    // quotes rather than about double-encoding.
    expect(
      checkEncodedInQuotes([
        {
          id: "send",
          kind: "tool",
          ref: "mail_send",
          paramsExpr:
            `[{"to":"{{ json(outputs.fetch.body).results[0].data[0].email }}",` +
            `"period":"{{ inputs.period }}"}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("stays silent when the jq program does not END in @json", () => {
    // `jq('length')` yields a number and `jq('map(@json) | join(","))` yields a
    // plain string — neither carries quotes, so both belong in a quoted position.
    // Only the encoder that runs LAST decides the shape.
    expect(
      checkEncodedInQuotes(
        twoStep(`[{"n":"{{ json(outputs.fetch.body).results[0].data | jq('length') | first }}"}]`),
      ),
    ).toEqual([]);
    expect(
      checkEncodedInQuotes(
        twoStep(`[{"n":"{{ outputs.fetch.value | jq('map(@json) | join(",")') | first }}"}]`),
      ),
    ).toEqual([]);
  });

  it("finds the encoder through a jq program that builds an object — I-57", () => {
    // A jq program supplying its own braces is why the span comes from
    // `templateSpans` and not from a regex here. A non-greedy `}}` match would read
    // a truncated program and measure the wrong final filter, so this would go
    // silent on the shape it exists to catch.
    const findings = checkEncodedInQuotes(
      twoStep(`[{"row":"{{ outputs.fetch.value | jq('{period: .p, n: .c} | @json') | first }}"}]`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`"row"`);
  });

  it("reports once per distinct expression, and once per field that carries it", () => {
    // Two different parameters double-encoding is two things to fix.
    const findings = checkEncodedInQuotes(
      twoStep(
        `[{"input":"${ENCODED}","context":"{{ outputs.fetch.value | jq('. | @json') | first }}"}]`,
      ),
    );
    expect(findings).toHaveLength(2);
  });

  it("⚠ THE CONTROL — the five older checks all pass the expression that failed", () => {
    // This is the whole reason the check exists, and it is asserted rather than
    // stated: if a later widening of any of them starts covering this shape, the
    // duplication should be a deliberate decision, not a discovery.
    const steps = twoStep(
      `[{"input":"${ENCODED}","instruction":"Write a concise attendance report."}]`,
    );
    expect(checkJsonPositions(steps)).toEqual([]);
    expect(checkPluckedThenJq(steps)).toEqual([]);
    expect(checkFreeTextInQuotes(steps)).toEqual([]);
    expect(checkTextToolInput(steps)).toEqual([]);
    expect(checkOutputShapes(steps as never)).toEqual([]);
    // The 2026-08-20 addition passes it too, and for a reason worth pinning: the
    // expression here sits INSIDE quotes, so the `"input":` span test fails and
    // the bulk check never looks at the program. The quoted form belongs to
    // `checkEncodedInQuotes` alone.
    expect(checkBulkToolInput(steps)).toEqual([]);
    // …and this one does not.
    expect(checkEncodedInQuotes(steps)).toHaveLength(1);
  });

  it("is in SHAPE_CHECKS, so refine and generate both run it", () => {
    // I-119 is the record of three of these being enforced on a generated model and
    // not on an edited one.
    expect(SHAPE_CHECKS.map((c) => c.name)).toContain("checkEncodedInQuotes");
  });
});

/**
 * ⚠ **THE CORRIDOR — `step-payload-bounds` contract §4, asserted from BOTH sides.**
 *
 * `checkTextToolInput` (I-119) refuses an `input` that describes the data in a
 * sentence. `checkBulkToolInput` refuses an `input` that carries the whole
 * unbounded response. Each is correct alone; together they can close onto each
 * other, and then there is **no expression a drafter can write** — every draft
 * gets a finding, every redraft trades one for the other, and the loop is
 * invisible from either check's own test file because both pass.
 *
 * So the four rows are asserted TOGETHER, from both functions, in one place. Row
 * 3 is the contract: projected AND serialised must be silent from both. A future
 * edit that makes it fire reads here as breaking the corridor rather than as an
 * odd expectation somewhere.
 */
describe("the I-119 / 05aca859 corridor — both checks, four rows, one table", () => {
  const report = (paramsExpr: string) => [
    { id: "report", kind: "tool", ref: "llm_complete", paramsExpr },
  ];
  /** `input` bound to `fetch`'s response through the given jq program. */
  const input = (program: string, path = "") =>
    report(
      `[{"input":{{ json(outputs.fetch.body).results[0].data${path} | jq('${program}') | first }},` +
        `"instruction":"Write a concise report."}]`,
    );

  /** Row 1 — the literal expression that produced the green run with no data. */
  const SENTENCE =
    `("Generate a concise report for employees with less than 80 percent attendance for ` +
    `period " + .period + ". Include the evaluated count, below-threshold count, and a short ` +
    `bullet list of affected employees with attendance_rate and min_attendance_rate. Use ` +
    `plain English.") | @json`;

  it("row 1 — a sentence with no serialisation: TEXT fires, BULK silent", () => {
    const steps = input(SENTENCE);
    expect(checkTextToolInput(steps)).toHaveLength(1);
    expect(checkBulkToolInput(steps)).toEqual([]);
  });

  it("row 2 — the whole payload serialised (execution 05aca859): BULK fires, TEXT silent", () => {
    const steps = input("tostring | @json");
    expect(checkBulkToolInput(steps)).toHaveLength(1);
    expect(checkTextToolInput(steps)).toEqual([]);
  });

  /**
   * ⚠ **ROW 3 IS THE CONTRACT.** This is the expression the drafter is supposed
   * to arrive at. If either side ever reports it, the corridor is closed and the
   * fix is to widen the reducing set — not to decide which finding matters more.
   */
  it("row 3 — projected AND serialised: BOTH SILENT (the corridor)", () => {
    const steps = input("map({name, rate}) | tostring | @json");
    expect(checkBulkToolInput(steps)).toEqual([]);
    expect(checkTextToolInput(steps)).toEqual([]);
  });

  it("row 4 — a leaf plucked then piped into jq: both silent, checkPluckedThenJq's case", () => {
    const steps = input("tostring | @json", ".text");
    expect(checkBulkToolInput(steps)).toEqual([]);
    expect(checkTextToolInput(steps)).toEqual([]);
    // Asserted positively so the row is not silent from ALL THREE — a shape no
    // check covers is how this family of bugs got to four members.
    expect(checkPluckedThenJq(steps)).toHaveLength(1);
  });
});

describe("checkBulkToolInput — what counts as having reduced the data", () => {
  const input = (program: string, source = "json(outputs.fetch.body).results[0].data") =>
    [
      {
        id: "report",
        kind: "tool",
        ref: "llm_complete",
        paramsExpr: `[{"input":{{ ${source} | jq('${program}') | first }},"instruction":"Report."}]`,
      },
    ];

  it("a slice is a reduction — `.[0:50]`", () => {
    expect(checkBulkToolInput(input(".[0:50] | tostring | @json"))).toEqual([]);
  });

  it("an index is a reduction — `.[0]`", () => {
    expect(checkBulkToolInput(input(".[0] | tostring | @json"))).toEqual([]);
  });

  it("`first(` inside the program is a reduction", () => {
    expect(checkBulkToolInput(input("first(.employees[]) | tostring | @json"))).toEqual([]);
  });

  it("an aggregate is a reduction — `length`", () => {
    expect(checkBulkToolInput(input(".employees | length | tostring | @json"))).toEqual([]);
  });

  /**
   * ⚠ The one that would silence the check everywhere. Every correct expression
   * in this repo ends `| first` — Kestra's unwrap of the single-element list jq
   * returns. It is OUTSIDE `jq(…)`, and reading it as a reduction would make this
   * a control that cannot fail (I-38).
   */
  it("the trailing Pebble `| first` is NOT a reduction — it is the engine's unwrap", () => {
    // Row 2 above ends in `| first` and fires. Asserted again here as the reason.
    expect(checkBulkToolInput(input("tostring | @json"))).toHaveLength(1);
  });

  it("sorting is not reducing — the same 4,722 rows in a different order", () => {
    expect(checkBulkToolInput(input("sort_by(.name) | tostring | @json"))).toHaveLength(1);
  });

  it("`tojson` counts as serialising, like `tostring`", () => {
    expect(checkBulkToolInput(input("tojson | @json"))).toHaveLength(1);
  });

  it("a query or datasource envelope is the same failure and fires too", () => {
    // `.results[0].data` is the envelope for `tool`, `datasource` AND `query`
    // alike, and a table is no more bounded than an endpoint.
    expect(
      checkBulkToolInput(input("tostring | @json", "json(outputs.rows.body).results[0].data")),
    ).toHaveLength(1);
  });

  /**
   * ⚠ **THE REMEDY MUST NOT BE REFUSED.** The finding says "add a `transform` or
   * a `code` step and pass its output to `input`" — which produces exactly these
   * two expressions. If either fires, the second draft is the first draft plus a
   * step and the same complaint, and the check is worse than useless.
   */
  it("a `transform` step's output serialised whole is SILENT — it is the remedy", () => {
    expect(
      checkBulkToolInput(input("tostring | @json", "json(outputs.reduce.value)")),
    ).toEqual([]);
  });

  it("a `code` step's output serialised whole is SILENT — it is the other remedy", () => {
    expect(
      checkBulkToolInput([
        {
          id: "report",
          kind: "tool",
          ref: "llm_complete",
          paramsExpr:
            `[{"input":{{ outputs.aggregate.vars.result | jq('tostring | @json') | first }},` +
            `"instruction":"Report."}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("does not police a tool that is not llm_complete", () => {
    // Only `input` has a published ceiling (plan Decision 5). Every other
    // parameter is bounded by whatever the endpoint accepts, which nothing here
    // knows — firing there would report correct flows.
    expect(
      checkBulkToolInput([
        {
          id: "send",
          kind: "tool",
          ref: "mail_send",
          paramsExpr: `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}}]`,
        },
      ]),
    ).toEqual([]);
  });

  it("does not police another parameter of llm_complete", () => {
    expect(
      checkBulkToolInput([
        {
          id: "report",
          kind: "tool",
          ref: "llm_complete",
          paramsExpr: `[{"input":"x","context":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}}]`,
        },
      ]),
    ).toEqual([]);
  });

  /**
   * The finding IS the control — it goes into the redraft prompt, and a correct
   * diagnosis a model cannot act on is I-115's lesson. Plan Decision 9 requires
   * both remedies with the rule for choosing, because a model that only knows
   * `transform` and needs a total reaches for a bigger `input` instead.
   */
  it("the finding names both remedies, the ceiling, and the run — and never chunking", () => {
    const [finding] = checkBulkToolInput(input("tostring | @json"));
    expect(finding).toContain("transform");
    expect(finding).toContain("code");
    expect(finding).toContain("32,000");
    expect(finding).toContain("05aca859");
    expect(finding).toContain("fetch");
    // ⚠ D-34: chunk-and-summarise makes `llm_complete` output load-bearing, and
    // costs ~236 calls for the measured payload. It must never be offered.
    expect(finding).not.toMatch(/chunk|batch|split|in pieces/i);
  });

  it("is in SHAPE_CHECKS, so refine runs it too — not just generation", () => {
    // I-119 is the record of three of these being enforced on a generated model
    // and not on an edited one.
    expect(SHAPE_CHECKS.map((c) => c.name)).toContain("checkBulkToolInput");
  });
});
