import { config } from "../config/index.js";
import { invalidateModelConnection, resolveModelConnection } from "./runtime-model.service.js";

/**
 * WHICH MODEL DESIGNS AUTOMATIONS (2026-11-04): the builder's model now comes from the one model connection
 * (`runtime-model.service.ts`): its gateway, key, enabled list and default. `generation_llm` is no longer read;
 * migration 0136 merged it into `runtime_model_provider`. This file stays as the adapter the callers already import.
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
  /** The connection's enabled-model list. */
  allowedModels: string[];
}

export async function resolveGenerationProvider(): Promise<ResolvedGenerationProvider> {
  const c = await resolveModelConnection();
  return {
    baseUrl: c.baseUrl || null,
    apiKey: c.apiKey || null,
    model: c.defaultModel || config.inference.model,
    source: c.source === "configured" ? "configured" : "environment",
    updatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
    updatedBy: c.updatedBy,
    allowedModels: c.allowedModels,
  };
}

/** Test seam — the harnesses and the route both need a way to force a re-read. */
export function invalidateGenerationProvider(): void {
  invalidateModelConnection();
}
