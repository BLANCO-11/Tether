/**
 * The one model connection (2026-11-04), resolved against a mocked database: env fallback, a saved row, an empty
 * base URL, the TTL cache, a failed read that throws, and the generation adapter over it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { limit } = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock("../db/index.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } }));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => `dec:${s}`, encrypt: (s: string) => s }));

import { config } from "../config/index.js";
import { invalidateModelConnection, resolveModelConnection, viewOf, type RuntimeProvider } from "./runtime-model.service.js";
import { resolveGenerationProvider } from "./generation-provider.service.js";
import { lastModelConnection } from "./model-connection.js";

const row = {
  id: 1,
  baseUrl: "https://gw2.example/v1/",
  apiKeyEnc: "x",
  defaultModel: "m1",
  allowedModels: ["m1", "m2"],
  updatedAt: new Date("2026-11-04T00:00:00Z"),
  updatedBy: "a@b.example",
};

beforeEach(() => {
  invalidateModelConnection();
  limit.mockReset();
});

describe("resolveModelConnection", () => {
  it("(a) uses the environment when there is no row", async () => {
    limit.mockResolvedValue([]);
    const c = await resolveModelConnection();
    expect(c.source).toBe("env");
    expect(c.baseUrl).toBe(config.inference.baseUrl.replace(/\/+$/, ""));
    expect(c.apiKey).toBe(config.inference.apiKey);
    expect(c.allowedModels).toEqual([...new Set(config.runtimeModel.fallbackModels)]);
  });

  it("(b) uses a saved row and remembers it for Forge", async () => {
    limit.mockResolvedValue([row]);
    const c = await resolveModelConnection();
    expect(c.source).toBe("configured");
    expect(c.baseUrl).toBe("https://gw2.example/v1");
    expect(c.apiKey).toBe("dec:x");
    expect(c.updatedBy).toBe("a@b.example");
    expect(lastModelConnection()).toEqual({ baseUrl: "https://gw2.example/v1", apiKey: "dec:x" });
  });

  it("(c) falls back to the environment for an empty base URL and a null key", async () => {
    limit.mockResolvedValue([{ ...row, baseUrl: "", apiKeyEnc: null }]);
    const c = await resolveModelConnection();
    expect(c.baseUrl).toBe(config.inference.baseUrl.replace(/\/+$/, ""));
    expect(c.apiKey).toBe(config.inference.apiKey);
  });

  it("(d) caches, until invalidated", async () => {
    limit.mockResolvedValue([row]);
    await resolveModelConnection();
    await resolveModelConnection();
    expect(limit).toHaveBeenCalledTimes(1);
    invalidateModelConnection();
    await resolveModelConnection();
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("(e) throws when the row cannot be read", async () => {
    limit.mockRejectedValue(new Error("db down"));
    await expect(resolveModelConnection()).rejects.toThrow("db down");
  });
});

describe("resolveGenerationProvider", () => {
  it("(f) is the connection, shaped for the builder", async () => {
    limit.mockResolvedValue([row]);
    const p = await resolveGenerationProvider();
    expect(p.model).toBe("m1");
    expect(p.allowedModels).toEqual(["m1", "m2"]);
    expect(p.source).toBe("configured");
    expect(p.baseUrl).toBe("https://gw2.example/v1");
    expect(p.apiKey).toBe("dec:x");
    expect(p.updatedAt).toBeInstanceOf(Date);
  });
});

describe("viewOf", () => {
  const provider = (baseUrl: string): RuntimeProvider => ({
    baseUrl,
    apiKey: "k",
    defaultModel: "m1",
    allowedModels: ["m1"],
    source: "configured",
    updatedAt: null,
    updatedBy: null,
  });

  it("(g) reports whether Forge can reach the gateway, and never carries the key", () => {
    if (config.forge.egressAllow) return;
    const same = viewOf(provider(config.inference.baseUrl));
    expect(same.forgeReachable).toBe(true);
    expect("apiKey" in same).toBe(false);
    const other = viewOf(provider("https://elsewhere.example/v1"));
    expect(other.forgeReachable).toBe(false);
    expect(typeof other.forgeWarning).toBe("string");
  });
});
