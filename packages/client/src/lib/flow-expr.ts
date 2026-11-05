// src/lib/flow-expr.ts — building Kestra expressions from picks, inside D-22 by
// construction. Programme 3, Stage 5.
//
// ── The problem this solves, measured rather than supposed ───────────────────
//
// `paramsExpr` is a Pebble template wrapping a jq program, and everything the
// canvas emits passes D-22's allowlist: five variable roots, seven callables,
// everything else rejected **by name**. That is a good boundary and a terrible
// text box. `outline:measure` produced the evidence — a draft was refused for
// using jq variable bindings, with the finding "`vs` is not readable in a
// generated expression". A model hit that. A finance manager typing into a
// textarea will hit it every time.
//
// So the inspector does not ask anyone to write an expression. It asks two
// questions it can render as dropdowns — *which upstream step*, and *which of
// its fields goes in which parameter* — and this file turns the answers into a
// string. The allowlist is then satisfied **by construction**: every expression
// below is assembled from `outputs.<id>`, `inputs.<id>`, a literal, and the jq
// and `json` calls that are already permitted. Nothing here can emit a call to
// anything else, because there is no code path that writes a function name it
// was given.
//
// ⚠ It is still checked. `validateAgainstAllowlist` below re-reads what was
// built, using the roots and calls **served by the catalogue** rather than a
// second copy of the list. Belt and braces on purpose: the raw-expression escape
// hatch exists (people who know jq should not be locked out), and everything
// that comes back through it goes through the same check.

import type { AuthoredStep } from "@/lib/flow-authoring";
import type { BranchTest, CodeInputValue, ItemPredicate } from "@foundry/flow-edit";

// ── Stage 3.2: the builders moved to `@foundry/flow-edit` (`render.ts`) ─────
//
// The six builders plus `rowsExpr` and the `BranchTest` vocabulary are pure
// string assembly with no client imports, so one module serves the panel, the
// server compiler and the stored-model upgrade. Everything below re-exports
// them, so the panel, the card and the writers keep their import path while
// the implementation lives in exactly one place.
export {
  BRANCH_TESTS,
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  buildSingleParams,
  outputExpr,
  rowsExpr,
} from "@foundry/flow-edit";
export type { BranchTest, CodeInputValue, ItemPredicate, OutputShapes } from "@foundry/flow-edit";

/** Served by `GET …/catalogue`. Never hardcoded here — that is the drift this avoids. */
export type ExprAllowlist = { roots: string[]; calls: string[] };

// ── The picker's own vocabulary — deliberately NOT the stored spelling ──────
//
// `Source` here is the narrow client form (no `whole`): the panel's parsers
// (`parseParams`, `codeInputSources`) can only ever read per-field bindings,
// and their narrowing (`step`/`input`/`self` handled, the rest is a literal)
// depends on that. The stored spelling (`@foundry/flow-edit` `Source`) is the
// wide form — it adds `whole` for whole-rows binds the panel reads as one
// step. Narrow assigns to wide, so builders and writers accept these directly;
// the writers' `toTypedSource` bridges the one direction that needs a name.
export type Source =
  /** A field off an upstream step's rows — `.contact_email`. */
  | { from: "step"; stepId: string; field: string; transform?: "date" | "text" | "number" }
  /** A flow input — `{{ inputs.period }}`. */
  | { from: "input"; inputId: string }
  /** Typed by the person, used verbatim as a literal. */
  | { from: "literal"; value: string }
  /** The bare list element — `[.[] | {name: .}]`. For iterating a list of names/numbers. */
  | { from: "self" };

export type Mapping = { param: string; source: Source };

/**
 * The one step an expression reads, or null when it reads none or several.
 *
 * ⚠ ONE reader, shared by the panel (`step-io.ts`), the card
 * (`flow-field-drop.ts`) and the writer (`step-binding.ts`) — D-197. Two copies
 * of "which step does this expression read" drift in the direction where the
 * card's ports and its params handle name different steps.
 *
 * Read from the EXPRESSION, not from `dependsOn`: a step may depend on several
 * others while its params read one. Exactly one match counts — two `outputs.…`
 * reads mean the value is assembled from more than one place, and there is no
 * single step to point at.
 */
export function soleStepRead(expr: string, flow: { steps: Array<{ id: string }> }): string | null {
  const ids = new Set<string>();
  for (const m of expr.matchAll(/outputs\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (flow.steps.some((s) => s.id === m[1])) ids.add(m[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Read a `select(…)` inner test back into the picks that produced it — the
 * inverse of `perItemTest`, one vocabulary both directions. Returns `null`
 * when the test is not byte-for-byte a shape `perItemTest` emits; the caller
 * must then treat the filter as unreadable rather than guess.
 */
export function readItemPredicate(test: string): ItemPredicate | null {
  const t = test.trim();
  // `(.f | tonumber?) OP n` / `(. | tonumber?) OP n` — the numeric family.
  let m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\|\s*tonumber\?\)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t);
  if (m) {
    const op = m[2] === ">" ? "field_gt" : m[2] === ">=" ? "field_gte" : m[2] === "<" ? "field_lt" : "field_lte";
    return { test: op, field: m[1] === "." ? undefined : m[1].slice(1), value: m[3] };
  }
  m = /^has\("([A-Za-z0-9_]+)"\)$/.exec(t);
  if (m) return { test: "field_present", field: m[1] };
  m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\/\/\s*""\)\s*==\s*""$/.exec(t);
  if (m) return { test: "field_empty", field: m[1] === "." ? undefined : m[1].slice(1) };
  // `(.f // "") | contains("v")` — greedy value so a `)` inside the string
  // (e.g. `contains("a)b")`) does not end the match early.
  m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\/\/\s*""\)\s*\|\s*(contains|startswith|endswith)\((.*)\)$/.exec(t);
  if (m) {
    try {
      const value: unknown = JSON.parse(m[3]);
      if (typeof value !== "string") return null;
      const kind = m[2] === "contains" ? "field_contains" : m[2] === "startswith" ? "field_starts" : "field_ends";
      return { test: kind, field: m[1] === "." ? undefined : m[1].slice(1), value };
    } catch {
      return null;
    }
  }
  m = /^(\.[A-Za-z0-9_]+|\.)\s*(==|!=)\s*(.*)$/.exec(t);
  if (m) {
    try {
      const value: unknown = JSON.parse(m[3].trim());
      if (typeof value !== "string") return null;
      return { test: m[2] === "==" ? "field_eq" : "field_ne", field: m[1] === "." ? undefined : m[1].slice(1), value };
    } catch {
      return null;
    }
  }
  return null;
}



/**
 * A picker's `Source` resolved against the flow: step ids become the steps
 * whose rows the payload reads (`null` when the id names nothing — an
 * unresolvable feed binds nothing), `self` becomes `null` (see above).
 */
export function codeInputValue(
  source: Source | null,
  resolve: (stepId: string) => AuthoredStep | null,
): CodeInputValue {
  if (!source) return null;
  if (source.from === "step") {
    const step = resolve(source.stepId);
    return step ? { kind: "step", step, field: source.field, transform: source.transform } : null;
  }
  if (source.from === "input") return { kind: "input", inputId: source.inputId };
  if (source.from === "literal") return { kind: "literal", value: source.value };
  return null;
}



/** A prompt — also a JSON string, for the same reason. */
export function buildAgentPrompt(text: string): string {
  return JSON.stringify(text);
}

// ── The check that runs on everything, built or typed ────────────────────────

const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const ROOT_RE = /(^|[^.\w'"])([A-Za-z_][A-Za-z0-9_]*)/g;
const FILTER_RE = /\|\s*([A-Za-z_][A-Za-z0-9_]*)/g;

function blankStrings(s: string): string {
  return s.replace(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));
}

/**
 * D-22, client-side — a PREVIEW of the server's answer, never a replacement.
 *
 * The authority is `validateModelExpressions` inside `flowService.writeRevision`
 * and nothing here changes that. This exists so the raw-expression escape hatch
 * can mark a field red as it is typed, instead of failing a save minutes later.
 *
 * ⚠ It takes the allowlist as an argument, fetched from the catalogue. A
 * hardcoded copy would be a second definition of the security boundary, and the
 * failure mode is silent in the dangerous direction: a client list that grew a
 * name the server never allowed would show green and fail on save, and one that
 * lost a name the server allows would refuse valid expressions with the server
 * disagreeing.
 */
export function validateAgainstAllowlist(expr: string, allow: ExprAllowlist): string[] {
  const roots = new Set(allow.roots);
  const calls = new Set(allow.calls);
  const findings: string[] = [];

  for (const m of expr.matchAll(TEMPLATE_RE)) {
    const body = blankStrings(m[1]);
    const called = new Set<string>();
    for (const c of body.matchAll(CALL_RE)) called.add(c[1]);
    for (const f of body.matchAll(FILTER_RE)) called.add(f[1]);

    for (const name of called) {
      if (!calls.has(name)) {
        findings.push(`\`${name}(…)\` is not callable here. Allowed: ${allow.calls.join(", ")}.`);
      }
    }
    for (const r of body.matchAll(ROOT_RE)) {
      const name = r[2];
      if (called.has(name) || roots.has(name)) continue;
      if (name === "true" || name === "false" || name === "null") continue;
      findings.push(`\`${name}\` is not readable here. Allowed: ${allow.roots.join(", ")}.`);
    }
  }
  return [...new Set(findings)];
}

/**
 * Read a built condition back into the picks that produced it.
 *
 * ⚠ **THE FORM MUST BE DERIVED FROM THE STEP, NOT HELD BESIDE IT.** The branch
 * form used to initialise `test`/`field`/`value` to defaults in local state, so
 * reopening a configured branch showed *"has any rows"* whatever it actually
 * tested — the form disagreed with the flow, and the first edit wrote the
 * form's version back over the real one. Nothing failed; the condition just
 * quietly became something else.
 *
 * ⚠ **It is the INVERSE of `buildCondition` and is pinned as one.** A parser
 * written by eye drifts the moment a builder changes, and the drift is silent
 * in exactly the direction above. The round-trip test covers every operator.
 *
 * ⚠ **An expression it cannot read returns the DEFAULT picks and an
 * `unparsed` flag**, never a guess. A hand-written or imported condition is
 * legitimate; the honest answer is that this form cannot show it, not a set of
 * picks that would overwrite it with something else on the next keystroke.
 */
export type ParsedCondition = {
  overId: string;
  test: BranchTest;
  field: string;
  value: string;
  /** True when the expression exists but is not one this form built. */
  unparsed: boolean;
};

export function parseCondition(expr: string | null | undefined): ParsedCondition {
  const empty: ParsedCondition = { overId: "", test: "any", field: "", value: "", unparsed: false };
  if (!expr) return empty;
  const m = /^\{\{\s*(.+?)\s*\|\s*jq\('(.+)'\)\s*\|\s*first\s*\}\}$/s.exec(expr);
  if (!m) return { ...empty, unparsed: true };
  const [, rows, prog] = m;
  // Every template in the catalogue's output table names the step as
  // `outputs.<id>`; the surrounding envelope differs per kind and does not
  // matter here.
  const idm = /outputs\.([A-Za-z0-9_]+?)(?:_await)?[.)]/.exec(rows!);
  const overId = idm?.[1] ?? "";
  const P = prog!;

  const simple: Array<[string, BranchTest]> = [
    ["length > 0", "any"],
    ["length == 0", "none"],
  ];
  for (const [p, t] of simple) if (P === p) return { ...empty, overId, test: t };

  const str = (re: RegExp, test: BranchTest): ParsedCondition | null => {
    const r = re.exec(P);
    if (!r) return null;
    let value = "";
    if (r[2] !== undefined) {
      try {
        value = JSON.parse(r[2]) as string;
      } catch {
        return null;
      }
    }
    return { overId, test, field: r[1]!, value, unparsed: false };
  };

  return (
    str(/^any\(\.\[\]; \.([A-Za-z0-9_]+) == (".*")\)$/, "field_eq") ??
    str(/^any\(\.\[\]; \.([A-Za-z0-9_]+) != (".*")\)$/, "field_ne") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| contains\((".*")\)\)$/, "field_contains") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| startswith\((".*")\)\)$/, "field_starts") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| endswith\((".*")\)\)$/, "field_ends") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) == ""\)$/, "field_empty") ??
    str(/^any\(\.\[\]; has\("([A-Za-z0-9_]+)"\)\)$/, "field_present") ??
    numeric(P, overId, "field_gt", ">") ??
    numeric(P, overId, "field_lt", "<") ?? { ...empty, overId, unparsed: true }
  );
}

function numeric(P: string, overId: string, test: BranchTest, op: string): ParsedCondition | null {
  const r = new RegExp(`^any\\(\\.\\[\\]; \\(\\.([A-Za-z0-9_]+) \\| tonumber\\?\\) \\${op} (-?[0-9.]+)\\)$`).exec(P);
  return r ? { overId, test, field: r[1]!, value: r[2]!, unparsed: false } : null;
}

// ── Chip references: what the variable picker inserts ───────────────────────

/**
 * One pick from the variable picker: a field off an upstream step's rows, or
 * a flow run input. The stored text is exactly what the compiler accepts —
 * `{{ outputs.<id>.<field> }}` / `{{ inputs.<id> }}` — built here, never typed.
 */
export type ChipRef = { stepId: string; field: string } | { inputId: string };

/** The stored text for one pick. */
export function referenceText(ref: ChipRef): string {
  return "inputId" in ref ? `{{ inputs.${ref.inputId} }}` : `{{ outputs.${ref.stepId}.${ref.field} }}`;
}

/**
 * Splice one pick into text at a caret offset. A missing space on either side
 * is added so `total{{ … }}due` can never be built by clicking; existing
 * whitespace is never doubled. Returns the caret after the insertion.
 */
export function insertReference(text: string, caret: number, ref: ChipRef): { text: string; caret: number } {
  const ins = referenceText(ref);
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return { text: `${before}${lead}${ins}${trail}${after}`, caret: (before + lead + ins + trail).length };
}

/**
 * The `jq` variant, offered only where the field is an expression:
 * `{{ outputs.<id>.<field> | jq('') }}` with the caret inside the quotes, so
 * the program is typed where the engine reads it and nowhere else.
 */
export function insertJqReference(text: string, caret: number, ref: ChipRef): { text: string; caret: number } {
  const base = "inputId" in ref ? `inputs.${ref.inputId}` : `outputs.${ref.stepId}.${ref.field}`;
  const ins = `{{ ${base} | jq('') }}`;
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return { text: `${before}${lead}${ins}${trail}${after}`, caret: (before + lead + ins.slice(0, -5)).length };
}

/** One segment of field text: prose, an exact reference, or a template this editor does not chip. */
export type TextToken =
  | { k: "text"; v: string }
  | { k: "ref"; stepId: string; field: string; raw: string }
  | { k: "input"; inputId: string; raw: string }
  | { k: "raw"; v: string };

const REF_BODY = /^\s*outputs\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const INPUT_BODY = /^\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/**
 * Split field text on `{{ … }}`. Exact `outputs.<id>.<field>` / `inputs.<id>`
 * become chips; anything else in braces (`json(…)`, filters, `jq(…)`) stays
 * prose — chipping a form this editor cannot rebuild would strand it.
 */
export function tokenizeReferences(text: string): TextToken[] {
  const out: TextToken[] = [];
  let rest = text;
  for (const m of text.matchAll(TEMPLATE_RE)) {
    const idx = m.index ?? 0;
    const head = rest.slice(0, idx - (text.length - rest.length));
    if (head) out.push({ k: "text", v: head });
    const body = m[1] ?? "";
    const ref = REF_BODY.exec(body);
    const input = ref ? null : INPUT_BODY.exec(body);
    if (ref) out.push({ k: "ref", stepId: ref[1]!, field: ref[2]!, raw: m[0] });
    else if (input) out.push({ k: "input", inputId: input[1]!, raw: m[0] });
    else out.push({ k: "raw", v: m[0] });
    rest = rest.slice(head.length + m[0].length);
  }
  if (rest) out.push({ k: "text", v: rest });
  return out;
}

/**
 * Tokens back to the stored string. Byte-identical whenever no chip was
 * inserted or removed — the test pins it — which is what keeps the
 * verbatim-emit contract while chips are only a reading of the text.
 */
export function serializeTokens(tokens: TextToken[]): string {
  return tokens.map((t) => (t.k === "text" || t.k === "raw" ? t.v : t.raw)).join("");
}
