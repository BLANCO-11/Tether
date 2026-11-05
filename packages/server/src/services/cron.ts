/**
 * Five-field cron — minute hour day-of-month month day-of-week — for Forge workflows' schedules (pi-runtime P5). Kestra
 * evaluated every cron until Foundry's runner had schedules of its own; this is the small, total subset a schedule
 * needs: `*`, numbers, lists `a,b`, ranges `a-b`, steps `*\/n` and `a-b/n`. Day-of-week is 0–6 (Sunday 0; 7 is also
 * Sunday). When both day fields are restricted, a day matches if EITHER does — the classic cron rule.
 *
 * Pure. Evaluated in the schedule's own timezone, so "09:00 Europe/London" is nine o'clock there in winter and summer.
 */

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export type ParsedCron = { sets: Array<Set<number>>; domAny: boolean; dowAny: boolean };

/** Parse a cron, or throw naming the field that is wrong. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a schedule needs 5 fields (minute hour day month weekday), got ${parts.length}: "${expr}"`);
  const sets = parts.map((part, i) => {
    const f = FIELDS[i]!;
    const out = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`the ${f.name} field "${part}" is not valid`);
      const step = m[3] ? Number(m[3]) : 1;
      const lo = m[1] === "*" ? f.min : Number(m[1]);
      const hi = m[1] === "*" ? f.max : m[2] ? Number(m[2]) : m[3] ? f.max : lo;
      if (step < 1 || lo < f.min || hi > f.max || lo > hi) throw new Error(`the ${f.name} field "${part}" is out of range ${f.min}–${f.max}`);
      for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { sets, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** The wall-clock fields of `at` in `timeZone`. */
function partsIn(at: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday };
}

/** Whether the cron fires in the minute containing `at`, in `timeZone` (default UTC). */
export function cronMatches(expr: string | ParsedCron, at: Date, timeZone = "UTC"): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const t = partsIn(at, timeZone);
  const [mi, h, dom, mon, dow] = c.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!mi.has(t.minute) || !h.has(t.hour) || !mon.has(t.month)) return false;
  const domOk = dom.has(t.day);
  const dowOk = dow.has(t.weekday);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** The start of the minute containing `at` — what a schedule run is de-duplicated on. */
export function minuteOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}
