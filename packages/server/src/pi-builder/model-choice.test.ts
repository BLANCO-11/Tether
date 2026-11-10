import { describe, expect, it } from "vitest";
import { bareModel, effectiveModel, modelChoices, modelNote } from "./model-choice.js";

const gen = { model: "gpt-a", allowedModels: ["gpt-a", "gpt-b"] };

describe("effectiveModel", () => {
  it("keeps a chosen model that is allowed", () => expect(effectiveModel("gpt-b", gen, "fb")).toBe("gpt-b"));
  it("falls back to the default when the choice is no longer allowed", () => expect(effectiveModel("gpt-z", gen, "fb")).toBe("gpt-a"));
  it("keeps the choice when nothing is listed", () => expect(effectiveModel("gpt-z", { model: "gpt-a", allowedModels: [] }, "fb")).toBe("gpt-z"));
  it("uses the default when nothing is chosen", () => expect(effectiveModel(null, gen, "fb")).toBe("gpt-a"));
  it("with no generation gives the choice or the fallback", () => {
    expect(effectiveModel("gpt-c", null, "fb")).toBe("gpt-c");
    expect(effectiveModel(null, null, "fb")).toBe("fb");
  });
  it("uses the fallback when the default is empty", () => expect(effectiveModel(null, { model: "", allowedModels: [] }, "fb")).toBe("fb"));
  it("strips prefixes from the choice, the list and the default", () => {
    expect(effectiveModel("litellm/gpt-b", { model: "x/gpt-a", allowedModels: ["litellm/gpt-b"] }, "fb")).toBe("gpt-b");
    expect(effectiveModel(null, { model: "litellm/gpt-a", allowedModels: [] }, "fb")).toBe("gpt-a");
    expect(bareModel(" litellm/gpt-x ")).toBe("gpt-x");
  });
});

describe("modelNote", () => {
  it("names the model without its provider", () => expect(modelNote("litellm/gpt-6-luna")).toBe("Now using gpt-6-luna."));
});

describe("modelChoices", () => {
  it("dedupes and strips", () => expect(modelChoices({ model: "a", allowedModels: ["p/a", "a", "b", ""] }, "fb")).toEqual(["a", "b"]));
  it("gives the default when nothing is listed", () => expect(modelChoices({ model: "p/a", allowedModels: [] }, "fb")).toEqual(["a"]));
  it("gives the fallback with no generation", () => expect(modelChoices(null, "p/fb")).toEqual(["fb"]));
});

describe("no model configured", () => {
  it("offers no empty choice and resolves to an empty model", () => {
    expect(modelChoices(null, "")).toEqual([]);
    expect(effectiveModel(null, null, "")).toBe("");
  });
});
