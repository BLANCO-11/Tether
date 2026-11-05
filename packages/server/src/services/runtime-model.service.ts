/**
 * Model connection: deployment singleton (enterprise / harness env fallback) or per-user row (personal thin).
 *
 * Personal (`PERSONAL_PRODUCT`): each subject owns one OpenAI-compatible connection in `user_llm_providers`.
 * Interactive routes never fall back to the shared env key (that would silently bill the deployment).
 * Harnesses / callers without a subject still use `LLM_*` via `fromEnv()`.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { runtimeModelProvider, userLlmProviders } from "../db/schema.js";
import { PERSONAL_PRODUCT } from "../personal.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { forgeReachability, rememberModelConnection } from "./model-connection.js";
import { presetById, resolvePresetBaseUrl, type LlmProviderPresetId } from "./llm-provider-presets.js";

export interface RuntimeProvider {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  allowedModels: string[];
  /** Preset id when personal BYOK; omitted for env/singleton. */
  providerId?: LlmProviderPresetId | string;
  /** Where the live values came from — `env` until someone saves; `configured` when a row exists. */
  source: "env" | "configured";
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What a person may see. Deliberately has no `apiKey`. */
export type RuntimeProviderView = Omit<RuntimeProvider, "apiKey"> & {
  configured: boolean;
  keyFingerprint: string;
  forgeReachable: boolean;
  forgeWarning: string | null;
  /**
   * Personal BYOK with no saved row: the deployment `LLM_*` build default, for display only.
   * Never includes the key. Absent when the person already has their own connection, or when env has none.
   */
  deploymentDefault?: {
    baseUrl: string;
    defaultModel: string;
    allowedModels: string[];
    keyFingerprint: string;
  } | null;
};

export function keyFingerprint(key: string): string {
  if (!key) return "";
  return createHash("sha256").update(`fp:${key}`).digest("hex").slice(0, 8);
}

function fromEnv(): RuntimeProvider {
  const models = [...new Set(config.runtimeModel.fallbackModels)];
  return {
    baseUrl: config.inference.baseUrl.replace(/\/+$/, ""),
    apiKey: config.inference.apiKey,
    defaultModel: models[0] ?? "",
    allowedModels: models,
    source: "env",
    updatedAt: null,
    updatedBy: null,
  };
}

/** Empty personal connection (UI empty state — never exposes the env key). */
function unconfiguredPersonal(): RuntimeProvider {
  return {
    baseUrl: "",
    apiKey: "",
    defaultModel: "",
    allowedModels: [],
    providerId: "openai",
    source: "env",
    updatedAt: null,
    updatedBy: null,
  };
}

async function loadSingleton(): Promise<RuntimeProvider> {
  const [row] = await db.select().from(runtimeModelProvider).where(eq(runtimeModelProvider.id, 1)).limit(1);
  if (!row) return fromEnv();
  return {
    baseUrl: (row.baseUrl.trim() || config.inference.baseUrl).replace(/\/+$/, ""),
    apiKey: row.apiKeyEnc ? decrypt(row.apiKeyEnc) : fromEnv().apiKey,
    defaultModel: row.defaultModel,
    allowedModels: Array.isArray(row.allowedModels) ? row.allowedModels : [],
    source: "configured",
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ?? null,
  };
}

async function loadUserRow(subject: string): Promise<RuntimeProvider | null> {
  const [row] = await db.select().from(userLlmProviders).where(eq(userLlmProviders.subject, subject)).limit(1);
  if (!row) return null;
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ""),
    apiKey: row.apiKeyEnc ? decrypt(row.apiKeyEnc) : "",
    defaultModel: row.defaultModel,
    allowedModels: Array.isArray(row.allowedModels) ? row.allowedModels : [],
    providerId: row.providerId,
    source: "configured",
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ?? null,
  };
}

export type LoadOpts = {
  /** Signed-in subject (personal BYOK). */
  subject?: string | null;
  /**
   * `interactive` — UI / Forge: never fall back to env for a person without a row.
   * `harness` — allow env when no subject / no row (tests, Kestra without acting subject).
   */
  mode?: "interactive" | "harness";
};

/** The live settings for a caller. */
export async function loadRuntimeProvider(opts: LoadOpts = {}): Promise<RuntimeProvider> {
  const mode = opts.mode ?? "harness";
  if (!PERSONAL_PRODUCT) return loadSingleton();

  const subject = opts.subject?.trim() || null;
  if (subject) {
    const row = await loadUserRow(subject);
    if (row) return row;
    if (mode === "interactive") return unconfiguredPersonal();
    return fromEnv();
  }
  if (mode === "interactive") return unconfiguredPersonal();
  return fromEnv();
}

export type ModelConnection = RuntimeProvider;

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: ModelConnection }>();

export function invalidateModelConnection(subject?: string | null): void {
  if (subject) cache.delete(`u:${subject}`);
  else cache.clear();
}

/**
 * Connection every consumer uses. Pass `subject` for personal chats / steps.
 * Missing interactive row → unconfigured (empty key); harness without subject → env.
 */
export async function resolveModelConnection(subject?: string | null): Promise<ModelConnection> {
  const key = PERSONAL_PRODUCT && subject ? `u:${subject}` : "singleton";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    rememberModelConnection({ baseUrl: hit.value.baseUrl, apiKey: hit.value.apiKey });
    return hit.value;
  }
  const value = await loadRuntimeProvider({
    subject,
    mode: PERSONAL_PRODUCT && subject ? "interactive" : "harness",
  });
  rememberModelConnection({ baseUrl: value.baseUrl, apiKey: value.apiKey });
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function viewOf(p: RuntimeProvider): RuntimeProviderView {
  const { apiKey, ...rest } = p;
  return {
    ...rest,
    configured: Boolean(p.baseUrl && apiKey),
    keyFingerprint: keyFingerprint(apiKey),
    ...forgeReachability(p.baseUrl || config.inference.baseUrl, config.inference.baseUrl, config.forge.egressAllow),
  };
}

/**
 * Read-only snapshot of the deployment `LLM_*` connection (no key). Used on the AI page when personal
 * BYOK has no row so "Not connected" is not shown while the build still has a model.
 */
export function deploymentDefaultView(): RuntimeProviderView["deploymentDefault"] {
  const env = fromEnv();
  if (!env.baseUrl || !env.apiKey) return null;
  return {
    baseUrl: env.baseUrl,
    defaultModel: env.defaultModel,
    allowedModels: env.allowedModels,
    keyFingerprint: keyFingerprint(env.apiKey),
  };
}

export class RuntimeModelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export type SaveProviderInput = {
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  allowedModels: string[];
  providerId?: string;
};

/**
 * Save. Personal → upsert by subject. Enterprise → singleton id=1.
 * `apiKey` omitted keeps the stored one; empty string refused.
 */
export async function saveRuntimeProvider(
  update: SaveProviderInput,
  by: string | null,
  subject?: string | null,
): Promise<RuntimeProvider> {
  const providerId = (update.providerId?.trim() || "custom") as string;
  const baseUrl = resolvePresetBaseUrl(providerId, update.baseUrl);
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw new RuntimeModelError(
      400,
      "bad_request",
      "The gateway address must be an http(s) URL ending at the OpenAI-compatible root, e.g. https://api.openai.com/v1",
    );
  }
  if (update.apiKey !== undefined && !update.apiKey.trim()) {
    throw new RuntimeModelError(400, "bad_request", "The key must not be empty. Leave it out to keep the stored one.");
  }
  const allowedModels = [...new Set(update.allowedModels.map((m) => m.trim()).filter(Boolean))];
  const defaultModel = update.defaultModel.trim();
  if (defaultModel && !allowedModels.includes(defaultModel)) {
    throw new RuntimeModelError(400, "bad_request", `The default model "${defaultModel}" must also be enabled.`, { allowedModels });
  }

  if (PERSONAL_PRODUCT) {
    if (!subject?.trim()) throw new RuntimeModelError(401, "unauthorized", "Sign in to save your AI connection.");
    const current = await loadUserRow(subject);
    const key = update.apiKey?.trim() ?? current?.apiKey ?? "";
    if (!key) throw new RuntimeModelError(400, "bad_request", "Paste an API key to connect this provider.");
    const values = {
      providerId: presetById(providerId).id,
      baseUrl,
      apiKeyEnc: encrypt(key),
      defaultModel,
      allowedModels,
      updatedAt: new Date(),
      updatedBy: by,
    };
    await db
      .insert(userLlmProviders)
      .values({ subject, ...values })
      .onConflictDoUpdate({ target: userLlmProviders.subject, set: values });
    invalidateModelConnection(subject);
    return (await loadUserRow(subject))!;
  }

  const current = await loadSingleton();
  const key = update.apiKey?.trim() ?? current.apiKey;
  const values = {
    baseUrl,
    apiKeyEnc: key ? encrypt(key) : null,
    defaultModel,
    allowedModels,
    updatedAt: new Date(),
    updatedBy: by,
  };
  await db.insert(runtimeModelProvider).values({ id: 1, ...values }).onConflictDoUpdate({ target: runtimeModelProvider.id, set: values });
  invalidateModelConnection();
  return loadSingleton();
}

/** Forget saved settings. Personal → delete user row; enterprise → delete singleton. */
export async function clearRuntimeProvider(subject?: string | null): Promise<RuntimeProvider> {
  if (PERSONAL_PRODUCT) {
    if (!subject?.trim()) throw new RuntimeModelError(401, "unauthorized", "Sign in to clear your AI connection.");
    await db.delete(userLlmProviders).where(eq(userLlmProviders.subject, subject));
    invalidateModelConnection(subject);
    return unconfiguredPersonal();
  }
  await db.delete(runtimeModelProvider).where(eq(runtimeModelProvider.id, 1));
  invalidateModelConnection();
  return fromEnv();
}

async function providerFetch(p: RuntimeProvider, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!p.baseUrl || !p.apiKey) {
    throw new RuntimeModelError(
      503,
      "provider_not_configured",
      PERSONAL_PRODUCT
        ? "Connect your AI provider on the AI models page (paste your API key)."
        : "No runtime model is configured. Set a gateway and key on the AI models page (or LLM_BASE_URL / LLM_API_KEY).",
    );
  }
  try {
    return await fetch(`${p.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${p.apiKey}` },
    });
  } catch (e) {
    const name = (e as Error).name;
    const msg = name === "AbortError" || name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
    throw new RuntimeModelError(502, "provider_unreachable", `The model gateway at ${p.baseUrl}: ${msg}`);
  }
}

export async function listModels(p: RuntimeProvider): Promise<string[]> {
  const res = await providerFetch(p, "/models", { method: "GET" }, 20_000);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RuntimeModelError(res.status === 401 || res.status === 403 ? 401 : 502, "provider_rejected", `The model gateway answered ${res.status} listing models: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
}

export const MODEL_LIST_CAVEAT =
  "The gateway listed these models. That is not proof the key can complete with any of them — listing succeeds for a " +
  "key with no quota or no access. Run the test completion.";

export interface CompletionResult {
  text: string;
  model: string;
  finishReason: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

const RUNTIME_TEMPERATURE = 1;
const rejectsTemperature = (status: number, body: string) => status === 400 && /temperature/i.test(body);

export async function complete(p: RuntimeProvider, opts: { model: string; system: string; user: string; maxTokens: number }): Promise<CompletionResult> {
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
      config.runtimeModel.timeoutMs,
    );
  let res = await send(true);
  let text = await res.text();
  if (rejectsTemperature(res.status, text)) {
    console.warn(`[llm_complete] ${opts.model} rejected temperature ${RUNTIME_TEMPERATURE}; retrying once without it. ${text.slice(0, 200)}`);
    res = await send(false);
    text = await res.text();
  }
  if (!res.ok) {
    throw new RuntimeModelError(res.status === 401 || res.status === 403 ? 401 : 502, "provider_rejected", `The model gateway answered ${res.status}: ${text.slice(0, 300)}`);
  }
  let json: { model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new RuntimeModelError(502, "provider_malformed", "The model gateway answered with something that is not JSON.");
  }
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new RuntimeModelError(502, "provider_malformed", "The model gateway answered with no message.");
  return {
    text: content,
    model: json.model ?? opts.model,
    finishReason: choice?.finish_reason ?? "unknown",
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
    latencyMs: Date.now() - startedAt,
  };
}

export function testCompletion(p: RuntimeProvider, model?: string): Promise<CompletionResult> {
  return complete(p, { model: model || p.defaultModel, system: "Reply with exactly the word OK.", user: "OK?", maxTokens: 8 });
}

/** Unsaved gateway/key for Fetch models / Test before save. */
export async function probeOf(
  b: { baseUrl?: string; apiKey?: string; providerId?: string },
  subject?: string | null,
): Promise<RuntimeProvider> {
  const stored = await loadRuntimeProvider({ subject, mode: PERSONAL_PRODUCT ? "interactive" : "harness" });
  const providerId = b.providerId ?? stored.providerId ?? "custom";
  const baseUrl = b.baseUrl?.trim()
    ? resolvePresetBaseUrl(providerId, b.baseUrl)
    : stored.baseUrl;
  return {
    ...stored,
    providerId,
    baseUrl,
    apiKey: b.apiKey?.trim() ? b.apiKey.trim() : stored.apiKey,
  };
}
