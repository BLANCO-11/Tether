/**
 * A transform's typed PIPELINE lowered to its `expr` (compiled-builder phase 2d), at the one write funnel.
 *
 * Each pipeline is typed against the REAL type of what it reads (the source step's rows, from the catalogue), with the
 * flow's declared inputs in scope. An ill-typed pipeline is refused by stage, never lowered. A typed one becomes exactly
 * the expression `lowerTransformProgram` emits for a drafted reshape:
 *   {{ <rows of from> | jq(<program, inputs spliced with toJson>) | first }}
 * so D-22, the type checker and the compiler judge it like any other `expr` afterwards — the guards stay as a second line.
 * The step's `fields` are the pipeline's output record's keys, so downstream reads are held to them (FT0302).
 */
import { lowerPipeline, pipelineInputType, spliceInputs, tyOfFlowInput, typeTransform, withContext, type Pipeline } from "@foundry/flow-edit";
import type { FlowModel, FlowStep } from "./flow-compiler.service.js";
import { transformRowsPath } from "./flow-compiler.service.js";
import type { CatalogueSnapshot } from "@foundry/flow-edit";

export class PipelineError extends Error {
  constructor(message: string, readonly stepId: string) { super(message); this.name = "PipelineError"; }
}

export function lowerPipelinesWith(model: FlowModel, cat: CatalogueSnapshot): FlowModel {
  const steps = model.steps as FlowStep[];
  if (!steps.some((s) => s.kind === "transform" && Array.isArray((s as { pipeline?: unknown }).pipeline))) return model;
  const inputs = Object.fromEntries((model.inputs ?? []).map((i) => [i.id, tyOfFlowInput(i as never)]));
  const next = steps.map((s) => {
    const p = (s as { pipeline?: Pipeline }).pipeline;
    if (s.kind !== "transform" || !Array.isArray(p)) return s;
    const from = (s as { from?: string }).from;
    const src = from ? steps.find((x) => x.id === from) : undefined;
    if (!from || !src) throw new PipelineError(`transform "${s.id}" has a pipeline but reads no step of this flow (from: ${from ?? "missing"})`, s.id);
    const inTy = pipelineInputType(src as never, cat, model as never);
    if (!inTy) throw new PipelineError(`transform "${s.id}" reads "${from}", which produces no readable rows`, s.id);
    const typed = withContext({ inputs }, () => typeTransform(inTy, p));
    if (!typed.ok) throw new PipelineError(`transform "${s.id}", stage ${typed.at + 1} (${p[typed.at]?.op}): ${typed.error}`, s.id);
    const program = withContext({ inputs }, () => lowerPipeline(inTy, p));
    const rows = transformRowsPath(steps, s.id, from);
    const expr = `{{ ${rows} | jq(${spliceInputs(`(${program}) | if type == "string" then {text: .} else . end`)}) | first }}`;
    const out = typed.ty.t === "List" || typed.ty.t === "Rows" ? typed.ty.of : typed.ty;
    const fields = out.t === "Record" ? Object.keys(out.fields) : undefined;
    const dependsOn = [...new Set([...(s.dependsOn ?? []), from])];
    return { ...s, expr, ...(fields?.length ? { fields } : {}), dependsOn } as FlowStep;
  });
  return { ...model, steps: next };
}
