/**
 * `flowResultOf` — the four ways to have no answer, and the one way to have one.
 *
 * ⚠ **The unavailable cases are the bulk of this file on purpose.** The defect
 * being prevented is a caller receiving `value: null` and being unable to tell
 * "nobody declared a result", "the step is not in this run", "the step failed"
 * and "the output could not be read" apart. Those need four different actions,
 * so they get four different sentences — D-66's ranking, where *"I could not
 * find out"* must never render as *"there is nothing"*.
 */
import { describe, expect, it } from "vitest";
import { emptyRowSteps, flowResultOf } from "./flow-result.js";

const envelopeStep = (data: unknown, extra: Record<string, unknown> = {}) => ({
  stepId: "rows",
  kind: "query",
  status: "success",
  output: { body: JSON.stringify({ results: [{ ok: true, data }], succeeded: 1, failed: 0, warnings: [], ...extra }) },
});

const valueStep = (value: string) => ({
  stepId: "digest",
  kind: "transform",
  status: "success",
  output: { value },
});

describe("a declared result that is there", () => {
  it("hands back the ROWS, not Foundry's envelope", () => {
    // The envelope is transport. A caller wanting `{results:[{data:…}]}` is a
    // caller reading Foundry's internals, and EXPRESSION_RULES already tells
    // every model that the payload is at `.results[n].data`.
    const r = flowResultOf({ stepId: "rows" }, [envelopeStep([{ ticket_id: 1 }])]);
    expect(r.available).toBe(true);
    expect(r.unavailableReason).toBeNull();
    expect(r.value).toEqual([{ ticket_id: 1 }]);
  });

  it("keeps one entry per call on a fan-out, so 1 row and 1 batch differ", () => {
    const step = {
      stepId: "rows",
      kind: "tool",
      status: "success",
      output: {
        body: JSON.stringify({
          results: [{ data: { id: "a" } }, { data: { id: "b" } }],
          succeeded: 2,
          failed: 0,
        }),
      },
    };
    expect(flowResultOf({ stepId: "rows" }, [step]).value).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("reports a PARTIAL failure alongside the value, never instead of it", () => {
    // 7 of 10 sent is a real answer AND a real failure. Reporting only the
    // value hides the failure; refusing the value hides the answer.
    const step = {
      stepId: "rows",
      kind: "tool",
      status: "success",
      output: { body: JSON.stringify({ results: [{ data: "sent" }], succeeded: 7, failed: 3, warnings: ["3 bounced"] }) },
    };
    const r = flowResultOf({ stepId: "rows" }, [step]);
    expect(r.available).toBe(true);
    expect(r.value).toBe("sent");
    expect(r.failed).toBe(3);
    expect(r.warnings).toEqual(["3 bounced"]);
  });

  it("passes a transform's own value through, parsed", () => {
    const r = flowResultOf({ stepId: "digest" }, [valueStep('[{"to":"a@x.test"}]')]);
    expect(r.value).toEqual([{ to: "a@x.test" }]);
    expect(r.succeeded).toBeNull();
  });

  it("returns a model's PROSE as-is rather than calling it unreadable", () => {
    const r = flowResultOf({ stepId: "digest" }, [valueStep("Three teams missed target.")]);
    expect(r.available).toBe(true);
    expect(r.value).toBe("Three teams missed target.");
  });

  it("carries the description, which is what the result IS in a person's words", () => {
    const r = flowResultOf(
      { stepId: "digest", description: "One paragraph on this week's misses" },
      [valueStep("x")],
    );
    expect(r.description).toBe("One paragraph on this week's misses");
  });
});

describe("the four ways to have no answer, each with its own sentence", () => {
  const reasons = new Set<string>();

  it("no declaration at all — and it never GUESSES a step", () => {
    // No "last step", no "the only transform". A guess that is right on a
    // two-step flow is wrong the moment somebody appends a notification, and
    // it would be wrong silently.
    const r = flowResultOf(null, [valueStep("x"), envelopeStep([1])]);
    expect(r.available).toBe(false);
    expect(r.stepId).toBeNull();
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toMatch(/does not declare/i);
    reasons.add(r.unavailableReason!);
  });

  it("the declared step is not in this run", () => {
    const r = flowResultOf({ stepId: "gone" }, [valueStep("x")]);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/did not run/i);
    reasons.add(r.unavailableReason!);
  });

  it("the declared step did not succeed — and it points at that step", () => {
    const r = flowResultOf({ stepId: "digest" }, [{ ...valueStep("x"), status: "failed" }]);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toContain("failed");
    expect(r.unavailableReason).toMatch(/read that step/i);
    reasons.add(r.unavailableReason!);
  });

  it("the output could not be read", () => {
    const r = flowResultOf({ stepId: "digest" }, [
      { stepId: "digest", kind: "transform", status: "success", output: { value: "   " } },
    ]);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/could not be read/i);
    reasons.add(r.unavailableReason!);
  });

  it("gives four DISTINCT sentences — the whole point of the module", () => {
    expect(reasons.size).toBe(4);
  });

  it("never leaves unavailableReason null when unavailable, nor set when available", () => {
    const bad = flowResultOf({ stepId: "gone" }, []);
    expect(bad.unavailableReason).toBeTruthy();
    const good = flowResultOf({ stepId: "digest" }, [valueStep("x")]);
    expect(good.unavailableReason).toBeNull();
  });

  it("a running step is unavailable and says so, rather than reading as empty", () => {
    const r = flowResultOf({ stepId: "digest" }, [{ ...valueStep("x"), status: "running" }]);
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toContain("running");
  });
});

describe("a row reading ONE field of a step (2026-09-24)", () => {
  const rows = (field?: string) => ({ rows: [{ name: "who", type: "any", source: { from: "step", stepId: "digest", ...(field ? { field } : {}) } }] });
  it("returns that field of each row, not the whole output", () => {
    const r = flowResultOf(rows("to"), [valueStep('[{"to":"a@x.test","n":1},{"to":"b@x.test","n":2}]')]);
    expect(r.rows?.[0]).toMatchObject({ available: true, value: ["a@x.test", "b@x.test"] });
  });
  it("returns that field of an object value", () => {
    const r = flowResultOf(rows("text"), [valueStep('{"text":"Three teams missed target.","n":3}')]);
    expect(r.rows?.[0]?.value).toBe("Three teams missed target.");
  });
  it("CONTROL: no field is the whole output, as before", () => {
    const r = flowResultOf(rows(), [valueStep('{"text":"x","n":3}')]);
    expect(r.rows?.[0]?.value).toEqual({ text: "x", n: 3 });
  });
});

describe("emptyRowSteps (I-301 C): a step that succeeded with no rows is said so", () => {
  const env = (data: unknown[]) => ({ body: JSON.stringify({ results: [{ ok: true, data }], succeeded: 1, failed: 0, warnings: [] }) });
  it("a reader that read nothing, and a filter that kept nothing, are each named", () => {
    expect(emptyRowSteps([
      { stepId: "read", kind: "datasource", status: "success", output: env([]) },
      { stepId: "where_1", kind: "transform", status: "success", output: { value: "[]" } },
    ])).toEqual([{ stepId: "read", note: "read no rows" }, { stepId: "where_1", note: "kept no rows" }]);
  });
  it("CONTROL: rows, a failed step, a tool call and a non-list value are not flagged", () => {
    expect(emptyRowSteps([
      { stepId: "read", kind: "datasource", status: "success", output: env([{ a: 1 }]) },
      { stepId: "broken", kind: "datasource", status: "failed", output: env([]) },
      { stepId: "send", kind: "tool", status: "success", output: env([]) },
      { stepId: "t", kind: "transform", status: "success", output: { value: "{\"n\":0}" } },
    ])).toEqual([]);
  });
});
