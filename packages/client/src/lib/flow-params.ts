// src/lib/flow-params.ts — reading a `paramsExpr` BACK into the form's own
// vocabulary. The inverse of `flow-expr.ts`'s `buildFanOutParams` /
// `buildSingleParams`.
//
// ── ⚠ WHY THIS EXISTS: THE FORM WAS WRITE-ONLY ──────────────────────────────
//
// `CallForm` and `OperationForm` initialise their mappings to `{}` and never
// read `step.paramsExpr`. So a step that is FULLY WIRED reopens with every
// parameter showing *"leave out"* — the panel's most important question, *what
// feeds this component?*, answered wrongly and confidently on every visit after
// the first. Reported from use as the inspector not showing what a component's
// inputs and outputs are.
//
// ⚠ **AND IT IS WORSE THAN A BLANK FORM.** Touching any one parameter calls
// `push`, which rebuilds the WHOLE expression from the in-memory map — so
// editing one binding silently dropped every other one. A read-back is not a
// nicety here; it is what stops an edit destroying bindings nobody could see.
//
// ── ⚠ IT FAILS CLOSED, AND THAT IS THE LOAD-BEARING PART ────────────────────
//
// A hand-authored or imported `paramsExpr` may be anything at all — the raw
// escape hatch exists and is used. `null` means *"this was not written by the
// builder and I will not guess"*, and every caller must render that as
// **unknown**, never as unbound. Those are opposite claims: unbound says
// nothing feeds the parameter, unknown says the answer is not on this screen.
// Presenting the first when the second is true is how somebody re-binds a
// parameter that was already correct.
//
// ⚠ **`transform` is deliberately NOT recovered.** `(.x | tostring)` is what
// `transform: "text"` emits and is also something a person may write by hand.
// Round-tripping the three wrappers is possible; asserting which INTENT
// produced them is not, and the cost of guessing wrong is a re-save that
// rewrites an expression that worked. So a wrapped field parses as the field.
import { toLegacyInputSpelling, type AuthoredStep } from "@foundry/flow-edit";
import { readItemPredicate, rowsExpr, type ItemPredicate, type Mapping, type OutputShapes } from "@/lib/flow-expr";

export type ParsedParams = {
  /** The step whose rows the call fans out over; `null` for a single call. */
  overStepId: string | null;
  mappings: Mapping[];
  /**
   * The per-item filter, when the fan-out's `select(…)` stage is byte-for-byte
   * a shape `perItemTest` emits. `null` when there is no `select` stage.
   */
  predicate: ItemPredicate | null;
  /**
   * True when a `select(…)` stage was consumed but is NOT a shape the builder
   * emits. The mappings are still readable per-field — but no writer may
   * re-emit without it, or the filter is silently dropped.
   */
  filterUnreadable: boolean;
  /**
   * Parameter names whose values were SKIPPED — fed by something this reader
   * will not name. A rebuild drops them, so no writer may re-emit while any
   * remain, and no row may read them as `unset`.
   */
  skipped: string[];
};

/**
 * A Pebble splice becomes this sentinel while the jq program is reassembled, so
 * `"' ~ inputs.period ~ '"` reads as ONE input-sourced value rather than two
 * empty string literals. It is a character no jq program here emits.
 */
const SPLICE = "\u0000";

/** `"a\"b"` → `a"b`, starting AT the opening quote. Null if unterminated. */
function readJsonString(s: string, at: number): { value: string; next: number } | null {
  if (s[at] !== '"') return null;
  let out = "";
  let i = at + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      if (n === undefined) return null;
      out += n;
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, next: i + 1 };
    out += c;
    i += 1;
  }
  return null;
}
/** `"p": <value>, "q": <value>` → mappings. An unrecognised value is SKIPPED and its name reported, so no writer re-emits without it. */
function parsePairs(body: string, pebble: string[]): { mappings: Mapping[]; skipped: string[] } {
  const out: Mapping[] = [];
  const skipped: string[] = [];
  let i = 0;
  let spliceSeen = 0;
  const skipWs = () => {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
  };
  while (i < body.length) {
    skipWs();
    if (i >= body.length) break;
    const key = readJsonString(body, i);
    if (!key) break;
    i = key.next;
    skipWs();
    if (body[i] !== ":") break;
    i += 1;
    skipWs();

    // Value 1 — a quoted string: a literal, a flow input, or a splice.
    if (body[i] === '"') {
      const v = readJsonString(body, i);
      if (!v) break;
      i = v.next;
      if (v.value.includes(SPLICE)) {
        // The fan-out form's `"' ~ inputs.period ~ '"`.
        const ref = pebble[spliceSeen++] ?? "";
        const inp = /^inputs\.([A-Za-z0-9_]+)$/.exec(ref);
        if (inp) out.push({ param: key.value, source: { from: "input", inputId: inp[1] } });
        // A splice of anything else feeds the parameter from somewhere this
        // reader will not name — skipped, never silently dropped.
        else skipped.push(key.value);
        continue;
      }
      const inline = /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/.exec(v.value);
      if (inline) {
        out.push({ param: key.value, source: { from: "input", inputId: inline[1] } });
      } else if (v.value !== "") {
        out.push({ param: key.value, source: { from: "literal", value: v.value } });
      }
      // ⚠ `""` is what `buildSingleParams` emits for a step field it CANNOT
      // address (no row context). Recovering it as a literal empty string would
      // put a value on screen the builder deliberately refused to produce.
      continue;
    }

    // Value 2 — a jq field reference, optionally wrapped by a transform.
    let j = i;
    let depth = 0;
    let raw = "";
    while (j < body.length) {
      const c = body[j];
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      if (c === "," && depth === 0) break;
      raw += c;
      j += 1;
    }
    i = j;
    // Value 2a — the bare element: what `{ from: "self" }` emits. A list of
    // names or numbers has no field, so `.` alone is the whole mapping.
    if (raw.trim() === ".") {
      out.push({ param: key.value, source: { from: "self" } });
      skipWs();
      continue;
    }
    // ⚠ The tail cannot be `[^)]*`: `transform: "date"` emits
    // `(.due | tostring | split("T")[0])`, whose own parentheses would end the
    // match early and make a transformed field read as NOT BOUND. So the field
    // is matched, and the remainder is only required to be a pipeline or a
    // closing bracket — anything else is left unrecognised on purpose.
    const field = /^\(?\s*\.([A-Za-z0-9_]+)\s*([\s\S]*)$/.exec(raw.trim());
    const tail = field ? field[2].replace(/\)\s*$/, "").trim() : "";
    if (field && (tail === "" || tail.startsWith("|"))) {
      out.push({ param: key.value, source: { from: "step", stepId: "", field: field[1] } });
    } else {
      skipped.push(key.value);
    }
    skipWs();
  }
  return { mappings: out, skipped };
}

/**
 * The fan-out form:
 *   `{{ <rows> | jq('[.[] | {"p": .field, "q": "' ~ inputs.x ~ '"}]') | first }}`
 *
 * ⚠ The `~`-spliced Pebble segments are why this cannot be a regex over the jq
 * text: I-11 forces a flow input to leave the quoted program and come back, so
 * one parameter's value is spread across three pieces of the source.
 */
function parseFanOut(expr: string, stepIdOf: (rows: string) => string | null): ParsedParams | null {
  const r = readJqCall(expr, stepIdOf);
  if (!r) return null;
  const { overStepId, program: prog, pebble } = r;
  const head = /^\[\.\[\]\s*\|\s*/.exec(prog);
  if (!head) return null;
  let rest = prog.slice(head[0].length);
  let predicate: ItemPredicate | null = null;
  let filterUnreadable = false;
  // An optional `select(…)` stage — what the per-item predicate emits.
  // Recovered only when it is byte-for-byte a shape `perItemTest` emits; a
  // hand-written filter is read past with `filterUnreadable` set, so no writer
  // re-emits without it. Balanced-paren scan, quote-aware so a value
  // containing `)` (e.g. `contains("a)b")`) does not end it early.
  if (rest.startsWith("select(")) {
    let depth = 0;
    let k = 0;
    let inStr = false;
    for (; k < rest.length; k += 1) {
      const c = rest[k];
      if (inStr) {
        if (c === "\\") k += 1;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    const inner = rest.slice("select(".length, k).trim();
    rest = rest.slice(k + 1).trim();
    if (!rest.startsWith("|")) return null;
    rest = rest.slice(1).trim();
    const read = readItemPredicate(inner);
    if (read) predicate = read;
    else filterUnreadable = true;
  }
  const body = /^\{([\s\S]*)\}\]$/.exec(rest);
  if (!body) return null;
  const pairs = parsePairs(body[1], pebble);
  return { overStepId, mappings: pairs.mappings, skipped: pairs.skipped, predicate, filterUnreadable };
}

/**
 * `{{ <rows> | jq(<program>) | first }}` → which step, the jq program with each
 * `~`-spliced Pebble segment replaced by `SPLICE`, and those segments in order.
 */
function readJqCall(
  expr: string,
  stepIdOf: (rows: string) => string | null,
): { overStepId: string; program: string; pebble: string[] } | null {
  const m = /^\{\{\s*([\s\S]*?)\s*\|\s*jq\(([\s\S]*)\)\s*\|\s*first\s*\}\}$/.exec(expr.trim());
  if (!m) return null;
  const overStepId = stepIdOf(m[1]);
  if (!overStepId) return null;
  const pebble: string[] = [];
  let program = "";
  let i = 0;
  const src = m[2];
  while (i < src.length) {
    if (src[i] === "'") {
      let j = i + 1;
      let lit = "";
      while (j < src.length && src[j] !== "'") lit += src[j++];
      if (j >= src.length) return null;
      program += lit;
      i = j + 1;
      continue;
    }
    if (src[i] === "~" || /\s/.test(src[i])) {
      i += 1;
      continue;
    }
    let j = i;
    let ref = "";
    while (j < src.length && src[j] !== "~") ref += src[j++];
    ref = ref.trim();
    if (!ref) return null;
    pebble.push(ref);
    program += SPLICE;
    i = j;
  }
  return { overStepId, program: program.trim(), pebble };
}

/**
 * The single call over ONE upstream's output (phase 3, E3.1):
 *   `{{ <rows> | jq('[{"p": (if type == "array" then [.[] | .f] else .f end), "w": .}]') | first }}`
 *
 * The array/object guard is unwrapped back to the field read it guards, so a
 * field and its transform read exactly as they do in a fan-out.
 */
function parseSingleOver(expr: string, stepIdOf: (rows: string) => string | null): ParsedParams | null {
  const r = readJqCall(expr, stepIdOf);
  if (!r) return null;
  const body = /^\[\s*\{([\s\S]*)\}\s*\]$/.exec(r.program);
  if (!body) return null;
  const unguarded = body[1].replace(
    /\(if type == "array" then \[\.\[\] \| ([^\]]*?)\] else \1 end\)/g,
    (_all, inner: string) => `(${inner})`,
  );
  const pairs = parsePairs(unguarded, r.pebble);
  // ⚠ `.` here is the WHOLE output, which the panel's narrow `Source` cannot
  // name (it has no `whole`). Reading it as `self` would claim a per-row
  // element that does not exist, so it is SKIPPED — no writer re-emits
  // without it, and no row reads it as unbound.
  const skipped = [...pairs.skipped, ...pairs.mappings.filter((m) => m.source.from === "self").map((m) => m.param)];
  const mappings = pairs.mappings
    .filter((m) => m.source.from !== "self")
    .map((m): Mapping => (m.source.from === "step" ? { ...m, source: { ...m.source, stepId: r.overStepId } } : m));
  return { overStepId: null, mappings, skipped, predicate: null, filterUnreadable: false };
}

/**
 * The single-call form: `[{ "p": "{{ inputs.x }}", "q": "lit" }]`.
 * No `~` splicing — the whole thing is JSON-ish text, so a nested
 * `{{ inputs.x }}` sits inside the quoted value.
 */
function parseSingle(expr: string): ParsedParams | null {
  const m = /^\[\s*\{([\s\S]*)\}\s*\]$/.exec(expr.trim());
  if (!m) return null;
  const pairs = parsePairs(m[1], []);
  return { overStepId: null, mappings: pairs.mappings, skipped: pairs.skipped, predicate: null, filterUnreadable: false };
}

/**
 * Read a `paramsExpr` back into the form's own vocabulary, or `null`.
 *
 * `steps` is the flow's steps, used to recognise which one a fan-out reads —
 * matched by rebuilding each candidate's `rowsExpr` rather than by scanning for
 * an id, so a step whose id is a substring of another's cannot be picked.
 */
export function parseParams(
  shapes: OutputShapes,
  steps: AuthoredStep[],
  expr: string | null | undefined,
): ParsedParams | null {
  if (!expr || !expr.trim()) return null;
  // The escaped input spelling reads as the legacy one it replaced (I-288): both pass the same input; the parser knows one.
  expr = toLegacyInputSpelling(expr);
  const stepIdOf = (rows: string): string | null => {
    const want = rows.trim();
    for (const s of steps) if (rowsExpr(shapes, s)?.trim() === want) return s.id;
    return null;
  };
  const fan = parseFanOut(expr, stepIdOf);
  if (fan) {
    return {
      ...fan,
      mappings: fan.mappings.map((m) =>
        m.source.from === "step" ? { ...m, source: { ...m.source, stepId: fan.overStepId! } } : m,
      ),
    };
  }
  return parseSingleOver(expr, stepIdOf) ?? parseSingle(expr);
}
