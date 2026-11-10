// packages/flow-edit/src/model-version.ts — the version upgrade, because revisions are immutable.
//
// `db/schema.ts` states `model_json` is never updated, so history cannot be
// rewritten. Therefore the stored model carries `version?: number` (absent = 1)
// and every read of a model-as-a-model runs `normaliseModel` first, which
// converts version 1 → 2: `paramsExpr`/`inputExpr`/`conditionExpr`/
// `summaryExpr`/`contextExpr` become the typed `inputs`/`over`/`where`/
// `mode`/`test`/`summary`/`context` the registry (Stage 2) declares.
//
// ── Deletion condition ──────────────────────────────────────────────────────
//
// When `SELECT count(*) FROM flow_revisions WHERE model_json->>'version' IS NULL`
// is zero, delete this file, its test, the fixture and the call site.
//
// ── The normalise rule ("new wins iff non-empty", never throws) ─────────────
//
// - Call kinds (`tool`/`datasource`/`query`) use `inputs` iff it is a non-empty
//   array, else parse `paramsExpr`.
// - `transform` uses `mode` iff present, else `"expression"`.
// - `code` uses `inputs` iff non-empty, else parse `inputExpr`.
// - `branch` uses `test` iff non-null, else parse `conditionExpr`.
// - `approval` uses `summary` iff non-empty else `summaryExpr`, and `context`
//   iff non-null else parse `contextExpr`.
// - A converted step drops the old expression-string field; a step whose old
//   expression cannot be read is LEFT AS WRITTEN with the affected bindings
//   `null`, which the panel renders as **unknown** ("set in the expression") —
//   never a silent rebind. Stored v2 revisions carry new fields only.
//
// ── Why the parsers below are copies, not imports ───────────────────────────
//
// `parseParams` lives in client `lib/flow-params.ts`, beside the panel that
// owns it: it imports the `@/` alias and the sibling-owned `readItemPredicate`,
// and this package cannot import the client (dependency direction), while
// `flow-params.ts` itself is outside this slice's targets. So the upgrade
// carries its own SHAPES-FREE structural parsers: where the client matches an
// over step by rebuilding each candidate's `rowsExpr` (byte-exact, needs the
// catalogue), these accept any single-step rows address naming a known step id.
// That is a deliberately wider acceptance with a fail-closed edge — the full
// envelope (`{{ … | jq(…) | first }}`, `[.[] | …]`) and every pair must still
// match structurally, and anything else keeps the old string with null
// bindings. The shared vocabulary that keeps the two sides in agreement is
// `render.ts`: both recognise the canonical strings its builders emit, and the
// round-trip tests on both sides pin them as one.
import { BRANCH_TESTS, toLegacyInputSpelling } from "./render.js";
import type { BranchTest } from "./render.js";
import type { InputBinding, Source } from "./node-types.js";

// ── Small guards (unknown in, precision out) ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Every `outputs.<id>` the text names that is also a step in this flow. */
function knownStepRefs(text: string, stepIds: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/outputs\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (stepIds.has(m[1] ?? "")) found.add(m[1] ?? "");
  }
  return [...found];
}

// ── paramsExpr → inputs/over/where ───────────────────────────────────────────
// A shapes-free structural port of the client's `parseParams` (see above for
// why it is a port). Transform wrappers are deliberately NOT recovered —
// `(.x | tostring)` is what `transform: "text"` emits and is also something a
// person may write by hand, so a wrapped field parses as the bare field.

type ParsedMapping = { param: string; source: Source };

type ParamsRead = {
  overStepId: string | null;
  mappings: ParsedMapping[];
  predicate: { test: string; field?: string; value?: string } | null;
  filterUnreadable: boolean;
  skipped: string[];
};

/** A Pebble splice while the jq program is reassembled. See the client's port. */
const SPLICE = "\u0000";

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
 /**
  * Whether a template body carries a LIVE `@json` encoder — one that makes the
  * value arrive self-quoted. Each jq program's inner string literals are
  * stripped first (both quote styles, escape-aware), so `@json` mentioned
  * inside a literal does not count. Mirrors `liveJsonEncoder` in the server's
  * `flow-draft-repair.ts`; the two must agree, or a shape one side repairs is
  * refused by the other. Conservative: an unrecognised shape reads as absent
  * and keeps today's binding, never a new one.
  */
 function hasLiveJsonEncoder(body: string): boolean {
   if (!body.includes("@json")) return false;
   const matches = [...body.matchAll(/\bjq\(\s*(['"])([\s\S]*?)\1\s*\)/g)];
   if (matches.length === 0) return true;
   const liveIn = (program: string): boolean => {
     let stripped = "";
     let i = 0;
     while (i < program.length) {
       const ch = program[i];
       if (ch === "'" || ch === '"') {
         const quote = ch;
         i += 1;
         while (i < program.length && program[i] !== quote) i += program[i] === "\\" ? 2 : 1;
         i += 1;
         continue;
       }
       stripped += ch;
       i += 1;
     }
     return stripped.includes("@json");
   };
   if (matches.some((m) => liveIn(m[2] ?? ""))) return true;
   let rest = "";
   let at = 0;
   for (const m of matches) {
     const start = m.index ?? at;
     rest += body.slice(at, start);
     at = start + m[0].length;
   }
   rest += body.slice(at);
   return rest.includes("@json");
 }
/**
 * `{{ ... }}` with balanced braces, quote-aware. Single `{`/`}` (a jq object
 * literal) never move the depth — only `{{`/`}}` pairs do — and braces inside
 * `'...'`/`"..."` do not count. Null when the braces never balance: the caller
 * falls through to the refusal rather than guessing where a broken template
 * ends, which would be a second expression language beside the compiler's.
 */
function readBalancedTemplate(s: string, at: number): { value: string; next: number } | null {
  let depth = 0;
  let i = at;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "{" && s[i + 1] === "{") {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === "}" && s[i + 1] === "}") {
      depth -= 1;
      i += 2;
      if (depth === 0) return { value: s.slice(at, i), next: i };
      continue;
    }
    i += 1;
  }
  return null;
}

function parsePairs(body: string, pebble: string[]): { mappings: ParsedMapping[]; skipped: string[] } {
  const out: ParsedMapping[] = [];
  const skipped: string[] = [];
  let i = 0;
  let spliceSeen = 0;
  const skipWs = (): void => {
    while (i < body.length && /[\s,]/.test(body[i] ?? "")) i += 1;
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

    if (body[i] === '"') {
      const v = readJsonString(body, i);
      if (!v) break;
      i = v.next;
      if (v.value.includes(SPLICE)) {
        const ref = pebble[spliceSeen++] ?? "";
        const inp = /^inputs\.([A-Za-z0-9_]+)$/.exec(ref);
        if (inp?.[1]) out.push({ param: key.value, source: { from: "input", inputId: inp[1] } });
        else skipped.push(key.value);
        continue;
      }
      const inline = /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/.exec(v.value);
      if (inline?.[1]) {
        out.push({ param: key.value, source: { from: "input", inputId: inline[1] } });
      } else if (v.value !== "") {
        out.push({ param: key.value, source: { from: "literal", value: v.value } });
      }
      // ⚠ `""` is what `buildSingleParams` emits for a step field it CANNOT
      // address (no row context) — deliberately dropped, never a literal `''`.
      continue;
    }
    // A bare template carrying a LIVE `@json` encoder is kept verbatim, not
    // bound as a literal — `"body": {{ … | jq('.text | @json') | first }}`.
    // `@json` emits the value WITH its quotes, so the span must splice raw;
    // binding it as a literal stringifies it whole at emit and the value
    // arrives double-quoted (post-loop `json_double_encoded`, measured
    // 2026-09-14 on `tether_email_send.body`). Skipped here means the stored
    // display stays authoritative and the binding is explicitly unbound
    // (`null`), which the emitter never reads while a display exists and the
    // validator never scans. Bare templates WITHOUT a live encoder keep
    // today's literal binding — their re-emit is byte-identical to before.
    if (body.startsWith("{{", i)) {
      const tpl = readBalancedTemplate(body, i);
      if (tpl) {
        if (hasLiveJsonEncoder(tpl.value)) {
          skipped.push(key.value);
          i = tpl.next;
          skipWs();
          continue;
        }
        out.push({ param: key.value, source: { from: "literal", value: tpl.value } });
        i = tpl.next;
        skipWs();
        continue;
      }
    }

    // Value splitter: paren depth (jq pipes) AND square-bracket depth (JSON
    // arrays — `"to": ["a@b.c", "d@e.f]"` must not cut at the inner comma),
    // skipping commas inside double-quoted segments. A cut mid-array
    // produced a truncated raw the scalar check then refused, stranding a
    // plain literal address list as an unbound input (measured 2026-09-14:
    // `"to": ["himanshu.saini@microland.com"]`).
    let j = i;
    let depth = 0;
    let brackets = 0;
    let raw = "";
    while (j < body.length) {
      const c = body[j];
      if (c === '"') {
        raw += c;
        j += 1;
        while (j < body.length && body[j] !== '"') {
          raw += body[j];
          j += body[j] === "\\" ? 2 : 1;
        }
        if (j < body.length) {
          raw += body[j];
          j += 1;
        }
        continue;
      }
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      if (c === "[") brackets += 1;
      if (c === "]") brackets -= 1;
      if (c === "," && depth === 0 && brackets === 0) break;
      raw += c;
      j += 1;
    }
    i = j;
    if (raw.trim() === ".") {
      out.push({ param: key.value, source: { from: "self" } });
      skipWs();
      continue;
    }
    const field = /^\(?\s*\.([A-Za-z0-9_]+)\s*([\s\S]*)$/.exec(raw.trim());
    const tail = field?.[2].replace(/\)\s*$/, "").trim() ?? "";
    if (field?.[1] && (tail === "" || tail.startsWith("|"))) {
      out.push({ param: key.value, source: { from: "step", stepId: "", field: field[1] } });
    } else {
      // An unquoted scalar is a literal value, not an unbound input — `90` in
      // `{"lookahead_days":90}` means the number ninety, full stop. Checked
      // after the `.field` projection above so projections keep precedence.
      const scalar = /^(?:-?\d+(?:\.\d+)?|true|false|null)$/.exec(raw.trim());
      if (scalar) {
        out.push({ param: key.value, source: { from: "literal", value: raw.trim() } });
        skipWs();
        continue;
      }
      // A JSON array or object value is a literal too — `"to":
      // ["a@b.c"]` is an address list, not an unbound input. Parsed (never
      // eval'd) and stored compact; a parse failure keeps today's skip.
      const trimmed = raw.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          out.push({ param: key.value, source: { from: "literal", value: JSON.stringify(JSON.parse(trimmed)) } });
          skipWs();
          continue;
        } catch {
          // Not valid JSON — fall through to the skip below.
        }
      }
      skipped.push(key.value);
    }
    skipWs();
  }
  return { mappings: out, skipped };
}

/** The inverse of `render.ts`'s per-item predicates, recognised not emitted. */
function readItemPredicateLike(test: string): { test: string; field?: string; value?: string } | null {
  const t = test.trim();
  let m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\|\s*tonumber\?\)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t);
  if (m) {
    const op = m[2] === ">" ? "field_gt" : m[2] === ">=" ? "field_gte" : m[2] === "<" ? "field_lt" : "field_lte";
    return { test: op, field: m[1] === "." ? undefined : (m[1] ?? "").slice(1), value: m[3] };
  }
  m = /^has\("([A-Za-z0-9_]+)"\)$/.exec(t);
  if (m) return { test: "field_present", field: m[1] };
  m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\/\/\s*""\)\s*==\s*""$/.exec(t);
  if (m) return { test: "field_empty", field: m[1] === "." ? undefined : (m[1] ?? "").slice(1) };
  m = /^\(\s*(\.[A-Za-z0-9_]+|\.)\s*\/\/\s*""\)\s*\|\s*(contains|startswith|endswith)\((.*)\)$/.exec(t);
  if (m) {
    try {
      const value: unknown = JSON.parse(m[3] ?? "");
      if (typeof value !== "string") return null;
      const kind = m[2] === "contains" ? "field_contains" : m[2] === "startswith" ? "field_starts" : "field_ends";
      return { test: kind, field: m[1] === "." ? undefined : (m[1] ?? "").slice(1), value };
    } catch {
      return null;
    }
  }
  m = /^(\.[A-Za-z0-9_]+|\.)\s*(==|!=)\s*(.*)$/.exec(t);
  if (m) {
    try {
      const value: unknown = JSON.parse((m[3] ?? "").trim());
      if (typeof value !== "string") return null;
      return { test: m[2] === "==" ? "field_eq" : "field_ne", field: m[1] === "." ? undefined : (m[1] ?? "").slice(1), value };
    } catch {
      return null;
    }
  }
  return null;
}

function parseFanOutLike(expr: string, stepIds: Set<string>): ParamsRead | null {
  const m = /^\{\{\s*([\s\S]*?)\s*\|\s*jq\(([\s\S]*)\)\s*\|\s*first\s*\}\}$/.exec(expr.trim());
  if (!m) return null;
  // Shapes-free over detection: the rows address must name exactly one known
  // step. The client instead rebuilds each candidate's `rowsExpr` (byte-exact,
  // needs the catalogue); without it, membership is the honest check, and a
  // ghost step reads as unknown rather than as its substring host.
  const refs = knownStepRefs(m[1] ?? "", stepIds);
  if (refs.length !== 1 || !refs[0]) return null;
  const overStepId = refs[0];

  const pebble: string[] = [];
  let program = "";
  let i = 0;
  const src = m[2] ?? "";
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
    if (src[i] === "~" || /\s/.test(src[i] ?? "")) {
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

  const prog = program.trim();
  const head = /^\[\.\[\]\s*\|\s*/.exec(prog);
  if (!head) return null;
  let rest = prog.slice(head[0].length);
  let predicate: ParamsRead["predicate"] = null;
  let filterUnreadable = false;
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
    const read = readItemPredicateLike(inner);
    if (read) predicate = read;
    else filterUnreadable = true;
  }
  const body = /^\{([\s\S]*)\}\]$/.exec(rest);
  if (!body) return null;
  const pairs = parsePairs(body[1] ?? "", pebble);
  return { overStepId, mappings: pairs.mappings, skipped: pairs.skipped, predicate, filterUnreadable };
}

function parseSingleLike(expr: string): ParamsRead | null {
  const m = /^\[\s*\{([\s\S]*)\}\s*\]$/.exec(expr.trim());
  if (!m) return null;
  const pairs = parsePairs(m[1] ?? "", []);
  return { overStepId: null, mappings: pairs.mappings, skipped: pairs.skipped, predicate: null, filterUnreadable: false };
}

function parseParamsLike(expr: string, stepIds: Set<string>): ParamsRead | null {
  if (!expr || !expr.trim()) return null;
  // The escaped input spelling reads as the legacy one it replaced (I-288): both pass the same input; the parser knows one.
  expr = toLegacyInputSpelling(expr);
  return (
    parseFanOutLike(expr, stepIds) ?? parseSingleLike(expr) ?? null
  );
}

/** A per-item predicate as the stored `where` — `any`/`none`/`gte`/`lte` have no stored form. */
function storableWhere(predicate: { test: string; field?: string; value?: string }): {
  field: string;
  test: BranchTest;
  value?: string;
} | null {
  if (predicate.test === "field_gte" || predicate.test === "field_lte") return null;
  const known = (BRANCH_TESTS as ReadonlyArray<{ test: string }>).some((t) => t.test === predicate.test);
  if (!known) return null;
  if (predicate.test === "any" || predicate.test === "none") return null;
  const where: { field: string; test: BranchTest; value?: string } = {
    field: predicate.field ?? "",
    test: predicate.test as BranchTest,
  };
  if (predicate.value !== undefined) where.value = predicate.value;
  return where;
}

// ── inputExpr → inputs ───────────────────────────────────────────────────────
// A shapes-free structural port of the client's `codeInputSources`: per-field
// values are `null`/missing (unset), one template (whole-list, column
// projection, or flow input), or one fixed string (literal). Anything else
// naming no single known step reads `null` — unknown, never guessed.

function codeProjectionLike(proj: string): { field: string; transform?: "date" | "text" | "number" } | null {
  const plain = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(proj.trim());
  if (plain?.[1]) return { field: plain[1] };
  const quoted = /^\.\["((?:[^"\\]|\\.)*)"\]$/.exec(proj.trim());
  if (quoted?.[1] !== undefined) {
    try {
      const field: unknown = JSON.parse(`"${quoted[1]}"`);
      if (typeof field === "string" && field) return { field };
    } catch {
      return null;
    }
    return null;
  }
  const wrapped = /^\(([\s\S]*) \|\s*(tostring\s*\|\s*split\("T"\)\[0\]|tostring|tonumber)\)$/.exec(proj.trim());
  const inner = wrapped?.[1] ? codeProjectionLike(wrapped[1]) : null;
  if (!wrapped || !inner || inner.transform) return null;
  const wrapper = (wrapped[2] ?? "").replace(/\s+/g, "");
  if (wrapper === 'tostring|split("T")[0]') return { field: inner.field, transform: "date" };
  if (wrapper === "tostring") return { field: inner.field, transform: "text" };
  if (wrapper === "tonumber") return { field: inner.field, transform: "number" };
  return null;
}

type CodeRead = { readable: boolean; bound: InputBinding[] };

function parseCodeInputLike(inputExpr: string, stepIds: Set<string>): CodeRead {
  // The escaped input spelling reads as the legacy one it replaced (I-288): both pass the same input; the parser knows one.
  const src = toLegacyInputSpelling(inputExpr).trim();
  const bound: InputBinding[] = [];
  const pair = /"((?:[^"\\]|\\.)*)"\s*:\s*(\{\{[\s\S]*?\}\}|null|"(?:[^"\\]|\\.)*")/g;
  let m: RegExpExecArray | null;
  const spans: Array<[number, number]> = [];
  let failed = false;
  while ((m = pair.exec(src)) !== null) {
    let key: unknown;
    try {
      key = JSON.parse(`"${m[1]}"`);
    } catch {
      failed = true;
      continue;
    }
    if (typeof key !== "string" || !key) {
      failed = true;
      continue;
    }
    spans.push([m.index, m.index + m[0].length]);
    const raw = m[2] ?? "";
    // The value must END the pair: trailing template text means the template
    // closed early and the rest is not this field's binding.
    const after = src.slice(m.index + m[0].length).trimStart();
    if (after && after[0] !== "," && after[0] !== "}") {
      bound.push({ name: key, source: null });
      continue;
    }
    if (raw === "null" || raw === '""') continue;
    if (raw.startsWith('"')) {
      try {
        const value: unknown = JSON.parse(raw);
        bound.push({ name: key, source: typeof value === "string" ? { from: "literal", value } : null });
      } catch {
        bound.push({ name: key, source: null });
      }
      continue;
    }
    const inner = /^\{\{([\s\S]*)\}\}$/.exec(raw);
    if (!inner || inner[1] === undefined) {
      bound.push({ name: key, source: null });
      continue;
    }
    const t = (inner[1] ?? "").trim();
    const input = /^inputs\.([A-Za-z0-9_]+)$/.exec(t);
    if (input?.[1]) {
      bound.push({ name: key, source: { from: "input", inputId: input[1] } });
      continue;
    }
    const refs = knownStepRefs(t, stepIds);
    if (refs.length !== 1 || !refs[0]) {
      bound.push({ name: key, source: null });
      continue;
    }
    const stepId = refs[0];
    if (!t.includes("|")) {
      bound.push({ name: key, source: { from: "whole", stepId } });
      continue;
    }
    const col = /^\s*[\s\S]*?\|\s*jq\('([\s\S]*)'\)\s*$/.exec(t);
    const prog = col?.[1] ? /^\[\.\[\]\s*\|\s*([\s\S]*)\]$/.exec(col[1]) : null;
    const proj = prog?.[1] ? codeProjectionLike(prog[1]) : null;
    if (!proj) {
      bound.push({ name: key, source: null });
      continue;
    }
    bound.push({
      name: key,
      source: proj.transform
        ? { from: "step", stepId, field: proj.field, transform: proj.transform }
        : { from: "step", stepId, field: proj.field },
    });
  }
  let rest = src;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const span = spans[k];
    if (!span) continue;
    rest = rest.slice(0, span[0]) + rest.slice(span[1]);
  }
  // Only the object's own punctuation may remain — anything else (a number, a
  // nested object, a payload that is not an object at all) fails the whole
  // read, never one field's guess.
  if (failed || !/^[{}\s,]*$/.test(rest)) return { readable: false, bound };
  return { readable: true, bound };
}

// ── conditionExpr → test ─────────────────────────────────────────────────────
// A shapes-free port of the client's `parseCondition` (which is already
// shapes-free — it regexes the rows address for `outputs.<id>`). An expression
// it cannot read returns `unparsed`, never a guess.

type ConditionRead = {
  overId: string;
  test: BranchTest;
  field: string;
  value: string;
  unparsed: boolean;
};

function parseConditionLike(expr: string, stepIds: Set<string>): ConditionRead {
  const empty: ConditionRead = { overId: "", test: "any", field: "", value: "", unparsed: false };
  if (!expr) return empty;
  const m = /^\{\{\s*(.+?)\s*\|\s*jq\('(.+)'\)\s*\|\s*first\s*\}\}$/s.exec(expr);
  if (!m) return { ...empty, unparsed: true };
  const rows = m[1] ?? "";
  const idm = /outputs\.([A-Za-z0-9_]+?)(?:_await)?[.)]/.exec(rows);
  const overId = idm?.[1] ?? "";
  if (!overId || !stepIds.has(overId)) return { ...empty, overId, unparsed: true };
  const P = m[2] ?? "";

  if (P === "length > 0") return { ...empty, overId, test: "any" };
  if (P === "length == 0") return { ...empty, overId, test: "none" };

  const str = (re: RegExp, test: BranchTest): ConditionRead | null => {
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
    return { overId, test, field: r[1] ?? "", value, unparsed: false };
  };

  const numeric = (op: string, test: BranchTest): ConditionRead | null => {
    const r = new RegExp(`^any\\(\\.\\[\\]; \\(\\.([A-Za-z0-9_]+) \\| tonumber\\?\\) \\${op} (-?[0-9.]+)\\)$`).exec(P);
    return r?.[1] && r?.[2] ? { overId, test, field: r[1], value: r[2], unparsed: false } : null;
  };

  return (
    str(/^any\(\.\[\]; \.([A-Za-z0-9_]+) == (".*")\)$/, "field_eq") ??
    str(/^any\(\.\[\]; \.([A-Za-z0-9_]+) != (".*")\)$/, "field_ne") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| contains\((".*")\)\)$/, "field_contains") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| startswith\((".*")\)\)$/, "field_starts") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) \| endswith\((".*")\)\)$/, "field_ends") ??
    str(/^any\(\.\[\]; \(\.([A-Za-z0-9_]+) \/\/ ""\) == ""\)$/, "field_empty") ??
    str(/^any\(\.\[\]; has\("([A-Za-z0-9_]+)"\)\)$/, "field_present") ??
    numeric(">", "field_gt") ??
    numeric("<", "field_lt") ?? { ...empty, overId, unparsed: true }
  );
}

// ── summaryExpr/contextExpr → summary/context ────────────────────────────────

function parseApprovalSummaryLike(summaryExpr: string, stepIds: Set<string>): { summary: string; context?: Source } | null {
  // The plain question — a JSON string with its quotes (I-11).
  try {
    const value: unknown = JSON.parse(summaryExpr);
    if (typeof value === "string") return { summary: value };
  } catch {
    // Not a bare string — try the built fan-out form below.
  }
  // The built form: `{{ <rows> | jq((("<text>") + " (" + (length|tostring) + " rows)") | @json) | first }}`.
  const m = /^\{\{\s*([\s\S]*?)\s*\|\s*jq\(([\s\S]*)\)\s*\|\s*first\s*\}\}$/.exec(summaryExpr.trim());
  if (!m) return null;
  const prog = (m[2] ?? "").trim();
  if (!prog.startsWith("'") || !prog.endsWith("'")) return null;
  const inner = prog.slice(1, -1);
  const text = /^\(\((".*")\) \+ " \(" \+ \(length\|tostring\) \+ " rows\)"\) \| @json$/.exec(inner);
  if (!text?.[1]) return null;
  let summary: string;
  try {
    const value: unknown = JSON.parse(text[1]);
    if (typeof value !== "string") return null;
    summary = value;
  } catch {
    return null;
  }
  const refs = knownStepRefs(m[1] ?? "", stepIds);
  if (refs.length === 1 && refs[0]) return { summary, context: { from: "whole", stepId: refs[0] } };
  return { summary };
}

function parseContextLike(contextExpr: string, stepIds: Set<string>): { found: boolean; source: Source | null } {
  const t = contextExpr.trim();
  try {
    const value: unknown = JSON.parse(t);
    if (typeof value === "string") return { found: true, source: { from: "literal", value } };
  } catch {
    // Not a bare string — try the template form below.
  }
  const m = /^\{\{([\s\S]*)\}\}$/.exec(t);
  if (!m || m[1] === undefined) return { found: false, source: null };
  const inner = (m[1] ?? "").trim();
  const input = /^inputs\.([A-Za-z0-9_]+)$/.exec(inner);
  if (input?.[1]) return { found: true, source: { from: "input", inputId: input[1] } };
  const refs = knownStepRefs(inner, stepIds);
  if (refs.length !== 1 || !refs[0]) return { found: false, source: null };
  const stepId = refs[0];
  if (!inner.includes("|")) return { found: true, source: { from: "whole", stepId } };
  const col = /^\s*[\s\S]*?\|\s*jq\('([\s\S]*)'\)\s*$/.exec(inner);
  const prog = col?.[1] ? /^\[\.\[\]\s*\|\s*([\s\S]*)\]$/.exec(col[1]) : null;
  const proj = prog?.[1] ? codeProjectionLike(prog[1]) : null;
  if (!proj) return { found: false, source: null };
  return {
    found: true,
    source: proj.transform
      ? { from: "step", stepId, field: proj.field, transform: proj.transform }
      : { from: "step", stepId, field: proj.field },
  };
}

// ── Per-kind upgrades ────────────────────────────────────────────────────────

function normaliseCall(step: Record<string, unknown>, stepIds: Set<string>): Record<string, unknown> {
  const out = { ...step };
  if (nonEmptyArray(out["inputs"])) {
    // New wins — unless a binding is explicitly unbound (`null`) while a
    // display exists. Null means unknown, and deleting the only readable
    // form for zero typed information strands the step: the emitter reads
    // the display verbatim when present and only falls to bindings without
    // one, where `boundSource` refuses the null (measured 2026-09-14:
    // second normalisation deleted the display a skipped `body` had kept).
    const bindings = out["inputs"] as Array<{ source?: unknown }>;
    if (!bindings.some((b) => b?.source === null || b?.source === undefined)) {
      delete out["paramsExpr"];
      return out;
    }
    if (!optString(out["paramsExpr"])?.trim()) {
      delete out["paramsExpr"];
      return out;
    }
    return out;
  }
  const expr = optString(out["paramsExpr"]);
  if (!expr || !expr.trim()) {
    out["inputs"] = [];
    delete out["paramsExpr"];
    return out;
  }
  const parsed = parseParamsLike(expr, stepIds);
  const where = parsed?.predicate ? storableWhere(parsed.predicate) : null;
  const bindings: InputBinding[] = (parsed?.mappings ?? []).map((m) => ({
    name: m.param,
    source:
      m.source.from === "step" && parsed?.overStepId
        ? { ...m.source, stepId: parsed.overStepId }
        : m.source,
  }));
  // Keep the stored string when the parse yields no bindings at all (the
  // standard blank `"[{}]"` included), or when any binding is null: dropping
  // it destroys the display the compiler still reads, for zero typed
  // information gained. (Readable mappings are never null — only the skipped
  // push below adds nulls, which already keeps — but the check states the rule.)
  const keepOld =
    !parsed ||
    parsed.filterUnreadable ||
    parsed.skipped.length > 0 ||
    (parsed.predicate !== null && !where) ||
    bindings.length === 0 ||
    bindings.some((b) => b.source === null);
  // ⚠ A FILTER the typed form cannot hold (phase 7, showcase `mild`): `select(… >= 70)`
  // has no stored `where`, so the bindings read without it describe a step that posts
  // for EVERY row. Carried beside the text they were a wrong statement of what runs,
  // and FT0206 refused the flow for disagreeing with its own text. The text is the
  // step: no bindings, no `over` — the legacy hand-written block (FT0602's warning),
  // exactly what it is.
  if (parsed && (parsed.filterUnreadable || (parsed.predicate !== null && !where))) {
    out["inputs"] = [];
    delete out["over"];
    delete out["where"];
    return out;
  }
  if (keepOld) {
    // Left as written; readable mappings carried, skipped names marked null.
    for (const name of parsed?.skipped ?? []) bindings.push({ name, source: null });
  }
  out["inputs"] = bindings;
  if (parsed?.overStepId) out["over"] = { stepId: parsed.overStepId, field: "" };
  else delete out["over"];
  if (!keepOld && where) out["where"] = where;
  else delete out["where"];
  if (!keepOld) delete out["paramsExpr"];
  return out;
}

function normaliseTransform(step: Record<string, unknown>): Record<string, unknown> {
  const out = { ...step };
  // `expr` is the shared old-and-new field — never dropped. Only the mode
  // defaults: an `expr`-only v1 transform is an expression transform.
  if (out["mode"] !== "expression" && out["mode"] !== "template") out["mode"] = "expression";
  return out;
}
function normaliseCode(step: Record<string, unknown>, stepIds: Set<string>): Record<string, unknown> {
  const out = { ...step };
  if (nonEmptyArray(out["inputs"])) {
    delete out["inputExpr"];
    return out;
  }
  const expr = optString(out["inputExpr"]);
  if (!expr || !expr.trim()) {
    out["inputs"] = [];
    delete out["inputExpr"];
    return out;
  }
  const parsed = parseCodeInputLike(expr, stepIds);
  out["inputs"] = parsed.bound;
  // Delete only when fully readable with zero nulls: a ghost ref reads as a
  // null binding the old pipeline emitted verbatim — dropping it turns a
  // carried unknown into an `unbound input` refusal.
  if (parsed.readable && parsed.bound.every((b) => b.source !== null)) delete out["inputExpr"];
  return out;
}

function normaliseBranch(step: Record<string, unknown>, stepIds: Set<string>): Record<string, unknown> {
  const out = { ...step };
  const test = out["test"];
  if (test !== undefined && test !== null) {
    // New wins — including an explicit `null` (unknown), which keeps the old
    // display the panel renders as unknown.
    if (test !== null) delete out["conditionExpr"];
    return out;
  }
  const expr = optString(out["conditionExpr"]);
  if (!expr || !expr.trim()) return out;
  const parsed = parseConditionLike(expr, stepIds);
  if (parsed.unparsed) {
    out["test"] = null;
    return out;
  }
  const left: Source =
    parsed.test === "any" || parsed.test === "none"
      ? { from: "whole", stepId: parsed.overId }
      : { from: "step", stepId: parsed.overId, field: parsed.field };
  const spec = BRANCH_TESTS.find((t) => t.test === parsed.test);
  const outTest: { left: Source; operator: BranchTest; right?: string } = { left, operator: parsed.test };
  if (spec?.needsValue) outTest.right = parsed.value;
  out["test"] = outTest;
  delete out["conditionExpr"];
  return out;
}

function normaliseApproval(step: Record<string, unknown>, stepIds: Set<string>): Record<string, unknown> {
  const out = { ...step };
  let summaryContext: Source | undefined;
  if (!nonEmptyString(out["summary"])) {
    const expr = optString(out["summaryExpr"]);
    if (nonEmptyString(expr)) {
      const parsed = parseApprovalSummaryLike(expr, stepIds);
      if (parsed) {
        out["summary"] = parsed.summary;
        delete out["summaryExpr"];
        summaryContext = parsed.context;
      }
      // Else left as written: the question stays in `summaryExpr`.
    }
  } else {
    delete out["summaryExpr"];
  }
  if (out["context"] !== undefined && out["context"] !== null) {
    delete out["contextExpr"];
  } else {
    const cexpr = optString(out["contextExpr"]);
    if (nonEmptyString(cexpr)) {
      const parsed = parseContextLike(cexpr, stepIds);
      if (parsed.found) {
        out["context"] = parsed.source;
        delete out["contextExpr"];
      }
      // Else left as written: the evidence stays in `contextExpr`.
    } else {
      delete out["contextExpr"];
      if (summaryContext && out["context"] === undefined) out["context"] = summaryContext;
    }
  }
  return out;
}

function normaliseStep(step: unknown, stepIds: Set<string>): unknown {
  if (!isRecord(step)) return step;
  const kind = step["kind"];
  if (kind === "tool" || kind === "datasource" || kind === "query") return normaliseCall(step, stepIds);
  if (kind === "transform") return normaliseTransform(step);
  if (kind === "code") return normaliseCode(step, stepIds);
  if (kind === "branch") return normaliseBranch(step, stepIds);
  if (kind === "approval") return normaliseApproval(step, stepIds);
  return { ...step };
}

/**
 * Upgrade a stored flow model to version 2 — see the file header for the rule.
 *
 * Never throws: a half-upgraded model would read as a different automation, so
 * on any failure the input is returned stamped but unconverted, and validation
 * downstream refuses it with a name rather than this function guessing.
 */
export function normaliseModel(raw: unknown): Record<string, unknown> {
  try {
    if (!isRecord(raw)) return { version: 2 };
    const steps = Array.isArray(raw["steps"]) ? raw["steps"] : [];
    const stepIds = new Set<string>();
    for (const s of steps) {
      if (isRecord(s) && typeof s["id"] === "string") stepIds.add(s["id"]);
    }
    return { ...raw, version: 2, steps: steps.map((s) => normaliseStep(s, stepIds)) };
  } catch {
    if (isRecord(raw)) return { ...raw, version: 2 };
    return { version: 2 };
  }
}
