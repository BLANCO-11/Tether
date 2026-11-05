/**
 * Phase 5 task 3 (D-255) — a flow input inherits the shape of the parameters
 * it feeds.
 *
 * The drafter declares nearly every input `STRING`, so a `period` feeding a
 * month-format parameter carried no shape at all: the run form accepted
 * `01/08/2026`, and the history holds `period must be YYYY-MM, got "2026/08"`,
 * `"2026-06-30"`, `"2026-06-01"` — 12 of 42 historical failures. The checker
 * says it too (FT0202 "Text is not Month", 4 of 5 errors on green runs in r7).
 * The parameters DECLARE their format; this copies it onto the input.
 *
 *   month    → `format: "month"` on the STRING input (Kestra has no MONTH type;
 *              the format rides the model, like `label`, and is not emitted)
 *   date     → `type: "DATE"`      (Kestra validates it natively)
 *   datetime → `type: "DATETIME"`
 *
 * ⚠ **Only when every parameter it feeds agrees.** One input feeding a month
 * parameter and a date parameter is left alone — any one answer would make the
 * other call wrong, and a wrong declaration is worse than none.
 *
 * ⚠ Never touched: a non-STRING input (somebody chose it), an input that
 * already has a format, a `computed` input (its value is engine-derived), and
 * one whose `defaults` would not parse under the new shape.
 *
 * Pure. Typed call bindings only — a hand-written `paramsExpr` is not read.
 */
import type { FlowModel } from "./flow-compiler.service.js";
import type { StepContract } from "./step-contract.service.js";

/**
 * Phase 2 task 8 (D-272) — an input's TYPE is derived from what consumes it.
 *
 * Every consumer states what it takes: a call parameter (`type`/`format`), or a
 * code step's contract field. When they all agree, that is the input's type;
 * the drafter chooses an input's id, label and description, not its type. It
 * was the drafter's choice that gave one concept different types across drafts
 * (I-234: a period as bare STRING, an as-of as DATETIME).
 *
 *   override: false  only a STRING input is widened (the phase-5 behaviour, and
 *                    what a person-chosen type gets: the checker reports a
 *                    mismatch instead of the type being rewritten)
 *   override: true   the drafter path — the consumers' type wins outright
 *
 * ⚠ Disagreeing consumers, a `computed` input, an input no typed consumer reads,
 * and a `defaults` that would not parse under the new type are all left alone.
 */
type Kind = "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "DATE" | "DATETIME" | "month";

const PARSE: Record<Kind, RegExp> = {
  STRING: /[^]*/,
  INT: /^-?\d+$/,
  FLOAT: /^-?\d+(\.\d+)?$/,
  BOOLEAN: /^(true|false)$/,
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  DATE: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  DATETIME: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
};

function kindOf(type: string | undefined, format: string | undefined): Kind | null {
  const f = (format ?? "").toLowerCase();
  if (f === "month") return "month";
  if (f === "date") return "DATE";
  if (f === "datetime" || f === "date-time") return "DATETIME";
  switch ((type ?? "").toLowerCase()) {
    case "date": return "DATE";
    case "datetime": return "DATETIME";
    case "integer": case "int": return "INT";
    case "number": case "float": return "FLOAT";
    case "boolean": return "BOOLEAN";
    case "string": case "text": return "STRING";
    default: return null; // unknown ⇒ says nothing
  }
}

/** The string values of a literal JSON `paramsExpr` (object, or the first object of an array), by key. */
function literalParamValues(paramsExpr: string): Array<[string, string]> {
  try {
    const v: unknown = JSON.parse(paramsExpr);
    const obj = Array.isArray(v) ? v[0] : v;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  } catch {
    return []; // a whole-body template — not readable here
  }
}

export function deriveInputTypes(
  model: FlowModel,
  interfaces: Record<string, { params?: Array<{ name: string; type?: string; format?: string }> }>,
  contracts: Record<string, StepContract>,
  opts: { override: boolean },
): { model: FlowModel; changed: string[] } {
  const fed = new Map<string, Set<Kind | "?">>();
  // Bindings whose consumer takes a MONTH — on the drafter path they get
  // `transform: "month"` and their input becomes a DATE (D-272: engine types
  // only; a month is a typed conversion of a date, never an input type).
  const monthUses = new Map<string, Array<{ stepId: string; name: string }>>();
  const note = (id: string, k: Kind | null, at?: { stepId: string; name: string }) => {
    if (!fed.has(id)) fed.set(id, new Set());
    if (opts.override && k === "month" && at) {
      fed.get(id)!.add("DATE");
      if (!monthUses.has(id)) monthUses.set(id, []);
      monthUses.get(id)!.push(at);
      return;
    }
    fed.get(id)!.add(k ?? "?");
  };
  for (const step of model.steps) {
    const isCall = step.kind === "tool" || step.kind === "datasource" || step.kind === "query";
    if (!isCall && step.kind !== "code") continue;
    if (isCall && step.paramsExpr?.trim()) {
      // A literal paramsExpr is read too (phase 7): a value that is EXACTLY
      // `{{ inputs.x }}` is that parameter consuming input x. Any other template
      // naming an input (`"{{ inputs.period }}-01"`) builds a new value from it, so
      // it says nothing about x's type and blocks the widening ("?"). Hand-written
      // flows — seeds, imports, anything saved before the drafter typed its
      // bindings — only have this form, and they were refused at save (FT0202)
      // for a STRING input their consumer declares as a date.
      for (const [name, value] of literalParamValues(step.paramsExpr)) {
        const whole = /^\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(value);
        if (whole) {
          const p = (interfaces[(step as { ref: string }).ref]?.params ?? []).find((x) => x.name === name);
          note(whole[1]!, p ? kindOf(p.type, p.format) : null);
          continue;
        }
        for (const m of value.matchAll(/inputs\.([A-Za-z_][A-Za-z0-9_]*)/g)) note(m[1]!, null);
      }
      continue;
    }
    if (step.kind === "code" && step.inputExpr?.trim()) continue;
    for (const b of (step.inputs ?? []) as Array<{ name: string; source?: unknown }>) {
      const src = b.source as { from?: string; inputId?: string; transform?: string } | null;
      if (!src || src.from !== "input" || !src.inputId) continue;
      // An existing conversion already says what the input must be.
      if (src.transform === "month") { note(src.inputId, "DATE"); continue; }
      if (src.transform === "date") { note(src.inputId, "DATETIME"); continue; }
      const at = { stepId: step.id, name: b.name };
      if (isCall) {
        const p = (interfaces[(step as { ref: string }).ref]?.params ?? []).find((x) => x.name === b.name);
        note(src.inputId, p ? kindOf(p.type, p.format) : null, at);
      } else {
        const f = contracts[step.id]?.input.find((x) => x.name === b.name);
        note(src.inputId, f ? kindOf(f.type, f.format) : null, at);
      }
    }
  }
  const changed: string[] = [];
  const inputs = (model.inputs ?? []).map((i) => {
    if (i.computed) return i;
    if (!opts.override && (i.type !== "STRING" || (i as { format?: string }).format)) return i;
    const kinds = fed.get(i.id);
    if (!kinds || kinds.size !== 1 || kinds.has("?")) return i;
    const k = [...kinds][0] as Kind;
    // D-272: nothing writes a month TAG any more (the drafter path cuts a DATE
    // instead). A stored revision that carries one is still read by the checker
    // and the run form — only its production stopped.
    if (k === "month") return i;
    const cur: Kind = (i as { format?: string }).format === "month" ? "month" : (i.type as Kind);
    if (k === cur) return i;
    if (i.defaults !== undefined && !PARSE[k].test(i.defaults)) return i;
    changed.push(`${i.id}: ${cur} → ${k}`);
    const { format: _f, ...rest } = i as typeof i & { format?: string };
    return { ...rest, type: k as Exclude<Kind, "month"> };
  });
  // Apply the month cuts only for inputs that did become DATE here (or already were).
  let steps = model.steps;
  for (const [id, uses] of monthUses) {
    const decl = (inputs as Array<{ id: string; type: string }>).find((i) => i.id === id);
    if (decl?.type !== "DATE") continue;
    steps = steps.map((st) => {
      const mine = uses.filter((u) => u.stepId === st.id).map((u) => u.name);
      if (!mine.length) return st;
      const ins = ((st as { inputs?: Array<{ name: string; source: unknown }> }).inputs ?? []).map((b) =>
        mine.includes(b.name) ? { ...b, source: { ...(b.source as object), transform: "month" } } : b,
      );
      changed.push(...mine.map((n) => `${st.id}.${n}: + transform month`));
      return { ...st, inputs: ins } as typeof st;
    });
  }
  return changed.length ? { model: { ...model, inputs: inputs as FlowModel["inputs"], steps }, changed } : { model, changed };
}
