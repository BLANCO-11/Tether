import { config } from "../config/index.js";
import { invalidateModelConnection, resolveModelConnection } from "./runtime-model.service.js";

/**
 * WHICH MODEL DESIGNS AUTOMATIONS (2026-11-04): the builder's model comes from the model connection
 * (`runtime-model.service.ts`). Personal thin: pass the chat owner's `subject` so Forge bills their BYOK key.
 * Harnesses / callers without a subject still resolve the env / singleton fallback.
 */

export interface ResolvedGenerationProvider {
  /** The model connection's gateway. Never settable through a caller. */
  baseUrl: string | null;
  /** The model connection's key. Never returned by any route. */
  apiKey: string | null;
  /** The connection's default model, or the environment's when it has none. */
  model: string;
  /** `configured` once the connection is saved; `environment` is the default, not a degraded state. */
  source: "configured" | "environment";
  updatedAt: Date | null;
  updatedBy: string | null;
  /** Preset id of the connection (decides gateway headers). */
  providerId?: string;
  /** The connection's enabled-model list. */
  allowedModels: string[];
}

export async function resolveGenerationProvider(subject?: string | null): Promise<ResolvedGenerationProvider> {
  const c = await resolveModelConnection(subject);
  return {
    baseUrl: c.baseUrl || null,
    apiKey: c.apiKey || null,
    model: c.defaultModel || config.inference.model,
    source: c.source === "configured" ? "configured" : "environment",
    updatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
    updatedBy: c.updatedBy,
    allowedModels: c.allowedModels,
    providerId: c.providerId ?? config.inference.provider,
  };
}

/** Test seam — the harnesses and the route both need a way to force a re-read. */
export function invalidateGenerationProvider(subject?: string | null): void {
  invalidateModelConnection(subject);
}
