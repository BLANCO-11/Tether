/**
 * THE FLOW'S RESULT, as a caller receives it — 2026-09-08.
 *
 * ── What was wrong, measured at the wire ────────────────────────────────────
 *
 * Nothing anywhere said which step held a flow's answer. `FOUNDRY_EMITS` has no
 * `core.output.OutputValues`, so the compiled YAML declares no outputs; firing a
 * trigger answers `202 {fireId, started, error}`. Getting a result therefore
 * meant: fire → list the trigger's fires → match `fireId` → `flowExecutionId` →
 * poll `GET …/flow-executions/:id` → pluck `steps[i].output.value` by a step id
 * hardcoded in the integration. Rename the step and it breaks silently.
 *
 * `FlowModel.output` names the step. This projects it.
 *
 * ── Output rows (Stage 4.5) ──────────────────────────────────────────────────
 *
 * `FlowModel.output.rows` declares what the automation RETURNS as a list of
 * named rows, each reading one `Source` — a step's output, a flow input, or a
 * literal. `flowResultOf` projects every row: `value` is the name-to-value map
 * and `rows` carries the per-row detail, so a caller reads names, never step
 * ids. A pre-rows revision carrying the legacy `stepId` projects exactly as
 * before (that path is unchanged below); a flow declaring neither gets the
 * same "nobody has declared one" answer it always did.
 *
 * ── ⚠ THE HONESTY RULES, WHICH ARE THE WHOLE MODULE ─────────────────────────
 *
 * `available: false` is a FIRST-CLASS answer and never renders as `value: null`
 * with no explanation. There are four distinct ways to have no result and they
 * need four different sentences, because they need four different fixes:
 *
 *   the declared step is not in this run   the run predates the declaration
 *   the step never reached success         look at the step, not the result
 *   the output could not be read           the engine holds something odd
 *   the flow declares no result at all     nobody has said what the answer is
 *
 * Collapsing those into "no result" is D-66's ranking violated: *"I could not
 * find out"* and *"there is nothing"* are different states. A caller that
 * cannot tell them apart retries the wrong one.
 *
 * ⚠ **`failed > 0` does NOT make a result unavailable.** A `tool` step that sent
 * 7 of 10 emails has a real, readable answer AND a real failure; reporting only
 * the value hides the failure, and refusing the value hides the answer. Both
 * travel.
 *
 * ⚠ **This reads the REDACTED view and must keep doing so.** The step outputs it
 * projects have already been through `redactOutputs`; reading Kestra directly to
 * get a "cleaner" value would put the execution token and every tool credential
 * on a route a tenant can poll. Same rule as `flow-expectation.service.ts`, and
 * for the same reason — this is a projection of an existing read, not a new one.
 *
 * ⚠ **It never guesses which step is the answer.** No "last step", no "the only
 * transform". A flow with no `output` gets `available: false` and a sentence
 * saying nobody has declared one — because a guess that happens to be right on
 * a two-step flow is wrong the first time somebody adds a notification at the
 * end, and it would be wrong *silently*.
 */

/**
 * One declared output row, projected. A row is unavailable on its own terms —
 * the step did not run, the input was not supplied, the source was never bound —
 * and says so, so one missing row does not take the readable ones with it.
 */
export interface FlowResultRowView {
  /** The row's declared name — the key it occupies in `FlowResultView.value`. */
  name: string;
  /** The row's declared type, when the declaration named one. */
  type: string | null;
  /** The step read, for `step`/`whole` sources. Null for inputs and literals. */
  stepId: string | null;
  /** That step's kind, when it is present in this run. */
  kind: string | null;
  available: boolean;
  /** Never null when `available` is false; always null when it is true. */
  unavailableReason: string | null;
  /** The row's payload. Null when the row is unavailable. */
  value: unknown;
}

export interface FlowResultView {
  /** The step declared as the answer, or `null` when the flow declares none or declares rows. */
  stepId: string | null;
  /** What the result IS, in a person's words. From `FlowModel.output`. */
  description: string | null;
  /** The declared step's kind, when it is present in this run. */
  kind: string | null;
  available: boolean;
  /** Never null when `available` is false; always null when it is true. */
  unavailableReason: string | null;
  /**
   * The payload. For a legacy single-step declaration this is that step's
   * value — for `tool`/`datasource`/`query` the rows (`results[].data`, NOT
   * Foundry's envelope, because the envelope is transport) and for
   * `transform`/`code`/`merge` the step's own value. For a rows declaration
   * it is the name-to-value map, one entry per declared row.
   */
  value: unknown;
  /** Envelope counts, when the step produced one. Null for the other kinds. */
  succeeded: number | null;
  failed: number | null;
  warnings: string[] | null;
  /** The per-row projection, for a rows declaration. Null for the legacy shape. */
  rows: FlowResultRowView[] | null;
}

/** The five envelope keys `POST /api/steps/{tool,datasource}` answers with. */
interface StepEnvelope {
  results?: Array<{ ok?: boolean; data?: unknown; error?: unknown }>;
  succeeded?: number;
  failed?: number;
  warnings?: string[];
}

/** One step as the redacted execution view carries it. */
export interface ResultStepInput {
  stepId: string;
  kind?: string | null;
  status?: string | null;
  output?: { body?: string; value?: string; [k: string]: unknown } | null;
}

function parseMaybeJson(raw: unknown): { ok: boolean; value: unknown } {
  if (typeof raw !== "string") return { ok: raw !== undefined, value: raw ?? null };
  const t = raw.trim();
  if (t === "") return { ok: false, value: null };
  if (!/^[[{"]|^-?\d|^true$|^false$|^null$/.test(t)) return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    // Not JSON after all — a model's prose, a plain string. That is a real
    // value, so it is returned as-is rather than reported unreadable.
    return { ok: true, value: raw };
  }
}

function isEnvelope(v: unknown): v is StepEnvelope {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Array.isArray((v as StepEnvelope).results)
  );
}

const none = (reason: string, stepId: string | null, description: string | null): FlowResultView => ({
  stepId,
  description,
  kind: null,
  available: false,
  unavailableReason: reason,
  value: null,
  succeeded: null,
  failed: null,
  warnings: null,
  rows: null,
});

/**
 * A step's output through the redacted view: an envelope (tool, datasource,
 * query), a plain value (transform, code, merge), or unreadable. Both already
 * redacted by the view.
 */
function stepPayload(
  step: ResultStepInput,
): { kind: "envelope"; env: StepEnvelope } | { kind: "value"; value: unknown } | { kind: "unreadable" } {
  // `value` for a native task (transform, code, merge), `body` for an http one
  // (tool, datasource, query).
  const parsed = parseMaybeJson(step.output?.value ?? step.output?.body);
  if (!parsed.ok) return { kind: "unreadable" };
  if (isEnvelope(parsed.value)) return { kind: "envelope", env: parsed.value };
  return { kind: "value", value: parsed.value };
}

/**
 * An envelope's payload: one call ⇒ the payload itself; a fan-out ⇒ one entry
 * per call, so a caller can tell 1 row from 1 batch of 1 without inspecting
 * lengths.
 */
function envelopeValue(env: StepEnvelope): unknown {
  const rows = (env.results ?? []).map((r) => r.data);
  return rows.length === 1 ? rows[0] : rows;
}

function rowNone(name: string, reason: string, type: string | null, stepId: string | null): FlowResultRowView {
  return { name, type, stepId, kind: null, available: false, unavailableReason: reason, value: null };
}

/**
 * A stored row's shape at the projection boundary. `writeRevision`
 * zod-validates every stored row (`outputRowSchema` in `flow.service.ts`), so
 * a row reaching this function carries these fields; every read below still
 * defends its own type with `typeof`, and anything else reads as unavailable.
 */
type StoredRow = { name?: unknown; type?: unknown; source?: unknown };
type StoredSource = { from?: unknown; stepId?: unknown; inputId?: unknown; value?: unknown; field?: unknown };

/**
 * Project one declared row against the run. Never throws: a row whose source
 * cannot be read is unavailable with its own sentence, so one missing row does
 * not take the readable ones with it.
 */
function projectRow(
  row: unknown,
  steps: ResultStepInput[],
  runInputs: Record<string, unknown> | undefined,
): FlowResultRowView {
  const rec = row as StoredRow;
  const name = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : "(unnamed row)";
  const type = typeof rec.type === "string" ? rec.type : null;
  const source = rec.source as StoredSource | null | undefined;
  if (!source || typeof source !== "object") {
    return rowNone(
      name,
      `row "${name}" has no source, so there is nothing to hand back for it. Bind it to a step, ` +
        `an input or a literal.`,
      type,
      null,
    );
  }
  const from = source.from;
  if (from === "step" || from === "whole") {
    const sourceStepId = typeof source.stepId === "string" ? source.stepId : null;
    const step = sourceStepId ? steps.find((s) => s.stepId === sourceStepId) : undefined;
    if (!step) {
      return {
        ...rowNone(
          name,
          `row "${name}" reads step "${sourceStepId ?? "(unknown)"}", which did not run in this ` +
            `execution — most likely the run predates the declaration, or a branch it sits in ` +
            `was not taken.`,
          type,
          sourceStepId,
        ),
        stepId: sourceStepId,
      };
    }
    if (step.status !== "success") {
      return {
        ...rowNone(
          name,
          `step "${step.stepId}" (row "${name}") is in state ${step.status ?? "unknown"}, so it ` +
            `produced no answer. Read that step, not this.`,
          type,
          step.stepId,
        ),
        stepId: step.stepId,
        kind: step.kind ?? null,
      };
    }
    const payload = stepPayload(step);
    if (payload.kind === "unreadable") {
      return {
        ...rowNone(
          name,
          `step "${step.stepId}" (row "${name}") succeeded but its output could not be read, so no ` +
            `result can be reported for it. This is a defect worth reporting rather than a state to retry.`,
          type,
          step.stepId,
        ),
        stepId: step.stepId,
        kind: step.kind ?? null,
      };
    }
    const whole = payload.kind === "envelope" ? envelopeValue(payload.env) : payload.value;
    // `{from:"step", field}` returns THAT field — of each row for a list, of the
    // value for an object. It returned the whole output until 2026-09-24, so a
    // declared single field silently handed back everything.
    const field = from === "step" && typeof source.field === "string" && source.field ? source.field : null;
    const pick = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[field!] : undefined);
    return {
      name,
      type,
      stepId: step.stepId,
      kind: step.kind ?? null,
      available: true,
      unavailableReason: null,
      value: field === null ? whole : Array.isArray(whole) ? whole.map(pick) : pick(whole),
    };
  }
  if (source.from === "input") {
    const inputId = typeof source.inputId === "string" ? source.inputId : null;
    if (!runInputs) {
      return rowNone(
        name,
        `row "${name}" reads input "${inputId ?? "(unknown)"}", which is not carried on the execution ` +
          `view this result was projected from.`,
        type,
        null,
      );
    }
    if (!inputId || !(inputId in runInputs)) {
      return rowNone(
        name,
        `row "${name}" reads input "${inputId ?? "(unknown)"}", which was not supplied to this run.`,
        type,
        null,
      );
    }
    return { name, type, stepId: null, kind: null, available: true, unavailableReason: null, value: runInputs[inputId] };
  }
  if (source.from === "literal") {
    if (typeof source.value !== "string") {
      return rowNone(name, `row "${name}" declares a literal that is not a string, so it cannot be handed back.`, type, null);
    }
    return { name, type, stepId: null, kind: null, available: true, unavailableReason: null, value: source.value };
  }
  if (source.from === "self") {
    return rowNone(
      name,
      `row "${name}" reads "self", which has no meaning in a flow-level output row — bind it to a ` +
        `step, an input or a literal.`,
      type,
      null,
    );
  }
  return rowNone(name, `row "${name}" has an unreadable source, so there is nothing to hand back for it.`, type, null);
}

/**
 * Project one execution's declared result.
 *
 * `declared` is `FlowModel.output` for the revision THIS execution ran — never
 * the flow's current draft. Approval binds to a revision (§6.5), so an armed
 * flow's draft can be several edits ahead and reading it would describe a run
 * by a declaration it never had.
 *
 * A rows declaration projects every row (`value` is the name-to-value map);
 * a legacy `stepId` declaration projects that one step exactly as before.
 */
export function flowResultOf(
  declared: { stepId?: unknown; description?: unknown; rows?: unknown } | null | undefined,
  steps: ResultStepInput[],
  runInputs?: Record<string, unknown>,
): FlowResultView {
  const description =
    typeof declared?.description === "string" && declared.description.length > 0
      ? declared.description
      : null;

  const rowsRaw: unknown[] = Array.isArray(declared?.rows) ? declared.rows : [];
  if (rowsRaw.length > 0) {
    const projected = rowsRaw.map((r) => projectRow(r, steps, runInputs));
    const missing = projected.filter((r) => !r.available);
    return {
      stepId: null,
      description,
      kind: null,
      available: missing.length === 0,
      unavailableReason:
        missing.length === 0 ? null : missing.map((r) => `row "${r.name}": ${r.unavailableReason}`).join(" · "),
      value: Object.fromEntries(projected.map((r) => [r.name, r.value])),
      succeeded: null,
      failed: null,
      warnings: null,
      rows: projected,
    };
  }

  const stepId = typeof declared?.stepId === "string" ? declared.stepId : null;
  if (stepId === null) {
    return none(
      "this automation does not declare which step is its result, so there is nothing to " +
        "hand back. Open it in the builder and mark the step that produces the answer.",
      null,
      description,
    );
  }

  const step = steps.find((s) => s.stepId === stepId);
  if (!step) {
    return none(
      `this automation's result comes from step "${stepId}", which did not run in this ` +
        `execution — most likely the run predates the declaration, or a branch it sits in ` +
        `was not taken.`,
      stepId,
      description,
    );
  }

  if (step.status !== "success") {
    return none(
      `step "${stepId}" is the declared result and its state is ` +
        `${step.status ?? "unknown"}, so it produced no answer. Read that step, not this.`,
      stepId,
      description,
    );
  }

  const payload = stepPayload(step);
  if (payload.kind === "unreadable") {
    return none(
      `step "${stepId}" succeeded but its output could not be read, so no result can be ` +
        `reported. This is a defect worth reporting rather than a state to retry.`,
      stepId,
      description,
    );
  }

  if (payload.kind === "envelope") {
    const env = payload.env;
    return {
      stepId,
      description,
      kind: step.kind ?? null,
      available: true,
      unavailableReason: null,
      value: envelopeValue(env),
      succeeded: typeof env.succeeded === "number" ? env.succeeded : null,
      failed: typeof env.failed === "number" ? env.failed : null,
      warnings: Array.isArray(env.warnings) ? env.warnings : null,
      rows: null,
    };
  }

  return {
    stepId,
    description,
    kind: step.kind ?? null,
    available: true,
    unavailableReason: null,
    value: payload.value,
    succeeded: null,
    failed: null,
    warnings: null,
    rows: null,
  };
}

/**
 * compiled-builder I-301 (C) — the backstop: a step that succeeded and produced NO rows, said so. A filter comparing a column with
 * a value it never holds is valid, deploys and runs green, and returns nothing — the one place that can see it is a run. Stated per
 * step, never as a failure: an empty result can be the right answer, and only the person knows which.
 * A reader (`tool`/`datasource`/`query` envelope) "read no rows"; a step over rows (`transform`/`code`/`merge`) "kept no rows".
 */
export function emptyRowSteps(steps: ResultStepInput[]): Array<{ stepId: string; note: string }> {
  const out: Array<{ stepId: string; note: string }> = [];
  for (const st of steps) {
    if (st.status !== "success") continue;
    const p = stepPayload(st);
    if (p.kind === "envelope") {
      const rs = p.env.results ?? [];
      if (st.kind !== "tool" && rs.length > 0 && rs.every((r) => r.ok !== false && Array.isArray(r.data) && r.data.length === 0)) out.push({ stepId: st.stepId, note: "read no rows" });
    } else if (p.kind === "value" && Array.isArray(p.value) && p.value.length === 0 && st.kind && ["transform", "code", "merge", "collect"].includes(st.kind)) {
      // A loop's output with no rows: the loop ran over nothing (phase F).
      out.push({ stepId: st.stepId, note: st.kind === "collect" ? "ran over no items" : "kept no rows" });
    }
  }
  return out;
}

