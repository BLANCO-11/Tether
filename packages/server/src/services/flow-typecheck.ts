/**
 * `typecheckFlow` — the composite checker (phased-typed-build phase 1).
 *
 * Two halves, one output:
 *
 *  1. the TYPED rules in `@foundry/flow-edit`'s `checkFlow` (new — they need
 *     types that did not exist), over a `CatalogueSnapshot` built here from what
 *     the workspace already declares;
 *  2. every EXISTING check, WRAPPED (D-249) and mapped onto the same FT codes —
 *     never re-implemented, because two implementations of one rule drift in
 *     the direction nobody sees (D-197, D-261).
 *
 * ⚠ **Report mode only** (phase 1). Nothing calls this to refuse a revision;
 * `writeRevision` still decides with the checks it has always run. Phase 2
 * makes this the gate.
 */
import { declarationOf, declaredPortTy } from "./tool-declarations.js";
import { tyOfOutputShape, checkFlow, normaliseModel, sortDiagnostics, diag, TypeOf as T, tyOfColumn, tyOfParam, enumValuesOfType, type CatalogueSnapshot, type CheckStep, type Diagnostic, type DiagnosticCode, type PortSig, type RefSig, type Ty } from "@foundry/flow-edit";
import { manifestBuilderService, type RefInterface } from "./manifest-builder.service.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { compileOperation, dialectOf, type SqlDialect } from "./db-operation.service.js";
import { selectProjection } from "./sql-projection.js";
import { SUBJECT_MAX_CHARS } from "./mail-recipients.js";
import { config } from "../config/index.js";
import { PURE_MODEL_CHECKS } from "./flow-model-findings.js";
import { checkFlowOutput, checkFlowParams, checkFlowShape, type FlowFinding } from "./flow-validator.service.js";
import { checkRefOutputFields } from "./flow-ref-columns.js";
import { displayCodeInput, displayParams, validateModel, type FlowModel, type FlowStep } from "./flow-compiler.service.js";

// ── The snapshot ────────────────────────────────────────────────────────────

export function toolSig(ref: string, iface: RefInterface): RefSig {
  // I-292: what the tool DECLARES (`tool-declarations.ts`); this function names no tool.
  const decl = declarationOf(ref, iface.params);
  const params: PortSig[] = iface.params.map((p) => {
    const d = decl.ports?.[p.name];
    const ty = declaredPortTy(tyOfParam(p.type, p.format), d);
    return {
      name: p.name,
      ty,
      required: p.required,
      ...(d?.liftsScalar && ty.t === "List" ? { liftsScalar: true } : {}),
      ...(d?.fallsBackToRequester ? { fallsBackToRequester: true } : {}),
      ...(d?.message ? { message: true } : {}),
      ...(d?.heading ? { heading: true } : {}),
      ...(d?.data ? { data: true } : {}),
      ...(d?.fromStep ? { fromStep: true } : {}),
      ...(d?.needs ? { needs: d.needs } : {}),
      ...(d?.group ? { group: d.group } : {}),
    };
  });
  // ⚠ compiled-builder 2c: the output is what the tool DECLARES (its own `output_schema`, else the endpoint registry).
  // Undeclared ⇒ `Opaque`, which cannot feed a typed port.
  const payload = iface.outputShape ? tyOfOutputShape(iface.outputShape) : T.opaque();
  return { kind: "tool", params, payload, ...(decl.modelText ? { modelText: true } : {}) };
}

/**
 * An operation's result columns, TYPED from the introspected schema — the one
 * implementation, shared by the checker's catalogue and by a reader the skeleton
 * pipeline creates (phase 4 task 3), so a created reader is typed exactly as a
 * saved one would be.
 */
export function operationFields(
  outputColumns: Array<{ alias: string; source: string; type: string | null; nullable?: boolean; unit?: "minutes" | "business_minutes" | "days" }>,
  rows: Awaited<ReturnType<typeof schemaRepo.listByDatasource>>,
): Record<string, Ty> {
  const fields: Record<string, Ty> = {};
  for (const c of outputColumns) {
    const agg = /^(\w+)\(/.exec(c.source)?.[1]?.toLowerCase();
    // ⚠ `nullable` comes from `compileOperation`, the one place that knows the join kinds and the grouping
    // (compiled-builder E0.7 G4/G5, I-270). The schema-row lookup below is only the fallback for a column list that
    // predates it, and it now matches on the schema qualifier too (G7): `hr.staff` and `public.staff` are not one table.
    const parts = c.source.replace(/^\w+\(|\)$/g, "").split(".");
    const [schemaQ, tbl, col] = parts.length >= 3 ? parts.slice(-3) : [undefined, ...parts.slice(-2)];
    const row = rows.find((r) => r.columnName === (col ?? tbl) && (!col || r.entityName === tbl) && (!schemaQ || (r.entitySchema ?? "public") === schemaQ));
    const nullable = c.nullable ?? (row ? row.nullable !== false : true);
    if (agg === "count") { fields[c.alias] = nullable ? T.option(T.int()) : T.int(); continue; }
    const base0 = agg && agg !== "min" && agg !== "max" ? (agg === "sum" || agg === "avg" ? T.number() : T.opaque()) : tyOfColumn(c.type, false, agg ? null : row?.semanticTag ?? null, agg ? null : row?.valueDomain?.values ?? null);
    // builder-behaviour P7 (R23): a computed length of time declares the unit its computation counts in (the compiler's `unit`).
    const base = c.unit ? T.timeIn(base0, c.unit) : base0;
    const ty = nullable && base.t !== "Opaque" ? T.option(base) : base;
    fields[c.alias] = ty;
  }
  return fields;
}

/**
 * `selects` (2026-10-01): the output field an EQUALITY filter on a parameter compares — the column the filter names, as the
 * projection returns it. From the operation's own compiled spec (which column each parameter filters, which alias each column is
 * returned as), so it holds for any tenant's operation; none when the column is not returned or the filter is not an equality.
 */
export function paramsSelecting(
  params: PortSig[],
  paramColumns: Record<string, { schema: string | null; table: string; column: string }>,
  outputColumns: Array<{ alias: string; source: string }>,
  paramOps: Record<string, string>,
  paramEdges: Record<string, NonNullable<PortSig["edge"]>> = {},
): PortSig[] {
  return params.map((p0) => {
    const p = paramEdges[p0.name] ? { ...p0, edge: paramEdges[p0.name] } : p0;
    const at = paramColumns[p.name];
    if (!at || paramOps[p.name] !== "eq") return p;
    const hit = outputColumns.filter((c) => { const parts = c.source.split("."); const [col, tbl, sch] = [parts.at(-1), parts.at(-2), parts.length >= 3 ? parts.at(-3) : undefined]; return col === at.column && tbl === at.table && (!sch || (sch ?? "public") === (at.schema ?? "public")); });
    return hit.length === 1 ? { ...p, selects: hit[0]!.alias } : p;
  });
}

/**
 * compiled-builder I-301: a text parameter an equality filter compares with a column whose value domain is KNOWN takes that
 * domain as a `OneOf` — so a value the column never holds is refused where it is written, and the person is asked with the real
 * values. A column with no known domain leaves the parameter open (read back as unchecked, never as verified).
 */
export function paramsWithDomains(
  params: PortSig[],
  paramColumns: Record<string, { schema: string | null; table: string; column: string }>,
  rows: Awaited<ReturnType<typeof schemaRepo.listByDatasource>>,
): PortSig[] {
  return params.map((p) => {
    const at = paramColumns[p.name];
    if (!at || p.ty.t !== "Text" || p.ty.refine?.length) return p;
    const row = rows.find((r) => r.columnName === at.column && r.entityName === at.table && (r.entitySchema ?? "public") === (at.schema ?? "public"));
    const values = row?.valueDomain?.values?.length ? row.valueDomain.values : enumValuesOfType(row?.columnType);
    return values?.length ? { ...p, ty: T.text([{ r: "OneOf", values: [...values] }]) } : p;
  });
}

export async function buildCatalogueSnapshot(
  workspaceId: string,
  model?: FlowModel,
  prefetched?: Record<string, RefInterface>,
): Promise<CatalogueSnapshot> {
  const ifaces = prefetched ?? (await manifestBuilderService.refInterfaces(workspaceId));
  const refs: Record<string, RefSig> = {};
  const ops = await dbOperationRepo.listByWorkspace(workspaceId);
  const schemaCache = new Map<string, Awaited<ReturnType<typeof schemaRepo.listByDatasource>>>();
  const schemaOf = async (dsId: string) => {
    if (!schemaCache.has(dsId)) schemaCache.set(dsId, await schemaRepo.listByDatasource(dsId));
    return schemaCache.get(dsId)!;
  };

  for (const [ref, iface] of Object.entries(ifaces)) {
    const params: PortSig[] = iface.params.map((p) => ({ name: p.name, ty: tyOfParam(p.type, p.format, p.per), required: p.required }));
    if (iface.kind === "tool") refs[ref] = toolSig(ref, iface);
    // A named query is ALWAYS the DB response as JSON (D-257).
    // A named query is JSON only when it was never DESCRIBED (D-257, superseded where a description exists: I-271).
    else if (iface.kind === "query") refs[ref] = {
      kind: "query",
      params,
      payload: iface.columnTypes?.length
        ? T.rows(T.record(Object.fromEntries(iface.columnTypes.map((c) => [c.name, tyOfColumn(c.type, c.nullable, c.tag)]))))
        : T.rows(T.json()),
    };
    else refs[ref] = { kind: "operation", params: params.map((p, i) => (iface.params[i]?.default ? { ...p, default: iface.params[i]!.default } : p)), payload: T.rows(T.record(Object.fromEntries((iface.columns ?? []).map((c) => [c, T.opaque()])))) };
  }

  // Operations: the columns' TYPES, by compiling the spec against the
  // introspected schema — the same function the visual builder uses.
  for (const { operation, datasource } of ops) {
    const ref = `${datasource.name}.${operation.name}`;
    if (!refs[ref]) continue;
    try {
      const rows = await schemaOf(datasource.id);
      const compiled = compileOperation(operation.specJson as never, rows, { dialect: dialectOf(datasource.type) });
      const fields = operationFields(compiled.outputColumns, rows);
      refs[ref] = { ...refs[ref]!, params: paramsSelecting(paramsWithDomains(refs[ref]!.params, compiled.paramColumns ?? {}, rows), compiled.paramColumns ?? {}, compiled.outputColumns, compiled.paramOps ?? {}, compiled.paramEdges ?? {}), payload: T.rows(T.record(fields)) };
    } catch {
      // A spec that no longer compiles keeps the names-only projection above;
      // that is its own finding elsewhere, never a guess here.
    }
  }

  // D-311 (slice 5d): a reader built from the schema carries its spec. It is typed from that spec — the same compile and the
  // same `operationFields` a saved operation gets — ONLY when the spec compiles to the step's own `sql`; otherwise it falls
  // through to the names-only projection below, and the mismatch is not papered over.
  const specTyped = new Set<string>();
  type SpecStep = { id: string; ref?: string; sql?: string; datasourceRef?: string; sqlSpec?: unknown };
  const specSteps = ((model?.steps ?? []) as unknown as SpecStep[]).filter((s) => s.sqlSpec && s.sql && s.datasourceRef && s.ref);
  if (specSteps.length) {
    const byName = new Map((await datasourceRepo.listByWorkspace(workspaceId)).map((d) => [d.name, d]));
    for (const s of specSteps) {
      const ds = byName.get(s.datasourceRef!);
      if (!ds) continue;
      const dsId = ds.id;
      try {
        const rows = await schemaOf(dsId);
        const typed = specSig(s.sqlSpec as never, rows, dialectOf(ds.type));
        if (typed.sql !== s.sql) continue;
        refs[s.ref!] = typed.sig;
        specTyped.add(s.id);
      } catch {
        // A spec that no longer compiles: names only, below — its own finding elsewhere.
      }
    }
  }

  const stepColumns: Record<string, string[]> = {};
  for (const s of model?.steps ?? []) {
    const sql = (s as { sql?: string }).sql;
    if (sql && !specTyped.has(s.id)) {
      const cols = selectProjection(sql);
      if (cols) stepColumns[s.id] = cols;
    }
  }
  const domains = config.mail?.allowedDomains ?? [];
  return { refs, stepColumns, renderInputs: compilerRenderInputs, ...(domains.length ? { mailAllowedDomains: domains } : {}) };
}

/**
 * A read that carries its own form (`sqlSpec`) — a table reader (D-311) or a read written for one flow — typed EXACTLY as a saved
 * operation is: compiled by `compileOperation`, the sole SQL emitter; its columns typed from the introspected schema
 * (`operationFields`); its parameters from the compiled `paramsSchema`, with the value domains and `selects` a saved operation's get.
 * One function for the builder's catalogue and the save funnel, so the two cannot type one read two ways.
 */
export function specSig(spec: never, rows: Awaited<ReturnType<typeof schemaRepo.listByDatasource>>, dialect: SqlDialect = "postgres"): { sig: RefSig; sql: string; paramOrder: string[]; paramsSchema: Record<string, unknown>; outputColumns: Array<{ alias: string; source: string; type: string | null; nullable?: boolean }>; paramColumns: Record<string, { schema: string | null; table: string; column: string }> } {
  const compiled = compileOperation(spec, rows, { dialect });
  const declared = compiled.paramsSchema as Record<string, { type?: string; format?: string; per?: string; required?: boolean }>;
  const ordered = [...compiled.paramOrder, ...Object.keys(declared).filter((n) => !compiled.paramOrder.includes(n))];
  const base: PortSig[] = ordered.map((name) => ({ name, ty: tyOfParam(declared[name]?.type ?? "string", declared[name]?.format, declared[name]?.per), required: declared[name]?.required !== false }));
  const params = paramsSelecting(paramsWithDomains(base, compiled.paramColumns ?? {}, rows), compiled.paramColumns ?? {}, compiled.outputColumns, compiled.paramOps ?? {}, compiled.paramEdges ?? {});
  return { sig: { kind: "operation", params, payload: T.rows(T.record(operationFields(compiled.outputColumns, rows))) }, sql: compiled.sql, paramOrder: compiled.paramOrder, paramsSchema: compiled.paramsSchema, outputColumns: compiled.outputColumns, paramColumns: compiled.paramColumns ?? {} };
}

/**
 * FT0206's second text (I-204): what the COMPILER would emit for a step's
 * inputs with its hand-written blob removed — the same `displayParams` /
 * `displayCodeInput` `emit` calls, so the checker compares the blob against
 * exactly what the bindings would compile to, never a second render.
 */
export function compilerRenderInputs(step: CheckStep, steps: readonly CheckStep[]): string | null {
  const all = steps as unknown as FlowStep[];
  if (step.kind === "code") return displayCodeInput(step as never, all);
  if (step.kind === "tool" || step.kind === "datasource" || step.kind === "query") return displayParams(step as never, all);
  return null;
}

// ── The existing checks, wrapped (D-249) ───────────────────────────────────

/** Which FT code each registered pure check answers to. A check missing here is FT0999. */
export const PURE_CHECK_CODE: Record<string, DiagnosticCode> = {
  validateModelExpressions: "FT0601",
  checkOutputShapes: "FT0303",
  // Phase 7 (R03): `.results[0]` of a fan-out step — a wrong path into its output.
  checkFanOutFirstResult: "FT0303",
  checkJsonPositions: "FT0603",
  checkPluckedThenJq: "FT0603",
  checkFreeTextInQuotes: "FT0603",
  checkEncodedInQuotes: "FT0603",
  checkTextValueThenJq: "FT0603",
  checkTextToolInput: "FT0505",
  checkBulkToolInput: "FT0505",
  checkConstructedDates: "FT0403",
  checkDeclaredInputs: "FT0204",
  checkStepRefs: "FT0102",
  unknown_binding_step: "FT0102",
  unused_step: "FT0104",
};

const STEP_IN = /step "([^"]+)"/;

function fromFinding(code: DiagnosticCode, f: FlowFinding): Diagnostic {
  return diag(code, f.stepId ? { stepId: f.stepId } : {}, f.message, { note: `existing check \`${f.rule}\``, ...(f.blocking ? {} : { severity: "warning" as const }) });
}

/** Every existing check, as Diagnostics. Pure over (model, interfaces). */
export function wrappedDiagnostics(model: FlowModel, ifaces: Record<string, RefInterface>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const steps = model.steps as unknown as Array<Record<string, unknown>>;
  const declared = (model.inputs ?? []).map((i) => i.id);
  for (const c of PURE_MODEL_CHECKS) {
    const code = PURE_CHECK_CODE[c.name] ?? "FT0999";
    let msgs: string[] = [];
    try { msgs = c.run(steps, declared, model.output); } catch (e) { msgs = [`check \`${c.name}\` threw: ${(e as Error).message}`]; }
    for (const m of msgs) {
      out.push(diag(code, STEP_IN.test(m) ? { stepId: STEP_IN.exec(m)![1] } : {}, m, { note: `existing check \`${c.name}\``, ...(code === "FT0104" ? { severity: "warning" as const } : {}) }));
    }
  }
  for (const f of checkFlowShape(model)) out.push(fromFinding("FT0106", f));
  for (const f of checkFlowOutput(model)) out.push(fromFinding("FT0504", f));
  for (const f of checkFlowParams(model, ifaces)) {
    const code: DiagnosticCode = /missing|required/.test(f.rule) ? "FT0201" : /unknown|undeclared/.test(f.rule) ? "FT0209" : f.rule === "params_not_array" ? "FT0603" : "FT0999";
    out.push(fromFinding(code, f));
  }
  for (const f of checkRefOutputFields(model, ifaces)) out.push(fromFinding("FT0301", f));
  try {
    validateModel(model);
  } catch (e) {
    const m = (e as Error).message;
    const code: DiagnosticCode = /cycle/i.test(m) ? "FT0101" : /nested/i.test(m) ? "FT0701" : /duplicate|not a valid|slug|id /i.test(m) ? "FT0103" : /depends|unknown step|not in this flow/i.test(m) ? "FT0102" : "FT0999";
    out.push(diag(code, STEP_IN.test(m) ? { stepId: STEP_IN.exec(m)![1] } : {}, m, { note: "existing check `validateModel`" }));
  }
  return out;
}

/** One diagnostic per (code, place, message) — the wrap and the typed rules can name the same thing. */
function dedupe(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const k = `${d.code}|${d.span.stepId ?? ""}|${d.span.port ?? ""}|${d.span.field ?? ""}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function typecheckWith(model: FlowModel, cat: CatalogueSnapshot, ifaces: Record<string, RefInterface>): Diagnostic[] {
  return sortDiagnostics(dedupe([...checkFlow(model as never, cat), ...wrappedDiagnostics(model, ifaces)]));
}

export async function typecheckFlow(workspaceId: string, model: FlowModel): Promise<Diagnostic[]> {
  const [cat, ifaces] = await Promise.all([buildCatalogueSnapshot(workspaceId, model), manifestBuilderService.refInterfaces(workspaceId)]);
  return typecheckWith(model, cat, ifaces);
}

/** The gate's rule over a catalogue already in hand: every checker ERROR refuses. The one definition `writeRevision`'s funnel uses. */
export function blockingOf(model: FlowModel, cat: CatalogueSnapshot): Diagnostic[] {
  return checkFlow(model as never, cat).filter((d) => d.severity === "error");
}

/**
 * Codes a LATER edit in the same unit of work can legitimately resolve — a
 * required input bound next, an input declared next, a step added next. A
 * chat turn applying several ops judges each op without them and the final
 * model with them (the `RELATIONAL_CHECKS` rule, one level down).
 */
export const RELATIONAL_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>(["FT0102", "FT0201", "FT0204", "FT0504"]);

// ── Gradual typing for legacy (phase 2 task 2, D-242) ──────────────────────

/**
 * Who produced a revision. Only `drafter` and `chat` are MODEL-authored, and
 * only they are held to D-242 — see `introducedUnsafeSteps`.
 */
/** `builder`: the compiled builder (phase 4) — a model chose every move, so it is held to D-242 like the drafter and chat. */
export type RevisionOrigin = "drafter" | "chat" | "builder" | "canvas" | "import" | "system";

/** The origins D-242 refuses a NEW unsafe block from. A person's save never is. */
export const MODEL_ORIGINS: ReadonlySet<RevisionOrigin> = new Set<RevisionOrigin>(["drafter", "chat", "builder"]);

/**
 * The steps that are the WHOLE-STEP unsafe block: FT0602 with a step and no
 * port — "this step's inputs are one hand-written template". The per-port
 * FT0602s (a key carried only by the blob, a template literal in one binding)
 * are the normaliser's unreadable residue (I-204), not a step a model chose to
 * write untyped, so they stay warnings from every origin.
 *
 * ⚠ Independent of the catalogue: `checkFlow` decides the whole-step form
 * before it reads a port, so an empty snapshot answers it exactly.
 */
export function unsafeStepIds(model: FlowModel, cat: CatalogueSnapshot = { refs: {}, stepColumns: {} }): Set<string> {
  return new Set(
    checkFlow(model as never, cat)
      .filter((d) => d.code === "FT0602" && d.span.stepId && !d.span.port)
      .map((d) => d.span.stepId!),
  );
}

/**
 * D-242: a MODEL may not INTRODUCE an unsafe block. A step that is unsafe now
 * and was not unsafe (or did not exist) in the flow's previous revision comes
 * back as an ERROR; one inherited from the previous revision does not — legacy
 * stays a warning until somebody rewrites it, which is what gradual typing
 * means. Pure; `previous` undefined is a first revision.
 *
 * ⚠ `previous` is NORMALISED here, like the model `writeRevision` judges: an
 * old v1 row compared raw could read as unsafe where its upgrade is typed, and
 * a step would then be "inherited" that the new model introduced.
 */
export function introducedUnsafeSteps(model: FlowModel, previous: FlowModel | undefined): Diagnostic[] {
  const before = previous ? unsafeStepIds(normaliseModel(previous as never) as unknown as FlowModel) : new Set<string>();
  return [...unsafeStepIds(model)]
    .filter((id) => !before.has(id))
    .map((id) =>
      diag("FT0602", { stepId: id }, "this step's inputs are one hand-written template, and a generated revision may not introduce one", {
        severity: "error",
        note: "D-242: a drafted or chat-built step binds its inputs typed; an unsafe block stays only where the previous revision already had it",
      }),
    );
}

/** One diagnostic as the line a person or a redraft reads. */
export function diagnosticLine(d: Diagnostic): string {
  const at = [d.span?.stepId, d.span?.port].filter(Boolean).join(".");
  return `${d.code}${at ? ` ${at}` : ""}: ${d.message}${d.help ? ` — help: ${d.help}` : ""}`;
}
