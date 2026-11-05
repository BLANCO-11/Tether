import { describe, expect, it } from "vitest";
import {
  forgeReachability,
  lastModelConnection,
  mergeModelLists,
  rememberModelConnection,
} from "./model-connection.js";

describe("last resolved model connection", () => {
  it("is null until something is remembered, then returns what was remembered", () => {
    expect(lastModelConnection()).toBeNull();
    rememberModelConnection({ baseUrl: "https://a/v1", apiKey: "k" });
    expect(lastModelConnection()).toEqual({ baseUrl: "https://a/v1", apiKey: "k" });
  });
});

describe("mergeModelLists", () => {
  it("has nothing to merge when there is no generation list", () => {
    expect(mergeModelLists(null, null)).toBeNull();
    expect(mergeModelLists({ defaultModel: "m1", allowedModels: ["m1"] }, null)).toBeNull();
  });

  it("keeps the runtime default and merges both lists in first-occurrence order", () => {
    expect(
      mergeModelLists(
        { defaultModel: "m1", allowedModels: ["m1", "m2"] },
        { defaultModel: "g1", allowedModels: ["m2", "g1", "g2"] },
      ),
    ).toEqual({ defaultModel: "m1", allowedModels: ["m1", "m2", "g1", "g2"] });
  });

  it("takes the generation default when the runtime default is empty", () => {
    expect(
      mergeModelLists({ defaultModel: "", allowedModels: ["m1"] }, { defaultModel: "g1", allowedModels: [] }),
    ).toEqual({ defaultModel: "g1", allowedModels: ["m1", "g1"] });
  });

  it("treats a null runtime as empty", () => {
    expect(mergeModelLists(null, { defaultModel: "g1", allowedModels: ["g2"] })).toEqual({
      defaultModel: "g1",
      allowedModels: ["g2", "g1"],
    });
  });

  it("ignores non-array lists, non-string and blank entries, and trims the rest", () => {
    expect(
      mergeModelLists(
        { defaultModel: " ", allowedModels: "oops" },
        { defaultModel: " g1 ", allowedModels: [" g1 ", 3, ""] },
      ),
    ).toEqual({ defaultModel: "g1", allowedModels: ["g1"] });
  });

  it("is idempotent when applied again to its own result", () => {
    const generation = { defaultModel: "g1", allowedModels: ["m2", "g1", "g2"] };
    const once = mergeModelLists({ defaultModel: "m1", allowedModels: ["m1", "m2"] }, generation);
    expect(mergeModelLists(once, generation)).toEqual(once);
  });
});

describe("forgeReachability", () => {
  it("is reachable when the gateway is the environment's host", () => {
    expect(forgeReachability("https://gw.example/v1", "https://gw.example/v1", "")).toEqual({
      forgeReachable: true,
      forgeWarning: null,
    });
  });

  it("warns when a saved gateway is outside the host of LLM_BASE_URL", () => {
    const result = forgeReachability("https://other.example/v1", "https://gw.example/v1", "");
    expect(result.forgeReachable).toBe(false);
    expect(result.forgeWarning).toContain("other.example");
    expect(result.forgeWarning).toContain("gw.example");
  });

  it("is reachable when FORGE_EGRESS_ALLOW lists the gateway, ignoring case, spaces and ports", () => {
    expect(
      forgeReachability("https://other.example/v1", "https://gw.example/v1", "gw.example:443, OTHER.example:443"),
    ).toEqual({ forgeReachable: true, forgeWarning: null });
  });

  it("has nothing to warn about when the gateway URL does not parse", () => {
    expect(forgeReachability("not a url", "https://gw.example/v1", "")).toEqual({
      forgeReachable: true,
      forgeWarning: null,
    });
  });
});
