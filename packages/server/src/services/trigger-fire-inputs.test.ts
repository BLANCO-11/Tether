import { describe, expect, it, vi, beforeEach } from "vitest";
import { flowRepo } from "../repositories/flow.repo.js";
import { triggerService } from "./trigger.service.js";

vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { get: vi.fn(), getRevision: vi.fn() },
}));

/**
 * Per-fire validation of a derivation.
 *
 * The load-bearing property: an unsupplied computed input is OMITTED from the
 * fire map, not substituted. Substituting the plan-default fallback would pin
 * the raw Pebble expression as the run's literal input value.
 */
describe("validateFireInputs — a derivation resolves itself", () => {
  const trigger = { workspaceId: "ws", flowId: "f" };
  const modelJson = {
    inputs: [
      { id: "period", type: "STRING", required: true, computed: "priorMonth" },
      { id: "sender", type: "STRING", required: true },
      { id: "note", type: "STRING", required: false, defaults: "n/a" },
    ],
  };

  beforeEach(() => {
    vi.mocked(flowRepo.get).mockResolvedValue({ id: "f", armedRevision: 3 } as never);
    vi.mocked(flowRepo.getRevision).mockResolvedValue({ modelJson } as never);
  });

  it("omits an unsupplied computed input instead of sending the expression", async () => {
    const r = await triggerService.validateFireInputs(trigger, { sender: "ops@example.com" });
    expect(r.issues).toEqual([]);
    // `period` is neither refused nor sent: the engine renders it at creation.
    expect(r.inputs).toEqual({ sender: "ops@example.com", note: "n/a" });
  });

  it("a computed input is not a missing required input", async () => {
    const r = await triggerService.validateFireInputs(trigger, {});
    expect(r.issues).toEqual([
      { input: "sender", message: 'input "sender" is required and no value was supplied' },
    ]);
    expect(r.inputs).not.toHaveProperty("period");
  });

  it("a supplied value for a computed input is type-checked and sent", async () => {
    const r = await triggerService.validateFireInputs(trigger, {
      period: "2026-03",
      sender: "ops@example.com",
    });
    expect(r.issues).toEqual([]);
    // The hand value wins for this fire — the derivation stands for the rest.
    expect(r.inputs.period).toBe("2026-03");
  });
});
