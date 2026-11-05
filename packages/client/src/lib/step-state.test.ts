import { describe, it, expect } from "vitest";
import { stepState } from "./step-state";
const base: {
  stepId: string;
  findings: Array<{ stepId?: string; message: string; blocking: boolean }>;
  broken: Array<{ name: string; stepId: string; field: string }>;
  lastRun: { status: string; revision: number } | null;
  draftRevision: number;
  flag: string | null;
} = {
  stepId: "summarise",
  findings: [],
  broken: [],
  lastRun: null,
  draftRevision: 5,
  flag: null,
};

describe("stepState", () => {
  it("is ready when nothing is wrong", () => {
    expect(stepState({ ...base })).toEqual({ state: "ready", reason: "ready", blocks: null });
  });

  it("is incomplete on a blocking finding for this step, refusing save", () => {
    const out = stepState({
      ...base,
      findings: [{ stepId: "summarise", message: "no model chosen yet", blocking: true }],
    });
    expect(out.state).toBe("incomplete");
    expect(out.reason).toBe("no model chosen yet");
    expect(out.blocks).toBe("save");
  });

  it("ignores non-blocking findings and findings for other steps", () => {
    expect(
      stepState({
        ...base,
        findings: [{ stepId: "summarise", message: "nothing feeds this step yet", blocking: false }],
      }).state,
    ).toBe("ready");
    expect(
      stepState({
        ...base,
        findings: [{ stepId: "fetch_offers", message: "no model chosen yet", blocking: true }],
      }).state,
    ).toBe("ready");
  });

  it("is broken when a reference no longer resolves, refusing save", () => {
    const out = stepState({
      ...base,
      broken: [{ name: "body", stepId: "fetch_offers", field: "body" }],
    });
    expect(out.state).toBe("broken");
    expect(out.reason).toBe("body is bound to a removed step");
    expect(out.blocks).toBe("save");
  });

  it("is failed when the last run's status is a failure word, refusing run", () => {
    for (const status of ["failed", "Failed", "FAILED: timeout"]) {
      const out = stepState({ ...base, lastRun: { status, revision: 5 } });
      expect(out.state).toBe("failed");
      expect(out.reason).toBe("last run failed");
      expect(out.blocks).toBe("run");
    }
    expect(stepState({ ...base, lastRun: { status: "succeeded", revision: 5 } }).state).toBe("ready");
  });

  it("is stale when the last run predates the draft, naming the revision", () => {
    const out = stepState({ ...base, lastRun: { status: "succeeded", revision: 3 } });
    expect(out.state).toBe("stale");
    expect(out.reason).toBe("edited since revision 3");
    expect(out.blocks).toBe(null);
  });

  it("is stale when a flag is set, naming the flag", () => {
    const out = stepState({ ...base, flag: "needs a value" });
    expect(out.state).toBe("stale");
    expect(out.reason).toContain("needs a value");
    expect(out.blocks).toBe(null);
  });

  it("prefers broken over incomplete over failed over stale", () => {
    const everything = {
      ...base,
      findings: [{ stepId: "summarise", message: "no model chosen yet", blocking: true }],
      broken: [{ name: "body", stepId: "fetch_offers", field: "body" }],
      lastRun: { status: "failed", revision: 3 },
      flag: "needs a value",
    };
    expect(stepState(everything).state).toBe("broken");
    expect(stepState({ ...everything, broken: [] }).state).toBe("incomplete");
    expect(stepState({ ...everything, broken: [], findings: [] }).state).toBe("failed");
    expect(stepState({ ...everything, broken: [], findings: [], lastRun: { status: "succeeded", revision: 3 } }).state).toBe(
      "stale",
    );
  });
});
