/**
 * The run list as History and the dashboard read it (2026-10-11): ONE request, not one per run.
 *
 * Both pages fetched the list and then every run's full detail — inputs, outputs and logs of every step — to print
 * one line per run ("stopped at `notify`", "7 steps completed"). 67 runs were 68 requests through the web proxy, and a
 * browser runs ~6 at a time per site (fewer while builder tabs hold their live connections), so the page queued in
 * waves. Each run on a page now carries its steps in a LIGHT form — id, status, attempt, error, loop counts; never
 * inputs, outputs or logs — read for the whole page in one query. A run's full detail is still one click away.
 *
 * A Kestra run carries no steps here (its steps live in the engine, one call per run); the client fetches those few
 * in full, as before.
 */
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flowRevisions, platformUsers, triggerFires, triggers } from "../db/schema.js";
import type { FlowExecution } from "../repositories/flow-execution.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { runnerStepResultRepo } from "../repositories/runner-step-result.repo.js";
import { RUNNER_EXECUTION_PREFIX } from "./flow-runner.service.js";
import { runnerEngineStatus, runnerSteps } from "./flow-visibility-runner.js";
import { engineStates, executionBase, type StepStatus, type StepView } from "./flow-visibility.service.js";
import { healthOf, windowOf, type HealthRange, type RunOutcome } from "./runs-health.js";

/** What a list row needs of a step. `items` is kept only as a marker (a loop), never its per-item records. */
export type LightStep = Pick<StepView, "stepId" | "status" | "attempt" | "durationMs" | "startedAt" | "endedAt" | "responseCode"> & {
  outcome?: string;
  error: string | null;
  items?: [];
  perItem?: StepView["perItem"];
  loop?: string;
};

const ERROR_CHARS = 400;

export function lightStep(s: StepView): LightStep {
  return {
    stepId: s.stepId,
    status: s.status,
    ...(s.outcome ? { outcome: s.outcome } : {}),
    attempt: s.attempt,
    durationMs: s.durationMs,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    responseCode: s.responseCode,
    error: s.error ? (s.error.length > ERROR_CHARS ? `${s.error.slice(0, ERROR_CHARS)}…` : s.error) : null,
    ...(s.items ? { items: [] as [] } : {}),
    ...(s.perItem ? { perItem: s.perItem } : {}),
    ...(s.loop ? { loop: s.loop } : {}),
  };
}

const isRunner = (r: { kestraExecutionId: string }) => r.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX);

/** Rows → list items: the run's summary, its live status, and (runner runs) its light steps. */
async function project(workspaceId: string, rows: FlowExecution[]) {
  const [engine, records] = await Promise.all([
    engineStates(workspaceId, rows, rows.length),
    runnerStepResultRepo.listForExecutions(rows.filter(isRunner).map((r) => r.id)),
  ]);
  const byRun = new Map<string, typeof records>();
  for (const r of records) (byRun.get(r.flowExecutionId) ?? byRun.set(r.flowExecutionId, []).get(r.flowExecutionId)!).push(r);
  return rows.map((r) => {
    const steps = isRunner(r) ? runnerSteps(byRun.get(r.id) ?? []) : null;
    const items = steps ? itemsOf(steps) : null;
    return {
      ...executionBase(r),
      engineStatus: (isRunner(r) ? runnerEngineStatus(r.status) : engine.get(r.kestraExecutionId) ?? null) as StepStatus | null,
      ...(steps ? { steps: steps.map(lightStep) } : {}),
      ...(items ? { items } : {}),
    };
  });
}

/**
 * "6 of 8": the run's first loop — how many of its items succeeded, out of how many it had. Null for a run with no
 * loop (the row shows a dash, never "1 of 1" for a run that had no items).
 */
export function itemsOf(steps: StepView[]): { done: number; total: number } | null {
  const loop = steps.find((s) => Array.isArray(s.items));
  if (!loop?.items) return null;
  return { done: loop.items.filter((i) => i.status === "success").length, total: loop.items.length };
}

/** A run's outcome as the dashboard counts it — `partial` is its own answer (runs-health.ts). */
export function outcomeOfStatus(s: StepStatus | null | undefined): RunOutcome {
  if (s === "success") return "done";
  if (s === "warning") return "partial";
  if (s == null || s === "running" || s === "created" || s === "paused") return "running";
  return "stopped";
}

/**
 * What started a run, in words a row can print: "Schedule · weekdays 09:00", "Kriti Gautam · manual",
 * "Webhook · expenses-in". `cron` is sent raw — the client already turns a cron into words (lib/cron.ts), and a
 * second implementation here would be one that disagrees.
 */
export type StartedBy = {
  kind: "person" | "replay" | "schedule" | "trigger" | "test" | "system" | "unknown";
  label: string;
  detail: string | null;
  cron?: string | null;
};

const TRIGGER_LABEL: Record<string, string> = { webhook: "Webhook", api: "API", manual: "Trigger", poll: "Poll", schedule: "Schedule" };

async function startedByFor(rows: FlowExecution[]): Promise<Map<string, StartedBy>> {
  const subjects = [...new Set(rows.map((r) => r.requestedBySubject).filter((s): s is string => !!s))];
  const fireIds = [...new Set(rows.map((r) => r.triggerFireId).filter((s): s is string => !!s))];
  const scheduled = rows.filter((r) => r.requestedByKind === "schedule" && r.flowId && r.flowRevision != null);
  const [people, fires, revisions] = await Promise.all([
    subjects.length
      ? db.select({ subject: platformUsers.subject, name: platformUsers.name, email: platformUsers.email }).from(platformUsers).where(inArray(platformUsers.subject, subjects))
      : [],
    fireIds.length
      ? db
          .select({ id: triggerFires.id, type: triggers.type, name: triggers.name })
          .from(triggerFires)
          .innerJoin(triggers, eq(triggers.id, triggerFires.triggerId))
          .where(inArray(triggerFires.id, fireIds))
      : [],
    scheduled.length
      ? db
          .select({ flowId: flowRevisions.flowId, revision: flowRevisions.revision, model: flowRevisions.modelJson })
          .from(flowRevisions)
          .where(or(...scheduled.map((r) => and(eq(flowRevisions.flowId, r.flowId!), eq(flowRevisions.revision, r.flowRevision!)))))
      : [],
  ]);
  const person = new Map(people.map((p) => [p.subject, p.name || p.email || null]));
  const fire = new Map(fires.map((f) => [f.id, f]));
  // A Forge workflow keeps its schedule at `workflow.schedule`; a compiled (Kestra-era) model at `schedule`.
  const cronOf = new Map(
    revisions.map((v) => {
      const m = (v.model ?? {}) as { schedule?: { cron?: string }; workflow?: { schedule?: { cron?: string } } };
      return [`${v.flowId}:${v.revision}`, m.workflow?.schedule?.cron ?? m.schedule?.cron ?? null];
    }),
  );
  const out = new Map<string, StartedBy>();
  for (const r of rows) {
    const who = (r.requestedBySubject && person.get(r.requestedBySubject)) || r.requestedBy || "Someone";
    let s: StartedBy;
    switch (r.requestedByKind) {
      case "user":
        s = { kind: "person", label: who, detail: "manual" };
        break;
      case "replay":
        s = { kind: "replay", label: who, detail: "replay" };
        break;
      case "schedule":
        s = { kind: "schedule", label: "Schedule", detail: null, cron: r.flowId ? cronOf.get(`${r.flowId}:${r.flowRevision}`) ?? null : null };
        break;
      case "trigger": {
        const f = r.triggerFireId ? fire.get(r.triggerFireId) : undefined;
        const name = f?.name ?? r.requestedBy?.replace(/^trigger:/, "") ?? null;
        s = { kind: "trigger", label: (f && TRIGGER_LABEL[f.type]) ?? "Trigger", detail: name };
        break;
      }
      case "system":
        s = r.autoTest ? { kind: "test", label: "Forge", detail: "test after a build" } : { kind: "system", label: "System", detail: r.requestedBy && r.requestedBy !== "system" ? r.requestedBy : null };
        break;
      default:
        s = { kind: "unknown", label: "Not recorded", detail: null };
    }
    out.set(r.id, s);
  }
  return out;
}

/** Live runs (published namespace) or test runs (the `.draft` namespace — every one, Forge's own tests included). */
const envWhere = (env: "live" | "test"): SQL =>
  env === "test" ? sql`${flowExecutions.kestraNamespace} like '%.draft'` : sql`${flowExecutions.kestraNamespace} not like '%.draft'`;

export type RunCursor = { at: Date; id: string };
export const encodeCursor = (r: { startedAt: Date | null; id: string }) => `${(r.startedAt ?? new Date(0)).toISOString()}|${r.id}`;
export function decodeCursor(raw: unknown): RunCursor | undefined {
  if (typeof raw !== "string" || !raw.includes("|")) return undefined;
  const [at, id] = raw.split("|");
  const d = new Date(at!);
  return Number.isNaN(d.getTime()) || !/^[0-9a-f-]{36}$/i.test(id!) ? undefined : { at: d, id: id! };
}

export const flowRunList = {
  /** One page, newest first, with the cursor of the next page (null on the last). */
  async page(workspaceId: string, opts: { limit: number; before?: RunCursor; name?: string; from?: Date; q?: string; visible?: SQL }) {
    const rows = await flowExecutionRepo.listPage(workspaceId, opts);
    const more = rows.length > opts.limit;
    const shown = more ? rows.slice(0, opts.limit) : rows;
    return {
      executions: await project(workspaceId, shown),
      next: more ? encodeCursor(shown[shown.length - 1]!) : null,
    };
  },

  /** Every label runs are listed under — the workflow filter's options, over all runs, not one page. */
  labels: (workspaceId: string, visible?: SQL) => flowExecutionRepo.labels(workspaceId, visible),

  /**
   * The dashboard's "Runs and health" (2026-10-23): the figures for one period (runs-health.ts), the last `recent`
   * runs, and every run still going — for live runs or test runs, over what this person may see (`visible`),
   * narrowed to their own when `mine` is given. `dayStart` is the start of the viewer's day (their time zone).
   */
  async summary(
    workspaceId: string,
    opts: { dayStart: Date; recent: number; range: HealthRange; env: "live" | "test"; mine?: SQL; now?: Date; visible?: SQL },
  ) {
    const now = opts.now ?? new Date();
    const where = and(opts.visible, opts.mine, envWhere(opts.env));
    const { prevStart } = windowOf(opts.range, opts.dayStart, now);
    const [rows, latest] = await Promise.all([
      flowExecutionRepo.listSinceOrRunning(workspaceId, prevStart, where),
      flowExecutionRepo.listPage(workspaceId, { limit: opts.recent, visible: where }),
    ]);
    const engine = await engineStates(workspaceId, rows, rows.length);
    const statusOf = (r: FlowExecution) => (isRunner(r) ? runnerEngineStatus(r.status) : engine.get(r.kestraExecutionId) ?? null);
    const health = healthOf(
      opts.range,
      rows.map((r) => ({ label: r.flowNameSnapshot ?? r.kestraFlowId, startedAt: r.startedAt, endedAt: r.endedAt, outcome: outcomeOfStatus(statusOf(r)) })),
      opts.dayStart,
      now,
    );
    const latestShown = latest.slice(0, opts.recent);
    const ids = new Set(latestShown.map((r) => r.id));
    const running = rows.filter((r) => outcomeOfStatus(statusOf(r)) === "running" && !ids.has(r.id));
    const all = [...latestShown, ...running];
    const [listed, startedBy] = await Promise.all([project(workspaceId, all), startedByFor(all)]);
    const withStart = listed.map((e) => ({ ...e, startedBy: startedBy.get(e.id)! }));
    return {
      env: opts.env,
      health,
      recent: withStart.slice(0, latestShown.length),
      running: withStart.filter((e) => outcomeOfStatus(e.engineStatus) === "running"),
    };
  },
};
