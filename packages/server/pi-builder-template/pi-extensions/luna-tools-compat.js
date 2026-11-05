/**
 * Set reasoning_effort for *luna* models. Load with: pi -e ./pi-extensions/luna-tools-compat.js
 *
 * The effort is the chat's thinking level (thinking.ts), handed to the process as PI_FORGE_REASONING_EFFORT; without
 * it, "none". gpt-5.x luna refuses any effort but "none" while tools are attached ("Responses API is enabled only for
 * api-version 2025-03-01-preview and later", measured 2026-10-29), so it always gets "none" — that refusal is why this
 * extension exists. gpt-6-luna takes none…xhigh with tools.
 */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function effortFor(modelId, wanted) {
  if (/gpt-5/i.test(modelId)) return "none";
  return EFFORTS.has(wanted) ? wanted : "none";
}

export default function (pi) {
  pi.on("before_provider_request", (event, ctx) => {
    const id = ctx.model?.id || "";
    if (!/luna/i.test(id)) return;
    if (typeof event.payload !== "object" || event.payload === null) return;
    const effort = effortFor(id, process.env.PI_FORGE_REASONING_EFFORT);
    const out = { ...event.payload, reasoning_effort: effort };
    if (out.reasoning && typeof out.reasoning === "object") {
      out.reasoning = { ...out.reasoning, effort };
    }
    return out;
  });
}
