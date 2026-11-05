// src/lib/flow-views.test.ts — the workflow list's view-tab predicates (S-28).
//
// ⚠ This is the FIRST of the `/flows` page tests the hand-off owes, and it is the
// pure one on purpose: `flow-views.ts` was extracted into `lib/` precisely so a
// predicate could be held without rendering a page. Every claim here is about a
// predicate's decision, not about the DOM.
//
// ⚠ THE ONE CLAIM THIS FILE EXISTS FOR: **"Scheduled" means armed AND carrying a
// non-empty cron.** The pack's `S-28 § Copy` lists `Scheduled` as a view, and an
// armed flow with no schedule fires only when a trigger or a person starts it —
// counting it as "Scheduled" would be false. Reverting the predicate to `armed`
// alone turns the scheduled test red.
import { describe, it, expect } from "vitest";
import { hasOwnerData, isMyDraft, isRunningUnattended, offReason, VIEWS, viewCounts, type ViewKey } from "./flow-views";
import type { FlowSummary } from "./types";

/**
 * A minimal flow, defaulting to the least-surprising values. Each test overrides
 * only the field it is about, so a change to one predicate cannot be masked by a
 * helper that happens to satisfy another.
 */
function flow(over: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "f1",
    name: "Invoice chase",
    description: null,
    kestraFlowId: "k1",
    draftRevision: 1,
    armedRevision: null,
    status: "draft",
    schedule: "",
    draftAhead: false,
    ...over,
  };
}

const match = (key: ViewKey) => VIEWS.find((v) => v.key === key)!.match;

describe("flow-views — VIEWS", () => {
  it("has ten tabs, each named in Foundry's status vocabulary", () => {
    expect(VIEWS.map((v) => v.label)).toEqual([
      "All",
      "Mine",
      "Live",
      "Scheduled",
      "Awaiting approval",
      "Drafts",
      "My drafts",
      "Suspended",
      "Running",
      "Failed",
    ]);
  });

  it("All matches everything, whatever the flow's state", () => {
    expect(match("all")(flow({ status: "draft" }))).toBe(true);
    expect(match("all")(flow({ status: "suspended" }))).toBe(true);
  });

  /**
   * ⚠ **THIS TEST USED TO PASS AGAINST A STATE THE SERVER CANNOT PRODUCE.** It
   * asserted `flow({ armedRevision: 3 })`, and the fixture's default status is
   * `draft` — but `writeRevision` writes `draft_pending` whenever
   * `armedRevision != null`, so armed-revision-with-status-draft exists nowhere.
   * The predicate it was pinning was `armedRevision != null`, which is exactly
   * the bug: `revoke` leaves `armed_revision` set.
   */
  it("Live means it can fire unattended — NOT that armed_revision is set", () => {
    expect(match("live")(flow({ status: "armed", armedRevision: 3, schedule: "0 7 * * 1" }))).toBe(true);
    // Approved with no schedule is still live: a trigger or a person can start
    // the approved revision. It is `Scheduled` that additionally needs the cron.
    expect(match("live")(flow({ status: "approved", armedRevision: 3 }))).toBe(true);
    // ⚠ THE CLAIM THIS BLOCK EXISTS FOR — a REVOKED flow. `armed_revision` is
    // still 3 because revoke keeps it deliberately; the trigger is gone from the
    // engine and every approval row is closed. Reverting the predicate to
    // `armedRevision != null` turns this line red.
    expect(match("live")(flow({ status: "suspended", armedRevision: 3 }))).toBe(false);
    // A never-approved draft was never live.
    expect(match("live")(flow({ status: "draft", armedRevision: null }))).toBe(false);
  });

  it("Live INCLUDES draft_pending — the approved revision is still firing", () => {
    /**
     * ⚠ The dangerous direction. An armed flow edited since approval is
     * `draft_pending`: it keeps firing the APPROVED revision while an unapproved
     * one waits. A predicate of `status === "armed"` renders it as off, which
     * tells somebody an automation is stopped while it fires at 09:00.
     */
    expect(match("live")(flow({ status: "draft_pending", armedRevision: 2, draftAhead: true }))).toBe(true);
  });

  it("Scheduled means running unattended AND a non-empty cron — not merely live", () => {
    expect(match("scheduled")(flow({ status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }))).toBe(true);
    // The claim this file exists for: a live flow with NO schedule fires only
    // when a trigger or a person starts it, so it is not "Scheduled".
    expect(match("scheduled")(flow({ status: "armed", armedRevision: 1, schedule: "" }))).toBe(false);
    expect(match("scheduled")(flow({ status: "armed", armedRevision: 1, schedule: "   " }))).toBe(false);
    // And a cron on a revoked flow is not Scheduled: nothing fires it. The cron
    // survives on the model, which is why this needs asserting rather than
    // following from the line above.
    expect(match("scheduled")(flow({ status: "suspended", armedRevision: 1, schedule: "0 7 * * 1" }))).toBe(false);
  });

  it("Awaiting approval means its owner asked a reviewer, and nobody has approved it yet", () => {
    expect(match("awaiting")(flow({ status: "draft", reviewRequestedRevision: 2 }))).toBe(true);
    // An edit to a live workflow, asked for: still waiting.
    expect(match("awaiting")(flow({ status: "draft_pending", armedRevision: 1, reviewRequestedRevision: 2 }))).toBe(true);
    // Not asked (or answered: approving clears the request server-side): not waiting.
    expect(match("awaiting")(flow({ status: "draft" }))).toBe(false);
    expect(match("awaiting")(flow({ status: "armed", armedRevision: 1, reviewRequestedRevision: null }))).toBe(false);
  });

  it("Drafts means a draft, in either of Foundry's draft states", () => {
    expect(match("drafts")(flow({ status: "draft" }))).toBe(true);
    expect(match("drafts")(flow({ status: "draft_pending" }))).toBe(true);
    expect(match("drafts")(flow({ status: "armed" }))).toBe(false);
  });

  it("Suspended means suspended", () => {
    expect(match("suspended")(flow({ status: "suspended" }))).toBe(true);
    expect(match("suspended")(flow({ status: "draft" }))).toBe(false);
  });

  // P6 — Running / Failed join last execution, not flow status.
  it("Running means last run is live (status running or engineStatus live)", () => {
    expect(match("running")(flow({ lastExecution: { id: "e1", status: "running", engineStatus: null } }))).toBe(true);
    expect(match("running")(flow({ lastExecution: { id: "e2", status: "succeeded", engineStatus: "running" } }))).toBe(true);
    expect(match("running")(flow({ lastExecution: { id: "e3", status: "succeeded", engineStatus: "failed" } }))).toBe(false);
    expect(match("running")(flow({ lastExecution: { id: "e4", status: "succeeded", engineStatus: "success" } }))).toBe(false);
    expect(match("running")(flow())).toBe(false); // honest-empty → 0
    // Run shape via lastRun.outcome === "running" also counts
    expect(match("running")(flow({ lastRun: { outcome: "running" } }))).toBe(true);
  });

  it("Failed means last run status failed or outcome stopped", () => {
    expect(match("failed")(flow({ lastExecution: { id: "e1", status: "failed", engineStatus: null } }))).toBe(true);
    expect(match("failed")(flow({ lastExecution: { id: "e2", status: "succeeded", engineStatus: "failed" } }))).toBe(true);
    expect(match("failed")(flow({ lastRun: { outcome: "stopped" } }))).toBe(true);
    expect(match("failed")(flow({ lastExecution: { id: "e3", status: "succeeded", engineStatus: "success" } }))).toBe(false);
    expect(match("failed")(flow({ lastExecution: { id: "e4", status: "running", engineStatus: "running" } }))).toBe(false);
    expect(match("failed")(flow())).toBe(false);
  });
  // P5 B-06 — My drafts owner gate
  it("My drafts matches only drafts with an owner (disabled until owner exists)", () => {
    expect(match("mydrafts")(flow({ status: "draft", ownerSubject: "sub-1" }))).toBe(true);
    expect(match("mydrafts")(flow({ status: "draft_pending", ownerSubject: "sub-1" }))).toBe(true);
    expect(match("mydrafts")(flow({ status: "draft" }))).toBe(false);
    expect(match("mydrafts")(flow({ status: "approved", ownerSubject: "sub-1" }))).toBe(false);
  });
});

describe("flow-views — viewCounts", () => {
  /**
   * ⚠ **EVERY ROW HERE IS A STATE THE SERVER ACTUALLY WRITES**, and the previous
   * fixture had two that it does not: `armedRevision` set with `status: "draft"`,
   * and `status: "approved"` with `armedRevision: null`. `writeRevision` writes
   * `draft_pending` whenever a revision is armed, and `approve` always sets
   * `armedRevision` alongside the status — so both were unreachable, and a
   * predicate pinned against an unreachable state is pinned against nothing.
   */
  const flows: FlowSummary[] = [
    // Live + Scheduled.
    flow({ status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }),
    // Live, but no schedule: fires only when triggered or started by a person.
    flow({ id: "f2", status: "armed", armedRevision: 2, schedule: "" }),
    // ⚠ Live AND a draft: still firing revision 2 with an unapproved 3 waiting.
    // It is counted by BOTH `live` and `drafts`, correctly.
    flow({ id: "f3", status: "draft_pending", armedRevision: 2, draftAhead: true }),
    // ⚠ REVOKED. `armed_revision` survives on purpose; nothing fires.
    flow({ id: "f4", status: "suspended", armedRevision: 3 }),
    // A never-approved draft.
    flow({ id: "f5", status: "draft" }),
  ];

  it("counts each tab from the same rows, and a zero is a real number, not an absence", () => {
    const counts = viewCounts(flows);
    expect(counts.all).toBe(5);
    // ⚠ THREE, not four: the revoked flow drops out even though it still carries
    // an `armed_revision`. Reverting the predicate makes this 4.
    expect(counts.live).toBe(3);
    expect(counts.scheduled).toBe(1); // only the one with a cron
    expect(counts.drafts).toBe(2); // the draft and the draft_pending
    expect(counts.suspended).toBe(1);
    expect(counts.running).toBe(0); // rendered as `0`, never hidden
    expect(counts.failed).toBe(0);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⚠ RESOLVED 2026-10-30 (sharing-boundaries): the tab now means "its owner
   * asked for approval" (`reviewRequestedRevision`). The finding below is kept
   * as the record of why it was hidden; the test asserts the old predicate's
   * subject still never appears on its own.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * Was: A LIVE FINDING, PINNED RATHER THAN FIXED — `Awaiting approval` CANNOT
   * MATCH ANY REAL FLOW.
   *
   * Its predicate is `status === "approved" && armedRevision == null`, and
   * `flowApprovalService.approve` is the only writer of `status: "approved"` —
   * it sets `armedRevision: input.revision` in the same `update`. So the two
   * halves can never both hold, and the tab has counted `0` for every flow that
   * has ever existed. The old fixture hid this by constructing the impossible
   * pair on purpose.
   *
   * ⚠ **Deliberately NOT fixed here.** Deciding what "awaiting approval" should
   * mean — `draft_pending`? a draft that has satisfied gate 1? — is a product
   * decision, and quietly redefining a tab while fixing an unrelated predicate
   * is how a view comes to mean something nobody chose. This test states the
   * defect so it cannot be lost, and goes red the moment somebody gives the tab
   * a real subject.
   */
  it("Awaiting approval counts 0 when nobody has asked, whatever the status", () => {
    const reachable: FlowSummary[] = [
      flow({ id: "a1", status: "draft" }),
      flow({ id: "a2", status: "draft_pending", armedRevision: 1 }),
      flow({ id: "a3", status: "approved", armedRevision: 1 }),
      flow({ id: "a4", status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }),
      flow({ id: "a5", status: "suspended", armedRevision: 1 }),
    ];
    expect(viewCounts(reachable).awaiting).toBe(0);
  });

  it("counts Running/Failed from lastExecution join (P6)", () => {
    const withRuns: FlowSummary[] = [
      flow({ id: "r1", lastExecution: { id: "e1", status: "running", engineStatus: "running" } }),
      flow({ id: "r2", lastExecution: { id: "e2", status: "failed", engineStatus: "failed" } }),
      flow({ id: "r3", lastExecution: { id: "e3", status: "succeeded", engineStatus: "success" } }),
      flow({ id: "r4" }), // no run → honest 0
      flow({ id: "r5", lastRun: { outcome: "stopped" } }),
    ];
    const c = viewCounts(withRuns);
    expect(c.running).toBe(1);
    expect(c.failed).toBe(2); // r2 + r5
    expect(c.all).toBe(5);
  });

  it("returns every key, including a suspended zero, so a tab can render a 0", () => {
    const counts = viewCounts([]);
    for (const key of Object.keys(counts)) {
      expect(counts[key as ViewKey]).toBe(0);
    }
  });
});

describe("flow-views — P5 B-06 owner helpers", () => {
  it("hasOwnerData is false until any flow carries ownerSubject", () => {
    expect(hasOwnerData([flow({})])).toBe(false);
    expect(hasOwnerData([flow({ ownerSubject: "sub-1" })])).toBe(true);
    expect(hasOwnerData([])).toBe(false);
  });

  it("isMyDraft filters drafts by me.subject", () => {
    expect(isMyDraft(flow({ status: "draft", ownerSubject: "sub-me" }), "sub-me")).toBe(true);
    expect(isMyDraft(flow({ status: "draft", ownerSubject: "sub-other" }), "sub-me")).toBe(false);
    expect(isMyDraft(flow({ status: "draft" }), "sub-me")).toBe(false);
    expect(isMyDraft(flow({ status: "armed", armedRevision: 1, ownerSubject: "sub-me" }), "sub-me")).toBe(false);
    expect(isMyDraft(flow({ status: "draft", ownerSubject: "sub-me" }), null)).toBe(false);
  });
});

/**
 * ⚠ **THE PREDICATE THE TURN-OFF BUG CAME DOWN TO.**
 *
 * `armed_revision` is the record of what WAS armed, not a liveness flag —
 * `revoke` removes the Kestra trigger, closes the approvals, writes
 * `status: "suspended"`, and leaves the column set. Four call sites read it as
 * "live" and all four were wrong about a revoked flow.
 */
describe("flow-views — isRunningUnattended", () => {
  it("is true for every state in which the live revision can fire", () => {
    expect(isRunningUnattended({ status: "armed" })).toBe(true);
    expect(isRunningUnattended({ status: "approved" })).toBe(true);
    // Still firing the approved revision, with an unapproved draft waiting.
    expect(isRunningUnattended({ status: "draft_pending" })).toBe(true);
  });

  it("is false once a flow is revoked, EVEN THOUGH armed_revision survives", () => {
    expect(isRunningUnattended({ status: "suspended" })).toBe(false);
    expect(isRunningUnattended({ status: "draft" })).toBe(false);
  });

  it("classifies every status in the union — no state falls through by default", () => {
    /**
     * ⚠ The point of the exhaustive `Record`. Both defaults are wrong and they
     * are wrong asymmetrically: defaulting a new status to "not running" tells
     * somebody an automation is stopped while it fires, and defaulting it to
     * "running" is the bug this change fixes. So a new status must not be able
     * to arrive without a decision — and this asserts the decision exists for
     * all five, rather than that any particular one is true.
     */
    const every: FlowSummary["status"][] = ["draft", "draft_pending", "approved", "armed", "suspended"];
    for (const status of every) {
      expect(typeof isRunningUnattended({ status })).toBe("boolean");
    }
  });
});

/**
 * Two causes of "not running", two sentences. `staleReason` is written by the
 * staleness sweep alone; `revoke` writes none, because a person turning a flow
 * off is not a fault.
 */
describe("flow-views — offReason", () => {
  it("reports the sweep's reason when the sweep suspended the flow", () => {
    const r = offReason({ status: "suspended", staleReason: "a referenced tool changed shape" });
    expect(r).toEqual({ kind: "stale", text: "a referenced tool changed shape" });
  });

  it("reports a deliberate turn-off when there is no stale reason", () => {
    /**
     * ⚠ The state the row used to render as an ordinary armed flow: `revoke`
     * sets `status` and nothing else, so the old
     * `status === "suspended" && !!staleReason` was false and the row showed no
     * warn ground, no Review and no explanation at all.
     */
    const r = offReason({ status: "suspended", staleReason: null });
    expect(r?.kind).toBe("turned_off");
    expect(r?.text).toMatch(/turned off/i);
    // ⚠ It must NOT read as a fault — that is the whole reason there are two.
    expect(r?.text).not.toMatch(/suspended|stale|error|fail/i);
  });

  it("is null for a running flow and for an ordinary draft", () => {
    expect(offReason({ status: "armed", staleReason: null })).toBeNull();
    expect(offReason({ status: "draft_pending", staleReason: null })).toBeNull();
    // A never-approved draft is not "off"; it was never on, and owes no sentence.
    expect(offReason({ status: "draft", staleReason: null })).toBeNull();
  });
});

describe("flow-views — Mine (rbac-observability)", () => {
  it("is the server's answer, never a guess from the owner field", () => {
    const mine = VIEWS.find((v) => v.key === "mine")!;
    const base = { id: "f", name: "n", kestraFlowId: "k", draftRevision: 1, armedRevision: null, status: "draft" as const, draftAhead: true };
    expect(mine.match({ ...base, ownerSubject: "me", mine: true })).toBe(true);
    expect(mine.match({ ...base, ownerSubject: "me", mine: false })).toBe(false);
    expect(mine.match({ ...base, ownerSubject: "me" })).toBe(false);
  });
});
