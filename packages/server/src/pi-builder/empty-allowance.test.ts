/**
 * "May this output come back with nothing in it?" is the person's call: a whole-output allowance Forge adds is held
 * and asked; a field allowance is not (2026-10-12).
 */
import { describe, expect, it } from "vitest";
import {
  ALLOW_NO,
  ALLOW_YES,
  BLANK_REASON,
  blankColumnsOf,
  blankColumnsQuestion,
  blankColumnsTarget,
  withFieldAllowances,
  heldFromId,
  heldQuestion,
  newWholeOutputAllowances,
  saysYes,
  withAllowance,
  withoutAllowances,
  withRoots,
} from "./empty-allowance.js";

const wf = (allow: unknown[]) => ({
  name: "Muster",
  reads: {},
  steps: [
    { id: "classify", entry: "steps/classify/main.py", outputs: ["report_rows"], allow_empty: allow },
    { id: "each", foreach: "classify.report_rows", as: "r", steps: [{ id: "inner", entry: "x.py", outputs: ["sent"], allow_empty: [{ output: "sent", reason: "r" }] }] },
  ],
});

describe("holding a new whole-output allowance", () => {
  it("finds one added this turn, anywhere in the workflow, and not one that was there before", () => {
    const now = wf([{ output: "report_rows", reason: "no rows match" }]);
    expect(newWholeOutputAllowances(now, [])).toEqual([
      { stepId: "classify", output: "report_rows", reason: "no rows match" },
      { stepId: "inner", output: "sent", reason: "r" },
    ]);
    expect(newWholeOutputAllowances(now, ["classify:report_rows", "inner:sent"])).toEqual([]);
  });

  it("does not hold a FIELD allowance — a column blank on purpose is ordinary", () => {
    expect(newWholeOutputAllowances(wf([{ output: "report_rows", field: "Remark", reason: "left blank" }]), ["inner:sent"])).toEqual([]);
  });

  it("takes the held one out and keeps the rest; a yes writes it back", () => {
    const now = wf([{ output: "report_rows", reason: "x" }, { output: "report_rows", field: "Remark", reason: "y" }]);
    const held = newWholeOutputAllowances(now, ["inner:sent"]);
    const out = withoutAllowances(now, held) as ReturnType<typeof wf>;
    expect(out.steps[0]!.allow_empty).toEqual([{ output: "report_rows", field: "Remark", reason: "y" }]);
    expect(out.name).toBe("Muster");
    const back = withAllowance(out, held[0]!) as ReturnType<typeof wf>;
    expect(back.steps[0]!.allow_empty).toContainEqual({ output: "report_rows", reason: "x" });
  });

  it("asks in plain words with the consequence of each answer, and maps the answer back", () => {
    const h = { stepId: "classify", output: "report_rows", reason: "no rows match" };
    const q = heldQuestion(h);
    expect(q.prompt).toMatch(/genuinely come back with nothing/);
    expect(q.prompt).toMatch(/an empty report would still go out/);
    expect(q.choices).toEqual([ALLOW_YES, ALLOW_NO]);
    expect(heldFromId(q.id, [h])).toBe(h);
    expect(saysYes(ALLOW_YES)).toBe(true);
    expect(saysYes(ALLOW_NO)).toBe(false);
    expect(saysYes("not really")).toBe(false);
  });
});

describe("columns blank in every row are put to the person, by code (chat 25d67dbd)", () => {
  const steps = [
    {
      stepId: "build_report",
      status: "failed",
      checksJson: [
        { output: "rows", field: "Remarks", rows: 99023, empty: 99023, verdict: "failed" },
        { output: "rows", field: "AB P/A", rows: 99023, empty: 98000, verdict: "partial" },
        { output: "rows", field: "Absent", rows: 99023, empty: 99023, verdict: "failed" },
      ],
    },
    { stepId: "make_file", status: "skipped", checksJson: null },
  ];

  it("asks only about the columns the test FAILED — never a partly-blank one, never 'every column'", () => {
    const blank = blankColumnsOf(steps);
    expect(blank).toEqual([{ stepId: "build_report", output: "rows", rows: 99023, fields: ["Remarks", "Absent"] }]);
    const q = blankColumnsQuestion(blank[0]!);
    expect(q).toMatchObject({ kind: "multi", choices: ["Remarks", "Absent"] });
    expect(q.prompt).toMatch(/99,023 rows/);
    expect(blankColumnsTarget(q.id)).toEqual({ stepId: "build_report", output: "rows" });
  });

  it("a whole-output emptiness is not a column question", () => {
    expect(blankColumnsOf([{ stepId: "s", status: "failed", checksJson: [{ output: "rows", rows: 0, verdict: "failed" }] }])).toEqual([]);
  });

  it("writes FIELD allowances onto the step, once each", () => {
    const wf = { steps: [{ id: "build_report", entry: "steps/b/main.py", allow_empty: [{ output: "rows", field: "Remarks", reason: "x" }] }] };
    const out = withFieldAllowances(wf, "build_report", "rows", ["Remarks", "Absent"]) as typeof wf;
    expect(out.steps[0]!.allow_empty).toEqual([
      { output: "rows", field: "Remarks", reason: "x" },
      { output: "rows", field: "Absent", reason: BLANK_REASON },
    ]);
    // every entry has a field: none of them lets the report itself come back with no rows
    expect(out.steps[0]!.allow_empty.every((a) => a.field)).toBe(true);
  });
});

describe("asked once per root: what is built only from an allowed-empty output follows its answer (chat eb205c03)", () => {
  const step = (id: string, inputs: Record<string, string> | undefined, outputs: string[]) => ({
    id,
    entry: `steps/${id}/main.py`,
    ...(inputs ? { inputs } : {}),
    outputs,
    allow_empty: outputs.map((o) => ({ output: o, reason: "r" })),
  });
  const flow = {
    reads: {},
    steps: [
      step("attendance", undefined, ["rows"]),
      step("leave", undefined, ["rows"]),
      step("prepare", { att: "attendance.rows", lv: "leave.rows" }, ["count", "body"]),
      step("send", { body: "prepare.body" }, ["result"]),
    ],
  };
  const held = newWholeOutputAllowances(flow, []);

  it("two roots; the steps built from them follow both, through a chain", () => {
    const got = Object.fromEntries(withRoots(flow, held).map((h) => [`${h.stepId}:${h.output}`, h.follows]));
    expect(got["attendance:rows"]).toBeUndefined();
    expect(got["leave:rows"]).toBeUndefined();
    expect(got["prepare:count"]).toEqual(["attendance:rows", "leave:rows"]);
    expect(got["send:result"]).toEqual(["attendance:rows", "leave:rows"]);
  });

  it("CONTROL: a step with one input that must have rows, or a $input, stays a root", () => {
    const f = {
      steps: [
        step("a", undefined, ["rows"]),
        { id: "b", entry: "b.py", outputs: ["rows"] },
        step("c", { x: "a.rows", y: "b.rows" }, ["out"]),
        step("d", { x: "a.rows", p: "$input.month" }, ["out"]),
      ],
    };
    const got = withRoots(f, newWholeOutputAllowances(f, []));
    expect(got.every((h) => h.follows === undefined)).toBe(true);
  });

  it("follows nothing held when its source was accepted before this turn", () => {
    const before = ["attendance:rows", "leave:rows"];
    const got = withRoots(flow, newWholeOutputAllowances(flow, before));
    expect(got.find((h) => h.stepId === "prepare")?.follows).toEqual([]);
  });

  it("the root's question names what its answer also decides", () => {
    const [root] = held;
    const q = heldQuestion(root, [{ stepId: "prepare", output: "count", reason: "" }]);
    expect(q.id).toBe("allow_empty:attendance:rows");
    expect(q.prompt).toContain('also decides "count" (step prepare)');
    expect(heldQuestion(root).prompt).not.toContain("also decides");
  });
});
