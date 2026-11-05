// packages/flow-edit/src/inventory.ts — one honest paragraph per step, for the chat prompt.
//
// `buildChatPrompt` (server `flow-chat.service.ts`) embeds this so the model is
// told what is *unset* instead of inferring it from raw JSON. Every line here
// is computed from the same declarations the panel reads — `NODE_TYPES`
// properties, the step's stored values by property name, the stored typed
// `InputBinding[]` — so the transcript speaks the panel's language and never a
// guess. Kinds whose inputs are mined from text (`transform` from
// `expr`/`templateText`, `code` from `inputExpr`) report `set in the
// expression`: mining the text here would be a second reader beside the
// compiler's, and the two would drift.
import type { AuthoredFlow, AuthoredStep } from "./index.js";
import { NODE_TYPES } from "./node-types.js";
import type { InputBinding, PropertySpec, Source } from "./node-types.js";

/** Kinds whose inputs live inside authored text — reported, never mined. */
const MINED_INPUT_KINDS: Record<string, true> = { transform: true, code: true };

/**
 * Kinds whose nested steps are contained, never expanded — the parent names
 * its child count and ids in one paragraph; per-item state is never invented
 * (a child that never ran has no status to report). `join` has no registry
 * entry yet; naming it here keeps a future wave-3 kind contained by default.
 */
const CONTAINER_KINDS: Record<string, true> = { iteration: true, loop: true, join: true };

/** Longest single value rendered before it is cut with its truncation named. */
const MAX_VALUE_CHARS = 300;

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}… (truncated)` : text;
}

function isSource(value: unknown): value is Source {
  if (typeof value !== "object" || value === null) return false;
  if (!("from" in value)) return false;
  const from: unknown = value.from;
  return from === "step" || from === "whole" || from === "input" || from === "literal" || from === "self";
}

/** A stored binding in the panel's words — `unknown` never renders as `unset`. */
function sourceText(source: Source | null | undefined): string {
  if (source === null || source === undefined) return "not set";
  switch (source.from) {
    case "step":
      return `from ${source.stepId}.${source.field}`;
    case "whole":
      return `from the whole of ${source.stepId}`;
    case "input":
      return `from run input ${source.inputId}`;
    case "literal":
      return `literal ${truncate(JSON.stringify(source.value))}`;
    case "self":
      return "from itself";
  }
}

function formatScalar(value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (typeof value === "string") return truncate(JSON.stringify(value.replace(/\s+/g, " ")));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return truncate(JSON.stringify(value));
}

function formatValue(value: unknown): string {
  if (isSource(value)) return sourceText(value);
  return formatScalar(value);
}

/** `properties` entries as `name=value` pairs, recursing one level into groups. */
function propertyPairs(step: AuthoredStep, specs: readonly PropertySpec[], record: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    if (spec.visibleWhen) {
      let visible = true;
      try {
        visible = spec.visibleWhen(step);
      } catch {
        visible = true;
      }
      if (!visible) continue;
    }
    const stored: unknown = record[spec.name];
    const value: unknown = stored === undefined ? spec.fallback : stored;
    if (spec.kind === "group") {
      if (typeof value !== "object" || value === null) {
        out.push(`${spec.name}=not set`);
        continue;
      }
      // A group value is the record of its sub-fields; the panel reads it the same way.
      const sub: Record<string, unknown> = value as Record<string, unknown>;
      for (const field of spec.fields ?? []) {
        const fieldStored: unknown = sub[field.name];
        out.push(`${spec.name}.${field.name}=${formatValue(fieldStored === undefined ? field.fallback : fieldStored)}`);
      }
      continue;
    }
    out.push(`${spec.name}=${formatValue(value)}`);
  }
  return out;
}

/** Stored typed bindings — `inputs` and the legacy-carried `inputBindings`. */
function storedBindings(step: AuthoredStep): InputBinding[] {
  const record = step as unknown as Record<string, unknown>;
  const out: InputBinding[] = [];
  const seen = new Set<string>();
  for (const key of ["inputs", "inputBindings"] as const) {
    const list: unknown = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!("name" in entry)) continue;
      const name: unknown = entry.name;
      if (typeof name !== "string" || seen.has(name)) continue;
      seen.add(name);
      // `set_binding` validates bindings on write; this read trusts the stored shape.
      const binding = entry as InputBinding;
      out.push(binding);
    }
  }
  return out;
}

/** Declared ports plus any stored binding, each with its source in words. */
function inputsText(step: AuthoredStep): string {
  if (MINED_INPUT_KINDS[step.kind]) return "set in the expression";
  const declared = NODE_TYPES[step.kind].inputs;
  const bindings = new Map(storedBindings(step).map((b) => [b.name, b.source]));
  const extra = [...bindings.keys()].filter((n) => !declared.some((p) => p.name === n));
  const names = [...declared.map((p) => p.name), ...extra];
  if (names.length === 0) return "none";
  return names.map((name) => `${name}=${sourceText(bindings.get(name) ?? null)}`).join("; ");
}

/** A dynamic output list (`code` contract, extractor params) by stored name. */
function dynamicOutputs(record: Record<string, unknown>, key: "contract" | "params"): string[] {
  const contract: unknown = record["contract"];
  const holder: unknown = key === "contract"
    ? (typeof contract === "object" && contract !== null && "output" in contract ? contract.output : undefined)
    : record["params"];
  if (!Array.isArray(holder)) return [];
  const out: string[] = [];
  for (const field of holder) {
    if (typeof field !== "object" || field === null) continue;
    if (!("name" in field)) continue;
    const name: unknown = field.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const type: unknown = "type" in field ? field.type : undefined;
    out.push(`${name} (${typeof type === "string" && type.length > 0 ? type : "any"})`);
  }
  return out;
}

function outputsText(step: AuthoredStep): string {
  const record = step as unknown as Record<string, unknown>;
  const names = [
    ...NODE_TYPES[step.kind].outputs.map((o) => `${o.name} (${o.type})`),
    ...(step.kind === "code" ? dynamicOutputs(record, "contract") : []),
    ...(step.kind === "extract" ? dynamicOutputs(record, "params") : []),
  ];
  return names.length > 0 ? names.join(", ") : "none";
}

/**
 * One unmined paragraph for a container parent: child count + ids, never
 * expanded, no per-item claims. Null when the step is not a container, so
 * every existing kind renders byte-identical to before.
 */
function childrenText(step: AuthoredStep): string | null {
  if (!CONTAINER_KINDS[step.kind]) return null;
  const raw: unknown = (step as unknown as Record<string, unknown>)["children"];
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const child of raw) {
    if (typeof child === "object" && child !== null && "id" in child && typeof child.id === "string") {
      ids.push(`"${child.id}"`);
    }
  }
  const noun = raw.length === 1 ? "step" : "steps";
  const names = ids.length > 0 ? `: ${ids.join(", ")}` : "";
  return truncate(`contains ${raw.length} ${noun}${names} (contained, not expanded)`);
}

/**
 * The flow's steps as compact plain text for the chat prompt — one block per
 * step carrying its id, kind label, settable properties with current values,
 * declared inputs with sources in words, and declared outputs. A container
 * parent (`iteration`, `loop`, `join`) gains one unmined `children` paragraph
 * — count + ids, never expanded. An empty flow yields an empty string so the
 * caller omits the section entirely.
 */
export function describeStepInventory(flow: AuthoredFlow): string {
  return flow.steps.map((step) => {
    const label = NODE_TYPES[step.kind].label;
    const record = step as unknown as Record<string, unknown>;
    const properties = propertyPairs(step, NODE_TYPES[step.kind].properties, record);
    const lines = [
      `- "${step.id}" · ${label} (${step.kind})`,
      `  properties: ${properties.length > 0 ? properties.join("; ") : "none"}`,
      `  inputs: ${inputsText(step)}`,
      `  outputs: ${outputsText(step)}`,
    ];
    const children = childrenText(step);
    if (children !== null) lines.push(`  children: ${children}`);
    return lines.join("\n");
  }).join("\n");
}
