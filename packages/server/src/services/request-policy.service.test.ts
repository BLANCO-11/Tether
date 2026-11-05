import { describe, expect, it, vi } from "vitest";
import { requestPolicyService } from "./request-policy.service.js";

describe("requestPolicyService.evaluate", () => {
  it("rejects an explicit clone request", () => {
    const decision = requestPolicyService.evaluate("Build Facebook", { confirmationAvailable: true });
    expect(decision.decision).toBe("reject");
  });

  it("allows a category-level request", () => {
    const decision = requestPolicyService.evaluate("Build a CRM", { confirmationAvailable: true });
    expect(decision.decision).toBe("allow");
  });

  it("collapses transform to reject when confirmation is unavailable (FR-012)", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const available = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    const unavailable = requestPolicyService.evaluate(task, { confirmationAvailable: false });
    expect(available.decision).toBe("transform");
    expect(unavailable.decision).toBe("reject");
  });

  it("logs and ignores the reserved bypass parameter without changing the decision (FR-021)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withoutBypass = requestPolicyService.evaluate("Build Facebook", { confirmationAvailable: true });
    const withBypass = requestPolicyService.evaluate("Build Facebook", {
      confirmationAvailable: true,
      bypass: { reason: "testing" },
    });
    expect(withBypass.decision).toBe(withoutBypass.decision);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("requestPolicyService.verifyAcceptedTransform", () => {
  it("returns the (possibly edited) task for a proposalId this process actually issued", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    expect(decision.decision).toBe("transform");
    if (decision.decision !== "transform") throw new Error("unreachable");

    const edited = decision.proposal.task + " Add a dark mode too.";
    const verified = requestPolicyService.verifyAcceptedTransform({
      proposalId: decision.proposal.proposalId,
      task: edited,
    });
    expect(verified).toBe(edited);
  });

  it("returns null for an unrecognised proposalId — never trusted blindly", () => {
    const verified = requestPolicyService.verifyAcceptedTransform({
      proposalId: "not-a-real-proposal-id",
      task: "anything",
    });
    expect(verified).toBeNull();
  });

  it(
    "CRITICAL: an accepted/edited proposal is NOT trusted verbatim — the caller must re-evaluate " +
      "the verified text before proceeding, or transform confirmation becomes a policy bypass wearing a UI",
    () => {
      const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
      const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
      if (decision.decision !== "transform") throw new Error("unreachable");

      // The user edits the proposal back into the exact request the proposal
      // was meant to replace — this must NOT be allowed through unchecked.
      const editedBackToViolation = requestPolicyService.verifyAcceptedTransform({
        proposalId: decision.proposal.proposalId,
        task: "Clone Facebook exactly",
      });
      expect(editedBackToViolation).toBe("Clone Facebook exactly"); // verified = "this proposalId was real"

      // This is the mandatory second step — script-generation.service.ts's
      // start() does this immediately after verifyAcceptedTransform, and must
      // never skip it. Simulated here directly since it's the composition
      // that matters, not which function happens to hold the two calls.
      const recheck = requestPolicyService.evaluate(editedBackToViolation!, {
        confirmationAvailable: true,
      });
      expect(recheck.decision).toBe("reject");
    },
  );

  it("an unedited, accepted proposal re-evaluates cleanly to allow (the substitute text is designed not to re-trigger)", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    if (decision.decision !== "transform") throw new Error("unreachable");

    const verified = requestPolicyService.verifyAcceptedTransform({
      proposalId: decision.proposal.proposalId,
      task: decision.proposal.task,
    });
    const recheck = requestPolicyService.evaluate(verified!, { confirmationAvailable: true });
    expect(recheck.decision).toBe("allow");
  });

  it("a proposalId can only be consumed once", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    if (decision.decision !== "transform") throw new Error("unreachable");

    const first = requestPolicyService.verifyAcceptedTransform({
      proposalId: decision.proposal.proposalId,
      task: decision.proposal.task,
    });
    const second = requestPolicyService.verifyAcceptedTransform({
      proposalId: decision.proposal.proposalId,
      task: decision.proposal.task,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("concurrent acceptance of the same proposalId — exactly one succeeds", () => {
    // Node's single-threaded event loop means there is no interleaving point
    // between the Map.get/delete pair in verifyAcceptedTransform (no `await`
    // in between), so two synchronous calls racing for the same proposalId
    // cannot both observe the entry present. Verified here rather than
    // assumed.
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    if (decision.decision !== "transform") throw new Error("unreachable");

    const accepted = { proposalId: decision.proposal.proposalId, task: decision.proposal.task };
    const results = [
      requestPolicyService.verifyAcceptedTransform(accepted),
      requestPolicyService.verifyAcceptedTransform(accepted),
    ];
    const succeeded = results.filter((r) => r !== null);
    expect(succeeded).toHaveLength(1);
  });

  it("an accepted proposal older than the TTL is rejected, not trusted (operational hygiene, not a security boundary)", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const decision = requestPolicyService.evaluate(task, { confirmationAvailable: true });
    if (decision.decision !== "transform") throw new Error("unreachable");

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31 * 60 * 1000; // 31 minutes later — past the 30-minute TTL
      const verified = requestPolicyService.verifyAcceptedTransform({
        proposalId: decision.proposal.proposalId,
        task: decision.proposal.task,
      });
      expect(verified).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

/**
 * ── The decision is reached in ONE place ────────────────────────────────────
 *
 * `combinator.ts`'s docblock used to claim a second caller —
 * `request-policy-client.ts` in the client — and an "equivalence test asserts
 * both wrappers use it identically". Neither exists: there is no policy code in
 * `packages/client` at all. That is the correct shape (a decision the browser can
 * compute is one it can skip), so what is worth pinning is not equivalence
 * between two evaluators but the ABSENCE of a second one.
 *
 * ⚠ Read off disk deliberately, the same idiom as the one-reader-per-secret
 *  assertion: a second implementation would work perfectly and report
 * nothing, and no behavioural test can see one that has not been written yet.
 */
describe("there is exactly one policy evaluator", () => {
  const repoRoot = new URL("../../../../", import.meta.url).pathname;

  it("the client holds no policy rules and no evaluator of its own", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      `grep -rl "evaluatePolicy\\|policyRules\\|request-policy" ${repoRoot}packages/client/src || true`,
      { encoding: "utf8" },
    ).trim();

    expect(hits).toBe("");
  });

  it("`evaluatePolicy` has exactly one non-test caller in the server", async () => {
    const { execSync } = await import("node:child_process");
    const callers = execSync(
      `grep -rl "evaluatePolicy" ${repoRoot}packages/server/src || true`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter((f) => f && !f.endsWith(".test.ts"));

    expect(callers).toHaveLength(1);
    expect(callers[0]).toContain("request-policy.service.ts");
  });

  /**
   * ⚠ THE CONTROL. Both greps above pass trivially against a tree where the
   * pattern was renamed or the paths are wrong, and "no matches" would then read
   * as "no second implementation". This requires the search to be able to find
   * something.
   */
  it("CONTROL — the grep can find the shared module it is searching for", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      `grep -rl "evaluatePolicy" ${repoRoot}packages/shared/src || true`,
      { encoding: "utf8" },
    ).trim();

    expect(hits).not.toBe("");
  });
});
