/**
 * The manual builder's server half (compiled-builder phase 7, D-328/D-329). The canvas is a second front end on the engine:
 * every gesture is a `CanvasAction` the engine listed (`@foundry/flow-edit`'s `canvasActions`), taken HERE against this
 * workspace's catalogue — the one that carries `renderInputs`, which no client has — and saved through the same funnel as
 * every other revision (`writeRevision`) or as the flow's incomplete working copy (`saveIncomplete`).
 *
 * Stateless between calls, and a client cannot hand it a state the engine did not produce (D-329): every state it returns is
 * SIGNED (an HMAC over the workspace, the flow and the state), and a state posted back must carry that signature. A signed
 * state is still re-judged by `checkState` against the catalogue as it is NOW, so a catalogue that moved under an open canvas
 * is refused by name, never built on.
 *
 * ⚠ Nothing here accepts an op, an expression or a step from the client — only an action id from the list the engine made for
 * the posted state, and a typed VALUE for a slot, which `apply` judges (the constants rule).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canvasActions, canvasApply, checkState, emptyFlow, errorsOf, flowShape, holesOf, unreadableByPort, type CanvasAction, type StepShape, type CatalogueSnapshot, type Diagnostic, type EFlow } from "@foundry/flow-edit";
import { config } from "../../config/index.js";
import { flowService } from "../flow.service.js";
import { flowRepo } from "../../repositories/flow.repo.js";
import { engineIdOf } from "../flow-engine-id.js";
import type { FlowModel } from "../flow-compiler.service.js";
import type { RevisionAuthor } from "../revision-author.js";
import { builderCatalogue, editStart, lowerTableReaders } from "./builder.service.js";
import { isLocalRef, localClauses } from "./local-readers.js";
import type { BuilderCatalogue } from "./goal-spec.js";
import type { ReadbackClause } from "../db-operation-readback.js";

const httpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** A key of its own, derived — never the credential key itself, so a signature here is useless anywhere else. */
const KEY = createHmac("sha256", config.credentialEncKey).update("foundry-canvas-state-v1").digest();
export const signState = (workspaceId: string, flowId: string, state: EFlow) => createHmac("sha256", KEY).update(`${workspaceId}\n${flowId}\n${JSON.stringify(state)}`).digest("base64url");
function verified(workspaceId: string, flowId: string, state: unknown, sig: unknown): EFlow {
  if (typeof sig !== "string" || !state || typeof state !== "object") throw httpError("a canvas state is the one the server last returned, with its signature", 400);
  const want = Buffer.from(signState(workspaceId, flowId, state as EFlow)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw httpError("this canvas state was not produced by the server for this flow — reload the flow", 400);
  return state as EFlow;
}

/** An action as the client sees it: where it sits, its words, and — for a slot — the type and what to type. Never a function. */
export interface ActionView { id: string; where: CanvasAction["where"]; kind?: CanvasAction["kind"]; label: string; op?: CanvasAction["op"]; slot?: { ty: unknown; what: string }; decide?: CanvasAction["decide"]; split?: CanvasAction["split"]; retest?: CanvasAction["retest"]; group?: string }
const viewOf = (a: CanvasAction): ActionView => ({ id: a.id, where: a.where, ...(a.kind ? { kind: a.kind } : {}), label: a.label, ...(a.op ? { op: a.op } : {}), ...(a.slot ? { slot: { ty: a.slot.ty, what: a.slot.what } } : {}), ...(a.decide ? { decide: a.decide } : {}), ...(a.split ? { split: a.split } : {}), ...(a.retest ? { retest: a.retest } : {}), ...(a.group ? { group: a.group } : {}) });

export interface CanvasView {
  state: EFlow;
  sig: string;
  actions: ActionView[];
  diagnostics: Diagnostic[];
  /** Complete: no holes — saving it writes a revision. */
  complete: boolean;
  /** Present when this is the flow's WORKING COPY (no revision holds it yet), with what the goal asked that it does not do. */
  working?: { notBuilt: string[] };
  /** Unset ports the receiver fills with whoever starts the run — shown as that, never as empty. */
  requesterPorts: Array<{ stepId: string; port: string }>;
  /** Each step's structure (phase Z, I-320): inputs with types and values, output fields with types, a condition's paths, who reads it. */
  shape: Record<string, StepShape>;
  /** Per input (`step.port`): every step it may NOT read, with the engine's reason — shown greyed in the picker (phase C). */
  unreadable: Record<string, Array<{ stepId: string; why: string }>>;
  /**
   * Per reader step that carries its own query (a read written for this flow, or a table reader): the query as a person reads it —
   * the form's readback, written by code — and as it runs: the SQL `compileOperation` wrote, with its parameters in order.
   */
  queries?: Record<string, QueryView>;
}
export interface QueryView { kind: "written" | "table"; datasource: string; clauses: ReadbackClause[]; sql: string; params: string[] }

/** The query each reader step runs, from the catalogue's own record of it — never re-derived from text. */
export function queriesOf(state: EFlow, items: BuilderCatalogue): Record<string, QueryView> {
  const out: Record<string, QueryView> = {};
  for (const s of state.steps) {
    const ref = s.kind === "datasource" ? s.ref : undefined;
    const t = ref ? items.tables?.[ref] : undefined;
    if (!ref || !t) continue;
    out[s.id] = { kind: isLocalRef(ref) ? "written" : "table", datasource: t.datasource, clauses: localClauses(t.spec as never), sql: t.sql, params: t.paramOrder ?? [] };
  }
  return out;
}

function viewFor(workspaceId: string, flowId: string, state: EFlow, cat: CatalogueSnapshot, items?: BuilderCatalogue): CanvasView {
  const diagnostics = checkState(state, cat);
  const errors = errorsOf(diagnostics);
  if (errors.length) throw httpError(`this state no longer checks against the workspace's catalogue: ${errors.map((d) => d.message).join(" · ")}`, 409);
  // An unset port its receiver fills with the run's requester (`to` on the mail tool): not empty, and said so on screen.
  const requesterPorts = state.steps.flatMap((s) => s.kind !== "tool" ? [] : (cat.refs[s.ref]?.params ?? [])
    .filter((p) => p.fallsBackToRequester && !s.inputs.some((b) => b.name === p.name && b.source))
    .map((p) => ({ stepId: s.id, port: p.name })));
  const queries = items ? queriesOf(state, items) : {};
  return { state, sig: signState(workspaceId, flowId, state), actions: canvasActions(state, cat).map(viewOf), diagnostics, complete: !holesOf(diagnostics).length, requesterPorts, shape: flowShape(state, cat), unreadable: unreadableByPort(state, cat), ...(Object.keys(queries).length ? { queries } : {}) };
}

/**
 * The state an editor opens on: the flow's incomplete working copy when it has a current one, else its draft as the engine reads
 * it, else (no steps) an empty flow. A draft the engine cannot read — written before the compiled builder, with raw expressions
 * — is `{legacy}`, stated: it cannot be edited by construction, and it is never re-expressed silently. Shared by the canvas and
 * by chat's edits (phase X), so both edit the same state.
 */
export async function loadState(workspaceId: string, flowId: string, cat: CatalogueSnapshot): Promise<{ state: EFlow; working?: { notBuilt: string[] } } | { legacy: string }> {
  const inc = await flowService.getIncomplete(workspaceId, flowId);
  // The working copy, with what the goal asked for that it does not do (I-299's `unmet`, from the build that saved it) — so a
  // screen can show unfinished work AS unfinished, even when no hole is left open (I-311, D-342).
  if (inc && !inc.stale && !errorsOf(inc.diagnostics).length) {
    const unmet = (inc.build as { trace?: { unmet?: unknown } } | undefined)?.trace?.unmet;
    return { state: inc.model, working: { notBuilt: Array.isArray(unmet) ? unmet.filter((x): x is string => typeof x === "string") : [] } };
  }
  let start: EFlow | null;
  try { start = (await editStart(workspaceId, flowId, cat, { resuming: true })).start; }
  catch (e) { if ((e as { statusCode?: number }).statusCode === 409) return { legacy: (e as Error).message }; throw e; }
  const flow = await flowRepo.get(workspaceId, flowId);
  return { state: start ?? emptyFlow(flow!.kestraFlowId) };
}

/** The state a canvas opens on — `loadState`, signed. */
export async function canvasOpen(workspaceId: string, flowId: string): Promise<CanvasView | { legacy: string }> {
  const { items, cat } = await builderCatalogue(workspaceId, { flowId });
  const loaded = await loadState(workspaceId, flowId, cat);
  return "legacy" in loaded ? loaded : { ...viewFor(workspaceId, flowId, loaded.state, cat, items), ...(loaded.working ? { working: loaded.working } : {}) };
}

/** Take one listed action on a signed state. A refusal (a typed value that does not fit) is `{refused}`, and nothing moves. */
export async function canvasAct(workspaceId: string, flowId: string, body: { state?: unknown; sig: unknown; actionId: string; value?: string }): Promise<CanvasView | { refused: string }> {
  const state = verified(workspaceId, flowId, body.state, body.sig);
  const { items, cat } = await builderCatalogue(workspaceId, { flowId });
  if (errorsOf(checkState(state, cat)).length) throw httpError("the workspace's catalogue changed and this state no longer checks — reload the flow", 409);
  const a = canvasActions(state, cat).find((x) => x.id === body.actionId);
  if (!a) throw httpError(`\`${body.actionId}\` is not an action on this state`, 400);
  const r = canvasApply(state, cat, a, body.value);
  if (!r.ok) return { refused: r.error };
  return viewFor(workspaceId, flowId, r.flow, cat, items);
}

/**
 * Save a signed state: complete → a REVISION through `writeRevision` (origin `canvas`), and the working copy is dropped;
 * incomplete → the flow's working copy (holes and all, D-319). Invalid never reaches either — `checkState` first, and then
 * the funnel's own gate.
 */
export async function canvasSave(workspaceId: string, flowId: string, body: { state?: unknown; sig: unknown }, author: RevisionAuthor): Promise<{ status: "complete"; revision: number } | { status: "incomplete"; holes: number }> {
  return saveState(workspaceId, flowId, verified(workspaceId, flowId, body.state, body.sig), author, "canvas");
}

/**
 * The one save of an edited engine state — the canvas's and chat's (phase X): complete → a revision through `writeRevision`, and
 * the working copy is dropped; incomplete → the working copy. `checkState` first, then the funnel's own gate.
 */
export async function saveState(workspaceId: string, flowId: string, state: EFlow, author: RevisionAuthor, origin: "canvas" | "chat"): Promise<{ status: "complete"; revision: number } | { status: "incomplete"; holes: number }> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) throw httpError("flow not found", 404);
  const { items, cat } = await builderCatalogue(workspaceId, { flowId });
  const ds = checkState(state, cat);
  if (errorsOf(ds).length) throw httpError("the workspace's catalogue changed and this state no longer checks — reload the flow", 409);
  // A table reader (D-311) carries its own statement once lowered; the funnel's catalogue types it from that, so BOTH saves
  // store the lowered state (I-304: the working copy was refused as "not a component" without it).
  const lowered = lowerTableReaders(state, items);
  if (holesOf(ds).length) {
    const saved = await flowService.saveIncomplete(workspaceId, flowId, lowered);
    return { status: "incomplete", holes: holesOf(saved.diagnostics).length };
  }
  const model = { ...(lowered as unknown as FlowModel), id: flow.kestraFlowId };
  const { revision } = await flowService.writeRevision(workspaceId, flow, model, author, {}, false, { origin });
  await flowService.clearIncomplete(workspaceId, flowId);
  return { status: "complete", revision: revision.revision };
}

/**
 * A new flow built by hand: an empty flow row (no revision, nothing deployed) whose engine id is its own uuid from the start, as
 * the builder's unfinished flows are — so the revision that completes it deploys under exactly this id. The canvas then opens
 * on it like any other flow.
 */
export async function canvasCreate(workspaceId: string, name: string): Promise<{ flowId: string }> {
  const id = randomUUID();
  const created = await flowRepo.create({ id, workspaceId, name, description: null, kestraFlowId: engineIdOf(id), draftRevision: 0, status: "draft", designSelection: null });
  if (!created) throw httpError("could not create the flow", 500);
  return { flowId: id };
}
