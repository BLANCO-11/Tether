// src/lib/conditional-copy.test.ts — 3.3a, the conditional made legible.
//
// The engine supports `else` (measured: `io.kestra.plugin.core.flow.If` lists it
// and requires only `then`). Foundry does not emit one, because its step id
// space is flat, so there is no way for a model to say which arm a step belongs
// to. Until that changes the screens must not imply a fork — and this file is
// what keeps that true.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BRANCH_LABEL, BRANCH_CAVEAT } from "@/lib/canvas-model";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const code = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the label promises one path, not two", () => {
  it("is 'only if' — never 'branch', never 'if/else'", () => {
    expect(BRANCH_LABEL).toBe("only if");
    expect(BRANCH_LABEL).not.toMatch(/else|branch|fork/i);
  });

  /**
   * ⚠ It was spelled in FOUR files, and those maps had ALREADY drifted on a
   * neighbouring key — `approval` reads "human approval" in two of them and
   * "waits for a person" in a third. The same drift on this key would put a
   * promise of a fork on one screen and not another.
   */
  it("is spelled in exactly one place", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => !f.endsWith("lib/canvas-model.ts") && !f.endsWith("lib/conditional-copy.test.ts"))
      .filter((f) => code(f).includes(`"${BRANCH_LABEL}"`))
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});

describe("and the false path is stated, not left to be assumed", () => {
  it("says there is no otherwise branch", () => {
    expect(BRANCH_CAVEAT).toMatch(/otherwise/i);
    expect(BRANCH_CAVEAT).toMatch(/either way/i);
  });

  /**
   * ⚠ The canvas is where this was missing. It labelled the node `only if` and
   * then said nothing at all about a false condition, so a reader could
   * reasonably assume a second, unshown path.
   */
  it("the canvas RENDERS it, from one constant", () => {
    for (const rel of ["components/flow/FlowCanvas.tsx"]) {
      const src = code(join(SRC, rel));
      // ⚠ A JSX RENDER of the symbol, not just the symbol. Checking for the
      // name alone is satisfied by the IMPORT line, so deleting the only render
      // site left this green — found by perturbing it, which is the whole
      // reason to perturb. The braces may now carry a ternary around it, so the
      // pattern allows one rather than requiring the bare `{BRANCH_CAVEAT}`.
      expect(src, rel).toMatch(/\{[^{}]*\bBRANCH_CAVEAT\b[^{}]*\}/);
      expect(src).toContain("@/lib/canvas-model");
    }
  });

  /**
   * ⚠ **AND IT IS SUPPRESSED ON A CHAIN, BECAUSE IT BECOMES FALSE.**
   * `BRANCH_CAVEAT` says there is no "otherwise" branch and that everything
   * else runs either way. That is true of a lone guard and untrue the moment an
   * if/elif/else chain exists — the arms are right there on the card. Deleting
   * it outright would drop a correct warning from every single-armed condition
   * in the product, so both surfaces choose per step.
   */
  it("⚠ neither surface states it unconditionally", () => {
    for (const rel of ["components/flow/FlowCanvas.tsx"]) {
      const src = code(join(SRC, rel));
      expect(src, `${rel} must decide per step`).toMatch(/arms/);
    }
  });

  /** ⚠ Never claim a capability the compiler does not emit. */
  it("no surface calls this if/else", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => /\bif\/else\b/i.test(code(f)))
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
