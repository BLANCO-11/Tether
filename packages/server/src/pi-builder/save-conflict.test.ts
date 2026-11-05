// A chat's save against a workflow changed since (sharing-boundaries P2-I2): what counts as a conflict, and whose
// account choice survives.
import { describe, expect, it } from "vitest";
import { keptChoice, workflowChanged } from "./save-conflict.js";

const wf = { steps: [{ id: "a" }] };
const each = { connectionId: "", label: "Each person", personal: false, service: "GitHub", each: true };

describe("a save over a newer version", () => {
  it("a changed step or file is a conflict; a changed Runs as alone is not", () => {
    expect(workflowChanged({ workflow: wf, files: { "steps/a.py": "1" } }, { workflow: wf, files: { "steps/a.py": "2" } })).toBe(true);
    expect(workflowChanged({ workflow: wf, files: {} }, { workflow: { steps: [] }, files: {} })).toBe(true);
    expect(workflowChanged({ workflow: wf, files: {} }, { workflow: wf, files: {}, accounts: { gh: each } } as never)).toBe(false);
  });

  it("⚠ keeps the page's Runs as (e.g. each person) unless the chat chose for that service", () => {
    expect(keptChoice("gh", {}, { gh: each })).toEqual(each);
    expect(keptChoice("gh", { gh: { connectionId: "c1" } }, { gh: each })).toBeNull();
    expect(keptChoice("gh", {}, undefined)).toBeNull();
  });
});
