/**
 * ⚠ THE SUPPRESSION RULE IS THE ONE TO GET RIGHT, and the test that matters is
 * the one about pages that found nobody home.
 *
 * That behaviour was proven at the wire before this file existed — and by
 * accident. A probe paged an undeliverable address twice for the same key and
 * got `no_responder` both times rather than `suppressed` on the second. It was
 * the correct answer for the right reason, and nothing in the codebase would
 * have noticed if it had been the wrong one, because reaching it needs a live
 * database and a bouncing address. That is why the decision was extracted.
 */
import { describe, expect, it } from "vitest";
import { decidePage, type PageDecisionInput } from "./paging-decision.js";

const base: PageDecisionInput = {
  recentDeliveredKey: null,
  windowMins: 60,
  dedupeKey: "INC-1021",
  target: "dana.okoro@acme-itops.example",
  targetIsUndeliverable: false,
  escalationTarget: null,
};

describe("decidePage", () => {
  it("wakes somebody when nobody has been told and the address works", () => {
    const d = decidePage(base);
    expect(d.status).toBe("delivered");
    expect(d.wokeSomeone).toBe(1);
    expect(d.reason).toBeNull();
    expect(d.supersededBy).toBeNull();
  });

  it("suppresses a repeat and names the page it was a repeat of", () => {
    const d = decidePage({ ...base, recentDeliveredKey: "PG-2001" });
    expect(d.status).toBe("suppressed");
    expect(d.supersededBy).toBe("PG-2001");
    expect(d.wokeSomeone).toBe(0);
    // The reason has to name both the incident and the window, or a reviewer
    // reading the page log cannot tell why nothing happened.
    expect(d.reason).toContain("INC-1021");
    expect(d.reason).toContain("PG-2001");
    expect(d.reason).toContain("60 minute");
  });

  /**
   * ⚠ THE RULE MOST LIKELY TO BE "SIMPLIFIED" AWAY.
   *
   * `recentDeliveredKey` is null when the only earlier attempts failed to reach
   * anybody, because the query feeding it filters on `status = 'delivered'`.
   * Widening that filter to "any recent page" reads as tidier and means that
   * during an outage, one undeliverable page silences every subsequent one for
   * the rest of the window.
   */
  it("does NOT suppress against a page that woke nobody", () => {
    // Two undeliverable attempts in a row: the second must still be attempted.
    const first = decidePage({ ...base, targetIsUndeliverable: true });
    expect(first.status).toBe("no_responder");
    expect(first.wokeSomeone).toBe(0);
    // `recentDeliveredKey` stays null precisely because the first one delivered
    // nothing — this is the caller's contract and the reason for the SQL filter.
    const second = decidePage({ ...base, targetIsUndeliverable: true, recentDeliveredKey: null });
    expect(second.status).toBe("no_responder");
    expect(second.status).not.toBe("suppressed");
  });

  it("escalates an undeliverable page when it has somewhere to escalate to", () => {
    const d = decidePage({
      ...base,
      targetIsUndeliverable: true,
      escalationTarget: "it-major-incident@acme-itops.example",
    });
    expect(d.status).toBe("no_responder");
    expect(d.escalatedTo).toBe("it-major-incident@acme-itops.example");
    expect(d.reason).toContain("escalated to it-major-incident@acme-itops.example");
    // ⚠ Still zero. An escalation is a second chance, not a person woken — and
    // an automation reporting "1 paged" here would be claiming work it has no
    // evidence of.
    expect(d.wokeSomeone).toBe(0);
  });

  it("says NOBODY WAS WOKEN, in those words, when there is nowhere to escalate", () => {
    const d = decidePage({ ...base, targetIsUndeliverable: true });
    expect(d.escalatedTo).toBeNull();
    // The phrasing is pinned because this is the outcome a person skimming a run
    // must not read as success. "delivery failed" would be true and would sound
    // like an email problem rather than an unattended incident.
    expect(d.reason).toContain("NOBODY WAS WOKEN");
  });

  it("suppresses BEFORE it checks deliverability", () => {
    // Both conditions true. Suppression wins, because the point of the window is
    // that the person already has the information — re-attempting on a changed
    // address would wake them twice about one incident.
    const d = decidePage({
      ...base,
      recentDeliveredKey: "PG-2001",
      targetIsUndeliverable: true,
      escalationTarget: "it-major-incident@acme-itops.example",
    });
    expect(d.status).toBe("suppressed");
    expect(d.escalatedTo).toBeNull();
  });

  it("counts a woken person only for a delivered page", () => {
    // The control on `wokeSomeone`: it must actually vary with the outcome, or
    // `api_call_log.result_count` says the same thing whatever happened.
    const outcomes = [
      decidePage(base),
      decidePage({ ...base, recentDeliveredKey: "PG-2001" }),
      decidePage({ ...base, targetIsUndeliverable: true }),
    ];
    expect(outcomes.map((o) => o.status)).toEqual(["delivered", "suppressed", "no_responder"]);
    expect(outcomes.map((o) => o.wokeSomeone)).toEqual([1, 0, 0]);
  });
});
