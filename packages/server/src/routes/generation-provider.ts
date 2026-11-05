import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requirePlatformPermission } from "../middleware/platform-permission.middleware.js";
import {
  clearGenerationModel,
  keyFingerprint,
  resolveGenerationProvider,
  saveGenerationModel,
} from "../services/generation-provider.service.js";
import { inference } from "../services/inference.service.js";
import { config } from "../config/index.js";
import { modelPricingService } from "../services/model-pricing.service.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformUsers } from "../db/schema.js";

/** Who set it, in words: their sign-in name, else their email — never the sign-in id a person cannot read. */
async function nameOf(subject: string | null): Promise<string | null> {
  if (!subject) return null;
  const [u] = await db.select({ name: platformUsers.name, email: platformUsers.email }).from(platformUsers).where(eq(platformUsers.subject, subject)).limit(1);
  return u?.name?.trim() || u?.email || null;
}

/**
 * The model that DESIGNS automations.
 * `breaking-2026-08-07/plan-provider-and-scope.md` Part A · **F2** · D-115
 *
 * ⚠ **Deliberately NOT under `/workspaces/:ws`.** This is a property of the
 * deployment (decision 1, 2026-08-07), and a workspace-scoped URL invites a
 * per-workspace registry nobody has decided to build. Same argument as
 * `/api/engine/plugins`.
 *
 * ⚠ **Nothing here returns a key, and `PUT` refuses one by NAME.** There is no
 * endpoint in this product that returns a secret value and no `?reveal=`; a
 * settings page is exactly where that rule gets broken *"so the operator can
 * check what they pasted"*. `keyFingerprint` is the answer to that question.
 * And a `baseUrl`/`apiKey` accepted-and-dropped would read exactly like a field
 * that works, so both are refused with a message rather than stripped.
 */
export const generationProviderRouter = Router();

/**
 * ⚠ `.strict()` is the load-bearing word. Zod's default strips unknown keys
 * silently, which is the accepted-and-ignored failure mode; this rejects them,
 * and the two named below get their own sentence so the refusal explains the
 * boundary instead of just naming a key.
 */
const saveSchema = z
  .object({
    defaultModel: z.string().min(1).max(255),
    allowedModels: z.array(z.string().min(1).max(255)).max(200).default([]),
  })
  .strict();

function refuseCredentialFields(body: Record<string, unknown>): void {
  for (const field of ["baseUrl", "apiKey", "base_url", "api_key"]) {
    if (field in body) {
      const e = new Error(
        `\`${field}\` is not settable here. The generation gateway and its key come from the ` +
          `deployment's own environment (LLM_BASE_URL / LLM_API_KEY) and are read in one place; ` +
          `only the MODEL is configurable from this page. Changing the gateway means editing ` +
          `\`.env\` and running \`docker compose up -d\` — not \`restart\`, which reuses the old ` +
          `environment.`,
      ) as Error & { statusCode: number };
      e.statusCode = 400;
      throw e;
    }
  }
}

generationProviderRouter.get(
  "/llm/provider",
  asyncHandler(async (_req, res) => {
    const resolved = await resolveGenerationProvider();
    res.json({
      // ⚠ Read-only, and the client renders it beside the RUNTIME provider's
      // editable one. The two share a gateway by decision, not by construction,
      // so the only thing standing between "one gateway" and "two, silently" is
      // showing both.
      baseUrl: resolved.baseUrl,
      keyFingerprint: await keyFingerprint(),
      defaultModel: resolved.model,
      allowedModels: resolved.allowedModels,
      source: resolved.source,
      /**
       * What the environment would give if the row were cleared. Shown so
       * "reset to the deployment default" names the value it will produce
       * rather than being a button with an unstated outcome.
       */
      environmentModel: config.inference.model,
      updatedAt: resolved.updatedAt,
      updatedBy: resolved.updatedBy,
      updatedByName: await nameOf(resolved.updatedBy),
    });
  }),
);

generationProviderRouter.put(
  "/llm/provider",
  requirePlatformPermission("platform.generation.write"),
  asyncHandler(async (req, res) => {
    refuseCredentialFields((req.body ?? {}) as Record<string, unknown>);
    const parsed = saveSchema.parse(req.body ?? {});
    const saved = await saveGenerationModel({
      defaultModel: parsed.defaultModel,
      allowedModels: parsed.allowedModels,
      // The signed identity's subject, never a body field. Same rule as
      // `authorOf()` — a body-derived actor is an input to identity, not one.
      updatedBy: req.user?.subject ?? null,
    });
    res.json({ defaultModel: saved.model, allowedModels: saved.allowedModels, source: saved.source });
  }),
);

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

generationProviderRouter.delete(
  "/llm/provider",
  requirePlatformPermission("platform.generation.write"),
  asyncHandler(async (_req, res) => {
    const cleared = await clearGenerationModel();
    res.json({ defaultModel: cleared.model, source: cleared.source });
  }),
);

/**
 * ⚠ **Listing models is NOT evidence the model works**, and this route and
 * `/test` must never be presented as the same thing.
 *
 * A gateway enumerates models happily for a key with no quota, no access to any
 * of them and no billing attached — the documented `llmConnected: true` false
 * green on a health probe that "verifies" an LLM by listing models. So
 * the caveat travels **with the payload**, the way the fragment-promotion
 * caveat does, rather than living in the page's source.
 */
generationProviderRouter.post(
  "/llm/models",
  asyncHandler(async (_req, res) => {
    // ⚠ The `503 no_gateway` branch that was here is GONE (1.8). It answered
    // *"this deployment has no generation gateway configured, so generation
    // falls back to the agent runtime"* — and there is no fallback now, nor any
    // way to reach this route without the gateway: `LLM_BASE_URL`/`LLM_API_KEY`
    // are `required()` config, so the process would not have booted. It had no
    // client consumer, and an error code nothing can produce is one a reader
    // reasonably assumes is reachable.
    const r = await fetch(`${config.inference.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.inference.apiKey}` },
    });
    if (!r.ok) {
      return res
        .status(502)
        .json({ error: "gateway_error", message: `the gateway answered ${r.status} listing models` });
    }
    const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
    res.json({
      models: (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).sort(),
      caveat:
        "A model list only proves the gateway answered a GET. It does not prove this key may " +
        "call any of these models, or that there is quota behind it. Run a test completion for that.",
    });
  }),
);

/**
 * ONE real completion, through the same seam generation uses.
 *
 * ⚠ It calls `inference.complete`, not a bespoke fetch — so what it proves is
 * what generation will actually do, including the per-call model resolution. A
 * second HTTP client here would be a test of a code path nothing else runs.
 */
generationProviderRouter.post(
  "/llm/test",
  asyncHandler(async (_req, res) => {
    const started = Date.now();
    try {
      const text = await inference.complete("Reply with the single word: ready", {
        label: "generation-provider-test",
        timeoutMs: 60_000,
        maxTokens: 32,
      });
      const resolved = await resolveGenerationProvider();
      res.json({ ok: true, model: resolved.model, ms: Date.now() - started, reply: text.slice(0, 200) });
    } catch (e) {
      // 200 with `ok: false` — this is a diagnostic whose whole job is to report
      // a failure legibly. A 502 here would be rendered by the client's error
      // path as "the request failed", losing the message that says why.
      res.json({ ok: false, ms: Date.now() - started, message: (e as Error).message });
    }
  }),
);
