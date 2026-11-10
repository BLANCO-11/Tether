import { z } from "zod";
import {
  stepExecutionService,
  type StepBatchResult,
  type StepItemResult,
} from "./step-execution.service.js";
import { StepError } from "./step-error.js";
import { redactSecrets } from "../utils/redact.js";
import { auditService } from "./audit.service.js";
import type { StepKind } from "./flow-output-shape.js";

/**
 * `stepTryService` — run ONE component, with values a person supplied, and
 * persist nothing. Builder programme T9 (`BD-006`).
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Authoring a step meant guessing. The catalogue says a tool takes
 * `{to, subject, body}`; nothing said what comes back, whether the credential
 * is stored, or whether the endpoint is reachable at all — and the only way to
 * find out was to finish the flow and run the whole thing. This runs the one
 * step, now, against the values in front of you.
 *
 * ── ⚠ THREE KINDS, NOT FIVE, AND THE PLAN SAID FIVE ──────────────────────────
 *
 * The plan's T9 lists `tool`, `datasource`, `query`, `transform` and `code`.
 * **`transform` and `code` cannot be run here and it is not an omission.** Both
 * execute INSIDE Kestra: a `transform` is a Pebble/jq expression the engine
 * evaluates, and a `code` fragment runs in a sibling Docker container Kestra
 * starts. `packages/server` holds no Docker socket and its image has no Docker
 * CLI (D-28), and `kestra:check` FAILS if the mount comes back — so the only
 * two ways to honour the plan's wording are to reintroduce the socket, or to
 * submit a one-task flow to the engine, which is an execution wearing a
 * preview's name. Both are worse than a refusal that says which.
 *
 * The same reasoning is why there is no Pebble evaluator here. A second
 * implementation of the expression language would drift from the engine's, and
 * this repo has already paid for that once: D-22's allowlist named three
 * functions the engine does not have (I-118), so the prompt taught a runtime
 * failure and the check configured from the same list waved it through. A try
 * therefore runs **the values a person supplied**, never the step's
 * `paramsExpr` — and the screen has to say so, or a green try reads as proof
 * the expression is right, which it is not evidence of at all.
 *
 * ── ⚠ IT REALLY CALLS THE ENDPOINT ───────────────────────────────────────────
 *
 * A `tool` try dials the registered URL with the stored credential and whatever
 * effect that has, happens. It is not a dry run and there is no dry-run mode:
 * a dial that pretends is exactly the probe that returns green for a tool which
 * 401s in a run. The surface must say so BEFORE the button, and
 * `ui-honesty-check.sh` asserts that sentence.
 *
 * ── What it does not write ───────────────────────────────────────────────────
 *
 * No revision, no `flow_executions` row, no M3 budget slot, no `flow_step_runs`
 * pointer, no Kestra anything. A preview that leaves audit rows is an execution
 * under a different name, and the whole value of this route is that pressing it
 * is cheap enough to press again.
 *
 * ⚠ **`api_call_log` is the one place a try DOES appear, with a null run id**,
 * and that is the accurate answer rather than a gap: there was no run. A reader
 * of that log should take a null `run_id` to mean *"a real call that did not
 * come from an execution"* — which includes every try. `invokeTool`'s `runId`
 * is deliberately not passed; inventing a token to fill it would put a value in
 * a field whose documented contract is that it holds a Foundry execution id.
 *
 * ── What is NOT relaxed ──────────────────────────────────────────────────────
 *
 * Every gate on the execution path applies unchanged, because this calls the
 * same three functions the engine's own step callbacks call — `invokeTool`,
 * `runNamedQuery`, `runOperation`. So the STRICT egress classifier, the
 * shadowed-secret collision refusal (I-120), the read-only datasource
 * credential and the sandbox/production selection are all in force and none of
 * them was reimplemented here. **This route must never grow its own dial.**
 */

/** The kinds a try can run, and it is exactly the set Foundry itself executes. */
export const TRYABLE_KINDS = ["tool", "datasource", "query"] as const;
export type TryableKind = (typeof TRYABLE_KINDS)[number];

/**
 * Why each other kind is refused, in the words the screen shows.
 *
 * ⚠ **A refusal names its own reason and they are all different reasons.** A
 * shared "not supported" would make `code` (no Docker socket here) read like
 * `approval` (waits on a person), and the second is a permanent property of the
 * kind while the first is a boundary somebody might otherwise try to move.
 */
export const UNTRYABLE_REASON: Record<Exclude<StepKind, TryableKind>, string> = {
  transform:
    "A transform is an expression Kestra evaluates. Tether has no evaluator for it, " +
    "and building a second one would let it disagree with the engine that runs the flow.",
  code:
    "A code step runs in a container Kestra starts. Tether holds no Docker socket, " +
    "deliberately, so there is nowhere here to run the fragment.",
  approval: "An approval step does not do anything — it waits for a person to decide.",
  branch: "A branch produces no output. It only decides whether the steps after it run.",
  // ⚠ Its own reason, not `transform`'s — the shared-refusal trap this table's
  // docblock names. A transform is untryable because Foundry has no evaluator;
  // a merge is untryable because there is nothing to evaluate *yet*. It reports
  // which earlier step produced a result, so trying it in isolation — with no
  // run, and therefore no arm having been taken — could only ever return the
  // "nothing matched" fallback, which reads as a real answer and is not one.
  merge:
    "A merge reports which earlier step produced a result, so there is nothing to try " +
    "on its own — run the flow and it will show which way the condition went.",
  // ⚠ Its own reason each, not a shared "not supported" — same trap as above.
  // The try box carries ONE parameter object for a ref-calling step; an `llm`
  // step needs a prompt and an `http` step needs a request, so neither fits
  // the box. Both run from the flow itself.
  // For each (D-361): its own reasons — a loop runs its body once per item of a run's list, and its output is what those runs
  // produced; neither exists outside a run.
  for_each:
    "A loop runs the steps inside it once per item of a list the run produced, so there is nothing to try on its own — " +
    "try a step inside it, or run the flow.",
  collect:
    "A loop's output is one row per item the loop ran, so it exists only after a run — run the flow to see it.",
  llm:
    "An llm step is a full prompt answered by the deployment's gateway. The try box " +
    "carries one parameter object, not a prompt — run the flow to try it.",
  http:
    "An http step dials its own URL through the workspace egress policy. The try box " +
    "carries one parameter object, not a request — run the flow to try it.",
};

export const stepTrySchema = z.object({
  /** Which kind of step this is. Decides the executor and the refusals. */
  stepKind: z.string().min(1).max(32),
  /** `<tool>`, or `<datasource>.<query|operation>`. Resolved server-side, per workspace. */
  ref: z.string().min(1).max(512),
  /**
   * ONE invocation's parameters.
   *
   * ⚠ **A single object, not the execution path's array.** A preview that fans
   * out is a run: `stepBatchSchema` caps a batch at 1000, and 1000 real emails
   * is not a thing a "try" button may do by accident. One call, every time.
   */
  params: z.record(z.unknown()).default({}),
  /**
   * Frozen step SQL (mock-data plan): the human-approved statement, carried
   * verbatim. When present the preview runs exactly this text (through
   * `checkSqlShape`) instead of the stored ref text. Absent means legacy.
   */
  sql: z.string().min(1).max(64000).optional(),
  /**
   * Explicit datasource address. When absent the preview falls back to the
   * `<datasource>.` prefix of `ref`.
   */
  datasourceRef: z.string().min(1).max(128).optional(),
  /**
   * Per-preview production opt-in (mock-data plan §4). Default OFF: the
   * preview reads mock data. `true` requires a workspace admin (the route
   * refuses anything else) and is recorded as an `access`/`datasource`
   * audit event.
   */
  useProductionData: z.boolean().optional().default(false),
});
// Input shape (not output): `useProductionData` defaults at parse time, so
// direct service callers may omit it exactly as request bodies do.
export type StepTryInput = z.input<typeof stepTrySchema>;

export interface StepTryResult {
  ok: boolean;
  /** The single item's outcome, redacted. */
  item: StepItemResult;
  /** Notes that are not failures, e.g. a skipped NULL recipient. */
  warnings: string[];
  /**
   * Which database a `datasource`/`query` try read. Absent for `tool`.
   *
   * ⚠ A try has no execution and therefore no namespace, so it resolves
   * **`draft`** — the same fail-closed answer `envForNamespace` gives an
   * unrecognised namespace, and for the same reason: reading production on a
   * preview is a wrong answer nobody is watching for. Without the explicit,
   * admin-gated `useProductionData` opt-in a preview reads mock (or refuses
   * without a READY mock) — the old no-sandbox-reads-production fallback is
   * gone, exactly as on the draft run path.
   */
  readFrom?: StepBatchResult["readFrom"];
  /**
   * True only on the explicit production opt-in path. Absent otherwise — a
   * preview reading production without this flag is a bug, not a fallback.
   */
  usedProductionData?: boolean;
}

function isTryable(kind: string): kind is TryableKind {
  return (TRYABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Run one step and return its outcome.
 *
 * ⚠ **A failed CALL is a result; a refused REQUEST is an error**, and the split
 * is the point of the `catch`. `invokeTool` and its two siblings throw a 502
 * when every item failed — correct on the execution path, where a step that
 * called nothing successfully must fail the flow. Here the person pressed a
 * button to find out what happens, and a 502 with the response body buried in
 * `detail` answers that question badly. Every other `StepError` — 404 unknown
 * ref, 409 shadowed secret, 424 credential never stored, 501 unsupported
 * datasource type — is about the request rather than the endpoint, and those
 * still leave as errors with their own status.
 */
async function tryStep(
  workspaceId: string,
  input: StepTryInput,
  opts: { actor?: string } = {},
): Promise<StepTryResult> {
  const kind = input.stepKind;
  if (!isTryable(kind)) {
    const reason = UNTRYABLE_REASON[kind as Exclude<StepKind, TryableKind>];
    throw new StepError(
      reason ?? `"${kind}" is not a kind of step that can be run on its own.`,
      // 422: the request is well formed and names a real thing; it is the thing
      // itself that cannot be done. A 400 would read as "you sent it wrong".
      422,
      { stepKind: kind, tryable: [...TRYABLE_KINDS] },
    );
  }

  // `tool` ignores the flag: a tool try dials the endpoint either way, so
  // there is no production-vs-mock decision to opt into and nothing to audit.
  const useProdOverride = input.useProductionData === true && kind !== "tool";
  if (useProdOverride) {
    // Every production read on a preview is an audited access, recorded where
    // the person is known (the route passes the verified actor). The route
    // gates this branch to admins; the service records the access.
    await auditService.record({
      workspaceId,
      actor: opts.actor ?? "unknown",
      operation: "access",
      entity: "datasource",
      description:
        `Production-data step preview of "${input.ref}": the preview read production instead of mock data.`,
      whereText: `Steps · ${input.ref}`,
      whereEntityType: null,
      whereEntityId: null,
      raw: { ref: input.ref, stepKind: kind, useProductionData: true },
    });
  }

  const batch = {
    ref: input.ref,
    params: [input.params ?? {}],
    ...(input.sql !== undefined ? { sql: input.sql } : {}),
    ...(input.datasourceRef !== undefined ? { datasourceRef: input.datasourceRef } : {}),
  };

  try {
    const result =
      kind === "tool"
        ? await stepExecutionService.tool(workspaceId, batch)
        : kind === "datasource"
          ? await stepExecutionService.datasource(workspaceId, batch, "draft", {
              workspaceId,
              useProdOverride,
            })
          : await stepExecutionService.operation(workspaceId, batch, "draft", {
              workspaceId,
              useProdOverride,
            });
    const shaped = shape(result);
    return useProdOverride ? { ...shaped, usedProductionData: true as const } : shaped;
  } catch (e) {
    if (e instanceof StepError && e.status === 502) {
      const detail = e.detail as {
        results?: StepItemResult[];
        readFrom?: StepBatchResult["readFrom"];
        usedProductionData?: boolean;
      };
      const item = detail?.results?.[0];
      if (item) {
        return {
          ok: false,
          item: redactSecrets(item) as StepItemResult,
          warnings: [e.message],
          ...(detail.readFrom ? { readFrom: detail.readFrom } : {}),
          ...(detail.usedProductionData ? { usedProductionData: true as const } : {}),
        };
      }
    }
    throw e;
  }
}

function shape(result: StepBatchResult): StepTryResult {
  const item = result.results[0] ?? { ok: false, error: "the step produced no result" };
  return {
    ok: item.ok === true,
    // ⚠ Redacted on the way OUT, not trusted to be clean on the way in. The item
    // type says it never carries a credential and that is a claim about the
    // callers, not a property of the data — an endpoint is free to echo the key
    // it was sent straight back in its own response body.
    item: redactSecrets(item) as StepItemResult,
    warnings: result.warnings,
    ...(result.readFrom ? { readFrom: result.readFrom } : {}),
  };
}

export const stepTryService = { tryStep };
