// src/lib/trigger-kinds.test.ts — the picker may only offer what the server can
// create for a flow. ui-upgrade Phase 7.2, I-94.
//
// The defect: seven kinds offered, three creatable. Email and File upload became
// webhooks under a wrong label; Kafka and RabbitMQ became `poll` triggers with
// no `config.url`, which `trigger-scheduler.ts` skips with a bare `continue` —
// so they never fired and logged nothing; Scheduled job and Cron were refused
// with a 409 the modal swallowed. Four of the seven stored a named, apparently
// configured trigger that could never start anything.
//
// This is `connectors.test.ts`'s shape, for the same reason and with the same
// caveat about direction.
import { describe, expect, it } from "vitest";
import { CREATABLE, SCHEDULE_SPEC, UNAVAILABLE, kindSpec } from "@/lib/trigger-kinds";

/**
 * ⚠ **A MIRROR of `FLOW_TRIGGER_TYPES` in
 * `packages/server/src/services/trigger.service.ts`**, and it says so rather
 * than pretending to derive it. The client has no endpoint that would tell it,
 * and adding one to serve three strings is more moving parts than the thing it
 * guards.
 *
 * ⚠ Know which direction it protects. The SERVER gaining a fourth type leaves
 * this green while the catalogue lags — a missing option somebody complains
 * about. The CATALOGUE gaining one the server refuses turns it red, which is
 * the direction that ships a dead end.
 */
const FLOW_TRIGGER_TYPES: Record<string, true> = {
  manual: true,
  poll: true,
  webhook: true,
  api: true,
};

describe("the trigger catalogue mirrors the server", () => {
  it("offers nothing the server cannot create for a flow", () => {
    for (const k of CREATABLE) {
      expect(FLOW_TRIGGER_TYPES[k.type] === true, `"${k.label}" creates type "${k.type}"`).toBe(true);
    }
  });

  it("offers no `schedule`, however it is spelled", () => {
    // The one refusal with a reason rather than a gap: a cron lives on the flow
    // MODEL and is deployed by approving a revision (D-18). A Foundry schedule
    // row would be a second way to fire on a timer that no approval covers.
    expect(CREATABLE.map((k) => String(k.type))).not.toContain("schedule");
  });

  it("offers each creatable type exactly once", () => {
    // Two entries for one type is two names for one thing, which is how a card
    // ends up labelled differently from the picker that made it.
    const types = CREATABLE.map((k) => k.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("is not empty — a mirror over nothing would pass forever", () => {
    // I-38. Every assertion above is a for-loop or a `not.toContain`, and all of
    // them hold over an empty list.
    expect(CREATABLE.length).toBeGreaterThan(0);
    expect(kindSpec("manual")).toBeDefined();
    expect(kindSpec("schedule")).toBeUndefined();
  });
});

describe("what each kind collects is what something reads", () => {
  it("asks a poll trigger for the url the scheduler actually fetches", () => {
    // `trigger-scheduler.ts`: `if (!cfg.url) continue`. A poll trigger with no
    // url is the silent half of I-94 — it never fires and never says why.
    const poll = kindSpec("poll")!;
    expect(poll.config.map((c) => c.key)).toContain("url");
  });

  it("asks a webhook trigger for nothing, because its address is minted server-side", () => {
    // The old form collected `config.path` while the real address is
    // `webhookPath`, built from a token the server generates. The person typed
    // one address and the card showed another.
    expect(kindSpec("webhook")!.config).toHaveLength(0);
  });

  it("asks an api trigger for nothing, for the same reason as the webhook", () => {
    // Phase 6: an api trigger is a token-bearing row like the webhook, and its
    // receiver rides the same `webhookPath` field — so there is no more to
    // collect at creation than there is for a webhook.
    expect(kindSpec("api")!.config).toHaveLength(0);
  });

  it("asks a manual trigger for nothing", () => {
    expect(kindSpec("manual")!.config).toHaveLength(0);
  });
});

describe("what was removed is NAMED, not silently dropped", () => {
  it("says where a schedule really lives, and does not offer one as a row", () => {
    // ⚠ Phase 6 moved the schedule answer out of "unavailable" and into the
    // picker as `SCHEDULE_SPEC`: a cron is not a trigger row in this product,
    // so the entry's job is to point at the flow — never at a create that
    // would be refused. The reason is the useful half.
    expect(SCHEDULE_SPEC.type).toBe("schedule");
    expect(SCHEDULE_SPEC.reason).toMatch(/approv/i);
    expect(CREATABLE.map((k) => String(k.type))).not.toContain("schedule");
  });

  it("keeps at least one entry for the connectors that do not exist yet", () => {
    expect(UNAVAILABLE.length).toBeGreaterThan(0);
  });
});
