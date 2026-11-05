// src/lib/step-shape.test.ts — T8.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fanOutOver, fanOutSentence, outputSummary, OUTPUT_EDITABLE } from "@/lib/step-shape";
import { buildFanOutParams, buildSingleParams, type OutputShapes } from "@/lib/flow-expr";
import type { StepKind } from "@/lib/flow-authoring";

const shapes = {
  datasource: { template: "json(outputs.<id>.body)", describes: "the query's HTTP response body — rows are at `.results[0].data`", caution: "A raw query row must not be handed to a `tool` step (I-42)." },
  query: { template: "json(outputs.<id>.body)", describes: "the operation's response body", caution: "I-42." },
  tool: { template: "json(outputs.<id>.body)", describes: "the tool call's HTTP response body", caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: "the value the jq expression produced", caution: null },
  code: { template: "outputs.<id>.vars.result", describes: "the object the fragment's `run(payload)` returned", caution: "`.vars.result`, not `.value` (I-44)." },
  approval: { template: null, describes: null, caution: "A gate produces no data." },
} as unknown as OutputShapes;

describe("fan-out is read off the expression, never a flag", () => {
  /**
   * ⚠ Built by the real emitter, not a hand-written string. A fixture would go
   * on passing after a change to `buildFanOutParams` that broke the detection.
   */
  it("finds the step a real fan-out expression fans over", () => {
    const expr = buildFanOutParams(shapes, { id: "overdue", kind: "datasource" } as never, [
      { param: "to", source: { from: "step", stepId: "overdue", field: "email" } },
    ]);
    expect(fanOutOver(expr)).toBe("overdue");
  });

  it("says a single call is a single call", () => {
    const expr = buildSingleParams([{ param: "period", source: { from: "input", inputId: "period" } }]);
    expect(fanOutOver(expr)).toBeNull();
  });

  it("is null for nothing at all", () => {
    expect(fanOutOver(null)).toBeNull();
    expect(fanOutOver("")).toBeNull();
    expect(fanOutOver("{{ inputs.period }}")).toBeNull();
  });

  /** ⚠ A jq program that merely mentions `.[]` is not a fan-out. */
  it("does not call a length or a filter a fan-out", () => {
    expect(fanOutOver("{{ json(outputs.a.body) | jq('[.[] | select(.n > 1)] | length') }}")).toBe("a");
    expect(fanOutOver("{{ json(outputs.a.body) | jq('.results | length') }}")).toBeNull();
  });

  it("puts the upstream step's name in the sentence", () => {
    const expr = buildFanOutParams(shapes, { id: "overdue", kind: "datasource" } as never, [
      { param: "to", source: { from: "step", stepId: "overdue", field: "email" } },
    ]);
    expect(fanOutSentence(expr)).toBe("Runs once per row from overdue.");
    expect(fanOutSentence(null)).toMatch(/Runs once,/);
  });
});

describe("output shape comes from the catalogue, never a copy", () => {
  it("resolves the expression for this step", () => {
    expect(outputSummary(shapes, "code" as StepKind, "rank").expr).toBe("outputs.rank.vars.result");
  });

  /** ⚠ I-44 and I-42 are the server's words. A client copy would go stale. */
  it("carries the server's describes and caution verbatim", () => {
    expect(outputSummary(shapes, "code" as StepKind, "rank").caution).toMatch(/I-44/);
    expect(outputSummary(shapes, "datasource" as StepKind, "q").caution).toMatch(/I-42/);
    expect(outputSummary(shapes, "tool" as StepKind, "t").caution).toBeNull();
  });

  it("draws nothing for a kind that produces nothing", () => {
    const s = outputSummary(shapes, "approval" as StepKind, "gate");
    expect(s.expr).toBeNull();
    expect(s.describes).toBeNull();
  });
});

describe("whose shape it is — a stated bound, not an omission", () => {
  it("is the author's for transform and code only", () => {
    expect([...OUTPUT_EDITABLE].sort()).toEqual(["code", "transform"]);
  });

  /**
   * ⚠ An editable box on a `tool` step lets somebody type a shape the call will
   * ignore: the value would not change, and the screen would be the only place
   * the typed shape existed.
   */
  it("names the owner when it is not the author", () => {
    expect(outputSummary(shapes, "datasource" as StepKind, "q").ownedBy).toBe("the query");
    expect(outputSummary(shapes, "tool" as StepKind, "t").ownedBy).toBe("the endpoint");
    expect(outputSummary(shapes, "transform" as StepKind, "x").ownedBy).toBeNull();
    expect(outputSummary(shapes, "code" as StepKind, "c").ownedBy).toBeNull();
  });
});

/**
 * ⚠ THE WIRING HALF. Everything above proves the seam is right and none of it
 * proves anyone calls it — which is exactly what was wrong before T8: the
 * inspector computed `fanOutOver` twice and rendered it nowhere, and the
 * catalogue served `describes`/`caution` that the client read only to build
 * expressions.
 *
 * Every scan strips comments first: these files name the symbols in prose while
 * explaining them, and a scan that matched prose would be the house rule this
 * repo has now earned six times.
 */
describe("both facts actually reach a screen", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const code = (rel: string) => {
    const raw = readFileSync(join(SRC, rel), "utf8");
    expect(raw.length).toBeGreaterThan(1000);
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  };

  /**
   * ⚠ BOTH adapters. `canvas-model.test.ts` asserts they classify the same step
   * identically, so one picture saying "once per row" while the other says
   * nothing is the disagreement that file exists to prevent.
   */
  it("both canvas adapters state the call count", () => {
    const src = code("lib/canvas-model.ts");
    expect(src.match(/fanOutOver\(/g) ?? []).toHaveLength(2);
    expect(src).toContain("once per row");
  });

  it("the review projection carries the expression the canvas reads", () => {
    expect(code("lib/api.ts")).toContain("paramsExpr:");
  });

  /**
   * ⚠ **THE SUBJECT MOVED AND THE PROPERTY DID NOT.** `OutputNote` was deleted
   * when the inspector's two prose sections became one table of rows; the claim
   * this test protects is unchanged — *the panel says what a step produces, and
   * it says it from the SERVER'S catalogue rather than a copy in the client.*
   *
   * So it now reads both halves of the seam: the inspector mounts the split
   * tables (`StepInputs` + `StepOutputs`, both over `lib/step-io.ts`), and
   * `step-io.ts` gets its answer through `outputSummary`. Asserting only the
   * second would pass against a panel that had quietly grown its own shape table.
   */

  /**
   * ⚠ The cautions are the SERVER's words — I-42, I-44, the agent and gate
   * rules. A copy in the client is how a screen goes on quoting I-44 after the
   * server has learned something newer.
   */
  it("the client keeps no copy of the server's cautions", () => {
    for (const rel of ["lib/step-shape.ts", "lib/flow-expr.ts"]) {
      const src = code(rel);
      expect(src, `${rel} hardcodes a caution`).not.toMatch(/vars\.result.*not.*\.value/);
      expect(src, `${rel} hardcodes a caution`).not.toMatch(/must not be handed to a/);
    }
  });
});

