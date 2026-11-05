// @vitest-environment jsdom
// Phase 3 — every surface reads the same `stepState` record: the card (via
// `stepNodes`), the panel head, the readiness sheet's per-step rows, and the
// strip. These tests pin the wiring, not the five words themselves (those live
// in `lib/step-state.test.ts`): a record computed once by `stepState` renders
// the same `state · reason` on each surface, and every surface renders
// today's output when the record is absent.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { stepState } from "@/lib/step-state";
import { stepNodes } from "@/components/flow/FlowCanvas";

afterEach(() => cleanup());

const CAT = {
  entries: [],
  triggers: [],
  outputs: {},
  expressions: { roots: ["inputs", "outputs"], calls: ["json", "jq", "first", "length"] },
  caps: { steps: 40, codeSteps: 8, agentSteps: 4, approvalSteps: 4 },
  drift: [],
};

const GATE = {
  kind: "approval",
  id: "gate",
  summaryExpr: '"Ship it?"',
  summary: "Ship it?",
  awaitSeconds: 3600,
};

const FLOW = { id: "f", inputs: [], steps: [GATE] } as never;

const badges = {
  gate: stepState({
    stepId: "gate",
    findings: [],
    broken: [{ name: "evidence", stepId: "read", field: "body" }],
    lastRun: null,
    draftRevision: 3,
    flag: null,
  }),
};

describe("stepNodes carries the shared record to the card", () => {
  const node = { id: "gate", kind: "approval" } as never;
  const at = [{ id: "gate", x: 0, y: 0 }] as never;

  it("passes the step's own badge into node data", () => {
    const [n] = stepNodes([node], at, { stepStates: badges });
    expect(n.data.stateBadge).toEqual(badges.gate);
  });

  it("leaves the badge absent when no record is supplied", () => {
    const [n] = stepNodes([node], at, {});
    expect(n.data.stateBadge).toBeUndefined();
  });

  it("never badges a boundary node", () => {
    const edge = { id: "start", boundary: "start" } as never;
    const [n] = stepNodes([edge], [{ id: "start", x: 0, y: 0 }] as never, {
      stepStates: { start: badges.gate },
    });
    expect(n.data.stateBadge).toBeUndefined();
  });
});
