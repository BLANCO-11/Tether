import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `llm`/`http` Foundry callbacks (Stage 4.1/4.2) — the THIRD sender's own
// test (`inference.service.ts` requires one rather than a shared module).
//
// `node:dns/promises` is mocked so `classifyHost(STRICT)` resolves without a
// real round trip; `fetch` is stubbed per test. Recorded targets, both honoring
// the STRICT profile (public addresses only — `127.0.0.1` is refused below):
//   - gateway: https://gateway.example.test/chat/completions
//   - http target: https://hooks.example.test/shortlist
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const { resolveGenerationProviderMock } = vi.hoisted(() => ({
  resolveGenerationProviderMock: vi.fn(async () => ({ model: "deployment-model" })),
}));
vi.mock("./generation-provider.service.js", () => ({
  resolveGenerationProvider: resolveGenerationProviderMock,
}));

const { stepExecutionService, StepError, resetLlmTemperatureMemory } = await import(
  "./step-execution.service.js"
);

const LLM_BODY = {
  ref: "llm",
  stepId: "ask",
  taskrunId: "t-1",
  params: {
    model: "test-model",
    temperature: 0.7,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    messages: [{ role: "user" as const, text: "Which invoices are worth escalation?" }],
    outputFields: [{ name: "shortlist", type: "array" as const }],
    contextStepId: null,
  },
};

const HTTP_BODY = {
  stepId: "post",
  taskrunId: "t-1",
  params: {
    method: "POST" as const,
    url: "https://hooks.example.test/shortlist",
    headers: [{ name: "Content-Type", value: "application/json" }],
    queryParams: [],
    body: { kind: "json" as const, content: '{"items": []}' },
    auth: { kind: "none" as const },
    timeouts: null,
    sslVerify: true,
  },
};

function gatewayAnswer(content: string, reasoning?: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
          },
        ],
      }),
  }) as unknown as Response);
}

function httpAnswer(status: number, payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
  }) as unknown as Response);
}

beforeEach(async () => {
  const { lookup } = await import("node:dns/promises");
  // hooks.example.test resolves public — STRICT allows the dial.
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  delete process.env.HOOKS_TOKEN;
  // The llm temperature memory is process-lifetime — reset it so each case
  // measures its own retry, and point the deployment fallback at one model.
  resetLlmTemperatureMemory();
  resolveGenerationProviderMock.mockResolvedValue({ model: "deployment-model" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.HOOKS_TOKEN;
});

describe("invokeLlm — the step's model, sampling and prompt reach the gateway", () => {
  it("sends the chosen model and sampling params, and returns text plus declared fields", async () => {
    const fetchMock = gatewayAnswer(JSON.stringify({ text: "Escalate A-1.", shortlist: ["A-1"] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await stepExecutionService.llm("ws-1", LLM_BODY, "run-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("test-model");
    expect(sent.temperature).toBe(0.7);
    expect(sent.messages[0].content).toContain("Which invoices are worth escalation?");
    expect(sent.messages[0].content).toContain("shortlist");
    expect(init.headers).toMatchObject({ "x-foundry-run": "run-1" });
    expect(out.text).toBe("Escalate A-1.");
    expect(out.shortlist).toEqual(["A-1"]);
    expect(out.reasoning_content).toBeNull();
  });

  it("prose without the declared shape is still the answer, not a refusal", async () => {
    vi.stubGlobal("fetch", gatewayAnswer("Just escalate A-1, trust me."));
    const out = await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(out.text).toBe("Just escalate A-1, trust me.");
  });

  it("a gateway failure fails the step — a lost answer must be retryable, not data", async () => {
    vi.stubGlobal("fetch", httpAnswer(503, { error: "overloaded" }));
    await expect(stepExecutionService.llm("ws-1", LLM_BODY)).rejects.toBeInstanceOf(StepError);
  });
});

describe("invokeLlm — gateway adaptations (temperature strip, model fallback)", () => {
  const gatewayFailure = (status: number, bodyText: string) =>
    vi.fn(async () => ({ ok: false, status, text: async () => bodyText }) as unknown as Response);

  const sentBody = (calls: unknown[][], call: number) =>
    JSON.parse((calls[call][1] as RequestInit).body as string);

  it("retries once without temperature when the provider names it", async () => {
    // Ordered: a 400 naming temperature, then the stripped retry succeeding.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Unsupported value: 'temperature' does not support 0.7 with this model" } as unknown as Response)
      .mockResolvedValueOnce(await gatewayAnswer("Recovered without temperature.")());
    vi.stubGlobal("fetch", fetchMock);
    const out = await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock.mock.calls, 0).temperature).toBe(0.7);
    expect(sentBody(fetchMock.mock.calls, 1)).not.toHaveProperty("temperature");
    expect(out.text).toBe("Recovered without temperature.");
    expect(out.model).toBe("test-model");
  });

  it("a 400 that does not name temperature is not retried", async () => {
    const fetchMock = httpAnswer(400, { error: "prompt too long" });
    vi.stubGlobal("fetch", fetchMock);
    const err = await stepExecutionService.llm("ws-1", LLM_BODY).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("after one strip the process omits temperature on the first attempt", async () => {
    const strip = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Unsupported value: 'temperature' is not supported" } as unknown as Response)
      .mockResolvedValueOnce(await gatewayAnswer("First answer.")());
    vi.stubGlobal("fetch", strip);
    await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(strip).toHaveBeenCalledTimes(2);
    const fetchMock = gatewayAnswer("Second answer.");
    vi.stubGlobal("fetch", fetchMock);
    const out = await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBody(fetchMock.mock.calls, 0)).not.toHaveProperty("temperature");
    expect(out.text).toBe("Second answer.");
  });

  it("a 404 falls back to the deployment model and states the substitution", async () => {
    resolveGenerationProviderMock.mockResolvedValue({ model: "deployment-model" });
    const fallbackAnswer = await gatewayAnswer(
      JSON.stringify({ text: "Escalate A-1.", shortlist: ["A-1"] }),
    )();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "model not found" } as unknown as Response)
      .mockResolvedValueOnce(fallbackAnswer);
    vi.stubGlobal("fetch", fetchMock);
    const out = await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock.mock.calls, 0).model).toBe("test-model");
    expect(sentBody(fetchMock.mock.calls, 1).model).toBe("deployment-model");
    expect(resolveGenerationProviderMock).toHaveBeenCalled();
    expect(out.model).toBe("deployment-model");
    expect(out.shortlist).toEqual(["A-1"]);
    expect(out.text).toContain("answered by deployment-model — the deployment does not serve test-model");
  });

  it("a failed fallback throws the original 404, not the fallback failure", async () => {
    resolveGenerationProviderMock.mockResolvedValue({ model: "deployment-model" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "model not found" } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "fallback exploded" } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const err = await stepExecutionService.llm("ws-1", LLM_BODY).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.message).toContain("gateway returned HTTP 404");
    expect(err.detail).toEqual({ status: 404 });
  });

  it("no fallback when the deployment already serves the requested model", async () => {
    resolveGenerationProviderMock.mockResolvedValue({ model: "test-model" });
    const fetchMock = gatewayFailure(404, "model not found");
    vi.stubGlobal("fetch", fetchMock);
    const err = await stepExecutionService.llm("ws-1", LLM_BODY).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(err.message).toContain("gateway returned HTTP 404");
  });

  it("the envelope names the serving model even when nothing was substituted", async () => {
    vi.stubGlobal("fetch", gatewayAnswer("Just escalate A-1, trust me."));
    const out = await stepExecutionService.llm("ws-1", LLM_BODY);
    expect(out.model).toBe("test-model");
    expect(out.text).toBe("Just escalate A-1, trust me.");
    expect(out.text).not.toContain("answered by");
  });
});

describe("invokeHttp — classified, dialled and enveloped by Foundry", () => {
  it("returns {body, status_code, headers, size} for the recorded target", async () => {
    vi.stubGlobal("fetch", httpAnswer(200, { received: true }));
    const out = await stepExecutionService.http("ws-1", HTTP_BODY, "run-1");
    expect(out.body).toEqual({ received: true });
    expect(out.status_code).toBe(200);
    expect(out.headers["content-type"]).toContain("application/json");
    expect(out.size).toBeGreaterThan(0);
  });

  it("reads auth.secretRef from the environment and sends it — never logged, never echoed", async () => {
    process.env.HOOKS_TOKEN = "hook-secret-value";
    const fetchMock = httpAnswer(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const authed = {
      ...HTTP_BODY,
      params: { ...HTTP_BODY.params, auth: { kind: "bearer" as const, secretRef: "HOOKS_TOKEN" } },
    };
    await stepExecutionService.http("ws-1", authed);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer hook-secret-value");
  });

  it("a named-but-unset secret fails closed, naming the ref and not the value", async () => {
    const authed = {
      ...HTTP_BODY,
      params: { ...HTTP_BODY.params, auth: { kind: "bearer" as const, secretRef: "HOOKS_TOKEN" } },
    };
    const err = await stepExecutionService.http("ws-1", authed).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(424);
    expect(err.message).toContain("HOOKS_TOKEN");
    expect(err.message).not.toContain("hook-secret");
  });

  it("STRICT refuses loopback without dialing — the egress decision", async () => {
    const fetchMock = httpAnswer(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const loopback = { ...HTTP_BODY, params: { ...HTTP_BODY.params, url: "http://127.0.0.1:9/x" } };
    await expect(stepExecutionService.http("ws-1", loopback)).rejects.toThrow(/egress_rejected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-2xx status throws with the status — so Kestra retries it", async () => {
    vi.stubGlobal("fetch", httpAnswer(503, { error: "down" }));
    const err = await stepExecutionService.http("ws-1", HTTP_BODY).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(503);
    expect(err.message).toContain("hooks.example.test");
    expect(err.message).not.toContain("down");
  });
});
