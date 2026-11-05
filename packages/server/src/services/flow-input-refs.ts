/**
 * -----------------------------------------------------------------------------
 * AN EXPRESSION MAY ONLY READ AN INPUT THE FLOW DECLARES
 * -----------------------------------------------------------------------------
 *
 * WARNING **Reported from use - execution `1ygllnw0XWjPHWo04qarqk`, dead 0.4s in:**
 *
 *     Unable to find `inputs` used in the expression
 *       [{"as_of":"{{ inputs.as_of }}"}]
 *
 * The step read `{{ inputs.as_of }}`. The flow declared no inputs at all - all
 * SIX of its revisions carry `inputs: null` - so the compiler emitted no
 * `inputs:` block, Kestra had no such variable, and the render threw before a
 * single call was made.
 *
 * -- WHY EVERY EXISTING CHECK PASSED IT --------------------------------------
 *
 * `inputs` is on D-22's `ALLOWED_ROOTS`, so the allowlist said yes - correctly,
 * since reading an input is exactly what that root is for. And neither
 * `flow-validator.service.ts` nor `flow-expression.service.ts` had ever read
 * `model.inputs`: the allowlist checks the SHAPE of an expression and never
 * whether the thing it names exists.
 *
 * WARNING **This is the THIRD instance of that one gap in a single day**, and the
 * pattern is worth naming because the next one will look different again:
 *
 *   - `{{ trigger.timestamp }}`   - an allowed root, absent on every run a
 *                                   person can start (see `UNREACHABLE_ROOTS`)
 *   - `"{{ inputs.period }}-31"`  - a legal concatenation, an impossible date
 *                                   (`checkConstructedDates`)
 *   - `{{ inputs.as_of }}`        - an allowed root, nothing declared it (here)
 *
 * Each was authored, saved and run before anything objected, and because gate 1
 * requires a successful run before arming, each made its flow permanently
 * unarmable. A refusal at authoring time is the whole remedy.
 *
 * -- WHAT THIS DOES NOT DO ---------------------------------------------------
 *
 * It does not check TYPES, and it must not start: an input declared `STRING`
 * and used where a number is wanted is a question about the query, not about
 * the flow model, and this module has no way to answer it.
 *
 * It reports only names read and never declared. The opposite - an input
 * declared and never read - is not an error: a person may add the field before
 * the step that uses it, and a flow whose input is only read by a trigger's
 * configured values is legitimate.
 */
import { templateSpans } from "./flow-expression.service.js";

/**
 * Every input name an expression reads.
 *
 * WARNING **Scanned through `templateSpans`, never with a regex over the raw field.**
 * A `paramsExpr` is mostly JSON with `{{ }}` islands in it, so a bare regex
 * would match the literal text `inputs.foo` in a prose value and report a
 * finding nobody can act on. I-62 is the record of what that costs: a guard
 * with three false positives and zero real ones gets widened, and the widening
 * people reach for is the one that permits the defect.
 */
const INPUT_REF_RE =
  /(^|[^.\w])inputs\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

export function inputNamesRead(expr: string): string[] {
  const out = new Set<string>();
  for (const span of templateSpans(expr)) {
    for (const m of span.body.matchAll(INPUT_REF_RE)) {
      const name = m[2] ?? m[3];
      if (name) out.add(name);
    }
  }
  return [...out];
}

/**
 * The check itself, over a parsed model's steps and its declared input ids.
 *
 * WARNING **`declared` is a REQUIRED argument and every caller must supply it.** The
 * obvious shape here is an optional parameter defaulting to "no inputs" - and
 * that is I-127 exactly: a shared checker whose optional input silently gives
 * one consumer less than another, which is how `operations` went missing from
 * chat's catalogue and how `expressionsBlock` stayed a five-line summary. An
 * omitted argument would make every input look undeclared, which is loud; the
 * dangerous direction is a default of "assume it exists", and there is no such
 * default here because there is no default at all.
 *
 * WARNING The message names the input AND both remedies, because a person reading it
 * has genuinely two choices and the wrong guess costs another round trip.
 */
export function checkDeclaredInputs(
  steps: Array<Record<string, unknown>>,
  declared: readonly string[],
  fields: readonly string[],
): string[] {
  const known = new Set(declared);
  const findings: string[] = [];
  const reported = new Set<string>();

  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : "<unnamed step>";
    // Expression fields, then typed bindings (phase 3 step 3) — a binding to an
    // undeclared input renders `inputs.x` exactly as an expression does and
    // fails the same way, so it is the same finding, named by its binding.
    const reads: Array<[string, string[]]> = [];
    for (const field of fields) {
      const value = step[field];
      if (typeof value === "string") reads.push([field, inputNamesRead(value)]);
    }
    if (Array.isArray(step.inputs)) {
      for (const b of step.inputs as Array<{ name?: unknown; source?: unknown }>) {
        const src = b?.source as { from?: unknown; inputId?: unknown; value?: unknown } | null | undefined;
        if (!src || typeof src !== "object") continue;
        const label = `inputs["${String(b.name ?? "")}"]`;
        if (src.from === "input" && typeof src.inputId === "string" && src.inputId) reads.push([label, [src.inputId]]);
        else if (src.from === "literal" && typeof src.value === "string") reads.push([label, inputNamesRead(src.value)]);
      }
    }
    for (const [field, names] of reads) {
      for (const name of names) {
        if (known.has(name)) continue;
        // One finding per (step, input), not per occurrence - a `paramsExpr`
        // reading the same input twice is one mistake with one fix.
        const key = `${id} ${name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push(
          `step "${id}".${field}: reads \`inputs.${name}\`, but this automation declares no input ` +
            `called "${name}"` +
            (known.size ? ` (it declares: ${[...known].join(", ")})` : " - it declares none at all") +
            `. Either declare it as an input, or read the value from an earlier step with ` +
            `\`outputs.<step>\`. An undeclared input is not empty at runtime - the whole ` +
            `\`inputs\` variable is missing, and the step fails before it runs.`,
        );
      }
    }
  }
  return findings;
}

/**
 * Every STEP an expression reads the output of.
 *
 * WARNING **The fourth instance of this one gap, found by running the flow the
 * third fix had just unblocked.** Execution `3rQ3IOg3sBW70KjsJFvNoD`:
 *
 *     Unable to find `csat_summary_input` used in the expression
 *       [{"input": {{ json(outputs.csat_summary_input.value) | ... }}]
 *
 * There is no step called `csat_summary_input`. A chat turn - "remove the
 * transform step, add a email step at end" - removed it and left the step that
 * read its output pointing at nothing. `remove_step` checks `dependsOn`, which
 * had already been rewired; it does not check EXPRESSIONS, and an expression is
 * where the actual read lives.
 *
 * WARNING **`dependsOn` and the expression are two different references and only one
 * was ever checked.** A step can depend on A and read B: that compiles, deploys,
 * and dies at render. So this checks the read, not the edge.
 */
const OUTPUT_REF_RE =
  /(^|[^.\w])outputs\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/**
 * Every input ONE step reads, across the expression fields it carries.
 *
 * ⚠ The mirror of `checkDeclaredInputs` and deliberately built from the same
 * `inputNamesRead`, because the two are asked opposite halves of one question:
 * that checker asks *"does the step read something nobody declared?"*, this one
 * answers *"is this declaration something the step actually reads?"* Two
 * different readers of `inputs.<name>` could disagree, and the disagreement
 * would land on a person as a refusal naming an input they can see in the step.
 *
 * ⚠ `fields` is REQUIRED for the reason stated above `checkDeclaredInputs`: a
 * default of "no fields" makes every step look like it reads nothing, and the
 * caller that forgot would silently permit every declaration.
 */
export function inputsReadBy(step: Record<string, unknown>, fields: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const field of fields) {
    const value = step[field];
    if (typeof value !== "string") continue;
    for (const name of inputNamesRead(value)) names.add(name);
  }
  // ⚠ Typed bindings read inputs too (phase 3 step 3 — the form every builder is
  // now taught). Without this, a step bound `{"from":"input","inputId":"as_of"}`
  // read NOTHING here, and chat refused every add_step that declared the input it
  // binds (chat:measure s1, 2026-09-23: 0 of 5 applied). A literal's
  // `{{ inputs.x }}` placeholder is a read as well — it is rendered.
  if (Array.isArray(step.inputs)) {
    for (const b of step.inputs as Array<{ source?: unknown }>) {
      const src = b?.source as { from?: unknown; inputId?: unknown; value?: unknown } | null | undefined;
      if (!src || typeof src !== "object") continue;
      if (src.from === "input" && typeof src.inputId === "string" && src.inputId) names.add(src.inputId);
      else if (src.from === "literal" && typeof src.value === "string") {
        for (const name of inputNamesRead(src.value)) names.add(name);
      }
    }
  }
  return names;
}

export function stepNamesRead(expr: string): string[] {
  const out = new Set<string>();
  for (const span of templateSpans(expr)) {
    for (const m of span.body.matchAll(OUTPUT_REF_RE)) {
      const name = m[2] ?? m[3];
      if (name) out.add(name);
    }
  }
  return [...out];
}

/**
 * Refuse an expression that reads a step this model does not contain.
 *
 * WARNING **Existence only, deliberately not ORDER.** "reads a step declared later"
 * is a real question and a different one - `validateModel` owns the topology,
 * and answering it here would put two definitions of what may depend on what in
 * two files. What this catches is the one the engine cannot survive at all: a
 * name with nothing behind it.
 */
export function checkStepRefs(
  steps: Array<Record<string, unknown>>,
  fields: readonly string[],
): string[] {
  const known = new Set(
    steps.map((s) => (typeof s.id === "string" ? s.id : "")).filter(Boolean),
  );
  const findings: string[] = [];
  const reported = new Set<string>();

  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of fields) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const name of stepNamesRead(value)) {
        if (known.has(name)) continue;
        const key = `${id} ${name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push(
          `step "${id}".${field}: reads \`outputs.${name}\`, but there is no step called ` +
            `"${name}" in this automation` +
            (known.size ? ` (it has: ${[...known].join(", ")})` : "") +
            `. Point it at a step that exists, or add the missing one back. A step that reads ` +
            `an absent step fails at render, before it runs - removing a step does not rewrite ` +
            `the expressions that read it.`,
        );
      }
    }
  }
  return findings;
}
