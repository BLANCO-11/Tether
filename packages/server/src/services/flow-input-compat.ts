/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AN INPUT PASSED RAW TO A FEEDER THAT NEEDS ANOTHER SHAPE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Measured: a DATE input bound verbatim to a `YYYY-MM` month parameter died at
 * runtime (`period must be YYYY-MM, got "2026-06-30"`). No validator saw it,
 * because `checkDeclaredInputs` (`flow-input-refs.ts`) checks NAMES only — its
 * docblock refuses type duty — and `checkFlowParams`
 * (`flow-validator.service.ts`) reads names, never values or types, on purpose:
 * params are an expression, so the value is not known until the step runs.
 *
 * This check asks the narrower question that IS answerable statically: the
 * input's DECLARED kind against the reader's DECLARED format. A catalogue
 * parameter that carries no `format` is unconstrained prose and never blocks —
 * the same "cannot see, so says nothing" rule `checkFlowParams` follows for a
 * jq-built params object. A reader that no longer reads the input at all (its
 * feed was rebound to a derivation's `outputs.<step>`) is not a reader of the
 * input and passes.
 *
 * ── WHY FREE TEXT PASSES ─────────────────────────────────────────────────────
 *
 * A free-text STRING carries values this check cannot see: a STRING bound to a
 * month reader may well hold `"2026-06"` at runtime, and refusing it would
 * block the drafter's canonical month vehicle (a STRING `period` read raw into
 * `month`). Static refusal would guess at a value; guessing is
 * `checkFlowParams`'s named refusal. So STRING passes into every format.
 *
 * By the same token, `text` passes every kind: a rendered calendar value is
 * fine prose (`"2026-06-30"` reads as a note), and an age in whole years is a
 * computation the author must ask for — opt-in, never implied. There is
 * deliberately no age-from-DOB derivation in the table below.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 *
 * It never refuses on behalf of a value: whether a free-text STRING holds a
 * valid month is unknowable here, and guessing is `checkFlowParams`'s named
 * refusal. It reports only RAW reads — an `inputs.<id>` template, an
 * `inputs`-row `{from:"input"}` source, or a `params`-row `expression`
 * template reading the input — into a formatted parameter of a mismatched
 * kind. Feeds from an upstream step (`{from:"step"}`, `outputs.<step>`) are
 * the derivation this finding asks for, so they pass — but only when that
 * step exists: a feed naming a step this flow does not declare is refused up
 * front (`unknown_binding_step`), before any catalogue is consulted.
 *
 * No new runtime code is needed here: the ops-api validators behind each
 * feeder are the runtime boundary that rejects a mismatched shape (that is
 * where `period must be YYYY-MM` came from). This check is the static
 * counterpart — it refuses the same pairs up front, with the derivation that
 * bridges them, so the author never ships a run the validators will fail.
 *
 * ── THE CONVERSIONS TABLE ───────────────────────────────────────────────────
 *
 * A covered pair still refuses while the read is raw — the conversion has to
 * be BUILT (a Python code step, the sole derivation vehicle; no inline jq
 * date math, no expression-language changes) — and the table entry writes the
 * remedy: which derivation to synthesize. An uncovered pair refuses without
 * one: change the input type or feed the reader from a derived value.
 */
import { inputNamesRead } from "./flow-input-refs.js";
import { collectUnknownBindingSteps, unknownBindingMessage } from "./flow-compiler.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/** The machine formats a catalogue parameter can declare. */
export type FeederFormat = "month" | "date" | "datetime" | "text";

/**
 * One derivation the chat turn can synthesize: a `(from → to)` pair a Python
 * code step bridges, and the words the finding uses to ask for it.
 */
export interface FeederConversion {
  /** The declared input kind the derivation starts from. */
  readonly from: string;
  /** The feeder format it produces. */
  readonly to: FeederFormat;
  /** The derivation's name, for the finding and the chat rule. */
  readonly name: string;
  /** How the code step does it — the remedy fragment. */
  readonly derive: string;
}

export const CONVERSIONS: readonly FeederConversion[] = [
  {
    from: "DATE",
    to: "month",
    name: "month-from-DATE",
    derive: "take the YYYY-MM prefix in Python",
  },
  {
    from: "DATETIME",
    to: "month",
    name: "month-from-DATETIME",
    derive: "take the YYYY-MM prefix in Python",
  },
  {
    from: "DATETIME",
    to: "date",
    name: "truncate-DATETIME-to-date",
    derive: "truncate to the YYYY-MM-DD date in Python",
  },
  {
    from: "DATE",
    to: "datetime",
    name: "midnight-DATE-to-datetime",
    derive: "expand to midnight (00:00:00) in Python",
  },
];

/** One catalogue parameter, with the format its annotation may carry. */
export interface FeederCatalogueParam {
  readonly name: string;
  readonly format?: string;
}

/**
 * What a ref declares, as the workspace's interfaces already state it. Extra
 * fields (a signature, a type, `required`) are fine — only `name` and the
 * optional `format` are read. A ref absent from the map, or present with no
 * params, contributes nothing: an unknown ref is `checkFlowRefs`'s finding.
 */
export type FeederCatalogue = Record<
  string,
  { readonly params?: readonly FeederCatalogueParam[] } | undefined
>;

/** The formats this check understands. Anything else is silent, never a refusal. */
const KNOWN_FORMATS: ReadonlySet<string> = new Set(["month", "date", "datetime", "text"]);

/**
 * The native kind that reads raw into each format with no derivation. `month`
 * has no native kind — no input type IS a month, so it has no entry and every
 * non-STRING read into it refuses. `text` is prose and is handled in
 * `compatible` directly (every kind renders as itself). STRING is free text
 * whose value is unknowable statically, so it is handled there too.
 */
const NATIVE_KIND: Readonly<Record<string, string>> = {
  date: "DATE",
  datetime: "DATETIME",
};

/**
 * A raw read of this kind into this format needs no derivation. Unknown
 * formats pass (silent, never a refusal); free-text STRING passes into every
 * format (its value is unknowable statically); `text` takes every kind (a
 * rendered value is fine prose). Otherwise the kind must be the format's
 * native one — looked up as data, so `month` (no entry) always refuses.
 */
function compatible(kind: string, format: string): boolean {
  if (!KNOWN_FORMATS.has(format)) return true;
  if (kind === "STRING") return true;
  if (format === "text") return true;
  return NATIVE_KIND[format] === kind;
}

function conversionFor(kind: string, format: string): FeederConversion | undefined {
  return CONVERSIONS.find((c) => c.from === kind && c.to === format);
}

function findingFor(
  stepId: string,
  field: string,
  ref: string,
  param: string,
  inputId: string,
  kind: string,
  format: string,
): string {
  const head =
    `step "${stepId}".${field}: input "${inputId}" is ${kind} but the "${ref}" parameter ` +
    `"${param}" needs ${format}${format === "month" ? " (YYYY-MM)" : ""} — INCOMPATIBLE`;
  const conversion = conversionFor(kind, format);
  if (conversion) {
    const runtime =
      format === "month"
        ? `: a ${kind} passed through verbatim fails at runtime where "${param}" expects YYYY-MM ` +
          `(measured: \`period must be YYYY-MM, got "2026-06-30"\`)`
        : `: a ${kind} passed through verbatim fails at runtime, where "${param}" expects ${format}`;
    return (
      `${head}${runtime}. Refused pending derivation: derive it with a Python code step ` +
      `(${conversion.name}: ${conversion.derive}) and rebind this reader to ` +
      `\`outputs.<step>\`, or change the input type.`
    );
  }
  return (
    `${head}: no conversion covers ${kind} → ${format}. Feed this reader from a derived ` +
    `value (a Python code step bound via \`outputs.<step>\`) or change the input type.`
  );
}

/** Every string a value carries, however nested — params objects nest. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

/**
 * The `(param, template)` pairs a `paramsExpr` feeds. Only a paramsExpr that
 * parses as plain JSON is inspected — one call object or an array of them. A
 * `{{…}}` template span, a jq program, a non-string value: all skipped under
 * the same "cannot see, so says nothing" rule `literalParamKeys` follows.
 */
function paramsExprReads(expr: string): Array<[param: string, template: string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(expr);
  } catch {
    return [];
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const out: Array<[string, string]> = [];
  for (const call of calls) {
    if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
    for (const [key, value] of Object.entries(call as Record<string, unknown>)) {
      for (const template of stringsIn(value)) out.push([key, template]);
    }
  }
  return out;
}

/**
 * Every raw input-to-feeder read: one finding per reader, each naming the
 * input, the old→new pair, and the affected `{step, field}`. Absent catalogue
 * formats pass silently; derived bindings (reads of `outputs.<step>`) are not
 * reads of the input at all.
 */
export function checkFeederCompatibility(
  model: FlowModel,
  catalogue: FeederCatalogue,
): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  const report = (finding: string): void => {
    if (seen.has(finding)) return;
    seen.add(finding);
    findings.push(finding);
  };
  // A feed rebound to a derivation that is not in the flow is not a feed at
  // all: the rev-2 `fetch.period → derive_month.month` binding passed this
  // check because only `{from:"input"}` rows were readers here, while the
  // `{from:"step"}` row named a step nobody declared. Reported before the
  // catalogue guard — a missing step blocks whatever the catalogue says — and
  // scoped to step feeds (flow output rows are `checkFlowOutput`'s finding).
  {
    const ids = (model.steps ?? []).map((s) => s.id);
    for (const ref of collectUnknownBindingSteps(model)) {
      if (!ref.outputRow) report(unknownBindingMessage(ref, ids));
    }
  }
  if (!catalogue || typeof catalogue !== "object") return findings;
  const kindById = new Map((model.inputs ?? []).map((i) => [i.id, i.type]));

  for (const step of model.steps ?? []) {
    if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") continue;
    if (typeof step.ref !== "string") continue;
    const entry = catalogue[step.ref];
    const params = entry?.params;
    // No declared params, or none carrying anything: nothing to join against.
    // An unknown ref is `checkFlowRefs`'s finding, never this one's.
    if (!Array.isArray(params) || params.length === 0) continue;
    const formatByName = new Map<string, string | undefined>();
    for (const p of params) {
      if (p !== null && typeof p === "object" && typeof p.name === "string") {
        formatByName.set(p.name, p.format);
      }
    }
    const stepId = typeof step.id === "string" ? step.id : "<unnamed step>";
    const check = (param: string, inputId: string, field: string): void => {
      const kind = kindById.get(inputId);
      // Undeclared — `checkDeclaredInputs` owns that refusal, not this check.
      if (kind === undefined) return;
      const format = formatByName.get(param);
      // The parameter carries no format: unconstrained prose, never blocked.
      if (format === undefined) return;
      if (compatible(kind, format)) return;
      report(findingFor(stepId, field, step.ref, param, inputId, kind, format));
    };

    // `paramsExpr` wins verbatim when present — the compiler renders it and the
    // rows are not the feed — so the rows below are read only in its absence.
    if (typeof step.paramsExpr === "string") {
      for (const [param, template] of paramsExprReads(step.paramsExpr)) {
        if (!formatByName.has(param)) continue;
        for (const inputId of inputNamesRead(template)) check(param, inputId, "paramsExpr");
      }
      continue;
    }
    for (const binding of step.inputs ?? []) {
      const source = binding?.source;
      if (typeof binding?.name !== "string" || source === null || source === undefined) continue;
      // `{from:"step"}` / `{from:"whole"}` is the derivation this finding asks
      // for; `literal` / `self` carry no input. Only `{from:"input"}` reads raw.
      if (source.from === "input") check(binding.name, source.inputId, "inputs");
    }
    const rows = step.params;
    if (rows !== undefined && rows !== null && typeof rows === "object") {
      for (const [name, row] of Object.entries(rows)) {
        const source = (row as { source?: unknown }).source as
          | { kind?: unknown; template?: unknown }
          | undefined;
        if (
          source !== null &&
          typeof source === "object" &&
          source.kind === "expression" &&
          typeof source.template === "string"
        ) {
          for (const inputId of inputNamesRead(source.template)) check(name, inputId, "params");
        }
        // `{kind:"step"}` is derived; `{kind:"fixed"}` carries no input.
      }
    }
  }
  return findings;
}
