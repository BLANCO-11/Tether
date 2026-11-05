/**
 * Phase Y task Y1 (D-343): the goal format is pinned to the engine's moves. Every `EngineOp` the engine defines is either EMITTED by
 * the goal pipeline (the solver, the build, the builder service, the table readers — read off disk, so a rename cannot pass by
 * scanning nothing) or DECLARED not-from-a-goal with its reason. A new engine op fails this test until someone decides which it is —
 * the gap that let if/else fall out of chat (I-310) becomes a red build instead of a user report.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = (p: string) => resolve(__dirname, p);
const OPS_SRC = readFileSync(resolve(__dirname, "../../../../flow-edit/src/engine/ops.ts"), "utf8");
const union = OPS_SRC.slice(OPS_SRC.indexOf("export type EngineOp ="), OPS_SRC.indexOf("export interface When"));
const ENGINE_OPS = [...union.matchAll(/\{ op: "([a-z_]+)"/g)].map((m) => m[1]!);
const PIPELINE = ["solver.ts", "build.ts", "builder.service.ts", "table-readers.ts"].map((f) => readFileSync(here(f), "utf8")).join("\n");

/** Ops a GOAL never asks for — each with why. Edits reach these through chat's edit path (phase X) or the canvas. */
const NOT_FROM_A_GOAL: Record<string, string> = {
  remove_input: "an edit: removing what is there (phase X, a listed canvas action)",
  retest: "an edit: changing what an EXISTING condition compares (phase C, a listed canvas action) — a goal places its condition with its value",
  unbind: "an edit: clearing what is set (phase X)",
  retype_input: "an edit: asking for an existing input as another type (2026-10-01) — a goal declares its input with its type",
  remove_step: "an edit: removing a step (phase X, confirmed first)",
  choose_reader: "the canvas's reader slot, chosen after the step exists; a goal names its reader when it adds it",
  // I-317 — owed: a goal like "…whichever list ran, then email it" joins two paths into one tail. Declared, not silent: a goal that
  // needs it is read back with the tail stated unmet (the unaccounted-clause rule), never built as a guess.
  add_merge: "OWED (I-317): a shared tail after a condition's paths — not yet in the wiring",
  // Phase F (D-381): a goal's "for each … then …" reaches `add_loop` and `close_loop` through the wiring's `each`; a loop's settings
  // and a changed result are edits.
  set_loop: "an edit: a loop's settings (items at once, keep going or stop) — a goal's loop starts at the defaults",
  set_loop_result: "an edit: which body step is each row's result, once the loop has an output",
};

describe("the goal format reaches every engine move (D-343)", () => {
  it("the scan finds the engine's ops and the pipeline's source — a control, so an empty read cannot pass", () => {
    expect(ENGINE_OPS.length).toBeGreaterThanOrEqual(16);
    expect(ENGINE_OPS).toEqual(expect.arrayContaining(["add_reader", "add_call", "add_branch", "add_otherwise", "add_gate"]));
    expect(PIPELINE.length).toBeGreaterThan(20_000);
  });

  it("every engine op is emitted by the goal pipeline or declared not-from-a-goal, with a reason", () => {
    const undecided = ENGINE_OPS.filter((op) => !NOT_FROM_A_GOAL[op] && !PIPELINE.includes(`op: "${op}"`));
    expect(undecided, `engine ops no goal can reach and nobody declared: ${undecided.join(", ")}`).toEqual([]);
  });

  it("the declared set names only ops that exist, and none the pipeline already emits (a stale declaration hides a reach)", () => {
    for (const op of Object.keys(NOT_FROM_A_GOAL)) {
      expect(ENGINE_OPS, `${op} is declared but is not an engine op`).toContain(op);
      expect(PIPELINE.includes(`op: "${op}"`), `${op} is emitted by the pipeline; drop its declaration`).toBe(false);
    }
  });

  it("phase F's reach: a for-each and its output come from a goal (F5)", () => {
    for (const op of ["add_loop", "close_loop"]) expect(PIPELINE.includes(`op: "${op}"`), op).toBe(true);
  });

  it("phase Y's reach: conditions, their otherwise, and approvals come from a goal", () => {
    for (const op of ["add_branch", "add_otherwise", "add_gate"]) expect(PIPELINE.includes(`op: "${op}"`), op).toBe(true);
  });
});
