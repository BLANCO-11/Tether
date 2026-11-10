/**
 * One model connection for the deployment (2026-11-04): one connection, one enabled-model list, one default model.
 * This file holds only the pure parts: the merge rule migration 0136 applies in SQL, Forge reachability, and the
 * last-resolved connection snapshot that pi-runner reads synchronously. It imports nothing, so it loads anywhere.
 */

export type ModelLists = { defaultModel: string; allowedModels: unknown };

/** Non-array lists count as empty; non-string and blank entries are dropped; each entry is trimmed. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cleanDefault(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The rule migration 0136 applies in SQL. Null generation = nothing to merge. */
export function mergeModelLists(
  runtime: ModelLists | null,
  generation: ModelLists | null,
): { defaultModel: string; allowedModels: string[] } | null {
  if (generation === null) return null;
  const runtimeDefault = runtime ? cleanDefault(runtime.defaultModel) : "";
  const generationDefault = cleanDefault(generation.defaultModel);
  const defaultModel = runtimeDefault || generationDefault || "";
  const combined = [
    ...(runtime ? cleanList(runtime.allowedModels) : []),
    ...cleanList(generation.allowedModels),
    ...(defaultModel ? [defaultModel] : []),
  ];
  return { defaultModel, allowedModels: [...new Set(combined)] };
}

/** The lower-cased host of a URL, or "" when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Whether Forge can reach the saved gateway. `egressAllow` is FORGE_EGRESS_ALLOW (comma-separated host:port); empty
 * means the host of the environment's LLM_BASE_URL. Warns only when the gateway's host is outside that list.
 */
export function forgeReachability(
  connectionBaseUrl: string,
  envBaseUrl: string,
  egressAllow: string,
): { forgeReachable: boolean; forgeWarning: string | null } {
  const allowed = egressAllow.trim()
    ? egressAllow
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
        .map((entry) => entry.replace(/:\d+$/, ""))
    : [hostOf(envBaseUrl)].filter(Boolean);
  const host = hostOf(connectionBaseUrl);
  if (host === "" || allowed.includes(host)) return { forgeReachable: true, forgeWarning: null };
  const source = egressAllow.trim() ? "FORGE_EGRESS_ALLOW" : "the host of LLM_BASE_URL";
  return {
    forgeReachable: false,
    forgeWarning:
      `Forge chats can only reach ${allowed.join(", ") || "no host"} (${source}). ` +
      `This gateway is ${host}, so Forge chats will fail until FORGE_EGRESS_ALLOW in the deployment's .env includes ` +
      `${host}:443 and the containers are recreated with docker compose up -d.`,
  };
}

export type ModelConnectionSnapshot = { baseUrl: string; apiKey: string; providerId?: string };

/** The connection most recently resolved from the database; null until something is remembered. */
let lastConnection: ModelConnectionSnapshot | null = null;

/** Remember the resolved connection so pi-runner can read it synchronously. */
export function rememberModelConnection(c: ModelConnectionSnapshot): void {
  lastConnection = { baseUrl: c.baseUrl, apiKey: c.apiKey, ...(c.providerId ? { providerId: c.providerId } : {}) };
}

export function lastModelConnection(): ModelConnectionSnapshot | null {
  return lastConnection ? { ...lastConnection } : null;
}
