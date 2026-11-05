// The type checker's diagnostics must survive the last hop — `req()` used to
// read `message` and drop the rest, which is exactly how `findings` was lost
// before it was carried (see `FoundryApiError.findings`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoundryApiError, foundryApi } from "./foundry-client";

afterEach(() => vi.unstubAllGlobals());

function refuse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })),
  );
}

describe("FoundryApiError.diagnostics", () => {
  it("carries the refused save's structured diagnostics, unsummarised", async () => {
    const diagnostics = [{ code: "FT0202", severity: "error", span: { stepId: "send", port: "to" }, message: "m", owner: "wiring" }];
    refuse({ error: "request_error", message: "FT0202 send.to: m", requestId: "r", diagnostics });
    const err = await foundryApi.saveFlowRevision("ws", "f", { steps: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(FoundryApiError);
    expect((err as FoundryApiError).message).toBe("FT0202 send.to: m");
    expect((err as FoundryApiError).diagnostics).toEqual(diagnostics);
  });

  it("CONTROL: a refusal without them leaves the field undefined", async () => {
    refuse({ error: "request_error", message: "nope" });
    const err = (await foundryApi.saveFlowRevision("ws", "f", { steps: [] }).catch((e) => e)) as FoundryApiError;
    expect(err.diagnostics).toBeUndefined();
  });
});
