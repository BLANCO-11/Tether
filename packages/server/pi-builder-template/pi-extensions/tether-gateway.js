/**
 * Register the AI gateway as a pi provider that sends request headers. Load with: pi -e ./pi-extensions/tether-gateway.js
 *
 * OpenCode Go answers 400 MissingSessionID unless every request carries `x-opencode-session: <stable id>`, and wants
 * `User-Agent: Tether/1.0`. pi 0.74.2 predates its own OpenCode session-header fix, and the `litellm` provider cannot send
 * custom headers; an extension-registered provider can (provider-level `headers`). The server hands the config over as
 * PI_GATEWAY_BASE_URL (full URL incl. /v1) and PI_GATEWAY_HEADERS (JSON), only for OpenCode connections; without them
 * this extension does nothing and pi keeps using litellm.
 */
export const TETHER_GATEWAY_PROVIDER = "tether-gateway";

function parseHeaders(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function gatewayProviderConfig(env) {
  if (!env.PI_GATEWAY_BASE_URL || !env.PI_MODEL) return null;
  const model = env.PI_MODEL.replace(/^[^/]+\//, "");
  return {
    name: "Tether gateway",
    baseUrl: env.PI_GATEWAY_BASE_URL,
    // The literal key, not a `$VAR` reference: the env-interpolation syntax differs between pi versions.
    apiKey: env.LITELLM_API_KEY || "",
    api: "openai-completions",
    headers: parseHeaders(env.PI_GATEWAY_HEADERS),
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],
  };
}

export default function (pi) {
  const cfg = gatewayProviderConfig(process.env);
  if (cfg) pi.registerProvider(TETHER_GATEWAY_PROVIDER, cfg);
}
