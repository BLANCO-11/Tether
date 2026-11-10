import { describe, expect, it, vi } from "vitest";

describe("testCompletion without a model", () => {
  it("answers 400 and never calls the gateway", async () => {
    const { testCompletion } = await import("./runtime-model.service.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      testCompletion({ providerId: "custom", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", defaultModel: "" } as never),
    ).rejects.toMatchObject({ status: 400, message: /Pick a model/ });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
