/**
 * Pi-built flows as Foundry flows (plans/pi-runtime-2026-10-09, P3).
 *
 * A `runtime: "foundry"` flow's revision stores its BUNDLE — `workflow.json` + the step files — in `model_json`.
 * There is no compile and no deploy: nothing here touches Kestra, which is what broke the P0 save → run path.
 * Revisions stay insert-only and approval still binds to a revision number (§6.5); the hashes are of the bundle,
 * so "the thing a reviewer read is the thing that runs" is checkable the same way it is for a compiled flow.
 */
import { actsAsOwner, type PiRunAs } from "./run-as.service.js";
import { createHash, randomUUID } from "node:crypto";
import { flowRepo } from "../repositories/flow.repo.js";
import { engineIdOf } from "./flow-engine-id.js";
import type { RevisionAuthor } from "./revision-author.js";
import { readProblems, type PiBundle } from "./flow-runner.service.js";

export const FOUNDRY_RUNTIME = "foundry";

/** What `model_json` holds for a foundry flow. `runtime` is inside it too, so a revision read alone says what it is. */
export type PiRevisionModel = {
  runtime: "foundry";
  workflow: PiBundle["workflow"];
  files: Record<string, string>;
  /** Per connected service it uses, the connection it runs through — chosen by a person, set by the server (8.6). */
  accounts?: Record<string, PiRunAs>;
};

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");

export function isPiModel(model: unknown): model is PiRevisionModel {
  return !!model && typeof model === "object" && (model as { runtime?: unknown }).runtime === FOUNDRY_RUNTIME;
}

class PiFlowError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export const piFlowService = {
  /**
   * Save a bundle as the flow's next draft revision, creating the flow on first save.
   * `compiled_yaml_hash` = the whole bundle (what runs); `structure_hash` = workflow.json alone (the shape).
   */
  async save(input: {
    workspaceId: string;
    flowId: string | null;
    bundle: PiBundle;
    name: string;
    description: string | null;
    author: RevisionAuthor;
    /** Whose account each service runs as (run-as.service.ts). Part of what is approved: a change is a new revision. */
    accounts?: Record<string, PiRunAs>;
  }): Promise<{ flowId: string; revision: number }> {
    const model: PiRevisionModel = {
      runtime: "foundry",
      workflow: input.bundle.workflow,
      files: input.bundle.files,
      ...(input.accounts && Object.keys(input.accounts).length ? { accounts: input.accounts } : {}),
    };
    // The executor's own read rules, applied at save too — the same function a run applies (readProblems).
    const reads = await readProblems(input.workspaceId, input.bundle.workflow);
    if (reads.length) throw new PiFlowError(`not saved — the workflow's reads do not pass their checks:\n- ${reads.join("\n- ")}`, 422);

    let flow = input.flowId ? await flowRepo.get(input.workspaceId, input.flowId) : undefined;
    if (input.flowId && !flow) throw new PiFlowError("flow not found", 404);
    if (flow && flow.runtime !== FOUNDRY_RUNTIME) {
      throw new PiFlowError("this flow was built with the previous builder and cannot be edited here", 409);
    }
    if (!flow) {
      const id = randomUUID();
      const taken = new Set((await flowRepo.listByWorkspace(input.workspaceId)).map((f) => f.name));
      let name = input.name.trim() || "Untitled automation";
      const base = name;
      for (let n = 2; taken.has(name) && n <= 100; n++) name = `${base} ${n}`;
      flow = await flowRepo.create({
        id,
        workspaceId: input.workspaceId,
        name,
        description: input.description,
        kestraFlowId: engineIdOf(id),
        draftRevision: 0,
        status: "draft",
        runtime: FOUNDRY_RUNTIME,
      });
      if (!flow) throw new PiFlowError("could not create the flow", 500);
    }

    const revision = flow.draftRevision + 1;
    await flowRepo.insertRevision({
      flowId: flow.id,
      revision,
      modelJson: model,
      compiledYamlHash: sha(model),
      structureHash: sha(model.workflow),
      createdBy: input.author.createdBy,
      createdByKind: input.author.createdByKind,
    });
    // Same rule `writeRevision` follows: an armed flow edited past its approval keeps firing the approved
    // revision and says so (`draft_pending`), never silently `draft`.
    await flowRepo.update(flow.id, {
      draftRevision: revision,
      status: flow.armedRevision != null ? "draft_pending" : "draft",
      // ⚠ Runs on its owner's own account (sharing-boundaries D4): nobody else may edit what acts as them.
      ...(actsAsOwner(input.accounts) ? { othersMayEdit: false } : {}),
      ...(input.description != null && !flow.description ? { description: input.description } : {}),
    });
    return { flowId: flow.id, revision };
  },

  /** The bundle at a revision (default: the draft) — what a session is rebuilt from and what a run executes. */
  async load(workspaceId: string, flowId: string, revision?: number): Promise<{ flow: NonNullable<Awaited<ReturnType<typeof flowRepo.get>>>; revision: number; model: PiRevisionModel }> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw new PiFlowError("flow not found", 404);
    if (flow.runtime !== FOUNDRY_RUNTIME) {
      throw new PiFlowError("this flow was built with the previous builder and cannot be opened here", 409);
    }
    const rev = revision ?? flow.draftRevision;
    const row = await flowRepo.getRevision(flow.id, rev);
    if (!row || !isPiModel(row.modelJson)) throw new PiFlowError(`revision ${rev} of this flow has no Forge bundle`, 409);
    return { flow, revision: rev, model: row.modelJson };
  },
};

export { PiFlowError };

/** Every node at any depth — loops' steps and branch paths included. */
export function nodesIn(nodes: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const n of Array.isArray(nodes) ? (nodes as Array<Record<string, unknown>>) : []) {
    out.push(n);
    out.push(...nodesIn(n.steps));
    for (const arm of Array.isArray(n.branch) ? (n.branch as Array<Record<string, unknown>>) : []) out.push(...nodesIn(arm.steps));
  }
  return out;
}

/**
 * The catalogue refs a Forge workflow depends on, for the approval fingerprint and the staleness sweep (P5): every
 * tool a step `uses`, and every saved reader a read names. A workflow's own SQL names a datasource, not a ref.
 */
export function forgeRefsOf(model: PiRevisionModel): string[] {
  const tools = nodesIn(model.workflow.steps).flatMap((n) =>
    (Array.isArray(n.uses) ? (n.uses as unknown[]) : []).filter((u): u is string => typeof u === "string" && u.startsWith("tool:")).map((u) => u.slice(5)),
  );
  const readers = Object.values(model.workflow.reads ?? {})
    .map((r) => (r as { ref?: unknown })?.ref)
    .filter((r): r is string => typeof r === "string");
  return [...new Set([...tools, ...readers])];
}

/** A Forge workflow's inputs in the shape the trigger and schedule code reads a compiled model's (P5). */
export function forgeDeclared(model: PiRevisionModel): {
  inputs: Array<{ id: string; type: string; required: boolean; defaults?: string }>;
  steps: Array<Record<string, unknown>>;
  schedule?: { cron?: string; timezone?: string };
} {
  const inputs = Object.entries((model.workflow.inputs ?? {}) as Record<string, { type?: string; default?: unknown } | null>).map(([id, d]) => {
    const has = !!d && typeof d === "object" && "default" in d && d.default !== undefined;
    return { id, type: String(d?.type ?? "string"), required: !has, ...(has ? { defaults: String(d!.default) } : {}) };
  });
  return { inputs, steps: [], ...(model.workflow.schedule ? { schedule: model.workflow.schedule } : {}) };
}

/** A scheduled Forge workflow fires with nobody to ask: every input it declares needs a default. */
export function forgeScheduleRefusal(model: PiRevisionModel): string | null {
  if (!model.workflow.schedule?.cron) return null;
  const missing = forgeDeclared(model).inputs.filter((i) => i.required).map((i) => i.id);
  return missing.length
    ? `this workflow runs on a schedule, so nobody is there to give ${missing.map((m) => `"${m}"`).join(", ")} — give each a default (or have a step work it out) before approving it`
    : null;
}

/**
 * The runtime seam's refusal (pi-runtime P3). A Kestra-only path reached with a `foundry` flow refuses BY NAME
 * instead of compiling a Pi bundle as a FlowModel and failing somewhere opaque. Each call site is a path P4/P5
 * gives a Foundry-runner implementation; until then the refusal says where the working path is.
 */
export function refuseFoundryRuntime(flow: { runtime: string; name: string }, action: string): void {
  if (flow.runtime !== FOUNDRY_RUNTIME) return;
  throw Object.assign(
    new Error(`“${flow.name}” is built with Forge and runs on Foundry's runner — ${action} is not available for it yet. Test it from its builder.`),
    { statusCode: 409 },
  );
}
