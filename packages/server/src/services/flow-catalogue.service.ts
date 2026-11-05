/**
 * Everything a person needs to AUTHOR a flow in this workspace, in one read.
 * Programme 3, Stage 5 — the editable canvas.
 *
 * ── Why one route rather than four the client already has ────────────────────
 *
 * The palette needs the callable refs, their parameters, the caps it must not
 * let someone exceed, the expression allowlist, and how each kind's output is
 * reached. Every one of those exists somewhere; assembling them client-side
 * means the client holds a copy of each, and a copy is a thing that drifts. The
 * concrete version of that: a palette offering a ref `checkFlowRefs` will reject
 * is a form that fails on submit for a reason the person cannot see.
 *
 * ── The ref list is taken from the FINGERPRINTS, not from the interfaces ─────
 *
 * `flowValidator.checkFlowRefs` is handed `Object.keys(refFingerprints())`, so
 * that key set — and no other — decides what a step's `ref` may be. The palette
 * is therefore built from the same call, with `refInterfaces()` joined on for
 * the parameter signatures.
 *
 * ⚠ The two functions derive their keys with the same formula in two places, and
 * `drift` below reports it if they ever stop agreeing. Not defensive noise: a
 * ref present in one and absent from the other is either a ref the palette
 * offers and the validator refuses, or one nobody can pick — and both present as
 * "the tool is missing from the list" with nothing pointing at the cause.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 *
 * A named query's `sqlText`, a tool's URL, and every secret. The palette picks a
 * ref by NAME; the implementation behind it is reviewed engineer content and is
 * already on `/tools` and `/data-sources` for anyone entitled to read it. There
 * is no secret value on any Foundry route and this does not become the first.
 */
import { manifestBuilderService } from "./manifest-builder.service.js";
import { declarationOf } from "./tool-declarations.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { readback, type ReadbackClause } from "./db-operation-readback.js";
import { triggerRepo, type Trigger } from "../repositories/trigger.repo.js";
import { FLOW_CAPS } from "./flow-validator.service.js";
import { flowExpressionService } from "./flow-expression.service.js";
import { OUTPUT_SHAPES, type StepKind } from "./flow-output-shape.js";
import { resolveGenerationProvider } from "./generation-provider.service.js";
import { TRYABLE_KINDS, UNTRYABLE_REASON } from "./step-try.service.js";
import { isAuthorableToolName } from "./platform-tool-names.js";

export interface CatalogueParam {
  name: string;
  type: string;
  required: boolean;
  /**
   * ⚠ The reason field-mapping is possible at all. Every tool has carried
   * per-parameter prose since it was written, and until Programme 3 the manifest
   * rendered none of it (I-40) — so a person mapping a field onto `to_email` had
   * only the name to go on.
   */
  description: string | null;
  /**
   * Left unset, the receiver sends to the person who started the run (`resolveRecipients`, I-287) — declared per port in
   * `tool-declarations.ts`. So an empty field is not a missing value, and a screen must say who it goes to (2026-09-28).
   */
  fallsBackToRequester?: boolean;
}

export interface CatalogueEntry {
  /** EXACTLY what a step's `ref` must be. Never reconstructed client-side. */
  ref: string;
  /** What the ref names: a tool, a named query, or a DB operation. */
  kind: "tool" | "query" | "operation";
  /** The step kind that may name this ref — `tool`/`operation` refs on their own kinds only. */
  stepKind: "tool" | "datasource" | "query";
  description: string | null;
  /**
   * Tool entries only: the first path segment of the tool's registered URL
   * (`/hr/employees` → `hr`) — the service the tool belongs to. Drives the
   * palette's sub-groups (D-28); derived from the URL, never from the name, so
   * a rename cannot silently re-bucket a tool. Null for query/operation
   * entries and for a tool with no URL.
   */
  service: string | null;
  /** Tool entries only: the HTTP method it is called with. A `GET` changes nothing — the builder offers it as a lookup, never as an action. */
  method?: string | null;
  params: CatalogueParam[];
  /** Query and operation entries only. The datasource half of `<datasource>.<query>`. */
  datasource: string | null;
  /**
   * Query and operation entries only. The datasource's ID — platform-coherence Phase 3.6.
   *
   * ⚠ Served beside the name rather than instead of it, and the picker selects
   * on THIS. A design selection stores datasource ids because a datasource's
   * name is renameable while its id is not, so a picker joining on the name
   * would silently drop a datasource from an automation's scope the day
   * somebody tidied the name. The name stays because it is what a person reads
   * and what the ref is built from.
   */
  datasourceId: string | null;
  /**
   * **Exactly what this ref reads** — the compiled SQL for a DB operation, the
   * stored `sql_text` for a named query, null for a tool (which has none).
   *
   * ⚠ Served because the step inspector had no answer to *"what does this step
   * actually read"*. Finding out meant leaving the builder for the data-source
   * page, where the operation list shows *"2 params · 1 join"* and the SQL is
   * one more click — so in practice nobody checked, and a reader that returns
   * plausible-but-wrong rows (`past_due_orders` standing in for "not shipped")
   * read as correct right up to the run.
   *
   * ⚠ **Reading, never authority.** The compiler emits from `spec_json`; this
   * is the stored `compiled_sql` the same row already carries, shown so a
   * person can check it. Nothing may compile or execute from this field.
   */
  sql: string | null;
  /**
   * The same read in English — `readback(spec)`, operations only (a named query
   * is hand-written SQL with no spec to describe). Null for every other kind.
   *
   * ⚠ The PRIMARY artefact of the two (FR-011): the readback is what caught an
   * employee id equated to a department id, in words, where the SQL did not.
   */
  readback: ReadbackClause[] | null;
}

export interface FlowCatalogue {
  entries: CatalogueEntry[];
  /** The kinds, with what each one's output looks like and how to read it. */
  outputs: Record<StepKind, (typeof OUTPUT_SHAPES)[StepKind]>;
  /** D-22's allowlist, served rather than duplicated in the browser. */
  expressions: { roots: string[]; calls: string[] };
  /** D-37's caps, so the canvas can say "you are at 16 of 16" before a 400 does. */
  caps: typeof FLOW_CAPS;
  /**
   * Wave 1 (Stage 4.1) — the deployment's configured models, from the same
   * provider the `llm` save refusal reads (`generation-provider.service.ts`:
   * `defaultModel`/`allowedModels`). Served so the model picker offers exactly
   * what a save will accept; empty when nothing is configured, in which case an
   * `llm` step cannot save (the refusal says where to configure one).
   */
  models: string[];
  /** The deployment default, or null when the provider has none to name. */
  defaultModel: string | null;
  /**
   * Refs the fingerprint set and the interface set disagree about. Empty in a
   * healthy workspace; served rather than logged, because the symptom otherwise
   * is a tool that is simply not in the list.
   */
  drift: string[];
  /**
   * Triggers declarable on the flow being authored — `webhook` and `api` only
   * (D-07: manual and poll are not LLM-creatable and not declarable). Always
   * present, empty array when the workspace has none, so the client palette's
   * contract is stable across reads.
   *
   * Schedules are deliberately NOT here: a schedule is flow-level (it has no
   * name of its own to declare by), and inserting another flow's cron into
   * this flow is nonsense. The schedule entry point stays the per-flow
   * SchedulePane (Phase 6).
   */
  triggers: Array<{ name: string; type: "webhook" | "api" }>;
  /**
   * Which kinds T9's "try this step" can run, and why each of the others
   * cannot — served, never mirrored in the browser (D-197).
   *
   * ⚠ The builder has to decide, before any button is pressed, whether to draw
   * a form or a sentence. A hardcoded client copy of that decision is the
   * failure this repo keeps paying for: it drifts silently, and it drifts in
   * the direction where the screen offers something the server refuses. The
   * REASONS travel too, for the same reason `outputs.<kind>.caution` does —
   * "not supported" for `code` (no Docker socket here) and for `approval`
   * (waits on a person) would flatten a boundary somebody might move into a
   * permanent property of the kind.
   */
  tryable: { kinds: readonly string[]; reasons: Record<string, string> };
}

/** The first path segment of a tool URL — `/hr/employees` → `hr`. Null when
    there is no URL (an internal tool) or the URL has no path. A regex, not
    `new URL`, so a malformed registration cannot throw the whole catalogue. */
function serviceOfUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/^\w+:\/\/[^/]+(?:\/([^/?#]+))?/);
  return m?.[1] ?? null;
}

export const flowCatalogueService = {
  async forWorkspace(workspaceId: string): Promise<FlowCatalogue> {
    const [fingerprints, interfaces, tools, queries, operations, workspaceTriggers, provider] = await Promise.all([
      manifestBuilderService.refFingerprints(workspaceId),
      manifestBuilderService.refInterfaces(workspaceId),
      toolRepo.listByWorkspace(workspaceId),
      datasourceQueryRepo.listByWorkspace(workspaceId),
      dbOperationRepo.listByWorkspace(workspaceId),
      triggerRepo.listByWorkspace(workspaceId),
      // Wave 1 (Stage 4.1): the same provider the `llm` save refusal reads, so
      // the picker offers exactly what a save will accept.
      resolveGenerationProvider(),
    ]);

    // Descriptions, keyed the same way the refs are. Two small maps rather than
    // a join inside the loop, so the ref list stays driven by `fingerprints`.
    const toolMeta = new Map(
      tools.map((t) => [
        t.name,
        {
          description: t.description ?? null,
          service: serviceOfUrl(t.url ?? null),
          method: (t.method ?? null) as string | null,
          params: (t.paramsSchema ?? {}) as Record<
            string,
            { type?: string; required?: boolean; description?: string }
          >,
        },
      ]),
    );
    const queryMeta = new Map(
      queries.map(({ query, datasource }) => [
        `${datasource.name}.${query.name}`,
        {
          description: query.description ?? null,
          datasource: datasource.name,
          datasourceId: datasource.id,
          sql: query.sqlText ?? null,
          params: (query.paramsSchema ?? {}) as Record<
            string,
            { type?: string; required?: boolean; description?: string }
          >,
        },
      ]),
    );
    const operationMeta = new Map(
      operations.map(({ operation, datasource }) => [
        `${datasource.name}.${operation.name}`,
        {
          description: operation.description ?? null,
          datasource: datasource.name,
          datasourceId: datasource.id,
          sql: operation.compiledSql ?? null,
          // Computed from the SAME `spec_json` the compiler reads, never from
          // the SQL text — the readback is a description of the spec, and
          // deriving it from the compiled output would describe the wrong
          // artefact the moment the two could disagree.
          readback: operation.specJson ? readback(operation.specJson as never) : null,
          params: (operation.paramsSchema ?? {}) as Record<
            string,
            { type?: string; required?: boolean; description?: string }
          >,
        },
      ]),
    );

    const entries: CatalogueEntry[] = [];
    for (const ref of Object.keys(fingerprints).sort()) {
      // Demo mail tools execute but are never offered for authoring: simulated
      // delivery that reads like the real thing. Fingerprints, interfaces,
      // `drift` and validation are untouched, so existing flows keep the ref.
      if (!isAuthorableToolName(ref)) continue;
      const iface = interfaces[ref];
      if (!iface) continue; // reported in `drift` below
      const meta =
        iface.kind === "tool" ? toolMeta.get(ref) : iface.kind === "query" ? queryMeta.get(ref) : operationMeta.get(ref);
      entries.push({
        ref,
        kind: iface.kind,
        // A `tool` ref belongs on a `tool` step, a query ref on a `datasource`
        // step, and an operation ref on a `query` step. Stating it here means
        // the palette cannot offer a combination the compiler refuses.
        stepKind: iface.kind === "tool" ? "tool" : iface.kind === "query" ? "datasource" : "query",
        description: meta?.description ?? null,
        service: iface.kind === "tool" ? ((meta as { service?: string | null })?.service ?? null) : null,
        ...(iface.kind === "tool" ? { method: (meta as { method?: string | null })?.method ?? null } : {}),
        params: iface.params.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: meta?.params?.[p.name]?.description ?? null,
          ...(iface.kind === "tool" && declarationOf(ref, iface.params).ports?.[p.name]?.fallsBackToRequester ? { fallsBackToRequester: true } : {}),
        })),
        datasource:
          iface.kind === "query" || iface.kind === "operation"
            ? ((meta as { datasource?: string })?.datasource ?? null)
            : null,
        datasourceId:
          iface.kind === "query" || iface.kind === "operation"
            ? ((meta as { datasourceId?: string })?.datasourceId ?? null)
            : null,
        sql:
          iface.kind === "query" || iface.kind === "operation"
            ? ((meta as { sql?: string | null })?.sql ?? null)
            : null,
        readback:
          iface.kind === "operation"
            ? ((meta as { readback?: ReadbackClause[] | null })?.readback ?? null)
            : null,
      });
    }

    const inFingerprints = new Set(Object.keys(fingerprints));
    const inInterfaces = new Set(Object.keys(interfaces));
    const drift = [
      ...[...inFingerprints].filter((r) => !inInterfaces.has(r)),
      ...[...inInterfaces].filter((r) => !inFingerprints.has(r)),
    ].sort();

    // `webhook` and `api` only — manual and poll are not LLM-creatable and not
    // declarable (D-07), so they never reach the palette. Schedules are NOT
    // here either: a schedule is flow-level (it has no name of its own to
    // declare by) and inserting another flow's cron into this flow is
    // nonsense; the schedule entry point stays the per-flow SchedulePane
    // (Phase 6). Deterministically sorted by type then name so the palette is
    // stable across reads.
    const triggers: FlowCatalogue["triggers"] = workspaceTriggers
      .filter((t): t is Trigger & { type: "webhook" | "api" } => t.type === "webhook" || t.type === "api")
      .map((t) => ({ name: t.name, type: t.type }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type),
      );

    return {
      entries,
      outputs: OUTPUT_SHAPES,
      expressions: {
        roots: [...flowExpressionService.ALLOWED_ROOTS].sort(),
        calls: [...flowExpressionService.ALLOWED_CALLS].sort(),
      },
      caps: FLOW_CAPS,
      models: provider.allowedModels,
      defaultModel: provider.model ?? null,
      drift,
      triggers,
      tryable: { kinds: TRYABLE_KINDS, reasons: UNTRYABLE_REASON },
    };
  },
};
