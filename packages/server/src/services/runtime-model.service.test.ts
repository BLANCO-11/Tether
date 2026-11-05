/**
 * The runtime model in Foundry (2026-10-30, moved from ops-api): the settings round-trip with the key write-only, and
 * the `llm_complete` endpoint's rules — through the real app, against a stand-in gateway (no real model is called).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { db } from "../db/index.js";
import { runtimeModelProvider } from "../db/schema.js";
import { clearRuntimeProvider, loadRuntimeProvider, saveRuntimeProvider, viewOf } from "./runtime-model.service.js";
import { llmServiceKey, LLM_KEY_HEADER } from "./llm-service-key.js";

const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;
const GATEWAY = "https://gateway.test.example/v1";
const realFetch = globalThis.fetch;

/** The stand-in gateway: answers chat completions; everything else goes to the real fetch (our own app). */
function gateway(reply: { content?: string; finish_reason?: string; status?: number }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(GATEWAY)) return realFetch(input as Parameters<typeof fetch>[0], init);
    if (reply.status) return new Response("nope", { status: reply.status });
    return new Response(
      JSON.stringify({ model: "m1", choices: [{ finish_reason: reply.finish_reason ?? "stop", message: { content: reply.content ?? "A short summary." } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

const call = (body: unknown, key = llmServiceKey()) =>
  realFetch(`${base}/api/llm/complete`, { method: "POST", headers: { "content-type": "application/json", [LLM_KEY_HEADER]: key }, body: JSON.stringify(body) });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.delete(runtimeModelProvider);
  await saveRuntimeProvider({ baseUrl: GATEWAY, apiKey: "sk-test-123", defaultModel: "m1", allowedModels: ["m1"] }, "test");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.delete(runtimeModelProvider);
  server?.close();
});

describe("the runtime model's settings", () => {
  it("round-trip with the key stored encrypted and never shown — a fingerprint instead", async () => {
    const [row] = await db.select().from(runtimeModelProvider);
    expect(row!.apiKeyEnc).not.toContain("sk-test-123");
    const p = await loadRuntimeProvider();
    expect(p.apiKey).toBe("sk-test-123");
    const view = viewOf(p);
    expect(JSON.stringify(view)).not.toContain("sk-test-123");
    expect(view.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(view.source).toBe("configured");
  });

  it("refuses a default model that is not enabled, and an empty key", async () => {
    await expect(saveRuntimeProvider({ baseUrl: GATEWAY, defaultModel: "m2", allowedModels: ["m1"] }, null)).rejects.toThrow(/must also be enabled/);
    await expect(saveRuntimeProvider({ baseUrl: GATEWAY, apiKey: "  ", defaultModel: "m1", allowedModels: ["m1"] }, null)).rejects.toThrow(/must not be empty/);
  });

  it("a save that leaves the key out keeps the stored one", async () => {
    const p = await saveRuntimeProvider({ baseUrl: GATEWAY, defaultModel: "m1", allowedModels: ["m1", "m3"] }, null);
    expect(p.apiKey).toBe("sk-test-123");
    expect(p.allowedModels).toEqual(["m1", "m3"]);
  });
});

describe("POST /api/llm/complete", () => {
  it("answers with ONE text field", async () => {
    gateway({ content: "Two stories today." });
    const r = await call({ instruction: "summarise", input: "a, b" });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { text: string; usage: { prompt_tokens: number } };
    expect(b.text).toBe("Two stories today.");
    expect(b.usage.prompt_tokens).toBe(10);
  });

  it("refuses without its key, and never with the parent key", async () => {
    expect((await call({ instruction: "x", input: "" }, "wrong")).status).toBe(401);
  });

  it("a model that is not enabled is refused by name, never substituted", async () => {
    gateway({});
    const r = await call({ instruction: "x", input: "", model: "gpt-unlisted" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toContain("gpt-unlisted");
  });

  it("a truncated answer is a named failure, never a 200 over half a document", async () => {
    gateway({ finish_reason: "length", content: "Half a sen" });
    const r = await call({ instruction: "write a report", input: "rows" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe("output_truncated");
  });

  it("the gateway refusing the key says so, as the gateway's answer", async () => {
    gateway({ status: 401 });
    const r = await call({ instruction: "x", input: "" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { message: string }).message).toContain("gateway");
  });

  it("cleared, the settings fall back to the environment", async () => {
    await clearRuntimeProvider();
    const p = await loadRuntimeProvider();
    expect(p.source).toBe("env");
    await saveRuntimeProvider({ baseUrl: GATEWAY, apiKey: "sk-test-123", defaultModel: "m1", allowedModels: ["m1"] }, "test");
  });
});
