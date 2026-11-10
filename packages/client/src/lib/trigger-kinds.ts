// src/lib/trigger-kinds.ts — the trigger kinds a person can create, and the ones
// that are named as unavailable rather than quietly dropped. ui-upgrade Phase
// 7.2, I-94.
//
// ── ⚠ INERT IS WORSE THAN REFUSED ───────────────────────────────────────────
//
// This list used to hold seven kinds and the server could create three. Email
// and File upload became webhooks with a misleading label; Kafka and RabbitMQ
// became `poll` triggers with no `config.url`, which the scheduler skips with
// `continue` — no fire, no error, no log. Scheduled job and Cron were refused by
// the server with a 409 the modal never showed. See I-94.
//
// It is the same finding `CLAUDE.md` records for the connector catalogue, and it
// is fixed the same way: a closed list that MIRRORS the server, plus a test that
// says so.
//
// ⚠ **`CREATABLE` is a mirror and fails in one direction on purpose.**
// `lib/trigger-kinds.test.ts` goes red when this list runs ahead of the server —
// a dead end shipped, which is the defect above — and stays quiet when the
// server runs ahead of this list, which is a missing option somebody complains
// about. The server's own list is `FLOW_TRIGGER_TYPES` in
// `services/trigger.service.ts`.

/** The four a flow-bound trigger may be. Mirrors `FLOW_TRIGGER_TYPES`. */
export type TriggerKind = "manual" | "webhook" | "poll" | "api";

export type TriggerKindSpec = {
  type: TriggerKind;
  label: string;
  /** The plain-English sentence the card and the picker both show. */
  quote: string;
  /** What the RUNTIME reads out of `config` — nothing else is collected. */
  config: { key: string; label: string; hint: string; placeholder?: string }[];
};

/**
 * ⚠ Each `config` entry names a key something actually reads.
 *
 * - `poll` → `trigger-scheduler.ts` fetches `config.url` every
 *   `config.intervalSeconds` and fires on a change of body hash.
 * - `webhook` → collects **nothing**. Its address is `webhookPath`, minted by
 *   the server from a token at creation; the old form asked for one and stored
 *   it under a key nobody read.
 * - `api` → collects **nothing**, for the same reason as webhook. It is a
 *   token-bearing row too; the server mints the token and returns the receiver
 *   (`/api/triggers/<token>/api`) in the same `webhookPath` field the webhook
 *   uses, so the two rows render identically (Phase 6).
 * - `manual` → collects nothing. It is fired by a person, from this page.
 *
 * The values a trigger sends live in `config.inputs` and are edited through
 * `TriggerInputsEditor`, not here — they are the automation's declared inputs
 * (D-107), not a property of the kind.
 */
export const CREATABLE: readonly TriggerKindSpec[] = [
  {
    type: "manual",
    label: "Start by hand",
    quote: "Someone starts it from Tether when it is needed.",
    config: [],
  },
  {
    type: "webhook",
    label: "Webhook",
    quote: "When another system sends us a message, start.",
    config: [],
  },
  {
    type: "api",
    label: "API",
    quote: "When another system posts with the trigger's token, start.",
    config: [],
  },
  {
    type: "poll",
    label: "Watch a web address",
    quote: "Tether checks an address on a timer and starts when what it returns changes.",
    config: [
      {
        key: "url",
        label: "Address to watch",
        hint: "Tether fetches this and starts the automation when the response changes.",
        placeholder: "https://example.com/status.json",
      },
      {
        key: "intervalSeconds",
        label: "How often, in seconds",
        hint: "Defaults to 60 if left blank.",
        placeholder: "60",
      },
    ],
  },
] as const;

/**
 * The schedule OPTION, deliberately outside `CREATABLE`.
 *
 * A cron is NOT a trigger row in this product — it lives on the flow's MODEL and
 * approving a revision is what deploys it (D-18); a Foundry `schedule` row would
 * be a second way to fire on a timer that no approval covers, which is why the
 * server refuses one by name. So this is the picker entry that says where a
 * schedule actually lives instead of offering the impossible row:
 *
 * - on `/flows/[id]` (which has a flow in hand) picking it opens the flow's
 *   `SchedulePane` — the flow-scoped schedule surface;
 * - on `/triggers` (no flow context) the option is rendered DISABLED, with the
 *   tooltip sentence below.
 */
export const SCHEDULE_SPEC: {
  type: "schedule";
  label: string;
  quote: string;
  config: readonly [];
  /** Where a schedule actually lives, and how it is deployed. */
  reason: string;
} = {
  type: "schedule",
  label: "Schedule (time)",
  quote: "A time trigger edits the flow model's schedule — no separate row, it rides the revision.",
  config: [],
  reason:
    "Schedules live on the flow, not the trigger list. Set the cron on the automation and " +
    "approve a revision — approving is what deploys the schedule, and revoking removes it.",
};

/**
 * Named as unavailable rather than removed.
 *
 * ⚠ Deleting them silently would leave the person who came here for an email or
 * file-drop trigger with nowhere to go and no idea why. The reason is the
 * useful half. (A schedule used to sit here too; Phase 6 moved it into the
 * picker as `SCHEDULE_SPEC` — it is not unavailable, it is elsewhere.)
 */
export const UNAVAILABLE: readonly { label: string; reason: string }[] = [
  {
    label: "Email · file drop · Kafka · a work queue",
    reason:
      "Tether has no connector for these yet. They were pickable here until they were found to " +
      "create a trigger that stored fine and could never start anything.",
  },
] as const;

/** The spec for a stored trigger's type, or undefined for one this build cannot describe. */
export function kindSpec(type: string): TriggerKindSpec | undefined {
  return CREATABLE.find((k) => k.type === type);
}
