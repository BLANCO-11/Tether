// @vitest-environment jsdom
//
// T6 / BX-005 — the panel that replaced a fabrication.
//
// Most of these assert an ABSENCE, because that is what the defect was: output
// where none had been produced. A test that only checked the happy path would
// pass against the `mockPerNode` loop this component exists to delete.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TestRunPanel, hasTestRun } from "@/components/flow/builder/TestRunPanel";
import { STATUS_LABEL, type CanvasGraph } from "@/lib/canvas-model";

afterEach(cleanup);

const node = (id: string, status: string | null) => ({
  id, kind: "tool" as const, ref: null, status: status as never, seam: null,
  meta: null, attempt: null, generated: false, platform: false,
});
const graph = (...nodes: Array<[string, string | null]>): CanvasGraph => ({
  nodes: nodes.map(([id, s]) => node(id, s)),
  edges: [], hasSeam: false, hasUnknownSeam: false,
});

describe("hasTestRun — is there anything to say at all", () => {
  it("is false with nothing, true with any one of the three", () => {
    expect(hasTestRun({})).toBe(false);
    expect(hasTestRun({ testing: true })).toBe(true);
    expect(hasTestRun({ testNotice: "waiting" })).toBe(true);
    expect(hasTestRun({ testOutputs: {} })).toBe(true);
  });
});

describe("the pane has a structure, not a pile", () => {
  it("opens with a summary, then named sections", () => {
    render(<TestRunPanel graph={graph(["a", "success"])} testOutputs={{ a: { status: "success" } }} />);
    expect(screen.getByRole("button", { name: /^Steps/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Output/ })).toBeTruthy();
  });

  it("counts only the steps the run has reported on", () => {
    render(<TestRunPanel graph={graph(["a", "success"], ["b", null])} testOutputs={{ a: { status: "success" } }} />);
    // One reported of two nodes — the unreported one is not counted as pending.
    expect(within(screen.getByRole("button", { name: /^Steps/ })).getByText("1")).toBeTruthy();
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
  });

  it("gives a selected step its own section", () => {
    render(
      <TestRunPanel
        graph={graph(["fetch", "success"])}
        testOutputs={{ fetch: { status: "success", ref: "hr.attendance", durationMs: 2000 } }}
        selectedStepId="fetch"
      />,
    );
    expect(screen.getByRole("button", { name: /Step — fetch/ })).toBeTruthy();
    expect(screen.getByText("hr.attendance")).toBeTruthy();
    expect(screen.getByText("2 sec")).toBeTruthy();
  });

  it("draws no row for a fact the step does not carry", () => {
    render(
      <TestRunPanel graph={graph(["fetch", "created"])} testOutputs={{ fetch: { status: "created" } }} selectedStepId="fetch" />,
    );
    for (const label of ["Uses", "Called", "Responded", "Took", "Attempt", "Read from"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});

describe("what it refuses to say", () => {
  it("shows no output for a step that produced none", () => {
    render(<TestRunPanel graph={graph(["a", "created"])} testOutputs={{ a: { status: "created" } }} />);
    expect(screen.getByText(/No run yet|No step has produced/)).toBeTruthy();
    expect(screen.queryByText(/output for/)).toBeNull();
  });

  /** ⚠ The notice replaces output; it never sits beside an invented one. */
  it("says what went wrong instead of showing output", () => {
    render(<TestRunPanel graph={graph(["a", null])} testNotice="The run was accepted but has not appeared yet." />);
    expect(screen.getByTestId("test-notice").textContent).toMatch(/has not appeared/);
    expect(screen.queryByText(/output for/)).toBeNull();
  });

  it("makes no aggregation claim", () => {
    render(<TestRunPanel graph={graph(["a", "success"])} testOutputs={{ a: { status: "success", output: { n: 1 } } }} />);
    expect(screen.queryByText(/Aggregated/)).toBeNull();
    expect(screen.getByRole("button", { name: /Last output — a/ })).toBeTruthy();
  });
});

describe("state is drawn as itself", () => {
  it("says waiting for a paused step, never running", () => {
    render(<TestRunPanel graph={graph(["gate", "paused"])} testing testOutputs={{ gate: { status: "paused" } }} />);
    expect(screen.getByText(STATUS_LABEL.paused)).toBeTruthy();
    expect(screen.queryByText(STATUS_LABEL.running)).toBeNull();
    expect(screen.getByText("waiting for a person")).toBeTruthy();
  });

  it("leads with the failure when a step failed", () => {
    render(
      <TestRunPanel
        graph={graph(["a", "failed"])}
        testOutputs={{ a: { status: "failed", error: "date/time field value out of range" } }}
        selectedStepId="a"
      />,
    );
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.getByText(/out of range/)).toBeTruthy();
  });

  it("uses the canvas's own words for every state", () => {
    render(<TestRunPanel graph={graph(["a", "skipped"])} testOutputs={{ a: { status: "skipped" } }} />);
    expect(screen.getByText(STATUS_LABEL.skipped)).toBeTruthy();
  });

  it("reads 'no report yet' for a node the run has not mentioned", () => {
    render(<TestRunPanel graph={graph(["a", null])} testing />);
    expect(screen.getByText("no report yet")).toBeTruthy();
  });
});
