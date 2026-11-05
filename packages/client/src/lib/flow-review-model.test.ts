/**
 * `getFlowReview`'s model must come from the DRAFT MODEL the server serves, not
 * from the version list.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 *
 * Reported twice, the second time as *"cant see any properties in inspector for
 * any component"*. The chain:
 *
 *   1. A chat turn writes its revision with `hidden_at` already set — that is
 *      what stops every sentence typed becoming a version in the list.
 *   2. `flowService.get`'s `revisions` is `listRevisions`, the ONE place
 *      `hidden_at` is honoured. So it comes back `[]` while
 *      `flow.draftRevision` is a real number. Measured on the live deployment:
 *      **every revision of every flow was hidden**, and `GET …/flows/:id`
 *      answered `revisions: []` with `draftRevision: 1`.
 *   3. `getFlowReview` derived the model as
 *      `revisions.find(r => r.revision === revision)?.modelJson ?? null` —
 *      undefined, so null.
 *   4. A null model makes `authoredFromModel` unreachable, so the builder's
 *      `working` is null and the step inspector renders *"this draft could not
 *      be read as an editable model"* under EVERY node of EVERY chat-built
 *      flow.
 *
 * The canvas kept working throughout, which is why this looked like an
 * inspector bug: the nodes come from `…/revisions/:n/steps`, which is not
 * filtered. One picture of the flow was readable and the other was not.
 *
 * ⚠ The fallback to `revisions` is NOT dead code and is asserted below:
 * `draftModel` is the draft's model, and this function is also called for an
 * older or an armed revision, where the list is the right source.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  getFlow: vi.fn(),
  getFlowRevisionSteps: vi.fn(),
}));
vi.mock("@/lib/foundry-client", () => ({
  foundryApi: api,
  resolveWorkspaceId: () => Promise.resolve("ws-1"),
  FoundryApiError: class extends Error {},
  NO_WORKSPACE_MESSAGE: "none",
}));

import { getFlowReview } from "@/lib/api";

const DRAFT_MODEL = {
  id: "uat-orders",
  steps: [{ id: "past_due_orders", kind: "query", ref: "orders_demo.past_due_orders" }],
  inputs: [{ id: "as_of", type: "DATE", required: true }],
};
const OLD_MODEL = { id: "uat-orders", steps: [{ id: "older", kind: "transform", expr: "{{ 1 }}" }] };

beforeEach(() => {
  api.getFlow.mockReset();
  api.getFlowRevisionSteps.mockReset();
  api.getFlowRevisionSteps.mockResolvedValue([
    { stepId: "past_due_orders", kind: "query", ordinal: 0, configJson: { ref: "orders_demo.past_due_orders" }, contractJson: null },
  ]);
});

describe("getFlowReview reads the draft model the server serves", () => {
  it("returns the draft model when the version list is EMPTY — the live deployment's state", async () => {
    api.getFlow.mockResolvedValue({
      flow: { draftRevision: 1 },
      revisions: [],
      draftModel: DRAFT_MODEL,
    });
    const out = await getFlowReview("flow-1", 1);
    expect(out.model).toEqual(DRAFT_MODEL);
  });

  /**
   * The control. Without it the assertion above passes against a function that
   * ignores its `revision` argument entirely and always answers `draftModel`,
   * which would silently show the DRAFT while a reviewer reads an older
   * version — the same class of bug pointing the other way.
   */
  it("falls back to the version list for a revision that is NOT the draft", async () => {
    api.getFlow.mockResolvedValue({
      flow: { draftRevision: 3 },
      revisions: [{ revision: 1, modelJson: OLD_MODEL }],
      draftModel: DRAFT_MODEL,
    });
    const out = await getFlowReview("flow-1", 1);
    expect(out.model).toEqual(OLD_MODEL);
  });

  /** A deployment that has not been rebuilt yet still serves no `draftModel`. */
  it("still uses the version list when the server serves no draftModel", async () => {
    api.getFlow.mockResolvedValue({
      flow: { draftRevision: 1 },
      revisions: [{ revision: 1, modelJson: OLD_MODEL }],
      draftModel: null,
    });
    const out = await getFlowReview("flow-1", 1);
    expect(out.model).toEqual(OLD_MODEL);
  });

  /** Nothing anywhere is still null — never a fabricated empty model. */
  it("returns null when neither source has the revision", async () => {
    api.getFlow.mockResolvedValue({ flow: { draftRevision: 1 }, revisions: [], draftModel: null });
    expect((await getFlowReview("flow-1", 1)).model).toBeNull();
  });
});
