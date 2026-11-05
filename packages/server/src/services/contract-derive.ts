/**
 * Phase 5 task 1 (D-254) — a code step's INPUT contract is derived from what
 * feeds it, not invented by the drafter.
 *
 * A code step is drafted with typed `inputs` (phase 3 task 6, `055f394`): one
 * binding per contract input, each naming its source. That makes the upstream
 * TYPE exactly knowable — the checker's own `outputOf` over the same catalogue
 * snapshot — so the fragment is told the row it will receive:
 *
 *   rows: array<object>
 *     each element has exactly these keys:
 *       vendor_name: string
 *       amount_cents: number
 *
 * instead of the drafter's `rows: array`, which F1 refused over ("not which
 * fields each grouped vendor must contain") and which invites a guessed column.
 *
 * ⚠ **PROMPT-TIME ONLY**, like `enrichContractWithColumns`: the declared
 * contract — which refusal keys are computed on (D-118) and which is stored —
 * does not move. Only the copy `generateFragment` sees is derived.
 *
 * ⚠ **A type the catalogue cannot see changes nothing.** `Opaque`/`Json` (a
 * tool's body, a named query's rows) leave the declared field as written — the
 * "cannot see, so says nothing" rule every check here follows. The declared
 * NAME and description are always kept; only type, items, format, fields and
 * nullable are replaced, and only when known.
 *
 * A step with a non-blank `inputExpr` (legacy, hand-written) is not derived —
 * its payload is an expression this does not read; the older enrichments
 * still handle it.
 */
import { applyOnNull, convert, outputOf, rowOf, tyOfFlowInput, type CatalogueSnapshot, type Ty } from "@foundry/flow-edit";
import type { FlowModel } from "./flow-compiler.service.js";
import type { ContractField, ContractType, StepContract } from "./step-contract.service.js";

type Shape = Pick<ContractField, "type" | "items" | "format" | "fields" | "nullable">;

/** A checker type as a contract shape, or null when it says nothing. */
export function shapeOfTy(ty: Ty | null | undefined): Shape | null {
  if (!ty) return null;
  switch (ty.t) {
    case "Envelope":
      return shapeOfTy(ty.of);
    case "Option": {
      const inner = shapeOfTy(ty.of);
      return inner ? { ...inner, nullable: true } : null;
    }
    case "Text":
    case "Address":
    case "Key":
      return { type: "string" };
    case "Int":
    case "Number":
      return { type: "number" };
    case "Bool":
      return { type: "boolean" };
    case "Date":
      return { type: "string", format: "date" };
    case "DateTime":
      return { type: "string", format: "datetime" };
    case "Month":
      return { type: "string", format: "month" };
    case "Record": {
      const fields = fieldsOf(ty.fields);
      return fields ? { type: "object", fields } : { type: "object" };
    }
    case "Rows":
    case "List": {
      const el = shapeOfTy(ty.of);
      if (!el) return { type: "array" };
      return { type: "array", items: el.type, ...(el.fields ? { fields: el.fields } : {}) };
    }
    default:
      return null; // Json, Opaque, Never — nothing to say
  }
}

function fieldsOf(fields: Record<string, Ty>): ContractField[] | undefined {
  const out: ContractField[] = [];
  for (const [name, ty] of Object.entries(fields)) {
    const s = shapeOfTy(ty);
    // A key whose type is unknown is still a KEY the row carries — name it `any`.
    out.push({ name, ...(s ?? { type: "any" as ContractType }) });
  }
  return out.length ? out : undefined;
}

/** The type ONE bound source hands the fragment, or null when unknown. */
function sourceTy(
  source: unknown,
  model: FlowModel,
  cat: CatalogueSnapshot,
): Ty | null {
  const src = source as {
    from?: string; stepId?: string; field?: string; inputId?: string;
    transform?: "month" | "date"; onNull?: "skip" | "fail" | Record<string, "skip" | "fail">;
  } | null;
  if (!src) return null;
  if (src.from === "literal") return { t: "Text" };
  if (src.from === "input") {
    const decl = (model.inputs ?? []).find((i) => i.id === src.inputId);
    const ty = decl ? tyOfFlowInput(decl as never) : null;
    // D-272: a cut input reaches the fragment already cut (month → "(month YYYY-MM)").
    return ty && src.transform ? convert(ty, src.transform) : ty;
  }
  if (src.from !== "whole" && src.from !== "step") return null;
  const step = model.steps.find((s) => s.id === src.stepId);
  if (!step) return null;
  const out = outputOf(step as never, cat, model as never);
  if (!out) return null;
  // D-273: a declared null rule means the fragment never sees that null.
  if (src.from === "whole") return applyOnNull(out, src.onNull);
  // `buildCodeInput` projects the column across the rows: a list of it.
  const row = rowOf(out);
  const f = row.t === "Record" ? row.fields[src.field ?? ""] : undefined;
  return f ? applyOnNull({ t: "List", of: f }, src.onNull) : null;
}

export function deriveContractInputs(
  contract: StepContract,
  model: FlowModel,
  cat: CatalogueSnapshot | undefined,
): StepContract {
  if (!cat) return contract;
  const step = model.steps.find((s) => s.id === contract.stepId);
  if (!step || step.kind !== "code") return contract;
  if (typeof step.inputExpr === "string" && step.inputExpr.trim()) return contract;
  const bound = new Map((step.inputs ?? []).map((b) => [b.name, b.source]));
  let changed = false;
  const input = contract.input.map((f) => {
    const shape = shapeOfTy(sourceTy(bound.get(f.name), model, cat));
    if (!shape) return f;
    changed = true;
    const { items: _i, format: _f, fields: _k, nullable: _n, ...kept } = f;
    return { ...kept, ...shape };
  });
  return changed ? { ...contract, input } : contract;
}

/**
 * The catalogue the derivation reads, or `undefined` when it cannot be built.
 *
 * ⚠ Never throws: the derivation is prompt-time enrichment, so a failed read
 * degrades to the declared contract rather than failing a generation — and it
 * LOGS what it degraded from (the `/executions/search` lesson: a silent
 * degrade presents as "the field is just sometimes missing").
 */
export async function catalogueForDerivation(
  workspaceId: string,
  model: FlowModel,
  interfaces: Record<string, unknown>,
): Promise<CatalogueSnapshot | undefined> {
  try {
    const { buildCatalogueSnapshot } = await import("./flow-typecheck.js");
    const cat = await buildCatalogueSnapshot(workspaceId, model, interfaces as never);
    // ⚠ A NAMED QUERY's rows are `Rows<Json>` to the checker, deliberately (D-257).
    // For the fragment prompt only, name the keys its own SELECT lists — the same
    // parser a generated reader's columns come from — so a code step over a named
    // query is told its row's keys (r12 I1: "breach_record_schema"). This copy is
    // the derivation's; the checker never sees it. Types stay unknown (`any`).
    const { datasourceQueryRepo } = await import("../repositories/datasource-query.repo.js");
    const { selectProjection } = await import("./sql-projection.js");
    const { TypeOf: T } = await import("@foundry/flow-edit");
    for (const { datasource, query } of await datasourceQueryRepo.listByWorkspace(workspaceId)) {
      const ref = `${datasource.name}.${query.name}`;
      const sig = cat.refs[ref];
      const cols = sig?.kind === "query" ? selectProjection(query.sqlText) : undefined;
      if (sig && cols?.length) cat.refs[ref] = { ...sig, payload: T.rows(T.record(Object.fromEntries(cols.map((c) => [c, T.opaque()])))) };
    }
    return cat;
  } catch (e) {
    console.warn(`[contract-derive] no catalogue for workspace ${workspaceId}; contracts stay as declared: ${(e as Error).message}`);
    return undefined;
  }
}
