/**
 * Images kept under the AI gateway's size limit (pi-builder-template/pi-extensions/image-budget.js, 2026-10-12): an
 * 800 KB image left in the conversation made the gateway refuse every later turn with a 413.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain-JS pi extension, loaded by pi rather than by this package
import imageBudget from "../../pi-builder-template/pi-extensions/image-budget.js";

type Handler = (event: Record<string, unknown>) => unknown;
function hooks(): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  imageBudget({ on: (name: string, fn: Handler) => (on[name] = fn) });
  return on;
}
const img = (kb: number) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(kb * 1024)}` } });

describe("before_provider_request", () => {
  it("removes the OLDEST images until the request fits, and keeps the newest", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }, img(500)] },
        { role: "user", content: [{ type: "text", text: "second" }, img(500)] },
      ],
    };
    const out = hooks().before_provider_request!({ payload }) as typeof payload;
    expect(out.messages[0]!.content[1]).toMatchObject({ type: "text" });
    expect(out.messages[1]!.content[1]).toMatchObject({ type: "image_url" });
    expect(JSON.stringify(out).length).toBeLessThan(900 * 1024);
  });

  it("leaves a request that already fits alone", () => {
    const payload = { messages: [{ role: "user", content: [img(100)] }] };
    expect(hooks().before_provider_request!({ payload })).toBeUndefined();
  });
});

describe("tool_result", () => {
  it("leaves a small image as it is", async () => {
    const content = [{ type: "image", data: "A".repeat(1000), mimeType: "image/png" }];
    expect(await hooks().tool_result!({ content })).toBeUndefined();
  });

  it("never passes a large image through at full size", async () => {
    const content = [{ type: "image", data: "A".repeat(600 * 1024), mimeType: "image/png" }];
    const out = (await hooks().tool_result!({ content })) as { content: Array<{ type: string; data?: string }> };
    for (const c of out.content) if (c.type === "image") expect(c.data!.length).toBeLessThanOrEqual(350 * 1024);
    expect(out.content.some((c) => c.type === "text")).toBe(true);
  });
});
