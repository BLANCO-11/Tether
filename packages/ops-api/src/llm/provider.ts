import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";

/**
 * The LLM provider: who ops-api calls, with what key, and which models a flow
 * may name.
 *
 * ── Why the configuration is a ROW and not just environment variables ────────
 *
 * The four `LLM_*` variables still work and are the fallback, but a provider you
 * can only change by editing compose and recreating a container is not something
 * an operator can set up. So the live configuration is a single row, written
 * through the operator surface, with the env values as `source: "env"` until
 * someone saves one.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  * **The base URL is operator-set and caller-unset.** A flow step passes
 *    `instruction` and `input`. There is no URL parameter anywhere on the tool
 *    route, so no caller can point this process at a host of its choosing. That
 *    is the property that keeps "ops-api has one outbound route" true even
 *    though the route is now configurable.
 *  * **The allowlist is chosen from what the gateway advertises**, not typed
 *    freehand. `GET /admin/llm/models` lists them; the operator enables a
 *    subset; a flow naming anything else gets a 400 that names the allowed set.
 *    Without this, `model` is a free-text field on a billable call.
 *
 * ── Encryption at rest, and exactly what it is worth ────────────────────────
 *
 * The provider key is stored AES-256-GCM encrypted under a key derived from
 * `OPS_API_KEY` — the same root this process already derives its `hr_demo`
 * password and its six service credentials from. ops-api must never hold
 * `CREDENTIAL_ENC_KEY` (that one decrypts every stored credential in
 * `foundry_parent`), so deriving from the root it legitimately has is the
 * available option.
 *
 * ⚠ Be honest about the threat model: this protects a database dump, a backup
 * and a screenshot of a row. It does NOT protect against anything holding
 * `OPS_API_KEY`, which is by construction this process itself. Encryption whose
 * key sits in the same process is a real control against one class of exposure
 * and no control at all against another; describing it as more than that is how
 * a "secrets are encrypted" line ends up in a document while the interesting
 * attack is unaffected.
 */

// ── at-rest encryption ───────────────────────────────────────────────────────

function atRestKey(): Buffer {
  return createHash("sha256")
    .update(`${config.apiKey}:ops-api:llm-provider:v1`)
    .digest();
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", atRestKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split(":");
  if (!iv || !tag || !enc) throw new Error("stored provider key is malformed");
  const decipher = createDecipheriv("aes-256-gcm", atRestKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
}

/**
 * A stable, non-reversible label for a key.
 *
 * An operator has to be able to answer "is the key I just pasted the one that is
 * live?" without any route ever returning a credential — the parent has no
 * endpoint that reveals a secret and no `?reveal=`, and this surface must not
 * become the exception. Eight hex characters of a salted SHA-256 distinguishes
 * two keys and reconstructs neither.
 */
export function keyFingerprint(key: string): string {
  if (!key) return "";
  return createHash("sha256").update(`fp:${key}`).digest("hex").slice(0, 8);
}

// ── the resolved configuration ───────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  allowedModels: string[];
  /** Where the live values came from — `env` until an operator saves a row. */
  source: "env" | "configured";
  updatedAt: string | null;
}

/** What an operator may see. Deliberately has no `apiKey`. */
export type ProviderView = Omit<ProviderConfig, "apiKey"> & {
  configured: boolean;
  keyFingerprint: string;
};

function fromEnv(): ProviderConfig {
  const models = [config.llm.fastModel, config.llm.reasoningModel].filter(Boolean);
  return {
    baseUrl: config.llm.baseUrl.replace(/\/+$/, ""),
    apiKey: config.llm.apiKey,
    defaultModel: config.llm.fastModel || models[0] || "",
    allowedModels: [...new Set(models)],
    source: "env",
    updatedAt: null,
  };
}

interface ProviderRow extends Record<string, unknown> {
  base_url: string;
  api_key_enc: string | null;
  default_model: string;
  allowed_models: string[];
  updated_at: string;
}

/** The live configuration: the stored row if there is one, else the env. */
export async function loadProvider(): Promise<ProviderConfig> {
  const rows = await db.execute<ProviderRow>(
    sql`SELECT base_url, api_key_enc, default_model, allowed_models, updated_at
        FROM llm_provider WHERE id = 1`,
  );
  const row = rows.rows[0];
  if (!row) return fromEnv();

  // A saved row with no key of its own falls back to the env key rather than
  // failing: changing the default model must not require re-pasting a
  // credential, and `PUT` deliberately treats an omitted `apiKey` as "keep".
  const env = fromEnv();
  return {
    baseUrl: row.base_url.replace(/\/+$/, ""),
    apiKey: row.api_key_enc ? open(row.api_key_enc) : env.apiKey,
    defaultModel: row.default_model,
    allowedModels: Array.isArray(row.allowed_models) ? row.allowed_models : [],
    source: "configured",
    updatedAt: row.updated_at,
  };
}

export function viewOf(p: ProviderConfig): ProviderView {
  const { apiKey, ...rest } = p;
  return {
    ...rest,
    configured: Boolean(p.baseUrl && apiKey),
    keyFingerprint: keyFingerprint(apiKey),
  };
}

export interface ProviderUpdate {
  baseUrl: string;
  /** Omitted means "keep the stored key"; the empty string is not accepted. */
  apiKey?: string;
  defaultModel: string;
  allowedModels: string[];
}

export async function saveProvider(update: ProviderUpdate): Promise<ProviderConfig> {
  const current = await loadProvider();
  const key = update.apiKey ?? current.apiKey;
  await db.execute(sql`
    INSERT INTO llm_provider (id, base_url, api_key_enc, default_model, allowed_models, updated_at)
    VALUES (1, ${update.baseUrl.replace(/\/+$/, "")}, ${key ? seal(key) : null},
            ${update.defaultModel}, ${JSON.stringify(update.allowedModels)}::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      base_url = EXCLUDED.base_url,
      api_key_enc = EXCLUDED.api_key_enc,
      default_model = EXCLUDED.default_model,
      allowed_models = EXCLUDED.allowed_models,
      updated_at = now()`);
  return loadProvider();
}

/** Forget the row and fall back to the environment. */
export async function clearProvider(): Promise<ProviderConfig> {
  await db.execute(sql`DELETE FROM llm_provider WHERE id = 1`);
  return loadProvider();
}

// ── the gateway ──────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function providerFetch(
  p: ProviderConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!p.baseUrl) {
    throw new ProviderError(
      503,
      "provider_not_configured",
      "no LLM provider is configured — set a base URL and key on the AI provider page " +
        "(or supply LLM_BASE_URL / LLM_API_KEY)",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${p.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        // The provider key goes out here and only here.
        authorization: `Bearer ${p.apiKey}`,
      },
    });
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
    throw new ProviderError(502, "provider_unreachable", `LLM provider at ${p.baseUrl}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The models the gateway advertises.
 *
 * ⚠ A successful listing is NOT evidence that completions work. This is exactly
 * the shape of the documented `llmConnected: true` false green on
 * `GET /api/tether/health`, which "verifies" the LLM by listing models — a
 * gateway will happily enumerate models for a key that has no quota, no access
 * to any of them, or no billing attached. Use `testCompletion` for evidence.
 */
export async function listModels(p: ProviderConfig): Promise<string[]> {
  const res = await providerFetch(p, "/models", { method: "GET" }, 20_000);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      res.status === 401 || res.status === 403 ? 401 : 502,
      "provider_rejected",
      `LLM provider returned ${res.status} listing models: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
}

export interface CompletionResult {
  text: string;
  model: string;
  finishReason: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

/**
 * ⚠ **`temperature` IS NOT UNIVERSALLY ACCEPTED, AND THAT IS WHY THIS IS A
 * PREDICATE RATHER THAN A CONSTANT.** `temperature: 0` was sent unconditionally
 * and hardcoded, with a comment saying it was "fixed, and not a parameter". It
 * is still not a parameter — nobody may set it — but some models refuse the
 * value outright:
 *
 *     400 Unsupported value: 'temperature' does not support 0 with this model.
 *         Only the default (1) is supported.  Model Group=gpt-5.6-luna
 *
 * That is not a soft degradation. `llm_complete` is a step kind, so every flow
 * using one fails at execution — and under gate 1 a flow that cannot complete a
 * run cannot be armed at all, so choosing such a model on `/ai-provider`
 * silently made a whole capability unusable. Reported from use on 2026-09-04.
 *
 * ⚠ **The retry is keyed on the provider naming `temperature`, never on the
 * status alone.** A blanket "400 → drop a field and try again" would re-send
 * every malformed request a second time and report the second failure, which is
 * the one carrying less information. It fires **once**: a second rejection is
 * returned as it arrived.
 *
 * ⚠ **Determinism is unchanged wherever it was ever real.** A model that accepts
 * 0 still gets 0 — the first attempt is byte-identical to what this function
 * has always sent, so no existing measurement moves. And the original comment's
 * caveat is what makes the fallback acceptable at all: temperature 0 is a bias
 * toward the same answer and never a guarantee of one (batching, quantisation
 * and provider routing all move it), so nothing downstream may depend on this
 * output being stable. See the terminal-not-load-bearing rule on the route.
 */
function rejectsTemperature(status: number, body: string): boolean {
  return status === 400 && /temperature/i.test(body);
}

/**
 * The temperature every `llm_complete` call asks for.
 *
 * ⚠ **1 SINCE 2026-09-17; it was 0 before that.** Asked for directly, and
 * changed on BOTH senders in the same edit — this one and
 * `packages/server`'s `GENERATION_TEMPERATURE`. They are deliberately separate
 * modules (D-35: runtime and generation inference share a provider and nothing
 * else), which is exactly why the value has to be changed in both or the two
 * halves of one product setting disagree. The docblock above already records
 * what it cost to fix only one of them.
 *
 * ⚠ **The paragraph above says "a model that accepts 0 still gets 0 — no
 * existing measurement moves". THAT IS NO LONGER TRUE and is kept as the
 * reasoning it was.** Every model now gets 1. It is still not a parameter —
 * nobody may set it — and the original caveat is what makes that acceptable:
 * temperature 0 was a bias toward the same answer and never a guarantee of one,
 * so nothing downstream was permitted to depend on this output being stable.
 * What changes is the strength of the bias, not whether anything may rely on it.
 */
const RUNTIME_TEMPERATURE = 1;

/** One completion. No streaming, no tools, no JSON mode — see the route. */
export async function complete(
  p: ProviderConfig,
  opts: { model: string; system: string; user: string; maxTokens: number },
): Promise<CompletionResult> {
  const startedAt = Date.now();
  const send = (withTemperature: boolean) =>
    providerFetch(
      p,
      "/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          max_tokens: opts.maxTokens,
          ...(withTemperature ? { temperature: RUNTIME_TEMPERATURE } : {}),
          stream: false,
        }),
      },
      config.llm.timeoutMs,
    );

  let res = await send(true);
  let text = await res.text();
  if (rejectsTemperature(res.status, text)) {
    console.warn(
      `[llm] ${opts.model} rejected temperature: ${RUNTIME_TEMPERATURE} — retrying once without it. ${text.slice(0, 200)}`,
    );
    res = await send(false);
    text = await res.text();
  }
  if (!res.ok) {
    throw new ProviderError(
      res.status === 401 || res.status === 403 ? 401 : 502,
      "provider_rejected",
      `LLM provider returned ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  let json: {
    model?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(502, "provider_malformed", "LLM provider returned a non-JSON body");
  }

  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError(502, "provider_malformed", "LLM provider returned no message content");
  }
  return {
    text: content,
    model: json.model ?? opts.model,
    finishReason: choice?.finish_reason ?? "unknown",
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * A real, tiny completion — the only thing that proves a key works.
 *
 * Deliberately separate from `listModels` and deliberately not folded into the
 * provider view, because the difference between "the gateway answered" and "the
 * gateway completed" is the difference this repo has already been bitten by.
 */
export async function testCompletion(
  p: ProviderConfig,
  model?: string,
): Promise<CompletionResult> {
  return complete(p, {
    model: model || p.defaultModel,
    system: "Reply with exactly the word OK.",
    user: "OK?",
    maxTokens: 8,
  });
}
