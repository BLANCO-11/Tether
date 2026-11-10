import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "./llm-provider-presets.js";

export const TETHER_USER_AGENT = "Tether/1.0";

export type GatewayKind = "opencode_go" | "opencode_zen" | "custom";

export type GatewayConn = { providerId?: string | null; baseUrl?: string | null };

/** Which gateway family a connection is: the saved provider first, else the shape of an opencode.ai URL. */
export function gatewayKind(c: GatewayConn): GatewayKind {
  const id = normalizeProviderId(c.providerId);
  if (id === "opencode_go" || id === "opencode_zen") return id;
  let url: URL;
  try {
    url = new URL(c.baseUrl ?? "");
  } catch {
    return "custom";
  }
  const host = url.hostname.toLowerCase();
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    return url.pathname.includes("/go/") ? "opencode_go" : "opencode_zen";
  }
  return "custom";
}

/**
 * Extra headers EVERY outbound LLM request must carry for this connection.
 * Go answers 400 MissingSessionID without `x-opencode-session`. Callers pass a stable conversation id
 * (chat id, Forge session id, flow run id). A uuid per request is used when there is none.
 */
export function gatewayHeaders(c: GatewayConn, sessionKey?: string | null): Record<string, string> {
  switch (gatewayKind(c)) {
    case "opencode_go":
      return { "x-opencode-session": sessionKey?.trim() || randomUUID(), "User-Agent": TETHER_USER_AGENT };
    case "opencode_zen":
      return { "User-Agent": TETHER_USER_AGENT };
    default:
      return {};
  }
}
