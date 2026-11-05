/**
 * The RUNTIME model: who `llm_complete` calls, with what key, and which models a workflow may name (2026-10-30, moved
 * here from ops-api's `llm/provider.ts` with its rules unchanged).
 *
 * ⚠ Not the builder's model. `inference.service.ts` / `generation-provider.service.ts` are the model that DESIGNS
 * workflows; this is the one a running workflow calls. D-35 keeps them apart: separate settings, separate code, no
 * shared abstraction. Its "different processes" clause is what this move amended — both now run in the server.
 *
 *  - **The settings are a ROW** (`runtime_model_provider`, set on the AI models page); the `LLM_*` environment values
 *    are the fallback until one is saved (`source: "env"`).
 *  - **The key is write-only.** Encrypted under `CREDENTIAL_ENC_KEY` like every stored credential; no route returns it.
 *    A fingerprint (eight hex characters of a salted digest) tells two keys apart and reconstructs neither.
 *  - **The base URL is operator-set, never caller-set.** A step passes `instruction` and `input`; nothing it sends can
 *    point this at another host.
 *  - **The enabled list is a spend control**: a step naming a model not on it is refused by name, never substituted.
 *  - **A model list is not proof a key works** (a gateway lists models for a key with no quota). Only a completion is.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { runtimeModelProvider } from "../db/schema.js";
import { decrypt, encrypt } from "../utils/encryptor.js";

export interface RuntimeProvider {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  allowedModels: string[];
  /** Where the live values came from — `env` until someone saves the settings. */
  source: "env" | "configured";
  updatedAt: string | null;
}

/** What an operator may see. Deliberately has no `apiKey`. */
export type RuntimeProviderView = Omit<RuntimeProvider, "apiKey"> & { configured: boolean; keyFingerprint: string };

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
  };
}

/** The live settings: the saved row if there is one, else the environment. */
export async function loadRuntimeProvider(): Promise<RuntimeProvider> {
  const [row] = await db.select().from(runtimeModelProvider).where(eq(runtimeModelProvider.id, 1)).limit(1);
  if (!row) return fromEnv();
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ""),
    apiKey: row.apiKeyEnc ? decrypt(row.apiKeyEnc) : fromEnv().apiKey,
    defaultModel: row.defaultModel,
    allowedModels: Array.isArray(row.allowedModels) ? row.allowedModels : [],
    source: "configured",
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function viewOf(p: RuntimeProvider): RuntimeProviderView {
  const { apiKey, ...rest } = p;
  return { ...rest, configured: Boolean(p.baseUrl && apiKey), keyFingerprint: keyFingerprint(apiKey) };
}

export class RuntimeModelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

/**
 * Save the settings. `apiKey` omitted keeps the stored one; the empty string is refused. The default model must be on
 * the enabled list.
 */
export async function saveRuntimeProvider(update: { baseUrl: string; apiKey?: string; defaultModel: string; allowedModels: string[] }, by: string | null): Promise<RuntimeProvider> {
  const baseUrl = update.baseUrl.trim();
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw new RuntimeModelError(400, "bad_request", "The gateway address must be an http(s) URL ending at the OpenAI-compatible root, e.g. https://gateway.example/v1");
  }
  if (update.apiKey !== undefined && !update.apiKey.trim()) {
    throw new RuntimeModelError(400, "bad_request", "The key must not be empty. Leave it out to keep the stored one.");
  }
  const allowedModels = [...new Set(update.allowedModels.map((m) => m.trim()).filter(Boolean))];
  const defaultModel = update.defaultModel.trim();
  if (defaultModel && !allowedModels.includes(defaultModel)) {
    throw new RuntimeModelError(400, "bad_request", `The default model "${defaultModel}" must also be enabled.`, { allowedModels });
  }
  const current = await loadRuntimeProvider();
  const key = update.apiKey?.trim() ?? current.apiKey;
  const values = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKeyEnc: key ? encrypt(key) : null,
    defaultModel,
    allowedModels,
    updatedAt: new Date(),
    updatedBy: by,
  };
  await db.insert(runtimeModelProvider).values({ id: 1, ...values }).onConflictDoUpdate({ target: runtimeModelProvider.id, set: values });
  return loadRuntimeProvider();
}

/** Forget the saved settings and fall back to the environment. */
export async function clearRuntimeProvider(): Promise<RuntimeProvider> {
  await db.delete(runtimeModelProvider).where(eq(runtimeModelProvider.id, 1));
  return loadRuntimeProvider();
}

async function providerFetch(p: RuntimeProvider, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!p.baseUrl) {
    throw new RuntimeModelError(503, "provider_not_configured", "No runtime model is configured. Set a gateway and key on the AI models page (or LLM_BASE_URL / LLM_API_KEY).");
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

/** The models the gateway advertises. ⚠ Not evidence that completions work — see `testCompletion`. */
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

/**
 * The temperature every `llm_complete` call asks for: 1 since 2026-09-17, nobody may set it. Some models refuse any
 * other value, so a 400 that NAMES `temperature` is retried once without it; nothing downstream may depend on this
 * output being stable either way (D-34).
 */
const RUNTIME_TEMPERATURE = 1;
const rejectsTemperature = (status: number, body: string) => status === 400 && /temperature/i.test(body);

/** One completion. No streaming, no tools, no JSON mode. */
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

/** A real, tiny completion — the only thing that proves a key works. */
export function testCompletion(p: RuntimeProvider, model?: string): Promise<CompletionResult> {
  return complete(p, { model: model || p.defaultModel, system: "Reply with exactly the word OK.", user: "OK?", maxTokens: 8 });
}

/** The settings with an unsaved gateway or key swapped in, for "Fetch models" and "Test" before saving. */
export async function probeOf(b: { baseUrl?: string; apiKey?: string }): Promise<RuntimeProvider> {
  const stored = await loadRuntimeProvider();
  return {
    ...stored,
    baseUrl: b.baseUrl?.trim() ? b.baseUrl.trim().replace(/\/+$/, "") : stored.baseUrl,
    apiKey: b.apiKey?.trim() ? b.apiKey.trim() : stored.apiKey,
  };
}
