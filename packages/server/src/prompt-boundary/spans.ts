// T008 — the untrusted-span vocabulary (plan D3 / research R6).
//
// NO IMPORTS. This module is pure over data it is handed, which is what keeps
// `prompt-boundary/` a leaf beside `services/` rather than a second place that
// reaches into repositories (frameworks.md, server layering).
//
// WHY THIS IS ONE LIST: provenance framing (US1) and injection detection (US2)
// must agree on exactly what counts as untrusted. Two independent lists drift,
// and the drift is SILENT — a field added to one and not the other is either
// labelled but unscanned, or scanned but unlabelled, and no test fails.
//
// ADAPTED FROM krt/guardrail_validation (research.md Decision 3): v1-alpha's
// `tools` table has no `isDummy`/`dummyResponseTemplate` columns (dummy tools
// were removed before this feature — manifest-builder.service.ts's own comment
// records that no tool row has ever had one). Those two fields and the source
// branch's `dummyResponseTemplate` span are omitted; every other field survives
// unchanged.
//
// EXTENSION POINT (spec OOS-005): collecting table and column comments is
// deferred to its own feature. When it lands it adds `tableComment` and
// `columnComment` to SPAN_FIELDS and one push each below — not a second
// mechanism. Comments are the classic vector for this attack precisely because
// operators do not think of them as content; the deferral is scheduling, not a
// finding that they are safe.

export type SpanSource = "tool" | "datasource" | "schema";

export interface UntrustedSpan {
  /** Which registry the content came from. */
  source: SpanSource;
  /** The tool or datasource name, so an operator can go and look at it. */
  itemName: string;
  /** Which field of that item — one of SPAN_FIELDS. */
  field: string;
  /** The RAW registered content. Normalisation happens at match time only. */
  value: string;
}

/**
 * The complete set of third-party fields that reach the generation prompt.
 * This constant IS FR-002, and `spans.test.ts` asserts both directions: every
 * declared field is emitted, and every emitted field is declared.
 */
export const SPAN_FIELDS = [
  // tool
  "name",
  "description",
  "method",
  "url",
  "paramName",
  "paramType",
  "secretEnvName",
  "authStyle",
  "authParamName",
  // datasource
  "type",
  // schema (introspected from a remote database nobody here controls)
  "schemaName",
  "tableName",
  "entityKind",
  "columnName",
  "columnType",
  "foreignKeyReference",
  // deferred (spec OOS-005): "tableComment", "columnComment"
] as const;

export type SpanField = (typeof SPAN_FIELDS)[number];

/** The subset of a tool row that reaches the prompt. Deliberately no secret VALUE. */
export interface InventoryTool {
  name: string;
  description: string | null;
  method: string | null;
  url: string | null;
  paramsSchema: unknown;
  secretEnvName: string | null;
  authStyle: string | null;
  authParamName: string | null;
}

export interface InventoryEntity {
  name: string;
  schema: string | null;
  entityType: string;
  columns: Array<{ name?: unknown; type?: unknown; foreignKeyReference?: unknown }>;
}

export interface InventoryDatasource {
  name: string;
  type: string;
  entities: InventoryEntity[];
}

export interface WorkspaceInventory {
  tools: InventoryTool[];
  datasources: InventoryDatasource[];
}

/** Push only non-empty values — an empty span is one every consumer must special-case. */
function push(out: UntrustedSpan[], source: SpanSource, itemName: string, field: SpanField, value: unknown) {
  if (value === null || value === undefined) return;
  const s = typeof value === "string" ? value : String(value);
  if (s.length === 0) return;
  out.push({ source, itemName, field, value: s });
}

/**
 * Pure over one workspace's inventory, so it is testable without a database and
 * so workspace isolation (Article XII) is a property of the caller rather than
 * something re-implemented here.
 */
export function spansFromInventory(inv: WorkspaceInventory): UntrustedSpan[] {
  const out: UntrustedSpan[] = [];

  for (const t of inv.tools) {
    push(out, "tool", t.name, "name", t.name);
    push(out, "tool", t.name, "description", t.description);
    push(out, "tool", t.name, "method", t.method);
    push(out, "tool", t.name, "url", t.url);

    if (t.paramsSchema && typeof t.paramsSchema === "object") {
      for (const [pname, p] of Object.entries(t.paramsSchema as Record<string, { type?: string }>)) {
        push(out, "tool", t.name, "paramName", pname);
        push(out, "tool", t.name, "paramType", p?.type);
      }
    }

    // NAME only. The resolved value never enters a span (Article VIII).
    push(out, "tool", t.name, "secretEnvName", t.secretEnvName);
    push(out, "tool", t.name, "authStyle", t.authStyle);
    push(out, "tool", t.name, "authParamName", t.authParamName);
  }

  for (const d of inv.datasources) {
    push(out, "datasource", d.name, "name", d.name);
    push(out, "datasource", d.name, "type", d.type);

    for (const e of d.entities) {
      push(out, "schema", d.name, "schemaName", e.schema);
      push(out, "schema", d.name, "tableName", e.name);
      push(out, "schema", d.name, "entityKind", e.entityType);
      for (const c of e.columns) {
        push(out, "schema", d.name, "columnName", c?.name);
        push(out, "schema", d.name, "columnType", c?.type);
        push(out, "schema", d.name, "foreignKeyReference", c?.foreignKeyReference);
      }
    }
  }

  return out;
}

// NO workspaceId-taking entry point here, deliberately.
//
// The first cut of this module shipped `readInventory(workspaceId)` and
// `collectUntrustedSpans(workspaceId)`, which read through the repositories.
// They had ZERO callers — production or test — because `manifest-builder.service.ts`
// already has the tools, datasources and entities in hand while rendering, and
// passing them straight to `spansFromInventory` costs no extra query. The pair
// was deleted rather than kept "for later" (Article IV: prefer deleting code
// over adding it).
//
// Deleting them also made this file's placement honest. plan.md put
// `prompt-boundary/` beside `services/` on the grounds that it "holds no
// business rules and touches no repository" — which the repository imports
// contradicted. It now touches none, and the one-direction layering
// `frameworks.md` requires holds.
//
// If a caller ever does need spans without a manifest build, assemble the
// inventory in a SERVICE and pass it here.
