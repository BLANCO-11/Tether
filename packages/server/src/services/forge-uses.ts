/**
 * What a Forge workflow's run may touch: exactly what its workflow.json declares (plugins phase 9, 2026-10-29).
 *
 * A step may only use what its `uses` lists (`read:<name>`, `tool:<name>`, `file:<name>`). The `foundry` library
 * refuses an undeclared use inside the step — but the step's own code runs in that same process and holds the run's
 * token, so that refusal is a courtesy, not a control: a step could call the step API directly for any tool, any
 * datasource and any file in the workspace. So the SERVER holds every call from a runner execution to the union of
 * its workflow's declared uses, from the job it stored when the run started (`flow_executions.runner_job`), never
 * from the request.
 *
 * This is what makes "what a reviewer read in workflow.json is what the run can do" true, and what lets an owner
 * switch on an automation that uses only their own things (`automation-reach.ts` reads the same declarations).
 *
 * The union, not the calling step's own list: the step names itself in the body, which its code controls.
 */
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { RUNNER_EXECUTION_PREFIX, type PiBundle } from "./flow-runner.service.js";
import { nodesIn } from "./pi-flow.service.js";

export type DeclaredUses = { tools: Set<string>; reads: Set<string>; files: Set<string> };

type ReadDecl = { ref?: unknown; datasource?: unknown; sql?: unknown };

/** Every `uses` entry across all steps, at any depth (loops' steps and branch paths included). */
export function declaredUses(workflow: PiBundle["workflow"] | undefined): DeclaredUses {
  const out: DeclaredUses = { tools: new Set(), reads: new Set(), files: new Set() };
  for (const node of nodesIn(workflow?.steps)) {
    for (const u of Array.isArray(node.uses) ? (node.uses as unknown[]) : []) {
      if (typeof u !== "string") continue;
      const at = u.indexOf(":");
      if (at < 1) continue;
      const kind = u.slice(0, at);
      const name = u.slice(at + 1);
      if (kind === "tool") out.tools.add(name);
      else if (kind === "read") out.reads.add(name);
      else if (kind === "file") out.files.add(name);
    }
  }
  return out;
}

/** One call a step makes, as the step API receives it. */
export type StepUse =
  | { kind: "tool"; ref: string }
  | { kind: "read"; ref: string; sql?: string; datasourceRef?: string }
  | { kind: "file"; name: string }
  | { kind: "other"; what: string };

/**
 * Why this call is not one the workflow declared, or null when it is. A read matches a declared, used read by its
 * saved reader (`ref`), or by its own datasource AND its exact statement — the SDK sends `<datasource>.pi:<name>`
 * with the declared SQL, and a different statement under a declared name is not the declared read.
 */
export function useRefusal(workflow: PiBundle["workflow"] | undefined, use: StepUse): string | null {
  const declared = declaredUses(workflow);
  if (use.kind === "tool") {
    return declared.tools.has(use.ref) ? null : `the workflow does not use the tool "${use.ref}" — no step lists "tool:${use.ref}"`;
  }
  if (use.kind === "file") {
    return declared.files.has(use.name) ? null : `the workflow does not use the file "${use.name}" — no step lists "file:${use.name}"`;
  }
  if (use.kind === "read") {
    const reads = (workflow?.reads ?? {}) as Record<string, ReadDecl>;
    for (const name of declared.reads) {
      const d = reads[name];
      if (!d || typeof d !== "object") continue;
      if (typeof d.ref === "string" && d.ref === use.ref && use.sql === undefined) return null;
      if (
        typeof d.datasource === "string" &&
        typeof d.sql === "string" &&
        use.ref === `${d.datasource}.pi:${name}` &&
        use.sql === d.sql &&
        (use.datasourceRef ?? d.datasource) === d.datasource
      ) {
        return null;
      }
    }
    return `the workflow declares no read that is "${use.ref}"${use.sql !== undefined ? " with this statement" : ""}`;
  }
  return `a Forge workflow's steps reach Foundry only through foundry.read, foundry.call and foundry.file — not ${use.what}`;
}

/**
 * The step API's check for one call: null for an execution that is not a Forge run (a Kestra flow's callbacks are
 * bounded by its compiled YAML), otherwise `useRefusal` against the job the run was started with. A runner execution
 * with no stored job refuses — it cannot show what it may use.
 */
export async function refuseUndeclaredUse(flowExecutionId: string, use: StepUse): Promise<string | null> {
  const ex = await flowExecutionRepo.get(flowExecutionId);
  if (!ex || !ex.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)) return null;
  const workflow = (ex.runnerJob as { workflow?: PiBundle["workflow"] } | null)?.workflow;
  if (!workflow) return "this run has no workflow on record, so nothing it may use can be shown";
  return useRefusal(workflow, use);
}
