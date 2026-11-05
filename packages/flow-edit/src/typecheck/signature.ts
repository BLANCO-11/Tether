/**
 * Step signatures — DERIVED, never newly declared (D-244). Phase 1 task 3.
 *
 * A signature is what a step takes (typed ports) and what it produces (one Ty).
 * Everything comes from the `CatalogueSnapshot` the server builds from what the
 * workspace already declares. Where nothing declares a type the answer is
 * `Opaque` — gradual typing — and never a guess.
 */
import { typeTransform, withContext, type Pipeline } from "../ir/combinators.js";
import { T, tyOfParam, type Ty } from "./types.js";

/** One port of a component, as the catalogue declares it. */
export interface PortSig {
  name: string;
  ty: Ty;
  required: boolean;
  /**
   * A `List` port that ALSO accepts one element in its place, because its
   * receiver wraps it (`routes/mail.ts` `to`/`cc`). Declared per port, from
   * what the receiver's own schema does — never assumed for lists in general.
   */
  liftsScalar?: boolean;
  /**
   * Left unset, the RECEIVER fills this port with the person who started the run — `routes/mail.ts`' `to`
   * (`resolveRecipients`), and nothing else. Declared per port from what the receiver does (I-287): FT0508 and the engine's
   * scheduled-recipient hole used to assume it of EVERY optional address port, which was true only while no other tool had
   * one, and is false of `cc` even on the same tool (an unset `cc` is no cc).
   */
  fallsBackToRequester?: boolean;
  /**
   * A value the CATALOGUE states for this port (compiled-builder D-323) — "Use 'prod'" declared as data. The solver binds it,
   * with provenance `catalogue`, when the person's words fill nothing here: after them, before a question. In the engine's
   * literal form, and checked with `literalFits` wherever it is bound, so a stale default becomes a question, never a guess.
   */
  default?: string;
  /** The port carries words a person reads (declared per tool) — the only kind of port a drafted per-row template fills (D-324). */
  message?: boolean;
  /** A short line a person reads that names the thing sent — a subject, a title (declared per tool). Drafted from the goal (Z8). */
  heading?: boolean;
  /**
   * The port that takes the UPSTREAM DATA (as text) — declared per tool, because a tool with two text ports (a model's `input` and
   * `instruction`) cannot be told apart by type, and the builder asked the person "what should the input be?" (2026-09-27).
   */
  data?: boolean;
  /**
   * Only a STEP's output fills this port — never a value a person states (declared per tool). A port typed as text because the
   * engine hands it a step's whole output as text (`attach_rows`) would otherwise take any sentence: the goal's words "active
   * employees not allocated to any project" were bound as the rows of a CSV, and the run failed at the receiver (2026-10-02, H07).
   */
  fromStep?: boolean;
  /**
   * A value in this port means nothing unless the NAMED port is bound too (declared per tool): a generated file's name or format
   * without its rows. The solver binds that port from what the call already takes when this one is filled — never by name.
   */
  needs?: string;
  /** The section a builder shows this port under, with the others of the same group (declared per tool: "Attachment"). Display only. */
  group?: string;
  /**
   * A reader's input that keeps only the rows whose field `selects` EQUALS it — the output field its equality filter compares,
   * derived from the reader's own definition (a DB operation's filter and projection), never from names. So "the open tickets" is
   * this input set to "open" whatever the input is called, and a filter on that field is what the reader already does.
   */
  selects?: string;
  /**
   * Which END of a range a reader's input is — the operator that reads it (`ge` the first day, `lt` the day after the last), derived
   * from the reader's own definition. So a range the person states ("1 to 15 august 2026") fills each end by what it IS, not by name.
   */
  edge?: "ge" | "gt" | "le" | "lt";
}

/** What a ref (a tool, a named query, a DB operation) takes and gives. */
export interface RefSig {
  kind: "tool" | "query" | "operation";
  params: PortSig[];
  /**
   * The type of ONE element of `.results[i].data`, i.e. what the step's
   * envelope carries. A query/operation's is `Rows<Record{…}>`; a named
   * query's is `Rows<Json>` (D-257); a tool with no declared output `Opaque`.
   */
  payload: Ty;
  /**
   * The tool's output is text a MODEL wrote, for a person to read and never to compute on (D-34). DECLARED by the catalogue
   * (I-292) — the checker and the engine read this flag and never a tool's name.
   */
  modelText?: boolean;
}

/**
 * The plain-data projection of a workspace the checker reads. Built by the
 * server (`typecheck-catalogue.ts`); the client may receive the same value.
 */
export interface CatalogueSnapshot {
  refs: Record<string, RefSig>;
  /**
   * A step-local reader (drafter-generated SQL, `fillGapsWithStepSql`) has no
   * catalogue entry. The server parses its select list and hands the column
   * names here, keyed by step id. Names only — their types are `Opaque`.
   */
  stepColumns?: Record<string, string[]>;
  /** `MAIL_ALLOWED_RECIPIENT_DOMAINS`, when set. Absent = not restricted. */
  mailAllowedDomains?: string[];
  /**
   * What the COMPILER would emit for a step's inputs if its hand-written blob
   * (`paramsExpr` / `inputExpr`) were absent — the server passes its own
   * `displayParams` / `displayCodeInput` over a blob-stripped copy (I-204,
   * FT0206). `null` = the bindings do not render. Absent = the checker falls
   * back to `buildSingleParams` for the literal/input-only case and decides
   * nothing else, because a second render with no shapes would be a second
   * definition of what runs.
   */
  renderInputs?: (step: CheckStep, steps: readonly CheckStep[]) => string | null;
}

// ── The model, as far as the checker reads it ─────────────────────────────
// Deliberately STRUCTURAL and loose: the server's `FlowModel` and the client's
// `AuthoredFlow` both satisfy it, and a field the checker does not know about
// is ignored rather than refused.

export interface CheckSource {
  from: "step" | "whole" | "input" | "literal" | "self";
  stepId?: string;
  field?: string;
  inputId?: string;
  value?: string;
  transform?: "date" | "text" | "number" | "month";
  onNull?: "skip" | "fail" | Record<string, "skip" | "fail">;
}

export interface CheckStep {
  id: string;
  kind: string;
  ref?: string;
  sql?: string;
  dependsOn?: string[];
  inputs?: Array<{ name: string; source: CheckSource | null }>;
  paramsExpr?: string;
  /** A `code` step's hand-written input object — the blob beside its `inputs`. */
  inputExpr?: string;
  over?: { stepId: string; field: string } | null;
  outputColumns?: Array<{ name: string; type?: string }>;
  outputKeys?: string[];
  /** A drafted reshape's declared output fields (phase 3 step 2). */
  fields?: string[];
  outputFields?: Array<{ name: string; type?: string; format?: string }>;
  sources?: string[];
  elseOf?: string;
  [k: string]: unknown;
}

export interface CheckInput {
  id: string;
  type?: string;
  computed?: string;
  defaults?: string;
  /** A STRING input's shape (phase 5, D-255). */
  format?: string;
}

export interface CheckModel {
  id: string;
  inputs?: CheckInput[];
  steps: CheckStep[];
  output?: { stepId?: string };
}

// ── Flow inputs ────────────────────────────────────────────────────────────

const COMPUTED: Record<string, Ty> = {
  priorMonth: T.month(),
  currentMonth: T.month(),
  priorDate: T.date(),
  currentDate: T.date(),
  currentYear: T.int(),
  runTimestamp: T.dateTime(),
  currentMonthStart: T.date(),
  priorMonthStart: T.date(),
};

/** A declared flow input's type. A computed input's function decides it. */
export function tyOfFlowInput(i: CheckInput): Ty {
  if (i.computed && COMPUTED[i.computed]) return COMPUTED[i.computed]!;
  switch (String(i.type ?? "STRING").toUpperCase()) {
    case "INT": return T.int();
    case "FLOAT": return T.number();
    case "BOOLEAN": return T.bool();
    case "DATE": return T.date();
    case "DATETIME": return T.dateTime();
    default: return i.format === "month" ? T.month() : T.text();
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

const CALL_KINDS = new Set(["tool", "datasource", "query"]);

export function isCallStep(s: CheckStep): boolean {
  return CALL_KINDS.has(s.kind);
}

/**
 * The type of what a step produces, as a downstream step reads it.
 *
 * `Envelope<P>` for a call step (Foundry's `{results, succeeded, failed,
 * warnings}`, I-117); the declared shape for a transform/code/llm step; `Never`
 * for approval and branch. `null` is returned for an unknown ref — that is
 * FT0105's finding, and the signature does not pretend.
 */
export function outputOf(step: CheckStep, cat: CatalogueSnapshot, model?: CheckModel): Ty | null {
  switch (step.kind) {
    case "tool":
    case "datasource":
    case "query": {
      const local = cat.stepColumns?.[step.id];
      if (step.sql && local) return T.envelope(T.rows(T.record(Object.fromEntries(local.map((c) => [c, T.opaque()])))));
      const ref = step.ref ? cat.refs[step.ref] : undefined;
      return ref ? T.envelope(ref.payload) : null;
    }
    case "transform":
      // A typed PIPELINE (compiled-builder 2d) has an exact output type — no Opaque fields (E0.7 G9). An ill-typed one is
      // FT0901 (reported by checkFlow); its output is then Opaque so one error does not cascade into many.
      if (Array.isArray(step.pipeline)) {
        const r = pipelineType(step, cat, model);
        return r && r.ok ? r.ty : T.opaque();
      }
      if (step.outputColumns?.length)
        return T.rows(T.record(Object.fromEntries(step.outputColumns.map((c) => [c.name, c.type ? tyOfParam(c.type) : T.opaque()]))));
      // A drafted `{from, program, fields}` reshape DECLARES its keys — of the
      // object it returns, or of each element of a list (`rowOf` reads both
      // the same). Their types are the program's business, so Opaque.
      if (step.fields?.length) {
        const rec = T.record(Object.fromEntries(step.fields.map((f) => [f, T.opaque()])));
        // Our own lowering is `… | jq('(<program>) | …') | first`. Only a program
        // that PLAINLY opens with `{` is one object; anything else — `[…]`, but
        // also `(.employees | map(…))` — is taken as a LIST (fan-out-able,
        // FT0207). ⚠ The guess used to run the other way ("opens with `[`, else
        // an object") and refused build:measure R01 r7, whose `map(…)` fanned out
        // on a green run: a finding the checker cannot justify is I-62's shape.
        // ⚠ And "anything else is a list" was ALSO a guess: r11 R11/L2 end in
        // `… | if type == "string" then {text: .} else . end` — ONE object — and
        // were refused (FT0202 "List<Opaque> is not Text") on green runs. Now the
        // program's LAST top-level stage decides; undecidable is Opaque, no error.
        // Undecidable keeps the declared KEYS (read as one object, so a field
        // read is checked) and `transformShapeOf` tells FT0207 not to judge it.
        // No program text at all (a drafted reshape before lowering) stays a list.
        const shape = transformShapeOf(step);
        return shape === "list" || shape === "none" ? T.rows(rec) : rec;
      }
      return T.opaque();
    case "code":
      return step.outputKeys?.length ? T.record(Object.fromEntries(step.outputKeys.map((k) => [k, T.opaque()]))) : T.opaque();
    case "llm":
      return step.outputFields?.length
        ? T.record(Object.fromEntries(step.outputFields.map((f) => [f.name, tyOfParam(f.type, f.format)])))
        : T.record({ text: T.text() });
    case "approval":
    case "branch":
      return T.never();
    case "for_each": {
      // For each (D-361): inside the body, the loop's value is the CURRENT ITEM — one row of the list it runs over.
      const over = (step.over as { stepId?: string } | null | undefined)?.stepId;
      const src = over ? model?.steps.find((s) => s.id === over) : undefined;
      const rows = src ? outputOf(src, cat, model) : null;
      return rows ? rowOf(rows) : T.opaque();
    }
    case "collect": {
      // The box's output: one row per item — its own fields, and `i`, `ok`, `error`, `result` (the result step's value; null
      // for an item whose result step did not finish).
      const loop = model?.steps.find((s) => s.id === step["loop"]);
      const res = model?.steps.find((s) => s.id === step["result"]);
      const item = loop ? outputOf(loop, cat, model) : null;
      const out = res ? outputOf(res, cat, model) : null;
      if (!item || item.t !== "Record" || !out) return T.opaque();
      const value = out.t === "Envelope" ? out.of : out;
      return T.list(T.record({ ...item.fields, ff_i: T.int(), ff_ok: T.bool(), ff_error: T.option(T.text()), ff_result: T.option(value) }));
    }
    case "merge": {
      // The join of the sources — all must agree (FT0702 says when not).
      const outs = (step.sources ?? []).map((id) => model?.steps.find((s) => s.id === id)).map((s) => (s ? outputOf(s, cat, model) : null));
      const first = outs[0];
      if (!first || outs.some((o) => !o || JSON.stringify(o) !== JSON.stringify(first))) return T.opaque();
      return first;
    }
    default:
      return T.opaque();
  }
}

/**
 * The type a transform PIPELINE reads — what `rowsExpr` hands it at run time — and the pipeline's own type.
 * A call step's rows are its envelope's payload (`.results[0].data`); a fan-out's are every call's data spliced into one
 * list (`allResultsRows`); a transform's are its value. `null` when the source step is not in the flow (FT0902).
 */
export function pipelineInputType(from: CheckStep, cat: CatalogueSnapshot, model?: CheckModel): Ty | null {
  const out = outputOf(from, cat, model);
  if (!out) return null;
  if (out.t !== "Envelope") return out;
  const p = out.of;
  if (from.over) return p.t === "Rows" || p.t === "List" ? T.list(p.of) : T.list(p);
  return p;
}
export function pipelineType(step: CheckStep, cat: CatalogueSnapshot, model?: CheckModel): ReturnType<typeof typeTransform> | null {
  const fromId = typeof step.from === "string" ? step.from : undefined;
  const src = fromId ? model?.steps.find((s) => s.id === fromId) : undefined;
  if (!src) return null;
  const inTy = pipelineInputType(src, cat, model);
  if (!inTy) return null;
  const inputs = Object.fromEntries((model?.inputs ?? []).map((i) => [i.id, tyOfFlowInput(i)]));
  return withContext({ inputs }, () => typeTransform(inTy, step.pipeline as Pipeline));
}

/**
 * The type ONE ROW has, as a `{from:"step", field}` binding reads it: strip the
 * envelope, then take the element of a `Rows`/`List` (`render.ts` `jqValue`
 * reads `.field` off each row of `.results[0].data`).
 */
export function rowOf(ty: Ty): Ty {
  let t = ty;
  if (t.t === "Envelope") t = t.of;
  if (t.t === "Rows" || t.t === "List") t = t.of;
  return t;
}

/** The ports a call step's component declares. `null` when the ref is unknown. */
export function portsOf(step: CheckStep, cat: CatalogueSnapshot): PortSig[] | null {
  if (!isCallStep(step)) return [];
  if (step.sql && cat.stepColumns?.[step.id]) return []; // a generated reader: its params are its own
  const ref = step.ref ? cat.refs[step.ref] : undefined;
  return ref ? ref.params : null;
}

type JqShape = "object" | "list" | "unknown";

/** A transform's list-or-object shape, read from its program; "none" when it has no program text. */
export function transformShapeOf(step: { kind?: string; expr?: unknown }): JqShape | "none" {
  if (step.kind !== "transform" || typeof step.expr !== "string") return "none";
  const prog = /\|\s*jq\('([\s\S]*)'\)\s*\|\s*first\s*\}\}\s*$/.exec(step.expr)?.[1];
  return prog === undefined ? "unknown" : jqResultShape(prog.replace(/''/g, "'"));
}

/** Split `src` at `sep` wherever it is outside strings and brackets. */
function splitTop(src: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      // skip the string; `\(…)` interpolation is inside it and changes nothing here
      i++;
      let interp = 0;
      while (i < src.length && (src[i] !== '"' || interp > 0)) {
        if (src[i] === "\\" && src[i + 1] === "(") { interp++; i += 2; continue; }
        if (src[i] === "\\") { i += 2; continue; }
        if (interp > 0 && src[i] === "(") interp++;
        else if (interp > 0 && src[i] === ")") interp--;
        i++;
      }
      i++;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      const m = sep.exec(src.slice(i));
      if (m && m.index === 0) { out.push(src.slice(start, i)); i += m[0].length; start = i; continue; }
    }
    i++;
  }
  out.push(src.slice(start));
  return out.map((x) => x.trim());
}

/** Does the bracket opened at 0 close at the very end? */
function closesAtEnd(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c) && --d === 0 && i < s.length - 1) return false;
  }
  return d === 0;
}

/**
 * What ONE jq program returns — an object, a list, or undecidable — read off
 * its LAST top-level pipe stage (`.` in an `if` branch is the stage before).
 * Deliberately small: anything unrecognised is "unknown", never a guess.
 */
export function jqResultShape(program: string): JqShape {
  let prev: JqShape = "unknown";
  for (const st of splitTop(program.trim(), /^\|(?!=)/)) prev = stageShape(st, prev);
  return prev;
}

function stageShape(s: string, prev: JqShape): JqShape {
  if (/\sas\s+\$\w+$/.test(s)) return prev; // `X as $v` passes its input through
  if (s === ".") return prev;
  if (s.startsWith("{")) return "object";
  if (s.startsWith("[")) return "list";
  if (/^(map|sort_by|group_by|unique_by|unique|sort|reverse|flatten|to_entries|keys)\b/.test(s)) return "list";
  if (/^(map_values|from_entries|with_entries)\b/.test(s)) return "object";
  if (closesAtEnd(s) && s.startsWith("(")) return jqResultShape(s.slice(1, -1));
  const m = /^if\s([\s\S]*)\send$/.exec(s);
  if (m && !/\bif\b/.test(m[1]!.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
    // cond, body, (cond, body)*, else-body — bodies are the odd parts and the last.
    const parts = splitTop(m[1]!, /^\s(?:then|elif|else)\s/);
    const bodies = parts.filter((_, i) => i % 2 === 1 || i === parts.length - 1);
    const shapes = bodies.map((b) => (b === "." ? prev : jqResultShape(b)));
    return shapes.length && shapes.every((x) => x === shapes[0]) ? shapes[0]! : "unknown";
  }
  return "unknown";
}
