import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowRevisions, flows } from "../db/schema.js";

/**
 * B-01 next-fire armed only 30d + overflow.
 * Reads from ARMED revision, never draft (D-18). Prefers Kestra engine if available
 * but stub computes expansion in Foundry with note "derived in Foundry" beside number.
 * honouring armed only D-18, limit 4, window 30d.
 */

export interface NextFire {
  flowId: string;
  flowName: string;
  cron: string;
  fireAt: string;
  description: string | null;
  derivedInFoundry: boolean;
}

export interface NextFireResult {
  nextFires: NextFire[];
  overflow: number;
  total: number;
  windowDays: number;
  limit: number;
  derivedInFoundry: boolean;
}

function looksLikeCron(cron: string): boolean {
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
function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const stepHour = /^\*\/(\d{1,2})$/.exec(hour);
  if (stepHour && dom === "*" && mon === "*" && dow === "*" && /^\d{1,2}$/.test(min)) {
    return `Every ${Number(stepHour[1])} hours`;
  }
  if (dom === "*" && mon === "*" && dow === "*") {
    const at = hhmm(min, hour);
    return at ? `Every day at ${at}` : null;
  }
  if (dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
    const at = hhmm(min, hour);
    return at ? `Every ${DAYS[Number(dow)]} at ${at}` : null;
  }
  if (mon === "*" && dow === "*" && /^\d{1,2}$/.test(dom)) {
    const at = hhmm(min, hour);
    const d = Number(dom);
    return at && d >= 1 && d <= 31 ? `On day ${d} of every month at ${at}` : null;
  }
  const stepDay = /^\*\/(\d{1,2})$/.exec(dom);
  if (stepDay && mon === "*" && dow === "*") {
    const at = hhmm(min, hour);
    const n = Number(stepDay[1]);
    return at ? `Every ${n} days at ${at} — counting from the 1st of each month` : null;
  }
  return null;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field === "?") return true;
  // step like */N
  const stepAll = /^\*\/(\d+)$/.exec(field);
  if (stepAll) {
    const step = Number(stepAll[1]);
    if (step <= 0) return false;
    return value % step === 0;
  }
  // list
  if (field.includes(",")) {
    return field.split(",").some((p) => fieldMatches(p.trim(), value));
  }
  // range with step e.g. 1-10/2
  const rangeStep = /^(\d+)-(\d+)\/(\d+)$/.exec(field);
  if (rangeStep) {
    const lo = Number(rangeStep[1]);
    const hi = Number(rangeStep[2]);
    const step = Number(rangeStep[3]);
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  }
  // range
  const range = /^(\d+)-(\d+)$/.exec(field);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return value >= lo && value <= hi;
  }
  // step on range with */? already handled, also e.g. 2/3 ?
  const stepVal = /^(\d+)\/(\d+)$/.exec(field);
  if (stepVal) {
    const start = Number(stepVal[1]);
    const step = Number(stepVal[2]);
    if (value < start) return false;
    return (value - start) % step === 0;
  }
  // exact
  if (/^\d+$/.test(field)) return Number(field) === value;
  // contains LW#? treat as non-match -> no fire
  return false;
}

function matchesCron(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  let f5: string[];
  if (fields.length === 6) {
    // seconds field ignored
    f5 = fields.slice(1);
  } else if (fields.length === 5) {
    f5 = fields;
  } else return false;
  const [minF, hourF, domF, monF, dowF] = f5;
  // unsupported cron chars -> no match
  if (/[LW#]/.test(cron)) return false;
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();
  return (
    fieldMatches(minF, minute) &&
    fieldMatches(hourF, hour) &&
    fieldMatches(domF, dom) &&
    fieldMatches(monF, mon) &&
    fieldMatches(dowF, dow)
  );
}

function expandCron(cron: string, from: Date, windowDays: number): Date[] {
  const out: Date[] = [];
  const end = new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);
  // iterate minute by minute, but start at next minute boundary
  const cur = new Date(from);
  cur.setUTCSeconds(0, 0);
  cur.setUTCMinutes(cur.getUTCMinutes() + 1);
  while (cur <= end) {
    if (matchesCron(cron, cur)) out.push(new Date(cur));
    cur.setUTCMinutes(cur.getUTCMinutes() + 1);
    // safety: prevent infinite loop if cron never matches
    if (out.length > 500) break;
  }
  return out;
}

export const nextFireService = {
  describeCron,
  looksLikeCron,

  async list(workspaceId: string, limit = 4, windowDays = 30): Promise<NextFireResult> {
    const l = Math.min(Math.max(Math.trunc(limit) || 4, 1), 20);
    const w = Math.min(Math.max(Math.trunc(windowDays) || 30, 1), 90);
    // armed only: flows where armedRevision IS NOT NULL
    const armedFlows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.workspaceId, workspaceId), isNotNull(flows.armedRevision)));

    const allFires: NextFire[] = [];
    const now = new Date();

    for (const f of armedFlows) {
      if (f.armedRevision == null) continue;
      const rev = await db
        .select()
        .from(flowRevisions)
        .where(and(eq(flowRevisions.flowId, f.id), eq(flowRevisions.revision, f.armedRevision)))
        .limit(1);
      const row = rev[0];
      if (!row) continue;
      const model = row.modelJson as { schedule?: { cron?: string } } | null;
      const cron = model?.schedule?.cron;
      if (!cron || typeof cron !== "string") continue;
      const trimmed = cron.trim();
      if (!trimmed) continue;
      if (!looksLikeCron(trimmed)) continue;
      // expand
      const fires = expandCron(trimmed, now, w);
      for (const d of fires) {
        allFires.push({
          flowId: f.id,
          flowName: f.name,
          cron: trimmed,
          fireAt: d.toISOString(),
          description: describeCron(trimmed),
          derivedInFoundry: true,
        });
      }
    }

    allFires.sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime());
    const total = allFires.length;
    const nextFires = allFires.slice(0, l);
    const overflow = total > l ? total - l : 0;
    return { nextFires, overflow, total, windowDays: w, limit: l, derivedInFoundry: true };
  },
};
