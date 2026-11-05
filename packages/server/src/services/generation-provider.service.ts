import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationLlm } from "../db/schema.js";
import { config } from "../config/index.js";

/**
 * WHICH MODEL DESIGNS AUTOMATIONS — the one setting `/ai-provider` never had.
 * `breaking-2026-08-07/plan-provider-and-scope.md` Part A · **F2**
 *
 * ── The defect this exists for, measured ─────────────────────────────────────
 *
 * *"I changed to 5.4-mini for better speed and it is still slow."* Both sides
 * were read at the wire on 2026-08-07:
 *
 *   ops-api `llm_provider` row   gpt-5.4-mini                (changed 09:24)
 *   server environment           google/gemma-4-26B-A4B-it   (what drafted)
 *
 * `/ai-provider` configures the `llm_complete` **tool**. The generation model
 * was settable only by editing `.env` and running `docker compose up -d` — and
 * ⚠ not `restart`, which reuses the old environment. Nothing on the page said
 * so, which is what made this a copy defect as much as a missing feature.
 *
 * ── ⚠ WHY THIS IS A SECOND SERVICE AND NOT A SHARED ONE ─────────────────────
 *
 * D-35: *"runtime and generation inference must not be merged — different
 * credentials, different processes, no shared abstraction."* That was not a
 * preference. It was forced by I-24, where the agent-runtime transport silently
 * destroyed the `insufficient_contract` refusal channel — the mitigation for the
 * measured `period="2023-10"` failure the whole migration is built around — and
 * failed *asymmetrically*, so satisfiable contracts kept working and nothing
 * looked broken.
 *
 * Two panels on one page is a layout choice. **Two rows in two stores read by
 * two processes is the property**, and this file must never learn to read
 * ops-api's row (nor ops-api this one).
 *
 * ── ⚠ IT RESOLVES A MODEL. IT NEVER RESOLVES A CREDENTIAL ───────────────────
 *
 * `baseUrl` and `apiKey` come from `config.inference` and only from there:
 * `kestra:check` asserts the `LLM_*` environment variables are read in
 * `config/index.ts` and nowhere else, so this is a **layer over** that config rather than a
 * replacement for it. The row overrides one field of the resolved value.
 *
 * The rejected alternative was *"the parent fetches the gateway and key from
 * ops-api's row"*, which inverts Stage 5's boundary: ops-api holds no
 * control-plane credential and the parent holds no ops database credential.
 */

export interface ResolvedGenerationProvider {
  /** From the environment, always. Never settable through any route. */
  baseUrl: string | null;
  /** From the environment, always. Never returned by any route — see `fingerprint`. */
  apiKey: string | null;
  model: string;
  /**
   * ⚠ Which of the two the MODEL came from, and it is shown on the page.
   *
   * `environment` is not a degraded state — it is the default and it is what
   * every deployment does until somebody chooses otherwise. Rendering the two
   * identically is how "I set this and it did nothing" happens twice.
   */
  source: "configured" | "environment";
  updatedAt: Date | null;
  updatedBy: string | null;
  allowedModels: string[];
}

/**
 * ⚠ **A short TTL, not a process-lifetime cache** — and the difference is the
 * whole point of this feature.
 *
 * `export const inference` was resolved once at module load, so changing the
 * model needed a container restart. Caching this at boot would leave that
 * exactly as it was, with a settings page on top implying otherwise. Ten seconds
 * is long enough that a draft's fragment calls do not each hit the database and
 * short enough that Save is visibly effective.
 */
const TTL_MS = 10_000;
let cached: { at: number; value: ResolvedGenerationProvider } | null = null;

/** Test seam — the harnesses and the route both need a way to force a re-read. */
export function invalidateGenerationProvider(): void {
  cached = null;
}

export async function resolveGenerationProvider(): Promise<ResolvedGenerationProvider> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  /**
   * ⚠ **A failure to read the row is NOT "fall back to the environment".**
   *
   * That would generate on a different model from the one the screen shows, for
   * as long as the database is unhappy, and say nothing. It throws instead — the
   * same posture as `POST /api/executions/begin`, which answers 503 when it
   * cannot ask Kestra rather than trusting the request body (I-07). A missing
   * ROW is a different thing entirely and is the normal case.
   */
  const rows = await db.select().from(generationLlm).where(eq(generationLlm.id, true)).limit(1);
  const row = rows[0];

  const value: ResolvedGenerationProvider = {
    baseUrl: config.inference.baseUrl || null,
    apiKey: config.inference.apiKey || null,
    model: row?.defaultModel || config.inference.model,
    source: row?.defaultModel ? "configured" : "environment",
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    allowedModels: Array.isArray(row?.allowedModels) ? (row.allowedModels as string[]) : [],
  };
  cached = { at: Date.now(), value };
  return value;
}

/**
 * Eight hex characters of a salted digest — enough to tell two keys apart and
 * not enough to reconstruct either.
 *
 * ⚠ There is deliberately no endpoint in this product that returns a secret
 * value and no `?reveal=`, and a settings page is precisely where that rule gets
 * broken *"so the operator can check what they pasted"*. The runtime provider
 * already answers this way; this matches it rather than inventing a second
 * shape.
 */
export async function keyFingerprint(): Promise<string | null> {
  const key = config.inference.apiKey;
  if (!key) return null;
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`foundry-generation:${key}`).digest("hex").slice(0, 8);
}

export async function saveGenerationModel(input: {
  defaultModel: string;
  allowedModels: string[];
  updatedBy: string | null;
}): Promise<ResolvedGenerationProvider> {
  const model = input.defaultModel.trim();
  if (!model) {
    throw httpError("a default model is required — clear the setting instead to use the deployment's environment", 400);
  }
  const allowed = [...new Set(input.allowedModels.map((m) => m.trim()).filter(Boolean))];
  /**
   * ⚠ The default must be IN the allowlist, so the page cannot save a state it
   * would then refuse to show. The runtime provider enforces the same rule for
   * the same reason; here it also stops a model disappearing from the picker
   * while remaining what everything actually generates with.
   */
  if (allowed.length && !allowed.includes(model)) allowed.push(model);

  await db
    .insert(generationLlm)
    .values({
      id: true,
      defaultModel: model,
      allowedModels: allowed,
      updatedAt: new Date(),
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({
      target: generationLlm.id,
      set: {
        defaultModel: model,
        allowedModels: allowed,
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      },
    });

  invalidateGenerationProvider();
  return resolveGenerationProvider();
}

/** Back to the deployment's environment. Deleting the row, never writing the env value into it. */
export async function clearGenerationModel(): Promise<ResolvedGenerationProvider> {
  // ⚠ Writing `config.inference.model` into the row instead would look identical
  // on screen and be a different thing: the row would then PIN today's
  // environment value, so a later `.env` change would silently not take effect.
  await db.delete(generationLlm).where(eq(generationLlm.id, true));
  invalidateGenerationProvider();
  return resolveGenerationProvider();
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}
