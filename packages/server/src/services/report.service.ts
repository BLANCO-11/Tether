/**
 * The cost report (2026-10-26): what the model calls behind each workspace, workflow, run and person cost.
 *
 * ## Who may open it
 *
 * `reports.read`, a workspace permission the Admin preset holds. The report is NOT scoped to one workspace: it spans the
 * workspaces the caller holds that permission in (every workspace for a super admin, who holds all of them). So the
 * routes are identity-only in the route map and the authorisation is in the CONTENTS, the way `GET /api/workspaces` is:
 * `resolveWorkspaces` turns what the caller asked for into what they may see, and refuses a workspace outside it.
 * Everything below takes an already-resolved list of workspace ids and never decides who somebody is.
 *
 * ## What a "run" is
 *
 * One row per run: a test or live execution (`usage_events.execution_id`), or one building session (`session_id`)
 * which has no execution. Rows with neither stand alone. Cost is `costOf()`, the one definition every cost summary
 * uses, so this page agrees with the rest of the product.
 */
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flows, usageEvents } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { effectivePermissionsService, PlatformRoleCache, type Identity } from "./effective-permissions.service.js";
import { costOf } from "./model-pricing.service.js";

const DAY = 86_400_000;

/** A flow-less building session has no workflow to name; the filter value for it. */
export const NO_FLOW = "none";

export type ReportPurpose = "building" | "test" | "live";

export type ReportOutcome = "succeeded" | "failed" | "stopped";

/**
 * Which of the three outcomes a run's status is, or null when it has none: a building session has no execution, and a
 * run still going or waiting has not ended, so counting either as success or failure would invent an answer.
 */
export function outcomeOf(status: string): ReportOutcome | null {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "partial") return "failed";
  if (status === "rejected" || status === "expired" || status === "cancelled") return "stopped";
  return null;
}

export interface ReportWorkspace {
  id: string;
  name: string;
}

export interface ReportWindow {
  /** Inclusive, UTC midnight. */
  since: Date;
  /** Exclusive, UTC midnight. */
  until: Date;
  /** `YYYY-MM-DD`, inclusive both ends: what the person sees and what is recorded. */
  fromDay: string;
  toDay: string;
}

/** The drill filters. Applied in memory, to runs already limited to the workspaces the caller may see. */
export interface ReportDrill {
  /** A subset of the workspaces the caller may see; empty means all of them. */
  workspaceIds?: readonly string[];
  /** A workflow id, or `NO_FLOW` for building sessions that never became a workflow. */
  flowId?: string;
  /** An identity subject. */
  subject?: string;
}

export interface ReportRun {
  key: string;
  workspaceId: string;
  workspaceName: string;
  flowId: string | null;
  flowName: string;
  subject: string | null;
  person: string;
  purpose: ReportPurpose;
  /** The execution's status, or `session` for a building session (it has no execution). */
  status: string;
  at: string;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  costUsd: number;
}

export interface ReportGroup {
  /** The value a drill filter takes: a workspace id, a workflow id (or `none`), or a subject. */
  id: string | null;
  name: string;
  /** Set on the workflow lens: the workspace the workflow lives in. */
  workspaceName?: string;
  workspaceId?: string;
  costUsd: number;
  tokens: number;
  runs: number;
  workflows: number;
  people: number;
  workspaces: number;
  share: number;
}

export interface ReportSummary {
  window: { fromDay: string; toDay: string };
  tiles: {
    costUsd: number;
    tokens: number;
    runs: number;
    workspaces: number;
    workflows: number;
    people: number;
  };
  /** Each day of the window, with its cost split by what spent it. A quiet day is zeros, not a gap. */
  byDay: Array<{ day: string; costUsd: number; live: number; test: number; building: number }>;
  byPurpose: Array<{ purpose: ReportPurpose; costUsd: number; runs: number }>;
  /** Cost of the runs that have an outcome. Building sessions and runs still going have none (`withoutOutcome`). */
  byOutcome: Array<{ outcome: ReportOutcome; costUsd: number; runs: number }>;
  withoutOutcome: number;
  lenses: { workspaces: ReportGroup[]; workflows: ReportGroup[]; people: ReportGroup[] };
}

const n = (v: unknown) => Number(v ?? 0);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** `days` back from today (today included), or an explicit inclusive `from`..`to`. */
export function windowOf(input: { days?: number; from?: string; to?: string }, now = new Date()): ReportWindow {
  if (input.from && input.to) {
    const since = new Date(`${input.from}T00:00:00.000Z`);
    const until = new Date(new Date(`${input.to}T00:00:00.000Z`).getTime() + DAY);
    return { since, until, fromDay: input.from, toDay: input.to };
  }
  const days = input.days ?? 30;
  const today = startOfUtcDay(now);
  const since = new Date(today.getTime() - (days - 1) * DAY);
  const until = new Date(today.getTime() + DAY);
  return { since, until, fromDay: isoDay(since), toDay: isoDay(today) };
}

export const reportService = {
  /** Every workspace this caller holds `reports.read` in. A super admin holds it everywhere. */
  async allowedWorkspaces(identity: Identity | undefined): Promise<ReportWorkspace[]> {
    const all = await workspaceRepo.list();
    const cache = new PlatformRoleCache();
    const checked = await Promise.all(
      all.map(async (w) => {
        const eff = await effectivePermissionsService.forWorkspace(identity, w.id, cache);
        return (eff.permissions as readonly string[]).includes("reports.read") ? { id: w.id, name: w.name } : null;
      }),
    );
    return checked.filter((w): w is ReportWorkspace => w !== null).sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * What the caller asked for, narrowed to what they may see. Nothing asked for means everything they may see.
   * Naming a workspace outside that set is a refusal, not a silent drop: a forged id must not look like an empty one.
   */
  resolve(
    allowed: readonly ReportWorkspace[],
    requested: readonly string[],
  ): { ok: true; workspaces: ReportWorkspace[] } | { ok: false; reason: "none_allowed" | "not_allowed" } {
    if (!allowed.length) return { ok: false, reason: "none_allowed" };
    if (!requested.length) return { ok: true, workspaces: [...allowed] };
    const byId = new Map(allowed.map((w) => [w.id, w]));
    const picked: ReportWorkspace[] = [];
    for (const id of requested) {
      const w = byId.get(id);
      if (!w) return { ok: false, reason: "not_allowed" };
      picked.push(w);
    }
    return { ok: true, workspaces: picked };
  },

  /** One row per run, newest first, for the workspaces already resolved. */
  async runs(workspaceIds: readonly string[], window: ReportWindow, names: ReadonlyMap<string, string>): Promise<ReportRun[]> {
    if (!workspaceIds.length) return [];
    const runKey = sql<string>`coalesce(${usageEvents.executionId}::text, ${usageEvents.sessionId}, ${usageEvents.id}::text)`;
    const where: SQL[] = [
      inArray(usageEvents.workspaceId, [...workspaceIds]),
      gte(usageEvents.at, window.since),
      lt(usageEvents.at, window.until),
    ];

    const rows = await db
      .select({
        workspaceId: usageEvents.workspaceId,
        key: runKey,
        flowId: sql<string | null>`max(${usageEvents.flowId}::text)`,
        flowName: sql<string | null>`coalesce(max(${flows.name}), max(${usageEvents.flowName}))`,
        subject: sql<string | null>`max(${usageEvents.subject})`,
        actor: sql<string | null>`max(${usageEvents.actor})`,
        purpose: sql<string>`max(${usageEvents.purpose})`,
        status: sql<string | null>`max(${flowExecutions.status})`,
        at: sql<string>`min(${usageEvents.at})`,
        tokensIn: sql<string>`coalesce(sum(${usageEvents.tokensIn}), 0)`,
        tokensOut: sql<string>`coalesce(sum(${usageEvents.tokensOut}), 0)`,
        cost: sql<string>`coalesce(sum(${costOf()}), 0)`,
      })
      .from(usageEvents)
      .leftJoin(flows, eq(flows.id, usageEvents.flowId))
      .leftJoin(flowExecutions, eq(flowExecutions.id, usageEvents.executionId))
      .where(and(...where))
      .groupBy(usageEvents.workspaceId, runKey)
      .orderBy(desc(sql`min(${usageEvents.at})`));

    return rows.map((r) => {
      const purpose = (["building", "test", "live"].includes(r.purpose) ? r.purpose : "live") as ReportPurpose;
      const tokensIn = n(r.tokensIn);
      const tokensOut = n(r.tokensOut);
      return {
        key: r.key,
        workspaceId: r.workspaceId,
        workspaceName: names.get(r.workspaceId) ?? "Unknown workspace",
        flowId: r.flowId,
        flowName: r.flowName ?? "Unsaved build",
        subject: r.subject,
        person: r.actor || r.subject || "Unknown",
        purpose,
        status: r.status ?? "session",
        at: new Date(r.at).toISOString(),
        tokensIn,
        tokensOut,
        tokens: tokensIn + tokensOut,
        costUsd: n(r.cost),
      };
    });
  },
};

// ── aggregation (pure) ────────────────────────────────────────────────────────

/** Narrow runs to the drill the person has made. Never widens: it only ever removes rows. */
export function applyDrill(runs: readonly ReportRun[], drill: ReportDrill): ReportRun[] {
  const ws = drill.workspaceIds?.length ? new Set(drill.workspaceIds) : null;
  return runs.filter(
    (r) =>
      (!ws || ws.has(r.workspaceId)) &&
      (!drill.flowId || (drill.flowId === NO_FLOW ? r.flowId === null : r.flowId === drill.flowId)) &&
      (!drill.subject || r.subject === drill.subject),
  );
}

const distinct = <T>(rows: readonly ReportRun[], pick: (r: ReportRun) => T) => new Set(rows.map(pick)).size;

function groupBy(
  runs: readonly ReportRun[],
  idOf: (r: ReportRun) => string | null,
  nameOf: (r: ReportRun) => string,
  extra?: (r: ReportRun) => Partial<ReportGroup>,
): ReportGroup[] {
  const m = new Map<string, ReportRun[]>();
  for (const r of runs) {
    const k = idOf(r) ?? "\u0000none";
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  const total = runs.reduce((a, r) => a + r.costUsd, 0) || 1;
  const groups: ReportGroup[] = [];
  for (const rs of m.values()) {
    const costUsd = rs.reduce((a, r) => a + r.costUsd, 0);
    groups.push({
      id: idOf(rs[0]),
      name: nameOf(rs[0]),
      ...(extra ? extra(rs[0]) : {}),
      costUsd,
      tokens: rs.reduce((a, r) => a + r.tokens, 0),
      runs: rs.length,
      workflows: distinct(rs, (r) => r.flowId ?? NO_FLOW),
      people: distinct(rs, (r) => r.subject ?? r.person),
      workspaces: distinct(rs, (r) => r.workspaceId),
      share: costUsd / total,
    });
  }
  return groups.sort((a, b) => b.costUsd - a.costUsd);
}

export function summarise(runs: readonly ReportRun[], window: ReportWindow): ReportSummary {
  const costUsd = runs.reduce((a, r) => a + r.costUsd, 0);

  // Every day in the window appears, so a quiet day is a zero bar and not a gap.
  const days: ReportSummary["byDay"] = [];
  const index = new Map<string, number>();
  for (let t = window.since.getTime(); t < window.until.getTime(); t += DAY) {
    const day = isoDay(new Date(t));
    index.set(day, days.length);
    days.push({ day, costUsd: 0, live: 0, test: 0, building: 0 });
  }
  for (const r of runs) {
    const i = index.get(r.at.slice(0, 10));
    if (i === undefined) continue;
    days[i].costUsd += r.costUsd;
    days[i][r.purpose] += r.costUsd;
  }

  const outcomes: ReportOutcome[] = ["succeeded", "failed", "stopped"];
  const byOutcome = outcomes.map((outcome) => {
    const rs = runs.filter((r) => outcomeOf(r.status) === outcome);
    return { outcome, costUsd: rs.reduce((a, r) => a + r.costUsd, 0), runs: rs.length };
  });

  const purposes: ReportPurpose[] = ["live", "test", "building"];
  return {
    window: { fromDay: window.fromDay, toDay: window.toDay },
    tiles: {
      costUsd,
      tokens: runs.reduce((a, r) => a + r.tokens, 0),
      runs: runs.length,
      workspaces: distinct(runs, (r) => r.workspaceId),
      workflows: distinct(runs, (r) => r.flowId ?? NO_FLOW),
      people: distinct(runs, (r) => r.subject ?? r.person),
    },
    byDay: days,
    byPurpose: purposes.map((purpose) => {
      const rs = runs.filter((r) => r.purpose === purpose);
      return { purpose, costUsd: rs.reduce((a, r) => a + r.costUsd, 0), runs: rs.length };
    }),
    byOutcome,
    withoutOutcome: runs.filter((r) => outcomeOf(r.status) === null).length,
    lenses: {
      workspaces: groupBy(runs, (r) => r.workspaceId, (r) => r.workspaceName),
      workflows: groupBy(runs, (r) => r.flowId ?? NO_FLOW, (r) => r.flowName, (r) => ({
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
      })),
      people: groupBy(runs, (r) => r.subject ?? `name:${r.person}`, (r) => r.person),
    },
  };
}

export const RUN_SORTS = ["at", "cost", "tokens", "workflow", "workspace", "person", "status"] as const;
export type RunSort = (typeof RUN_SORTS)[number];

/** One page of runs, sorted. The total is the whole set so the screen can say "50 of 412". */
export function pageOfRuns(
  runs: readonly ReportRun[],
  opts: { sort: RunSort; dir: "asc" | "desc"; offset: number; limit: number },
): { total: number; rows: ReportRun[] } {
  const pick: Record<RunSort, (r: ReportRun) => string | number> = {
    at: (r) => r.at,
    cost: (r) => r.costUsd,
    tokens: (r) => r.tokens,
    workflow: (r) => r.flowName.toLowerCase(),
    workspace: (r) => r.workspaceName.toLowerCase(),
    person: (r) => r.person.toLowerCase(),
    status: (r) => r.status,
  };
  const f = pick[opts.sort];
  const sign = opts.dir === "asc" ? 1 : -1;
  const sorted = [...runs].sort((a, b) => {
    const x = f(a);
    const y = f(b);
    return (x > y ? 1 : x < y ? -1 : 0) * sign || (a.at < b.at ? 1 : -1);
  });
  return { total: sorted.length, rows: sorted.slice(opts.offset, opts.offset + opts.limit) };
}
