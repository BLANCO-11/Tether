// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PiEndInspector, PiStartInspector, PiStepInspector } from "./PiDagCanvas";

afterEach(cleanup);

describe("a step's properties say what it may return empty", () => {
  it("lists each allowance with the step's reason", () => {
    render(
      <PiStepInspector
        step={{ id: "load", outputs: ["employees"], allow_empty: [{ output: "employees", field: "manager_email", reason: "contractors have no manager" }] }}
      />,
    );
    expect(screen.getByText("employees.manager_email")).toBeTruthy();
    expect(screen.getByText(/contractors have no manager/)).toBeTruthy();
  });

  it("control: with none declared it says every empty result fails the step", () => {
    render(<PiStepInspector step={{ id: "load", outputs: ["employees"] }} />);
    expect(screen.getByText(/Every run fails this step if an output/)).toBeTruthy();
  });
});

describe("the Start and End nodes have properties of their own", () => {
  const workflow = {
    inputs: { month: { type: "integer", description: "Which month?", default: 2 }, year: { type: "integer", description: "Which year?" } },
    steps: [
      { id: "load", params: { month: "$input.month" }, outputs: ["rows"] },
      { id: "send", inputs: { rows: "load.rows" }, outputs: ["email_result"], allow_empty: [{ output: "email_result", reason: "r" }] },
    ],
  };

  it("Start lists each input: type, question, test default, and which step receives it", () => {
    render(<PiStartInspector workflow={workflow} />);
    expect(screen.getByText("month")).toBeTruthy();
    expect(screen.getByText("Which month?")).toBeTruthy();
    expect(screen.getByText(/Test default: 2 · used by load/)).toBeTruthy();
    // an input no step receives says so — and one with no default says it is required
    expect(screen.getByText(/No default — required · no step receives it/)).toBeTruthy();
  });

  it("End names the step the result comes from and its outputs", () => {
    render(<PiEndInspector workflow={workflow} />);
    expect(screen.getByText("send")).toBeTruthy();
    expect(screen.getByText("email_result")).toBeTruthy();
  });

  it("control: a workflow with no inputs says it asks for nothing", () => {
    render(<PiStartInspector workflow={{ steps: [] }} />);
    expect(screen.getByText(/asks for no values/)).toBeTruthy();
  });
});

describe("clicking a step shows what it really does (2026-10-11)", () => {
  const workflow = {
    reads: { weekly: { datasource: "Attendance_DB", sql: "SELECT emp_id FROM attendance_day WHERE work_date >= $1", params: [{ name: "week_start", type: "date" }] } },
    cases: [
      { says: "LOP leave → tell the department head", path: "decide.1" },
      { says: "otherwise nothing", path: "decide.else" },
    ],
    steps: [
      {
        id: "review",
        description: "Adds up each employee's hours for the week.",
        uses: ["read:weekly", "tool:test_email_send"],
        params: { week_start: "$input.week_start" },
        outputs: ["short"],
      },
      {
        id: "decide",
        description: "Chooses what happens to each person.",
        branch: [
          { if: { value: "review.short", op: "not_empty" }, steps: [{ id: "tell_head", description: "Emails the department head.", outputs: [] }] },
          { else: true, steps: [] },
        ],
      },
    ],
  };

  it("a code step: its sentence, its read with the query behind an expander, its tools, what it is given, its code", () => {
    render(<PiStepInspector step={workflow.steps[0]!} workflow={workflow} files={{ "steps/review/main.py": "def run(params, inputs):\n    return {}\n" }} />);
    expect(screen.getByText("Adds up each employee's hours for the week.")).toBeTruthy();
    expect(screen.getByText(/from Attendance_DB · takes week_start/)).toBeTruthy();
    expect(screen.getByText("Show the query")).toBeTruthy();
    expect(screen.getByText("test_email_send")).toBeTruthy();
    expect(screen.getByText(/the run's input "week_start"/)).toBeTruthy();
    expect(screen.getByText("Code")).toBeTruthy();
  });

  it("a choice: each path's condition in words, the request's case it handles, and what it runs", () => {
    render(<PiStepInspector step={workflow.steps[1]!} workflow={workflow} />);
    expect(screen.getByText("LOP leave → tell the department head")).toBeTruthy();
    expect(screen.getByText("otherwise nothing")).toBeTruthy();
    expect(screen.getByText("Emails the department head.")).toBeTruthy();
  });

  it("control: a step with no description says so instead of rendering nothing", () => {
    render(<PiStepInspector step={{ id: "old", outputs: [] }} />);
    expect(screen.getByText(/No description/)).toBeTruthy();
  });
});
