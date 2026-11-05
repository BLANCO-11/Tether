/**
 * Force reasoning_effort=none for *luna* models so LiteLLM accepts tools on
 * /v1/chat/completions. Load with: pi -e ./pi-extensions/luna-tools-compat.js
 */
export default function (pi) {
  pi.on("before_provider_request", (event, ctx) => {
    const id = ctx.model?.id || "";
    if (!/luna/i.test(id)) return;
    if (typeof event.payload !== "object" || event.payload === null) return;
    const out = { ...event.payload, reasoning_effort: "none" };
    if (out.reasoning && typeof out.reasoning === "object") {
      out.reasoning = { ...out.reasoning, effort: "none" };
    }
    return out;
  });
}
