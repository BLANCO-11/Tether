/**
 * A Pi run's inputs — the values a person supplies BEFORE the run (pi-runtime P4). Pure: no database, no config,
 * so the rule is testable on its own and the runner service, the test form and any later caller share ONE copy.
 */
/** The types a workflow input may declare — what the test form offers a control for and the run coerces to. */
export const RUN_INPUT_TYPES = ["string", "integer", "number", "boolean", "date"] as const;

/**
 * The inputs a run actually uses, TYPED: each declared default, then whatever the run was started with — a value
 * given always wins (the runner's own rule, `run_one.py`). A form sends text, so a value is coerced to its declared
 * type here, once, before a run exists; a step then receives `6`, never `"6"`.
 *
 * Refused by name (never guessed): a value for an input the workflow does not declare, a value that is not of its
 * declared type, and a declared input with no default that the run was not given.
 */
export function runInputsOf(
  workflow: { inputs?: Record<string, unknown>; schedule?: { timezone?: string } },
  given: Record<string, unknown> | undefined,
  opts: { live?: boolean; now?: Date } = {},
): { values: Record<string, unknown>; problems: string[] } {
  const declared = workflow.inputs ?? {};
  const problems: string[] = [];
  const values: Record<string, unknown> = {};
  for (const name of Object.keys(given ?? {})) {
    if (!(name in declared)) problems.push(`"${name}" is not an input this workflow declares (it declares: ${Object.keys(declared).join(", ") || "none"})`);
  }
  for (const [name, raw] of Object.entries(declared)) {
    const d = (raw ?? {}) as { type?: unknown; default?: unknown; relative?: unknown };
    const has = given != null && name in given && !(typeof given[name] === "string" && (given[name] as string).trim() === "");
    // A REAL run of an input declared relative to the run day ("last week's start") works it out from today, in the
    // schedule's timezone; a TEST run uses `default` — a date the test data has rows for (2026-10-11). A value given wins.
    const rel = !has && opts.live && typeof d.relative === "string" ? relativeDate(d.relative, opts.now ?? new Date(), workflow.schedule?.timezone ?? "UTC") : null;
    if (!has && !rel && !("default" in d)) {
      problems.push(`input "${name}" has no default and was not given a value`);
      continue;
    }
    const v = has ? given![name] : rel ?? d.default;
    const typed = coerceInput(String(d.type ?? "string"), v);
    if (typed.error) problems.push(`input "${name}": ${typed.error}`);
    else values[name] = typed.value;
  }
  return { values, problems };
}

function coerceInput(type: string, v: unknown): { value?: unknown; error?: string } {
  const text = typeof v === "string" ? v.trim() : v;
  switch (type) {
    case "integer": {
      const n = typeof text === "number" ? text : Number(text);
      return Number.isInteger(n) ? { value: n } : { error: `expected a whole number, got ${JSON.stringify(v)}` };
    }
    case "number": {
      const n = typeof text === "number" ? text : Number(text);
      return typeof text !== "boolean" && text !== "" && Number.isFinite(n) ? { value: n } : { error: `expected a number, got ${JSON.stringify(v)}` };
    }
    case "boolean":
      if (text === true || text === "true") return { value: true };
      if (text === false || text === "false") return { value: false };
      return { error: `expected true or false, got ${JSON.stringify(v)}` };
    case "date":
      return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
        ? { value: text }
        : { error: `expected a date as YYYY-MM-DD, got ${JSON.stringify(v)}` };
    case "string":
      return { value: typeof text === "string" ? text : JSON.stringify(text) };
    default:
      return { error: `declares type "${type}", which is not one of ${RUN_INPUT_TYPES.join(", ")}` };
  }
}


/**
 * The dates an input may be declared relative to the run day — a period like "last week" a scheduled run must work out
 * itself, while a test run uses a fixed date inside the test data. Weeks start on Monday. ONE list, read by the
 * builder's checker (verify.mjs RELATIVE_DATES) and by every real run.
 */
export const RELATIVE_DATES = [
  "today",
  "yesterday",
  "this_week_start",
  "last_week_start",
  "last_week_end",
  "this_month_start",
  "last_month_start",
  "last_month_end",
] as const;

/** `relative` resolved against `now` in `timeZone`, as YYYY-MM-DD; null for a name not in RELATIVE_DATES. */
export function relativeDate(relative: string, now: Date, timeZone = "UTC"): string | null {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  // The run day, as a calendar date with no time of day: arithmetic in UTC cannot cross a DST edge.
  const today = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const day = (d: Date, add: number) => new Date(d.getTime() + add * 86_400_000);
  const weekStart = day(today, -((today.getUTCDay() + 6) % 7));
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const at: Record<string, Date> = {
    today,
    yesterday: day(today, -1),
    this_week_start: weekStart,
    last_week_start: day(weekStart, -7),
    last_week_end: day(weekStart, -1),
    this_month_start: monthStart,
    last_month_start: lastMonthStart,
    last_month_end: day(monthStart, -1),
  };
  return at[relative] ? at[relative]!.toISOString().slice(0, 10) : null;
}
