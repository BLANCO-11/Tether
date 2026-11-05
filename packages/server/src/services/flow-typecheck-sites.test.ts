import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHERE the type checker's gate runs — phase 2 tasks 3 and 5, read off disk.
 *
 * Task 3 (D-245): an ARMED revision is never re-checked. Approval, the
 * staleness sweep, `begin`, replay and the trigger scheduler all act on a
 * revision that was checked when it was WRITTEN; re-running a checker whose
 * rules move (every new rule is a new refusal) against an armed revision would
 * turn a rule change into a silent disarm of a flow nobody edited — the
 * staleness sweep's I-14 failure, with the checker as the trigger. So the gate
 * is called from the write path and the builders' pre-save loops, and from
 * nowhere else.
 *
 * Task 5: `writeRevision` is the ONE place a SAVE is refused on type errors.
 * The drafter's loop, `authorFlow`'s final stage and chat's gates are feedback
 * (a redraft, a correction, a refusal before any write); they are allowed to
 * disagree in timing, never in rule, because they call the same function.
 *
 * ⚠ Comments are STRIPPED before matching (I-62): these modules explain the
 * gate in prose that names it, and a scan that counted a docblock would pass
 * with the call deleted.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const FILES = walk(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), src: code(readFileSync(p, "utf8")) }));

/** file → number of CALLS (not the definition, not an import). */
function callSites(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FILES) {
    const n = f.src.match(re)?.length ?? 0;
    if (n) out[f.rel] = n;
  }
  return out;
}

describe("the gate's call sites (D-245, task 3)", () => {
  it("CONTROL: the scan read the tree and finds calls at all", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(Object.keys(callSites(/\bblockingOf\(/g)).length).toBeGreaterThan(0);
  });

  it("the save gate's rule (`blockingOf`) is called from the funnel and nowhere else (D-318)", () => {
    // `blockingDiagnostics` — the drafter's pre-save loop's entry to the same rule — went with the drafter (phase 8, D-333).
    expect(callSites(/\bblockingOf\(model,/g)).toEqual({ "services/flow.service.ts": 1 });
    // `writeRevision` is the one PRODUCTION caller; `kestra-bindings` calls the same funnel as its oracle, as the property test
    // does (a harness, never on a request path) — named here so a third caller still turns this red.
    expect(callSites(/await\s+gateRevisionModel\(/g)).toEqual({ "services/flow.service.ts": 1, "scenarios/kestra-bindings.ts": 1 });
  });

  it("⚠ no approval, sweep, begin, replay or scheduler module reaches the checker at all", () => {
    const armedPath = FILES.filter((f) =>
      /^(services\/(flow-approval|step-approval|approval-queue|flow-replay|tenant-budget|operational-signals)\.service|services\/trigger-scheduler|routes\/executions|routes\/steps)\.ts$/.test(f.rel),
    );
    // CONTROL: the modules the claim is about exist under these names — a
    // rename must turn this red rather than leave it asserting over nothing.
    expect(armedPath.map((f) => f.rel).sort()).toEqual([
      "routes/executions.ts",
      "routes/steps.ts",
      "services/approval-queue.service.ts",
      "services/flow-approval.service.ts",
      "services/flow-replay.service.ts",
      "services/operational-signals.service.ts",
      "services/step-approval.service.ts",
      "services/tenant-budget.service.ts",
      "services/trigger-scheduler.ts",
    ]);
    for (const f of armedPath) {
      expect(f.src, f.rel).not.toMatch(/flow-typecheck/);
      expect(f.src, f.rel).not.toMatch(/\b(checkFlow|typecheckFlow|typecheckWith|blockingOf|localBlockingDiagnostics)\(/);
      // Nor through the write path: an armed revision is never RE-WRITTEN.
      expect(f.src, f.rel).not.toMatch(/\bwriteRevision\(|flowService\.(create|saveRevision)\(/);
    }
  });
});

describe("writeRevision is the one save gate (task 5)", () => {
  const svc = FILES.find((f) => f.rel === "services/flow.service.ts")!.src;
  // Since D-318 the checks live in `gateRevisionModel`, which writeRevision calls once (asserted above and here).
  const start = svc.indexOf("export async function gateRevisionModel(");
  const body = svc.slice(start);
  const write = svc.slice(svc.indexOf("async writeRevision("), svc.indexOf("async create(", svc.indexOf("async writeRevision(")));

  it("CONTROL: the method was found and bounded", () => {
    expect(start).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toMatch(/flowCompiler\.compile\(/);
    expect(write).toMatch(/await gateRevisionModel\(model, \{/);
  });

  it("contains exactly ONE type gate", () => {
    expect(body.match(/blockingOf\(model, await g\.catalogue\(model\)\)/g)?.length).toBe(1);
  });

  it("runs it AFTER assertValid and BEFORE the compile", () => {
    const valid = body.indexOf("flowValidator.assertValid(");
    const gate = body.search(/blockingOf\(model, await g\.catalogue/);
    const compile = body.indexOf("flowCompiler.compile(");
    expect(valid).toBeGreaterThan(0);
    expect(valid).toBeLessThan(gate);
    expect(gate).toBeLessThan(compile);
  });
});
