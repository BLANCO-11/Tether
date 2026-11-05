// packages/flow-edit/src/node-types.ts — the ONE definition of every workflow component.
//
// `workflow-component-behaviour.md` §26 + §39: a node type declares its properties,
// its typed inputs and its declared outputs, and the panel renders from that
// declaration. Before this file, kind metadata was four hand-synced tables in four
// files (`FlowCanvas.tsx`, `StepInspector.tsx`, `FlowReview.tsx`, `ChatWorkbench.tsx`)
// plus a hand-written form per kind in the inspector — and they had already drifted.
//
// Readers of this file:
// - `blankStep` (client `lib/flow-authoring.ts`) builds a new step from `fallback`s.
// - The properties panel (client `builder/properties/`) renders sections/controls.
// - The palette reads `offeredKinds()` + `label`/`summary`/`icon`/`colour`.
// - The chat vocabulary (`ops.ts` `set_property`) validates names against `propertySpec`.
// - The server derives `stepSchema` members and the drafter's shape lines from it.
//
// A `runtime: null` entry is DECLARED but not implemented: never offered in the
// palette, the picker or chat, and refused at save by name. Offering a type before
// its emitter is how `notify` happened (authorable by the drafter, unemittable —
// `flow-compiler.service.ts` "is not emittable"). Wave 1 sets `llm` + `http`; the
// wave-2/3 entries below carry their doc tables so the work is specified, not guessed.

import type { AuthoredStep, StepKind } from "./index.js";

/** Dify's variable vocabulary (`docs/nodes/output.md` §3), plus `any` for unshaped values. */
export type VariableType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "file"
  | "array[string]"
  | "array[number]"
  | "array[object]"
  | "array[boolean]"
  | "array[file]"
  | "any";

/**
 * How one property is edited. Rendered by `PropertyField` and nowhere else —
 * a new kind of control is added there, never beside it.
 */
export type PropertyKind =
  | "text"
  | "paragraph"
  | "number"
  | "integer"
  | "toggle"
  | "select"
  | "model-picker"
  | "expression"
  | "template"
  | "step-field"
  | "step-list"
  | "key-value-list"
  | "field-list"
  | "prompt-blocks"
  | "output-rows"
  /** A nested object edited as a sub-section; sub-keys are `fields`. */
  | "group";

export type PropertySpec = {
  /** The stored key on the step. */
  name: string;
  /** The panel's label, verbatim. */
  label: string;
  kind: PropertyKind;
  section: "basic" | "behavior";
  required?: boolean;
  /** What `blankStep` writes. Never `undefined` — `null` means explicitly unset. */
  fallback: unknown;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** Section-head hint, at most three words (`component-panel.md`). */
  hint?: string | null;
  /** The row's `title` tooltip. */
  help?: string | null;
  /** Sub-keys, for `kind: "group"` — `name` is relative to the object. */
  fields?: readonly PropertySpec[];
  /**
   * For `kind: "step-field"`: `"step-id"` stores a bare upstream step id
   * (`llm.contextStepId`); absent stores a `Source` and renders the picker.
   * A bare string value with no `refMode` (http `body.fileVar`, a variable
   * name) renders a text input — never a step pick writing an id where a
   * name belongs.
   */
  refMode?: "step-id";
  visibleWhen?: (step: AuthoredStep) => boolean;
};

export type InputPortSpec = {
  name: string;
  label: string;
  type: VariableType;
  required?: boolean;
};

export type OutputPortSpec = {
  name: string;
  /** What the value IS, for a person choosing it. */
  label: string;
  type: VariableType;
  /**
   * The expression a later step reads it by, `<id>` = the step id.
   * `null` only where the kind produces nothing (then `noOutputNote` says so).
   */
  expr: string | null;
  /** Shown beside the pick when a chooser would otherwise get it wrong. */
  caution?: string | null;
};

export type NodeTypeSpec = {
  kind: StepKind;
  label: string;
  category: "ai" | "logic" | "transform" | "integration" | "human" | "data";
  /** A `--k-*` token, e.g. `var(--k-llm)`. */
  colour: string;
  /** An exported name from client `components/ui/icons`. */
  icon: string;
  /** Palette body: two sentences, the second is what it costs/sends/forecloses. */
  summary: string;
  /** `null` = declared but not implemented; never offered, refused at save by name. */
  runtime: "foundry" | "engine" | null;
  /**
   * Built only by the engine's own moves (the canvas's listed actions, the chat builder) — never offered by the legacy palette
   * or picker, whose forms cannot keep its rules (for each, D-361).
   */
  engineOnly?: boolean;
  /** True for `tool`/`datasource`/`query`: offered from catalogue rows naming a real ref, never from-scratch. */
  catalogueBacked?: boolean;
  properties: readonly PropertySpec[];
  /** Empty + `catalogueBacked` = ports come from `catalogue.entries[ref].params`. */
  inputs: readonly InputPortSpec[];
  /** Empty + no `noOutputNote` = outputs are dynamic (code contract, extractor params). */
  outputs: readonly OutputPortSpec[];
  /** Shown in the Outputs section when `outputs` is empty and the kind yields nothing. */
  noOutputNote?: string | null;
  retryable: boolean;
  /** Whether the step record carries `timeoutSeconds` (Advanced section). */
  timeoutable: boolean;
  /** The card's one config pill. `null` → `label`. */
  pill: (step: AuthoredStep) => string | null;
};

/** The flow's boundary cards — Start (inputs) and End (output rows), not steps. */
export type BoundarySpec = {
  kind: "start" | "end";
  label: string;
  properties: readonly PropertySpec[];
};

// ── Shared value vocabulary ──────────────────────────────────────────────────
// `BranchTest` (the eleven-operator union) and `BRANCH_TESTS` (its labels)
// live in `render.ts`, beside the builders that speak them — one list for the
// panel, the compiler and the stored-model upgrade. The registry's
// `test`/`where`/`filter` groups name its members as strings.

/**
 * Where a value comes from — the stored form of "a reference, not a value"
 * (md §31). One spelling, shared by input bindings, `over`, `context`, output
 * rows and the iteration array source.
 *
 * The `transform` on a `step` source is the column wrapper the display string
 * was rendered with (`split("T")[0]` for a date, `tostring`, `tonumber`) — the
 * same projection `render.ts` emits, kept on the binding so the runtime value
 * still carries it. Optional so steps stored before it existed keep reading.
 */
/**
 * D-273 — what a NULL does where a non-null value is needed: `skip` drops the
 * row before it is used; `fail` lets it through and the step fails on it.
 * Required by the checker (FT0203) wherever an `Option` meets a non-null port.
 */
export type OnNull = "skip" | "fail";

export type Source =
  | { from: "step"; stepId: string; field: string; transform?: "date" | "text" | "number"; onNull?: OnNull }
  /** `transform: "text"` = the whole output as JSON text (`tostring`) — what a text port like `llm_complete.input` takes. */
  | { from: "whole"; stepId: string; transform?: "text"; onNull?: Record<string, OnNull> }
  /**
   * `transform` on an input is a TYPED conversion (phase 2 task 9, D-272): `month` cuts a
   * `DATE` to `YYYY-MM`, `date` a `DATETIME` to `YYYY-MM-DD`. Emitted in the spliced form
   * only — a value piped INTO jq is parsed as JSON text and a bare date is not (E2.1).
   */
  | { from: "input"; inputId: string; transform?: "month" | "date" }
  | { from: "literal"; value: string }
  | { from: "self" };

/** One named input port bound to a source, or explicitly unbound (`null`). */
export type InputBinding = { name: string; source: Source | null };

/**
 * Phase 0 seam (complexity plan Phase 3; `docs/nodes/error-handling.md` §3):
 * what a step does when it fails AFTER its `retry` exhausts. `StepRetry`
 * (and its bounds) are unchanged; this engages only after them.
 */
export type FailureMode = "none" | "default" | "fail-branch";

export type FailureHandling = {
  /** Default `"none"` — today's behavior (stop, surface the error); unset reads as `"none"`. */
  failureMode: FailureMode;
  /**
   * Only meaningful when `failureMode === "default"`; typed per kind. Stored
   * only under `"default"` — switching modes away keeps the last value but
   * the runner ignores it.
   */
  defaultValue?: unknown;
};

/**
 * The panel vocabulary for the seam above, spread into every `retryable`
 * spec — one declaration, not eight hand-synced copies. Optional and
 * additive: `failureMode` falls back to `"none"` (today's behavior),
 * `defaultValue` to `null` (explicitly unset). Kind gates, record fields,
 * refusals and the runner land with their phases; this declares the names.
 */
export const FAILURE_HANDLING: readonly PropertySpec[] = [
  {
    name: "failureMode",
    label: "On error",
    kind: "select",
    section: "behavior",
    fallback: "none",
    options: [
      { value: "none", label: "Stop the run" },
      { value: "default", label: "Use a default value and continue" },
      { value: "fail-branch", label: "Take the error branch" },
    ],
    help: "Runs only after retries exhaust; unset stops the run.",
  },
  {
    name: "defaultValue",
    label: "Default value",
    kind: "text",
    section: "behavior",
    fallback: null,
    help: "Only used for a default value; shape follows the kind's output.",
  },
];

// ── The registry ─────────────────────────────────────────────────────────────

function refOf(step: AuthoredStep): string | null {
  const ref = (step as unknown as Record<string, unknown>)["ref"];
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

export const NODE_TYPES: Record<StepKind, NodeTypeSpec> = {
  tool: {
    kind: "tool",
    label: "tool call",
    category: "integration",
    colour: "var(--k-tool)",
    icon: "Wrench",
    summary: "Calls a blessed catalogue tool with bound inputs. Runs through Foundry, never from the engine directly.",
    runtime: "foundry",
    catalogueBacked: true,
    properties: [
      { name: "ref", label: "Tool", kind: "text", section: "basic", required: true, fallback: "" },
      {
        name: "extraInputs",
        label: "Extra inputs",
        kind: "key-value-list",
        section: "behavior",
        fallback: [],
        help: "Caller-supplied values beyond the endpoint's own parameters.",
      },
      ...FAILURE_HANDLING,
    ],
    inputs: [],
    outputs: [
      {
        name: "body",
        label: "the tool call's HTTP response body",
        type: "any",
        expr: "json(outputs.<id>.body)",
      },
    ],
    retryable: true,
    timeoutable: true,
    pill: (step) => refOf(step),
  },
  datasource: {
    kind: "datasource",
    label: "data source",
    category: "integration",
    colour: "var(--k-datasource)",
    icon: "Database",
    summary: "Reads rows from a workspace data source. Read-only SQL; rows arrive at `.results[0].data`.",
    runtime: "foundry",
    catalogueBacked: true,
    properties: [
      { name: "ref", label: "Source", kind: "text", section: "basic", required: true, fallback: "" },
      ...FAILURE_HANDLING,
    ],
    inputs: [],
    outputs: [
      {
        name: "body",
        label: "the query's HTTP response body — rows are at `.results[0].data`",
        type: "any",
        expr: "json(outputs.<id>.body)",
        caution:
          "A raw query row must not be handed to a `tool` or `approval` step. Put a " +
          "`transform` in between that picks the fields the call needs, with dates flattened " +
          'to "YYYY-MM-DD" — a timestamp crossing into a tool body fails the step at runtime (I-42).',
      },
    ],
    retryable: true,
    timeoutable: true,
    pill: (step) => refOf(step),
  },
  query: {
    kind: "query",
    label: "DB operation",
    category: "integration",
    colour: "var(--k-datasource)",
    icon: "Database",
    summary: "Runs a workspace DB operation. Read-only SQL; rows arrive at `.results[0].data`.",
    runtime: "foundry",
    catalogueBacked: true,
    properties: [
      { name: "ref", label: "Operation", kind: "text", section: "basic", required: true, fallback: "" },
      ...FAILURE_HANDLING,
    ],
    inputs: [],
    outputs: [
      {
        name: "body",
        label: "the operation's HTTP response body — rows are at `.results[0].data`",
        type: "any",
        expr: "json(outputs.<id>.body)",
        caution:
          "A raw query row must not be handed to a `tool` or `approval` step. Put a " +
          "`transform` in between that picks the fields the call needs, with dates flattened " +
          'to "YYYY-MM-DD" — a timestamp crossing into a tool body fails the step at runtime (I-42).',
      },
    ],
    retryable: true,
    timeoutable: true,
    pill: (step) => refOf(step),
  },
  transform: {
    kind: "transform",
    label: "transform",
    category: "transform",
    colour: "var(--k-transform)",
    icon: "Split",
    summary: "Reshapes the previous step's output. The place to flatten a date.",
    runtime: "engine",
    properties: [
      {
        name: "mode",
        label: "Mode",
        kind: "select",
        section: "behavior",
        required: true,
        fallback: "expression",
        options: [
          { value: "expression", label: "Expression" },
          { value: "template", label: "Template" },
        ],
      },
      {
        name: "expr",
        label: "Expression",
        kind: "expression",
        section: "behavior",
        required: true,
        fallback: "{{ 1 }}",
        help: "A jq expression over the previous step's output.",
        visibleWhen: (step) =>
          (step as unknown as Record<string, unknown>)["mode"] !== "template",
      },
      {
        name: "templateText",
        label: "Template",
        kind: "template",
        section: "behavior",
        required: true,
        fallback: "",
        help: "Jinja2 source; {{var}} refs bind in Inputs.",
        visibleWhen: (step) =>
          (step as unknown as Record<string, unknown>)["mode"] === "template",
      },
      // The rows editor's typed readings, persisted BESIDE the text by
      // `rows/TransformSection.tsx` — `expr`/`templateText` stay the source of
      // truth, these declare the feed (`inputBindings`) and the projection
      // (`outputColumns`) for the server to render when the text is absent.
      // Declared so `set_property` accepts them by name with the same array
      // validation as every other `field-list` (`applySetProperty`); the rows
      // carry `{name, source}` / `{name, type, source}` and any extra key is
      // ignored by that validation, never stripped.
      {
        name: "inputBindings",
        label: "Input bindings",
        kind: "field-list",
        section: "behavior",
        fallback: [],
        help: "Typed readings of the expression's feed; the text still emits.",
      },
      {
        name: "outputColumns",
        label: "Output columns",
        kind: "field-list",
        section: "behavior",
        fallback: [],
        help: "Typed readings of the expression's projection; the text still emits.",
      },
    ],
    // Mined from `expr`/`templateText` for display only — the text is the source
    // of truth (`docs/nodes/template.md` §3), so there are no stored bindings.
    inputs: [],
    outputs: [{ name: "result", label: "the value the expression produced", type: "any", expr: "json(outputs.<id>.value)" }],
    retryable: false,
    timeoutable: false,
    pill: (step) => {
      const s = step as unknown as Record<string, unknown>;
      return s["mode"] === "template" ? "template" : null;
    },
  },
  code: {
    kind: "code",
    label: "generated code",
    category: "transform",
    colour: "var(--k-code)",
    icon: "Box",
    summary: "You write the contract; Foundry writes the function. No network, no credentials.",
    runtime: "foundry",
    properties: [
      {
        name: "contract",
        label: "Contract",
        kind: "group",
        section: "behavior",
        required: true,
        fallback: { purpose: "", input: [], output: [] },
        fields: [
          { name: "purpose", label: "Purpose", kind: "paragraph", section: "behavior", required: true, fallback: "" },
          { name: "input", label: "Input fields", kind: "field-list", section: "behavior", fallback: [] },
          { name: "output", label: "Output fields", kind: "field-list", section: "behavior", fallback: [] },
        ],
      },
      ...FAILURE_HANDLING,
    ],
    // Names come from `contract.input`; bindings are stored on the step in Stage 3.
    inputs: [],
    // Names come from `contract.output` — dynamic, never a static row.
    outputs: [],
    retryable: true,
    timeoutable: true,
    pill: () => null,
  },
  approval: {
    kind: "approval",
    label: "waits for a person",
    category: "human",
    colour: "var(--k-approval)",
    icon: "Check",
    summary: "Stops the run until someone approves. Rejecting kills it.",
    runtime: "foundry",
    properties: [
      {
        name: "summary",
        label: "Question",
        kind: "template",
        section: "behavior",
        required: true,
        fallback: '"Approve this?"',
        help: "The question the approver answers. May reference upstream outputs.",
      },
      {
        name: "context",
        label: "Evidence",
        kind: "step-field",
        section: "behavior",
        fallback: null,
        help: "The upstream output the approver is shown.",
      },
      {
        name: "awaitSeconds",
        label: "Wait budget (seconds)",
        kind: "integer",
        section: "behavior",
        min: 60,
        max: 604800,
        fallback: null,
        help: "Unset means the server default.",
      },
    ],
    inputs: [],
    outputs: [],
    noOutputNote:
      "A gate produces no data. Rejecting it kills the execution, so there is no " +
      'downstream "no" to read.',
    retryable: false,
    timeoutable: false,
    pill: () => null,
  },
  branch: {
    kind: "branch",
    label: "If / Else",
    category: "logic",
    colour: "var(--k-transform)",
    icon: "Fork",
    summary:
      "Run the steps after this only when a condition holds. There is no \u201cotherwise\u201d branch: " +
      "when the condition is false the steps after it are skipped, and everything not downstream of it runs either way.",
    runtime: "engine",
    properties: [
      {
        name: "test",
        label: "Condition",
        kind: "group",
        section: "behavior",
        fallback: null,
        help: "Unset plus no Else link is a refused save — a branch that tests nothing guards nothing.",
        fields: [
          { name: "left", label: "Value", kind: "step-field", section: "behavior", required: true, fallback: null },
          { name: "operator", label: "Test", kind: "select", section: "behavior", required: true, fallback: "field_eq" },
          { name: "right", label: "Against", kind: "text", section: "behavior", fallback: "" },
        ],
      },
      {
        name: "elseOf",
        label: "Else of",
        kind: "text",
        section: "behavior",
        fallback: "",
        help: "The branch id this step is the Else arm of. Set by chaining, rarely typed.",
      },
    ],
    inputs: [],
    outputs: [],
    noOutputNote:
      "A condition produces no data. It decides whether the steps after it run at " +
      "all — there is nothing to read from it.",
    retryable: false,
    timeoutable: false,
    pill: () => null,
  },
  merge: {
    kind: "merge",
    label: "Either way",
    category: "logic",
    colour: "var(--k-transform)",
    icon: "Merge",
    summary:
      "Carry on after a condition, whichever way it went. Without this, a step after a " +
      "condition runs only when the condition held.",
    runtime: "engine",
    properties: [
      {
        name: "sources",
        label: "Sources",
        kind: "step-list",
        section: "behavior",
        required: true,
        fallback: [],
        help: "Top of the list wins if more than one produced a result.",
      },
    ],
    inputs: [],
    outputs: [
      {
        name: "value",
        label: "whichever of the merged steps produced a result",
        type: "any",
        expr: "json(outputs.<id>.value)",
        caution:
          "If no branch matched, none of the merged steps ran and this is `null` — not an " +
          "error. A step that reads a merge should cope with nothing having happened.",
      },
    ],
    retryable: false,
    timeoutable: false,
    pill: (step) => {
      const sources = (step as unknown as Record<string, unknown>)["sources"];
      return Array.isArray(sources) ? `merge · ${sources.length} branches` : null;
    },
  },
  llm: {
    kind: "llm",
    label: "LLM",
    category: "ai",
    colour: "var(--k-llm)",
    icon: "Bot",
    summary:
      "Asks a configured model about the data. Sends this workspace's rows outside.",
    // Wave 1 (Stage 4.1): runs through Foundry (`POST /api/steps/llm`), never from the engine directly.
    runtime: "foundry",
    properties: [
      { name: "model", label: "Model", kind: "model-picker", section: "behavior", required: true, fallback: "" },
      {
        name: "tempPreset",
        label: "Creativity",
        kind: "select",
        section: "behavior",
        fallback: "balanced",
        options: [
          { value: "precise", label: "Precise" },
          { value: "balanced", label: "Balanced" },
          { value: "creative", label: "Creative" },
          { value: "custom", label: "Custom" },
        ],
      },
      { name: "temperature", label: "Temperature", kind: "number", section: "behavior", min: 0, max: 1, step: 0.1, fallback: 0.7 },
      { name: "topP", label: "Top P", kind: "number", section: "behavior", min: 0, max: 1, step: 0.05, fallback: 1 },
      { name: "frequencyPenalty", label: "Frequency penalty", kind: "number", section: "behavior", fallback: 0 },
      { name: "presencePenalty", label: "Presence penalty", kind: "number", section: "behavior", fallback: 0 },
      { name: "promptBlocks", label: "Prompt", kind: "prompt-blocks", section: "behavior", required: true, fallback: [{ role: "user", text: "" }] },
      { name: "contextStepId", label: "Context step", kind: "step-field", section: "behavior", refMode: "step-id", fallback: null },
      { name: "outputFields", label: "Structured output", kind: "field-list", section: "behavior", fallback: [] },
      { name: "memoryEnabled", label: "Chat memory", kind: "toggle", section: "behavior", fallback: false, help: "Chat flows only; no effect in run-once flows." },
      {
        name: "visionDetail",
        label: "Vision detail",
        kind: "select",
        section: "behavior",
        fallback: "low",
        options: [
          { value: "high", label: "High" },
          { value: "low", label: "Low" },
        ],
      },
      { name: "reasoningSeparated", label: "Separate reasoning", kind: "toggle", section: "behavior", fallback: false },
      ...FAILURE_HANDLING,
    ],
    // Mined from `promptBlocks` for display — the blocks are the source of truth.
    inputs: [],
    outputs: [
      {
        name: "text",
        label: "the model's answer text",
        type: "string",
        expr: "json(outputs.<id>.body).text",
        caution:
          "An answer is text, not a shape. Declare the fields you need; nothing downstream " +
          "should branch on a field a model invented.",
      },
      { name: "reasoning_content", label: "the model's reasoning trace, when separated", type: "string", expr: "json(outputs.<id>.body).reasoning_content" },
    ],
    retryable: true,
    timeoutable: false,
    pill: (step) => {
      const s = step as unknown as Record<string, unknown>;
      const model = typeof s["model"] === "string" && s["model"].length > 0
        ? (s["model"] as string).split("/").pop()
        : null;
      const preset = typeof s["tempPreset"] === "string" ? (s["tempPreset"] as string) : "balanced";
      return model ? `${model} · ${preset}` : null;
    },
  },
  http: {
    kind: "http",
    label: "HTTP",
    category: "integration",
    colour: "var(--k-http)",
    icon: "Link",
    summary:
      "Sends exactly the request written here — not a catalogue tool. Responses pass the workspace egress policy.",
    // Wave 1 (Stage 4.2): dials from Foundry through `classifyHost(url, STRICT)`, never from a Kestra task.
    runtime: "foundry",
    properties: [
      {
        name: "method",
        label: "Method",
        kind: "select",
        section: "behavior",
        required: true,
        fallback: "GET",
        options: [
          { value: "GET", label: "GET" },
          { value: "HEAD", label: "HEAD" },
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" },
        ],
      },
      { name: "url", label: "URL", kind: "text", section: "behavior", required: true, fallback: "", help: "{{…}} refs must validate against the expression allowlist." },
      { name: "headers", label: "Headers", kind: "key-value-list", section: "behavior", fallback: [] },
      { name: "queryParams", label: "Query params", kind: "key-value-list", section: "behavior", fallback: [] },
      {
        name: "body",
        label: "Body",
        kind: "group",
        section: "behavior",
        required: true,
        fallback: { kind: "none", content: "" },
        fields: [
          {
            name: "kind",
            label: "Body type",
            kind: "select",
            section: "behavior",
            required: true,
            fallback: "none",
            options: [
              { value: "none", label: "None" },
              { value: "json", label: "JSON" },
              { value: "form", label: "Form" },
              { value: "binary", label: "Binary" },
              { value: "raw", label: "Raw" },
            ],
          },
          { name: "content", label: "Content", kind: "paragraph", section: "behavior", fallback: "" },
          { name: "contentType", label: "Content type", kind: "text", section: "behavior", fallback: "" },
          { name: "fileVar", label: "File variable", kind: "step-field", section: "behavior", fallback: null },
        ],
      },
      {
        name: "auth",
        label: "Auth",
        kind: "group",
        section: "behavior",
        required: true,
        fallback: { kind: "none" },
        fields: [
          {
            name: "kind",
            label: "Auth type",
            kind: "select",
            section: "behavior",
            required: true,
            fallback: "none",
            options: [
              { value: "none", label: "None" },
              { value: "api-key", label: "API key" },
              { value: "basic", label: "Basic" },
              { value: "bearer", label: "Bearer" },
              { value: "custom", label: "Custom" },
            ],
          },
          { name: "headerName", label: "Header name", kind: "text", section: "behavior", fallback: "" },
          { name: "secretRef", label: "Secret", kind: "text", section: "behavior", fallback: "", help: "An environment variable name — never a literal token." },
        ],
      },
      {
        name: "timeouts",
        label: "Timeouts",
        kind: "group",
        section: "behavior",
        fallback: null,
        fields: [
          { name: "connectMs", label: "Connect (ms)", kind: "integer", section: "behavior", min: 1, fallback: null },
          { name: "readMs", label: "Read (ms)", kind: "integer", section: "behavior", min: 1, fallback: null },
          { name: "writeMs", label: "Write (ms)", kind: "integer", section: "behavior", min: 1, fallback: null },
        ],
      },
      { name: "sslVerify", label: "Verify TLS", kind: "toggle", section: "behavior", fallback: true, help: "External API with verification off is a real hazard." },
      ...FAILURE_HANDLING,
    ],
    // Mined from `url`/headers/body for display — the texts are the source of truth.
    inputs: [],
    outputs: [
      { name: "body", label: "the response body", type: "any", expr: "json(outputs.<id>.body).body" },
      { name: "status_code", label: "the response status code", type: "integer", expr: "json(outputs.<id>.body).status_code" },
      { name: "headers", label: "the response headers", type: "object", expr: "json(outputs.<id>.body).headers" },
      { name: "size", label: "the response size in bytes", type: "integer", expr: "json(outputs.<id>.body).size" },
    ],
    retryable: true,
    timeoutable: false,
    pill: (step) => {
      const url = (step as unknown as Record<string, unknown>)["url"];
      if (typeof url !== "string" || url.length === 0) return null;
      try {
        const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
        return host || null;
      } catch {
        return null;
      }
    },
  },
  classifier: {
    kind: "classifier",
    label: "Classify",
    category: "ai",
    colour: "var(--k-llm)",
    icon: "Fork",
    summary:
      "Routes text into one of its classes. Wave 2 — declared, not runnable.",
    runtime: null,
    properties: [
      { name: "inputSource", label: "Text to classify", kind: "step-field", section: "behavior", required: true, fallback: null },
      { name: "model", label: "Model", kind: "model-picker", section: "behavior", required: true, fallback: "" },
      {
        name: "classes",
        label: "Classes",
        kind: "field-list",
        section: "behavior",
        required: true,
        fallback: [
          { name: "CLASS 1", type: "string", required: true, description: "" },
          { name: "CLASS 2", type: "string", required: true, description: "" },
        ],
      },
      { name: "instructions", label: "Instructions", kind: "paragraph", section: "behavior", fallback: "" },
      ...FAILURE_HANDLING,
    ],
    inputs: [],
    // No emitter yet — read spellings are provisional, do not offer.
    outputs: [
      { name: "class_label", label: "the winning class title", type: "string", expr: "json(outputs.<id>.body).class_label" },
    ],
    retryable: true,
    timeoutable: false,
    pill: (step) => {
      const classes = (step as unknown as Record<string, unknown>)["classes"];
      return Array.isArray(classes) ? `classify · ${classes.length} classes` : null;
    },
  },
  extract: {
    kind: "extract",
    label: "Extract",
    category: "ai",
    colour: "var(--k-llm)",
    icon: "Search",
    summary:
      "Pulls named fields out of text. Wave 2 — declared, not runnable.",
    runtime: null,
    properties: [
      { name: "inputSource", label: "Source text", kind: "step-field", section: "behavior", required: true, fallback: null },
      { name: "model", label: "Model", kind: "model-picker", section: "behavior", required: true, fallback: "" },
      { name: "params", label: "Fields to extract", kind: "field-list", section: "behavior", required: true, fallback: [] },
      { name: "instructions", label: "Instructions", kind: "paragraph", section: "behavior", required: true, fallback: "" },
      {
        name: "inferenceMode",
        label: "Inference mode",
        kind: "select",
        section: "behavior",
        fallback: "function_call",
        options: [
          { value: "function_call", label: "Function call" },
          { value: "prompt", label: "Prompt" },
        ],
      },
      { name: "memoryEnabled", label: "Chat memory", kind: "toggle", section: "behavior", fallback: false },
      ...FAILURE_HANDLING,
    ],
    inputs: [],
    // Names come from `params` — dynamic, never a static row.
    outputs: [],
    retryable: true,
    timeoutable: false,
    pill: (step) => {
      const params = (step as unknown as Record<string, unknown>)["params"];
      return Array.isArray(params) && params.length > 0 ? `extract · ${params.length} fields` : null;
    },
  },
  listop: {
    kind: "listop",
    label: "listop",
    category: "logic",
    colour: "var(--k-transform)",
    icon: "Table",
    summary:
      "Filters, sorts and takes from one array. Wave 2 — declared, not runnable.",
    runtime: null,
    properties: [
      { name: "arraySource", label: "Array", kind: "step-field", section: "behavior", required: true, fallback: null },
      {
        name: "filter",
        label: "Filter",
        kind: "group",
        section: "behavior",
        fallback: null,
        fields: [
          { name: "field", label: "Field", kind: "text", section: "behavior", required: true, fallback: "" },
          { name: "test", label: "Test", kind: "select", section: "behavior", required: true, fallback: "field_eq" },
          { name: "value", label: "Value", kind: "text", section: "behavior", fallback: "" },
        ],
      },
      {
        name: "sort",
        label: "Sort",
        kind: "group",
        section: "behavior",
        fallback: null,
        fields: [
          { name: "field", label: "Field", kind: "text", section: "behavior", required: true, fallback: "" },
          {
            name: "dir",
            label: "Direction",
            kind: "select",
            section: "behavior",
            required: true,
            fallback: "asc",
            options: [
              { value: "asc", label: "Ascending" },
              { value: "desc", label: "Descending" },
            ],
          },
        ],
      },
      {
        name: "selection",
        label: "Take",
        kind: "group",
        section: "behavior",
        required: true,
        fallback: { mode: "all", n: 1 },
        fields: [
          {
            name: "mode",
            label: "Mode",
            kind: "select",
            section: "behavior",
            required: true,
            fallback: "all",
            options: [
              { value: "all", label: "All" },
              { value: "first-n", label: "First N" },
              { value: "first", label: "First" },
              { value: "last", label: "Last" },
            ],
          },
          { name: "n", label: "N", kind: "integer", section: "behavior", min: 1, max: 20, fallback: 1 },
        ],
      },
    ],
    inputs: [],
    // Fixed triple (`result`/`first_record`/`last_record`, `docs/nodes/list-operator.md`
    // §6); the read spelling is provisional until the emitter lands.
    outputs: [
      { name: "result", label: "the filtered, sorted array", type: "any", expr: "json(outputs.<id>.value).result" },
      { name: "first_record", label: "the first element", type: "any", expr: "json(outputs.<id>.value).first_record" },
      { name: "last_record", label: "the last element", type: "any", expr: "json(outputs.<id>.value).last_record" },
    ],
    retryable: false,
    timeoutable: false,
    pill: () => null,
  },
  iteration: {
    kind: "iteration",
    label: "iteration",
    category: "logic",
    colour: "var(--k-transform)",
    icon: "RefreshCw",
    summary:
      "Runs its child steps once per array item. Wave 3 — declared, not runnable.",
    runtime: null,
    properties: [
      { name: "arraySource", label: "Array", kind: "step-field", section: "behavior", required: true, fallback: null },
      {
        name: "mode",
        label: "Mode",
        kind: "select",
        section: "behavior",
        fallback: "sequential",
        options: [
          { value: "sequential", label: "Sequential" },
          { value: "parallel", label: "Parallel" },
        ],
      },
      { name: "parallelCap", label: "Parallel limit", kind: "integer", section: "behavior", min: 1, max: 10, fallback: 10 },
      {
        name: "onItemError",
        label: "On item error",
        kind: "select",
        section: "behavior",
        fallback: "terminate",
        options: [
          { value: "terminate", label: "Stop on first error" },
          { value: "continue-null", label: "Emit null, keep length" },
          { value: "remove-failed", label: "Drop failed items" },
        ],
      },
      // Phase 0 seam (complexity plan Phase 1): the declared type of each
      // array item, for typed downstream picks. Advisory only until a
      // downstream step narrows it — never a runtime coercion.
      {
        name: "elementShape",
        label: "Element type",
        kind: "select",
        section: "behavior",
        fallback: null,
        options: [
          { value: "string", label: "string" },
          { value: "number", label: "number" },
          { value: "integer", label: "integer" },
          { value: "boolean", label: "boolean" },
          { value: "object", label: "object" },
          { value: "file", label: "file" },
          { value: "array[string]", label: "array[string]" },
          { value: "array[number]", label: "array[number]" },
          { value: "array[object]", label: "array[object]" },
          { value: "array[boolean]", label: "array[boolean]" },
          { value: "array[file]", label: "array[file]" },
          { value: "any", label: "any" },
        ],
        help: "Unset means unshaped — downstream picks read `any`.",
      },
      // Phase 0 seam: at most 100 items per run (validator `iterationItems`) —
      // 100 is the batching number the migration docs already use
      // (batch ~100/taskrun), not a concurrency or cycle bound.
      {
        name: "itemCap",
        label: "Item cap",
        kind: "integer",
        section: "behavior",
        min: 1,
        fallback: 100,
        help: "Refused above 100 at run; split the flow instead of raising it.",
      },
    ],
    // `children` are nested `AuthoredStep`s, not scalar properties — declared on
    // the step record, with no PropertyKind yet (wave 3 adds the renderer).
    inputs: [],
    outputs: [],
    retryable: false,
    timeoutable: false,
    pill: () => null,
  },
  for_each: {
    kind: "for_each",
    label: "For each",
    category: "logic",
    colour: "var(--k-loop)",
    icon: "RefreshCw",
    summary: "Runs the steps inside it once per item of a list. The steps after it run once, and read one row per item.",
    runtime: "engine",
    engineOnly: true,
    properties: [],
    inputs: [],
    outputs: [],
    noOutputNote: "Inside, it is the current item. Outside, read the loop's output — one row per item.",
    retryable: false,
    timeoutable: false,
    pill: (step) => {
      const s = step as unknown as { concurrency?: number; onError?: string };
      return `for each · ${s.concurrency ?? 5} at a time · ${s.onError === "stop" ? "stops if one fails" : "keeps going"}`;
    },
  },
  collect: {
    kind: "collect",
    label: "Loop output",
    category: "logic",
    colour: "var(--k-loop)",
    icon: "Merge",
    summary: "One row per item of a loop, in input order: the item, whether it worked, and its result.",
    runtime: "engine",
    engineOnly: true,
    properties: [],
    inputs: [],
    outputs: [{ name: "value", label: "one row per item", type: "any", expr: "json(outputs.<id>.value)" }],
    retryable: false,
    timeoutable: false,
    pill: () => "one row per item",
  },
  loop: {
    kind: "loop",
    label: "loop",
    category: "logic",
    colour: "var(--k-transform)",
    icon: "Clock",
    summary:
      "Repeats its child steps until a test holds. Wave 3 — declared, not runnable.",
    runtime: null,
    properties: [
      { name: "maxCount", label: "Max cycles", kind: "integer", section: "behavior", required: true, min: 1, fallback: 10 },
      { name: "conditionExpr", label: "Until", kind: "expression", section: "behavior", fallback: "" },
    ],
    // `loopVars` + `children` are nested records, not scalar properties — same
    // rule as `iteration` above.
    inputs: [],
    outputs: [],
    retryable: false,
    timeoutable: false,
    pill: (step) => {
      const max = (step as unknown as Record<string, unknown>)["maxCount"];
      return typeof max === "number" ? `loop ×${max}` : null;
    },
  },
};
/**
 * Phase 0 seam (complexity plan Phase 2): the row join across two feeds —
 * left/right step-field sources combined on left-field ↔ right-field key
 * pairs. Explicitly not `merge`: `merge` stays first-wins coalesce, the join
 * is row combination with key mapping.
 *
 * Parked outside `NODE_TYPES` until `StepKind` names it: `NODE_TYPES` is
 * `Record<StepKind, NodeTypeSpec>` and `offeredKinds()` is the only offer
 * gate, so declaring the spec here keeps both byte-identical until the
 * Phase 2 slice moves it in. `runtime: null`: never offered, refused at
 * save by name.
 */
export const JOIN_SPEC: Omit<NodeTypeSpec, "kind"> & { kind: "join" } = {
  kind: "join",
  label: "join",
  category: "transform",
  colour: "var(--k-transform)",
  icon: "Merge",
  summary:
    "Combines two feeds row by row on shared keys. Wave 2 — declared, not runnable.",
  runtime: null,
  properties: [
    { name: "left", label: "Left feed", kind: "step-field", section: "behavior", required: true, fallback: null },
    { name: "right", label: "Right feed", kind: "step-field", section: "behavior", required: true, fallback: null },
    {
      name: "keys",
      label: "Key mapping",
      kind: "key-value-list",
      section: "behavior",
      required: true,
      fallback: [],
      help: "Each row maps a left-feed field (name) to a right-feed field (value).",
    },
    {
      name: "multiplicity",
      label: "On multiple matches",
      kind: "select",
      section: "behavior",
      fallback: "first",
      options: [
        { value: "first", label: "First match" },
        { value: "fan-out-capped", label: "Fan out, capped" },
      ],
    },
    // At most 1000 output rows (validator `joinOutputRows`): past it the run
    // refuses with both-side counts named, never truncates silently.
    {
      name: "outputCap",
      label: "Output cap",
      kind: "integer",
      section: "behavior",
      min: 1,
      fallback: 1000,
      help: "Refuses past 1000 rows instead of dropping them silently.",
    },
  ],
  // Outputs are derived from the feeds — dynamic, never a static row.
  inputs: [],
  outputs: [],
  retryable: false,
  timeoutable: false,
  pill: () => null,
};

export const BOUNDARY_TYPES: { start: BoundarySpec; end: BoundarySpec } = {
  start: {
    kind: "start",
    label: "Start",
    // The flow's declared inputs live on the flow, not on a step — Stage 4.5
    // wires the existing inputs editor here.
    properties: [],
  },
  end: {
    kind: "end",
    label: "End",
    properties: [
      { name: "description", label: "Description", kind: "paragraph", section: "basic", fallback: "" },
      { name: "rows", label: "Returned values", kind: "output-rows", section: "behavior", fallback: [] },
    ],
  },
};

/** Every kind, in palette order. The single list `STEP_KINDS` mirrors copy. */
export const STEP_KINDS: readonly StepKind[] = [
  "transform",
  "code",
  "llm",
  "http",
  "branch",
  "merge",
  "tool",
  "datasource",
  "query",
  "approval",
  "classifier",
  "extract",
  "listop",
  "iteration",
  "loop",
  "for_each",
  "collect",
];

/** Kinds the palette, the picker and chat may offer — implemented ones only. */
export function offeredKinds(): StepKind[] {
  return STEP_KINDS.filter((k) => NODE_TYPES[k].runtime !== null && !NODE_TYPES[k].engineOnly);
}

/** Kinds offered from-scratch — catalogue-backed rows name a real ref instead. */
export function scratchKinds(): StepKind[] {
  return offeredKinds().filter((k) => !NODE_TYPES[k].catalogueBacked);
}

export function propertySpec(kind: StepKind, name: string): PropertySpec | undefined {
  return NODE_TYPES[kind].properties.find((p) => p.name === name);
}

