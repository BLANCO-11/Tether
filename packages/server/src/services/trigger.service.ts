import { forgeDeclared, isPiModel } from "./pi-flow.service.js";
import { checkRunInputs, coerceTypedInput } from "./flow-run-inputs.js";
import crypto from "node:crypto";
import { z } from "zod";
import { flowInputFormat, type FlowInputFormat } from "./flow-input-format.js";
import { triggerRepo, type Trigger } from "../repositories/trigger.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "./flow.service.js";
import { flowApprovalService } from "./flow-approval.service.js";
import { flowExpectationService } from "./flow-expectation.service.js";
import { flowEnableReadiness, type EnableReadiness } from "./flow-arm-readiness.js";
import { ensureApiAddress } from "./flow-api-address.js";
import { runRequesterRepo, triggerRequester } from "./run-requester.js";
import { kestra, KestraError } from "./kestra-client.service.js";
import { redactSecrets } from "../utils/redact.js";
import { hasFlowInputDefault, isFlowInputRequired } from "./flow-inputs.js";
import type { ComputedInputFn } from "./flow-compiler.service.js";

/**
 * One row of a trigger's fire audit trail, as `GET …/triggers/:tid/fires` serves it.
 *
 * ⚠ `flowExecutionId` is FOUNDRY's execution id, and there is no Kestra id on
 * this view (R5). It is null when the fire started nothing — refused at the
 * approval gate, or the engine never accepted it — which is the row someone
 * debugging a silent automation came here for.
 *
 * `trigger_fires.execution_id` is deliberately NOT here: it points at the
 * `execution_results` table Phase 4 deleted and a flow fire always leaves it
 * NULL, so serving it would be a field that says "nothing ran" on every row.
 */
export type TriggerFireView = {
  id: string;
  triggerId: string;
  firedBy: string;
  firedAt: string | null;
  payload: unknown;
  flowExecutionId: string | null;
  flowExecutionStatus: string | null;
};

export const createTriggerSchema = z.object({
  name: z.string().min(1).max(255),
  // `schedule` stays on the schema so the refusal in `createForFlow` is a 409
  // with the reason, not a 400 saying the value does not exist (D-18).
  type: z.enum(["manual", "schedule", "poll", "webhook", "api"]),
  config: z.record(z.any()).optional(),
  // WS-H0.3: default OFF. A trigger is a standing grant to run something
  // repeatedly and unattended, so the safe state is the default one — enabling is
  // a deliberate act that passes the gate below.
  enabled: z.boolean().optional().default(false),
});
export const updateTriggerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
  /**
   * The values this trigger sends for the flow's declared inputs — ui-upgrade
   * Phase 7.4.
   *
   * ⚠ **Merged into `config.inputs`, not written over it.** `config` replaces
   * wholesale, and a client that had to send the whole object back to change one
   * value would drop whatever it did not know about — `draftedFrom`, and every
   * key a later version adds. If both are given, `config` applies first and this
   * merges into the result, so the wholesale write is never silently ignored.
   *
   * ⚠ **An empty string DELETES the entry rather than sending `""`.** That is
   * how an override is taken back off: with no trigger value the input falls
   * back to the plan's own `defaults`, which is where it is authoritative
   * (D-107). Storing `""` would look like a value and send one.
   */
  inputs: z.record(z.string().max(512)).optional(),
});

export type FiredBy = "manual" | "schedule" | "poll" | "webhook" | "api";

/**
 * Trigger types a FLOW-bound trigger may have.
 *
 * `api` (Phase 6) is the programmatic sibling of `webhook`: a token-bearing
 * row, fired by `POST /api/triggers/:token/api`, authenticated by the trigger's
 * workspace credential (kind `api`) rather than by the URL alone.
 *
 * `schedule` is absent, and its absence is §5.4 made visible: a Kestra Schedule
 * trigger is deployed as part of approval promotion and removed on revoke, so a
 * cron lives on the flow MODEL and is armed by approving a revision. A Foundry
 * schedule row for a flow would be a second, unapproved way to fire it on a
 * timer — the exact bypass gate 2 exists to close.
 */
/**
 * The trigger types a FLOW may have.
 *
 * ⚠ **`webhook` IS RETIRED (2026-09-08) AND `api` IS WHAT REPLACED IT.** Asked
 * for directly — *"we should merge webhook with api"* — and the merge went the
 * safe way round: the UNAUTHENTICATED receiver is the one that went.
 *
 * What the two actually differed by, measured at the source before deciding:
 *
 *  - **Not authentication.** An `api` trigger's Bearer resolves through
 *    `credentialProviderService.resolveCredential` to `trigger.webhookToken` —
 *    byte-identical to the token already in its own URL — and
 *    `SECRET_OWNED_KINDS` is `{tool, llm, generic}`, so a workspace secret of
 *    kind `api` **cannot be created by any write path in the product**. Anyone
 *    holding the URL holds the credential, on both types.
 *  - **Inputs.** `/api` type-checks the body's `inputs` and passes them to the
 *    flow; `/webhook`'s body never reaches the engine at all.
 *
 * So `webhook` was the strictly weaker of two endpoints that are equally
 * reachable, and keeping both meant two URL shapes, two receivers, two
 * refusals in `approve()` and two names on every screen for one idea.
 *
 * ⚠ **It stays in `createTriggerSchema`'s enum ON PURPOSE**, exactly as
 * `schedule` does and for the same reason (D-18): a caller that asks for one
 * gets a **409 naming the replacement**, not a 400 saying the value does not
 * exist. A retired concept has to be able to say it is retired.
 *
 * ⚠ Nothing was migrated because there was nothing to migrate — measured on
 * this deployment: `triggers` holds `api=4, manual=4` and **zero** webhooks,
 * and **0 of 30** revisions declare `model.webhook`.
 */
const FLOW_TRIGGER_TYPES = new Set(["manual", "poll", "api"]);

/** Retired types, and what to use instead. Refused with a 409, never a 400. */
const RETIRED_TRIGGER_TYPES: Record<string, string> = {
  webhook:
    'the "webhook" trigger is retired — use "api" instead. It is the same URL and the same token, ' +
    "with two differences: the path ends in /api, and the call may carry typed inputs in its body " +
    "which are checked against what the approved revision declares. A webhook's body never reached " +
    "the flow at all, so nothing an existing caller sends is lost.",
};

function toPublic(t: Trigger) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    flowId: t.flowId,
    name: t.name,
    type: t.type,
    config: t.config,
    enabled: t.enabled,
    /**
     * The public path clients POST to fire this trigger — deliberately ONE
     * field for both token-bearing types (Phase 6): the client renders the
     * webhook row and the api row identically, and the only difference is the
     * last path segment. `api` triggers additionally require a Bearer
     * credential, but that is a request property, not a row property.
     */
    webhookPath:
      t.type === "webhook" && t.webhookToken
        ? `/api/triggers/${t.webhookToken}/webhook`
        : t.type === "api" && t.webhookToken
          ? `/api/triggers/${t.webhookToken}/api`
          : null,
    lastFiredAt: t.lastFiredAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * ⚠ **GATE 1 MOVED TO `flow-arm-readiness.ts` — it is not gone, and it must not
 * be re-implemented here.** Publishing now also arms the capacity a flow was
 * built in, so `flow-approval.service.ts` needs the identical answer and cannot
 * import this module (this file imports `flowApprovalService`, so it would be a
 * cycle). The gate therefore lives in a leaf both import. `EnableReadiness` and
 * `flowEnableReadiness` are re-exported below so every existing caller — and
 * `flowEnableReadiness` on this service's public surface, which the Triggers
 * page reads to EXPLAIN a dead switch rather than just refuse — is unchanged.
 */
export type { EnableReadiness };


/**
 * One input the flow declares, and **who supplies its value when this trigger
 * fires** — ui-upgrade Phase 7.1, D-107.
 *
 * The three sources are not a presentation detail; they are three different
 * places a value lives, and the whole point of reporting them is that only one
 * of them is this trigger's own:
 *
 *  - `trigger` — `triggers.config.inputs[id]`, typed by a person here.
 *  - `plan`    — the model declares `defaults`, and Kestra applies it from the
 *                flow definition. It is deliberately NOT copied onto the trigger
 *                (D-107): a copy freezes, and an edited default would then
 *                disagree with what actually fires, silently.
 *  - `computed` — the model declares a derivation (`computed`), and the engine
 *                resolves it at run creation from the firing time. `value` is
 *                null: there is no stored value, and showing the expression
 *                would invite editing what only the engine can evaluate.
 *  - `none`    — nobody. On a `required` input that is a fire that will be
 *                rejected by the engine, which is what `inputsWarning` says.
 */
export type DeclaredInput = {
  id: string;
  type: string;
  required: boolean;
  /** The value that will be sent, or null when none will be. */
  value: string | null;
  source: "trigger" | "plan" | "computed" | "none";
  /** Which derivation, when `source` is `computed` — so a surface can say why. */
  computed: ComputedInputFn | null;
  /**
   * Which control this input deserves — derived by `flowInputFormat` from the
   * declared type, then from how the flow's own expressions use it, then from
   * the shape of the value. `text` is the honest answer when nothing knows.
   */
  format: FlowInputFormat;
};

/**
 * The declared inputs of the revision this trigger would actually run, plus the
 * model's own cron.
 *
 * ⚠ **The ARMED revision when there is one, the draft otherwise.** A trigger
 * fires the approved live revision or nothing (§5.4), so on a flow whose draft
 * has moved ahead, the draft's inputs are not the ones that will be sent.
 * Reading the draft unconditionally would describe a fire that cannot happen —
 * the same mistake as reading `flow_executions.status` instead of `engineStatus`
 * (D-13).
 *
 * ⚠ `scheduleCron` is READ from the model every time, never stored on a trigger.
 * A cron lives on the model and is deployed by approving a revision (D-18); a
 * `schedule` row would be a second, unapproved way to fire on a timer, which
 * `createForFlow` refuses by name.
 */
async function declaredInputsFor(
  flow: { id: string; draftRevision: number; armedRevision: number | null },
  config: unknown,
): Promise<{
  inputs: DeclaredInput[];
  fromRevision: number | null;
  scheduleCron: string | null;
}> {
  const revision = flow.armedRevision ?? flow.draftRevision;
  if (revision < 1) return { inputs: [], fromRevision: null, scheduleCron: null };
  const row = await flowRepo.getRevision(flow.id, revision);
  // A Forge workflow declares its inputs as an object on workflow.json; read it in the compiled model's shape.
  const stored = row?.modelJson ?? null;
  const model = (isPiModel(stored) ? forgeDeclared(stored) : stored) as {
    inputs?: { id: string; type: string; required?: boolean; defaults?: string; computed?: ComputedInputFn }[];
    steps?: Array<Record<string, unknown>>;
    schedule?: { cron?: string };
  } | null;
  if (!model) return { inputs: [], fromRevision: null, scheduleCron: null };

  const supplied = ((config ?? {}) as { inputs?: Record<string, unknown> }).inputs ?? {};
  const steps = model.steps ?? [];
  const inputs: DeclaredInput[] = (model.inputs ?? []).map((i) => {
    const own = supplied[i.id];
    const overridden = own !== undefined && own !== null && String(own) !== "";
    // A derivation is decided but has no stored value — `value` stays null so
    // no surface can display (or edit) the expression as if it were data.
    const derived = !overridden && i.computed !== undefined;
    const value = overridden ? String(own) : derived ? null : hasFlowInputDefault(i) ? i.defaults! : null;
    const source: DeclaredInput["source"] = overridden
      ? "trigger"
      : derived
        ? "computed"
        : hasFlowInputDefault(i)
          ? "plan"
          : "none";
    return {
      id: i.id,
      type: i.type,
      required: isFlowInputRequired(i),
      value,
      source,
      computed: derived ? i.computed! : null,
      format: flowInputFormat(i, steps, value),
    };
  });
  return { inputs, fromRevision: revision, scheduleCron: model.schedule?.cron ?? null };
}

/**
 * The THIRD sentence (D-108) — and it warns rather than blocks, on purpose.
 *
 * Its fix is neither "run it once" (gate 1) nor "find an approver" (gate 2): it
 * is typing a value here. But the failure it describes is **loud** — Kestra
 * rejects the execution, the refusal is rethrown with its status, and the
 * `trigger_fires` row is written before the engine is called, so a fire that
 * started nothing is already on the audit trail. Turning it into a refusal would
 * mean a new arm-time 409 inside `assertEnableAllowed`, which every harness in
 * the regression net drives.
 */
function inputsWarningFor(inputs: DeclaredInput[]): string | null {
  const missing = inputs.filter((i) => i.required && i.source === "none");
  if (!missing.length) return null;
  const names = missing.map((i) => `"${i.id}"`).join(", ");
  return (
    `The automation requires ${names}, and neither this trigger nor the plan supplies a value. ` +
    `Firing it will be rejected until one is set here.`
  );
}

/** toPublic + the fields the Triggers page needs to explain a blocked enable. */
async function toPublicDetailed(t: Trigger) {
  if (t.flowId) {
    const flow = await flowRepo.get(t.workspaceId, t.flowId);
    const readiness = await flowEnableReadiness(t.workspaceId, t.flowId);
    const approval = flow ? await flowApprovalService.state(t.workspaceId, flow) : null;
    const declared = flow
      ? await declaredInputsFor(flow, t.config)
      : { inputs: [] as DeclaredInput[], fromRevision: null, scheduleCron: null };
    return {
      ...toPublic(t),
      automationName: flow?.name ?? null,
      automationStatus: flow?.status ?? null,
      /** Phase 7.1 — what this trigger will send, and who supplies each value. */
      declaredInputs: declared.inputs,
      inputsFromRevision: declared.fromRevision,
      scheduleCron: declared.scheduleCron,
      /** ⚠ A warning, NOT a gate — see `inputsWarningFor`. */
      inputsWarning: inputsWarningFor(declared.inputs),
      enableReady: readiness.ready,
      enableBlockedReason: readiness.reason,
      /**
       * Gate 2, surfaced separately (task 3.9). A trigger blocked on approval
       * must SAY so rather than present a switch that does nothing.
       */
      approvalState: approval,
      approvalBlockedReason:
        approval && approval.armedRevision == null
          ? "This flow has no approved revision, so it cannot run unattended yet."
          : approval && !approval.approval
            ? "The approval for this flow was revoked or has gone stale. Re-approve it to fire again."
            : null,
    };
  }
  // A trigger with no `flow_id` is unreachable: `createForFlow` is the only
  // constructor left. Represented rather than assumed, because "bound to
  // nothing, reported as fine" is the failure mode this migration exists to stop.
  return {
    ...toPublic(t),
    automationName: null,
    automationStatus: null,
    declaredInputs: [] as DeclaredInput[],
    inputsFromRevision: null,
    scheduleCron: null,
    inputsWarning: null,
    enableReady: false,
    enableBlockedReason: "This trigger is bound to nothing.",
    approvalState: null,
    approvalBlockedReason: null,
  };
}

function conflict(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 409;
  return e;
}

async function assertEnableAllowed(
  t: Pick<Trigger, "workspaceId" | "flowId" | "type" | "config">,
) {
  if (!t.flowId) throw conflict("this trigger is bound to nothing");
  const { ready, reason } = await flowEnableReadiness(t.workspaceId, t.flowId);
  if (!ready) throw conflict(reason ?? "this trigger cannot be enabled yet");
  if (t.type === "webhook") {
    const flow = await flowRepo.get(t.workspaceId, t.flowId);
    if (!flow) throw conflict("the flow this trigger is bound to no longer exists");
    const declared = await declaredInputsFor(flow, t.config);
    const missing = declared.inputs.filter((input) => input.required && input.source === "none");
    if (missing.length) {
      throw conflict(
        `this webhook cannot be enabled because required input(s) ` +
          `${missing.map((input) => `"${input.id}"`).join(", ")} have no trigger value or plan ` +
          `default. A webhook body is untrusted and is not used as execution input.`,
      );
    }
  }
}

/**
 * Fire a flow-bound trigger → start a Kestra execution (task 3.6).
 *
 * ── It fires the APPROVED revision, in the LIVE namespace, or nothing ────────
 *
 * A webhook that quietly ran the draft would be an approval bypass with a public
 * URL on it: gate 2 asks "may this run unattended", and a webhook fire is
 * unattended by definition. Test runs have their own path,
 * `POST /flows/:id/test-run`, which is explicitly a draft action and says so.
 *
 * ── Ordering, preserved from the script path ────────────────────────────────
 *
 * The `trigger_fires` row is written whether or not the execution started — a
 * fire that produced nothing is exactly what someone debugging a silent
 * automation needs to see — and the refusal is RETHROWN with its status code
 * rather than returned as a 202 carrying an `error` field nobody reads.
 *
 * The row is written FIRST here, because its id is stamped onto the Kestra
 * execution as a label and `POST /api/executions/begin` reads it back to link
 * the two. Doing it afterwards would race: `begin` runs as the flow's first
 * task, which can complete before `startExecution` has even returned.
 */
async function fireFlow(
  trigger: Trigger,
  firedBy: FiredBy,
  payload?: unknown,
  /**
   * The inputs THIS fire sends, when the caller supplied them.
   *
   * `undefined` keeps the webhook contract: inputs come from the trigger's own
   * config, never from an attacker-controlled body. A caller that IS allowed to
   * name values (the api receiver, the manual fire route) passes the map
   * `validateFireInputs` built and type-checked against the flow's declared
   * inputs — the validated map arrives here as this argument, never as a raw
   * body read.
   */
  inputsOverride?: Record<string, string>,
) {
  const flow = await flowRepo.get(trigger.workspaceId, trigger.flowId!);
  if (!flow) {
    const e = new Error("the flow this trigger is bound to no longer exists") as Error & {
      statusCode?: number;
    };
    e.statusCode = 404;
    throw e;
  }

  // The inputsWarning promise, kept: a fire missing required inputs is refused
  // with 409 carrying the same sentence the trigger detail shows — never an
  // opaque engine 502 with a null execution. (Measured in UAT: three held
  // triggers fired without `as_of` all died downstream instead of here.)
  {
    const declared = await declaredInputsFor(flow, trigger.config);
    const over = inputsOverride ?? {};
    const missing = declared.inputs.filter(
      (i) => i.required && String(over[i.id] ?? "") === "" && i.source === "none",
    );
    if (missing.length) {
      throw conflict(
        `cannot fire: required input(s) ${missing.map((i) => `"${i.id}"`).join(", ")} ` +
          `have no value on this trigger — set them on the trigger first`,
      );
    }
  }

  const fire = await triggerRepo.recordFire({
    triggerId: trigger.id,
    executionId: null,
    firedBy,
    payload: (payload as object) ?? null,
  });
  await triggerRepo.update(trigger.id, { lastFiredAt: new Date() });

  let kestraExecutionId: string | null = null;
  let error: string | undefined;
  let statusCode: number | undefined;
  try {
    if (firedBy === "webhook") {
      const declared = await declaredInputsFor(flow, trigger.config);
      const missing = declared.inputs.filter((input) => input.required && input.source === "none");
      if (missing.length) {
        throw conflict(
          `this webhook cannot run because required input(s) ` +
            `${missing.map((input) => `"${input.id}"`).join(", ")} have no trigger value or plan default`,
        );
      }
    }
    if (flow.runtime === "foundry") {
      // A Forge workflow runs on Foundry's runner (pi-runtime P5): the armed revision, live, recorded against this
      // fire. Inputs follow the same rule as below — the trigger's config, or a validated override, never a body.
      const inputs =
        inputsOverride ?? (((trigger.config ?? {}) as { inputs?: Record<string, string> }).inputs ?? {});
      const { flowRunnerService } = await import("./flow-runner.service.js");
      const started = await flowRunnerService.startLiveRun({
        workspaceId: trigger.workspaceId,
        flowId: flow.id,
        inputs,
        requester: triggerRequester(trigger.name),
        triggerFireId: fire.id,
      });
      return { fire, executionId: started.flowExecutionId, kestraExecutionId: null, error: undefined };
    }
    const revision = await flowApprovalService.assertMayRunLive(trigger.workspaceId, flow);
    const { live } = await flowService.namespaces(trigger.workspaceId);
    // Inputs come from the trigger's own config, never from the payload. A
    // webhook body is attacker-controlled on a public URL (`/api/triggers/:token/webhook`
    // is unauthenticated by design), and flow inputs are interpolated into step
    // params — so the body is recorded on the fire row for the audit trail and
    // is not handed to the engine. The exceptions are the callers allowed to
    // name values (the api receiver, the manual fire route): they pass
    // `inputsOverride`, the map `validateFireInputs` built and type-checked
    // against the flow's declared inputs.
    const inputs =
      inputsOverride ??
      (((trigger.config ?? {}) as { inputs?: Record<string, string> }).inputs ?? {});
    const execution = await kestra.startExecution(live, flow.kestraFlowId, inputs, {
      foundry_flow: flow.id,
      foundry_revision: String(revision),
      foundry_env: "live",
      foundry_trigger_fire: fire.id,
      // GAPS §1.1b. A trigger fire has no person behind it, and recording that
      // explicitly is the point: gate 3's self-decision refusal stands down on a
      // run nobody asked for, and it can only know that if the run says so.
      foundry_run_request: await runRequesterRepo.record(
        trigger.workspaceId,
        flow.id,
        triggerRequester(trigger.name),
      ),
    });
    kestraExecutionId = execution.id;
  } catch (e) {
    error = (e as Error).message;
    statusCode = (e as { statusCode?: number }).statusCode ?? (e instanceof KestraError ? 502 : undefined);
  }

  if (statusCode) {
    const e = new Error(error ?? "trigger fire failed") as Error & { statusCode?: number };
    e.statusCode = statusCode;
    throw e;
  }
  return { fire, executionId: null, kestraExecutionId, error };
}

// `coerceTypedInput` / `checkRunInputs` live in `flow-run-inputs.ts` — one rule
// for every route that starts a run (phase 5 task 4).

/**
 * Validate the `inputs` one fire carries against the flow's DECLARED inputs,
 * typed, and build the string map the execution path sends.
 *
 * Two callers, one rule. The api receiver's caller IS credential-authenticated
 * and the manual fire route's caller holds the API key, so either body is
 * trusted enough to reach the engine — but only after this check: every
 * supplied value is coerced against the declared type, an undeclared input id
 * is refused, and a required input with no supplied value and no plan default
 * is refused. `issues` non-empty means the fire must not proceed (the route
 * answers 422 with the issues).
 *
 * ⚠ Reads the ARMED revision's declarations, never the draft's — a fire can
 * only run the approved live revision (§5.4), so the draft's inputs are not
 * the ones that will be sent (the same rule as `declaredInputsFor`).
 */
async function validateFireInputs(
  trigger: Pick<Trigger, "workspaceId" | "flowId">,
  supplied: Record<string, unknown> | undefined,
): Promise<{ inputs: Record<string, string>; issues: Array<{ input: string; message: string }> }> {
  const issues: Array<{ input: string; message: string }> = [];
  // A non-object `inputs` (string, array, number) is a malformed call — the
  // flow declares an id→value MAP, and `Object.entries` on anything else
  // would validate garbage against it.
  const body =
    typeof supplied === "object" && supplied !== null && !Array.isArray(supplied) ? supplied : {};

  const flow = await flowRepo.get(trigger.workspaceId, trigger.flowId!);
  if (!flow) {
    const e = new Error("the flow this trigger is bound to no longer exists") as Error & {
      statusCode?: number;
    };
    e.statusCode = 404;
    throw e;
  }
  const revision = flow.armedRevision;
  // No armed revision → nothing to validate against, and `fireFlow`'s
  // `assertMayRunLive` will refuse with the approval-gate message.
  if (revision == null || revision < 1) return { inputs: {}, issues: [] };

  const row = await flowRepo.getRevision(flow.id, revision);
  // A Forge workflow declares its inputs as an object on workflow.json; read it in the compiled model's shape.
  const stored = row?.modelJson ?? null;
  const model = (isPiModel(stored) ? forgeDeclared(stored) : stored) as {
    inputs?: Array<{ id: string; type: string; format?: string; required?: boolean; defaults?: string; computed?: ComputedInputFn }>;
  } | null;
  const declared = model?.inputs ?? [];
  const byId = new Map(declared.map((d) => [d.id, d]));

  // Supplied values first: an undeclared id is a caller mistake worth naming,
  // and a mistyped value is refused here rather than by the engine.
  issues.push(...checkRunInputs(declared, body));

  const inputs: Record<string, string> = {};
  for (const d of declared) {
    const raw = body[d.id];
    if (raw !== undefined && raw !== null) {
      const coerced = coerceTypedInput(d.type, raw, d.format);
      if (coerced !== null) inputs[d.id] = coerced;
      continue;
    }
    // Nothing supplied. A derivation resolves itself at run creation — sending
    // the expression as a literal would pin raw Pebble text as the run's
    // input. A literal plan default travels as the value (D-107 — authoritative
    // and never copied onto the trigger).
    if (d.computed !== undefined) continue;
    if (hasFlowInputDefault(d)) {
      inputs[d.id] = d.defaults!;
      continue;
    }
    if (isFlowInputRequired(d)) {
      issues.push({ input: d.id, message: `input "${d.id}" is required and no value was supplied` });
    }
  }

  return { inputs, issues };
}

/**
 * The row a fire acts on, or the refusal before anything is written.
 *
 * The manual fire route loads it first so `validateFireInputs` can check the
 * body before the fire row exists; `fire` loads it to run. One loader so the
 * two cannot disagree about what "this trigger" means.
 */
async function getForFire(triggerId: string): Promise<Trigger> {
  const trigger = await triggerRepo.get(triggerId);
  if (!trigger) {
    const e = new Error("trigger not found") as Error & { statusCode?: number };
    e.statusCode = 404;
    throw e;
  }
  if (!trigger.flowId) {
    const e = new Error("this trigger is bound to no flow") as Error & { statusCode?: number };
    e.statusCode = 409;
    throw e;
  }
  return trigger;
}

export const triggerService = {
  async listByFlow(workspaceId: string, flowId: string) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) {
      const e = new Error("flow not found") as Error & { statusCode?: number };
      e.statusCode = 404;
      throw e;
    }
    return Promise.all((await triggerRepo.listByFlow(flowId)).map(toPublicDetailed));
  },

  async createForFlow(workspaceId: string, flowId: string, input: z.infer<typeof createTriggerSchema>) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) {
      const e = new Error("flow not found") as Error & { statusCode?: number };
      e.statusCode = 404;
      throw e;
    }
    // ⚠ The retired-type refusal comes FIRST, because the generic message below
    // talks about Kestra owning schedules and would be simply untrue about a
    // webhook. A refusal that names the wrong reason is worse than a 400.
    const retired = RETIRED_TRIGGER_TYPES[input.type];
    if (retired) throw conflict(retired);
    if (!FLOW_TRIGGER_TYPES.has(input.type)) {
      throw conflict(
        `a flow cannot have a "${input.type}" trigger in Tether — Kestra owns schedules from ` +
          "§5.4 on. Put the cron on the flow model and approve a revision; approval deploys the " +
          "Schedule trigger and revoking removes it.",
      );
    }
    if (input.enabled) {
      await assertEnableAllowed({
        workspaceId,
        flowId,
        type: input.type,
        config: input.config ?? {},
      });
    }
    const t = await triggerRepo.create({
      workspaceId,
      flowId,
      name: input.name,
      type: input.type,
      config: input.config ?? {},
      enabled: input.enabled,
      // Both token-bearing types: `api` is `webhook` with a credential on top
      // (Phase 6), and the receiver resolves the stored token through the
      // credential seam, so there is exactly one stored secret per row.
      webhookToken:
        input.type === "webhook" || input.type === "api" ? crypto.randomBytes(18).toString("hex") : null,
    });
    return toPublicDetailed(t);
  },

  /**
   * Draft this flow's first trigger when the automation is created — ui-upgrade
   * Phase 7.1, D-107, and D-88 before it.
   *
   * ── Drafting is NOT arming ──────────────────────────────────────────────────
   *
   * `enabled: false`, so the engine holds no schedule for it and its URL answers
   * nothing. Everything that makes a trigger fire is downstream of gate 1 and
   * gate 2 and neither is touched here. Phase 7's exit criterion asserts the
   * absence against KESTRA rather than against this row, because the two
   * legitimately disagree and the row is the one that lies (D-13).
   *
   * ── It carries what the plan DECLARES and invents nothing ───────────────────
   *
   * `config.inputs` is left **empty**. Not an oversight: a value the plan does
   * not know is a value nobody knows, and writing one anyway is the measured
   * failure this migration exists to fix (`period="2023-10"`, 0 of 11 emailed,
   * exit 0) relocated one layer out, where it would arrive pre-filled in a box
   * that looks reviewed. A declared `defaults` is not copied either — a copy
   * freezes, and an edited default would then disagree with what fires. Both are
   * reported instead, per input, by `declaredInputsFor`.
   *
   * ⚠ **Idempotent by "has a NON-API trigger", not by name.** Regeneration,
   * import and template instantiation all reach flow creation, and a second
   * drafted trigger on the same flow is a second thing to arm that nobody asked
   * for. Renaming the drafted one must not be enough to get another. ⚠ This
   * said *"has any trigger"* until 2026-09-08 and the qualifier is
   * load-bearing: the api address is ensured separately, by its own by-type
   * guard, and a flow that already had a manual trigger would otherwise return
   * early and never get an address at all — which was the reported defect.
   *
   * ⚠ **THIS SAID "`manual`, AND ONLY `manual`" UNTIL 2026-09-08 AND THAT IS NO
   * LONGER TRUE — the D-18 property it was protecting is unchanged though, and
   * it is worth reading precisely.** A cron lives on the flow model and is armed
   * by approving a revision (D-18); `createForFlow` refuses a `schedule` row by
   * name, and drafting must not become the route around that. **No timer is
   * drafted, and that is the whole of the rule.**
   *
   * What is also drafted now is an **api ADDRESS** — `ensureApiAddress`, called
   * first, because *"every workflow ever that is published should be able to be
   * called using api"* and an address is a `triggers` row. It routes around
   * nothing: an `api` row is creatable by hand anyway, and it arrives
   * `enabled: false`, so gate 1 still decides whether it can ever fire.
   */
  /**
   * Make sure this flow HAS an API address — so that publishing it makes it
   * callable, without anybody having to know that an address is a `triggers`
   * row.
   *
   * ⚠ **THE REPORT THIS EXISTS FOR: "every workfow ever that is published
   * should be able to be called using api".** Before this, an address was a
   * row somebody had to create by hand on a different page, so the flow page's
   * API tab said *"This automation has no API trigger, so there is no URL to
   * call it on"* — on every one of this deployment's 14 flows, because
   * `draftForFlow` drafts a `manual` trigger and nothing ever drafted an api
   * one. A capability that exists only if you already know it exists is not a
   * capability the product has.
   *
   * ⚠ **IDEMPOTENT BY TYPE, and `draftForFlow`'s is by "has ANY trigger" —
   * the difference is deliberate and they are not interchangeable.** That one
   * guards against a second thing to arm: a flow that already has a trigger
   * does not want another drafted, whatever its type. This one guards a
   * DIFFERENT thing — that an api address exists — so it has to run on a flow
   * that already has a manual trigger, and must not create a second api row on
   * one that already has an address, because a second address is a second
   * credential to rotate and a coin-flip about which one somebody pasted.
   *
   * ⚠ **`enabled: false`, and publishing is what turns it on** — through
   * `_armDeclaredCapacity`, which asks gate 1 and obeys it. Creating it enabled
   * would be this function quietly becoming the way round a gate whose reason
   * is a script that reported `tests_passed=true` and emailed 0 of 11 people.
   * So a flow that has never completed a run gets an address that answers 404,
   * and the API tab shows the shape with the blocker named — which is what
   * somebody wiring up a caller needs BEFORE go-live anyway.
   *
   * ⚠ **The name must be unique per WORKSPACE**, not per flow: `getByName` is
   * workspace-scoped because the credential seam resolves a trigger by name.
   * Two flows called "Untitled automation" exist on this deployment, so the
   * derived name collides and the fallback appends the flow id's first eight
   * characters — deterministic, so re-running this cannot produce a third name
   * for the same flow.
   */
  async ensureApiTrigger(workspaceId: string, flowId: string) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) {
      const e = new Error("flow not found") as Error & { statusCode?: number };
      e.statusCode = 404;
      throw e;
    }
    // ⚠ The creation itself lives in `flow-api-address.ts`, a LEAF, because
    // `flow-approval.service.ts` needs the identical thing at publish and
    // cannot import this module (this one imports it — a cycle). This wrapper
    // adds only the 404 and the public shape.
    const { trigger, created } = await ensureApiAddress(workspaceId, flow);
    return created
      ? { created: await toPublicDetailed(trigger), existing: null }
      : { created: null, existing: await toPublicDetailed(trigger) };
  },

  async draftForFlow(workspaceId: string, flowId: string) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) {
      const e = new Error("flow not found") as Error & { statusCode?: number };
      e.statusCode = 404;
      throw e;
    }
    // ⚠ **THE API ADDRESS IS ENSURED FIRST, AND OUTSIDE THE GUARD BELOW.**
    // That guard returns early when the flow has ANY trigger, which is right
    // for "do not draft a second thing to arm" and wrong for "does this flow
    // have an address" — a flow with a manual trigger would keep getting no
    // api one, which is the reported defect. `ensureApiTrigger` has its own
    // by-type idempotency, so calling it here is safe on every path that
    // reaches flow creation: regeneration, import and template instantiation.
    await this.ensureApiTrigger(workspaceId, flowId);

    const existing = await triggerRepo.listByFlow(flowId);
    if (existing.some((t) => t.type !== "api")) {
      return { drafted: null, skipped: "this flow already has a trigger" };
    }

    const t = await triggerRepo.create({
      workspaceId,
      flowId,
      name: "Start by hand",
      type: "manual",
      // `draftedFrom` is provenance, not configuration: it is what lets a
      // surface say "Foundry drafted this when the automation was created"
      // rather than implying a person chose it.
      config: { inputs: {}, draftedFrom: "plan" },
      enabled: false,
      webhookToken: null,
    });
    return { drafted: await toPublicDetailed(t), skipped: null };
  },

  async update(id: string, input: z.infer<typeof updateTriggerSchema>) {
    // Enabling is gated; disabling is always free — pausing a trigger must never
    // be the operation that fails.
    const current = input.enabled === true || input.inputs ? await triggerRepo.get(id) : undefined;
    if (input.enabled === true) {
      if (!current) return undefined;
      await assertEnableAllowed(current);
    }

    const { inputs, ...patch } = input;
    let config = patch.config;
    if (inputs) {
      if (!current) return undefined;
      // `config` first, then the merge — so a caller sending both gets both
      // applied rather than one silently discarding the other.
      const base = (config ?? (current.config as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const merged: Record<string, string> = {
        ...((base.inputs as Record<string, string> | undefined) ?? {}),
      };
      for (const [k, v] of Object.entries(inputs)) {
        // ⚠ Empty means REMOVE, never `""`. Clearing an override has to put the
        // input back on the plan's own `defaults` (D-107); storing an empty
        // string would look like a value on every surface and send one.
        if (v === "") delete merged[k];
        else merged[k] = v;
      }
      config = { ...base, inputs: merged };
    }

    const t = await triggerRepo.update(id, { ...patch, ...(config !== undefined ? { config } : {}) });
    return t ? toPublicDetailed(t) : undefined;
  },

  /** Why a trigger cannot be armed yet — for the UI to explain, not just block. */
  flowEnableReadiness,

  async remove(id: string) {
    return triggerRepo.remove(id);
  },

  /**
   * The fire audit trail — every attempt to start this trigger, and what it
   * started. Newest first, capped at 50 by the repository.
   *
   * ⚠ `payload` is REDACTED here and not at the edge. A webhook fire records the
   * body verbatim, and that body arrives on `/api/triggers/:token/webhook`, which
   * is unauthenticated by design — so it is arbitrary third-party JSON that may
   * carry a bearer token in a field nobody here named. It was already served raw
   * by this route; it now also reaches a screen, and the rule the rest of the
   * product follows is that redaction is server-side and stays there (D-07).
   */
  async fires(triggerId: string): Promise<TriggerFireView[]> {
    const rows = await triggerRepo.listFires(triggerId);
    return rows.map((r) => ({
      id: r.id,
      triggerId: r.triggerId,
      firedBy: r.firedBy,
      firedAt: r.firedAt?.toISOString() ?? null,
      payload: redactSecrets(r.payload) ?? null,
      flowExecutionId: r.flowExecutionId ?? null,
      flowExecutionStatus: r.flowExecutionStatus ?? null,
    }));
  },

  /**
   * Fire a trigger → start a KESTRA execution of the flow's **approved** live
   * revision, or nothing at all. The shared path for "Fire now", polls and
   * webhooks.
   *
   * The script branch was deleted in Phase 4 (task 4.11). It matters that it is
   * gone rather than disabled: while both backends existed, a trigger bound to a
   * script fired code that no approval had ever covered, on the same button.
   */
  async fire(
    triggerId: string,
    firedBy: FiredBy,
    payload?: unknown,
    inputs?: Record<string, string>,
  ) {
    return fireFlow(await getForFire(triggerId), firedBy, payload, inputs);
  },

  getByWebhookToken(token: string) {
    return triggerRepo.getByWebhookToken(token);
  },

  getForFire,

  /**
   * The typed-input check a fire route runs BEFORE any fire row is written.
   * See `validateFireInputs`; exported so the route stays a thin shell and
   * the rule lives beside the fire path it guards.
   */
  validateFireInputs,
};
