import { forgeRefsOf, forgeScheduleRefusal, isPiModel, type PiRevisionModel } from "./pi-flow.service.js";
import { effectiveAccounts, runAsProblems } from "./run-as.service.js";
import { reachOf } from "./automation-reach.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { z } from "zod";
import { flowRepo, type Flow, type FlowApproval } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { manifestBuilderService, toolFingerprint } from "./manifest-builder.service.js";
import { flowService } from "./flow.service.js";
import { flowCompiler, FlowCompileError, type FlowModel } from "./flow-compiler.service.js";
import { kestra, KestraError } from "./kestra-client.service.js";
import type { RevisionAuthorKind } from "./revision-author.js";
import { scheduleInputRefusal } from "./flow-schedule-inputs.js";
import { triggerRepo, type Trigger } from "../repositories/trigger.repo.js";
import { flowEnableReadiness } from "./flow-arm-readiness.js";
import { ensureApiAddress } from "./flow-api-address.js";

/**
 * Gate 2 — may this revision run UNATTENDED?
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.5 · 03 §5.4
 *
 * ── The rule that is easiest to get wrong ────────────────────────────────────
 *
 * **Approval binds to a REVISION, never to the flow.** If it bound to the flow,
 * editing an approved flow would silently repoint an already-armed schedule at
 * different behaviour — approve-once becomes a blank cheque over changing
 * content. That is privilege escalation by editing (risk 1d).
 *
 * ── Why the gate is structural rather than a check ───────────────────────────
 *
 * A Kestra Schedule trigger is part of the flow definition. So approval DEPLOYS
 * the trigger and revocation REMOVES it (§5.4): an unapproved flow has no
 * trigger in Kestra and cannot fire, which is stronger than any runtime test
 * because there is nothing to test. `begin` re-checks anyway — that is
 * defence in depth for a manual live start, not the primary control.
 *
 * ── Three gates, none replacing another ──────────────────────────────────────
 *
 *   1. `enableReadiness()`  has this flow ever succeeded?      (per flow)
 *   2. **schedule approval**  may it run unattended?           (per revision) ← here
 *   3. step approval        may THIS execution pass step N?    (per execution, Kestra `Pause`)
 *
 * Do not conflate 2 and 3. A flow can be schedule-approved and still pause every
 * execution for a step-level approval.
 */

/**
 * What a CLIENT may send when approving.
 *
 * ⚠ `approverUserId` is deliberately absent, and the schema is **`.strict()`**
 * so sending it is a 400 naming the field (Stage 9.1). It is supplied by the
 * route from the verified identity. Merely dropping an accepted field would
 * leave a request that looks like it worked and an audit record that says
 * somebody else.
 */
export const approveSchema = z
  .object({
    revision: z.number().int().min(1),
    approverKind: z.enum(["client_admin", "foundry_operator"]).optional().default("client_admin"),
    note: z.string().max(2000).optional(),
  })
  .strict();

/** The service's input: the client's fields plus the identity the route verified. */
export type ApproveInput = z.infer<typeof approveSchema> & {
  approverUserId: string;
  /**
   * The caller is a super admin, so the self-approval refusal does not apply.
   *
   * ⚠ **Set by the ROUTE from the verified identity, never parsed from a body.**
   * `approveSchema` is `.strict()` precisely so an approver cannot name
   * themselves; a body-settable exemption would be the same hole with a
   * different field name. It is deliberately outside the schema for that reason
   * — the schema describes what a client may send, and this is not that.
   */
  bySuperAdmin?: boolean;
};

/** Same rule as approving: `revokedBy` comes from the route, never from the body. */
export const revokeSchema = z
  .object({
    reason: z.string().min(1).max(2000),
    revision: z.number().int().min(1).optional(),
  })
  .strict();

export type RevokeInput = z.infer<typeof revokeSchema> & { revokedBy?: string };

/** Approving answers the owner's "ask for approval" (sharing-boundaries, migration 0120), whichever revision it was for. */
const ANSWERED = { reviewRequestedRevision: null, reviewRequestedBy: null, reviewRequestedAt: null } as const;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

/** Flow statuses this service writes. `armed` means a schedule exists AND is deployed. */
export type FlowStatus = "draft" | "draft_pending" | "approved" | "armed" | "suspended";

export interface ApprovalState {
  /** The revision currently deployed live, if any. */
  armedRevision: number | null;
  approval: FlowApproval | null;
  status: FlowStatus;
  /** True when the draft has moved ahead of what is armed. */
  draftAhead: boolean;
  /** Why a client cannot approve right now, in words a UI can print. */
  blockedReason: string | null;
}

async function modelOf(flow: Flow, revision: number): Promise<FlowModel> {
  const row = await flowRepo.getRevision(flow.id, revision);
  if (!row) throw httpError(`revision ${revision} does not exist`, 404);
  return row.modelJson as FlowModel;
}

/**
 * Recompute the approval fingerprint for a revision from the CURRENT manifest.
 *
 * Per ref, not per manifest version — §6.5 is explicit that a manifest bump
 * touching nothing this flow uses must have no effect. Registering an unrelated
 * tool suspending every schedule in the workspace would be a control nobody
 * leaves switched on.
 */
async function fingerprintNow(workspaceId: string, model: FlowModel, owner?: string | null): Promise<{
  fingerprint: string;
  missing: string[];
}> {
  const current = await manifestBuilderService.refFingerprints(workspaceId);
  // A Forge workflow may call an action its OWNER switched on for themselves (plans/personal-actions-2026-10-29): it
  // counts here like a workspace tool, so switching it off reads as "no longer has it" and an upgrade as a new shape.
  if (owner && isPiModel(model)) {
    const { personalTools } = await import("./personal-actions.js");
    for (const t of await personalTools(workspaceId, owner)) if (!(t.name in current)) current[t.name] = toolFingerprint(t, { personal: true });
  }
  // A Forge workflow declares what it reaches in its own terms (`uses`, saved readers) — not compiled steps.
  const refs = isPiModel(model) ? forgeRefsOf(model) : flowCompiler.refsOf(model);
  return {
    fingerprint: manifestBuilderService.aggregateFingerprint(refs, current),
    missing: [...new Set(refs)].filter((r) => !current[r]),
  };
}

/**
 * What publishing did about FIRING — ui report, and the reason it exists.
 *
 * ⚠ **"Publish" now means "this workflow is ready to run in whatever capacity
 * it was built in"** (scheduled / trigger / manual fire / API), which is the
 * answer to a question this product had left open. Measured beforehand, on this
 * deployment: 14 flows, **every one a draft, zero approvals ever**, and **8
 * trigger rows every one of them `enabled = false`**. Approval deploys a Kestra
 * Schedule only when the model declares a cron (1 revision of 30 does), and
 * every other firing mechanism is a separate row with its own gate. So all 14
 * flows could have been marked Live and **nothing would ever have fired.**
 *
 * ⚠ **IT IS THREE OUTCOMES AND NOT A BOOLEAN, AND THAT IS THE WHOLE POINT.**
 * `armed` alone would report a partial arming as a success; a thrown error would
 * make publishing fail on a condition the user deliberately downgraded to a
 * warning. `held` carries the server's own sentence per trigger, so "published
 * and firing" and "published, firing nothing yet, here is why" are different
 * answers a person can act on rather than one green tick.
 */
export type FiringOutcome = {
  /** Enabled by this publish, or already on. */
  armed: Array<{ id: string; name: string; type: string }>;
  /** Not enabled, each with the server's reason. */
  held: Array<{ id: string; name: string; type: string; reason: string }>;
  /**
   * The cron the compile deployed, when the model declares one. Reported rather
   * than inferred: `schedule` is the ONE capacity that is not a `triggers` row
   * (D-18), so a caller reading only `armed` would conclude a scheduled flow
   * fires nothing.
   *
   * ⚠ The `cron` string only, not the `FlowSchedule` object. The timezone
   * belongs beside the cron wherever it is DISPLAYED, and this field exists to
   * answer "does a timer fire this" — a shape that can grow fields is a shape a
   * caller starts reading other things out of.
   */
  schedule: string | null;
};

export const flowApprovalService = {
  /**
   * Deploy a revision's YAML to the LIVE namespace.
   *
   * **The only place in the codebase that writes to the live namespace.** Kept
   * private to this module on purpose — `flow.service.ts` has no live branch at
   * all, so "editing cannot change what the schedule runs" is checkable by
   * grepping for the caller rather than by reading every path.
   */
  async _deployLive(workspaceId: string, flow: Flow, revision: number, withSchedule: boolean) {
    const model = await modelOf(flow, revision);
    const { live } = await flowService.namespaces(workspaceId);
    let compiled;
    try {
      compiled = flowCompiler.compile(model, {
        namespace: live,
        withSchedule: withSchedule && !!model.schedule,
        labels: { foundry_flow: flow.id, foundry_revision: String(revision), foundry_env: "live" },
      });
    } catch (e) {
      if (e instanceof FlowCompileError) throw httpError(e.message, 400);
      throw e;
    }
    await flowService.assertKestraAccepts(compiled.yaml);
    await kestra.deployFlow(live, flow.kestraFlowId, compiled.yaml);
    return { model, hash: compiled.hash };
  },

  /**
   * Approve one revision and promote it.
   *
   * Order matters. Kestra is written FIRST and Foundry second, so a crash in
   * between leaves a flow that is armed in Kestra with no approval row — which
   * the next staleness sweep and every `begin` will refuse, because both read
   * Foundry. The reverse order leaves an approval row for a schedule that was
   * never deployed, i.e. a flow the product says is running and that never
   * fires. Fail towards the state that is visible and refuses, not the one that
   * is invisible and silent.
   */
  /**
   * Arm the firing mechanisms this flow was built with — publishing's second half.
   *
   * ⚠ **IT WRITES NOTHING TO THE LIVE NAMESPACE, which is why it may live
   * here.** `_deployLive` is still the only function in the codebase that does
   * (§6.5's checkable property), and a `triggers` row is not a Kestra object: a
   * flow-bound `manual`/`api`/`poll` trigger is a Foundry row that the poll
   * scheduler reads and that `fire()` turns into an execution against the
   * already-deployed live revision. The one capacity that IS a Kestra object is
   * the schedule, and that is deployed by the compile, untouched by this.
   *
   * ⚠ **GATE 1 IS ASKED, AND ITS ANSWER IS OBEYED.** Publishing does not
   * bypass it. Gate 1 for APPROVAL became a warning on 2026-09-07 by explicit
   * request; the TRIGGER gate is still a hard refusal and the asymmetry is the
   * point — approving records that a person read a version, arming lets it fire
   * with nobody watching, and the measured failure behind that gate is a script
   * which reported `tests_passed=true` and emailed 0 of 11 people. So a flow
   * that has never completed a run publishes and arms NOTHING, and says so.
   * Refusing out loud is not bypassing; making publish throw would re-impose
   * gate 1 as a block on the act the user deliberately unblocked.
   *
   * ⚠ **ASKED ONCE, NOT PER TRIGGER.** `flowEnableReadiness` is scoped to the
   * FLOW, so a per-trigger call is the same query N times with the same answer.
   *
   * ⚠ **A `webhook` IS HELD, DELIBERATELY, AND IT IS THE ONE NARROWING HERE.**
   * `assertEnableAllowed` applies an extra rule to webhooks — every required
   * input needs a trigger value or a plan default, because a webhook body is
   * untrusted and is never used as execution input — and that rule lives in
   * `trigger.service.ts`, which this module cannot import (it imports this one;
   * see `flow-arm-readiness.ts` for the cycle). Copying the rule here would be
   * a second definition of it (D-197) that drifts in the direction where the
   * copy stops refusing. So a webhook is held with a reason naming the Triggers
   * page, which fails CLOSED: a public unauthenticated endpoint is not turned
   * on as a side effect of publishing. ⚠ A webhook DECLARED ON THE MODEL is a
   * different path and is unaffected — `materializeDeclaredTriggers` has
   * created those `enabled: true`, with no gate at all, since Phase 6. That
   * pre-existing inconsistency is recorded rather than extended or quietly
   * changed here; changing it would alter what every existing declared trigger
   * does and is its own decision.
   */
  async _armDeclaredCapacity(
    workspaceId: string,
    flow: Flow,
    model: FlowModel,
  ): Promise<FiringOutcome> {
    const out: FiringOutcome = { armed: [], held: [], schedule: model.schedule?.cron ?? null };
    const triggers = await triggerRepo.listByFlow(flow.id);
    if (!triggers.length) return out;

    const label = (t: Trigger) => ({ id: t.id, name: t.name, type: t.type });

    // Asked once. `null` means "not asked yet"; it is only asked if some
    // trigger actually needs the answer, so a flow whose triggers are all
    // already on costs no extra query.
    let readiness: { ready: boolean; reason: string | null } | null = null;

    for (const t of triggers) {
      // Already on — report it, do not re-write it. Publishing must be
      // idempotent: re-approving the same revision is an ordinary act.
      if (t.enabled) {
        out.armed.push(label(t));
        continue;
      }
      if (t.type === "webhook") {
        out.held.push({
          ...label(t),
          reason:
            "A webhook is a public endpoint that anyone holding its URL can call, so publishing " +
            "does not turn one on. Enable it from the Triggers page, where the required-input " +
            "check for an untrusted body is applied.",
        });
        continue;
      }
      readiness ??= await flowEnableReadiness(workspaceId, flow.id);
      if (!readiness.ready) {
        out.held.push({
          ...label(t),
          // The server's own sentence, verbatim. It is always specific — "has
          // never completed a run", "declares 2 expectation(s)… has not passed"
          // — and replacing it with a summary throws away the actionable half.
          reason: readiness.reason ?? "This trigger cannot be enabled yet.",
        });
        continue;
      }
      await triggerRepo.update(t.id, { enabled: true });
      out.armed.push(label(t));
    }
    return out;
  },

  async approve(workspaceId: string, flowId: string, input: ApproveInput) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);

    const revisionRow = await flowRepo.getRevision(flow.id, input.revision);
    if (!revisionRow) throw httpError(`revision ${input.revision} does not exist`, 404);

    // ── Gate 1 — now WARNING not BLOCK ───────────────────────────────────────
    // User wants to switch to any version even if never run, with warning only.
    // Previously this threw 409 when !hasSucceeded. Now it allows approve but
    // state() will expose blockedReason as warning for UI. The gate still
    // exists for visibility (see state() below) but does not refuse approval.
    // Logging the warning keeps audit trail without blocking.
    const hasSucceeded = await flowExecutionRepo.hasSucceeded(flow.id);
    if (!hasSucceeded) {
      // Warning only — allow version switch. UI will show warning.
      console.warn(`[flow-approval] approving flow ${flow.id} without prior successful run — allowed with warning`);
    }

    // ── The self-approval refusal, and what it can and cannot see ────────────
    //
    // ⚠ NOT separation of duties, in any combination of values (I-13). There
    // ⚠ Roles exist since GAPS §1.1, and they are enforced at the ROUTE
    // (`requireWorkspaceRole`), not here — a service caller (harness, seed, CLI)
    // has no request and no identity, and giving them a privileged fake would
    // satisfy the role model with a constant. So this function still assumes its
    // caller was authorised, and anything holding
    // `RUNTIME_JWT_SECRET` can mint an identity. This catches the honest
    // mistake and records intent.
    //
    // The comparison is UNCHANGED by archive/GAPS.md §1.2, deliberately, and the two
    // rejected alternatives are worth stating:
    //
    //   * **Refusing every `system`-authored revision** would refuse every flow
    //     any harness, seed or CLI ever wrote — `kestra:phase3`, `showcase:seed`,
    //     `scenarios:seed` and `e2e:ui` all arm flows they authored without a
    //     session. A control that takes the regression net down is a control
    //     somebody switches off, and what gets switched off is the control.
    //   * **Skipping the comparison when the author is `system`** would make
    //     `phase3-verify` pass its own self-approval assertion by not running
    //     it, which is the "test that passes over no rows" failure. A name that
    //     matches is still an honest mistake worth catching, whoever recorded it.
    //
    // So the refusal fires exactly as before. What changes is that the approval
    // row below now RECORDS `revisionRow.createdByKind`, so afterwards "a second
    // pair of eyes was possible and happened" and "there was nobody to be the
    // first pair" are different rows rather than the same one.
    //
    // ── ⚠ THE SUPER-ADMIN OVERRIDE, AND WHAT IT COSTS ───────────────────────
    //
    // A super admin may approve a revision they wrote. This was asked for
    // directly, and on a single-operator deployment it is not really optional:
    // the person who authors the automation is the only person who could ever
    // approve it, so an absolute refusal means nothing can be armed at all.
    //
    // ⚠ **It is the ONE control here that was a genuine second pair of eyes**,
    // and the honest description of the product changes with it: say *"a
    // non-super-admin cannot approve their own revision"*, and never the
    // unqualified *"an author cannot approve their own work"*. Everything I-13
    // already says still applies, and more so.
    //
    // It is not silent — `self_approved_override` on the row below records it,
    // so an approval history keeps *"someone else approved this"* and *"its
    // author approved it under an override"* as different rows. An exemption
    // that left no trace would retire the meaning of every row in the table.
    const selfApproval = !!revisionRow.createdBy && revisionRow.createdBy === input.approverUserId;
    const override = selfApproval && !!input.bySuperAdmin;
    if (selfApproval && !override) {
      throw httpError(
        `"${input.approverUserId}" wrote revision ${input.revision} and cannot approve it. ` +
          "Approval is a second pair of eyes (§5.0).",
        409,
      );
    }
    if (override) {
      // Logged as well as recorded: the row is the audit artefact, and the log
      // is what somebody watching the deployment sees at the time.
      console.warn(
        `[approval] SELF-APPROVAL OVERRIDE — "${input.approverUserId}" is a super admin and ` +
          `approved revision ${input.revision} of flow ${flowId}, which they authored.`,
      );
    }

    const model = revisionRow.modelJson as FlowModel;
    const { fingerprint, missing } = await fingerprintNow(workspaceId, model, flow.ownerSubject ?? null);
    if (missing.length) {
      // Approving a flow that references something no longer in the manifest
      // would arm a schedule guaranteed to fail at that step.
      throw httpError(
        `revision ${input.revision} references ${missing.length} thing(s) this workspace no longer ` +
          `has: ${missing.join(", ")}`,
        409,
      );
    }

    // ── The schedule-inputs gate (autonomous-readiness) ──────────────────────
    // An armed schedule fires with NO caller. A required input with no default
    // and no derivation has no value source at that moment: Kestra refuses to
    // create the run at 09:00 — a guaranteed failure deployed in advance.
    // Refuse the approval here, naming the inputs, so the author resolves them
    // BEFORE the schedule goes live: a default expression evaluated at run
    // creation (proven: `{{ execution.startDate | date('yyyy-MM') }}` resolves
    // the month with no caller), a DERIVED input (`computed`, resolved from the
    // firing time the same way — "month just ended" without anyone typing it),
    // or a step that computes the value (no input declared at all — the derived
    // pattern binds downstream steps to `outputs.<step>`). On-demand flows (no
    // schedule) pass: their callers supply inputs or the run is refused at
    // creation, in the open.
    //
    // ⚠ **The refusal SPLITS by whether a step reads the input**, and
    // `flow-schedule-inputs.ts` says why: the three remedies above all assume
    // the input is wanted, and two flows on this deployment were blocked by a
    // declaration nothing reads — where every one of them is wrong and the
    // right action (remove it) went unnamed. Still a refusal either way.
    // A Forge workflow (pi-runtime P5): nothing to compile or deploy — see `_approveForge`.
    if (isPiModel(revisionRow.modelJson)) return this._approveForge(flow, revisionRow, input, override, fingerprint);

    const scheduleRefusal = scheduleInputRefusal(model);
    if (scheduleRefusal) throw httpError(scheduleRefusal, 409);

    /**
     * ⚠ **THE WEBHOOK REFUSAL THAT STOOD HERE IS DELETED, AND IT IS DELETED
     * RATHER THAN LEFT UNREACHABLE.** It refused approval of a flow declaring a
     * webhook with an unresolvable required input, because a webhook's body was
     * untrusted and never became execution input — so such a flow was
     * guaranteed to fail on every call, and deploying it was deploying a
     * failure in advance.
     *
     * `webhook` is retired (2026-09-08): it cannot be declared on a model, it
     * cannot be created as a trigger, and `POST /api/triggers/:token/webhook`
     * refuses unconditionally. So the endpoint this protected no longer exists,
     * and a refusal that can never fire is worse than none — it reads as a live
     * control (I-38). The rule it enforced survives where it is still true, in
     * `checkFlowInputResolution`, for `schedule` alone.
     *
     * ⚠ It has NO `api` equivalent, deliberately: an api caller carries its
     * inputs in a body that is type-checked against the declared inputs before
     * anything is written, so a required input with no default is that caller's
     * to supply, not a defect.
     */

    // ── Phase 6 — materialize declared webhook/api triggers ──────────────────
    //
    // After every refusal gate above, before any Kestra write: a declaration
    // that collides (409) must fail the approval before the live namespace has
    // been touched. Idempotent create-or-resolve, so re-approving the same
    // declaration reuses the row instead of duplicating it. The rows are
    // written before the approval row on purpose: a crash in between leaves
    // triggers enabled but the flow unapproved, and `begin` refuses — the same
    // fail-visible direction `_deployLive`'s ordering picks. `schedule` is
    // never materialized here — it is deployed by the compile below.
    await flowService.materializeDeclaredTriggers(workspaceId, flow, model);

    // ── Publishing's second half — arm the capacity this flow was built in ───
    //
    // ⚠ **HERE, not after the approval row, and the convention above is the
    // reason.** `materializeDeclaredTriggers` states it: writing trigger state
    // before the approval means a crash in between leaves triggers on and the
    // flow unapproved, which `begin` and `fire` both refuse — visible and
    // safe. The other order leaves the flow live with its triggers off, which
    // is exactly the "Live but nothing ever fires" trap this change removes,
    // and it is silent.
    //
    // ⚠ Its answer does not depend on the approval: gate 1 asks whether the
    // flow has ever completed a run, and deliberately not whether it is
    // approved (gate 2 is reported alongside, never folded in). So asking here
    // gives the same answer as asking at the end.
    /**
     * ⚠ **EVERY PUBLISHED WORKFLOW IS CALLABLE OVER THE API, and this is the
     * line that makes that true.** Asked for directly: *"every workfow ever
     * that is published should be able to be called using api"*.
     *
     * `ensureApiAddress` is idempotent by type, so this is a no-op for any flow
     * that already has one — which, after `draftForFlow` also calls it, is
     * every flow created from now on. It is here as well because a flow created
     * BEFORE that change has no address, and publishing is the moment the
     * guarantee has to hold rather than the moment somebody notices it does
     * not. `_armDeclaredCapacity` on the next line is what then enables it,
     * subject to gate 1.
     */
    await ensureApiAddress(workspaceId, flow);

    const firing = await this._armDeclaredCapacity(workspaceId, flow, model);

    const withSchedule = !!model.schedule;
    await this._deployLive(workspaceId, flow, input.revision, withSchedule);

    // Supersede whatever was approved before. Left open, an earlier revision's
    // approval would keep reading as current after the flow moved on.
    await flowRepo.revokeApprovals(flow.id, `superseded by revision ${input.revision}`);

    const approval = await flowRepo.insertApproval({
      flowId: flow.id,
      revision: input.revision,
      approverUserId: input.approverUserId,
      selfApprovedOverride: override,
      approverKind: input.approverKind,
      note: input.note ?? null,
      manifestFingerprint: fingerprint,
      // Copied from the revision, which is insert-only — so this can never
      // disagree with its source, and the approval history answers "was there
      // anybody to be the first pair of eyes" without the reader knowing to
      // join. archive/GAPS.md §1.2.
      revisionAuthorKind: revisionRow.createdByKind as RevisionAuthorKind,
    });

    const status: FlowStatus = withSchedule ? "armed" : "approved";
    const updated = await flowRepo.update(flow.id, { armedRevision: input.revision, status, ...ANSWERED });
    // ⚠ `firing` travels to the caller. Without it, publishing reports success
    // and a person has no way to learn that nothing was armed — which is the
    // whole defect, moved one layer out.
    return { flow: updated ?? flow, approval, firing };
  },

  /**
   * Approve a Forge workflow's revision (pi-runtime P5): it runs on Foundry's runner, which reads the armed revision
   * when a run starts, so there is nothing to compile or deploy. The approval binds to the revision exactly as for a
   * compiled flow. Kept out of `approve` so that function's order — arm, THEN record — reads as it always has.
   */
  async _approveForge(
    flow: Flow,
    revisionRow: NonNullable<Awaited<ReturnType<typeof flowRepo.getRevision>>>,
    input: ApproveInput,
    override: boolean,
    fingerprint: string,
    selfEnabled = false,
  ) {
    const forge = revisionRow.modelJson as PiRevisionModel;
    const refusal = forgeScheduleRefusal(forge);
    if (refusal) throw httpError(refusal, 409);
    // ⚠ Whose account it acts as must hold for its owner — a personal connection only ever the owner's own (8.6).
    const runAs = await runAsProblems(flow.workspaceId, await effectiveAccounts(flow.workspaceId, flow, forge), flow.ownerSubject ?? null);
    if (runAs.length) throw httpError(`not approved: ${runAs.join("; ")}. Choose its connection again on the workflow's page.`, 409);
    await flowRepo.revokeApprovals(flow.id, `superseded by revision ${input.revision}`);
    const approval = await flowRepo.insertApproval({
      flowId: flow.id,
      revision: input.revision,
      approverUserId: input.approverUserId,
      selfApprovedOverride: override,
      selfEnabled,
      approverKind: input.approverKind,
      note: input.note ?? null,
      manifestFingerprint: fingerprint,
      revisionAuthorKind: revisionRow.createdByKind as RevisionAuthorKind,
    });
    const cron = forge.workflow.schedule?.cron ?? null;
    const updated = await flowRepo.update(flow.id, { armedRevision: input.revision, status: cron ? "armed" : "approved", ...ANSWERED });
    // Everyone who turned it on for themselves ran an older version: theirs pauses, and they are told (phase 3).
    const { flowActivationService } = await import("./flow-activation.service.js");
    await flowActivationService
      .noteApproved(flow.workspaceId, flow.id, input.revision, flow.name)
      .catch((e) => console.warn(`[flow-approval] people who turned "${flow.name}" on were not told: ${(e as Error).message}`));
    return { flow: updated ?? flow, approval, firing: { armed: [], held: [], schedule: cron } as FiringOutcome };
  },

  /**
   * Switch on a Forge workflow's revision by its OWNER, with no reviewer (plugins phase 9) — allowed only when the
   * revision uses nothing but the owner's own things (`automation-reach.ts`, computed here from the revision, never
   * taken from the request), and only where the workspace lets members do this (`workspaces.self_enable`).
   *
   * Everything else is `_approveForge`, unchanged: the schedule-input and whose-account refusals, the fingerprint,
   * superseding the earlier approval, and the revision binding. The row records `self_enabled`, so the history keeps
   * "a reviewer approved it" and "its owner switched it on" as different rows.
   *
   * ⚠ No self-approval refusal: there is no second pair of eyes to require, by design — that is the whole point of
   * the rule, and the reach check is what bounds it. An edit is a new revision and is classified afresh, so an edit
   * that adds anything of the workspace's cannot be switched on this way.
   */
  async enableOwn(workspaceId: string, flowId: string, input: { revision?: number; subject: string; actor: string; note?: string }) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    if (flow.runtime !== "foundry") {
      throw httpError("only a workflow built with Forge can be switched on by its owner — this one needs a reviewer", 409);
    }
    if (!flow.ownerSubject || flow.ownerSubject !== input.subject) {
      throw httpError("only its owner can switch an automation on themselves — a reviewer can approve it", 403);
    }
    // Shared things have a blast radius; personal ones are accountable to one person (sharing-boundaries Q2). So only a
    // workflow its owner keeps private may skip the reviewer.
    if (flow.visibility !== "private" || flow.projectId) {
      throw httpError(
        flow.projectId
          ? "this workflow lives in a project, so a reviewer approves it — move it to My space to switch it on yourself"
          : "this workflow is shared with the workspace, so a reviewer approves it — make it private to switch it on yourself",
        409,
      );
    }
    const ws = await workspaceRepo.get(workspaceId);
    if (!ws?.selfEnable) {
      throw httpError("in this workspace, members may not switch on their own automations — ask a reviewer to approve it", 403);
    }
    const revision = input.revision ?? flow.draftRevision;
    const revisionRow = await flowRepo.getRevision(flow.id, revision);
    if (!revisionRow) throw httpError(`revision ${revision} does not exist`, 404);
    if (!isPiModel(revisionRow.modelJson)) throw httpError(`revision ${revision} has no Forge workflow`, 409);
    const reach = await reachOf(workspaceId, revisionRow.modelJson, flow.ownerSubject, flow);
    if (!reach.ownOnly) {
      throw httpError(`this automation needs a reviewer to approve it, because it ${reach.workspace.join("; ")}`, 409);
    }
    const { fingerprint, missing } = await fingerprintNow(workspaceId, revisionRow.modelJson as unknown as FlowModel, flow.ownerSubject ?? null);
    if (missing.length) {
      throw httpError(`revision ${revision} references ${missing.length} thing(s) this workspace no longer has: ${missing.join(", ")}`, 409);
    }
    return this._approveForge(
      flow,
      revisionRow,
      {
        revision,
        approverUserId: input.actor,
        approverKind: "client_admin",
        note: input.note ?? "Switched on by its owner: it uses only their own things.",
      },
      false,
      fingerprint,
      true,
    );
  },

  /**
   * Why a revision its owner switched on may not run now, or null (plugins phase 9). Checked at every live start,
   * not only when it was switched on: the workspace may have stopped allowing it, or what it uses may no longer be
   * only its owner's (a connection handed to the workspace, say). Handing the automation to somebody else turns it
   * off at that moment (`PUT …/owner`) — the new owner switches it on themselves.
   */
  async _selfEnabledRefusal(workspaceId: string, flow: Flow, model: unknown): Promise<string | null> {
    if (flow.visibility !== "private" || flow.projectId) {
      return `"${flow.name}" was switched on by its owner, but it is now shared${flow.projectId ? " in a project" : " with the workspace"} — a reviewer approves it`;
    }
    const ws = await workspaceRepo.get(workspaceId);
    if (!ws?.selfEnable) {
      return `"${flow.name}" was switched on by its owner, and this workspace no longer lets members do that — a reviewer approves it`;
    }
    if (!isPiModel(model)) return `"${flow.name}" was switched on by its owner, but its revision has no Forge workflow`;
    const reach = await reachOf(workspaceId, model, flow.ownerSubject, flow);
    if (!reach.ownOnly) return `"${flow.name}" was switched on by its owner, but it ${reach.workspace.join("; ")} — a reviewer approves it`;
    return null;
  },

  /**
   * Revoke — and REMOVE the Schedule trigger from Kestra (assertion 25).
   *
   * Removed, not disabled. Kestra supports `disabled: true` on a trigger, which
   * is exactly the "merely flagged" state the assertion forbids: a flag is one
   * accidental redeploy away from firing again, and it leaves the engine holding
   * a schedule nobody approved.
   *
   * The live FLOW stays deployed, without triggers. Deleting it would also stop
   * firing, but it risks an execution that is in flight — and §6.5 wants "no
   * further firings, in-flight completes". With no trigger there is nothing to
   * fire, and `begin` refuses a manual live start because the approval is gone.
   */
  async revoke(workspaceId: string, flowId: string, input: RevokeInput) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);

    const armed = flow.armedRevision;
    // A Forge workflow was never deployed: revoking closes the approval, and the runner refuses a live run without one.
    if (armed != null && flow.runtime !== "foundry") await this._deployLive(workspaceId, flow, armed, false);

    const closed = await flowRepo.revokeApprovals(
      flow.id,
      input.reason,
      input.revision,
      input.revokedBy,
    );
    const updated = await flowRepo.update(flow.id, { status: "suspended" });
    return { flow: updated ?? flow, revoked: closed };
  },
  /**
   * Re-arm a turned-off flow WITHOUT a new review — one click on the list's switch.
   *
   * ⚠ **SUSPEND/RESUME IS ORTHOGONAL TO DRAFTS.** Turning a flow off suspends
   * its triggers; it does not un-approve anything. Re-arming resumes the
   * APPROVED revision (`armedRevision`) — even when edits since made a newer
   * draft. Those edits stay exactly where they are: an unapproved draft that
   * still needs its own review before it can go live. The switch must never
   * hold a resume hostage to unrelated work-in-progress, and approving-by-
   * switch must never smuggle an unreviewed draft live — so this arms the
   * revision an approval already covered, never the current draft.
   *
   * ⚠ **THIS IS NOT APPROVE WITHOUT THE CONTROL.** This re-approves nothing
   * new: every ref fingerprint recomputed from the ARMED revision's manifest
   * must match the earlier approval's (`manifestFingerprint`). A tool changing
   * shape under the approved revision, or a sweep suspension (stale), still
   * refuses with 409, and the client routes those to `/publish` — that refusal
   * is stated as the endpoint's contract, and the client reads only the status.
   *
   * ⚠ **NO SELF-APPROVAL REFUSAL HERE, DELIBERATELY.** `approve` refuses an
   * author approving their own revision because new content needs a second pair
   * of eyes. There is no new content here — the model and its fingerprints are
   * identical to what was already approved — so the original approval's eyes
   * still cover it. The new row still records WHO re-armed it
   * (`approverUserId`), so "re-armed by its author" and "re-armed by someone
   * else" stay different rows rather than the same one.
   *
   * ⚠ **A NEW ROW, NOT A REOPENED ONE.** Approvals are closed, never deleted or
   * rewritten (`flow.repo.ts`'s invariant) — reopening a revoked row would make
   * "was turned off on Tuesday" unreadable from the history. The turn-off and
   * the re-arm are two rows about the same approved revision.
   */
  async rearm(workspaceId: string, flowId: string, input: { rearmedBy: string }) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);

    const armed = flow.armedRevision;
    if (armed == null) {
      // ⚠ 409, not 404: the flow exists, but there is nothing to re-arm — and
      // the client's contract is "409 means route to review", which is exactly
      // right here too (a never-armed flow needs its first approval).
      throw httpError(`flow "${flow.name}" was never armed — approve a revision from review first`, 409);
    }
    // ⚠ NO draft-equality check, deliberately. A newer draft is work-in-progress
    // that needs its own review — it neither blocks resuming the approved
    // revision nor rides along silently. `armed` is deployed below, never the
    // current draft.

    // The earlier approval is the proof this revision was reviewed. An approval
    // that is still OPEN means the flow believes it is live while its status
    // says it is not — redeploy into that state rather than stacking a second
    // open row `currentApproval` would then have to disambiguate.
    const open = await flowRepo.currentApproval(flow.id, armed);
    const approvals = open ? [open] : await flowRepo.listApprovals(flow.id);
    const prior = open ?? approvals.find((a) => a.revision === armed);
    if (!prior) {
      throw httpError(
        `flow "${flow.name}" has no approval on record for revision ${armed} — review and approve it instead`,
        409,
      );
    }
    if (prior.staleAt) {
      throw httpError(
        `approval for "${flow.name}" revision ${armed} went stale — something it depends on changed ` +
          "shape. Review and approve again instead",
        409,
      );
    }

    const revisionRow = await flowRepo.getRevision(flow.id, armed);
    if (!revisionRow) throw httpError(`revision ${armed} does not exist`, 404);
    const model = revisionRow.modelJson as FlowModel;
    if (isPiModel(model)) {
      // Turned off because whose account it acts as stopped holding: it stays off until that is chosen again (8.6).
      const runAs = await runAsProblems(workspaceId, await effectiveAccounts(workspaceId, flow, model), flow.ownerSubject ?? null);
      if (runAs.length) throw httpError(`"${flow.name}" cannot be turned on: ${runAs.join("; ")}. Choose its connection again on the workflow's page.`, 409);
    }
    const { fingerprint, missing } = await fingerprintNow(workspaceId, model, flow.ownerSubject ?? null);
    if (missing.length) {
      throw httpError(
        `revision ${armed} references ${missing.length} thing(s) this workspace no longer ` +
          `has: ${missing.join(", ")}`,
        409,
      );
    }
    if (fingerprint !== prior.manifestFingerprint) {
      throw httpError(
        `approval for "${flow.name}" revision ${armed} no longer matches the current workspace — a ` +
          "referenced tool or datasource query changed shape since it was approved. " +
          "Review and approve again instead",
        409,
      );
    }

    // Same second half as `approve`, in the same order: address, capacity, live
    // deploy — then the row, then the status. `_armDeclaredCapacity` is
    // idempotent (already-on triggers are reported, not rewritten), so triggers
    // left enabled across the turn-off simply come back.
    await ensureApiAddress(workspaceId, flow);
    const firing = await this._armDeclaredCapacity(workspaceId, flow, model);
    const withSchedule = !!model.schedule;
    await this._deployLive(workspaceId, flow, armed, withSchedule);

    const approval =
      open ??
      (await flowRepo.insertApproval({
        flowId: flow.id,
        revision: armed,
        approverUserId: input.rearmedBy,
        approverKind: "client_admin",
        selfApprovedOverride: false,
        note:
          `Re-armed approved revision ${armed} after turn-off — model and ref fingerprints ` +
          "identical to the earlier approval, so no new review was needed. Any newer draft is untouched and still needs its own review.",
        manifestFingerprint: fingerprint,
        revisionAuthorKind: revisionRow.createdByKind as RevisionAuthorKind,
      }));
    const status: FlowStatus = withSchedule ? "armed" : "approved";
    const updated = await flowRepo.update(flow.id, { armedRevision: armed, status });
    // ⚠ `firing` travels to the caller, for the same reason as in `approve`: a
    // re-arm that armed nothing must say so rather than report success.
    return { flow: updated ?? flow, approval, firing };
  },

  /**
   * Is the armed revision still approved against the CURRENT manifest?
   *
   * The case §6.5 names: a client approved a flow against a tool with three
   * parameters, and the tool gained a required fourth. The approved flow is now
   * wrong, and nothing about the flow changed — so only comparing against the
   * manifest can detect it.
   *
   * Suspends on divergence: marks the approval stale AND removes the trigger.
   * Marking it stale without removing the trigger would leave the schedule
   * firing a flow the product has already decided is not approved.
   */
  async checkStaleness(workspaceId: string, flow: Flow): Promise<{ stale: boolean; reason?: string }> {
    if (flow.armedRevision == null) return { stale: false };
    const approval = await flowRepo.currentApproval(flow.id, flow.armedRevision);
    if (!approval) return { stale: false };

    const model = await modelOf(flow, flow.armedRevision);
    const { fingerprint, missing } = await fingerprintNow(workspaceId, model, flow.ownerSubject ?? null);
    if (fingerprint === approval.manifestFingerprint) return { stale: false };

    const reason = missing.length
      ? `referenced ${missing.length === 1 ? "ref" : "refs"} no longer exist: ${missing.join(", ")}`
      : "a referenced tool or datasource query changed shape since approval";

    // Kestra first, for the same reason as `approve`: fail towards "not firing".
    try {
      await this._deployLive(workspaceId, flow, flow.armedRevision, false);
    } catch (e) {
      // Leave the approval open. Marking it stale while the trigger is still
      // deployed would report a suspended schedule that is in fact still firing
      // — the one outcome worse than either state on its own.
      throw httpError(
        `could not suspend the schedule for "${flow.name}" (${(e as Error).message}); ` +
          "approval left open deliberately so the UI does not claim a suspension that did not happen",
        502,
      );
    }
    await flowRepo.markStale(flow.id, flow.armedRevision, reason);
    await flowRepo.update(flow.id, { status: "suspended" });
    return { stale: true, reason };
  },

  /**
   * Sweep every armed flow.
   *
   * 08 §10 puts this "on every scheduler tick", written when Foundry owned
   * schedules. Kestra owns them now, so there is no per-flow tick to hang it on
   * — it runs on the surviving poll loop in `trigger-scheduler.ts` instead. That
   * is a real behavioural difference: divergence is now detected within a tick
   * rather than before the next firing, so a schedule can fire ONCE against a
   * changed manifest. `begin` closes that window by refusing an execution whose
   * fingerprint has moved. See DECISIONS.md D-17.
   */
  async sweepStaleness(): Promise<{
    checked: number;
    suspended: number;
    /**
     * WHICH flows were suspended, not just how many.
     *
     * Added because the count alone is not a checkable claim: the sweep is
     * global, so any other armed flow that happens to reference the same tool is
     * counted too. `kestra:phase3` asserted `suspended === 1` and started failing
     * the moment a second armed flow in the same workspace also used `mail_send`
     * — a correct sweep reported as a regression. A caller that wants to know
     * "did MY flow go stale" has to be able to ask that.
     */
    suspendedFlowIds: string[];
  }> {
    const armed = await flowRepo.listLive();
    const suspendedFlowIds: string[] = [];
    for (const flow of armed) {
      try {
        const r = await this.checkStaleness(flow.workspaceId, flow);
        if (r.stale) {
          suspendedFlowIds.push(flow.id);
          console.warn(`[approval-sweep] suspended "${flow.name}" (${flow.id}): ${r.reason}`);
        }
      } catch (e) {
        console.warn(`[approval-sweep] ${flow.id}: ${(e as Error).message}`);
      }
    }
    return { checked: armed.length, suspended: suspendedFlowIds.length, suspendedFlowIds };
  },

  /**
   * The `begin` gate for an execution in the LIVE namespace.
   *
   * Returns the revision that is allowed to run, or throws. Three things have to
   * hold, and the fingerprint check is the one that is easy to leave out: the
   * trigger being deployed proves an approval EXISTED, not that it is still
   * valid, and a schedule that fires between a tool changing shape and the next
   * sweep would otherwise run unapproved.
   */
  async assertMayRunLive(workspaceId: string, flow: Flow): Promise<number> {
    if (flow.armedRevision == null) {
      throw httpError(`flow "${flow.name}" has no approved revision`, 403);
    }
    const approval = await flowRepo.currentApproval(flow.id, flow.armedRevision);
    if (!approval) {
      throw httpError(
        `flow "${flow.name}" revision ${flow.armedRevision} is not currently approved`,
        403,
      );
    }
    const model = await modelOf(flow, flow.armedRevision);
    if (approval.selfEnabled) {
      const refusal = await this._selfEnabledRefusal(workspaceId, flow, model);
      if (refusal) throw httpError(refusal, 403);
    }
    const { fingerprint } = await fingerprintNow(workspaceId, model, flow.ownerSubject ?? null);
    if (fingerprint !== approval.manifestFingerprint) {
      // Do not suspend from here. `begin` is on the execution path and this
      // request has already been refused; a Kestra redeploy inside it would put
      // a control-plane write behind a callback whose failure mode is a retry
      // storm. The sweep does the suspending.
      throw httpError(
        `approval for "${flow.name}" revision ${flow.armedRevision} is stale — a referenced tool ` +
          "or datasource query changed shape since it was approved",
        403,
      );
    }
    return flow.armedRevision;
  },

  /** Everything a UI needs to explain the gate, including why it is blocked. */
  async state(workspaceId: string, flow: Flow): Promise<ApprovalState> {
    const approval =
      flow.armedRevision == null ? null : ((await flowRepo.currentApproval(flow.id, flow.armedRevision)) ?? null);
    const draftAhead = flow.armedRevision == null || flow.draftRevision > flow.armedRevision;

    let blockedReason: string | null = null;
    if (flow.draftRevision < 1) {
      blockedReason = "This flow has no revision yet.";
    } else if (!(await flowExecutionRepo.hasSucceeded(flow.id))) {
      blockedReason =
        "This flow has never completed a run. Start a test run and check the result before approving it " +
        "to run unattended.";
    } else if (!draftAhead && approval) {
      blockedReason = null;
    }

    return {
      armedRevision: flow.armedRevision,
      approval,
      status: (flow.status as FlowStatus) ?? "draft",
      draftAhead,
      blockedReason,
    };
  },

  /**
   * What changed between two revisions — what the approver is actually signing
   * off (`RevisionDiff.tsx`).
   *
   * Reports the STRUCTURE/fragment split §6.5 turns on, because they are not the
   * same review: a structure change means different systems get touched, and a
   * fragment change with an unchanged contract means the same ones do.
   */
  async diff(workspaceId: string, flowId: string, from: number | null, to: number) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    const toRow = await flowRepo.getRevision(flow.id, to);
    if (!toRow) throw httpError(`revision ${to} does not exist`, 404);
    const fromRow = from == null ? null : await flowRepo.getRevision(flow.id, from);

    const toSteps = await flowRepo.listSteps(flow.id, to);
    const fromSteps = fromRow ? await flowRepo.listSteps(flow.id, from!) : [];
    const before = new Map(fromSteps.map((s) => [s.stepId, s]));
    const after = new Map(toSteps.map((s) => [s.stepId, s]));

    const added = toSteps.filter((s) => !before.has(s.stepId)).map((s) => s.stepId);
    const removed = fromSteps.filter((s) => !after.has(s.stepId)).map((s) => s.stepId);
    const changed = toSteps
      .filter((s) => {
        const b = before.get(s.stepId);
        return b && JSON.stringify(b.configJson) !== JSON.stringify(s.configJson);
      })
      .map((s) => s.stepId);

    const structureChanged = !fromRow || fromRow.structureHash !== toRow.structureHash;
    return {
      from: fromRow?.revision ?? null,
      to,
      added,
      removed,
      changed,
      structureChanged,
      /**
       * §6.5's asymmetry, stated for the UI. Structure → human re-approval.
       * Fragment body only, contract unchanged → automated re-test, approval
       * carries over. Written as every-regeneration-invalidates, the gate gets
       * disabled: at 1-of-3 first-pass accuracy you regenerate constantly.
       */
      requires: structureChanged ? "human_reapproval" : "automated_retest",
    };
  },
};
