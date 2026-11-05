// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepEvidence } from "./StepEvidence";
import type { StepRun } from "@/lib/types";

const step = (over: Partial<StepRun>): StepRun => ({ stepId: "load", status: "failed", output: null, error: null, logs: [], ...over }) as unknown as StepRun;

afterEach(cleanup);

describe("a step's evidence shows what the run checked in its output", () => {
  it("names a field empty in every row, with the numbers, as not allowed", () => {
    render(<StepEvidence step={step({ checks: [{ output: "employees", field: "hours", rows: 3387, empty: 3387, verdict: "failed" }] })} />);
    expect(screen.getByText("Checked")).toBeTruthy();
    expect(screen.getByText("employees.hours: empty in 3387 of 3387 rows — not allowed by the step")).toBeTruthy();
  });

  it("an allowed emptiness shows the step's own reason", () => {
    render(<StepEvidence step={step({ status: "success", checks: [{ output: "rows", verdict: "allowed", reason: "nobody may be late" }] })} />);
    expect(screen.getByText("rows: empty — allowed by the step")).toBeTruthy();
    expect(screen.getByText(/nobody may be late/)).toBeTruthy();
  });

  it("control: an engine step with no checks draws no Checked section", () => {
    render(<StepEvidence step={step({ status: "success" })} />);
    expect(screen.queryByText("Checked")).toBeNull();
  });
});
