// src/lib/step-io.ts — what goes INTO a step and what comes OUT, as DATA.
//
// ── ⚠ WHY THIS IS A MODULE AND NOT JSX ──────────────────────────────────────
//
// Reported from use, against Dify's node panel: *"the inspector doesn't clearly
// show what input node and output node are there for a component … no textual
// mess, just clean properties and lack of confusing description spam."*
//
// The old surface was two overlapping sections — `Output` (a paragraph about
// the kind's shape) and `Inputs and outputs` (more paragraphs, plus an editable
// name list for `code`) — and between them they printed five sentences before
// naming a single field. The information was all there and none of it was
// legible.
//
// The rules for WHICH fields a step declares, and where each one's value comes
// from, are the part worth asserting. Rendering them is not. So this module
// answers both questions as plain data and `StepIO.tsx` stays a table.
//
// ── ⚠ THE THREE STATES A BINDING CAN BE IN, AND WHY TWO IS A BUG ────────────
//
// A parameter is `bound` (something feeds it), `unset` (nothing does), or
// `unknown` (the expression was not written by the builder and this screen will
// not guess — see `flow-params.ts`, which fails closed). Collapsing `unknown`
// into `unset` is the tempting simplification and it is a false claim in the
// confident direction: it tells somebody a wired parameter is empty, and the
// obvious response is to re-bind it, which rewrites an expression that worked.
import type { AuthoredStep, InputBinding, Source as TypedSource } from "@foundry/flow-edit";
import { toLegacyInputSpelling } from "@foundry/flow-edit";
import { outputExpr, rowsExpr, soleStepRead, type OutputShapes } from "@/lib/flow-expr";
import { parseParams } from "@/lib/flow-params";
import { inputOwnerOf, outputSummary } from "@/lib/step-shape";

/**
 * The catalogue surface the reader needs: entry params by ref, and output
 * shapes. Both `FAFlowCatalogue` and the card's `FieldCatalogue` satisfy it
 * structurally, so the panel and the card read through one call.
 */
export type IoCatalogue = {
  entries: Array<{
    ref: string;
    params?: Array<{ name: string; type?: string; required?: boolean; description?: string | null; fallsBackToRequester?: boolean }>;
  }>;
  outputs: unknown;
};

export type IoType = string;

/**
 * Where one declared input's value comes from.
 *
 * `whole` is the state the card already drew but could not name: every input
 * fed by ONE whole-object read of an upstream step. It is distinct from
 * `unknown` (several readers, or none recognisable) and from `unset`.
 */
export type InputSource =
  | { kind: "step"; stepId: string; field: string; transform?: "date" | "text" | "number" }
  | { kind: "input"; inputId: string }
  | { kind: "literal"; value: string }
  /** The bare list element — a fan-out over a list of names or numbers. */
  | { kind: "self" }
  /** Every input fed by one whole-object read of this step. */
  | { kind: "whole"; stepId: string }
  | { kind: "unset" }
  | { kind: "unknown" }
  /** Display only (phase Z): a row's configuration as tokens (`cardRows`); `stepId` when a wire feeds it. */
  | { kind: "tokens"; tokens: Array<{ t: string; k: string }>; stepId?: string };

export type IoInput = {
  name: string;
  type: IoType;
  required: boolean;
  description: string | null;
  source: InputSource;
  /** Left unset, the receiver sends to whoever starts the run — so "not set" is the wrong words for it (2026-09-28). */
  fallsBackToRequester?: boolean;
};

export type IoOutput = {
  name: string;
  type: IoType;
  /** The expression a later step uses to read it, when there is one. */
  ref: string | null;
  description: string | null;
  /** The later steps that actually read it — the "feeding into" half. */
  readers: OutputReader[];
};

/**
 * One later step reading an output: which step, and which field of it — or the
 * whole object, when the reader fans out over it or binds it whole.
 */
export type OutputReader = {
  stepId: string;
  /** The output field read, `null` when the whole object is read. */
  field: string | null;
  whole: boolean;
};

export type StepIo = {
  inputs: IoInput[];
  outputs: IoOutput[];
  /**
   * A `code` step's `contract.purpose` — what the fragment is FOR.
   *
   * ⚠ Kept when the rest of the prose went, and it is the one sentence that
   * earns its place: it is the step's own description (Dify puts the same thing
   * under the panel title), it is written per step rather than per kind, and it
   * is the only text on the panel that is not restating a field below it.
   */
  purpose: string | null;
  /**
   * Who owns a shape this screen cannot edit — "the endpoint", "the query".
   * ⚠ One short noun phrase, rendered as a head hint, NEVER as a sentence in
   * the row stack. The rows are the content; this is a label on them.
   */
  inputsOwnedBy: string | null;
  outputsOwnedBy: string | null;
  /** True when the step fans out over an upstream step's rows. */
  overStepId: string | null;
  /**
   * The one upstream step a non-blank, unreadable expression reads whole —
   * the step the per-row `whole` sources name. Null for per-field bindings,
   * the blank fresh-step state, and expressions naming zero or several steps.
   * The panel's behaviour line ("runs once, reading the whole of X") reads
   * this; it is never derived twice.
   */
  wholeFrom: string | null;
  /**
   * True when the panel may offer a per-input editor. False exactly when the
   * inputs are set by an expression no writer may re-emit (hand-written, or a
   * filter outside the builder's vocabulary) — the panel then shows the truth
   * plus the convert action, never a picker.
   */
  editable: boolean;
  /**
   * Why `editable` is false. `"expression"` means the values live in a
   * hand-written expression; `null` means they are editable (including the
   * blank fresh-step state, which edits as new bindings).
   */
  readonly: "expression" | null;
  /**
   * The kind's real caution from the catalogue (I-42, I-44, an agent's answer
   * not being a shape to depend on). Kept — it is written from failures — but
   * rendered once, below the rows.
   */
  caution: string | null;
};
/**
 * The STORED typed bindings, when the step carries any (Stage 3
 * dual representation). A non-empty `inputs` array is authoritative: the
 * display string beside it was rendered from these very bindings, so it is
 * parseable by construction and never needs guessing. An absent or EMPTY
 * array is the ancient-v1 shape — the reopen path (`authoredFromModel`)
 * carries display strings only — and reads through the expression parsers
 * below, exactly as before.
 */
function typedInputsOf(step: AuthoredStep): InputBinding[] | null {
  const raw = "inputs" in step ? step.inputs : undefined;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

/**
 * One stored binding as the row's source. Total: every stored shape has a
 * row shape, including `whole` (a field-less step read is NOT the same claim
 * — the card lands its edge on it) and the column `transform` a projection
 * was written with, which the runtime value still carries.
 */
function typedBindingToInput(source: TypedSource): InputSource {
  switch (source.from) {
    case "step": {
      const base = { kind: "step" as const, stepId: source.stepId, field: source.field };
      // Writers carry the column transform through on the runtime value (see
      // `toTypedSource` in `step-binding.ts`); the registry type does not
      // name it, so read it only when it is one of the three the builders
      // emit — anything else is not a projection this screen wrote.
      const transform = "transform" in source ? source.transform : undefined;
      return transform === "date" || transform === "text" || transform === "number"
        ? { ...base, transform }
        : base;
    }
    case "whole":
      return { kind: "whole", stepId: source.stepId };
    case "input":
      return { kind: "input", inputId: source.inputId };
    case "literal":
      return { kind: "literal", value: source.value };
    case "self":
      return { kind: "self" };
  }
}

/**
 * The one upstream step every bound input reads whole — the typed version of
 * the unanimity rule the `code` branch already applies to parsed sources.
 * Null for per-field bindings, the blank fresh-step state, and feeds naming
 * zero or several steps.
 */
function typedWholeFrom(sources: InputSource[]): string | null {
  const feeds = sources.filter((s) => s.kind !== "unset");
  const head = feeds[0];
  if (!head || head.kind !== "whole") return null;
  return feeds.every((s) => s.kind === "whole" && s.stepId === head.stepId) ? head.stepId : null;
}


const CALL_KINDS = new Set(["datasource", "query", "tool", "trigger", "action", "notify", "report", "end"]);

/**
 * Everything the panel needs to draw a step's inputs and outputs.
 *
 * ⚠ **`code` is the only kind whose declarations are the step's own.** Its
 * `contract` carries typed inputs and outputs and has since Phase 4. Every
 * other kind's inputs are its ref's parameters (owned by the endpoint or the
 * query) and its output is the kind's fixed shape — which is why nothing here
 * is editable except where `StepShape` already allowed it.
 */
export function stepIo(step: AuthoredStep, catalogue: IoCatalogue, allSteps: AuthoredStep[]): StepIo {
  const shapes = catalogue.outputs as unknown as OutputShapes;
  // ⚠ Through `outputSummary`, never off `catalogue.outputs` directly — it is
  // the one place that resolves `<id>` and decides who owns a shape, and a
  // has learned something new.
  const summary = outputSummary(shapes, step.kind as never, step.id);
  const caution = summary.caution;

  // ── Inputs ────────────────────────────────────────────────────────────────
  let inputs: IoInput[] = [];
  let overStepId: string | null = null;
  let inputsOwnedBy: string | null = null;
  let wholeFrom: string | null = null;
  let editable = false;
  let readonlyState: StepIo["readonly"] = null;

  let purpose: string | null = null;

  if (step.kind === "code") {
    const contract = (step as Extract<AuthoredStep, { kind: "code" }>).contract;
    purpose = contract.purpose || null;
    // ⚠ The head hint carries the honesty statement the old paragraph made:
    // these names and types were written when the contract was created and
    // nothing on this screen writes them. Saying it ONCE, as a label on the
    // rows, is the whole difference between this panel and the old one.
    inputsOwnedBy = "this step's contract";
    // The per-field read lives here (moved from `flow-field-drop.ts`'s
    // `codePorts`): `inputExpr` names each bound input's source. A whole-rows
    // address reads as `whole` (rendered `whole list from <step>`), a column
    // projection as `step` with its field, a flow input as `input`, a fixed
    // string as `literal` — each recovered only from a shape `buildCodeInput`
    // emits, never guessed. Anything hand-shaped reads `unknown` while the
    // payload is unre-emittable (see below), never `unset`: the convert action
    // owns that loss, not a row pill.
    const names = contract.input.map((f) => f.name);
    const typed = typedInputsOf(step);
    if (typed) {
      // ⚠ TYPED-FIRST (Stage 3): the writer stored these beside the payload,
      // so they are bound by construction — `bound` when set, `unset` when
      // null, never `unknown`. A name the bindings do not mention is unbound,
      // not unreadable.
      const byName = new Map(typed.map((b) => [b.name, b.source]));
      editable = true;
      readonlyState = null;
      inputs = contract.input.map((f) => {
        const bound = byName.get(f.name);
        const source: InputSource = bound ? typedBindingToInput(bound) : { kind: "unset" };
        return {
          name: f.name,
          type: f.type,
          required: true,
          description: f.description ?? null,
          source,
        } satisfies IoInput;
      });
      wholeFrom = typedWholeFrom(inputs.map((i) => i.source));
    } else {
      const expr = "inputExpr" in step ? (step.inputExpr as string | null) : null;
      const parsed = codeInputSources(expr, names, { steps: allSteps, shapes });
      editable = codeInputEditable(expr, names);
      readonlyState = editable ? null : "expression";
      inputs = contract.input.map((f) => {
        const found = parsed.find((p) => p.name === f.name);
        const source: InputSource = editable && found ? found.source : { kind: "unknown" };
        return {
          name: f.name,
          type: f.type,
          required: true,
          description: f.description ?? null,
          source,
        } satisfies IoInput;
      });
      // The behaviour line's source, like the call kinds': the one step every
      // bound input reads whole. A column, input, or literal bind among them
      // means no single whole-object feed, so this stays null.
      const wholeIds = parsed.filter((p) => p.source.kind !== "unset").map((p) => p.source);
      const head = wholeIds[0];
      const first = head && head.kind === "whole" ? head.stepId : null;
      wholeFrom = editable && first !== null && wholeIds.every((s) => s.kind === "whole" && s.stepId === first) ? first : null;
    }
  } else if (CALL_KINDS.has(step.kind)) {
    const ref = "ref" in step ? (step.ref as string) : "";
    const entry = catalogue.entries.find((e) => e.ref === ref);
    const raw = "paramsExpr" in step ? (step.paramsExpr as string | null) : null;
    const typed = typedInputsOf(step);
    if (typed) {
      // ⚠ TYPED-FIRST (Stage 3): the writer stored these beside the display
      // string, so a row is `bound` when its source is set and `unset` when
      // null or unmentioned — never `unknown`. The display string was rendered
      // from these bindings, so the fan-out it names parses; `overStepId`
      // still comes from that parse (writers do not store `over` yet).
      const byName = new Map(typed.map((b) => [b.name, b.source]));
      editable = true;
      readonlyState = null;
      overStepId = parseParams(shapes, allSteps, raw)?.overStepId ?? null;
      inputsOwnedBy = inputOwnerOf(step.kind);
      wholeFrom = typedWholeFrom(typed.map((b): InputSource => (b.source ? typedBindingToInput(b.source) : { kind: "unset" })));
      inputs = (entry?.params ?? []).map((p) => {
        const bound = byName.get(p.name);
        const source: InputSource = bound ? typedBindingToInput(bound) : { kind: "unset" };
        return {
          name: p.name,
          type: p.type ?? "string",
          required: p.required ?? false,
          description: p.description ?? null,
          source,
          ...(p.fallsBackToRequester ? { fallsBackToRequester: true } : {}),
        } satisfies IoInput;
      });
    } else {
    // ⚠ Emptiness is a third state, not a parse failure: a fresh step has
    // nothing written yet, so every input is `unset` AND editable. A
    // non-empty expression `parseParams` cannot read is `whole` when it names
    // exactly one step, else `unknown` — never `unset`.
    const blank = !raw || !raw.trim();
    const parsed = parseParams(shapes, allSteps, raw);
    // ⚠ `skipped` is a third refusal: the mappings ARE readable per-field, but
    // a rebuild would drop the skipped pairs — so the step is not re-emittable
    // and the skipped rows read `unknown`, never `unset`.
    const readable = parsed !== null && !parsed.filterUnreadable && parsed.skipped.length === 0;
    editable = blank || readable;
    readonlyState = editable ? null : "expression";
    overStepId = parsed?.overStepId ?? null;
    inputsOwnedBy = inputOwnerOf(step.kind);
    const sole = !blank && !parsed ? soleStepRead(raw as string, { steps: allSteps }) : null;
    // The behaviour line's source: the same single read the `whole` rows name.
    wholeFrom = sole;
    inputs = (entry?.params ?? []).map((p) => {
      const m = parsed?.mappings.find((x) => x.param === p.name);
      let source: InputSource;
      if (m) {
        if (m.source.from === "step") {
          source = { kind: "step", stepId: m.source.stepId, field: m.source.field };
        } else if (m.source.from === "input") {
          source = { kind: "input", inputId: m.source.inputId };
        } else if (m.source.from === "self") {
          source = { kind: "self" };
        } else if (m.source.value.includes("{{")) {
          // ⚠ **A "literal" CARRYING A TEMPLATE IS NOT A FIXED VALUE.** The
          // single (non-fan-out) params form has no row context, so a per-field
          // step read arrives as a literal holding the whole expression. Taken
          // at face value the card would print the template where a person
          // expects a value and claim a constant where a step feeds the param.
          // A template naming exactly one step is bound to that step (the card
          // never claimed which field, so `field` stays empty); more than one,
          // or none, is unknown — certainly not a constant.
          const id = soleStepRead(m.source.value, { steps: allSteps });
          source = id ? { kind: "step", stepId: id, field: "" } : { kind: "unknown" };
        } else {
          source = { kind: "literal", value: m.source.value };
        }
      } else if (parsed?.skipped.includes(p.name)) {
        source = { kind: "unknown" };
      } else if (blank || parsed) {
        // A filtered fan-out's mappings ARE per-field, so its unmapped params
        // are honestly `unset` — only editing is refused, not reading.
        source = { kind: "unset" };
      } else if (sole) {
        source = { kind: "whole", stepId: sole };
      } else {
        source = { kind: "unknown" };
      }
      return {
        name: p.name,
        type: p.type ?? "string",
        required: p.required ?? false,
        description: p.description ?? null,
        source,
        ...(p.fallsBackToRequester ? { fallsBackToRequester: true } : {}),
      } satisfies IoInput;
    });
  }
  }

  // ── Outputs ───────────────────────────────────────────────────────────────
  let outputs: IoOutput[] = [];
  let outputsOwnedBy: string | null = null;
  const ref = summary.expr;
  // Who reads this step: every other step whose params expression names it.
  // ⚠ `paramsExpr` carriers only. A `transform` `expr`, a `code` `inputExpr`
  // or a `condition` test can also name an output, but those are free-form
  // strings, not per-field mappings — claiming a field off one would be a
  // guess, so they are not counted here.
  const readBy: OutputReader[] = [];
  for (const s of allSteps) {
    if (s.id === step.id || !("paramsExpr" in s)) continue;
    const parsed = parseParams(shapes, allSteps, s.paramsExpr as string | null);
    if (!parsed) continue;
    // A fan-out over this step reads its fields per row — prefer the precise
    // field entries; the whole-object marker is the fallback when the fan
    // names no field (it still iterates the rows, which is a dependency).
    if (parsed.overStepId === step.id) {
      const fields = parsed.mappings.flatMap((m) => (m.source.from === "step" ? [m.source.field] : []));
      if (fields.length > 0) {
        for (const field of fields) readBy.push({ stepId: s.id, field, whole: false });
      } else {
        readBy.push({ stepId: s.id, field: null, whole: true });
      }
      continue;
    }
    for (const m of parsed.mappings) {
      if (m.source.from === "step" && m.source.stepId === step.id) {
        readBy.push({ stepId: s.id, field: m.source.field ?? null, whole: false });
      }
    }
  }

  if (step.kind === "code") {
    const contract = (step as Extract<AuthoredStep, { kind: "code" }>).contract;
    outputs = contract.output.map((f) => ({
      name: f.name,
      type: f.type,
      // `outputs.<id>.vars.result` is the whole object; a named key hangs off it.
      ref: ref ? `${ref}.${f.name}` : null,
      description: f.description ?? null,
      // A whole-object reader feeds every declared field; a field reader only
      // the field it names.
      readers: readBy.filter((r) => r.whole || r.field === f.name),
    }));
  } else if (ref) {
    outputsOwnedBy = summary.ownedBy;
    outputs = [
      {
        // ⚠ Not a guessed field list. A `tool`'s body is whatever the endpoint
        // returns and this client has never seen it; naming columns here would
        // be the fabrication the whole run surface refuses.
        name: summary.describes ? "response" : "value",
        type: "object",
        ref,
        description: summary.describes,
        readers: readBy,
      },
    ];
  }

  return { inputs, outputs, purpose, inputsOwnedBy, outputsOwnedBy, overStepId, wholeFrom, editable, readonly: readonlyState, caution };
}

/**
 * Whether a `code` step's `inputExpr` may be rebuilt field by field.
 *
 * `buildCodeInput` emits exactly the contract's fields, each reading `null`,
 * one `{{ … }}` template, or one fixed string — so re-emitting is lossless
 * only when the payload holds nothing else. A missing key is fine (the rebuild
 * adds it as `null`); an extra key, a number or object where a value belongs,
 * or a payload that is not an object at all fails closed: the panel shows the
 * truth plus the convert action, and no writer touches it.
 *
 * ⚠ The check is structural, not `JSON.parse`: a template is not JSON, so
 * parsing the raw payload refuses every payload the builder itself wrote.
 */
export function codeInputEditable(inputExpr: string | null | undefined, names: string[]): boolean {
  if (typeof inputExpr !== "string" || !inputExpr.trim()) return true;
  // The escaped input spelling reads as the legacy one it replaced (I-288): both pass the same input; the parser knows one.
  const src = toLegacyInputSpelling(inputExpr).trim();
  // One pair: a JSON key reading `null`, a single template, or a fixed string
  // (a literal binding the picker wrote and reads back). Anything else (a
  // number, a nested object) matches nothing and survives into the remainder,
  // which fails the check below — the safe direction.
  const pair = /"((?:[^"\\]|\\.)*)"\s*:\s*(\{\{[\s\S]*?\}\}|null|"(?:[^"\\]|\\.)*")/g;
  let m: RegExpExecArray | null;
  let rest = src;
  const spans: Array<[number, number]> = [];
  while ((m = pair.exec(src)) !== null) {
    let key: unknown;
    try {
      key = JSON.parse(`"${m[1]}"`);
    } catch {
      return false;
    }
    if (typeof key !== "string" || !names.includes(key)) return false;
    spans.push([m.index, m.index + m[0].length]);
  }
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (!span) continue;
    rest = rest.slice(0, span[0]) + rest.slice(span[1]);
  }
  // Every pair accounted for: only the object's own punctuation may remain.
  return /^[{}\s,]*$/.test(rest);
}

/** Escape a field name for the key half of a `"name": <value>` pair regex. */
function escapeRe(name: string): string {
  return JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What `codeInputSources` needs to recognise a step's addresses without guessing. */
export type CodeInputContext = {
  steps: AuthoredStep[];
  shapes: OutputShapes;
};

/** A template that IS one step's whole rows or whole output — the whole-list bind. */
function codeWholeOf(inner: string, ctx: CodeInputContext): string | null {
  for (const s of ctx.steps) {
    if (rowsExpr(ctx.shapes, s)?.trim() === inner) return s.id;
    const out = outputExpr(ctx.shapes, s.kind as never, s.id);
    if (out !== null && out.trim() === inner) return s.id;
  }
  return null;
}

/** A projected column the builder wrote: `.field`, `.["field"]`, or a known transform wrapper. */
function codeProjection(proj: string): { field: string; transform?: "date" | "text" | "number" } | null {
  const plain = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(proj.trim());
  if (plain && plain[1]) return { field: plain[1] };
  const quoted = /^\.\["((?:[^"\\]|\\.)*)"\]$/.exec(proj.trim());
  if (quoted && quoted[1] !== undefined) {
    try {
      const field = JSON.parse(`"${quoted[1]}"`) as unknown;
      if (typeof field === "string" && field) return { field };
    } catch {
      return null;
    }
    return null;
  }
  const wrapped = /^\(([\s\S]*) \|\s*(tostring\s*\|\s*split\("T"\)\[0\]|tostring|tonumber)\)$/.exec(proj.trim());
  const inner = wrapped && wrapped[1] ? codeProjection(wrapped[1]) : null;
  if (!wrapped || !inner || inner.transform) return null;
  const wrapper = wrapped[2].replace(/\s+/g, "");
  if (wrapper === 'tostring|split("T")[0]') return { field: inner.field, transform: "date" };
  if (wrapper === "tostring") return { field: inner.field, transform: "text" };
  if (wrapper === "tonumber") return { field: inner.field, transform: "number" };
  return null;
}

/**
 * A column projection over one step's rows — exactly what `buildCodeInput`
 * emits for a step pick with a field, recognised by rebuilding each
 * candidate's rows address rather than by scanning for an id (so a step whose
 * id is a substring of another's cannot be picked). Anything else naming a
 * step is NOT a column read: it is hand-shaped, and reads `unknown`.
 */
function codeColumnOf(
  inner: string,
  ctx: CodeInputContext,
): { stepId: string; field: string; transform?: "date" | "text" | "number" } | null {
  const pipe = inner.indexOf("|");
  if (pipe < 0) return null;
  const head = inner.slice(0, pipe).trim();
  const tail = inner.slice(pipe + 1).trim();
  const program = /^jq\('([\s\S]*)'\)$/.exec(tail);
  const body = program && program[1] ? /^\[\.\[\]\s*\|\s*([\s\S]*)\]$/.exec(program[1]) : null;
  const proj = body && body[1] ? codeProjection(body[1]) : null;
  if (!proj) return null;
  for (const s of ctx.steps) {
    if (rowsExpr(ctx.shapes, s)?.trim() === head) return { stepId: s.id, field: proj.field, transform: proj.transform };
  }
  return null;
}

/** One template's meaning — `whole` only for the exact addresses above, never by substring. */
function codeTemplateOf(inner: string, ctx: CodeInputContext): InputSource {
  const t = inner.trim();
  const whole = codeWholeOf(t, ctx);
  if (whole !== null) return { kind: "whole", stepId: whole };
  const input = /^inputs\.([A-Za-z0-9_]+)$/.exec(t);
  if (input && input[1]) return { kind: "input", inputId: input[1] };
  const column = codeColumnOf(t, ctx);
  if (column) {
    return column.transform
      ? { kind: "step", stepId: column.stepId, field: column.field, transform: column.transform }
      : { kind: "step", stepId: column.stepId, field: column.field };
  }
  return { kind: "unknown" };
}

/**
 * A `code` step's per-field bindings, read out of `inputExpr`.
 *
 * ⚠ **`ContractField` HAS NO `from` FIELD — the contract declares the shape and
 * the payload carries the binding.** Reading the contract looks right, compiles,
 * and reports every input as unset for ever.
 *
 * Each field's value is `null`/missing (unbound), one template (a whole-list
 * bind, a column projection, or a flow input — see above), or one fixed string
 * (a literal the picker wrote). A value in any other shape — a number, a nested
 * object, a template naming no recognisable step — is `unknown`, and a value
 * whose template closes early (`}}` before its real close) fails the delimiter
 * check below and reads `unknown` too: under-reporting draws no wire that is
 * not there, which is the defect this change exists to remove.
 */
export function codeInputSources(
  inputExpr: string | null | undefined,
  names: string[],
  ctx: CodeInputContext,
): Array<{ name: string; source: InputSource }> {
  // The escaped input spelling reads as the legacy one it replaced (I-288): both pass the same input; the parser knows one.
  const src = typeof inputExpr === "string" ? toLegacyInputSpelling(inputExpr) : "";
  const unbound: InputSource = { kind: "unset" };
  const unreadable: InputSource = { kind: "unknown" };
  return names.map((name) => {
    const m = new RegExp(`${escapeRe(name)}\\s*:\\s*(\\{\\{[\\s\\S]*?\\}\\}|null|"(?:[^"\\\\]|\\\\.)*")`).exec(src);
    if (!m || !m[1]) return { name, source: unbound };
    // The value must END the pair: trailing template text means the template
    // closed early and the rest is not this field's binding.
    const at = (m.index ?? 0) + m[0].length;
    const after = src.slice(at).trimStart();
    if (after && after[0] !== "," && after[0] !== "}") return { name, source: unreadable };
    const raw = m[1];
    if (raw === "null" || raw === '""') return { name, source: unbound };
    if (raw.startsWith('"')) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return { name, source: unreadable };
      }
      // ⚠ A flow input renders QUOTED since phase 3 (630f0a8 — bare, a STRING
      // input broke the payload's JSON), so `"{{ inputs.x }}"` is an INPUT, not a
      // literal: read it as a literal and the next canvas edit silently retypes
      // the binding. Only the exact single-input template qualifies.
      const quotedInput = typeof value === "string" ? /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/.exec(value) : null;
      if (quotedInput) return { name, source: { kind: "input", inputId: quotedInput[1]! } };
      if (typeof value === "string") return { name, source: { kind: "literal", value } };
      return { name, source: unreadable };
    }
    const inner = /^\{\{([\s\S]*)\}\}$/.exec(raw);
    if (!inner || inner[1] === undefined) return { name, source: unreadable };
    return { name, source: codeTemplateOf(inner[1], ctx) };
  });
}

/**
 * One source, as the short text the row shows — the panel AND the card, so the
 * two surfaces cannot disagree about what feeds an input.
 *
 * ⚠ **`unknown` and `unset` must read differently, and neither may read as the
 * other.** They are the two halves of the three-state rule at the top of this
 * file: one says nothing feeds this, the other says this screen cannot tell.
 */
export function inputSourceText(s: InputSource): string {
  switch (s.kind) {
    case "step":
      return `${s.stepId} / ${s.field}`;
    case "input":
      return `input / ${s.inputId}`;
    case "literal":
      return s.value === "" ? '""' : `"${s.value}"`;
    case "self":
      return "each item itself";
    case "whole":
      return `whole list from ${s.stepId}`;
    case "unset":
      return "not set";
    case "unknown":
      return "set in the expression";
    case "tokens":
      return s.tokens.map((t) => t.t).join(" ");
  }
}

/**
 * Every input bound to a step that is no longer in the flow. A `step` source
 * names its field; a `whole` source reads the entire step, so its field is
 * empty — renderers say `the whole of <stepId>` for those. The panel's warn
 * block, the card's `broken` state and the readiness sheet all read this one
 * list; nothing re-derives it.
 */
export function brokenReferences(
  step: AuthoredStep,
  allSteps: AuthoredStep[],
  catalogue: IoCatalogue,
): Array<{ name: string; stepId: string; field: string }> {
  const ids = new Set(allSteps.map((s) => s.id));
  const out: Array<{ name: string; stepId: string; field: string }> = [];
  for (const f of stepIo(step, catalogue, allSteps).inputs) {
    if (f.source.kind === "step" && !ids.has(f.source.stepId)) {
      out.push({ name: f.name, stepId: f.source.stepId, field: f.source.field });
    } else if (f.source.kind === "whole" && !ids.has(f.source.stepId)) {
      out.push({ name: f.name, stepId: f.source.stepId, field: "" });
    }
  }
  return out;
}
