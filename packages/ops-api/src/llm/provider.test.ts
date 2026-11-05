import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { complete, keyFingerprint, viewOf, type ProviderConfig } from "./provider.js";

const CONFIG: ProviderConfig = {
  baseUrl: "https://gateway.example/v1",
  apiKey: "sk-super-secret-value",
  defaultModel: "some/model",
  allowedModels: ["some/model", "other/model"],
  source: "configured",
  updatedAt: "2026-07-31T00:00:00.000Z",
};

describe("the provider view never carries the credential", () => {
  it("has no apiKey field at all, not an empty one", () => {
    // An empty-string field is worse than an absent one: a client renders it as
    // "not set" and a future edit that forgets to blank it ships the value. The
    // type omits it; this asserts the runtime object does too.
    const view = viewOf(CONFIG) as Record<string, unknown>;
    expect("apiKey" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("sk-super-secret-value");
  });

  it("reports configured only when there is both a URL and a key", () => {
    expect(viewOf(CONFIG).configured).toBe(true);
    expect(viewOf({ ...CONFIG, apiKey: "" }).configured).toBe(false);
    expect(viewOf({ ...CONFIG, baseUrl: "" }).configured).toBe(false);
  });
});

describe("keyFingerprint", () => {
  it("is the documented recipe — salted sha256, first 8 hex", () => {
    // Re-derived rather than compared to itself. The operator surface is the one
    // place where "let them see a bit of the key to check it" is a tempting
    // change, and a self-referential test would pass through exactly that.
    expect(keyFingerprint("sk-super-secret-value")).toBe(
      createHash("sha256").update("fp:sk-super-secret-value").digest("hex").slice(0, 8),
    );
  });

  it("distinguishes two keys and reconstructs neither", () => {
    const a = keyFingerprint("sk-aaaaaaaaaaaaaaaaaaaa");
    const b = keyFingerprint("sk-aaaaaaaaaaaaaaaaaaab");
    expect(a).not.toBe(b);
    // The control: a fingerprint that were a prefix or suffix of the key would
    // satisfy "stable" and "distinguishing" while leaking the thing.
    expect("sk-aaaaaaaaaaaaaaaaaaaa").not.toContain(a);
    expect(a).toHaveLength(8);
  });

  it("is empty for an unset key rather than a digest of nothing", () => {
    // A fingerprint for "" would render in the UI as a configured-looking value
    // for a provider with no credential at all.
    expect(keyFingerprint("")).toBe("");
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ REPORTED FROM USE (2026-09-04) — `llm_complete` failed for every flow
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   LLM provider returned 400: Unsupported value: 'temperature' does not
 *   support 0 with this model. Only the default (1) is supported.
 *   Model Group=gpt-5.6-luna
 *
 * `temperature: 0` was hardcoded and sent unconditionally. Under gate 1 that is
 * not a degraded answer, it is a flow that can never be armed.
 *
 * The three properties below are the whole control, and the second and third
 * are what stop the fix from being "retry any 400 with less in it".
 */
describe("complete — a model that refuses the temperature we send", () => {
  const P: ProviderConfig = { ...CONFIG, baseUrl: "https://gateway.example/v1" };
  const OPTS = { model: "gpt-5.6-luna", system: "s", user: "u", maxTokens: 16 };
  const OK = JSON.stringify({
    model: "gpt-5.6-luna",
    choices: [{ finish_reason: "stop", message: { content: "hello" } }],
  });
  const REFUSAL =
    "Unsupported value: 'temperature' does not support 0 with this model. " +
    "Only the default (1) is supported. Model Group=gpt-5.6-luna";

  function stub(replies: Array<{ status: number; body: string }>) {
    const sent: Array<Record<string, unknown>> = [];
    const fetchStub = async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const r = replies[sent.length - 1];
      if (!r) throw new Error(`unexpected call ${sent.length}`);
      return new Response(r.body, { status: r.status });
    };
    vi.stubGlobal("fetch", fetchStub);
    return sent;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("sends the declared temperature on the first attempt", async () => {
    // The control on the whole change: every existing measurement in this repo
    // was taken against a body carrying `temperature: 0`, and one attempt is
    // still exactly that body. A version that dropped the field pre-emptively
    // would pass the retry test below and silently move every reading.
    const sent = stub([{ status: 200, body: OK }]);
    const out = await complete(P, OPTS);
    expect(out.text).toBe("hello");
    expect(sent).toHaveLength(1);
    expect(sent[0].temperature).toBe(1);
  });

  it("retries ONCE without it when the provider names temperature", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 200, body: OK },
    ]);
    const out = await complete(P, OPTS);
    expect(out.text).toBe("hello");
    expect(sent).toHaveLength(2);
    expect(sent[0].temperature).toBe(1);
    // Absent, not zero and not null: a provider that rejects the value rejects
    // it however it is spelled, and `"temperature": null` is still the key.
    expect("temperature" in sent[1]).toBe(false);
    // Everything else about the request is the same request.
    expect(sent[1].model).toBe("gpt-5.6-luna");
    expect(sent[1].max_tokens).toBe(16);
    expect(sent[1].messages).toEqual(sent[0].messages);
  });

  it("does NOT retry a 400 that says nothing about temperature", async () => {
    // The narrowing that makes this a fix rather than a blanket second attempt.
    // Re-sending a malformed request reports the SECOND failure, which is the
    // one carrying less about what was actually wrong.
    const sent = stub([{ status: 400, body: "context_length_exceeded" }]);
    await expect(complete(P, OPTS)).rejects.toThrow(/context_length_exceeded/);
    expect(sent).toHaveLength(1);
  });

  it("does not retry a second time — a second refusal is returned as it arrived", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 400, body: REFUSAL },
    ]);
    await expect(complete(P, OPTS)).rejects.toThrow(/does not support 0/);
    expect(sent).toHaveLength(2);
  });
});
