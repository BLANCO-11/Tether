/**
 * `GET /workspaces/:ws/flows/:flowId` must derive the DRAFT MODEL from the
 * unfiltered revision read, never from the version list it also serves.
 *
 * ── Why this is a control and not a tidy-up ─────────────────────────────────
 *
 * `flowRepo.listRevisions` is, by its own docblock, "the ONE place `hidden_at`
 * is honoured" — it is the version list a person reads. A chat turn writes its
 * revision already hidden, so on a flow built in the chat builder and not yet
 * saved that list is EMPTY while `flow.draftRevision` is a real number.
 * Measured on the live deployment: every revision of every flow was hidden and
 * this route answered `revisions: []` with `draftRevision: 1`.
 *
 * Two values were computed off `found.revisions.find(...)` and both failed
 * silently, in the direction that reads as a product defect:
 *
 *   - `usedRefs` came back empty, so `designedAgainst` reported every design
 *     choice as UNUSED on a flow that uses them.
 *   - `draftModel` — which the client's `getFlowReview` needs to build an
 *     editable model — was null, so the step inspector answered *"this draft
 *     could not be read as an editable model"* under every node.
 *
 * A source scan rather than an HTTP test: the property is WHICH READ the route
 * uses, and both reads return a well-formed response, so a runtime test over a
 * visible revision passes either way. That is the shape of test that let this
 * ship (I-38). `flow.service.test.ts` covers the filtering itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./flows.ts", import.meta.url)), "utf8");

describe("routes/flows.ts — the draft model comes from the unfiltered read", () => {
  /** The control: this file was found and is the real one, not an empty read. */
  it("is reading the route file", () => {
    expect(source.length).toBeGreaterThan(5000);
    expect(source).toContain('flowsRouter.get(\n  "/:flowId",');
  });

  it("reads the draft revision by number, not out of the version list", () => {
    expect(source).toContain(
      "flowRepo.getRevision(found.flow.id, found.flow.draftRevision)",
    );
  });

  /**
   * ⚠ The half that actually regresses. `found.revisions.find(...)` reads
   * perfectly naturally and is what was there; nothing about it looks like a
   * filtered read at the call site, which is exactly why it survived.
   */
  it("never derives the draft model from found.revisions", () => {
    // ⚠ Not `[^)]*` — the reverted line is
    // `found.revisions.find((r) => r.revision === found.flow.draftRevision)`,
    // whose first `)` closes the arrow's parameter list, so a character class
    // excluding `)` stops before ever reaching `draftRevision` and the
    // assertion passes over the defect. Written that way first, and the
    // perturbation is what caught it.
    expect(source).not.toMatch(/found\.revisions\.find\([\s\S]{0,120}?draftRevision/);
  });

  it("serves the draft model to the client, explicitly nulled when absent", () => {
    expect(source).toContain("draftModel: draftModel ?? null,");
  });
  /**
   * The test drawer renders from THESE formats, not from a second derivation
   * client-side — one call (`flowInputFormat`, the same one the trigger
   * surfaces use) so the two cannot disagree.
   */
  it("serves the server-derived input formats beside the draft model", () => {
    expect(source).toContain("inputFormats,");
    expect(source).toContain("flowInputFormat(input, draftSteps,");
  });
});
