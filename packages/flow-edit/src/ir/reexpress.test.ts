/**
 * The phase-2 exit gate against LOCAL jq (the fast loop). `kestra-reexpress.ts` runs the same judgement on the engine,
 * which is the authority (jackson-jq).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { engineEqual } from "./admission.js";
import { evaluatePipeline, lowerPipeline, typeTransform } from "./combinators.js";
import { judgeReexpressions, REEXPRESSIONS, type ProgramRunner } from "./reexpress.js";

const localJq: ProgramRunner = async (program, input) => {
  const out = execFileSync("jq", ["-c", program], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  return out === "" ? null : JSON.parse(out);
};
const deps = { lower: lowerPipeline, evaluate: evaluatePipeline, type: typeTransform, equal: engineEqual };

describe("phase 2 exit gate — the correct baseline transforms, re-expressed", () => {
  it("covers all 41, and every one is either expressed or refused with a reason", () => {
    expect(REEXPRESSIONS.length).toBe(41);
    expect(new Set(REEXPRESSIONS.map((c) => c.id)).size).toBe(41);
  });
  it("every expressed transform agrees with the jq it replaces (or diverges exactly where declared), and is sound", async () => {
    const r = await judgeReexpressions(localJq, deps);
    const failures = r.results.filter((x) => !x.ok).map((x) => `${x.id} / ${x.fixture}: ${x.detail}`);
    expect(failures).toEqual([]);
    expect(r.expressed).toBe(33);
    expect(r.notAdmitted.length).toBe(8);
  }, 60_000);
  it("⚠ NEGATIVE CONTROL: a wrong lowering is caught (unsound), and a wrong pipeline is caught (disagrees)", async () => {
    const wrongLower = { ...deps, lower: (ty: Parameters<typeof lowerPipeline>[0], p: Parameters<typeof lowerPipeline>[1]) => lowerPipeline(ty, p).replace(/ > /g, " >= ") };
    const r1 = await judgeReexpressions(localJq, wrongLower);
    expect(r1.results.some((x) => !x.ok && /UNSOUND/.test(x.detail ?? ""))).toBe(true);
    // A pipeline that forgets one filter still types and is sound — only the comparison with the original can catch it.
    const r15 = REEXPRESSIONS.find((c) => c.id === "R15#1 vip_breaches")! as Extract<(typeof REEXPRESSIONS)[number], { pipeline: unknown }>;
    const r2 = await judgeReexpressions(localJq, deps, [{ ...r15, pipeline: r15.pipeline.filter((s) => !(s.op === "filter" && "cmp" in s.where && s.where.cmp === "eq")) }]);
    expect(r2.results.some((x) => !x.ok && /original/.test(x.detail ?? ""))).toBe(true);
  }, 60_000);
});
