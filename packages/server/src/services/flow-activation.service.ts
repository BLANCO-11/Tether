/**
 * "Turn on for me" (sharing-boundaries phase 3, D4). A workflow shared with the workspace whose Runs as is EACH PERSON's
 * own account has no single schedule — there is nobody for a schedule to act as. Each member who turns it on gets their
 * own: their runs start on its schedule (or one they set), act as them (`connectionForRun`), and are theirs to see.
 *
 * ⚠ It runs the APPROVED revision they confirmed, never a newer one: when a reviewer approves a change, every person's
 * copy pauses (derived — `confirmedRevision` < the workflow's approved revision — never a written flag) and they are
 * told, until they look again. No second approval: the workflow's approval covers it; each person confirms their own
 * account (Q2).
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowActivations, flows } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { notificationService } from "./notification.service.js";
import { runsAsEachPerson, type PiRunAs } from "./run-as.service.js";

export type FlowActivation = typeof flowActivations.$inferSelect;
type FlowRow = NonNullable<Awaited<ReturnType<typeof flowRepo.get>>>;

/** What a person sees about turning a workflow on for themselves. */
export type ActivationView = {
  /** Whether this workflow can be turned on for a person at all; `reason` says why not. */
  available: boolean;
  reason: string | null;
  /** Turned on by this person. */
  on: boolean;
  /** Turned on, but not running: the approved version changed since they confirmed it. */
  paused: string | null;
  /** The workflow's own schedule, and this person's, when they set one. */
  schedule: { cron: string; timezone: string } | null;
  mine: { cron: string; timezone: string } | null;
};

type Refusal = Error & { statusCode: number };
const refusal = (message: string, statusCode = 409): Refusal => Object.assign(new Error(message), { statusCode });

async function approvedModel(flow: FlowRow): Promise<{ accounts?: Record<string, PiRunAs>; workflow?: { schedule?: { cron?: string; timezone?: string } } } | null> {
  if (flow.armedRevision == null) return null;
  const row = await flowRepo.getRevision(flow.id, flow.armedRevision);
  return (row?.modelJson as never) ?? null;
}

/** Why this workflow cannot be turned on for a person, or null when it can. */
async function unavailable(flow: FlowRow): Promise<string | null> {
  if (flow.runtime !== "foundry") return "Only a workflow built with Forge can be turned on for you.";
  if (flow.visibility !== "public" && !flow.projectId) return "Only a workflow shared with the workspace or a project can be turned on for you.";
  const model = await approvedModel(flow);
  if (!model) return "It is not approved yet. Once a reviewer approves it, you can turn it on for you.";
  if (!runsAsEachPerson(model.accounts)) return "It does not run on each person's own account, so it has one schedule, which its owner switches on.";
  return null;
}

const scheduleOf = (m: Awaited<ReturnType<typeof approvedModel>>) =>
  m?.workflow?.schedule?.cron ? { cron: m.workflow.schedule.cron, timezone: m.workflow.schedule.timezone ?? "UTC" } : null;

export const flowActivationService = {
  async view(workspaceId: string, flowId: string, subject: string | null): Promise<ActivationView | null> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return null;
    const reason = await unavailable(flow);
    const model = await approvedModel(flow);
    const row = subject
      ? (await db.select().from(flowActivations).where(and(eq(flowActivations.flowId, flowId), eq(flowActivations.subject, subject))))[0]
      : undefined;
    const paused = row && flow.armedRevision != null && row.confirmedRevision < flow.armedRevision
      ? "It changed since you turned it on. Look at what changed, then turn it on again."
      : row && reason
        ? reason
        : null;
    return {
      available: reason == null,
      reason,
      on: !!row,
      paused,
      schedule: scheduleOf(model),
      mine: row?.cron ? { cron: row.cron, timezone: row.timezone ?? "UTC" } : null,
    };
  },

  /**
   * Turn it on (or keep it on, confirming the current approved version) or off, for the person asking. On needs a
   * schedule: theirs, or the workflow's.
   */
  async set(
    workspaceId: string,
    flowId: string,
    who: { subject: string; actor: string },
    want: { on: boolean; cron?: string | null; timezone?: string | null },
  ): Promise<ActivationView> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw refusal("Not found.", 404);
    if (!want.on) {
      await db.delete(flowActivations).where(and(eq(flowActivations.flowId, flowId), eq(flowActivations.subject, who.subject)));
      return (await this.view(workspaceId, flowId, who.subject))!;
    }
    const reason = await unavailable(flow);
    if (reason) throw refusal(reason);
    // What it needs from THIS person (their own account, which of theirs) is said before it is on, not at 09:00.
    const { readinessOf, needsSentence } = await import("./readiness.service.js");
    const ready = await readinessOf(workspaceId, flowId, { person: who.subject });
    if (ready && !ready.ready) throw Object.assign(refusal(`Not turned on: ${needsSentence(ready)}`), { needs: ready.needs });
    const cron = want.cron?.trim() || null;
    const timezone = want.timezone?.trim() || null;
    if (!cron && !scheduleOf(await approvedModel(flow))) {
      throw refusal("It has no schedule of its own. Set when it should run for you.", 400);
    }
    if (cron) {
      const { cronMatches } = await import("./cron.js");
      try {
        cronMatches(cron, new Date(), timezone ?? "UTC");
      } catch (e) {
        throw refusal(`That schedule cannot be read: ${(e as Error).message}`, 400);
      }
    }
    const values = { confirmedRevision: flow.armedRevision!, cron, timezone, actor: who.actor, updatedAt: new Date() };
    await db
      .insert(flowActivations)
      .values({ workspaceId, flowId, subject: who.subject, ...values })
      .onConflictDoUpdate({ target: [flowActivations.flowId, flowActivations.subject], set: values });
    return (await this.view(workspaceId, flowId, who.subject))!;
  },

  /**
   * Every person's copy that may run now: on the workflow's CURRENT approved revision, the workflow still shared and
   * still running on each person's own account. For the schedule tick.
   */
  async running(): Promise<Array<FlowActivation & { flowName: string; schedule: { cron: string; timezone: string } | null }>> {
    const rows = await db
      .select({ a: flowActivations, f: flows })
      .from(flowActivations)
      .innerJoin(flows, eq(flowActivations.flowId, flows.id))
      .where(isNotNull(flows.armedRevision));
    const out: Array<FlowActivation & { flowName: string; schedule: { cron: string; timezone: string } | null }> = [];
    for (const { a, f } of rows) {
      if (a.confirmedRevision !== f.armedRevision || (await unavailable(f))) continue;
      out.push({ ...a, flowName: f.name, schedule: scheduleOf(await approvedModel(f)) });
    }
    return out;
  },

  /** A newer version was approved: everyone who turned it on is told their copy is paused until they look again. */
  async noteApproved(workspaceId: string, flowId: string, revision: number, flowName: string): Promise<void> {
    const behind = await db
      .select()
      .from(flowActivations)
      .where(and(eq(flowActivations.flowId, flowId), lt(flowActivations.confirmedRevision, revision)));
    for (const a of behind) {
      await notificationService.add({
        workspaceId,
        subject: a.subject,
        kind: "activation_paused",
        title: `"${flowName}" changed`,
        body: "A new version was approved, so it stopped running for you. Look at what changed, then turn it on again.",
        href: `/flows/${flowId}`,
      });
    }
  },
};
