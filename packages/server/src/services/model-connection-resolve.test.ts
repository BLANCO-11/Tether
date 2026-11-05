/**
 * Personal BYOK model connection: env harness fallback, per-subject row, TTL cache, generation adapter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { limit } = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock("../db/index.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } }));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => `dec:${s}`, encrypt: (s: string) => s }));

import { config } from "../config/index.js";
import { invalidateModelConnection, resolveModelConnection, viewOf, type RuntimeProvider } from "./runtime-model.service.js";
import { resolveGenerationProvider } from "./generation-provider.service.js";
import { lastModelConnection } from "./model-connection.js";

const SUBJECT = "user-a";
const row = {
  subject: SUBJECT,
  providerId: "openai",
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
  it("(a) harness without subject uses the environment (never a shared interactive key)", async () => {
    limit.mockResolvedValue([]);
    const c = await resolveModelConnection();
    expect(c.source).toBe("env");
    expect(c.baseUrl).toBe(config.inference.baseUrl.replace(/\/+$/, ""));
    expect(c.apiKey).toBe(config.inference.apiKey);
    expect(limit).not.toHaveBeenCalled();
  });

  it("(b) uses a saved per-subject row and remembers it for Forge", async () => {
    limit.mockResolvedValue([row]);
    const c = await resolveModelConnection(SUBJECT);
    expect(c.source).toBe("configured");
    expect(c.baseUrl).toBe("https://gw2.example/v1");
    expect(c.apiKey).toBe("dec:x");
    expect(c.providerId).toBe("openai");
    expect(c.updatedBy).toBe("a@b.example");
    expect(lastModelConnection()).toEqual({ baseUrl: "https://gw2.example/v1", apiKey: "dec:x" });
  });

  it("(c) interactive subject with no row is empty (does not fall back to env)", async () => {
    limit.mockResolvedValue([]);
    const c = await resolveModelConnection(SUBJECT);
    expect(c.baseUrl).toBe("");
    expect(c.apiKey).toBe("");
    expect(viewOf(c).configured).toBe(false);
  });

  it("(d) caches per subject, until invalidated", async () => {
    limit.mockResolvedValue([row]);
    await resolveModelConnection(SUBJECT);
    await resolveModelConnection(SUBJECT);
    expect(limit).toHaveBeenCalledTimes(1);
    invalidateModelConnection(SUBJECT);
    await resolveModelConnection(SUBJECT);
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("(e) throws when the row cannot be read", async () => {
    limit.mockRejectedValue(new Error("db down"));
    await expect(resolveModelConnection(SUBJECT)).rejects.toThrow("db down");
  });
});

describe("resolveGenerationProvider", () => {
  it("(f) is the connection, shaped for the builder, for that subject", async () => {
    limit.mockResolvedValue([row]);
    const p = await resolveGenerationProvider(SUBJECT);
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
