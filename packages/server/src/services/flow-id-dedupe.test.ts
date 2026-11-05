// src/services/flow-id-dedupe.test.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ A DEDUPED FLOW ID MUST STILL COMPILE (reported from use, 2026-09-16)
// ─────────────────────────────────────────────────────────────────────────────
//
// `flowService.create` uniquifies a colliding flow id rather than refusing it —
// chat seeds every flow as "Untitled automation", so the second one must not
// 409. The suffix it appended was a hardcoded hyphen:
//
//     modelId = `${baseId}-${n}`;
//
// and `validateModel` accepts an id that is all-underscore or all-hyphen and
// NEVER a mix. So `untitled_automation` + `-2` produced
// `untitled_automation-2`, refused at the first save with
//
//     flow id "untitled_automation-2" is not slug-shaped
//
// ⚠ It fired on the SECOND colliding flow and never the first, so it presented
// as workflow creation being broken rather than as a naming rule — and every
// default-named flow collides by construction, so it was reachable on any
// deployment where somebody made two flows without renaming them.
//
// ⚠ **The assertion runs the REAL `validateModel`, never a copy of its
// regexes.** Two definitions of "slug-shaped" is how the mismatch happened in
// the first place: `create` assumed hyphens were always safe and the compiler
// is the only thing that actually decides.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateModel } from "./flow-compiler.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * The suffix rule under test, mirroring `flowService.create`'s `withSuffix`.
 *
 * ⚠ This IS a second copy and it is deliberately a small one: `create` needs a
 * live workspace, repos and Kestra to reach its loop, which is a integration
 * test's job. What this file pins is the PROPERTY — that whatever separator is
 * chosen, the result compiles — and the source scan at the bottom of this file
 * keeps the two spellings in step.
 */
const withSuffix = (baseId: string, n: number) =>
  `${baseId}${baseId.includes("_") ? "_" : "-"}${n}`;

/** The smallest model `validateModel` will look past the id for. */
const model = (id: string): FlowModel =>
  ({
    id,
    steps: [{ id: "only", kind: "transform", expr: "{{ 1 }}" }],
  }) as unknown as FlowModel;

describe("a deduped flow id still compiles", () => {
  it("⚠ the control — `validateModel` genuinely refuses a mixed id", () => {
    // Without this, every assertion below passes against a check that accepts
    // everything, which is exactly what a green suite over a dead control looks
    // like (I-38).
    expect(() => validateModel(model("untitled_automation-2"))).toThrow(/not slug-shaped/);
    expect(() => validateModel(model("my-flow_2"))).toThrow(/not slug-shaped/);
  });

  it("the reported case: an underscored base takes an underscore", () => {
    expect(withSuffix("untitled_automation", 2)).toBe("untitled_automation_2");
    expect(() => validateModel(model(withSuffix("untitled_automation", 2)))).not.toThrow();
  });

  it("a hyphenated base keeps hyphens", () => {
    expect(withSuffix("monthly-report", 3)).toBe("monthly-report-3");
    expect(() => validateModel(model(withSuffix("monthly-report", 3)))).not.toThrow();
  });

  it("a base with no separator takes a hyphen — the previous behaviour, still right", () => {
    expect(withSuffix("report", 2)).toBe("report-2");
    expect(() => validateModel(model(withSuffix("report", 2)))).not.toThrow();
  });

  it("holds for every n the loop can reach (it gives up at 100)", () => {
    for (const base of ["untitled_automation", "monthly-report", "report"]) {
      for (let n = 2; n <= 100; n += 1) {
        expect(() => validateModel(model(withSuffix(base, n)))).not.toThrow();
      }
    }
  });
});

/**
 * ⚠ The mirror above is only worth anything while `create` still agrees with
 * it. A source scan is the cheapest thing that notices when it stops —
 * `create`'s loop needs a workspace, repos and a reachable Kestra to run, so
 * nothing else in the unit suite reaches it.
 */
describe("`flowService.create` derives the suffix rather than hardcoding one", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./flow.service.ts", import.meta.url)),
    "utf8",
  );

  it("⚠ the control — the file was read and holds the dedupe loop", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("const baseId = input.model.id;");
  });

  it("no longer builds an id with a hardcoded hyphen", () => {
    // The exact spelling of the defect. `name = `${baseName} ${n}`` is
    // untouched and must stay — a display name is not an identifier.
    expect(src).not.toContain("modelId = `${baseId}-${n}`");
  });

  it("chooses the separator from the base id", () => {
    expect(src).toContain('baseId.includes("_") ? "_" : "-"');
  });
});
