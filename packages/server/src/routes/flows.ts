import { Router } from "express";
import { flowActivationService } from "../services/flow-activation.service.js";
import { chooseAccount, readinessOf } from "../services/readiness.service.js";
import { actsAsOwner, EACH_PERSON, runAsProblems, runAsView, setRunAs, type PiRunAs } from "../services/run-as.service.js";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { checkState, engineReaderKinds, errorsOf, type EFlow } from "@foundry/flow-edit";
import {
  flowService,
  createFlowSchema,
  saveRevisionSchema,
  updateFlowSchema,
} from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { flowIntegrationService } from "../services/flow-integration.service.js";
import { flowPortabilityService } from "../services/flow-portability.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { regenerateStep } from "../services/flow-generation.service.js";

import { FragmentContractError, type StepContract } from "../services/step-contract.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import { flowCompiler } from "../services/flow-compiler.service.js";
import { authorOf, requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";

import { flowExpectationService } from "../services/flow-expectation.service.js";
import { requesterOf } from "../services/run-requester.js";
import { flowRunnerService } from "../services/flow-runner.service.js";
import { describeSelection, refsUsedBy, unpreferredRefs } from "../services/flow-selection.js";
import {
  applyInputValues,
  confirmInputsSchema,
  UnknownInputError,
} from "../services/flow-inputs.js";
import { flowInputFormat, type FlowInputFormat } from "../services/flow-input-format.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { phaseService } from "../services/flow-phase.service.js";
import { db } from "../db/index.js";
import { flowRevisions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import * as builder from "../services/builder/builder.service.js";
import * as canvas from "../services/builder/canvas.service.js";
import { choiceReadback } from "../services/builder/choice-readback.js";
import { goalSpecSchema, type GoalSpec } from "../services/builder/goal-spec.js";
import { validate } from "../services/builder/strict-schema.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { parsePlace, projectService } from "../services/project.service.js";
import { requireFlowManager } from "../middleware/content-guard.middleware.js";
import { workspaceMemberService } from "../services/workspace-member.service.js";
import { platformUserService } from "../services/platform-user.service.js";
import { auditService } from "../services/audit.service.js";
import { reachOf } from "../services/automation-reach.js";
import { isPiModel } from "../services/pi-flow.service.js";

/**
 * Who owns each automation, as a name a person can read (rbac-observability). A workspace member's email first, then
 * whoever this deployment has seen sign in, else null — never the raw subject, which is an Entra OID.
 */
async function ownerNames(workspaceId: string): Promise<(subject: string | null | undefined) => string | null> {
  const [members, users] = await Promise.all([
    workspaceMemberService.list(workspaceId).catch(() => []),
    platformUserService.list().catch(() => []),
  ]);
  const names = new Map<string, string>();
  for (const u of users) names.set(u.subject, u.name?.trim() || u.email);
  for (const m of members) if (!names.has(m.subject)) names.set(m.subject, m.email);
  return (subject) => (subject ? (names.get(subject) ?? null) : null);
}
/**
 * Flow CRUD, revisions and draft test runs.
 * Mounted at `/api/workspaces/:workspaceId/flows` behind `requireApiKey`.
 * archive/kestra-migration/07-refactor-inventory.md §7.2
 *
 * Note what is NOT here: nothing on this router can write to the live namespace.
 * Promotion is `routes/approvals.ts` only. `POST /:flowId/test-run` starts a
 * DRAFT execution and cannot be pointed anywhere else — the namespace is chosen
 * server-side from the workspace, never from the request (R4).
 */
export const flowsRouter = Router({ mergeParams: true });

flowsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Only what this person may see: their own drafts, every published automation, and everything for an Admin or
    // a Reviewer (rbac-observability, `content-visibility.service.ts`).
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
    const rows = (await flowService.list(req.params.workspaceId)).filter(({ flow }) => contentVisibility.flowVisible(viewer, flow));
    /**
     * `?view=scheduled&limit=N` (2026-10-11, the dashboard's "Coming up") — only the automations that fire on a
     * timer (`schedule` is the cron actually firing, from `firingCronsFor`), and only what that card prints. It
     * skips the per-row approval state the full list computes, so the home page no longer downloads every
     * workflow to show four.
     *
     * ⚠ Only flows that RUN UNATTENDED. `schedule` falls back to the DRAFT's cron when nothing is armed
     * (`firingRevisionOf`), so filtering on the cron alone listed drafts that will never fire. The statuses are the
     * client's `RUNS_UNATTENDED` table (`lib/flow-views.ts`): `draft_pending` still fires its approved revision;
     * `draft` and `suspended` fire nothing.
     */
    if (req.query.view === "scheduled") {
      const limit = Math.min(Math.max(Number(req.query.limit) || 4, 1), 50);
      const firing = new Set(["armed", "approved", "draft_pending"]);
      const scheduled = rows.filter(({ flow }) => firing.has(flow.status) && (flow.schedule ?? "").trim().length > 0);
      res.json({
        flows: scheduled.slice(0, limit).map(({ flow }) => ({ id: flow.id, name: flow.name, schedule: flow.schedule })),
        total: scheduled.length,
      });
      return;
    }
    /**
     * ⚠ **`version` IS THE APPROVAL COUNT, NOT `armed_revision`.** A revision is
     * written on every edit, so the number the list used to print climbed while
     * somebody was still drafting — the defect this closes. One grouped query
     * for the page, not one per row. `null` for an automation nobody has
     * approved, which is honest: it has no version yet, rather than `v1`.
     */
    const [versions, nameOf, projectNames] = await Promise.all([
      flowRepo.approvalCountsFor(rows.map((r) => r.flow.id)),
      ownerNames(req.params.workspaceId),
      projectService.namesIn(req.params.workspaceId),
    ]);
    res.json({
      flows: await Promise.all(
        rows.map(async ({ flow, approval }) => ({
          ...flow,
          ownerName: nameOf(flow.ownerSubject),
          /** Where it lives, when that is a project (sharing-boundaries phase 5). */
          projectName: flow.projectId ? (projectNames.get(flow.projectId) ?? null) : null,
          /** The person asking owns it — the Workflows list's "Mine" tab. */
          mine: viewer.subject != null && flow.ownerSubject === viewer.subject,
          approval,
          version: versions.get(flow.id) ?? null,
          approvalState: await flowApprovalService.state(req.params.workspaceId, flow),
        })),
      ),
    });
  }),
);

flowsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { createdBy, ...input } = createFlowSchema.parse(req.body);
    const { flow, revision } = await flowService.create(req.params.workspaceId, {
      ...input,
      // archive/GAPS.md §1.2 — the body's `createdBy` is an INPUT to `authorOf`, never a
      // value that reaches the service. It is refused outright from a signed-in
      // caller and stamped `system` otherwise.
      author: authorOf(req, createdBy),
    });
    res.status(201).json({ flow, revision });
  }),
);

/**
 * P6 — last run for one flow (honest-empty). Joins `engineStatus` via
 * `flowVisibilityService.list` so `Running` (= isLive(engineStatus) || status running)
 * and `Failed` (= status failed || stopped) read the engine, not the stale row.
 * Returns `{ execution: null }` when the flow never ran rather than 404 — the
 * tab then counts 0, not hides (S-28 Layout). Must sit BEFORE `GET /:flowId`
 * or Express would treat "last-run" as a flow id.
 */
/**
 * `GET …/flows/:flowId/integration` — how to call this flow from outside.
 *
 * ⚠ **Mounted BEFORE `/:flowId`**, like every other sub-path on this router:
 * Express matches in declaration order and `/:flowId` would otherwise swallow
 * the word `integration` as a flow id and answer 404.
 *
 * Read-only, and it returns no secret value — the api token is already in the
 * path it prints (that IS the addressing), and the Bearer is described by
 * WHERE it comes from rather than by what it is. There is deliberately no
 * `?reveal=`, the same rule the secrets audit follows.
 */
flowsRouter.get(
  "/:flowId/integration",
  asyncHandler(async (req, res) => {
    res.json(await flowIntegrationService.get(req.params.workspaceId, req.params.flowId));
  }),
);

flowsRouter.get(
  "/:flowId/last-run",
  asyncHandler(async (req, res) => {
    const found = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!found) return res.status(404).json({ error: "not_found" });
    const all = await flowVisibilityService.list(req.params.workspaceId, 200);
    const filtered = all.filter((e) => e.flowId === req.params.flowId);
    filtered.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    res.json({ execution: filtered[0] ?? null });
  }),
);
/**
 * The flow's INCOMPLETE working copy, re-judged against the catalogue as it is now (compiled-builder D-319): the engine
 * state, its holes, and every diagnostic — a hole is severity `hole`, never `error`. `{incomplete: null}` when there is
 * none. Read-only here: a working copy is written by the builder through `flowService.saveIncomplete`, which the engine's
 * ops feed, so no route accepts a hand-posted model with holes in it.
 */
flowsRouter.get(
  "/:flowId/incomplete",
  asyncHandler(async (req, res) => {
    res.json({ incomplete: await flowService.getIncomplete(req.params.workspaceId, req.params.flowId) });
  }),
);

/**
 * The readback of CHOICES for a revision (compiled-builder phase 8, P6): every step and bound input — what was chosen, from how
 * many options, by whom — least-certain first, beside the confirmed goal and the spec-match result. `?revision=` defaults to the
 * draft. `{legacy}` for a revision the engine cannot read (built before the compiled builder): it has no choices to read back.
 */
flowsRouter.get(
  "/:flowId/choices",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    const n = req.query.revision !== undefined ? z.coerce.number().int().min(1).parse(req.query.revision) : flow.draftRevision;
    const rev = n > 0 ? await flowRepo.getRevision(flow.id, n) : undefined;
    if (!rev) return res.status(404).json({ error: "no such revision" });
    const { cat } = await builder.builderCatalogue(req.params.workspaceId);
    const model = rev.modelJson as { steps: unknown[] };
    const start = engineReaderKinds({ ...(model as unknown as EFlow), inputs: (model as { inputs?: EFlow["inputs"] }).inputs ?? [], holes: [] });
    if (errorsOf(checkState(start, cat)).length) return res.json({ legacy: "this revision was built before the compiled builder; its steps carry expressions, not choices" });
    const build = rev.goalSpec ? { goalSpec: rev.goalSpec, trace: rev.buildTrace } : null;
    res.json({ revision: n, ...choiceReadback(model, build as never, cat) });
  }),
);

/** The state the canvas opens on, its listed actions and diagnostics — or `{legacy}` for a draft the engine cannot read. */
flowsRouter.get(
  "/:flowId/canvas",
  asyncHandler(async (req, res) => {
    res.json(await canvas.canvasOpen(req.params.workspaceId, req.params.flowId));
  }),
);
/**
 * Whether this person may switch the draft on themselves (plugins phase 9), and why not when they may not — the
 * same reach the server enforces in `enableOwn`, never a client-side guess. Null for an automation not built with
 * Forge, which a reviewer always approves.
 */
async function selfEnableView(workspaceId: string, flow: { runtime: string; ownerSubject: string | null; visibility: string; projectId?: string | null }, draftModel: unknown, subject: string | null) {
  if (flow.runtime !== "foundry" || !isPiModel(draftModel)) return null;
  const ws = await workspaceRepo.get(workspaceId);
  const reach = await reachOf(workspaceId, draftModel, flow.ownerSubject, flow);
  const owner = !!subject && subject === flow.ownerSubject;
  return {
    /** The workspace lets members switch on their own automations that use only their own things. */
    allowed: ws?.selfEnable === true,
    ownOnly: reach.ownOnly,
    /** Each thing of the workspace's the draft uses — why a reviewer approves it. */
    needsReviewerFor: reach.workspace,
    own: reach.own,
    /** This person may press "Switch on" for the draft. */
    youMay: owner && ws?.selfEnable === true && reach.ownOnly,
  };
}

flowsRouter.get(
  "/:flowId",
  asyncHandler(async (req, res) => {
    const found = await flowService.get(req.params.workspaceId, req.params.flowId);
    if (!found) return res.status(404).json({ error: "not_found" });
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
    const [approvalState, allExecutions, nameOf] = await Promise.all([
      flowApprovalService.state(req.params.workspaceId, found.flow),
      // Only the runs this person may see — a Creator looking at a published automation sees its live runs and their
      // own tests, not somebody else's test runs.
      flowVisibilityService.list(req.params.workspaceId, 200, contentVisibility.runsWhere(viewer)),
      ownerNames(req.params.workspaceId),
    ]);
    const executions = (allExecutions ?? []).filter((e) => e.flowId === found.flow.id);
    // What this automation's designer was pointed at, resolved to names — 3.3.
    // ⚠ Null when nobody chose, which is NOT an empty list: null means nothing
    // was preferred, and an empty list would mean nothing was pointed at, which
    // nothing can produce. Entries carry `present`, so a datasource deleted
    // since the design shows as gone rather than vanishing from the record.
    //
    // ── ⚠ And whether each one was USED (D-114) ──────────────────────────────
    //
    // Derived HERE, on every read, from the draft revision's own refs — not
    // captured at generation and stored. A stored answer would keep saying
    // "unused" about a choice somebody has since wired in on the canvas, and
    // this note's whole justification is that it is an observation rather than
    // a verdict. It is computed against the DRAFT revision because that is what
    // the review screen shows; the armed revision has already been approved by
    // someone who could see this.
    /**
     * WARNING **READ THROUGH `getRevision`, NEVER OFF `found.revisions`** - and this
     * line used to do the latter, which made it null for very nearly every
     * flow on the deployment.
     *
     * `flowService.get`'s `revisions` is `listRevisions`, the ONE place
     * `hidden_at` is honoured - it is the version list a person reads. A chat
     * turn writes its revision already hidden (that is what stops every
     * sentence typed becoming a version), so a flow built in the chat builder
     * and not yet saved has `revisions: []` while `flow.draftRevision` is 1.
     * Measured on the live deployment: **every revision of every flow was
     * hidden**, so `.find(...)` returned undefined every time.
     *
     * Two things were computed off it and both failed SILENTLY in the
     * direction that reads as a product defect:
     *
     *   - `usedRefs` came back empty, so `designedAgainst` reported every
     *     design choice as UNUSED on a flow that uses them.
     *   - `draftModel` is what the client's `getFlowReview` needs to build an
     *     editable model, and a null one renders as *"this draft could not be
     *     read as an editable model"* under every node in the inspector.
     *
     * So it is answered here, from the unfiltered read, and SERVED as
     * `draftModel` - one query, one source, both consumers. A second
     * reconstruction on the client (from the step rows, which are not
     * filtered) would be a second definition of what a draft IS.
     */
    const draftRevisionRow = await flowRepo.getRevision(found.flow.id, found.flow.draftRevision);
    const draftModel = draftRevisionRow?.modelJson;
    // ⚠ The test drawer renders from THESE formats, derived with the same
    // `flowInputFormat(input, steps, value)` call the trigger surfaces use — so
    // the two cannot disagree. `value` is the declared default, the only value
    // this route can see.
    const draftInputs =
      ((draftModel as { inputs?: Array<{ id: string; type?: string; defaults?: string }> } | undefined)
        ?.inputs ?? []);
    const draftSteps =
      ((draftModel as { steps?: Array<Record<string, unknown>> } | undefined)?.steps ?? []);
    const inputFormats: Record<string, FlowInputFormat> = Object.fromEntries(
      draftInputs.map((input) => [input.id, flowInputFormat(input, draftSteps, input.defaults ?? null)]),
    );
    const usedRefs = refsUsedBy(draftModel as { steps?: unknown[] } | undefined);
    const designedAgainst = found.flow.designSelection
      ? describeSelection(
          found.flow.designSelection,
          {
            datasources: await datasourceRepo.listByWorkspace(req.params.workspaceId),
            tools: await toolRepo.listByWorkspace(req.params.workspaceId),
          },
          usedRefs,
        )
      : null;
    res.json({
      ...found,
      flow: { ...found.flow, ownerName: nameOf(found.flow.ownerSubject) },
      /** What this person may do about ownership: only an Admin moves an automation to somebody else. */
      canChangeOwner: viewer.all,
      /** May this person edit it: they may build at all, and it is theirs (or they are an Admin). */
      canChange: viewer.write === true && contentVisibility.flowChangeable(viewer, found.flow),
      /**
       * May this person MANAGE it — delete it, private/view-only, whose account, switch on/off, ask for approval
       * (sharing-boundaries phase 2). An editor of a shared workflow has `canChange` and not this.
       */
      canManage: viewer.write === true && contentVisibility.flowManageable(viewer, found.flow),
      approvalState,
      selfEnable: await selfEnableView(req.params.workspaceId, found.flow, draftRevisionRow?.modelJson, viewer.subject),
      executions,
      designedAgainst,
      /**
       * The draft revision's model, whether or not that revision is in the
       * version list above. See `draftModel` for why the two differ.
       *
       * WARNING **`revisions` is a DISPLAY concern and this is a DATA one.** They
       * were one array serving both, which is how hiding a revision from a
       * list also hid it from the editor.
       */
      draftModel: draftModel ?? null,
      // Beside `draftModel` by construction: the drawer reads these, derived
      // from that same model, and never recomputes them client-side.
      inputFormats,
      // The other half of the sentence — *"you pointed at X; this used Y"*.
      // Empty when nothing was pointed at, so the client renders nothing.
      usedInstead: designedAgainst ? unpreferredRefs(designedAgainst, usedRefs) : [],
    });
  }),
);

/**
 * Rename, or reword the description. Metadata only, and never a revision —
 * `flowService.updateMeta` says why a rename that wrote one would unarm a live
 * automation for a typo.
 */
flowsRouter.patch(
  "/:flowId",
  asyncHandler(async (req, res) => {
    const patch = updateFlowSchema.parse(req.body);
    const flow = await flowService.updateMeta(req.params.workspaceId, req.params.flowId, patch);
    res.json({ flow });
  }),
);

/**
 * Move an automation to another owner (rbac-observability). Admin only — the route's permission is
 * `content.read.others`, which only the Admin preset holds. The new owner must be a member of this workspace who may
 * build (an Observer cannot own work they may not change). `null` leaves it with nobody, which is what an
 * automation from before owners existed has; then only Admins and Reviewers see it until it is published.
 */
const setOwnerSchema = z.object({ subject: z.string().min(1).max(512).nullable() }).strict();
flowsRouter.put(
  "/:flowId/owner",
  asyncHandler(async (req, res) => {
    const { subject } = setOwnerSchema.parse(req.body);
    const ws = req.params.workspaceId;
    const found = await flowService.get(ws, req.params.flowId);
    if (!found) return res.status(404).json({ error: "not_found" });
    if (subject) {
      const member = await workspaceMemberService.find(ws, subject);
      if (!member) return res.status(400).json({ error: "not_a_member", message: "That person is not a member of this workspace." });
      if (member.role === "viewer") {
        return res.status(400).json({ error: "observer", message: "An Observer cannot own a workflow: they may not change it." });
      }
    }
    const flow = await flowRepo.setOwner(ws, req.params.flowId, subject);
    const nameOf = await ownerNames(ws);
    // ⚠ A workflow approved to act as the OLD owner's own account must not act as it for the new one (plugins 8.6):
    // it is turned off, saying why, until its connection is chosen again and approved.
    if (flow?.armedRevision != null && flow.runtime === "foundry") {
      // ⚠ Switched on by its OLD owner with no reviewer (plugins phase 9): that was their choice about their own
      // things, not the new owner's — it is turned off, and the new owner switches it on themselves.
      const current = await flowRepo.currentApproval(flow.id, flow.armedRevision);
      if (current?.selfEnabled && subject !== found.flow.ownerSubject) {
        await flowApprovalService.revoke(ws, flow.id, {
          reason: "Its owner changed. It was switched on by its previous owner; its new owner switches it on themselves, or a reviewer approves it.",
          revokedBy: req.user?.email ?? req.user?.subject ?? "unknown",
        });
      }
      const armed = await flowRepo.getRevision(flow.id, flow.armedRevision);
      const problems = await runAsProblems(ws, (armed?.modelJson as { accounts?: Record<string, PiRunAs> } | undefined)?.accounts, subject ?? null);
      if (problems.length) {
        await flowApprovalService.revoke(ws, flow.id, {
          reason: `Its owner changed and ${problems.join("; ")}. Choose its connection again, then approve it.`,
          revokedBy: req.user?.email ?? req.user?.subject ?? "unknown",
        });
      }
    }
    await auditService
      .record({
        workspaceId: ws,
        actor: req.user?.email ?? req.user?.subject ?? "unknown",
        operation: "update",
        entity: "flow",
        entityId: req.params.flowId,
        description: `Owner of "${found.flow.name}" changed from ${nameOf(found.flow.ownerSubject) ?? "nobody"} to ${nameOf(subject) ?? "nobody"}`,
        whereText: found.flow.name,
        whereEntityType: "flow",
        whereEntityId: req.params.flowId,
      })
      .catch((e) => console.error("[flows] owner change not audited:", e));
    res.json({ flow: flow ? { ...flow, ownerName: nameOf(flow.ownerSubject) } : null });
  }),
);

/**
 * Who may EDIT a shared workflow (sharing-boundaries phase 2): `othersMayEdit` — members edit it, or only view it. Its
 * owner chooses (or an Admin); the content guard holds it to whoever manages this workflow. Audited.
 *
 * ⚠ WHERE it lives is NOT changed here (sharing-boundaries phase 7, P7-D1). This route used to take `visibility`
 * (`private`/`public`, plugins phase 9); that was a second way to move a workflow which skipped the Move preview, so a
 * move that narrows who sees it could happen without first saying who loses it and what it switches off (Q5). A body
 * naming `visibility` is refused with `use_move`, never silently ignored — an ignored field reads as one that worked.
 */
const visibilitySchema = z
  .object({ visibility: z.string().optional(), othersMayEdit: z.boolean().optional() })
  .strict()
  .refine((b) => b.visibility !== undefined || b.othersMayEdit !== undefined, "Say what to change: whether others may edit it.");
flowsRouter.put(
  "/:flowId/visibility",
  requireIdentity,
  // Managing, not editing: its owner's or an Admin's (sharing-boundaries phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const body = visibilitySchema.parse(req.body ?? {});
    if (body.visibility !== undefined) {
      return res.status(409).json({
        error: "use_move",
        message: "Where a workflow lives changes with Move, which says first who would gain or lose it: POST …/flows/:flowId/move.",
      });
    }
    const ws = req.params.workspaceId!;
    const found = await flowRepo.get(ws, req.params.flowId!);
    if (!found) return res.status(404).json({ error: "not_found" });
    const othersMayEdit = body.othersMayEdit ?? found.othersMayEdit;
    // ⚠ A workflow that acts as its owner's own account is view-only for everyone else (sharing-boundaries D4).
    if (body.othersMayEdit === true) {
      for (const rev of [found.draftRevision, found.armedRevision]) {
        if (!rev) continue;
        const r = await flowRepo.getRevision(found.id, rev);
        if (actsAsOwner((r?.modelJson as { accounts?: Record<string, PiRunAs> } | undefined)?.accounts)) {
          return res.status(409).json({
            error: "runs_as_owner",
            message: "It runs on its owner's own account, so others can only view it. Change Runs as to the workspace's account or to each person's own first.",
          });
        }
      }
    }
    const flow = found.othersMayEdit === othersMayEdit ? found : await flowRepo.update(found.id, { othersMayEdit });
    if (found.othersMayEdit !== othersMayEdit) {
      await auditService
        .record({
          workspaceId: ws,
          actor: req.user?.email ?? req.user?.subject ?? "unknown",
          operation: "update",
          entity: "flow",
          entityId: found.id,
          description: `"${found.name}": ${othersMayEdit ? "members may edit it while it is shared" : "view-only for members — only its owner and Admins edit it"}`,
          whereText: found.name,
          whereEntityType: "flow",
          whereEntityId: found.id,
        })
        .catch((e) => console.error("[flows] edit setting not audited:", e));
    }
    res.json({ flow });
  }),
);

/**
 * Where a workflow lives (sharing-boundaries phase 5): My space, a project, or the Workspace. The preview says, BEFORE
 * it moves, who would stop seeing it, whether it runs on its own, who turned it on for themselves and would lose it,
 * and the chats that use it (Q5). Moving is its manager's (owner or Admin); into a project, only for somebody in it.
 */
flowsRouter.get(
  "/:flowId/move-preview",
  requireIdentity,
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const to = parsePlace(z.string().parse(req.query.to ?? ""));
    if (!to) return res.status(400).json({ error: "bad_place", message: "Say where to: mine, workspace, or project:<id>." });
    const preview = await projectService.movePreview(req.params.workspaceId!, { kind: "flow", id: req.params.flowId! }, to);
    if (!preview) return res.status(404).json({ error: "not_found" });
    res.json(preview);
  }),
);

flowsRouter.post(
  "/:flowId/move",
  requireIdentity,
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const { to: raw } = z.object({ to: z.string().min(1).max(64) }).strict().parse(req.body ?? {});
    const to = parsePlace(raw);
    if (!to) return res.status(400).json({ error: "bad_place", message: "Say where to: mine, workspace, or project:<id>." });
    const ws = req.params.workspaceId!;
    const out = await projectService.move(ws, { kind: "flow", id: req.params.flowId! }, to, await contentVisibility.viewer(req.user, ws), req.user?.email ?? req.user?.subject ?? "unknown");
    res.json({ flow: await flowRepo.get(ws, req.params.flowId!), ...out });
  }),
);

/**
 * Ask a reviewer to approve (sharing-boundaries 2026-10-30). Reviewers judge whether a workflow is valid, and see a
 * PRIVATE one only once its owner asks (or once it is live) — so this is what puts it in front of them, and it is the
 * owner's choice (`flows.write`; the content guard holds it to whoever may change this workflow). `revision` defaults
 * to the draft. Approving any revision answers it; DELETE withdraws it. Audited both ways.
 */
const reviewRequestSchema = z.object({ revision: z.number().int().min(1).optional() }).strict();
flowsRouter.post(
  "/:flowId/review-request",
  requireIdentity,
  // Managing, not editing: its owner's or an Admin's (sharing-boundaries phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const { revision: asked } = reviewRequestSchema.parse(req.body ?? {});
    const ws = req.params.workspaceId!;
    const found = await flowRepo.get(ws, req.params.flowId!);
    if (!found) return res.status(404).json({ error: "not_found" });
    const revision = asked ?? found.draftRevision;
    if (!(await flowRepo.getRevision(found.id, revision))) {
      return res.status(404).json({ error: "not_found", message: `This workflow has no version ${revision}.` });
    }
    const actor = req.user?.email ?? req.user?.subject ?? "unknown";
    const flow = await flowRepo.update(found.id, { reviewRequestedRevision: revision, reviewRequestedBy: actor, reviewRequestedAt: new Date() });
    await auditService
      .record({
        workspaceId: ws,
        actor,
        operation: "update",
        entity: "flow",
        entityId: found.id,
        description: `"${found.name}": approval asked for — reviewers can now see it`,
        whereText: found.name,
        whereEntityType: "flow",
        whereEntityId: found.id,
      })
      .catch((e) => console.error("[flows] review request not audited:", e));
    res.json({ flow });
  }),
);

flowsRouter.delete(
  "/:flowId/review-request",
  requireIdentity,
  // Managing, not editing: its owner's or an Admin's (sharing-boundaries phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId!;
    const found = await flowRepo.get(ws, req.params.flowId!);
    if (!found) return res.status(404).json({ error: "not_found" });
    if (found.reviewRequestedRevision == null) return res.json({ flow: found });
    const actor = req.user?.email ?? req.user?.subject ?? "unknown";
    const flow = await flowRepo.update(found.id, { reviewRequestedRevision: null, reviewRequestedBy: null, reviewRequestedAt: null });
    await auditService
      .record({
        workspaceId: ws,
        actor,
        operation: "update",
        entity: "flow",
        entityId: found.id,
        description: `"${found.name}": request for approval withdrawn`,
        whereText: found.name,
        whereEntityType: "flow",
        whereEntityId: found.id,
      })
      .catch((e) => console.error("[flows] review withdrawal not audited:", e));
    res.json({ flow });
  }),
);

/**
 * Switch an automation on yourself (plugins phase 9): its OWNER, no reviewer, only when the revision uses nothing
 * but the owner's own things — `flowApprovalService.enableOwn` decides from the revision, and refuses otherwise
 * naming what needs a reviewer. `revision` defaults to the draft.
 */
flowsRouter.post(
  "/:flowId/switch-on",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { revision } = z.object({ revision: z.number().int().min(1).optional() }).strict().parse(req.body ?? {});
    const out = await flowApprovalService.enableOwn(req.params.workspaceId!, req.params.flowId!, {
      ...(revision ? { revision } : {}),
      subject: req.user!.subject,
      actor: req.user?.email || req.user!.subject,
    });
    res.status(201).json(out);
  }),
);

/**
 * Switch your own automation off (plugins phase 9). Stopping one is always its owner's to do (or an Admin's — the
 * content guard holds the route to whoever may change it); a Reviewer turns anybody's off through the approvals
 * route as before. Turning off never needs more than turning on.
 */
flowsRouter.post(
  "/:flowId/switch-off",
  requireIdentity,
  // Managing, not editing: its owner's or an Admin's (sharing-boundaries phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(1).max(2000).optional() }).strict().parse(req.body ?? {});
    const actor = req.user?.email || req.user!.subject;
    res.json(
      await flowApprovalService.revoke(req.params.workspaceId!, req.params.flowId!, {
        reason: reason ?? `Switched off by ${actor}.`,
        revokedBy: actor,
      }),
    );
  }),
);

/**
 * "Runs as": per connected service a Forge workflow uses, the connection it acts as — the draft's, the approved one's,
 * and what this person may choose (their own account only if they own the workflow). Plugins 8.6.
 */
flowsRouter.get(
  "/:flowId/run-as",
  asyncHandler(async (req, res) => {
    res.json(await runAsView(req.params.workspaceId!, req.params.flowId!, req.user?.subject ?? null));
  }),
);

/** Change what one service runs as: a new draft revision, approved again before a live run uses it. */
flowsRouter.put(
  "/:flowId/run-as",
  requireIdentity,
  // Managing, not editing: its owner's or an Admin's (sharing-boundaries phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const { piece, connectionId } = z
      .object({ piece: z.string().min(1).max(200), connectionId: z.union([z.string().uuid(), z.literal(EACH_PERSON)]) })
      .strict()
      .parse(req.body ?? {});
    const out = await setRunAs(req.params.workspaceId!, req.params.flowId!, piece, connectionId, req.user!.subject, authorOf(req, undefined));
    void auditService
      .record({
        workspaceId: req.params.workspaceId!,
        actor: req.user?.email ?? req.user!.subject,
        operation: "update",
        entity: "flow",
        entityId: req.params.flowId!,
        description: `Changed which ${piece.replace("@activepieces/piece-", "")} connection the workflow runs as${connectionId === EACH_PERSON ? ": each person's own" : ""} (revision ${out.revision}; needs approving again)`,
        whereText: "Workflows",
        whereEntityType: "flow",
        whereEntityId: req.params.flowId!,
      })
      .catch((e) => console.error("[flows] run-as change not audited:", e));
    res.json({ ...out, ...(await runAsView(req.params.workspaceId!, req.params.flowId!, req.user!.subject)) });
  }),
);

/**
 * Edit → a NEW revision, deployed to draft. The live namespace is untouched, so
 * an armed schedule keeps running the approved revision (§6.5).
 */
flowsRouter.post(
  "/:flowId/revisions",
  asyncHandler(async (req, res) => {
    const { createdBy, ...input } = saveRevisionSchema.parse(req.body);
    const { flow, revision } = await flowService.saveRevision(
      req.params.workspaceId,
      req.params.flowId,
      { ...input, author: authorOf(req, createdBy) },
    );
    res.status(201).json({ flow, revision });
  }),
);

/**
 * Confirm the values this automation's declared inputs should carry.
 * platform-coherence Phase 4 · I-107
 *
 * ── ⚠ WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * It is not a clarification *conversation*, and it is not a retry channel. The
 * body carries values for DECLARED inputs and nothing else — no goal, no
 * instruction, no redraft — and `applyInputValues` refuses an id the model did
 * not declare rather than ignoring it. Re-asking about the goal is a
 * resubmission, and re-asking a refusal is precisely how a correct
 * `insufficient_contract` becomes an invented `period="2023-10"` on attempt two
 * (§6.7, D-38, D-112). The protection is structural: `confirmInputsSchema` has
 * nowhere to put a goal.
 *
 * ── Why it is a revision ────────────────────────────────────────────────────
 *
 * `defaults` is part of what a SCHEDULED run does, so changing one changes
 * behaviour, and behaviour is what approval binds to (§6.5). Storing the values
 * beside the model instead would make two sources for one fact, and the two
 * would eventually disagree about what a run at 03:00 actually used.
 */
flowsRouter.post(
  "/:flowId/inputs",
  asyncHandler(async (req, res) => {
    const { createdBy, values, computed } = confirmInputsSchema.parse(req.body);
    const target = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!target) return res.status(404).json({ error: "not_found" });
    const current = await flowRepo.getRevision(target.id, target.draftRevision);
    // The same refusal `refine` makes, for the same reason: a flow with no
    // readable draft model would have to have one invented to be edited.
    if (!current?.modelJson) {
      return res.status(409).json({
        error: "no_draft",
        message: "this automation has no draft model, so there is nothing to set values on",
      });
    }
    let model: FlowModel;
    try {
      model = applyInputValues(current.modelJson as FlowModel, values, computed);
    } catch (e) {
      if (e instanceof UnknownInputError) {
        return res.status(400).json({ error: "unknown_input", message: e.message });
      }
      throw e;
    }
    const { flow, revision } = await flowService.saveRevision(
      req.params.workspaceId,
      req.params.flowId,
      { model, author: authorOf(req, createdBy) },
    );
    res.status(201).json({ flow, revision });
  }),
);

flowsRouter.get(
  "/:flowId/revisions",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    res.json({ revisions: await flowRepo.listRevisions(flow.id) });
  }),
);

/**
 * Hide one revision from the version list — the Versions tab's "Delete".
 *
 * ⚠ **`requireWorkspaceRole("approver")`, not `author`**, and the reason is what
 * the list is FOR. It is the record of what was approved and what is running; a
 * person who may write drafts is not, by that fact, a person who may decide
 * which of them stop being visible. The same role guards approve and revoke,
 * which are the two operations this one sits between.
 *
 * ⚠ At the ROUTE, like every other role check here (D-67): it needs `req.user`,
 * and a harness calling the service directly has none — in the service it would
 * be satisfied by a constant or break every harness.
 *
 * The service owns the two refusals (draft, live). This owns who may ask.
 */
flowsRouter.delete(
  "/:flowId/revisions/:revision",
  requireIdentity,
  requireWorkspaceRole("approver"),
  asyncHandler(async (req, res) => {
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision)) return res.status(400).json({ error: "bad_revision" });
    const out = await flowService.hideRevision(
      req.params.workspaceId,
      req.params.flowId,
      revision,
    );
    res.json({ revision: out.revision, hidden: true, alreadyHidden: out.alreadyHidden });
  }),
);

/**
 * SAVE DRAFT - put the conversation's current version in the version list.
 *
 * WARNING **`author`, not `approver`, and the asymmetry is deliberate.** Hiding a
 * revision is an editorial act on the record of what was approved, so it takes
 * the role that approves. Saving your own draft is authoring - it is the last
 * step of writing the thing, and requiring an approver to press it would mean
 * nobody could finish a flow alone on a single-operator deployment.
 *
 * The service owns idempotence; this owns who may ask.
 */
flowsRouter.post(
  "/:flowId/save-draft",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const out = await flowService.saveDraft(req.params.workspaceId, req.params.flowId);
    res.json({ revision: out.revision, alreadyVisible: out.alreadyVisible });
  }),
);

flowsRouter.get(
  "/:flowId/revisions/:revision/steps",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision)) return res.status(400).json({ error: "bad_revision" });
    res.json({ steps: await flowRepo.listSteps(flow.id, revision) });
  }),
);

/**
 * B-11 · `flow_phases` — background frames for the builder canvas.
 *
 * Phases are per-revision background frames, not collapsible groups (flows/02:48).
 * The builder still renders derived grouping from `flow_steps.phase_id` when present,
 * but the revision now carries its own frames — Phase 2 builder canvas will read
 * them here. Lane gap 56px is CSS only. Honest-empty when none: no phases is
 * not an error, just a flow that has not been phased.
 */
flowsRouter.get(
  "/:flowId/phases",
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const flowId = req.params.flowId as string;
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });

    const raw =
      (req.query.revision as string | undefined) ??
      (req.query.revisionId as string | undefined) ??
      (req.query.revision_id as string | undefined);

    let revisionId: string | undefined;

    if (raw !== undefined) {
      if (/^\d+$/.test(raw)) {
        const revNum = Number(raw);
        const rev = await flowRepo.getRevision(flowId, revNum);
        if (!rev) return res.status(404).json({ error: "revision_not_found" });
        revisionId = rev.id;
      } else {
        const full = await db.select().from(flowRevisions).where(eq(flowRevisions.id, raw)).limit(1);
        if (full.length === 0 || full[0].flowId !== flowId) {
          return res.status(404).json({ error: "revision_not_found" });
        }
        revisionId = raw;
      }
    } else {
      if (flow.draftRevision !== null && flow.draftRevision !== undefined) {
        const rev = await flowRepo.getRevision(flowId, flow.draftRevision);
        if (rev) revisionId = rev.id;
      }
      if (!revisionId) {
        const revs = await flowRepo.listRevisions(flowId);
        if (revs.length > 0) revisionId = revs[0].id;
      }
    }

    if (!revisionId) return res.json({ phases: [] });
    const phases = await phaseService.list(revisionId);
    res.json({ phases });
  }),
);

/**
 * Claims this flow's own shape implies — archive/GAPS.md §2.3b.
 *
 * ⚠ **A GET, and it writes nothing.** Accepting a suggestion is an ordinary
 * `POST …/revisions` by the person who read it, so a claim never enters a flow
 * without somebody having chosen it. A route that "applied" suggestions would be
 * the system declaring what a flow should produce and then checking its own
 * homework, which is `generation-audit.service.ts`'s failure mode.
 *
 * No inference runs here. See `suggestExpectations` for why the generating half
 * of §2.3b is deliberately NOT this.
 */
flowsRouter.get(
  "/:flowId/expectation-suggestions",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    const revision = await flowRepo.getRevision(flow.id, flow.draftRevision);
    const model = revision?.modelJson;
    res.json({
      suggestions: flowExpectationService.suggestExpectations(
        model,
        flowExpectationService.expectationsOf(model),
      ),
      // ⚠ Served WITH the payload, the same way fragment promotion's caveat is
      // (D-27): a suggestion read as a finding is the failure mode here, and a
      // caveat that lives only in a docblock is one the screen can forget.
      caveat:
        "These follow mechanically from the flow's own shape — no model was asked what this flow " +
        "should produce. They are deliberately weak (“at least one row”, “nothing failed”): a " +
        "suggestion that guessed a number would be inventing the fact the claim exists to pin " +
        "down. Set the numbers yourself, and reject any that are wrong for this flow.",
    });
  }),
);

// ── The one builder (compiled-builder phase 4, D-292) ────────────────────────
//
// understand → (correct, once) → build → (answer, later). ONE entry for a new flow and an edit (task 3): with `flowId` naming
// a flow that has steps, the message is an EDIT — additive only (D-321), starting from its current draft; without one, or on
// an empty flow, it is a goal. Stateless between calls: the client echoes the understood spec,
// and `recheck` re-derives everything in it from the person's words and the catalogue as it is now, so a client can present
// only what the model's own reply is held to. A model reply outside its schema is a 502 (`GatewayDefect`), never a repair.

const understoodBody = z.object({
  goal: z.string().trim().min(1).max(4000),
  texts: z.array(z.string().max(4000)).max(2),
  spec: z.unknown(),
  corrected: z.boolean().optional(),
});
const flowIdField = z.string().uuid().optional();

/** The workspace's catalogue, and — for an edit — the flow and the engine state it starts from (re-read on every call). */
async function builderContext(workspaceId: string, flowId: string | undefined) {
  const { items, cat } = await builder.builderCatalogue(workspaceId);
  const edit = flowId ? await builder.editStart(workspaceId, flowId, cat) : null;
  return { items, cat, flow: edit?.flow, start: edit?.start ?? null, current: edit?.start ? builder.currentLines(edit.start, cat) : undefined };
}
async function understoodFrom(workspaceId: string, sent: z.infer<typeof understoodBody>, flowId: string | undefined) {
  const ctx = await builderContext(workspaceId, flowId);
  const problem = validate(goalSpecSchema(ctx.items), sent.spec);
  if (problem) throw Object.assign(new Error(`the understood goal no longer fits this workspace's catalogue (${problem}); understand the goal again`), { statusCode: 400 });
  const checked = builder.recheck({ ...sent, spec: sent.spec as GoalSpec }, ctx.items);
  // D-324: the drafted per-row messages are re-derived here, never taken from the client.
  const u = builder.withDrafts(ctx.current ? { ...checked, current: ctx.current } : checked, ctx.cat, ctx.start ?? undefined);
  return { u, ...ctx };
}
const understoodView = (u: builder.Understood) => ({ goal: u.goal, texts: u.texts, spec: u.checked.spec, dropped: u.checked.dropped, readback: u.readback, outcome: u.outcome, corrected: u.corrected, edit: !!u.current });

/** The goal as a GoalSpec and its code-written readback, for the person to confirm. One strict model call. */
flowsRouter.post(
  "/builder/understand",
  asyncHandler(async (req, res) => {
    const { goal, flowId } = z.object({ goal: z.string().trim().min(1).max(4000), flowId: flowIdField }).strict().parse(req.body);
    const { items, cat, start, current } = await builderContext(req.params.workspaceId, flowId);
    res.json({ understood: understoodView(builder.withDrafts(await builder.understand(goal, items, builder.modelChooser, undefined, current), cat, start ?? undefined)) });
  }),
);

/** One correction to the readback. A second is `{unresolved}` — a stated disagreement, never another call (D-294). */
flowsRouter.post(
  "/builder/correct",
  asyncHandler(async (req, res) => {
    const body = z.object({ understood: understoodBody, text: z.string().trim().min(1).max(4000), flowId: flowIdField }).strict().parse(req.body);
    const { u, items, cat, start } = await understoodFrom(req.params.workspaceId, body.understood, body.flowId);
    const next = await builder.correct(u, body.text, items, builder.modelChooser);
    res.json("unresolved" in next ? { unresolved: next.unresolved } : { understood: understoodView(builder.withDrafts(next, cat, start ?? undefined)) });
  }),
);

/**
 * Build from a confirmed spec. `answers` carries the readback's "I will ask you" values, keyed by question id
 * (`spec:<i>:<role>`); anything else the build needs becomes a question on the flow's unfinished build, answered through
 * `POST /:flowId/incomplete/answer`. 201 with a revision when complete; 201 with `open` questions when not; 200
 * `cannot` when the workspace has nothing that fits (a refusal is a success, D-38) — and then nothing is written.
 */
flowsRouter.post(
  "/builder/build",
  asyncHandler(async (req, res) => {
    const body = z.object({ understood: understoodBody, answers: z.record(z.string().max(4000)).optional(), name: z.string().trim().min(1).max(200).optional(), flowId: flowIdField }).strict().parse(req.body);
    const { u, items, cat, flow, start } = await understoodFrom(req.params.workspaceId, body.understood, body.flowId);
    const given = body.answers ?? {};
    const answerer = async (qs: Array<{ holeId: string }>) => qs.map((q) => given[q.holeId] ?? null);
    const r = start ? await builder.run(u, items, cat, builder.modelChooser, answerer, start) : await builder.run(u, items, cat, builder.modelChooser, answerer);
    if (r.status === "cannot") return res.status(200).json({ status: "cannot", missing: u.checked.spec.missing, readback: u.readback });
    if (r.status === "unchanged") return res.status(200).json({ status: "unchanged", flowId: flow?.id ?? null, stop: r.trace.stop, calls: r.trace.calls.length });
    const saved = await builder.save(req.params.workspaceId, r.understood ?? u, r, authorOf(req, undefined), body.name, flow);
    const open = r.trace.questions.filter((q) => q.answer === undefined).map((q) => ({ id: q.holeId, ask: q.ask }));
    res.status(201).json({ status: r.status, flowId: saved.flowId, revision: saved.revision ?? null, open, stop: r.trace.stop, calls: r.trace.calls.length });
  }),
);

/** Answer an unfinished build's open questions — each once (409 for an answered one, 400 for one never asked). */
flowsRouter.post(
  "/:flowId/incomplete/answer",
  asyncHandler(async (req, res) => {
    const { answers } = z.object({ answers: z.record(z.string().trim().min(1).max(4000)) }).strict().parse(req.body);
    res.json(await builder.answerIncomplete(req.params.workspaceId, req.params.flowId, answers, authorOf(req, undefined)));
  }),
);

// ── The manual builder (compiled-builder phase 7, D-328/D-329) ─────────────
//
// The canvas is a second front end on the engine: it opens a flow's state, takes ONE listed action at a time, and saves through
// the same funnel. Stateless: every state is signed by the server, and only a signed state is accepted back.

/** A new flow built by hand: an empty flow the canvas opens on. Nothing is deployed until a complete state is saved. */
flowsRouter.post(
  "/canvas",
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    res.status(201).json(await canvas.canvasCreate(req.params.workspaceId, name));
  }),
);

/** Take one action the engine listed for the posted state. 200 `{refused}` for a typed value that does not fit — nothing moves. */
flowsRouter.post(
  "/:flowId/canvas/act",
  asyncHandler(async (req, res) => {
    const body = z.object({ state: z.unknown(), sig: z.string().max(200), actionId: z.string().regex(/^c\d{1,5}$/), value: z.string().max(4000).optional() }).strict().parse(req.body);
    res.json(await canvas.canvasAct(req.params.workspaceId, req.params.flowId, body));
  }),
);

/** Save the canvas: complete → a revision (201), incomplete → the flow's working copy (200). */
flowsRouter.post(
  "/:flowId/canvas/save",
  asyncHandler(async (req, res) => {
    const body = z.object({ state: z.unknown(), sig: z.string().max(200) }).strict().parse(req.body);
    const r = await canvas.canvasSave(req.params.workspaceId, req.params.flowId, body, authorOf(req, undefined));
    res.status(r.status === "complete" ? 201 : 200).json(r);
  }),
);

/** The two GET halves are declared ABOVE `GET /:flowId` — see the note there. */

/**
 * Regenerate ONE `code` step's fragment → a new revision.
 *
 * Triage level 1 as a route. A `contract_violation` costs one fragment, not a
 * redraft of the flow — and assertion 19 is the guarantee that makes that safe:
 * the other steps come out byte-identical, because a fragment is a function of
 * its contract and nothing else.
 *
 * A new revision, never an edit in place. Regenerating is a change to what the
 * flow does, so it must invalidate an approval exactly like any other edit
 * (§6.5). An armed flow keeps running its approved revision and becomes
 * `draft_pending`.
 */
flowsRouter.post(
  "/:flowId/steps/:stepId/regenerate",
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const flow = await flowRepo.get(workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });

    const current = await flowRepo.getRevision(flow.id, flow.draftRevision);
    if (!current) return res.status(404).json({ error: "no_revision" });

    const contracts: Record<string, StepContract> = await flowService.contractsFor(
      flow.id,
      flow.draftRevision,
    );
    if (!contracts[req.params.stepId]) {
      // Not a 404: the step may well exist. It has no contract, which means it
      // was hand-written, and regenerating it would require inventing the
      // standard it is judged against.
      return res.status(409).json({
        error: "no_contract",
        message:
          `step "${req.params.stepId}" has no stored contract, so it cannot be regenerated. ` +
          `Only fragments generated from a contract can be.`,
      });
    }

    let result;
    try {
      result = await regenerateStep(
        current.modelJson as FlowModel,
        contracts,
        req.params.stepId,
      );
    } catch (e) {
      if (e instanceof FragmentContractError) {
        return res.status(422).json({ error: "generation_failed", message: e.message, stepId: e.stepId });
      }
      throw e;
    }

    if (result.outcome.status === "insufficient_contract") {
      return res.status(200).json({
        status: "insufficient_contract",
        stepId: result.outcome.stepId,
        missing: result.outcome.missing,
        reason: result.outcome.reason,
      });
    }

    const { flow: updated, revision } = await flowService.saveRevision(
      workspaceId,
      req.params.flowId,
      // ⚠ This route used to read `req.body.createdBy` DIRECTLY, bypassing
      // `authorOf` — so a signed-in caller could name anyone as the author of a
      // regenerated revision, and gate 2's refusal would then compare against
      // whatever they typed. archive/GAPS.md §1.2. The 400 for a signed-in caller
      // supplying the field is the same one every other write path gives.
      { model: result.model, author: authorOf(req, req.body?.createdBy) },
      contracts,
    );
    res.status(201).json({ status: "ok", flow: updated, revision, attempts: result.outcome.attempts });
  }),
);

// ── Portability (6.2 / 6.3) ──────────────────────────────────────────────────

/**
 * Export a flow revision as a **bundle** — Foundry's model, never Kestra YAML.
 *
 * Defaults to the draft revision: export is an authoring operation, and you share
 * what you are working on. The bundle carries no generated code, no secret
 * values, no execution history and no approval — see
 * `flow-portability.service.ts` for why the CONTRACT travels while the code does
 * not, which is the one part of §5.2 the design left implicit.
 */
flowsRouter.get(
  "/:flowId/export",
  asyncHandler(async (req, res) => {
    const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
    if (revision !== undefined && !Number.isInteger(revision)) {
      return res.status(400).json({ error: "bad_revision" });
    }
    const ws = await workspaceRepo.get(req.params.workspaceId);
    res.json(
      await flowPortabilityService.exportFlow(req.params.workspaceId, req.params.flowId, {
        ...(revision !== undefined ? { revision } : {}),
        ...(ws?.name ? { workspaceName: ws.name } : {}),
        exportedAt: new Date().toISOString(),
      }),
    );
  }),
);

/**
 * Export the draft revision as **Kestra YAML** — the exact source the engine
 * runs for a test run (D-36, user directive 2026-08-13). This is the deployable
 * artifact: it can be pasted into a Kestra UI or `kestra flow create`, and
 * because it is produced by the same `flowCompiler.compile` call
 * `writeRevision` makes — same namespace, same labels, schedule off for the
 * same reason (a draft must not fire unattended) — it is guaranteed to be
 * accepted by the engine the way the portability bundle deliberately is not
 * (the bundle travels between Foundry tenants; this travels to Kestra).
 */
flowsRouter.get(
  "/:flowId/export/kestra",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    const revision = await flowRepo.getRevision(flow.id, flow.draftRevision);
    if (!revision) return res.status(404).json({ error: "no_revision" });
    const { draft } = await flowService.namespaces(req.params.workspaceId);
    const yaml = flowCompiler.compile(revision.modelJson as FlowModel, {
      namespace: draft,
      withSchedule: false,
      labels: {
        foundry_flow: flow.id,
        foundry_revision: String(flow.draftRevision),
        foundry_env: "draft",
      },
    }).yaml;
    res.setHeader("content-disposition", `attachment; filename="${flow.kestraFlowId}.yaml"`);
    res.type("text/yaml").send(yaml);
  }),
);

const importSchema = z.object({
  bundle: z.unknown(),
  /**
   * Origin ref → local ref, supplied by a human. There is deliberately no fuzzy
   * matching: `attendance_below_threshold` → `presence_below_policy` is a guess,
   * the two queries return different units, and a silently-accepted guess is the
   * exact failure class this migration exists to remove.
   */
  refMap: z.record(z.string().max(128)).optional(),
  modelId: z.string().min(1).max(63).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  createdBy: z.string().min(1).max(255).optional(),
});

/**
 * Dry run: every finding, before an inference call is spent.
 *
 * The common case for a cross-tenant import is a list of refs to map, and that is
 * a conversation rather than a failure. Making the caller discover it by
 * attempting the import would spend one generation per `code` step first.
 */
flowsRouter.post(
  "/import/plan",
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body);
    const parsed = flowPortabilityService.flowBundleSchema.safeParse(input.bundle);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_bundle", detail: parsed.error.flatten().fieldErrors });
    }
    const bundle = input.modelId
      ? { ...parsed.data, model: { ...parsed.data.model, id: input.modelId } }
      : parsed.data;
    const plan = await flowPortabilityService.planImport(
      req.params.workspaceId,
      bundle,
      input.refMap ?? {},
    );
    res.json({
      findings: plan.findings,
      warnings: plan.warnings,
      remapped: plan.remapped,
      importable: plan.findings.every((f) => !f.blocking),
      // The contracts, so a reviewer can see what will be generated here — the
      // recipe, before it is cooked.
      contracts: plan.contracts,
    });
  }),
);

/**
 * Import a bundle. Revalidate → generate → create, in that order (04 §5.3.1).
 *
 * **200 with `refusals` is a success**, exactly as on `/generate`: a travelled
 * contract that cannot be satisfied here names the field the recipe assumes and
 * this workspace does not supply, which is the most useful thing an import can
 * say. The flow is not created.
 *
 * 422 carries the blocking findings — unresolvable refs, a changed call
 * signature, a rejected expression. They are written for a model to act on.
 */
flowsRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body);
    let result;
    try {
      result = await flowPortabilityService.importFlow(req.params.workspaceId, input.bundle, {
        ...(input.refMap ? { refMap: input.refMap } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.description ? { description: input.description } : {}),
        // Same fix as the regenerate route: this read the body directly. The
        // author of an imported revision is whoever imported it — a person if
        // one was signed in, `system` otherwise — never a name the bundle or the
        // body supplied. archive/GAPS.md §1.2.
        author: authorOf(req, input.createdBy),
      });
    } catch (e) {
      const findings = (e as { findings?: unknown }).findings;
      if (findings) {
        return res.status(422).json({
          error: "import_refused",
          message: (e as Error).message,
          findings,
          warnings: (e as { warnings?: unknown }).warnings ?? [],
        });
      }
      throw e;
    }
    res.status(result.status === "ok" ? 201 : 200).json(result);
  }),
);

const testRunSchema = z.object({
  inputs: z.record(z.string()).optional(),
  /**
   * Per-run production opt-in (mock-data plan §4). Default OFF: the draft run
   * reads mock data. `true` requires a signed-in workspace admin (checked
   * inline below, so the plain mock run stays exactly as gated as before)
   * and is recorded as an `access`/`datasource` audit event.
   */
  useProductionData: z.boolean().optional().default(false),
});

/**
 * A manual run against the DRAFT namespace — how gate 1 is satisfied (§6.5 stage 7).
 *
 * ⚠ The response is BUILT, never spread from the service's return value (I-22).
 * `flowService.testRun` resolves `{ kestraExecutionId, namespace, revision, usedProductionData }`,
 * and this route used to `json(started)` — handing a client the engine's
 * execution id *and* the namespace, which is the whole of what it takes to
 * address Kestra directly, against the invariant `ExecutionView.id`'s own
 * docblock states (R5).
 *
 * The service keeps returning all three, because in-process callers legitimately
 * need them: every `kestra:*` harness imports `flowService` and waits on the
 * engine. The split is the point — **strip at the route, not in the service** —
 * and it only holds while the projection is written out field by field. A
 * `...started` here re-opens it silently the next time the service gains a field.
 *
 * What replaces it: nothing addressable. The run becomes visible when the flow's
 * own `begin` task writes `flow_executions`, and a client finds it the way the UI
 * already does — by listing executions. Since I-23 that list carries Foundry's
 * `flowId`, so "the runs of the flow I just started" is finally a filter a client
 * can express; before this pair of fixes it was neither expressible nor leaked
 * usefully.
 */
flowsRouter.post(
  "/:flowId/duplicate",
  asyncHandler(async (req, res) => {
    const { flow, revision } = await flowService.duplicate(
      req.params.workspaceId,
      req.params.flowId,
      authorOf(req, undefined),
    );
    res.status(201).json({ flow, revision });
  }),
);

flowsRouter.post(
  "/:flowId/test-run",
  asyncHandler(async (req, res) => {
    const { inputs, useProductionData } = testRunSchema.parse(req.body ?? {});
    if (useProductionData) {
      // Admin-gated branch ONLY: the plain mock run is untouched by this
      // block. `workspaceMemberService.check` 401s an anonymous caller and
      // 403s a non-admin, so both refusals come from the one verdict.
      // Dynamic import: the same cycle-avoidance `requireWorkspaceRole`
      // uses (`identity.middleware.ts`), not a runtime-selected module.
      const { workspaceMemberService } = await import("../services/workspace-member.service.js");
      const verdict = await workspaceMemberService.check(req.params.workspaceId, req.user, "admin");
      if (!verdict.allowed) {
        return res.status(verdict.status).json({ error: "forbidden", message: verdict.reason });
      }
    }
    // GAPS §1.1b — WHO asked, from the verified identity and from nowhere else.
    // There is no body field for it: a client naming the person gate 3 will
    // refuse to let decide is the refusal switched off from outside.
    const started = await flowService.testRun(
      req.params.workspaceId,
      req.params.flowId,
      inputs ?? {},
      requesterOf(req),
      { useProductionData },
    );
    // Built field by field, never spread (I-22 — see the docblock above).
    // `usedProductionData` is the mock-vs-prod indicator the client renders.
    res.status(202).json({ revision: started.revision, usedProductionData: started.usedProductionData });
  }),
);

/**
 * Run a Forge workflow's APPROVED revision now, live (pi-runtime P5) — production data, mail delivered. The person is
 * the requester (whom "email me" means, and who cannot approve this run's own approvals). Only an armed revision
 * runs: `startLiveRun` applies the same gate a compiled flow's live start does. Compiled flows run live through
 * their triggers; this is refused for them by name.
 */
flowsRouter.post(
  "/:flowId/run",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ inputs: z.record(z.union([z.string().max(10_000), z.number(), z.boolean()])).optional() })
      .strict()
      .parse(req.body ?? {});
    const started = await flowRunnerService.startLiveRun({
      workspaceId: req.params.workspaceId,
      flowId: req.params.flowId,
      inputs: body.inputs,
      requester: requesterOf(req),
    });
    res.status(202).json({ flowExecutionId: started.flowExecutionId, revision: started.revision });
  }),
);

/**
 * What this workflow still needs before it can run, for the person asking — each with who fixes it (sharing-boundaries
 * phase 4). `?revision=draft` for the version being built; the approved one otherwise.
 */
flowsRouter.get(
  "/:flowId/readiness",
  asyncHandler(async (req, res) => {
    const revision = req.query.revision === "draft" ? "draft" : "approved";
    const r = await readinessOf(req.params.workspaceId!, req.params.flowId!, { person: req.user?.subject ?? null, revision });
    if (!r) return res.status(404).json({ error: "not_found" });
    res.json(r);
  }),
);

/** Which of my own accounts my runs use for one service, when I have several (phase 4, P3-I1). Mine alone. */
flowsRouter.put(
  "/:flowId/my-account",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { piece, connectionId } = z.object({ piece: z.string().min(1).max(200), connectionId: z.string().uuid() }).strict().parse(req.body ?? {});
    await chooseAccount(req.params.workspaceId!, req.user!.subject, piece, connectionId);
    res.json(await readinessOf(req.params.workspaceId!, req.params.flowId!, { person: req.user!.subject }));
  }),
);

/**
 * "Turn on for me" (sharing-boundaries phase 3): a shared workflow that runs on each person's own account, run on the
 * asking person's own schedule, as them. Theirs alone: nobody turns it on or off for somebody else.
 */
flowsRouter.get(
  "/:flowId/activation",
  asyncHandler(async (req, res) => {
    const view = await flowActivationService.view(req.params.workspaceId!, req.params.flowId!, req.user?.subject ?? null);
    if (!view) return res.status(404).json({ error: "not_found" });
    res.json(view);
  }),
);
flowsRouter.put(
  "/:flowId/activation",
  requireIdentity,
  // An Observer runs nothing; turning it on for yourself is running it.
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ on: z.boolean(), cron: z.string().max(200).nullish(), timezone: z.string().max(100).nullish() })
      .strict()
      .parse(req.body ?? {});
    const who = { subject: req.user!.subject, actor: req.user!.email ?? req.user!.subject };
    const view = await flowActivationService.set(req.params.workspaceId!, req.params.flowId!, who, body);
    void auditService
      .record({
        workspaceId: req.params.workspaceId!,
        actor: who.actor,
        operation: "update",
        entity: "flow",
        entityId: req.params.flowId!,
        description: body.on ? "Turned it on for themselves, on their own account" : "Turned it off for themselves",
        whereText: "Workflows",
        whereEntityType: "flow",
        whereEntityId: req.params.flowId!,
      })
      .catch((e) => console.error("[flows] activation not audited:", e));
    res.json(view);
  }),
);

flowsRouter.delete(
  "/:flowId",
  // Deleting a shared workflow takes it from everybody: its owner's or an Admin's, never an editor's (phase 2).
  requireFlowManager,
  asyncHandler(async (req, res) => {
    const ok = await flowService.remove(req.params.workspaceId, req.params.flowId, requesterOf(req).actor);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);
