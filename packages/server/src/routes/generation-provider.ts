import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requirePlatformPermission } from "../middleware/platform-permission.middleware.js";
import { modelPricingService } from "../services/model-pricing.service.js";

/**
 * Model pricing (D-115). Since 2026-11-04 this router serves model pricing only; the model connection (gateway, key,
 * enabled models, default) is `/api/runtime-model/*`.
 *
 * ⚠ **Deliberately NOT under `/workspaces/:ws`.** Pricing is a property of the deployment, and a workspace-scoped URL
 * invites a per-workspace registry nobody has decided to build. Same argument as `/api/engine/plugins`.
 */
export const generationProviderRouter = Router();

/**
 * Model prices (rbac-observability, 2026-10-15): per 1M input and per 1M output tokens. Anyone signed in may READ
 * them — a member sees their own cost, and a cost nobody can explain is a number nobody trusts. Setting one is
 * `platform.generation.write`, the same as choosing the model.
 */
generationProviderRouter.get(
  "/pricing",
  asyncHandler(async (_req, res) => {
    const [prices, modelsSeen, history] = await Promise.all([
      modelPricingService.current(),
      modelPricingService.modelsSeen(),
      modelPricingService.history(),
    ]);
    res.json({ prices, modelsSeen, history, currency: "USD", unit: "per 1M tokens" });
  }),
);

const priceSchema = z
  .object({
    model: z.string().trim().min(1).max(255),
    inputPer1m: z.number().min(0).max(100_000).nullable(),
    outputPer1m: z.number().min(0).max(100_000).nullable(),
    /** A cache read; null or absent charges it at the input price. */
    cachedInputPer1m: z.number().min(0).max(100_000).nullable().optional(),
    /** A cache write; null or absent charges it at the input price. */
    cacheWritePer1m: z.number().min(0).max(100_000).nullable().optional(),
  })
  .strict();

generationProviderRouter.put(
  "/pricing",
  requirePlatformPermission("platform.generation.write"),
  asyncHandler(async (req, res) => {
    const p = priceSchema.parse(req.body ?? {});
    // A name a person can read in the history, never the bare subject (an Entra OID).
    await modelPricingService.set(p.model, p, req.user?.email ?? req.user?.name ?? req.user?.subject ?? null);
    res.json({ prices: await modelPricingService.current() });
  }),
);

/**
 * What each model cost across the deployment over the last `days` (default 30), split by where the figure came from:
 * a price set here, the cost the producer reported, or nothing at all (`uncostedCalls` — missing from every total
 * until somebody sets a price). Deployment-wide spend is `platform.signals.read`, the same as the deployment's own
 * usage summary (`GET /api/observability`).
 */
generationProviderRouter.get(
  "/pricing/spend",
  requirePlatformPermission("platform.signals.read"),
  asyncHandler(async (req, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse(req.query.days ?? undefined);
    res.json({ days, models: await modelPricingService.spend(days), currency: "USD" });
  }),
);
