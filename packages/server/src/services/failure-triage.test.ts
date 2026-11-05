import { describe, expect, it } from "vitest";
import { MAX_FRAGMENT_ATTEMPTS, triage, type TriageInput } from "./failure-triage.service.js";

/**
 * The §6.9 classification table.
 * archive/kestra-migration/06-failure-triage.md · 09 §13 assertions 33, 34, 35, 36
 *
 * Two of these are the whole point of the ladder existing:
 *
 *  * **35** — a 401 goes STRAIGHT to the user and never to the LLM. Three
 *    regenerations of correct code that all 401 end with "step 3 failed after
 *    3 attempts" instead of "update the API key".
 *  * **34** — the third failure of one step escalates to a flow redraft rather
 *    than a fourth attempt. Repeated failure of one step is the boundary-error
 *    signature, and no amount of regenerating fixes insufficient inputs.
 */

const base: TriageInput = { stepId: "compute_variance", kind: "code", attempt: 0 };
const t = (over: Partial<TriageInput> = {}) => triage({ ...base, ...over });

describe("33 — a refusal triggers a FLOW redraft, not a fragment regeneration", () => {
  it("routes an author-time refusal to level 0", () => {
    const v = t({ refused: true });
    expect(v).toMatchObject({ failureClass: "insufficient_contract", route: "flow_redraft", level: 0 });
  });

  it("says what to do, not that a step failed", () => {
    // §6.10: never "step 3 failed". The message names the fix.
    expect(t({ refused: true }).message).toMatch(/Add it as a flow input, or add a step that resolves it/);
  });
});

describe("35 — credential and tool-shape failures go straight to the user", () => {
  it.each([401, 403])("routes HTTP %s to the user, never to the LLM", (httpStatus) => {
    const v = t({ kind: "tool", httpStatus });
    expect(v.failureClass).toBe("credential");
    expect(v.route).toBe("user");
    expect(v.message).toMatch(/secrets\/audit/);
  });

  it("does not let a Python-looking word in a 401 body pull it onto the ladder", () => {
    // The ordering bug this guards: classify-by-error-text first, and a 401
    // whose body mentions `TypeError` becomes three wasted regenerations.
    const v = t({ kind: "tool", httpStatus: 401, error: "TypeError: unauthorized token" });
    expect(v.route).toBe("user");
    expect(v.failureClass).toBe("credential");
  });

  it("36 — a changed tool response suspends the approval AND names the field", () => {
    const v = t({ kind: "tool", missingResponseFields: ["leave_type"] });
    expect(v).toMatchObject({ failureClass: "tool_changed", route: "user", suspendsApproval: true });
    expect(v.message).toContain("leave_type");
    expect(v.message).toMatch(/approval is suspended/);
  });

  it("treats a 404 as the tool having moved, not as bad code", () => {
    expect(t({ kind: "tool", httpStatus: 404 })).toMatchObject({
      failureClass: "tool_changed",
      route: "user",
      suspendsApproval: true,
    });
  });

  it("retries a 429 rather than rewriting anything", () => {
    expect(t({ kind: "tool", httpStatus: 429 })).toMatchObject({ failureClass: "rate_limited", route: "retry" });
  });

  it("explains a read-only refusal instead of calling it a broken connection", () => {
    const v = t({ kind: "datasource", error: 'permission denied for table "employees"' });
    expect(v.failureClass).toBe("infrastructure");
    expect(v.route).toBe("user");
    expect(v.message).toMatch(/read-only by design/);
  });

  it("routes an unreachable datasource to the user", () => {
    expect(t({ kind: "datasource", error: "connect ECONNREFUSED 10.0.0.5:5432" })).toMatchObject({
      failureClass: "infrastructure",
      route: "user",
    });
  });
});

describe("34 — three failures of one step escalate to a flow redraft", () => {
  it("regenerates the fragment on the first two failures", () => {
    for (const attempt of [0, 1]) {
      expect(t({ attempt, wrapperFailureClass: "contract_violation" })).toMatchObject({
        route: "fragment_regenerate",
        level: 1,
      });
    }
  });

  it("escalates on the third, and does NOT try a fourth fragment", () => {
    const v = t({ attempt: MAX_FRAGMENT_ATTEMPTS - 1, wrapperFailureClass: "contract_violation" });
    expect(v.route).toBe("flow_redraft");
    expect(v.level).toBe(2);
    expect(v.message).toMatch(/inputs are insufficient/);
  });

  it("classifies a throw on a declared input as bad code", () => {
    expect(t({ error: "KeyError: 'period'" })).toMatchObject({
      failureClass: "contract_violation",
      route: "fragment_regenerate",
    });
  });

  it("classifies a time or memory overrun as bad code, distinctly", () => {
    // §6.9 routes it to level 1 like a contract violation, but the CLASS is
    // different — a step that keeps running out of memory reads very differently
    // in a run history than one returning the wrong shape.
    expect(t({ error: "Command killed: out of memory" })).toMatchObject({
      failureClass: "resource_exhausted",
      route: "fragment_regenerate",
    });
  });
});

describe("the rows that are neither the LLM's nor a retry's", () => {
  it("sends an oracle mismatch to review, not to regeneration", () => {
    // §6.11's honest limit: a step can satisfy its contract and still be wrong.
    // Nothing mechanical detects that, so it must not enter the ladder.
    const v = t({ oracleMismatch: { expected: 11, actual: 9 } });
    expect(v).toMatchObject({ failureClass: "oracle_mismatch", route: "review" });
    expect(v.message).toMatch(/ran successfully/);
  });

  it("treats an over-cap output as a decomposition problem", () => {
    // Regenerating the fragment would produce the same volume.
    expect(t({ wrapperFailureClass: "output_too_large" })).toMatchObject({
      failureClass: "output_too_large",
      route: "flow_redraft",
    });
  });

  it("routes an unclassifiable failure to the USER, not to the LLM", () => {
    // The tempting default is "try the LLM, it might fix it". Three
    // regenerations against an unknown produce three variants of the same
    // unknown and a worse message at the end.
    const v = t({ error: "something nobody has a model of" });
    expect(v).toMatchObject({ failureClass: "unknown", route: "user", level: 3 });
    expect(v.message).toContain("something nobody has a model of");
  });

  it("never routes a suspend-worthy failure anywhere but the user", () => {
    // A signal that suspends the schedule is by definition one the LLM cannot
    // fix — if it could, suspending would be wrong.
    for (const input of [{ httpStatus: 404 }, { missingResponseFields: ["x"] }]) {
      const v = t(input);
      expect(v.suspendsApproval).toBe(true);
      expect(v.route).toBe("user");
    }
  });
});
