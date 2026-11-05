/** Phase F (D-367): a partial replay cannot start INSIDE a loop (a body step ran once per item); from the loop itself it can. */
import { describe, expect, it } from "vitest";
import { partialReplayObstacle } from "./flow-replay.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

const model = {
  id: "f",
  steps: [
    { id: "rows", kind: "transform", expr: "{{ 1 }}", dependsOn: [] },
    { id: "each", kind: "for_each", over: { stepId: "rows", field: "" }, concurrency: 5, onError: "continue", dependsOn: ["rows"] },
    { id: "tag", kind: "transform", expr: "{{ 1 }}", dependsOn: ["each"] },
    { id: "results", kind: "collect", loop: "each", result: "tag", dependsOn: ["tag"] },
    { id: "after", kind: "transform", expr: "{{ 1 }}", dependsOn: ["results"] },
  ],
} as unknown as FlowModel;

describe("a partial replay and a loop", () => {
  it("refuses a step inside the loop, naming the loop to start from", () => {
    expect(partialReplayObstacle(model, new Map(), true, "tag", "failed")).toMatch(/inside the loop "each" and ran once per item.*Replay from "each"/);
  });
  it("allows the loop itself, its output and the steps after it", () => {
    for (const id of ["each", "results", "after", "rows"]) expect(partialReplayObstacle(model, new Map(), true, id, "failed")).toBeUndefined();
  });
});
