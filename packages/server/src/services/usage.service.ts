/**
 * Observability (pi-runtime P-OBS, 2026-10-10): what was used, by whom, for which workflow, at what cost.
 *
 * Recorded at the few places usage happens, never reconstructed:
 *   - building: every model reply in a Forge conversation (Pi reports tokens and cost — measured equal to the
 *     gateway's own `x-litellm-response-cost`), and the compiled builder's inference calls;
 *   - test / live: every tool call and read a run's steps make through the step API, and `llm_complete`.
 * Run outcomes are not stored here — `flow_executions` already holds them, and a second copy would drift.
 *
 * Recording never fails what it records: a lost usage row is a gap in a chart, a thrown one is a broken run.
 *
 * Who may see what (rbac-observability, 2026-10-15 — replaces PO-D1/PO-D2): EVERYBODY sees cost, for what they may
 * see. A member sees their own usage and cost and the runs they may see; an Admin (`content.read.others`) sees every
 * person's. The caller passes the two filters (`contentVisibility.usageWhere` / `runsWhere`); this module never
 * decides who somebody is. Cost is `costOf()` — the price set on the model settings page when there is one, else the
 * cost the producer reported. Building cost is counted, labelled "building", and attributed to the person and the
 * workflow.
 */
import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flows, usageEvents, workspaces } from "../db/schema.js";
import { costOf } from "./model-pricing.service.js";

export type UsagePurpose = "building" | "test" | "live";
export type UsageKind = "llm" | "tool" | "read";

export type UsageRecord = {
  workspaceId: string;
  purpose: UsagePurpose;
  kind: UsageKind;
  source: string;
  subject?: string | null;
  actor?: string | null;
  flowId?: string | null;
  flowName?: string | null;
  sessionId?: string | null;
  executionId?: string | null;
  stepId?: string | null;
  model?: string | null;
  tool?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensCached?: number | null;
  tokensCacheWrite?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  ok?: boolean;
};

const int = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

export const usageService = {
  /** Record one use. Fire-and-forget: never awaited by a run, never throws. */
  record(r: UsageRecord): void {
    void db
      .insert(usageEvents)
      .values({
        workspaceId: r.workspaceId,
        purpose: r.purpose,
        kind: r.kind,
        source: r.source,
        subject: r.subject ?? null,
        actor: r.actor ?? null,
        flowId: r.flowId ?? null,
        flowName: r.flowName ?? null,
        sessionId: r.sessionId ?? null,
        executionId: r.executionId ?? null,
        stepId: r.stepId ?? null,
        model: r.model ?? null,
        tool: r.tool ?? null,
        tokensIn: int(r.tokensIn),
        tokensOut: int(r.tokensOut),
        tokensCached: int(r.tokensCached),
        tokensCacheWrite: int(r.tokensCacheWrite),
        costUsd: typeof r.costUsd === "number" && Number.isFinite(r.costUsd) ? r.costUsd.toFixed(8) : null,
        durationMs: int(r.durationMs),
        ok: r.ok ?? true,
      })
      .catch((e) => console.warn(`[usage] not recorded (${r.source}/${r.kind}): ${(e as Error).message}`));
  },

  /** A conversation that had no workflow yet gets one (first save): its building cost moves onto the workflow. */
  async attachSession(sessionId: string, flowId: string, flowName: string | null): Promise<void> {
    await db
      .update(usageEvents)
      .set({ flowId, flowName })
      .where(and(eq(usageEvents.sessionId, sessionId), isNull(usageEvents.flowId)))
      .catch((e) => console.warn(`[usage] could not attach session ${sessionId}: ${(e as Error).message}`));
  },

  /**
   * The workspace's (or, with `workspaceId` null, the whole deployment's) usage over the last `days`, limited to the
   * usage and runs the caller may see (`usageWhere` / `runsWhere`, from `contentVisibility`; absent = everything).
   * `scope` says which it is, so the screen can label "your usage" apart from "everyone's".
   */
  async summary(
    workspaceId: string | null,
    opts: { days: number; usageWhere?: SQL; runsWhere?: SQL; scope: "mine" | "workspace" | "deployment" },
  ) {
    const since = new Date(Date.now() - opts.days * 86_400_000);
    const ws = workspaceId ? [eq(usageEvents.workspaceId, workspaceId)] : [];
    const wsRuns = workspaceId ? [eq(flowExecutions.workspaceId, workspaceId)] : [];
    const inWindow = and(...ws, gte(usageEvents.at, since), opts.usageWhere);
    const cost = sql<string>`coalesce(sum(${costOf()}), 0)`;
    const tokensIn = sql<string>`coalesce(sum(${usageEvents.tokensIn}), 0)`;
    const tokensOut = sql<string>`coalesce(sum(${usageEvents.tokensOut}), 0)`;
    const n = (v: unknown) => Number(v ?? 0);

    const byPurpose = await db
      .select({ purpose: usageEvents.purpose, cost, tokensIn, tokensOut, calls: sql<string>`count(*) filter (where ${usageEvents.kind} = 'llm')` })
      .from(usageEvents)
      .where(inWindow)
      .groupBy(usageEvents.purpose);

    const day = sql<string>`to_char(date_trunc('day', ${usageEvents.at}), 'YYYY-MM-DD')`;
    const byDay = await db
      .select({ day, purpose: usageEvents.purpose, cost, tokens: sql<string>`coalesce(sum(${usageEvents.tokensIn}), 0) + coalesce(sum(${usageEvents.tokensOut}), 0)` })
      .from(usageEvents)
      .where(inWindow)
      .groupBy(day, usageEvents.purpose)
      .orderBy(day);

    // The workflow's name from the workflow (rows a run records carry none), or the name it had when recorded.
    const byFlow = await db
      .select({
        flowId: usageEvents.flowId,
        flowName: sql<string>`coalesce(max(${flows.name}), max(${usageEvents.flowName}))`,
        purpose: usageEvents.purpose,
        cost,
        tokensIn,
        tokensOut,
      })
      .from(usageEvents)
      .leftJoin(flows, eq(flows.id, usageEvents.flowId))
      .where(inWindow)
      .groupBy(usageEvents.flowId, usageEvents.purpose);

    // Everything a person caused — building, testing and running — not building alone: a member's own cost is the
    // whole of what they spent. Grouped by subject so one person under two display names is one row.
    const byPerson = await db
      .select({ subject: usageEvents.subject, actor: sql<string>`max(${usageEvents.actor})`, cost, tokensIn, tokensOut })
      .from(usageEvents)
      .where(inWindow)
      .groupBy(usageEvents.subject)
      .orderBy(desc(cost));

    // The deployment view (platform): cost per workspace.
    const byWorkspace = workspaceId
      ? []
      : await db
          .select({ workspaceId: usageEvents.workspaceId, name: sql<string>`max(${workspaces.name})`, cost, tokensIn, tokensOut })
          .from(usageEvents)
          .leftJoin(workspaces, eq(workspaces.id, usageEvents.workspaceId))
          .where(inWindow)
          .groupBy(usageEvents.workspaceId)
          .orderBy(desc(cost));

    const byModel = await db
      .select({ model: usageEvents.model, cost, tokensIn, tokensOut, calls: sql<string>`count(*)` })
      .from(usageEvents)
      .where(and(inWindow, eq(usageEvents.kind, "llm")))
      .groupBy(usageEvents.model)
      .orderBy(desc(cost));

    const tools = await db
      .select({
        tool: usageEvents.tool,
        kind: usageEvents.kind,
        calls: sql<string>`count(*)`,
        failed: sql<string>`count(*) filter (where not ${usageEvents.ok})`,
        avgMs: sql<string>`coalesce(avg(${usageEvents.durationMs}), 0)`,
      })
      .from(usageEvents)
      .where(and(inWindow, inArray(usageEvents.kind, ["tool", "read"])))
      .groupBy(usageEvents.tool, usageEvents.kind)
      .orderBy(desc(sql`count(*)`));

    // Run health, from the runs themselves. A run still going or waiting is not a failure (D-14): rates divide by
    // runs that SETTLED.
    const runRows = await db
      .select({
        status: flowExecutions.status,
        live: sql<boolean>`${flowExecutions.kestraNamespace} not like '%.draft'`,
        auto: flowExecutions.autoTest,
        count: sql<string>`count(*)`,
      })
      .from(flowExecutions)
      .where(and(...wsRuns, gte(flowExecutions.startedAt, since), opts.runsWhere))
      .groupBy(flowExecutions.status, sql`${flowExecutions.kestraNamespace} not like '%.draft'`, flowExecutions.autoTest);
    const runs = { live: emptyRuns(), test: emptyRuns() };
    for (const r of runRows) {
      const bucket = r.live ? runs.live : runs.test;
      bucket.byStatus[r.status] = (bucket.byStatus[r.status] ?? 0) + n(r.count);
    }
    for (const b of [runs.live, runs.test]) finishRuns(b);

    const runDay = sql<string>`to_char(date_trunc('day', ${flowExecutions.startedAt}), 'YYYY-MM-DD')`;
    const runsByDay = await db
      .select({ day: runDay, status: flowExecutions.status, count: sql<string>`count(*)` })
      .from(flowExecutions)
      .where(and(...wsRuns, gte(flowExecutions.startedAt, since), opts.runsWhere))
      .groupBy(runDay, flowExecutions.status)
      .orderBy(runDay);

    const runsByFlow = await db
      .select({
        flowId: flowExecutions.flowId,
        name: sql<string>`max(coalesce(${flowExecutions.flowNameSnapshot}, ${flows.name}))`,
        total: sql<string>`count(*)`,
        succeeded: sql<string>`count(*) filter (where ${flowExecutions.status} = 'succeeded')`,
        failed: sql<string>`count(*) filter (where ${flowExecutions.status} = 'failed')`,
        partial: sql<string>`count(*) filter (where ${flowExecutions.status} = 'partial')`,
      })
      .from(flowExecutions)
      .leftJoin(flows, eq(flows.id, flowExecutions.flowId))
      .where(and(...wsRuns, gte(flowExecutions.startedAt, since), opts.runsWhere))
      .groupBy(flowExecutions.flowId)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    const money = <T extends object>(row: T, c: unknown) => ({ ...row, costUsd: n(c) });
    return {
      days: opts.days,
      since: since.toISOString(),
      scope: opts.scope,
      costVisible: true,
      costUsd: byPurpose.reduce((a, r) => a + n(r.cost), 0),
      byPurpose: byPurpose.map((r) => money({ purpose: r.purpose, tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut), modelCalls: n(r.calls) }, r.cost)),
      byDay: byDay.map((r) => money({ day: r.day, purpose: r.purpose, tokens: n(r.tokens) }, r.cost)),
      byFlow: byFlow.map((r) => money({ flowId: r.flowId, flowName: r.flowName, purpose: r.purpose, tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut) }, r.cost)),
      byPerson: byPerson.map((r) => money({ subject: r.subject, actor: r.actor, tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut) }, r.cost)),
      byWorkspace: byWorkspace.map((r) => money({ workspaceId: r.workspaceId, name: r.name, tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut) }, r.cost)),
      byModel: byModel.map((r) => money({ model: r.model, calls: n(r.calls), tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut) }, r.cost)),
      tools: tools.map((r) => ({ tool: r.tool, kind: r.kind, calls: n(r.calls), failed: n(r.failed), avgMs: Math.round(n(r.avgMs)) })),
      runs,
      runsByDay: runsByDay.map((r) => ({ day: r.day, status: r.status, count: n(r.count) })),
      runsByFlow: runsByFlow.map((r) => ({
        flowId: r.flowId,
        name: r.name,
        total: n(r.total),
        succeeded: n(r.succeeded),
        failed: n(r.failed),
        partial: n(r.partial),
      })),
    };
  },
};

type RunBucket = { byStatus: Record<string, number>; total: number; settled: number; succeeded: number; failed: number; successRate: number | null };
function emptyRuns(): RunBucket {
  return { byStatus: {}, total: 0, settled: 0, succeeded: 0, failed: 0, successRate: null };
}
/** Settled = ended one way or another. Waiting and running are neither success nor failure (D-14). */
function finishRuns(b: RunBucket): void {
  const s = b.byStatus;
  b.total = Object.values(s).reduce((a, x) => a + x, 0);
  b.succeeded = s.succeeded ?? 0;
  b.failed = (s.failed ?? 0) + (s.partial ?? 0);
  b.settled = b.total - (s.running ?? 0) - (s.waiting ?? 0);
  b.successRate = b.settled ? b.succeeded / b.settled : null;
}
