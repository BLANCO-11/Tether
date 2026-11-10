import { describe, expect, it } from "vitest";
import { gatewayHeaders, gatewayKind } from "./llm-gateway-headers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("llm gateway headers", () => {
  it("opencode_go sends the session id and Tether user agent", () => {
    expect(gatewayHeaders({ providerId: "opencode_go" }, "chat-1")).toEqual({
      "x-opencode-session": "chat-1",
      "User-Agent": "Tether/1.0",
    });
  });

  it("opencode_go without a session id gets a fresh uuid per call", () => {
    const a = gatewayHeaders({ providerId: "opencode_go" })["x-opencode-session"];
    const b = gatewayHeaders({ providerId: "opencode_go" })["x-opencode-session"];
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it("opencode_zen sends only the user agent", () => {
    expect(gatewayHeaders({ providerId: "opencode_zen" })).toEqual({ "User-Agent": "Tether/1.0" });
  });

  it("custom gateway gets no extra headers", () => {
    expect(gatewayHeaders({ providerId: "custom", baseUrl: "https://api.openai.com/v1" })).toEqual({});
  });

  it("legacy providerId opencode is treated as zen", () => {
    expect(gatewayKind({ providerId: "opencode" })).toBe("opencode_zen");
  });

  it("detects the gateway from an opencode.ai URL when the provider is custom", () => {
    expect(gatewayKind({ providerId: "custom", baseUrl: "https://opencode.ai/inference/go/openai/v1" })).toBe("opencode_go");
    expect(gatewayKind({ providerId: "custom", baseUrl: "https://opencode.ai/zen/v1" })).toBe("opencode_zen");
  });

  it("an empty or invalid baseUrl with no providerId is custom", () => {
    expect(gatewayKind({ baseUrl: "" })).toBe("custom");
    expect(gatewayKind({ baseUrl: "not a url" })).toBe("custom");
    expect(gatewayKind({})).toBe("custom");
  });
});
