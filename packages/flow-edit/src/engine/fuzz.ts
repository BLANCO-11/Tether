/**
 * The soundness fuzz (compiled-builder phase 3, task 7; P7 — "well-typed flows do not go wrong"): for a COMPLETE flow, generate
 * data that CONFORMS to the declared schemas — every null a type permits, empty and single-row sets, boundary text, dates and
 * numbers, more rows than a fan-out may take — and evaluate the flow in process, with each call replaced by a stub of its
 * contract that checks what it RECEIVES. Any refusal is a runtime error on conforming data: a bug inside the box.
 *
 * ⚠ Data that violates its own schema is never generated (D-301): that is outside the box, and generating it would make the
 * fuzz measure the data instead of the compiler.
 *
 * ⚠ What this models, and what keeps it honest. Pipelines run through `evaluatePipeline`, which the admission kit proved
 * equal to the engine (phase 2). Bindings are evaluated here by the renderer's semantics — a literal and a flow input arrive
 * as TEXT, a declared number is coerced by the executor (`coerceDeclaredNumbers`), one row's field per fan-out call, a
 * column is every row's value, `text` is `tostring` — and a sampled subset runs on Kestra to keep this evaluator honest.
 */
import { evaluatePipeline, withContext } from "../ir/combinators.js";
import { dropNullKeys } from "../ir/admission.js";
import { portsOf, tyOfFlowInput, type CatalogueSnapshot, type CheckStep, type PortSig } from "../typecheck/signature.js";
import { render, type Ty } from "../typecheck/types.js";
import { armOfStep, chainOf, emissionOrder, loopOfStep, type EFlow, type EStep } from "./model.js";
import { rng } from "./walk.js";
import { MAX_FANOUT } from "./ops.js";

type R = () => number;
const pick = <X>(r: R, xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;

/** A value that inhabits `ty`, biased to the boundaries. */
export function genValue(ty: Ty, r: R, depth = 0, maxRows?: number): unknown {
  switch (ty.t) {
    case "Option": return r() < 0.35 ? null : genValue(ty.of, r, depth, maxRows);
    case "Text": return pick(r, ["", " ", "a", "O'Brien", "line one\nline two", "ünïcødé ✓", "x".repeat(300), '"quoted"', "\\slash", "Report"]);
    case "Key": return pick(r, ["INC-1001", "INC-1012", "K"]);
    case "Address": return pick(r, ["a@acme-corp.com", "o'brien@acme-corp.com", "first.last+tag@sub.acme-corp.com"]);
    case "Int": return pick(r, [0, 1, -1, 7, 1_000_000]);
    case "Number": return pick(r, [0, 0.1, -2.5, 92.5, 1e9, 3]);
    case "Bool": return r() < 0.5;
    case "Date": return pick(r, ["2024-02-29", "2026-06-30", "1970-01-01", "2026-12-31"]);
    case "DateTime": return pick(r, ["2026-06-30T09:00:00Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00Z"]);
    case "Month": return pick(r, ["2026-06", "2024-02", "1999-12"]);
    case "Record": return Object.fromEntries(Object.entries(ty.fields).map(([k, t]) => [k, genValue(t, r, depth + 1, maxRows)]));
    case "List": case "Rows": {
      // 0, 1, a few — and, at the top level, more than a fan-out may take, so a missing bound is found.
      // `maxRows` caps the top level for a run that must travel (the Kestra check, I-286); the fuzz itself never passes it.
      const n = depth > 0 ? pick(r, [0, 1, 2]) : pick(r, [0, 1, 1, 3, 6, MAX_FANOUT + 200].filter((k) => maxRows === undefined || k <= maxRows));
      return Array.from({ length: n }, () => genValue(ty.of, r, depth + 1, maxRows));
    }
    case "Envelope": return genValue(ty.of, r, depth, maxRows);
    case "Json": return {};
    default: return null;
  }
}

const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
/** Does a RECEIVED value satisfy a port's declared type? The stub of every call's contract. */
export function receives(v: unknown, ty: Ty, at: string): string | null {
  if (ty.t === "Option") return v === null || v === undefined ? null : receives(v, ty.of, at);
  if (v === null || v === undefined) return `${at}: null where ${render(ty)} is required`;
  switch (ty.t) {
    case "Text": {
      if (typeof v !== "string") return `${at}: ${JSON.stringify(v).slice(0, 40)} is not text`;
      for (const x of ty.refine ?? []) {
        if (x.r === "SingleLine" && /[\r\n]/.test(v)) return `${at}: a second line where one is allowed`;
        if (x.r === "NonEmpty" && !v.trim()) return `${at}: blank`;
        if (x.r === "MaxLen" && v.length > x.n) return `${at}: ${v.length} characters, at most ${x.n}`;
        if (x.r === "OneOf" && !x.values.includes(v)) return `${at}: "${v.slice(0, 30)}" is not one of ${x.values.join(", ")}`;
      }
      return null;
    }
    case "Key": return typeof v === "string" && v !== "" ? null : `${at}: ${JSON.stringify(v)} is not a key`;
    case "Address": return typeof v === "string" && ADDRESS.test(v) ? null : `${at}: ${JSON.stringify(v).slice(0, 40)} is not an address`;
    case "Int": return typeof v === "number" && Number.isInteger(v) ? null : `${at}: ${JSON.stringify(v)} is not a whole number`;
    case "Number": return typeof v === "number" && Number.isFinite(v) ? null : `${at}: ${JSON.stringify(v)} is not a number`;
    case "Bool": return typeof v === "boolean" ? null : `${at}: ${JSON.stringify(v)} is not true/false`;
    case "Date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : `${at}: ${JSON.stringify(v)} is not a date`;
    case "DateTime": return typeof v === "string" && v.includes("T") && !Number.isNaN(Date.parse(v)) ? null : `${at}: ${JSON.stringify(v)} is not a date-time`;
    case "Month": return typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? null : `${at}: ${JSON.stringify(v)} is not a month`;
    case "List": {
      if (!Array.isArray(v)) return `${at}: not a list`;
      for (const [i, x] of v.entries()) { const e = receives(x, ty.of, `${at}[${i}]`); if (e) return e; }
      return null;
    }
    case "Record": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${at}: not a record`;
      for (const [k, t] of Object.entries(ty.fields)) { const e = receives((v as Record<string, unknown>)[k], t, `${at}.${k}`); if (e) return e; }
      return null;
    }
    default: return null;
  }
}

/**
 * A flow input's value as the TEXT the engine renders it (`inputs.x ~ ''`), by its declared type — MEASURED on Kestra
 * (`logs/input-text-probe.log`, I-286), never assumed: an INT, DATE or BOOLEAN renders as sent; a FLOAT that is whole and
 * below 1e7 gains `.0` (`0` → `0.0`, `3` → `3.0`) while `10000000` and above render plain, and below 1e-3 it turns
 * scientific (`0.0001` → `1.0E-4`); a DATETIME carries six fractional digits (`…09:00:00.000000Z`).
 */
export function inputText(type: string, v: unknown): string {
  if (type === "FLOAT") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      if (Number.isInteger(n) && Math.abs(n) < 1e7) return `${n}.0`;
      if (n !== 0 && Math.abs(n) < 1e-3) { const [m, e] = n.toExponential().split("e"); return `${m!.includes(".") ? m : `${m}.0`}E${Number(e)}`; }
      return String(n);
    }
  }
  if (type === "DATETIME" && typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  return String(v);
}

/** The executor's coercion of a TEXT wire value by the port's declared type (`coerceDeclaredNumbers` / `coerceSqlParams`). */
function coerce(v: unknown, port: PortSig, kind: EStep["kind"]): unknown {
  if (typeof v !== "string") return v;
  const base = port.ty.t === "Option" ? port.ty.of : port.ty;
  if ((base.t === "Int" || base.t === "Number") && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  if (kind === "datasource" && base.t === "Bool" && (v === "true" || v === "false")) return v === "true";
  return v;
}

/**
 * What one run DID, for checking this evaluator against the engine (I-286): the inputs, each call step's parameters as they
 * leave the flow (`wire`, before the executor's coercion) and after it (`coerced`), and the data each call returned.
 */
export interface FuzzCallTrace { stepId: string; kind: "datasource" | "tool"; wire: Record<string, unknown>[]; coerced: Record<string, unknown>[]; responses: unknown[] }
/** `ran`: every step that ran, in order (an untaken arm's steps are absent); `values`: each transform's and merge's value. */
export interface FuzzRunTrace { inputs: Record<string, unknown>; calls: FuzzCallTrace[]; ran: string[]; values: Record<string, unknown> }
export interface FuzzReport { runs: number; errors: string[]; traces?: FuzzRunTrace[] }
export interface FuzzOptions { maxRows?: number; trace?: boolean }

/** Evaluate a complete flow `runs` times on fresh conforming data. `dataCat` is the TRUE schema the data is drawn from. */
export function fuzzFlow(f: EFlow, cat: CatalogueSnapshot, runs: number, seed: number, dataCat: CatalogueSnapshot = cat, opts: FuzzOptions = {}): FuzzReport {
  const r = rng(seed);
  const errors: string[] = [];
  const traces: FuzzRunTrace[] = [];
  const inputTys = Object.fromEntries(f.inputs.map((i) => [i.id, tyOfFlowInput(i)]));
  for (let run = 0; run < runs && errors.length === 0; run++) {
    // ⚠ A run's inputs travel as MULTIPART form fields (`kestra-client` and the harness both use FormData), and form encoding
    // normalises every newline to CRLF — measured on the engine (I-286 re-run, `logs/kestra-branches.log`). So a text input
    // is drawn as it ARRIVES, not as a person typed it.
    const arrives = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n|\r|\n/g, "\r\n") : v);
    const inputs: Record<string, unknown> = Object.fromEntries(f.inputs.map((i) => [i.id, i.defaults ?? arrives(genValue(inputTys[i.id]!, r, 0, opts.maxRows))]));
    const trace: FuzzRunTrace = { inputs, calls: [], ran: [], values: {} };
    if (opts.trace) traces.push(trace);
    const readable = new Map<string, unknown>(); // what a READER of the step sees (pipelineInputType's value)
    const fail = (m: string) => { errors.push(`run ${run}: ${m}`); };
    // D-320: a chain is decided where its head is (the compiler emits the whole chain there); the first link that holds runs.
    const arms = armOfStep(f);
    const taken = new Map<string, boolean>();
    const ran = (id: string) => trace.ran.push(id);
    const byId = new Map(f.steps.map((x) => [x.id, x]));
    const emitted = new Set<string>();
    const loops = loopOfStep(f);
    // Which steps ran in the current SCOPE — the whole run at the top level, one item inside a loop — so a merge inside a
    // loop's body picks the path THIS item took.
    let scope = new Set<string>();
    const order = emissionOrder(f);
    const loopResults = new Map<string, Array<{ item: unknown; ran: boolean; value: unknown }>>();
    const evalStep = (sid: string): void => {
      const s = byId.get(sid)!;
      emitted.add(sid);
      // ⚠ Every read must be of a step already EMITTED (the engine runs in emission order): a read of one not yet emitted
      // renders a task that has not run — refused here as it would fail on the engine.
      const reads = [...s.dependsOn, ...("from" in s ? [s.from] : []), ...("inputs" in s ? s.inputs.flatMap((b) => (b.source && "stepId" in b.source ? [b.source.stepId] : [])) : []), ...(s.kind === "branch" ? (s.conditions ?? []).map((c) => c.left.stepId) : [])];
      const early = reads.find((x) => !emitted.has(x));
      if (early) { fail(`\`${s.id}\` runs before \`${early}\`, which it reads`); return; }
      const guard = arms.get(s.id);
      if (guard !== undefined && !taken.get(guard)) return;
      const done = () => { ran(s.id); scope.add(s.id); };
      if (s.kind === "branch") {
        if (s.elseOf) return; // decided with its head
        let decided = false;
        for (const link of chainOf(f, s.id)) {
          for (const c of (byId.get(link) as EStep & { kind: "branch" }).conditions ?? []) if (!emitted.has(c.left.stepId)) fail(`\`${link}\` tests \`${c.left.stepId}\` before it runs`);
          const l = f.steps.find((x) => x.id === link) as EStep & { kind: "branch" };
          const holds = !decided && (l.conditions ?? []).every((c) => {
            const v = readable.get(c.left.stepId);
            if (!Array.isArray(v)) { fail(`\`${l.id}\` tests \`${c.left.stepId}\`, which is not a list at run time`); return false; }
            return c.op === "any" ? v.length > 0 : v.length === 0;
          });
          taken.set(link, holds);
          if (holds) decided = true;
        }
        done();
        return;
      }
      if (s.kind === "merge") {
        const src = s.sources.find((x) => scope.has(x));
        if (src === undefined) { fail(`the merge \`${s.id}\` has no source that ran`); return; }
        readable.set(s.id, readable.get(src));
        trace.values[s.id] = readable.get(src);
        done();
        return;
      }
      if (s.kind === "approval") { done(); return; }
      if (s.kind === "collect") {
        const rows = loopResults.get(s.loop);
        if (!rows) { fail(`the output \`${s.id}\` of \`${s.loop}\` has no items`); return; }
        const out = rows.map((x, i) => {
          if (!x.ran) fail(`\`${s.result}\`, the result of \`${s.loop}\`, did not run for item ${i}`);
          return { ...(x.item as Record<string, unknown>), ff_i: i, ff_ok: x.ran, ff_error: x.ran ? null : "did not finish", ff_result: x.ran ? x.value : null };
        });
        readable.set(s.id, out);
        trace.values[s.id] = out;
        done();
        return;
      }
      if (s.kind === "for_each") {
        // For each (D-361): the body runs once per row, each item with its own paths (`taken`) and its own scope; the result
        // step's value per item is what the loop's output reads.
        const rows = readable.get(s.over.stepId);
        if (!Array.isArray(rows)) { fail(`\`${s.id}\` loops over a non-list`); return; }
        if (rows.length > MAX_FANOUT) { fail(`\`${s.id}\` would run ${rows.length} items; the bound is ${MAX_FANOUT}`); return; }
        const members = order.filter((x) => loops.get(x) === s.id);
        const result = f.steps.find((x): x is EStep & { kind: "collect" } => x.kind === "collect" && x.loop === s.id)?.result;
        const outer = scope;
        const results: Array<{ item: unknown; ran: boolean; value: unknown }> = [];
        done();
        for (const row of rows) {
          scope = new Set();
          readable.set(s.id, row);
          for (const m of members) { emitted.delete(m); taken.delete(m); readable.delete(m); }
          for (const m of members) { if (errors.length) break; evalStep(m); }
          results.push({ item: row, ran: result !== undefined && scope.has(result), value: result !== undefined ? readable.get(result) : undefined });
        }
        for (const m of members) emitted.add(m);
        scope = outer;
        loopResults.set(s.id, results);
        return;
      }
      if (s.kind === "transform") {
        try {
          const out = withContext({ inputs: inputTys, values: inputs }, () => evaluatePipeline(readable.get(s.from), s.pipeline));
          if (out === null || out === undefined) fail(`\`${s.id}\` produced null, which its reader cannot read (I-282)`);
          readable.set(s.id, out);
          trace.values[s.id] = out;
          done();
        } catch (e) { fail(`\`${s.id}\` threw: ${(e as Error).message}`); }
        return;
      }
      const ports = portsOf(s as unknown as CheckStep, cat) ?? [];
      const trueSig = dataCat.refs[(s as EStep & { kind: "tool" | "datasource" }).ref!];
      const over = s.kind === "tool" ? s.over?.stepId : undefined;
      const rows = over ? (readable.get(over) as unknown[]) : [null];
      if (!Array.isArray(rows)) { fail(`\`${s.id}\` fans out over a non-list`); return; }
      if (rows.length > MAX_FANOUT) { fail(`\`${s.id}\` would make ${rows.length} calls; the batch limit is ${MAX_FANOUT}`); return; }
      const outs: unknown[] = [];
      const call: FuzzCallTrace = { stepId: s.id, kind: s.kind, wire: [], coerced: [], responses: outs };
      if (opts.trace) trace.calls.push(call);
      for (const row of rows) {
        const params: Record<string, unknown> = {};
        const wire: Record<string, unknown> = {};
        for (const b of s.inputs) {
          if (!b.source) continue;
          const src = b.source;
          const port = ports.find((p) => p.name === b.name)!;
          let v: unknown;
          if (src.from === "literal") v = src.value;
          else if (src.from === "input") { const iv = inputs[src.inputId]; v = iv === null || iv === undefined ? null : inputText(f.inputs.find((i) => i.id === src.inputId)?.type ?? "STRING", iv); }
          // The engine renders a value it has already dropped null-valued keys from (I-281) — measured on Kestra (I-286).
          else if (src.from === "whole") { const u = readable.get(src.stepId); v = typeof u === "string" ? u : JSON.stringify(dropNullKeys(u)); }
          else {
            const up = readable.get(src.stepId);
            if (over === src.stepId) v = (row as Record<string, unknown>)?.[src.field] ?? null;
            else if (Array.isArray(up)) v = up.map((x) => (x as Record<string, unknown>)?.[src.field] ?? null);
            else v = (up as Record<string, unknown> | null)?.[src.field] ?? null;
          }
          wire[b.name] = v;
          params[b.name] = coerce(v, port, s.kind);
        }
        call.wire.push(wire);
        call.coerced.push(params);
        for (const p of ports) {
          const v = params[p.name];
          if (v === undefined) { if (p.required) fail(`\`${s.id}\`.${p.name}: required and not sent`); continue; }
          const one = p.liftsScalar && p.ty.t === "List" && !Array.isArray(v) ? receives(v, p.ty.of, `\`${s.id}\`.${p.name}`) : receives(v, p.ty, `\`${s.id}\`.${p.name}`);
          if (one) fail(one);
        }
        outs.push(genValue(trueSig ? trueSig.payload : { t: "Json" }, r, 0, opts.maxRows));
      }
      // What a reader sees: rows of a reader; one payload of a single call; every call's data spliced for a fan-out.
      readable.set(s.id, over ? outs.flatMap((o) => (Array.isArray(o) ? o : [o])) : outs[0]);
      done();
    };
    for (const sid of order) {
      if (errors.length) break;
      if (loops.has(sid)) continue; // run by its loop, once per item
      evalStep(sid);
    }
  }
  return { runs, errors, ...(opts.trace ? { traces } : {}) };
}
