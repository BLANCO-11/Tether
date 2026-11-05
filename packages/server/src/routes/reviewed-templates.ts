import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { reviewedTemplateService } from "../services/reviewed-template.service.js";

const querySchema = z.object({
  q: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (Number.isNaN(n)) return undefined;
      return n;
    }),
  kind: z.string().optional(),
});

const paramsSchema = z.object({ slug: z.string().min(1) });

/**
 * B-08 reviewed_templates + B-09 chips most-used derived.
 *
 * Platform level, no workspace scoping — the 34 reviewed templates are the
 * platform catalogue. Workspace copies stay in `flow_templates`.
 * requireIdentity on every read (platform level but still a person).
 *
 * GET /               ?q=&limit=&kind=curated|mostUsed
 * GET /:slug          single template by slug
 * GET /suggestions    chips reuse — mostUsed 4 (S-01 + S-03 share one PromptComposer)
 *
 * B-09 note: chips GET /templates/suggestions?limit=4 can reuse same service
 * (mostUsed 4) — stub route returning 4 titles, S-01+S-03 share one component
 * when wired later. This router is that single source.
 */
export const reviewedTemplatesRouter = Router();

reviewedTemplatesRouter.get(
  "/suggestions",
  requireIdentity,
  validate({ query: z.object({ limit: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const raw = req.query.limit as string | undefined;
    const limit = raw ? Number(raw) : 4;
    const rows = await reviewedTemplateService.suggestions(Number.isNaN(limit) ? 4 : limit);
    // Return minimal chip payload — titles for PromptComposer chips
    res.json({
      suggestions: rows.map((r) => ({ slug: r.slug, name: r.name, eyebrow: r.eyebrow })),
    });
  }),
);

reviewedTemplatesRouter.get(
  "/",
  requireIdentity,
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const rawKind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const kind = reviewedTemplateService.normalizeKind(rawKind);
    const rawLimit = req.query.limit as number | undefined;
    const templates = await reviewedTemplateService.list({ q, limit: rawLimit, kind });
    res.json({ templates });
  }),
);

reviewedTemplatesRouter.get(
  "/:slug",
  requireIdentity,
  validate({ params: paramsSchema }),
  asyncHandler(async (req, res) => {
    const row = await reviewedTemplateService.getBySlug(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found", message: "template not found" });
    res.json({ template: row });
  }),
);
