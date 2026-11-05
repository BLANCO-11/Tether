// src/components/flow/builder/palette.test.ts — T7.
//
// ⚠ These assert the SECOND SENTENCE of each entry, because that is the half a
// copy loses. `FlowBuilder` and `BuilderShell` each carried their own
// `FROM_SCRATCH`, and the copy had dropped five of five — the containment
// property, the flatten-a-date mitigation, the model seam, gate 3's kill
// semantics, and the no-otherwise-branch claim. Nothing broke and no test failed;
// the honest half had simply not been copied across.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { FROM_SCRATCH, paletteMatches } from "@/components/flow/builder/palette";
import { BRANCH_CAVEAT } from "@/lib/canvas-model";

const SRC = fileURLToPath(new URL("../../..", import.meta.url));
const byKind = (k: string) => FROM_SCRATCH.find((e) => e.kind === k)!;

describe("every entry says what the step costs, not just what it is", () => {
  it("offers the kinds with no catalogue backing", () => {
    expect(FROM_SCRATCH.map((e) => e.kind).sort()).toEqual(
      ["approval", "branch", "code", "http", "llm", "merge", "transform"],
    );
  });

  /**
   * ⚠ **A merge that is not in the palette is a merge nobody can add, and the
   * whole point of the kind is the manual builder.** Its warning is unusual in
   * this list: it describes what goes wrong WITHOUT the step, because a step
   * placed after a condition silently joins that arm and the flow still goes
   * green. This is the last place that can be said before the mistake is made.
   */
  it("a merge warns about what happens without it", () => {
    expect(byKind("merge").body).toMatch(/only when the condition held/i);
  });

  /** R9 — `networkMode: none`, no credentials, no volumes, ephemeral container. */
  it("a code step states its containment", () => {
    expect(byKind("code").body).toMatch(/no network, no credentials/i);
  });

  /** I-42 — a tool or approval step must never consume a raw query row. */
  it("a transform states what it is for", () => {
    expect(byKind("transform").body).toMatch(/flatten a date/i);
  });

  /**
   * ⚠ THE ONE THAT MATTERED MOST. The palette is the last place this sentence
   * can still change the decision to add the step.
   */

  /** Gate 3 rejects by KILLING the run; resuming would execute the guarded step. */
  it("an approval step says rejecting kills the run", () => {
    expect(byKind("approval").body).toMatch(/rejecting kills it/i);
  });

  /** 3.3a — the palette makes the same claim in the same wording as the panel. */
  it("a branch states there is no otherwise branch", () => {
    expect(byKind("branch").body).toContain(BRANCH_CAVEAT);
  });

  it("every entry is more than one sentence", () => {
    for (const e of FROM_SCRATCH) {
      expect(e.body.split(/[.!?]\s/).length, `${e.kind} lost its second sentence`).toBeGreaterThan(1);
    }
  });
});

/**
 * ⚠ THE CONTROL. Both doors — `/flows/new`'s canvas (`FlowBuilder`) and
 * `/flows/[id]/builder`'s manual mode (`BuilderShell`) — must read this list
 * rather than keep one. There is deliberately NO palette in chat mode:
 * `ChatWorkbench`'s own header states that adding is the conversation's job and
 * that a palette there would be a second way to grow the flow mid-chat.
 */
describe("one list, read by both doors", () => {
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

  it("no other file declares a FROM_SCRATCH", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((f) => !f.endsWith("components/flow/builder/palette.ts"))
      .filter((f) => /(?:const|let|var)\s+FROM_SCRATCH/.test(code(f)))
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });


});

/**
 * ⚠ **ONE MATCH RULE, EVERY SEARCH BOX.** `StepPalette` and the canvas's
 * insert menu each filtered rows with their own inline `includes` — two
 * spellings of "match" that agree today and drift the day one of them learns
 * trimming, casing, or an empty query. Both call `paletteMatches`, so these
 * pin the rule once, here.
 */
describe("the one match rule", () => {
  it("an empty query matches everything", () => {
    expect(paletteMatches("Tool tool", "")).toBe(true);
    expect(paletteMatches("Tool tool", "   ")).toBe(true);
  });
  it("matches a substring of the label", () => {
    expect(paletteMatches("DB operation query", "oper")).toBe(true);
    expect(paletteMatches("DB operation query", "zzz")).toBe(false);
  });
  it("ignores case and surrounding whitespace in the query", () => {
    expect(paletteMatches("Send mail tool", "MAIL")).toBe(true);
    expect(paletteMatches("Send mail tool", "  mail  ")).toBe(true);
  });
});
