import { describe, expect, it } from "vitest";
import { policyConfig } from "./config.js";
import { buildProposal } from "./transform.js";
import type { Evidence } from "./evidence.js";

describe("buildProposal", () => {
  it("substitutes every matched feature with its generic counterpart", () => {
    const evidence: Evidence & { kind: "capabilitySignature" } = {
      kind: "capabilitySignature",
      product: "Facebook",
      matched: ["friend graph", "news feed", "marketplace", "pages"],
      missing: ["poke"],
    };
    const result = buildProposal(evidence, policyConfig);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.task).toContain("user connections");
      expect(result.task).toContain("activity feed");
      expect(result.task).toContain("listings");
      expect(result.task).toContain("organization profiles");
      expect(result.task).not.toMatch(/friend graph|news feed|marketplace\b.*Facebook|pages\b.*Facebook/i);
      expect(result.task.toLowerCase()).not.toContain("facebook");
      expect(result.proposalId.length).toBeGreaterThan(0);
    }
  });

  it("returns null when a matched feature has no substitute mapping (FR-009 fallback)", () => {
    const evidence: Evidence & { kind: "capabilitySignature" } = {
      kind: "capabilitySignature",
      product: "Stripe",
      matched: ["payment intents api", "connect marketplace payouts"],
      missing: [],
    };
    const result = buildProposal(evidence, policyConfig);
    expect(result).toBeNull();
  });

  it("issues a fresh, unpredictable proposalId on every call, even for identical evidence (not a security boundary — see request-policy.service.ts's mandatory re-evaluation)", () => {
    const evidence: Evidence & { kind: "capabilitySignature" } = {
      kind: "capabilitySignature",
      product: "Slack",
      matched: ["channels", "threads"],
      missing: ["workspace"],
    };
    const a = buildProposal(evidence, policyConfig);
    const b = buildProposal(evidence, policyConfig);
    expect(a?.proposalId).not.toBe(b?.proposalId);
    // Same evidence still produces the same *task* text — only the tracking
    // id, not the decision content, is random.
    expect(a?.task).toBe(b?.task);
  });
});
