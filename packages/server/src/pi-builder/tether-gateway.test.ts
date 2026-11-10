/**
 * The gateway provider extension (pi-builder-template/pi-extensions/tether-gateway.js): OpenCode needs per-request
 * session headers that pi 0.74.2's litellm provider cannot send.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error a plain-JS pi extension, loaded by pi rather than by this package
import gateway, { gatewayProviderConfig, TETHER_GATEWAY_PROVIDER } from "../../pi-builder-template/pi-extensions/tether-gateway.js";

const HEADERS = JSON.stringify({ "x-opencode-session": "s1", "User-Agent": "Tether/1.0" });
const env = {
  PI_GATEWAY_BASE_URL: "https://opencode.ai/inference/go/openai/v1",
  PI_GATEWAY_HEADERS: HEADERS,
  PI_MODEL: "litellm/kimi-k2",
  LITELLM_API_KEY: "key",
};

afterEach(() => vi.unstubAllEnvs());

describe("gatewayProviderConfig", () => {
  it("is null without a gateway base URL", () => {
    expect(gatewayProviderConfig({ PI_MODEL: "m" })).toBeNull();
  });

  it("carries the headers, key and a prefix-free model", () => {
    const cfg = gatewayProviderConfig(env);
    expect(cfg.baseUrl).toBe(env.PI_GATEWAY_BASE_URL);
    expect(cfg.headers).toEqual({ "x-opencode-session": "s1", "User-Agent": "Tether/1.0" });
    expect(cfg.apiKey).toBe("key");
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.models[0].id).toBe("kimi-k2");
  });

  it("falls back to no headers on bad JSON", () => {
    expect(gatewayProviderConfig({ ...env, PI_GATEWAY_HEADERS: "{nope" }).headers).toEqual({});
  });
});

describe("extension", () => {
  it("registers the provider only when its env is set", () => {
    const pi = { registerProvider: vi.fn() };
    vi.stubEnv("PI_GATEWAY_BASE_URL", "");
    gateway(pi);
    expect(pi.registerProvider).not.toHaveBeenCalled();
    vi.stubEnv("PI_GATEWAY_BASE_URL", env.PI_GATEWAY_BASE_URL);
    vi.stubEnv("PI_MODEL", env.PI_MODEL);
    gateway(pi);
    expect(pi.registerProvider).toHaveBeenCalledWith(TETHER_GATEWAY_PROVIDER, expect.objectContaining({ baseUrl: env.PI_GATEWAY_BASE_URL }));
  });
});
