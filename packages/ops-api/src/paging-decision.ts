/**
 * What a page DOES, as a pure function.
 *
 * ── Why this is not inline in `routes/ops.ts` ────────────────────────────────
 *
 * Everything else in that route is I/O — read the recent pages, insert a row.
 * The decision between the three outcomes is the only part that can be wrong in
 * a way nothing notices, and it needs a database to reach where it is written.
 * So it comes out here, exactly as `db-operation-readback.ts`,
 * `flow-expression-rules.ts` and `propose-adjudicate.ts` came out of their
 * callers, and for the same reason: a rule you cannot assert without standing up
 * Postgres is a rule that gets asserted once, by hand, on the day it is written.
 *
 * ── ⚠ THE THREE OUTCOMES, AND THE ONE THAT SURPRISES PEOPLE ─────────────────
 *
 *   delivered     somebody's phone rang.
 *   suppressed    they had already been told about this incident recently, so
 *                 nobody was woken a second time.
 *   no_responder  the address was undeliverable. NOBODY WAS WOKEN — which is an
 *                 escalation, not a warning to log.
 *
 * ⚠ SUPPRESSION COUNTS ONLY *DELIVERED* PAGES, and that is the rule most likely
 * to be "simplified" away. A previous attempt that found nobody home has told
 * nobody anything; suppressing against it would turn one unanswered page into
 * permanent silence for the rest of the window — during an outage, which is the
 * only time any of this runs. The query in `routes/ops.ts` filters on
 * `status = 'delivered'` for this reason and the test below pins it.
 *
 * ⚠ NONE OF THE THREE IS AN ERROR. The route returns 201 for all of them and the
 * outcome is in the body. A 4xx would make a retry policy re-page, which is the
 * exact behaviour suppression exists to prevent.
 */

export type PageStatus = "delivered" | "suppressed" | "no_responder";

export interface PageDecisionInput {
  /** The page key of the most recent DELIVERED page for this dedupe key inside the window, if any. */
  recentDeliveredKey: string | null;
  windowMins: number;
  dedupeKey: string;
  target: string;
  targetIsUndeliverable: boolean;
  escalationTarget: string | null;
}

export interface PageDecision {
  status: PageStatus;
  supersededBy: string | null;
  escalatedTo: string | null;
  reason: string | null;
  /** 1 only when a person was actually woken — what `api_call_log.result_count` records. */
  wokeSomeone: 0 | 1;
}

export function decidePage(input: PageDecisionInput): PageDecision {
  // ⚠ SUPPRESSION IS CHECKED FIRST, before deliverability. A repeat of an
  // incident somebody has already been told about should not be re-attempted
  // even if the address has since changed — the point of the window is that the
  // person has the information, not that a message was transmitted.
  if (input.recentDeliveredKey) {
    return {
      status: "suppressed",
      supersededBy: input.recentDeliveredKey,
      escalatedTo: null,
      reason:
        `${input.dedupeKey} was already paged as ${input.recentDeliveredKey} within the last ` +
        `${input.windowMins} minute(s); nobody was woken a second time`,
      wokeSomeone: 0,
    };
  }

  if (input.targetIsUndeliverable) {
    return {
      status: "no_responder",
      supersededBy: null,
      escalatedTo: input.escalationTarget,
      reason: input.escalationTarget
        ? `${input.target} is undeliverable; escalated to ${input.escalationTarget}`
        : `${input.target} is undeliverable and no escalation_target was given — NOBODY WAS WOKEN`,
      wokeSomeone: 0,
    };
  }

  return {
    status: "delivered",
    supersededBy: null,
    escalatedTo: null,
    reason: null,
    wokeSomeone: 1,
  };
}
