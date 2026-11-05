import { describe, it, expect } from "vitest";
import { BUILD_GOALS, type BuildGoal } from "./build-goals.js";
import { classify, findingText, matchShape, verdictOf, FAILURE_CLASSES } from "./build-classify.js";

/**
 * Every message below is a REAL one, copied from the 2026-09-23 baseline
 * (`plans/phased-typed-build-2026-09-23/phase-0-baseline/raw/`). A classifier
 * tested on invented text is tested on what its author expected to see.
 */
describe("classify — real messages land in their fixed class", () => {
  const cases: Array<[string, string]> = [
    ["serialization", "step \"send_email\".paramsExpr puts `{{ json(outputs.email_recipients.value) }}` inside a quoted JSON string."],
    ["serialization", "step \"post_summary\".paramsExpr: a `{{` is never closed — either a `}}` is missing"],
    ["serialization", "io.pebbletemplates.pebble.error.PebbleException: Unable to parse jq value '[{to=[m@x.example]}]'"],
    ["serialization", "com.fasterxml.jackson.core.JsonParseException: Unexpected character ('H' (code 72))"],
    ["serialization", "step \"send_email\".paramsExpr: an unexpected `]` in the literal (non-templated) text"],
    ["component", "step \"fetch_weekly_rates\" references \"hr_demo.weekly_attendance_rates\" — \"hr_demo\" IS a datasource in this workspace, but it has no readable component named"],
    ["io_shape", "step \"reminders\".expr reads `outputs.fetch_attendance.value`, but \"fetch_attendance\" is a `tool` step and its output is reached through `json(outputs.fetch_attendance.body)`"],
    ["io_shape", "period must be YYYY-MM, got \"2026-06-01\""],
    ["io_shape", "{\"fieldErrors\":{\"to\":[\"Expected string, received null\"]}}"],
    ["io_shape", "sender is required"],
    ["generated_sql", "relation \"public.user\" does not exist"],
    ["generated_sql", "column \"firstname\" does not exist"],
    ["generated_sql", "mock engine query failed: could not determine data type of parameter $1"],
    ["environment", "{\"error\":\"recipients_rejected\",\"message\":\"one or more recipients are not allowed\"}"],
    ["environment", "\"hr_demo\" mock data does not declare its column types (mock file v3 for datasource"],
    ["environment", "\"orders_demo\" has no mock data — this draft run is refused"],
    ["code_fragment", "Traceback (most recent call last):\n  File \"main.py\""],
    ["llm_output", "llm_complete output truncated at 1024 tokens"],
  ];
  for (const [cls, msg] of cases) it(`${cls}: ${msg.slice(0, 50)}`, () => expect(classify(msg)).toBe(cls));

  it("CONTROL: an unrecognised message is `other`, never a neighbour", () => {
    expect(classify("the moon is made of cheese")).toBe("other");
  });

  it("the class list is the fixed nine (D-251)", () => {
    expect(FAILURE_CLASSES).toHaveLength(9);
  });

  it("an object finding is rendered, not `[object Object]`", () => {
    expect(findingText({ path: "steps.2", message: "boom" })).toBe("steps.2: boom");
    expect(findingText({ code: 1 })).toBe('{"code":1}');
  });
});

describe("matchShape", () => {
  const R06 = BUILD_GOALS.find((g) => g.id === "R06")!;

  it("an exact draft is exact, with a transform extra allowed", () => {
    const m = matchShape(R06, [
      { id: "a", kind: "tool", ref: "hr_attendance_summary" },
      { id: "t", kind: "transform", dependsOn: ["a"] },
      { id: "g", kind: "approval", dependsOn: ["t"] },
      { id: "s", kind: "tool", ref: "foundry_email_send", dependsOn: ["g"] },
    ]);
    expect(m).toMatchObject({ exact: true, matched: 3, missing: [], extra: [], brokenEdges: [] });
  });

  it("⚠ a gate AFTER the send breaks the edge — the appended-gate failure", () => {
    const m = matchShape(R06, [
      { id: "a", kind: "tool", ref: "hr_attendance_summary" },
      { id: "s", kind: "tool", ref: "foundry_email_send", dependsOn: ["a"] },
      { id: "g", kind: "approval", dependsOn: ["s"] },
    ]);
    expect(m.exact).toBe(false);
    expect(m.brokenEdges).toEqual(["gate→send"]);
  });

  it("a missing gate is reported by its label", () => {
    const m = matchShape(R06, [
      { id: "a", kind: "tool", ref: "hr_attendance_summary" },
      { id: "s", kind: "tool", ref: "foundry_email_send", dependsOn: ["a"] },
    ]);
    expect(m.missing).toEqual(["gate"]);
  });

  it("an unexplained extra call counts; a `mayAlsoUse` one does not", () => {
    const R02 = BUILD_GOALS.find((g) => g.id === "R02")!;
    const base = [
      { id: "a", kind: "tool", ref: "hr_attendance_summary" },
      { id: "s", kind: "tool", ref: "foundry_email_send", dependsOn: ["a", "d"] },
    ];
    expect(matchShape(R02, [...base, { id: "d", kind: "tool", ref: "hr_list_departments" }]).exact).toBe(true);
    expect(matchShape(R02, [...base, { id: "d", kind: "tool", ref: "ticket_create" }]).extra).toEqual(["d:tool(ticket_create)"]);
  });
});

describe("a `ds.*` label matches any reader on that datasource", () => {
  it("a generated reader counts; one on another datasource does not", () => {
    const R07 = BUILD_GOALS.find((g) => g.id === "R07")!;
    const post = { id: "p", kind: "tool", ref: "chat_post_message", dependsOn: ["r"] };
    expect(matchShape(R07, [{ id: "r", kind: "datasource", ref: "hr_demo.approved_leave" }, post]).exact).toBe(true);
    expect(matchShape(R07, [{ id: "r", kind: "datasource", ref: "hr_demox.approved_leave" }, post]).missing).toEqual(["read"]);
  });
});

describe("verdictOf", () => {
  const draft = { expect: "draft" } as BuildGoal;
  const refuse = { expect: "refuse" } as BuildGoal;
  it("separates the refusal buckets by the label", () => {
    expect(verdictOf(refuse, "insufficient_catalogue")).toBe("refused_correctly");
    expect(verdictOf(draft, "insufficient_catalogue")).toBe("refused_wrongly");
    expect(verdictOf(refuse, "ok", "SUCCESS")).toBe("drafted_wrongly");
  });
  it("a paused gate is running as designed", () => {
    expect(verdictOf(draft, "ok", "PAUSED")).toBe("runs");
    expect(verdictOf(draft, "ok", "FAILED")).toBe("run_failed");
  });
});

describe("the labelled set", () => {
  it("ids are unique and every edge names a labelled step", () => {
    expect(new Set(BUILD_GOALS.map((g) => g.id)).size).toBe(BUILD_GOALS.length);
    for (const g of BUILD_GOALS) {
      const as = new Set(g.steps.map((s) => s.as));
      for (const [a, b] of g.edges) { expect(as.has(a)).toBe(true); expect(as.has(b)).toBe(true); }
      if (g.expect === "refuse") expect(g.steps).toHaveLength(0);
      else expect(g.steps.length).toBeGreaterThan(0);
    }
  });
});
