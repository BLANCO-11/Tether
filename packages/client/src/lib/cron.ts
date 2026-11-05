// src/lib/cron.ts — the small amount of cron this product needs a browser to
// know: whether a string is shaped like one, and what the common ones mean.
//
// ── ⚠ THIS IS NOT A CRON PARSER AND MUST NOT BECOME ONE ─────────────────────
//
// **Kestra owns cron.** It parses it, decides catch-up, and decides overlap
// policy. `flow-compiler.service.ts` checks the shape (5 or 6 fields of cron
// charset) and hands the string over verbatim. A second parser here would be a
// second opinion about when an automation fires, and the two would disagree on
// exactly the expressions nobody tests — `L`, `#`, `?`, step syntax on a range.
//
// So `describeCron` recognises a SHORT LIST of shapes and answers `null` for
// everything else. `null` renders as *"a custom schedule"*, never as a guess.
// A wrong plain-English description of when something fires is worse than none:
// it is the sentence somebody will quote back when the batch went out at the
// wrong hour.
//
// ⚠ `looksLikeCron` MIRRORS `assertCron` in `flow-compiler.service.ts` and
// fails in one direction on purpose — it lets through things the compiler may
// still refuse, so the server stays the authority and the browser only saves a
// round trip on the obvious mistakes. It must never be the only check.

/** 5 or 6 whitespace-separated fields of cron charset — the compiler's own rule. */
export function looksLikeCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((f) => /^[0-9*/,\-?LW#]+$/.test(f));
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hhmm(minute: string, hour: string): string | null {
  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Plain English for the handful of shapes this product's own presets produce,
 * and `null` for everything else.
 *
 * ⚠ Returning `null` is the important half. See the header.
 */
export function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];

  // ⚠ Every N hours is checked FIRST. `0 */6 * * *` has `* * *` in the last
  // three fields too, so the every-day branch below matches it, fails to read
  // `*/6` as an hour, and returns null — a describable schedule going
  // undescribed. Order is the whole fix; a test pins it.
  const stepHour = /^\*\/(\d{1,2})$/.exec(hour);
  if (stepHour && dom === "*" && mon === "*" && dow === "*" && /^\d{1,2}$/.test(min)) {
    return `Every ${Number(stepHour[1])} hours`;
  }
  // Every day at HH:MM
  if (dom === "*" && mon === "*" && dow === "*") {
    const at = hhmm(min, hour);
    return at ? `Every day at ${at}` : null;
  }
  // Every <weekday> at HH:MM
  if (dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
    const at = hhmm(min, hour);
    return at ? `Every ${DAYS[Number(dow)]} at ${at}` : null;
  }
  // On the Nth of every month at HH:MM
  if (mon === "*" && dow === "*" && /^\d{1,2}$/.test(dom)) {
    const at = hhmm(min, hour);
    const d = Number(dom);
    return at && d >= 1 && d <= 31 ? `On day ${d} of every month at ${at}` : null;
  }
  // Every N days at HH:MM — `*/N` in the day-of-month field. ⚠ This is what cron
  // actually does, and it is NOT "every N days" across a month boundary: the
  // count restarts on the 1st. Said here rather than glossed, because "every 3
  // days" is the exact phrase somebody types expecting the other behaviour.
  const stepDay = /^\*\/(\d{1,2})$/.exec(dom);
  if (stepDay && mon === "*" && dow === "*") {
    const at = hhmm(min, hour);
    const n = Number(stepDay[1]);
    return at ? `Every ${n} days at ${at} — counting from the 1st of each month` : null;
  }
  return null;
}

// ── The composer ────────────────────────────────────────────────────────────
//
// ⚠ **THIS IS A COMPOSER, NOT A PARSER, AND THE DISTINCTION IS THE WHOLE
// REASON IT IS ALLOWED TO EXIST.** The header above forbids a second opinion
// about *when* an automation fires. `buildCron` never reads a cron string and
// never decides what one means: it takes a choice a person made from a fixed
// set of controls and writes the field string that expresses it. Kestra still
// parses it and still decides catch-up and overlap.
//
// ⚠ **`buildCron`'s OUTPUT SET IS EXACTLY `describeCron`'s INPUT SET, and that
// is a checked property rather than a coincidence.** A picker that could emit
// an expression the describer cannot read back would render *"a custom
// schedule"* for a schedule the person had just built by clicking — a screen
// contradicting itself about the thing it had just been told. `cron.test.ts`
// enumerates every `CronChoice` the picker can produce and requires
// `describeCron` to answer non-null for all of them, with a control that the
// enumeration is not empty.
//
// So the five frequencies below are not a menu somebody chose for taste. They
// are `describeCron`'s five branches, in its order. **Adding a frequency here
// without a matching branch there is the one edit that breaks the property**,
// and the test is what says so.

/** The frequencies the picker offers — one per `describeCron` branch. */
export const CRON_FREQUENCIES = ["hourly", "daily", "weekly", "monthly", "everyNDays"] as const;
export type CronFrequency = (typeof CRON_FREQUENCIES)[number];

/**
 * A schedule as a person picked it, before it becomes cron.
 *
 * ⚠ Every field is present for every frequency rather than being a discriminated
 * union, and that is deliberate: the picker keeps a day and a time across a
 * change of frequency, so switching Weekly → Monthly → Weekly must not silently
 * reset the time to midnight. The frequency decides which fields are READ; it
 * does not decide which are held.
 */
export type CronChoice = {
  frequency: CronFrequency;
  /** 0–23. Read by every frequency except `hourly`. */
  hour: number;
  /** 0–59. Read by every frequency. */
  minute: number;
  /** 0 = Sunday … 6 = Saturday. Read by `weekly`. */
  weekday: number;
  /** 1–31. Read by `monthly`. */
  dayOfMonth: number;
  /** The step, in hours for `hourly` and in days for `everyNDays`. */
  interval: number;
};

/** The choice the picker opens on when a flow has no schedule: every day at 07:00. */
export const DEFAULT_CRON_CHOICE: CronChoice = {
  frequency: "daily",
  hour: 7,
  minute: 0,
  weekday: 1,
  dayOfMonth: 1,
  interval: 6,
};

/** Clamp to the range cron accepts, so a control cannot emit an out-of-range field. */
function bound(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i < lo ? lo : i > hi ? hi : i;
}

/**
 * Write the 5-field cron expressing this choice.
 *
 * ⚠ **Total, never `null`.** Every branch clamps its inputs into cron's own
 * ranges, so there is no combination of controls that yields an invalid string
 * and no error state for the picker to render. A `null` here would be a fourth
 * way for the panel to say "no schedule" beside the three it already has.
 *
 * ⚠ **The `hourly` branch pins the minute and NOT the hour** — `0 * /6 * * *`
 * fires at minute 0 of every sixth hour. Writing the hour as a literal and the
 * minute as a step would fire 60 times in one hour, once, and then never again
 * that day: the same characters in the other order, and a mistake nobody would
 * see until the following morning.
 */
export function buildCron(choice: CronChoice): string {
  const minute = bound(choice.minute, 0, 59, 0);
  const hour = bound(choice.hour, 0, 23, 7);
  switch (choice.frequency) {
    case "hourly":
      return `${minute} */${bound(choice.interval, 1, 23, 6)} * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${bound(choice.weekday, 0, 6, 1)}`;
    case "monthly":
      return `${minute} ${hour} ${bound(choice.dayOfMonth, 1, 31, 1)} * *`;
    case "everyNDays":
      return `${minute} ${hour} */${bound(choice.interval, 1, 31, 3)} * *`;
  }
}
