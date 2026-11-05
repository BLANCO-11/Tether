/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY SCHEMA THAT DECLARES A BRANCH ACCEPTS AN `else` — CX-018
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **This test exists because one rule lived in three schemas and only two were
 * widened.** The if/elif/else chain made `conditionExpr` optional in
 * `flow.service.ts`'s `stepSchema` and in the portability bundle;
 * `flow-drafted-shape.ts` was missed — and that is the one the CANVAS goes
 * through, so a person could draw a chain and not post it. `e2e:ui`'s PHASE 5e
 * is what found it, at a 422 naming a step they had just drawn.
 *
 * That is I-127's shape a fourth time: a rule spread across several
 * declarations, where the copy that gets missed is the one nothing points a test
 * at. So this file does two things a per-schema test cannot:
 *
 *  1. It **finds the copies mechanically**, by reading the source tree for
 *     `z.literal("branch")`, and fails when a copy appears that this file does
 *     not name. A sixth schema therefore cannot be added silently — the person
 *     adding it is made to decide whether an `else` is expressible in it.
 *  2. It asserts each known copy **behaviourally**, in both directions: a
 *     terminal `else` parses, and a conditionless branch with no `elseOf` is
 *     still refused SOMEWHERE (by `validateModel`, which is where a missing
 *     condition is caught with a message naming the step).
 *
 * ⚠ The scan has a **control**: it must find copies at all. A regex that matches
 * nothing passes every "is it in the list" assertion for ever (I-38).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flowModelSchema } from "./flow.service.js";
import { flowBundleSchema } from "./flow-portability.service.js";
import { draftedStepSchema } from "./flow-drafted-shape.js";

/** The copies this file asserts on. A new one must be added here deliberately. */
const REVIEWED = new Set([
  "flow.service.ts",
  "flow-portability.service.ts",
  "flow-drafted-shape.ts",
]);

function sourceFilesDeclaringABranch(): string[] {
  const dir = join(import.meta.dirname, ".");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => {
      const src = readFileSync(join(dir, f), "utf8");
      // ⚠ Either spelling declares a branch: a lone `z.literal("branch")`, or
      // a `z.enum` whose options include it (`flow-drafted-shape.ts` carries
      // `branch`/`condition` as one enum member since kind-parity widening).
      return src.includes('z.literal("branch")') || /z\.enum\(\[[^\]]*"branch"/.test(src);
    });
}

describe("every schema declaring a branch step", () => {
  it("⚠ has no copy this file does not know about (a sixth cannot appear silently)", () => {
    const found = sourceFilesDeclaringABranch();
    // The control: the scan must be capable of finding anything at all.
    expect(found.length).toBeGreaterThan(0);
    expect([...found].sort()).toEqual([...REVIEWED].sort());
  });

  it("accepts a terminal `else` — elseOf, and no condition", () => {
    const draft = draftedStepSchema.safeParse({ id: "rest", kind: "branch", elseOf: "mid" });
    expect(draft.success).toBe(true);

    const model = flowModelSchema.safeParse({
      id: "f",
      steps: [
        { id: "hi", kind: "branch", conditionExpr: "{{ true }}" },
        { id: "rest", kind: "branch", elseOf: "hi" },
      ],
    });
    expect(model.success).toBe(true);

    const bundle = flowBundleSchema.shape.model.shape.steps.safeParse([
      { id: "hi", kind: "branch", conditionExpr: "{{ true }}" },
      { id: "rest", kind: "branch", elseOf: "hi" },
    ]);
    expect(bundle.success).toBe(true);
  });

  it("carries `elseOf` through rather than stripping it", () => {
    const parsed = draftedStepSchema.parse({ id: "rest", kind: "branch", elseOf: "mid" });
    expect(parsed).toMatchObject({ elseOf: "mid" });
  });

  it("⚠ still lets a conditionless branch with no elseOf through the SHAPE — validateModel refuses it", () => {
    // The optionality is not a hole; it moves the refusal to where the message
    // can name the step. Pinned so nobody "tightens" the schema and takes the
    // `else` with it.
    expect(draftedStepSchema.safeParse({ id: "lonely", kind: "branch" }).success).toBe(true);
  });
});
