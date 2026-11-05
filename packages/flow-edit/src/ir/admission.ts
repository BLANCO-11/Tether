/**
 * The admission kit (compiled-builder D-306): what a combinator must pass before any builder may offer it.
 *
 * For every fixture case: the combinator TYPES the case's input type; the evaluator runs; the LOWERING, executed by an
 * injected jq runner, returns exactly what the evaluator returned. The runner is local jq in unit tests and Kestra in
 * the engine proof (`kestra-combinators.ts`), which is the authority: Kestra runs jackson-jq, not C jq.
 *
 * Every combinator's fixture set must include the EMPTY input and, where a field may be null in the input type, a NULL.
 * The kit refuses a fixture set without them, because the failures that reach a run are exactly those cases (E0.3: S1).
 *
 * `negativeControl` proves the kit can fail: a deliberately wrong lowering must be refused, or "admitted" means nothing.
 */
import type { Ty } from "../typecheck/types.js";
import { evaluatePipeline, lowerPipeline, typePipeline, withContext, type Pipeline } from "./combinators.js";

/** A flow input a case uses: its IR type, its value, and the Kestra input type the engine proof declares. */
export interface CaseInput { ty: Ty; value: unknown; kestra: "INT" | "FLOAT" | "STRING" | "DATE" | "DATETIME" | "BOOLEAN" }
export interface AdmissionCase { name: string; inputTy: Ty; pipeline: Pipeline; input: unknown; inputs?: Record<string, CaseInput> }
export type JqRunner = (program: string, input: unknown, c: AdmissionCase) => Promise<unknown>;
export interface AdmissionReport { admitted: boolean; results: Array<{ case: string; ok: boolean; detail?: string }> }

/**
 * ⚠ ENGINE SEMANTICS (measured 2026-09-26, `null-key-probe.mts`): Kestra DROPS null-valued object keys, both when
 * `json()` parses a step's body (`has("e")` is false for `{"e": null}`) and when it renders a result. Only a `tojson`
 * STRING keeps them. So in a Foundry flow "null" and "absent" cannot be told apart anywhere, and the combinators are
 * written so they never need to: they only READ fields (`.f` is null either way, and `Option` covers both), and no
 * lowering may test key PRESENCE (`has`, `keys`, `to_entries` are banned from the vocabulary). Equality in the kit is
 * therefore modulo null-valued keys, which is the engine's own semantics, not a tolerance.
 */
export function dropNullKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNullKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNullKeys(x)]));
  return v;
}

/** Engine equality: `sameJson` after `dropNullKeys` on both sides. */
export const engineEqual = (a: unknown, b: unknown) => sameJson(dropNullKeys(a), dropNullKeys(b));

/** Stable deep equality for JSON values (object key order ignored; numbers compared by value). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** The fixture-set rules: an empty input, and (if any field is nullable) a row where it is null. */
export function fixtureGaps(cases: AdmissionCase[]): string[] {
  const gaps: string[] = [];
  const emptyIn = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : !!v && typeof v === "object" && Object.values(v as object).some(emptyIn));
  if (!cases.some((c) => emptyIn(c.input))) gaps.push("no EMPTY-input case");
  const nullable = cases.some((c) => JSON.stringify(c.inputTy).includes('"Option"'));
  const hasNull = cases.some((c) => JSON.stringify(c.input).includes("null"));
  if (nullable && !hasNull) gaps.push("the input type has a nullable field but no case has a null");
  return gaps;
}

export async function admit(cases: AdmissionCase[], run: JqRunner, lowerFn: typeof lowerPipeline = lowerPipeline): Promise<AdmissionReport> {
  const results: AdmissionReport["results"] = fixtureGaps(cases).map((g) => ({ case: "(fixture set)", ok: false, detail: g }));
  for (const c of cases) {
    const ctx = { inputs: Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, v]) => [k, v.ty])), values: Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, v]) => [k, v.value])) };
    const typed = withContext(ctx, () => typePipeline(c.inputTy, c.pipeline));
    if (!typed.ok) { results.push({ case: c.name, ok: false, detail: `does not type at stage ${typed.at}: ${typed.error}` }); continue; }
    const want = withContext(ctx, () => evaluatePipeline(c.input, c.pipeline));
    let got: unknown;
    try { got = await run(withContext(ctx, () => lowerFn(c.inputTy, c.pipeline)), c.input, c); } catch (e) { results.push({ case: c.name, ok: false, detail: `the lowering failed: ${(e as Error).message}` }); continue; }
    results.push(engineEqual(got, want) ? { case: c.name, ok: true } : { case: c.name, ok: false, detail: `engine ${JSON.stringify(got)} ≠ evaluator ${JSON.stringify(want)}` });
  }
  return { admitted: results.every((r) => r.ok), results };
}
