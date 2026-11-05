import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  flowTemplateService,
  saveTemplateSchema,
  instantiateTemplateSchema,
} from "../services/flow-template.service.js";
import { fragmentPromotionService } from "../services/fragment-promotion.service.js";
import { authorOf } from "../middleware/identity.middleware.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { contentVisibility } from "../services/content-visibility.service.js";

/**
 * `/api/workspaces/:workspaceId/flow-templates` — the per-tenant template
 * library (6.4), and `/fragment-candidates` (6.5).
 * archive/kestra-migration/08-scale-and-phasing.md §10 "Phase 6"
 *
 * Both are workspace-scoped, and for the same reason rather than by convention:
 * a template holds ref names and step contracts written against ONE tenant's
 * data, and a promotion candidate quotes those contracts' purposes verbatim.
 * Neither has a listing that spans workspaces, so neither can leak the origin
 * tenant's schema vocabulary through a shared surface. Moving a flow between
 * tenants is an explicit export → import, by a human, with revalidation.
 *
 * Instantiating a template is an IMPORT — the same `flow-portability.service.ts`
 * path a pasted bundle takes, with the same checks. There is deliberately no
 * second instantiation path, because a second path is the one that ends up
 * missing a check.
 */
export const flowTemplatesRouter = Router({ mergeParams: true });

flowTemplatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await flowTemplateService.list(req.params.workspaceId);
    // The bundle is deliberately NOT in the list response. It is the whole model
    // and would make a library page tens of KB per row; `GET /:id` serves it.
    res.json({
      templates: rows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        sourceFlowId: t.sourceFlowId,
        sourceRevision: t.sourceRevision,
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        stepCount: ((t.bundleJson as { model?: { steps?: unknown[] } })?.model?.steps ?? []).length,
      })),
    });
  }),
);

flowTemplatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await flowTemplateService.get(req.params.workspaceId, req.params.id));
  }),
);

const saveFromFlowSchema = saveTemplateSchema.extend({
  flowId: z.string().uuid(),
});

/** Snapshot a flow revision into the library. */
flowTemplatesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { flowId, createdBy, ...input } = saveFromFlowSchema.parse(req.body);
    // The workflow is named in the BODY, which the path guard cannot see, and a template is visible to the whole
    // workspace — so copying a private workflow into one would publish it. Not visible: 404; visible but somebody
    // else's private workflow: 403.
    const flow = await flowRepo.get(req.params.workspaceId, flowId);
    if (flow) {
      const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
      if (!contentVisibility.flowVisible(viewer, flow)) {
        return res.status(404).json({ error: "not_found", message: "This is not here any more." });
      }
      if (!contentVisibility.flowCopyableToWorkspace(viewer, flow)) {
        return res.status(403).json({
          error: "forbidden",
          message: "Only its owner can save a workflow in their My space as a template, because templates are seen by the whole workspace.",
        });
      }
    }
    res.status(201).json(
      await flowTemplateService.saveFromFlow(req.params.workspaceId, flowId, {
        ...input,
        // `flow_templates.created_by` is a label and nothing reads it as a
        // control — but it stops being trusted from a signed-in caller for the
        // same reason as everywhere else (archive/GAPS.md §1.2). No kind column here:
        // a flag with no consumer is a flag that becomes wrong quietly.
        createdBy: authorOf(req, createdBy).createdBy,
      }),
    );
  }),
);

const saveFromBundleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  createdBy: z.string().min(1).max(255).optional(),
  bundle: z.unknown(),
});

/** Save a bundle that arrived from elsewhere, without importing it as a flow first. */
flowTemplatesRouter.post(
  "/from-bundle",
  asyncHandler(async (req, res) => {
    const input = saveFromBundleSchema.parse(req.body);
    res.status(201).json(
      await flowTemplateService.saveFromBundle(req.params.workspaceId, input.name, input.bundle, {
        ...(input.description ? { description: input.description } : {}),
        createdBy: authorOf(req, input.createdBy).createdBy,
      }),
    );
  }),
);

/**
 * What instantiating this template HERE would find, before any inference is
 * spent. A template written where `hr_demo.*` exists and used where it does not
 * is the common case, and the useful answer is a list of refs to map.
 */
flowTemplatesRouter.post(
  "/:id/plan",
  asyncHandler(async (req, res) => {
    const refMap = z.record(z.string().max(128)).optional().parse(req.body?.refMap);
    const plan = await flowTemplateService.plan(req.params.workspaceId, req.params.id, refMap ?? {});
    res.json({
      findings: plan.findings,
      warnings: plan.warnings,
      remapped: plan.remapped,
      importable: plan.findings.every((f) => !f.blocking),
      contracts: plan.contracts,
    });
  }),
);

flowTemplatesRouter.post(
  "/:id/instantiate",
  asyncHandler(async (req, res) => {
    const { createdBy, ...input } = instantiateTemplateSchema.parse(req.body ?? {});
    let result;
    try {
      // Instantiating creates a REVISION, so it carries a real attestation:
      // the author is whoever pressed the button here, never the template's
      // saver and never the origin tenant. archive/GAPS.md §1.2.
      result = await flowTemplateService.instantiate(req.params.workspaceId, req.params.id, {
        ...input,
        author: authorOf(req, createdBy),
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

flowTemplatesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const ok = await flowTemplateService.remove(req.params.workspaceId, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);

/**
 * `/api/workspaces/:workspaceId/fragment-candidates` — the graduation loop (6.5).
 *
 * A separate mount rather than a route on `flowsRouter`, because `GET
 * /promotion-candidates` there would be shadowed by `GET /:flowId` — a collision
 * that presents as "the endpoint returns 404 for a valid workspace".
 */
export const fragmentCandidatesRouter = Router({ mergeParams: true });

fragmentCandidatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const minFlows = Math.max(2, Number(req.query.minFlows ?? 2) || 2);
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
    const candidates = await fragmentPromotionService.promotionCandidates(req.params.workspaceId, {
      minFlows,
      visible: contentVisibility.flowsWhere(viewer),
    });
    res.json({
      candidates,
      minFlows,
      // Said in the payload, not just in a doc: a consumer that renders these as
      // findings rather than as suggestions is misreading them, and the caveat
      // travels with the data.
      caveat:
        "These are SURFACED BY SHAPE, not detected. Two steps sharing an input/output " +
        "interface may be unrelated jobs. `distinctBodies: 1` across several flows is the " +
        "strong signal; `shapeOnly: true` means the purposes did not agree and only the " +
        "interface matched.",
    });
  }),
);
