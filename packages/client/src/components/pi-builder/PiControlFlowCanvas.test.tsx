// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { piWorkflowToGraph, piWorkflowToRawModel, PiStepInspector } from "./PiDagCanvas";
import type { PiWorkflow } from "@/lib/pi-builder";

const wf: PiWorkflow = {
  steps: [
    { id: "find", outputs: ["rows"] },
    { id: "ok_to_send", approval: { title: "Send these?", review: "find.rows" } },
    { id: "each", foreach: "find.rows", as: "person", steps: [
      { id: "route", branch: [
        { if: { value: "$person.late", op: "gte", to: 10 }, steps: [{ id: "escalate", outputs: ["ref"] }] },
        { else: true, steps: [{ id: "remind", outputs: ["ref"] }] },
      ] },
    ] },
    { id: "summary", inputs: { n: "each.succeeded" }, outputs: ["done"] },
  ],
};

describe("a Forge workflow with a loop, a choice and an approval, on the canvas", () => {
  afterEach(cleanup);

  it("draws the approval and the loop as their own kinds, the choice as a chain labelled by its conditions", () => {
    const { steps, frames } = piWorkflowToRawModel(wf);
    const kind = Object.fromEntries(steps.map((r) => [r.id, r.kind]));
    expect(kind).toMatchObject({ find: "code", ok_to_send: "approval", each: "for_each", route: "branch", "route·else": "branch", escalate: "code", remind: "code" });
    expect(steps.find((r) => r.id === "route")?.conditionExpr).toBe("$person.late ≥ 10");
    expect(steps.find((r) => r.id === "route·else")).toMatchObject({ elseOf: "route" });
    expect(steps.find((r) => r.id === "route·else")?.conditionExpr).toBeUndefined(); // the catch-all
  });

  it("puts the loop's steps in its box, and hangs what follows a choice off every path's end", () => {
    const { steps, frames } = piWorkflowToRawModel(wf);
    expect(frames).toEqual([expect.objectContaining({ id: "each", members: ["each", "route", "route·else", "escalate", "remind"] })]);
    expect(steps.find((r) => r.id === "summary")?.dependsOn).toEqual(["escalate", "remind"]);
    expect(steps.find((r) => r.id === "escalate")?.dependsOn).toEqual(["route"]);
    expect(steps.find((r) => r.id === "remind")?.dependsOn).toEqual(["route·else"]);
    expect(piWorkflowToGraph(wf).frames?.[0]?.id).toBe("each");
  });

  it("inspects a choice by its paths, and an approval by what it asks", () => {
    render(<PiStepInspector step={wf.steps[2]!.steps![0]!} workflow={wf} />);
    expect(screen.getByText("$person.late ≥ 10")).toBeTruthy();
    expect(screen.getByText("Otherwise")).toBeTruthy();
    cleanup();
    render(<PiStepInspector step={wf.steps[1]!} workflow={wf} />);
    expect(screen.getByText("Send these?")).toBeTruthy();
    expect(screen.getByText(/nothing\s+after it does/)).toBeTruthy();
  });
});
