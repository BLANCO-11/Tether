/**
 * Whole-flow caps and tenant-scoped ref validation — Phase 5 task 5.2, built at
 * last because Stage 7 makes `POST /flows/generate` reachable from a browser.
 * archive/kestra-migration/progress/phase-5.md §"The validator's two jobs"
 *
 * ── What this is FOR, and it is not mainly security ──────────────────────────
 *
 * phase-5.md is explicit that framing this as a control against malicious
 * clients is a misread: *"its primary job is catching LLM error"*. That reading
 * got stronger, not weaker, in the five stages since it was written. The model
 * arriving at `writeRevision` comes from **the drafter** — "client-authored"
 * here means "LLM-authored on a client's behalf". So the findings below are
 * written to be **acted on by a model**: each names the rule, the offending
 * step, and the facts needed to fix it. `unknown ref "list-approved-leave"` with
 * the workspace's actual ref list attached costs one redraft; a bare "invalid
 * tool" costs a redraft that cannot succeed.
 *
 * ── Where the existing controls already sit, so this adds only what is missing ─
 *
 *  * **Expressions** are allowlisted in `flowService.writeRevision` — five
 *    roots, seven functions, everything else fails by name (D-22).
 *  * **Task types, the single host and block-scalar re-indentation** are
 *    structural properties of the compiler (D-16), not checks. No model can name
 *    a Kestra task type whatever it contains.
 *  * **Shape and semantics per step** — slug-shaped ids, reserved ids, cycles,
 *    retry bounds, `run(payload)` — are `flowCompiler.validateModel`.
 *
 * What none of them bound is **a flow's overall shape**. M3 caps a workspace's
 * concurrent executions and M4 its daily agent runs; nothing capped one flow's
 * step count, its container count or how long one execution may
 * hold an M3 slot. That is this file.
 *
 * ── Two caps that are deliberately NOT here, and why ─────────────────────────
 *
 * **Fan-out.** Task 5.2 lists a fan-out cap and the honest answer is that it
 * cannot be written here: a model declares a `paramsExpr`, not an item count, so
 * the number of items is not known until the expression is rendered at runtime.
 * The cap therefore already exists and already lives at the only place that can
 * see the number — `stepBatchSchema.params` in `step-execution.service.ts`, at
 * `.max(1000)`, on the route Kestra calls back into. `flow-validator.test.ts`
 * pins that bound so it cannot be widened without a failing test. Writing a
 * second, static fan-out check here would be a check that can never fire.
 *
 * **Subflow depth.** Also listed in 5.2, and there is no subflow step kind: the
 * emittable set is `datasource | transform | tool | code | agent | approval` and
 * the compiler refuses everything else by name. A depth check would iterate an
 * empty set for ever — and a test that passes over no rows reads exactly like a
 * test that passes. If a `subflow` kind is ever added, add the cap **with it**.
 */
import { checkRefOutputFields } from "./flow-ref-columns.js";
import { namesManifestRef } from "./sql-projection.js";
import { scheduleInputBlock, scheduleInputRefusal } from "./flow-schedule-inputs.js";
import { checkSqlShape } from "./datasource-query.service.js";
import {
  collectUnknownBindingSteps,
  OUTPUT_STEP_KINDS,
  unknownBindingMessage,
  type FlowModel,
  type FlowStep,
} from "./flow-compiler.service.js";
import { unresolvedRequiredInputs } from "./flow-inputs.js";
import { EMAIL_RE } from "./mail-recipients.js";
import { EXPECTABLE_KINDS } from "./flow-expectation.service.js";

/**
 * The numbers, in one object so a finding's message, a test and the docs cannot
 * drift apart. Every one of them is a resource a single flow can consume, and
 * the reason is beside it — a cap with no reason is the first thing raised when
 * a legitimate flow hits it.
 */
export const FLOW_CAPS = {
  /**
   * Also the zod bound on `flowModelSchema.steps`. Duplicated on purpose: that
   * one covers `POST /flows`, this one covers every path — an imported bundle,
   * a seed, a generated draft — because it runs inside `writeRevision`.
   */
  steps: 64,
  /** Each is a container start on the host daemon and one inference call to generate. */
  codeSteps: 16,
  /**
   * Each was a run in an external agent runtime, single-replica with an in-memory
   * `activeRuns` map. M4 bounds a WORKSPACE's daily agent runs; nothing bounded
   * one execution's, so a flow declaring 40 agent steps spends a day's budget in
   * a single run.
   */
  agentSteps: 4,
  /** Each is a person who has to be found, told and believed. */
  approvalSteps: 8,
  /**
   * The sum of every pause a single execution can sit in — the cap that actually
   * matters, because an execution holds its M3 concurrency slot for its whole
   * life, paused or not. Per-step ceilings do not compose: eight approvals at
   * the 7-day per-step maximum is a 56-day slot hold, and five such flows brick
   * a workspace through a FAIRNESS control (the I-10 shape).
   *
   * Omitted `awaitSeconds` counts at the compiler's default, not at zero —
   * `agent` 3600, `approval` 86400 — or the cap would be trivially avoided by
   * leaving the field out.
   */
  pauseBudgetSeconds: 604_800,
  /**
   * The serialised model. Per-field caps multiply: 64 steps × an 8 KB expression
   * is a 512 KB flow, and the compiled YAML is stored in Kestra's database and
   * returned by its API on every graph read.
   */
  modelBytes: 256_000,
  /**
   * One iteration's items. 100 is the migration-docs batch size
   * (`archive/kestra-migration/06-failure-triage.md`: `ForEach` width batches to
   * ~100/taskrun — the width at which the step graph stays renderable).
   *
   * No static check: an iteration declares an array source, not an item count,
   * so the number of items does not exist until it renders at runtime — the
   * same reason the fan-out cap lives in `stepBatchSchema.params`, not here.
   * Enforced at runtime when the iteration emitter lands (complexity plan
   * Phase 2); writing a static check here would be a check that can never fire.
   */
  iterationItems: 100,
  /**
   * One join's output rows. 1000 mirrors `stepBatchSchema.params`'s `.max(1000)`
   * in `step-execution.service.ts` — a join wider than the widest batch the step
   * API will accept can never be consumed downstream.
   *
   * No static check, same reason as `iterationItems`: row count is a runtime
   * fact, enforced at runtime when the join emitter lands (complexity plan
   * Phase 2).
   */
  joinOutputRows: 1000,
  /**
   * Iteration containers in one flow. 8 is a canvas/panel readability bound —
   * past it the graph no longer fits a readable layout and the readiness sheet
   * no longer fits a glance, the same person-scale budgeting as the other caps.
   *
   * No static check YET: there is no iteration container kind in the model
   * (`FlowStepKind` has no `iteration`/`loop` member), so a count today would
   * iterate an empty set for ever — the same reason there is no subflow-depth
   * check above. The check lands with the kind (complexity plan Phase 1).
   */
  iterationContainers: 8,
} as const;

/** Compiler defaults, mirrored here so the budget counts what will actually be emitted. */
const DEFAULT_AWAIT_SECONDS: Record<string, number> = { approval: 86_400 };

/**
 * One problem, written for a model to act on.
 *
 * `facts` is the part that earns its keep — it carries what the fixer does not
 * otherwise have. Same shape as `planImport`'s findings, including `blocking`,
 * so a client renders both with one component.
 */
export interface FlowFinding {
  /** Stable machine name. Never rephrased — a client may switch on it. */
  rule: string;
  stepId?: string;
  message: string;
  facts?: Record<string, unknown>;
  blocking: boolean;
}

function countKind(steps: FlowStep[], kind: string): number {
  return steps.filter((s) => s.kind === kind).length;
}

/**
 * The caps. Pure and synchronous — no workspace, no database — so it can run in
 * a test, in the compiler's own harnesses, and on a model that has not been
 * persisted.
 */
export function checkFlowShape(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  const steps = Array.isArray(model.steps) ? model.steps : [];

  if (steps.length > FLOW_CAPS.steps) {
    findings.push({
      rule: "too_many_steps",
      message:
        `this flow declares ${steps.length} steps and the cap is ${FLOW_CAPS.steps} — ` +
        `split it into flows that call each other, or aggregate related work into one step ` +
        `(a step is array-shaped, so one step can handle many items)`,
      facts: { declared: steps.length, cap: FLOW_CAPS.steps },
      blocking: true,
    });
  }

  for (const [kind, cap] of [
    ["code", FLOW_CAPS.codeSteps],
    ["approval", FLOW_CAPS.approvalSteps],
  ] as const) {
    const n = countKind(steps, kind);
    if (n > cap) {
      findings.push({
        rule: `too_many_${kind}_steps`,
        message: `this flow declares ${n} \`${kind}\` steps and the cap is ${cap}`,
        facts: {
          declared: n,
          cap,
          stepIds: steps.filter((s) => s.kind === kind).map((s) => s.id),
        },
        blocking: true,
      });
    }
  }

  const paused = steps.filter((s) => s.kind === "approval");
  const budget = paused.reduce(
    (sum, s) =>
      sum +
      ((s as { awaitSeconds?: number }).awaitSeconds ?? DEFAULT_AWAIT_SECONDS[s.kind] ?? 0),
    0,
  );
  if (budget > FLOW_CAPS.pauseBudgetSeconds) {
    findings.push({
      rule: "pause_budget_exceeded",
      message:
        `the waits in this flow total ${Math.round(budget / 3600)} hours and the cap is ` +
        `${Math.round(FLOW_CAPS.pauseBudgetSeconds / 3600)} — one execution holds a workspace ` +
        `concurrency slot for its whole life, including while paused. Shorten \`awaitSeconds\`, ` +
        `or split the flow so the wait is a separate execution.`,
      facts: {
        totalSeconds: budget,
        cap: FLOW_CAPS.pauseBudgetSeconds,
        // Named per step, with the DEFAULT made explicit: a model that left the
        // field out cannot otherwise tell which of its steps is expensive.
        waits: paused.map((s) => ({
          stepId: s.id,
          kind: s.kind,
          seconds:
            (s as { awaitSeconds?: number }).awaitSeconds ?? DEFAULT_AWAIT_SECONDS[s.kind] ?? 0,
          defaulted: (s as { awaitSeconds?: number }).awaitSeconds === undefined,
        })),
      },
      blocking: true,
    });
  }

  const bytes = Buffer.byteLength(JSON.stringify(model), "utf8");
  if (bytes > FLOW_CAPS.modelBytes) {
    findings.push({
      rule: "model_too_large",
      message:
        `this flow serialises to ${Math.round(bytes / 1024)} KB and the cap is ` +
        `${Math.round(FLOW_CAPS.modelBytes / 1024)} KB`,
      facts: { bytes, cap: FLOW_CAPS.modelBytes },
      blocking: true,
    });
  }

  return findings;
}

/**
 * Every `tool`, `datasource` and `query` ref resolves **in this workspace**.
 *
 * Pure, and takes the available names rather than fetching them, for one
 * concrete reason: `writeRevision` already computes `refFingerprints` — it needs
 * them for the staleness baseline — and a second query would be a second answer
 * to the same question, which is how a check and the row it writes come to
 * disagree.
 *
 * Until now an unknown ref was discovered at **runtime**, by
 * `invokeTool` returning a 404 mid-execution. That is late in the way that
 * costs: the steps before it have already sent mail.
 *
 * ⚠ It checks that the name resolves, and nothing about what it returns. A query
 * whose columns or units differ is invisible here, exactly as it is at import
 * (D-25) — and for the same reason: only that tenant's oracle can see it.
 */
/**
 * A declared result must exist and must actually produce something.
 *
 * ⚠ **Both halves are load-bearing and they fail differently.** A `stepId`
 * naming no step yields `null` for ever with the flow still green — the same
 * silent shape as reading a column an operation does not project. A `stepId`
 * naming an `approval` or a `branch` step yields `null` for ever too, but for a
 * reason nobody would guess from the name: gate 3 produces no value at all, and
 * a branch schedules other tasks rather than emitting one. Both are refused
 * here, with the step list and the permitted kinds in the finding, because a
 * redraft without them is a second guess.
 *
 * ── Output rows (Stage 4.5) ────────────────────────────────────────────────
 *
 * Each row's source is checked the same way: a `step`/`whole` source must name
 * a step that exists and is of a kind that produces a value (the same
 * `OUTPUT_STEP_KINDS` set, the same "green run, wrong answer" reason); an
 * `input` source must name a declared flow input; a row with no source is
 * refused rather than projected unavailable for ever; `self` has no meaning in
 * a flow-level row and is refused. A literal is always readable. Every finding
 * names the ROW, because the step list alone no longer locates the problem.
 *
 * Pure — it needs only the model, so it sits with the other shape rules rather
 * than beside the ref checks that need the workspace.
 */
export function checkFlowOutput(model: FlowModel): FlowFinding[] {
  const declared = model.output;
  if (!declared) return [];
  const steps = model.steps ?? [];
  const findings: FlowFinding[] = [];
  // Legacy single-step declaration (pre-rows revisions): unchanged, same rules,
  // same messages — stored history still validates on read.
  if (declared.stepId !== undefined) {
    const target = steps.find((s) => s.id === declared.stepId);
    if (!target) {
      findings.push({
        rule: "unknown_output_step",
        message:
          `this automation declares its result comes from step "${declared.stepId}", ` +
          `which does not exist. Its steps are: ${steps.map((s) => s.id).join(", ")}`,
        facts: { stepId: declared.stepId, steps: steps.map((s) => s.id) },
        blocking: true,
      });
    } else if (!OUTPUT_STEP_KINDS.has(target.kind)) {
      findings.push({
        rule: "output_step_produces_nothing",
        stepId: target.id,
        message:
          `step "${target.id}" is a ${target.kind} step and produces no value, so it cannot be ` +
          `this automation's result — a caller would be handed nothing, on a run that succeeded. ` +
          `Declare one of these kinds instead: ${[...OUTPUT_STEP_KINDS].join(", ")}`,
        facts: { stepId: target.id, kind: target.kind, permitted: [...OUTPUT_STEP_KINDS] },
        blocking: true,
      });
    }
  }
  const rows = declared.rows ?? [];
  const seenNames = new Set<string>();
  for (const row of rows) {
    const name = typeof row.name === "string" && row.name.length > 0 ? row.name : "(unnamed row)";
    if (seenNames.has(row.name)) {
      findings.push({
        rule: "duplicate_output_row",
        message:
          `this automation declares two output rows named "${row.name}" — a caller reading results ` +
          `by name would get one of them unpredictably. Rename one.`,
        facts: { row: row.name },
        blocking: true,
      });
      continue;
    }
    seenNames.add(row.name);
    const source = row.source;
    if (!source) {
      findings.push({
        rule: "output_row_has_no_source",
        message:
          `output row "${name}" has no source, so it would hand a caller nothing on a run that ` +
          `succeeded. Bind it to a step, an input or a literal.`,
        facts: { row: name },
        blocking: true,
      });
      continue;
    }
    if (source.from === "step" || source.from === "whole") {
      const target = steps.find((s) => s.id === source.stepId);
      if (!target) {
        findings.push({
          rule: "unknown_output_row_step",
          message:
            `output row "${name}" reads step "${source.stepId}", which does not exist. Its steps ` +
            `are: ${steps.map((s) => s.id).join(", ")}`,
          facts: { row: name, stepId: source.stepId, steps: steps.map((s) => s.id) },
          blocking: true,
        });
      } else if (!OUTPUT_STEP_KINDS.has(target.kind)) {
        findings.push({
          rule: "output_row_produces_nothing",
          stepId: target.id,
          message:
            `output row "${name}" reads step "${target.id}", which is a ${target.kind} step and ` +
            `produces no value, so the row would hand a caller nothing on a run that succeeded. ` +
            `Declare one of these kinds instead: ${[...OUTPUT_STEP_KINDS].join(", ")}`,
          facts: { row: name, stepId: target.id, kind: target.kind, permitted: [...OUTPUT_STEP_KINDS] },
          blocking: true,
        });
      }
    } else if (source.from === "input") {
      const inputs = model.inputs ?? [];
      if (!inputs.some((i) => i.id === source.inputId)) {
        findings.push({
          rule: "unknown_output_row_input",
          message:
            `output row "${name}" reads input "${source.inputId}", which this automation does not ` +
            `declare. Its inputs are: ${inputs.map((i) => i.id).join(", ") || "none"}`,
          facts: { row: name, inputId: source.inputId, inputs: inputs.map((i) => i.id) },
          blocking: true,
        });
      }
    } else if (source.from === "self") {
      findings.push({
        rule: "output_row_reads_self",
        message:
          `output row "${name}" reads "self", which has no meaning in a flow-level output row — ` +
          `there is no enclosing step. Bind it to a step, an input or a literal.`,
        facts: { row: name },
        blocking: true,
      });
    }
    // `literal` is always readable: nothing to check.
  }
  return findings;
}
/**
 * Every binding that names a step must name one that exists — the validator half
 * of `collectUnknownBindingSteps` (`flow-compiler.service.ts`).
 *
 * Flow-level output rows are SKIPPED here, not missed: `checkFlowOutput` already
 * refuses those (`unknown_output_row_step`), and a second rule on the same defect
 * would be the duplication the collector's docblock forbids. The compiler, model
 * and feeder layers keep them — they run no output check of their own.
 *
 * Blocking, and it names the available steps: the fixer is usually a model, and
 * a bare "unknown step" costs a redraft that cannot succeed (the `unknown_ref`
 * lesson above).
 */
export function checkUnknownBindingSteps(model: FlowModel): FlowFinding[] {
  const ids = (model.steps ?? []).map((s) => s.id);
  return collectUnknownBindingSteps(model)
    .filter((ref) => !ref.outputRow)
    .map((ref) => ({
      rule: "unknown_binding_step",
      ...(ref.stepId === null ? {} : { stepId: ref.stepId }),
      message: unknownBindingMessage(ref, ids),
      facts: { reader: ref.reader, stepId: ref.missingStepId, steps: ids },
      blocking: true,
    }));
}


export function checkFlowRefs(model: FlowModel, availableRefs: string[]): FlowFinding[] {
  const available = new Set(availableRefs);
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    // ── Does this step name something in the MANIFEST at all? ──────────────
    //
    // A non-calling kind does not, and neither does a STEP-LOCAL read: it
    // carries its own statement and its own datasource address, and the
    // executor runs that text rather than resolving `ref` to a stored row
    // (`runOperation`/`runNamedQuery` both branch on `frozenSql`). Requiring
    // `ref` to be registered would refuse the one shape that deliberately has
    // no registration — a read that lives in the workflow instead of in the
    // data source.
    //
    // ⚠ **ONE predicate, shared with `flowCompiler.refsOf` and
    // `flowService.writeRevision`'s `manifest_refs` record.** This used to be
    // the kind test written out here plus a separate `isStepLocalSql` skip a
    // few lines down, while the other two sites had only the kind test — so
    // this function exempted a step-local read and the PUBLISH gate refused
    // the very same flow for naming a ref `refFingerprints()` has no key for.
    // Measured: 5 of 11 flows on the running deployment could not be
    // published. `manifest-ref-agreement.test.ts` pins that the three answer
    // identically.
    //
    // ⚠ **Exempt from THIS check only, and not unchecked.**
    // `checkStepLocalSql` below covers what actually has to hold, and
    // `checkSqlShape` runs again inside the executor. Both halves are
    // required: an exemption with no replacement check is how a step ships
    // with a `$1` nothing binds.
    if (!namesManifestRef(step)) continue;
    if (available.has(step.ref)) continue;
    findings.push({
      rule: "unknown_ref",
      stepId: step.id,
      message:
        `step "${step.id}" calls "${step.ref}", which is not registered in this workspace`,
      facts: {
        ref: step.ref,
        kind: step.kind,
        // The list is the finding. Without it a redraft is a guess, and a guess
        // at a ref name is how `attendance_below_threshold` becomes
        // `presence_below_policy` — the failure class D-25 refuses to automate.
        available: [...available].sort(),
      },
      blocking: true,
    });
  }
  return findings;
}

/**
 * A flow-declared webhook/api trigger's name must be creatable under the
 * trigger API's own schema — Phase 6.
 *
 * ⚠ The resolution is **existing-or-valid-new by name SHAPE**, and no more.
 * `flowService.writeRevision` materialises a declared webhook/api trigger as a
 * `triggers` row idempotently BY NAME, so any name that satisfies
 * `createTriggerSchema` resolves — to the existing row when one already has it,
 * to a valid new row otherwise. That is why this check is pure (no workspace
 * fetch): a well-formed name cannot be "unknown", and the only unresolvable
 * declaration is one whose name the trigger schema itself would refuse. The
 * collision-with-another-flow case is `writeRevision`'s 409, not a finding this
 * check could see.
 *
 * The rule is `createTriggerSchema`'s (`trigger.service.ts`): a non-empty
 * string of at most 255 characters — the `triggers.name` varchar width. The
 * compiler's `validateModel` enforces the identical rule as a hard gate; this
 * check is the same rule in the finding vocabulary a model can act on.
 */
/**
 * The top-level keys of the first LITERAL object in a params expression, or
 * `null` when there is no literal object to read.
 *
 * ── Why this is a scanner and not a parser ───────────────────────────────────
 *
 * `paramsExpr` is not JSON. It is a Pebble expression that PRODUCES the params,
 * and D-16 emits it into the YAML verbatim. Real ones come in three shapes:
 *
 *   A  `[{"body":{{ … }},"subject":"…"}]`                         literal skeleton
 *   C  `{{ [{"body": (…), "subject": (…)}] | jq('.') | first }}`  literal in a span
 *   B  `{{ … | jq('[{sender: .a, recipients: [.b]}]') }}`         built INSIDE jq
 *
 * A and C carry their key names as quoted strings in the expression itself, so
 * they can be read without evaluating anything. B does not — its keys are jq
 * syntax inside a single-quoted program, and the object may not even have a
 * fixed key set. **Single-quoted regions are therefore skipped entirely**, which
 * is what makes B return `null` rather than a wrong answer.
 *
 * ── ⚠ `null` means "could not read", and must never read as "no keys" ────────
 *
 * The caller emits NO finding for `null`. That is the I-38 rule in the only
 * direction available here: a check that cannot see the keys has learned
 * nothing, and inventing a refusal from it would block every jq-built call in
 * the product — 5 of the 57 tool and datasource steps on this deployment,
 * including `finance-invoice-chase`'s fan-out. Allowing them is exactly what
 * already happens, so the check is a strict improvement that can refuse nothing
 * it has not actually read.
 *
 * Measured against every `paramsExpr` on this deployment (57 steps, 10 distinct
 * refs): 52 readable, 5 `null`, and the only key it did not recognise was the
 * `author` that caused the incident this check exists to prevent.
 */
export function literalParamKeys(expr: string): string[] | null {
  const n = expr.length;
  let i = 0;
  let depth = 0;
  let started = false;
  const keys: string[] = [];

  while (i < n) {
    const c = expr[i];

    // A jq program (or any single-quoted string). Its contents are another
    // language; reading keys out of it would be guessing. See the docblock.
    if (c === "'") {
      i += 1;
      while (i < n && expr[i] !== "'") i += 1;
      i += 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n && expr[j] !== '"') {
        if (expr[j] === "\\") {
          buf += expr[j + 1] ?? "";
          j += 2;
          continue;
        }
        buf += expr[j];
        j += 1;
      }
      // A string is a KEY only if the next non-space character is a colon and it
      // sits at the object's own depth — so `{"to": ["a@b"]}` yields `to` and not
      // the address, and `{"x": {"y": 1}}` yields `x` alone.
      let k = j + 1;
      while (k < n && /\s/.test(expr[k]!)) k += 1;
      if (depth === 1 && expr[k] === ":") keys.push(buf);
      i = j + 1;
      continue;
    }

    // `{{` opens a template span and `}}` closes one — neither is an object
    // brace, and counting them as one is how shape C loses its depth.
    if (c === "{") {
      if (expr[i + 1] === "{") {
        i += 2;
        continue;
      }
      depth += 1;
      started = true;
      i += 1;
      continue;
    }
    if (c === "}") {
      if (expr[i + 1] === "}") {
        i += 2;
        continue;
      }
      depth -= 1;
      if (started && depth === 0) return keys.length ? keys : null;
      i += 1;
      continue;
    }

    i += 1;
  }
  return null;
}

/**
 * `true` when a params expression PLAINLY produces a JSON object where the step
 * API requires an array, `false` when it plainly produces an array, `null` when
 * it cannot be told statically.
 *
 * ── Why this is a separate question from the key names ──────────────────────
 *
 * `stepBatchSchema.params` is `z.array(z.record(...))` — one entry per
 * invocation, shared by all three ref-calling kinds — and an empty array is
 * deliberately valid (I-09). A drafter that emits the single call's object
 * directly, `{"input": …, "instruction": …}` instead of `[{…}]`, is refused by
 * `POST /api/steps/tool` with `params: Expected array, received object`. That is
 * the same failure class as an undeclared key and it arrives at the same place:
 * after the flow has been saved, compiled, deployed and run.
 *
 * ── ⚠ `{{` is not `{` ──────────────────────────────────────────────────────
 *
 * A leading `{{` opens a template span, and what the span evaluates to is not
 * knowable here — `{{ [{…}] | jq('.') | first }}` yields the array and reads,
 * character for character, like the object case at position 0. So a span start
 * returns `null` and is not checked, which is the same "cannot see, so says
 * nothing" rule `literalParamKeys` follows.
 *
 * MEASURED against every `paramsExpr` on this deployment: 42 plainly arrays, 13
 * unreadable, 2 plainly objects — and both of those two are unrun flows carrying
 * byte-for-byte the shape that failed the run this check was written for.
 */
export function paramsPlainlyNotArray(expr: string): boolean | null {
  const t = expr.trim();
  if (t.startsWith("[")) return false;
  if (t.startsWith("{{")) return null; // a template span — see the docblock
  if (t.startsWith("{")) return true;
  return null;
}

/** The parameter interface a step's own `sql` declares, or null if it has none. */
function inlineSqlInterface(step: FlowModel["steps"][number]): { params: Array<{ name: string; required: boolean }> } | null {
  const sql = (step as { sql?: string }).sql;
  if (!sql?.trim()) return null;
  const order = (step as { sqlParamOrder?: string[] }).sqlParamOrder ?? [];
  const schema = ((step as { sqlParamsSchema?: Record<string, unknown> }).sqlParamsSchema ?? {}) as Record<string, { required?: boolean }>;
  const names = [...new Set([...order, ...Object.keys(schema)])];
  // `required` defaults TRUE: every `$n` in the SQL is bound positionally, so
  // an omitted one is a NULL the SQL was not written for.
  return { params: names.map((name) => ({ name, required: schema[name]?.required !== false })) };
}

/**
 * A `tool`, `datasource` or `query` step may only name parameters its ref
 * DECLARES, and must name the ones it requires.
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * A drafted flow called `foundry_email_send` with a fifth key, `author`, which
 * the tool does not declare. `POST /api/mail/send`'s body schema is `.strict()`,
 * so the call was refused `400 invalid_body` — after the flow had been saved,
 * compiled, deployed and run, at the last hop, having already read production
 * data and paid for an `llm_complete` call. Nothing between the drafter and the
 * wire knew the key was wrong, though the tool's own `paramsSchema` had said so
 * all along. (`author` is a real parameter — on `chat_post_message`. The
 * catalogue and the route never disagreed with each other.)
 *
 * ── Why here ────────────────────────────────────────────────────────────────
 *
 * `checkFlowRefs` above already asks "does this ref exist?" from the same
 * `refFingerprints` keys. This asks the next question — "is it being CALLED
 * correctly?" — and sits at the same chokepoint for the reason D-22's allowlist
 * and D-37's caps do: `writeRevision` is the one function every revision passes
 * through, so a new route cannot forget it, and a hand-authored model cannot
 * reach a weaker path than a generated one.
 *
 * ⚠ **`refInterfaces`, deliberately NOT `refFingerprints`** — D-25's distinction.
 * A fingerprint is a hash and answers no question about parameter names.
 *
 * ── ⚠ What it does NOT do ───────────────────────────────────────────────────
 *
 * It reads NAMES, never values or types. `{"period": 42}` where a string was
 * declared passes here: the params are an expression, so the value is not known
 * until the step runs, and a type check on an unevaluated expression would be
 * the guess this module refuses to make. Where `literalParamKeys` returns `null`
 * it reports nothing at all — a jq-built params object is not checked by this
 * and never claims to be.
 *
 * ── Why a ref with NO declared params is skipped ────────────────────────────
 *
 * An empty `paramsSchema` is ambiguous between "takes nothing" and "nobody wrote
 * the schema down", and three named queries on this deployment are the latter.
 * Refusing every call to them would turn an absent declaration into a broken
 * flow, which points the control backwards — the reason a datasource with no
 * sandbox reads production and says so rather than refusing (D-52).
 */
export function checkFlowParams(
  model: FlowModel,
  interfaces: Record<string, { params: Array<{ name: string; required: boolean }> }>,
): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") continue;
    // ⚠ The container is checked BEFORE the declarations are looked up, and
    // deliberately outside the `iface` guard below: `params` must be a list for
    // every ref-calling step, including one whose ref declares no parameters and
    // one whose ref this workspace does not have. Behind that guard the check
    // would silently skip exactly the refs nobody wrote a schema for.
    if (paramsPlainlyNotArray(step.paramsExpr ?? "")) {
      findings.push({
        rule: "params_not_array",
        stepId: step.id,
        message:
          `step "${step.id}" passes a single object to "${step.ref}", but params must be a ` +
          `LIST of parameter objects — one per call. Wrap it: [{ … }]`,
        facts: { ref: step.ref },
        blocking: true,
      });
      continue;
    }

    // ⚠ A step carrying its OWN `sql` (a generated reader) runs that SQL, not
    // the catalogue's — so its declaration is the one to check against, and the
    // catalogue does not have its ref at all. Skipping it (the old behaviour)
    // let build:measure R07 bind `period` to SQL asking for `period_start` and
    // `period_end`: nothing sent, 0 rows, a SUCCESS run.
    const iface = inlineSqlInterface(step) ?? interfaces[step.ref];
    // An unknown ref is `checkFlowRefs`'s finding; reporting it twice in two
    // vocabularies gives a redraft two problems where there is one. A ref that
    // declares nothing is skipped for the reason in the docblock above.
    if (!iface || iface.params.length === 0) continue;

    // A blank `paramsExpr` is ABSENT (`displayParams`): the call renders from
    // its typed `inputs`, whose NAMES are the parameters passed — so they are
    // checked by the same two rules, rather than not at all (phase 3 step 3).
    // An unbound (`null`) binding passes nothing, so it does not count as used.
    const typed = !step.paramsExpr?.trim() && step.inputs?.length ? step.inputs.filter((b) => b.source !== null).map((b) => b.name) : null;
    // ⚠ `[{}]` is the canonical "passes nothing", not an unreadable expression.
    // `literalParamKeys` answers null for an empty object (no keys read), which
    // skipped exactly the call that omits every required parameter —
    // build:measure r8 S1: a generated reader needing `opened_since`, called
    // with `[{}]`, read 0 rows on a SUCCESS run.
    const blank = /^\s*\[\s*\{\s*\}\s*\]\s*$/.test(step.paramsExpr ?? "");
    const used = typed ?? (blank ? [] : literalParamKeys(step.paramsExpr ?? ""));
    if (!used) continue; // could not read them — see `literalParamKeys`

    const declared = new Set(iface.params.map((p) => p.name));
    // Rendered once for both messages. `(required)` is part of it because the
    // two findings below are two halves of one question, and a model handed
    // only the names has to guess which it may omit.
    const declaredList = [...iface.params]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => (p.required ? `${p.name} (required)` : p.name))
      .join(", ");
    const unknown = [...new Set(used)].filter((k) => !declared.has(k)).sort();
    const missing = iface.params
      .filter((p) => p.required && !used.includes(p.name))
      .map((p) => p.name)
      .sort();

    if (unknown.length) {
      findings.push({
        rule: "unknown_param",
        stepId: step.id,
        message:
          `step "${step.id}" passes ${unknown.map((k) => `"${k}"`).join(", ")} to "${step.ref}", ` +
          `which does not declare ${unknown.length > 1 ? "those parameters" : "that parameter"}. ` +
          // ⚠ The declared list belongs in the MESSAGE, not only in `facts`.
          // `unknownRefs` feeds the redraft loop `f.message` and nothing else, so
          // a finding that says only "wrong" is the guess `checkFlowRefs`'s own
          // docblock refuses to make a model take. MEASURED: a real goal was
          // refused three times for passing `recipients` (which is `mail_send`'s
          // parameter) to `foundry_email_send`, never told the four names that
          // would have worked, and the next draft dropped the email step
          // altogether.
          `It declares: ${declaredList}`,
        // The declared list IS the finding, for the reason `checkFlowRefs` gives
        // about ref names: without it a redraft is a guess at a name.
        facts: { ref: step.ref, unknown, declared: [...declared].sort() },
        blocking: true,
      });
    }
    if (missing.length) {
      findings.push({
        rule: "missing_required_param",
        stepId: step.id,
        message:
          `step "${step.id}" calls "${step.ref}" without required ` +
          `${missing.length > 1 ? "parameters" : "parameter"} ${missing.map((k) => `"${k}"`).join(", ")}. ` +
          `It declares: ${declaredList}`,
        facts: { ref: step.ref, missing, declared: [...declared].sort() },
        blocking: true,
      });
    }
  }
  return findings;
}

export function checkFlowTriggers(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  const MAX_NAME = 255;
  // ⚠ `webhook` retired 2026-09-08 — no longer declarable, nothing to check.
  for (const [type, decl] of [["api", model.api]] as const) {
    if (!decl) continue;
    const name: unknown = decl.name;
    if (typeof name === "string" && name.length >= 1 && name.length <= MAX_NAME) continue;
    findings.push({
      rule: "invalid_trigger_name",
      message:
        `the declared \`${type}\` trigger name ` +
        `${typeof name === "string" ? JSON.stringify(name) : String(name)} is not a valid trigger ` +
        `name — it must be a non-empty string of at most ${MAX_NAME} characters, the same rule ` +
        `the trigger API enforces`,
      facts: { type, name: name ?? null, min: 1, max: MAX_NAME },
      blocking: true,
    });
  }
  return findings;
}

/**
 * An unattended flow's required inputs must resolve at run creation — the
 * autonomous-readiness check (approval enforces it too; this surfaces it in
 * the draft so the author sees it BEFORE trying to arm).
 *
 * A schedule fires with NO caller. A required input with no `defaults` has no
 * value source at that moment: Kestra refuses to create the run at 09:00 — a
 * guaranteed failure deployed in advance. The fix is a default expression
 * evaluated at run creation (proven on the live stack:
 * `{{ execution.startDate | date('yyyy-MM') }}` resolves the current month
 * with no caller) or computing the value in a step (the derived pattern —
 * declare no input at all and bind downstream steps to `outputs.<step>`).
 * A webhook is the other unattended case. Its public body is audit data, not a
 * trusted execution-input channel, so required values must likewise come from
 * defaults. Authenticated API and on-demand runs may supply inputs per call.
 *
 * Non-blocking in the validator on purpose: a draft may legitimately be
 * mid-authoring (the input is declared, the default not yet). The APPROVAL
 * gate is the blocking one — it fires before any schedule or webhook goes live.
 */
export function checkFlowInputResolution(model: FlowModel): FlowFinding[] {
  /**
   * ⚠ **ONLY `schedule` NOW, and the webhook half is GONE rather than left
   * unreachable.** A schedule fires with no caller, so a required input with no
   * default can never be supplied — that is the whole rule. The webhook arm
   * existed because a webhook's body is untrusted and never became execution
   * input, so a webhook flow with an unresolvable input was guaranteed to fail
   * on every call. `webhook` is retired (2026-09-08) and its receiver refuses,
   * so there is no such flow to warn about.
   *
   * ⚠ It deliberately does NOT extend to `api`. An api call CARRIES its inputs
   * in a body that is type-checked against the declared inputs before anything
   * is written, so "no default" is not a defect there — it means the caller
   * supplies it, which is the normal case. Warning about it would be a guard
   * that fires on every correct api flow (I-62).
   */
  /**
   * ⚠ **THE MESSAGE AND THE CONDITION COME FROM `flow-schedule-inputs.ts`, and
   * they used to be written out twice.** This warning and the approval gate's
   * refusal are the same rule at two moments — a draft mid-authoring and a
   * flow about to go live — and they carried two copies of one sentence. When
   * the refusal learned to distinguish an input a step READS from one nothing
   * reads, this copy would have gone on advising a person to invent a default
   * for a dead declaration, at exactly the moment they could still have removed
   * it cheaply. D-197: one rule, one wording, two moments.
   */
  const message = scheduleInputRefusal(model);
  if (!message) return [];
  const { wanted, unread } = scheduleInputBlock(model);
  return [
    {
      // ⚠ The `webhook_input_unresolvable` rule is GONE with the type, not left
      // behind an always-false flag. A branch that cannot be taken reads as a
      // second case somebody still has to think about.
      rule: "scheduled_input_unresolvable",
      message,
      // ⚠ `inputs` keeps meaning every blocked input, so any existing reader is
      // unchanged; `unreadInputs` is additive and names the subset a person can
      // fix by deleting rather than by inventing a value.
      facts: { inputs: [...wanted, ...unread], unreadInputs: unread },
      blocking: false,
    },
  ];
}

/**
 * Every expectation names a step that exists, of a kind whose output can be
 * read — archive/GAPS.md §2.3.
 *
 * ⚠ This is the check that stops an expectation from being decorative. Without
 * it, `stepId: "sned_emails"` is accepted, deployed and armed, and surfaces
 * months later as a single `unevaluable` row nobody is looking at — a claim that
 * is on screen, in the bundle and in the gate, and tests nothing. I-38: a
 * control that cannot fail is worse than none, and a typo is how one gets built
 * by accident.
 *
 * Blocking, and it names the available steps: the fixer is usually a model, and
 * a bare "unknown step" costs a redraft that cannot succeed (the `unknown_ref`
 * lesson above).
 */
export function checkFlowExpectations(model: FlowModel): FlowFinding[] {
  const raw = model.expectations;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const findings: FlowFinding[] = [];
  const byId = new Map((model.steps ?? []).map((s) => [s.id, s]));
  const seen = new Set<string>();

  for (const e of raw as Array<{ id?: unknown; stepId?: unknown }>) {
    const id = typeof e?.id === "string" ? e.id : "<unnamed>";
    const stepId = typeof e?.stepId === "string" ? e.stepId : "";

    if (seen.has(id)) {
      // Result rows are keyed on (run, expectation id). Two claims sharing one
      // id means one of them silently has no verdict — and which one depends on
      // insert order.
      findings.push({
        rule: "duplicate_expectation_id",
        message: `two expectations are both called "${id}"; each needs its own name`,
        facts: { id },
        blocking: true,
      });
    }
    seen.add(id);

    const step = byId.get(stepId);
    if (!step) {
      findings.push({
        rule: "expectation_unknown_step",
        message: `expectation "${id}" checks step "${stepId}", which this flow does not declare`,
        facts: { expectation: id, stepId, steps: [...byId.keys()] },
        blocking: true,
      });
      continue;
    }
    if (!EXPECTABLE_KINDS.has(step.kind)) {
      findings.push({
        rule: "expectation_unreadable_kind",
        message:
          `expectation "${id}" checks step "${stepId}", which is an \`${step.kind}\` step — ` +
          `only ${[...EXPECTABLE_KINDS].sort().join(", ")} steps produce output an expectation ` +
          `can read`,
        facts: {
          expectation: id,
          stepId,
          kind: step.kind,
          readable: (model.steps ?? [])
            .filter((s) => EXPECTABLE_KINDS.has(s.kind))
            .map((s) => s.id),
        },
        blocking: true,
      });
    }
  }
  return findings;
}

/**
 * Wave 1 (Stage 4.1) — an `llm` step names a model this deployment serves.
 *
 * The deployment's configured provider (`generation-provider.service.ts`)
 * holds `defaultModel`/`allowedModels`; `writeRevision` passes the latter in.
 * Three refusals, each naming the step: no model at all, no model configured
 * anywhere (the empty-catalogue contingency — the step cannot run, so it
 * cannot save), and a name outside the configured set. All blocking: a model
 * id the gateway does not serve fails the run after the steps before it.
 */
export function checkLlmModels(model: FlowModel, allowedModels: readonly string[] = []): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "llm") continue;
    const name = step.model?.trim() ?? "";
    if (!name) {
      findings.push({
        rule: "llm_missing_model",
        stepId: step.id,
        message:
          `step "${step.id}" is an \`llm\` step and names no model — ` +
          `pick one from the workspace catalogue`,
        facts: { stepId: step.id },
        blocking: true,
      });
      continue;
    }
    if (allowedModels.length === 0) {
      findings.push({
        rule: "llm_no_model_configured",
        stepId: step.id,
        message:
          `step "${step.id}" names model "${name}", but no model is configured for this ` +
          `deployment — set one on the AI model page`,
        facts: { stepId: step.id, model: name },
        blocking: true,
      });
      continue;
    }
    if (!allowedModels.includes(name)) {
      findings.push({
        rule: "unknown_llm_model",
        stepId: step.id,
        message:
          `step "${step.id}" names model "${name}", which is not configured for this ` +
          `deployment — available: ${allowedModels.join(", ")}`,
        facts: { stepId: step.id, model: name, available: [...allowedModels] },
        blocking: true,
      });
    }
  }
  return findings;
}

/**
 * Wave 1 (Stage 4.2) — an `http` step carries no credential and has a target.
 *
 * `auth.secretRef` names an environment variable; the VALUE is read server-side
 * when Foundry dials and never logged (constitution article VIII). A literal
 * token anywhere in the stored step — a header or query value, the body, or the
 * ref itself — is refused naming the FIELD, never the value: the message is
 * stored and rendered, so echoing the secret would be the leak this refuses.
 * Only `^`-anchored token shapes are matched, so prose mentioning a token kind
 * mid-sentence is not a refusal. All blocking: a secret in the model travels to
 * Kestra's database inside the compiled YAML.
 */
const TOKEN_RES = [
  /^sk-[A-Za-z0-9]/,
  /^gh[opsu]_/,
  /^xox[bpas]-/,
  /^AKIA[0-9A-Z]/,
  /^eyJ[A-Za-z0-9_-]{8,}/,
  /^(Bearer|Basic|Token)\s+\S/i,
  /glpat-/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY/,
];

/** An env-var NAME, which is all `auth.secretRef` may ever hold. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function checkHttpSteps(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "http") continue;
    if (!step.url?.trim()) {
      findings.push({
        rule: "http_missing_url",
        stepId: step.id,
        message: `http step "${step.id}" has no url — there is nothing to dial`,
        facts: { stepId: step.id },
        blocking: true,
      });
    }
    const candidates: Array<{ field: string; value: unknown }> = [
      ...step.headers.map((h, i) => ({ field: `headers[${i}].value`, value: h.value })),
      ...step.queryParams.map((q, i) => ({ field: `queryParams[${i}].value`, value: q.value })),
      { field: "body.content", value: step.body.content },
      ...(step.auth.secretRef ? [{ field: "auth.secretRef", value: step.auth.secretRef }] : []),
    ];
    for (const { field, value } of candidates) {
      if (typeof value !== "string" || !value) continue;
      if (field === "auth.secretRef" && !ENV_NAME_RE.test(value)) {
        findings.push({
          rule: "http_literal_secret",
          stepId: step.id,
          message:
            `http step "${step.id}" stores "${field}", which is not an environment variable ` +
            `name — that field names where the secret lives, never the secret itself. ` +
            `The value is read server-side when Tether dials and never logged`,
          facts: { stepId: step.id, field },
          blocking: true,
        });
        continue;
      }
      if (TOKEN_RES.some((re) => re.test(value))) {
        findings.push({
          rule: "http_literal_secret",
          stepId: step.id,
          message:
            `http step "${step.id}" stores what looks like a literal credential in ` +
            `"${field}" — credentials live in environment variables named by ` +
            `\`auth.secretRef\`, never in the step. The value is read server-side ` +
            `when Tether dials and never logged`,
          facts: { stepId: step.id, field },
          blocking: true,
        });
      }
    }
  }
  return findings;
}

/**
 * Literal addresses on mail steps must be shaped like addresses.
 *
 * Measured 2026-09-14: a prod flow carried `sender: "HR Compliance"` on
 * `mail_send_template` — a display name where an address belongs. It passed
 * every authoring check and died ×10 at the run, one 422 per batch item. The
 * run-time refusal is correct and stays; this is the authoring-time net under
 * it, in the same family as `checkHttpSteps`.
 *
 * ── What is read, and what is deliberately not ─────────────────────────────
 *
 * Only a paramsExpr that parses as plain JSON is inspected — one call object
 * or an array of them. A `{{…}}` template span, a jq program, a non-string
 * value: all skipped under the same "cannot see, so says nothing" rule
 * `literalParamKeys` follows. Reading addresses out of a jq source would be
 * guessing (its keys are unquoted), so jq-built literals escape this check
 * and remain the run-time refusal's business.
 *
 * Only steps whose ref names mail are inspected (`mail_send`,
 * `mail_send_template`, `foundry_email_send`, `test_email_send`), and channel
 * tools (`chat_post_message` and friends) are excluded — they address
 * channels, not mailboxes, and a `to` there means something else.
 */
const MAIL_REF_RE = /mail|email/i;
const CHANNEL_REF_RE = /chat|slack|teams|page|channel/i;
const ADDRESS_FIELDS = ["sender", "recipients", "to", "cc"] as const;
/**
 * Is `field` of a call to `ref` an ADDRESS by this check's rule? Exported so the checker's signature types those ports
 * `Address` by the SAME rule (compiled-builder I-284): before, the signature said `Text` and this check refused a non-address,
 * so a value both layers had to judge was legal to one and refused by the other.
 */
export function mailAddressField(ref: string, field: string): boolean {
  return MAIL_REF_RE.test(ref) && !CHANNEL_REF_RE.test(ref) && (ADDRESS_FIELDS as readonly string[]).includes(field);
}

export function checkMailAddressSteps(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "tool") continue;
    const ref = step.ref ?? "";
    if (!MAIL_REF_RE.test(ref) || CHANNEL_REF_RE.test(ref)) continue;
    let calls: unknown;
    if (!step.paramsExpr?.trim() && step.inputs?.length) {
      // Typed bindings (phase 3 step 3): the literal address bindings ARE the
      // call's address fields — without this a typed mail step escaped the check.
      const call: Record<string, string> = {};
      for (const b of step.inputs) {
        const src = b.source as { from?: string; value?: unknown } | null;
        if (src?.from === "literal" && typeof src.value === "string" && (ADDRESS_FIELDS as readonly string[]).includes(b.name)) call[b.name] = src.value;
      }
      calls = [call];
    } else {
      try {
        calls = JSON.parse(step.paramsExpr ?? "");
      } catch {
        continue;
      }
    }
    const list = Array.isArray(calls) ? calls : [calls];
    for (const call of list) {
      if (!call || typeof call !== "object") continue;
      for (const field of ADDRESS_FIELDS) {
        const v = (call as Record<string, unknown>)[field];
        if (v === undefined) continue;
        const values =
          typeof v === "string" ? [v]
          : Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v
          : null;
        if (!values) continue;
        for (const raw of values) {
          const addr = raw.trim();
          if (!addr || addr.includes("{{")) continue;
          if (!EMAIL_RE.test(addr)) {
            findings.push({
              rule: "mail_invalid_address",
              stepId: step.id,
              message:
                `step "${step.id}" passes "${addr}" as "${field}" to "${ref}" — that is not an address. ` +
                `Pass an address like ops@example.com, never a display name.`,
              facts: { stepId: step.id, ref, field },
              blocking: true,
            });
          }
        }
      }
    }
  }
  return findings;
}

const FLAT_ATTACH_KEYS = ["attach_rows", "attach_name", "attach_format"] as const;

function flatAttachFromCall(call: Record<string, unknown>): { rows?: unknown; name?: unknown; format?: unknown } {
  const out: { rows?: unknown; name?: unknown; format?: unknown } = {};
  for (const k of FLAT_ATTACH_KEYS) {
    const v = call[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k === "attach_rows" ? "rows" : k === "attach_name" ? "name" : "format"] = v;
  }
  return out;
}

function flatAttachFromStep(step: { paramsExpr?: string; inputs?: Array<{ name: string; source?: unknown }> }): {
  rows?: unknown;
  name?: unknown;
  format?: unknown;
} | null {
  if (step.inputs?.length) {
    const out: { rows?: unknown; name?: unknown; format?: unknown } = {};
    for (const b of step.inputs) {
      const src = b.source as { from?: string; value?: unknown; stepId?: string } | null;
      if (!src) continue;
      // Engine bind stores a step's WHOLE output as `from: "whole"` (and the text form as
      // `transform: "text"`). `toStored` turns the op's `from: "text"` into that shape — so a
      // check that only names `step`/`literal`/`expression` treats a correctly-bound
      // `attach_rows` as missing while `attach_name`/`attach_format` literals still count, and
      // refuses the save with "without attach_rows". Measured 2026-10-07 on a builder complete
      // that had already bound `attach_rows ← read_1 as text`.
      if (
        b.name === "attach_rows" &&
        (src.from === "step" ||
          src.from === "literal" ||
          src.from === "expression" ||
          src.from === "whole" ||
          src.from === "text")
      ) {
        out.rows = src;
      }
      if (b.name === "attach_name" && src.from === "literal") out.name = src.value;
      if (b.name === "attach_format" && src.from === "literal") out.format = src.value;
    }
    if (out.rows !== undefined || out.name !== undefined || out.format !== undefined) return out;
  }
  if (!step.paramsExpr?.trim()) return null;
  try {
    const parsed = JSON.parse(step.paramsExpr) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const merged: { rows?: unknown; name?: unknown; format?: unknown } = {};
    for (const call of list) {
      if (!call || typeof call !== "object") continue;
      const part = flatAttachFromCall(call as Record<string, unknown>);
      if (part.rows !== undefined) merged.rows = part.rows;
      if (part.name !== undefined) merged.name = part.name;
      if (part.format !== undefined) merged.format = part.format;
    }
    if (merged.rows === undefined && merged.name === undefined && merged.format === undefined) return null;
    return merged;
  } catch {
    return null;
  }
}

/**
 * Refuse a mail step saved with half of the flat attachment triple — same rules as `foldFlatAttachment` at send time.
 */
export function checkMailFlatAttachments(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "tool") continue;
    const ref = step.ref ?? "";
    if (!MAIL_REF_RE.test(ref) || CHANNEL_REF_RE.test(ref)) continue;
    const flat = flatAttachFromStep(step);
    if (!flat) continue;
    const hasRows = flat.rows !== undefined;
    const hasName = flat.name !== undefined && String(flat.name).trim() !== "";
    const hasFormat = flat.format !== undefined && String(flat.format).trim() !== "";
    if (!hasRows && !hasName && !hasFormat) continue;
    if (hasRows && !hasName) {
      findings.push({
        rule: "mail_flat_attachment",
        stepId: step.id,
        message:
          `step "${step.id}" binds attach_rows to "${ref}" without attach_name — the run refuses the mail. ` +
          `Name the file (attach_name) and state attach_format csv or xlsx.`,
        facts: { stepId: step.id, ref },
        blocking: true,
      });
    } else if (hasRows && !hasFormat) {
      findings.push({
        rule: "mail_flat_attachment",
        stepId: step.id,
        message:
          `step "${step.id}" binds attach_rows to "${ref}" without attach_format — the run refuses the mail. ` +
          `Pass attach_format csv or xlsx, or end attach_name in .csv or .xlsx.`,
        facts: { stepId: step.id, ref },
        blocking: true,
      });
    } else if (!hasRows && (hasName || hasFormat)) {
      findings.push({
        rule: "mail_flat_attachment",
        stepId: step.id,
        message:
          `step "${step.id}" passes attach_name or attach_format to "${ref}" without attach_rows — ` +
          `a generated file needs the rows to build it from.`,
        facts: { stepId: step.id, ref },
        blocking: true,
      });
    }
  }
  return findings;
}

/**
 * A `@json` inside an already-quoted span double-encodes — always fatal.
 *
 * Measured 2026-09-14: a prod `foundry_email_send` step carried
 * `"body": "{{ … | jq('.text | @json') | first }}"`. `@json` emits the value
 * WITH its quotes, and the span sits inside quotes of its own, so Kestra
 * rendered `"body": ""# …""` and its Jackson parse died with
 * `Unexpected character '#': was expecting comma` — before Foundry was ever
 * reached. The two valid forms are quoted-span-with-raw-text and
 * unquoted-span-with-`@json`; one quoting, never both.
 *
 * Static and narrow: on a ref-calling step (tool/datasource/query — every
 * callback body is raw JSON), a `"{{ … }}"` span whose inner text names
 * `@json` in verbatim text, or any `@json` span in a typed literal the
 * emitter stringifies whole. Anything else is skipped, never guessed at.
 */
const QUOTED_JSON_FILTER_RE = /"\{\{[^"]*?@json[^"]*?\}\}"/;
// A span anywhere inside a value the emitter stringifies whole (typed
// literals): the whole value renders quoted, so any `@json` span inside it
// double-encodes. No quote requirement — the value never splices raw.
const ANY_JSON_FILTER_RE = /\{\{[\s\S]*?@json[\s\S]*?\}\}/;

export function checkDoubleEncodedJson(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") continue;
    // Every textual surface the emitter reads: the legacy display string AND
    // the typed rows normalisation upgrades it into. The `inputs` path
    // (`buildSingleParams`) JSON-stringifies literal templates whole — it does
    // NOT raw-splice single spans the way the `params`-record path
    // (`renderCallRows`) does — so a quoted `@json` span breaks identically
    // from either surface, and scanning only the display misses the common
    // save path (normalisation drops the display before validation runs).
    // Verbatim text embeds spans in JSON: only a QUOTED span double-encodes
    // (an unquoted `@json` span is the valid form). Typed literals stringify
    // whole at emit (`buildSingleParams`), so ANY `@json` span inside one
    // renders quoted — flag all of those. Expression templates follow the
    // verbatim rule (single spans raw-splice, the rest embeds as written).
    const verbatim: string[] = [];
    if (step.paramsExpr) verbatim.push(step.paramsExpr);
    const typed: string[] = [];
    for (const b of step.inputs ?? []) {
      const s = b?.source;
      if (s?.from === "literal") typed.push(s.value);
    }
    for (const v of Object.values(step.params ?? {})) {
      if (v.source.kind === "fixed") typed.push(v.source.value);
      else if (v.source.kind === "expression") verbatim.push(v.source.template);
    }
    const bad =
      verbatim.some((c) => QUOTED_JSON_FILTER_RE.test(c)) ||
      typed.some((c) => ANY_JSON_FILTER_RE.test(c));
    if (bad) {
      findings.push({
        rule: "json_double_encoded",
        stepId: step.id,
        message:
          `step "${step.id}" puts \`@json\` inside an already-quoted "{{ … }}" span — the value arrives ` +
          `with two sets of quotes and the run dies parsing it. Quote the span and pass raw text, ` +
          `or unquote the span and let \`@json\` do the quoting — one quoting, not both.`,
        facts: { stepId: step.id, ref: step.ref },
        blocking: true,
      });
    }
  }
  return findings;
}

/**
 * **A step-local statement, checked at SAVE instead of at execution.**
 *
 * `runSqlBatch` already runs `checkSqlShape` on every execution, and that is the
 * control — it refuses a write or a multi-statement wherever the text came from.
 * But an execution-time refusal arrives after the revision was approved and, for
 * an armed flow, at 03:00. These findings move the same answers to the one place
 * they cost nothing, which is the argument `checkFlowParams` already makes.
 *
 * ⚠ **The placeholder rule is the one that earned this.** With no stored reader
 * there is no `paramOrder`, so a statement carrying `$1` and no
 * `sqlParamOrder` fails EVERY execution with `placeholder_mismatch` — measured,
 * and invisible until the run. Declaring the order is what makes a step-local
 * read able to take a parameter at all; interpolating the value into the text
 * instead is SQL injection, which is why there is no third option.
 */
export function checkStepLocalSql(model: FlowModel): FlowFinding[] {
  const findings: FlowFinding[] = [];
  for (const step of model.steps ?? []) {
    if (step.kind !== "datasource" && step.kind !== "query") continue;
    const sql = step.sql?.trim();
    const dsRef = step.datasourceRef?.trim();

    if (sql && !dsRef) {
      findings.push({
        rule: "step_sql_without_datasource",
        stepId: step.id,
        message:
          `step "${step.id}" carries its own SQL but names no datasource. Set ` +
          `\`datasourceRef\` to the datasource it reads — without it the executor has ` +
          `no registered ref to resolve one from.`,
        facts: { stepId: step.id },
        blocking: true,
      });
    }
    if (!sql && (step.sqlParamOrder?.length || step.sqlParamsSchema)) {
      findings.push({
        rule: "step_sql_binding_without_sql",
        stepId: step.id,
        message:
          `step "${step.id}" declares a parameter binding but carries no SQL. A stored ` +
          `reader supplies its own binding, so this one would be ignored.`,
        facts: { stepId: step.id },
        blocking: true,
      });
    }
    if (!sql) continue;

    // The SAME function the executor runs, with the SAME inputs it will see.
    // Not a second implementation of the rules — a second CALL SITE, earlier.
    for (const problem of checkSqlShape(sql, step.sqlParamOrder ?? [], step.sqlParamsSchema ?? {})) {
      findings.push({
        rule: "step_sql_shape",
        stepId: step.id,
        message: `step "${step.id}" SQL is refused: ${problem.message}`,
        facts: { stepId: step.id, code: problem.code },
        blocking: true,
      });
    }
  }
  return findings;
}

/** An error that carries its findings, so a route can hand them back intact. */
export class FlowValidationError extends Error {
  readonly statusCode = 400;
  constructor(readonly findings: FlowFinding[]) {
    super(findings.map((f) => f.message).join(" · "));
    this.name = "FlowValidationError";
  }
}

export const flowValidator = {
  FLOW_CAPS,
  checkFlowShape,
  checkFlowRefs,
  checkFlowParams,
  literalParamKeys,
  paramsPlainlyNotArray,
  checkFlowTriggers,
  checkFlowExpectations,
  checkFlowInputResolution,
  checkUnknownBindingSteps,
  checkFlowOutput,
  checkLlmModels,
  checkHttpSteps,
  checkMailAddressSteps,
  checkDoubleEncodedJson,
  checkStepLocalSql,
  /**
   * Both checks, throwing on any blocking finding.
   *
   * One call site — `flowService.writeRevision` — for the same reason D-22's
   * expression check has one: it is the single function every revision passes
   * through, whoever authored the model and however it arrived. A new route
   * cannot forget it.
   */
  assertValid(
    model: FlowModel,
    availableRefs: string[],
    /**
     * Per-ref call signatures for `checkFlowParams`. Optional so the harnesses
     * and tests that assert the pure shape rules keep working unchanged; the one
     * production call site (`writeRevision`) always passes them, and a test
     * reads that call site to make sure it still does. Omitting them skips the
     * param check rather than failing it — the same "cannot see, so says
     * nothing" rule `literalParamKeys` follows.
     */
    interfaces: Record<
      string,
      { params: Array<{ name: string; required: boolean }>; columns?: string[] }
    > = {},
    /**
     * The deployment's configured models, for `checkLlmModels`. Optional so the
     * shape-rule tests keep working unchanged; the one production call site
     * (`writeRevision`) always passes the provider's list. Omitting it means an
     * `llm` step is judged with no catalogue — empty-model still refused, and a
     * named model refused as unconfigured, which is the honest answer when the
     * caller cannot see the deployment.
     */
    allowedModels: readonly string[] = [],
  ): void {
    const findings = [
      ...checkFlowShape(model),
      ...checkFlowRefs(model, availableRefs),
      ...checkStepLocalSql(model),
      ...checkFlowParams(model, interfaces),
      // The mirror of `checkFlowParams`: that one asks whether a ref is CALLED
      // correctly, this one whether its OUTPUT is read correctly. Same
      // chokepoint, same `refInterfaces` source, same "no interface ⇒ no
      // finding" rule. See `flow-ref-columns.ts` for why an operation's columns
      // are knowable exactly where a tool's and a named query's are not.
      ...checkRefOutputFields(model, interfaces),
      ...checkFlowTriggers(model),
      ...checkFlowInputResolution(model),
      ...checkUnknownBindingSteps(model),
      ...checkFlowOutput(model),
      // Wave 1 component refusals — each names the step, all blocking.
      ...checkLlmModels(model, allowedModels),
      ...checkHttpSteps(model),
      ...checkMailAddressSteps(model),
      ...checkMailFlatAttachments(model),
      ...checkDoubleEncodedJson(model),
    ];
    if (findings.some((f) => f.blocking)) throw new FlowValidationError(findings);
  },
};
