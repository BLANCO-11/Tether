/**
 * Whose account a WORKFLOW acts as in each connected service (plugins 8.6, 2026-10-28).
 *
 * A Forge workflow's approved revision records, per service it uses, the connection it runs through — the workspace's,
 * or its OWNER's own ("only for me"). The person chose it (on a card while building, or on the workflow's page); it is
 * never assumed. It lives in the revision (`model.accounts`), not in workflow.json — Forge can edit workflow.json; it
 * cannot edit this — so changing it is a new revision, and a new revision needs approving again.
 *
 * At every call the choice is re-checked, never fallen back from:
 *   - a test run may use a personal connection only of the person who started it;
 *   - a live run, only of the workflow's CURRENT owner — a workflow handed to someone else stops acting as the old
 *     owner, and one whose owner left (8.7 removes their connections) stops acting as them.
 * A choice that no longer holds refuses the call, and turns the workflow off with the reason (`suspendRunningAs`).
 */
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { envForExecution } from "./execution-env.service.js";
import { parsePluginUrl } from "./plugin-connector.service.js";

/**
 * One service's connection, as a revision records it. `each` (sharing-boundaries phase 3): no single connection —
 * every run uses the OWN connection of whoever starts it (`connectionId` is empty, `personal` false).
 */
export type PiRunAs = { connectionId: string; label: string; personal: boolean; service: string; each?: boolean; own?: boolean };

/** The "Each person" choice for one service. */
export const EACH_PERSON = "each";
export const eachPerson = (service: string): PiRunAs => ({ connectionId: "", label: "Each person", personal: false, service, each: true });

/**
 * Where it lives decides whether there is a choice at all (sharing-boundaries Q3): nobody else enters My space, so a
 * workflow there always uses its OWNER's own accounts — no Runs as choice. The choice appears in a project or the
 * Workspace.
 */
export function inMySpace(flow: { visibility: string; projectId?: string | null }): boolean {
  return !flow.projectId && flow.visibility !== "public";
}
/** "Its owner's own account" for one service: resolved per run like Each person, with the owner as the person. */
export const ownersOwn = (service: string): PiRunAs => ({ connectionId: "", label: "Its owner's own account", personal: true, service, own: true });

/**
 * What a revision's services ACTUALLY run as, given where the workflow lives. Outside My space: the stored choices.
 * In My space: one of the owner's own connections already chosen stands; anything else (the workspace's connection,
 * Each person, nothing chosen — left from before it moved here) becomes "its owner's own account". The ONE place this
 * rule lives: the runner, approval, readiness and the self-enable check all read through it.
 */
export async function effectiveAccounts(
  workspaceId: string,
  flow: { visibility: string; projectId?: string | null; ownerSubject?: string | null },
  model: { workflow?: unknown; files?: Record<string, string>; accounts?: Record<string, PiRunAs> },
): Promise<Record<string, PiRunAs> | undefined> {
  if (!inMySpace(flow) || !model.workflow) return model.accounts;
  const { forgeRefsOf } = await import("./pi-flow.service.js");
  const used = await piecesUsed(workspaceId, forgeRefsOf({ runtime: "foundry", workflow: model.workflow, files: model.files ?? {} } as never), flow.ownerSubject ?? null);
  const out: Record<string, PiRunAs> = {};
  for (const piece of used.keys()) {
    const stored = model.accounts?.[piece];
    out[piece] = stored && stored.personal && !stored.each ? stored : ownersOwn(stored?.service ?? piece.replace("@activepieces/piece-", ""));
  }
  return out;
}

/** Does any service act as ONE person's own account (the owner's)? Such a workflow is view-only for everyone else. */
export function actsAsOwner(accounts: Record<string, PiRunAs> | undefined): boolean {
  return Object.values(accounts ?? {}).some((a) => a.personal && !a.each);
}

/** Does any service run on each person's own account? Such a run needs a person behind it. */
export function runsAsEachPerson(accounts: Record<string, PiRunAs> | undefined): boolean {
  return Object.values(accounts ?? {}).some((a) => a.each === true);
}

/**
 * Whose OWN account a run acts as, recorded on the run (`flow_executions.acts_as_subject`): the person who started it
 * when a service runs as each person, the workflow's owner (live) or the starter (test) when one runs as a personal
 * connection, else nobody (only the workspace's connections). Its data is that person's to see (and Admins').
 */
export function actsAsSubjectOf(accounts: Record<string, PiRunAs> | undefined, run: { live: boolean; requester: string | null; owner: string | null }): string | null {
  if (runsAsEachPerson(accounts)) return run.requester;
  if (actsAsOwner(accounts)) return run.live ? run.owner : run.requester;
  return null;
}

type Refusal = Error & { statusCode: number };
const refusal = (message: string, statusCode = 409): Refusal => Object.assign(new Error(message), { statusCode });

/**
 * The connected services a workflow calls: piece → one of its tools (whose own connection is the workspace's). With
 * `subject`, an action that is on only for that person (plans/personal-actions-2026-10-29) counts too — its tool names
 * their own connection, so only their own accounts are offered for it.
 */
export async function piecesUsed(workspaceId: string, toolNames: string[], subject?: string | null): Promise<Map<string, Tool>> {
  const wanted = new Set(toolNames);
  const out = new Map<string, Tool>();
  const all = await toolRepo.listByWorkspace(workspaceId);
  const active = all.filter((t) => t.isActive !== false);
  for (const t of all) {
    if (!wanted.has(t.name)) continue;
    const ref = parsePluginUrl(t.url);
    if (ref && !out.has(ref.piece)) out.set(ref.piece, t);
  }
  if (subject) {
    const { personalTools } = await import("./personal-actions.js");
    for (const t of await personalTools(workspaceId, subject)) {
      if (!wanted.has(t.name) || active.some((w) => w.name === t.name)) continue;
      const ref = parsePluginUrl(t.url);
      if (ref && !out.has(ref.piece)) out.set(ref.piece, t);
    }
  }
  return out;
}

/**
 * Whose run this is, for a connected service: a live run acts for the workflow's CURRENT owner, a test for the person
 * who started it. The environment as every step read decides it (D-52): an unknown one is a draft.
 */
export async function actingSubjectForRun(workspaceId: string, runId: string): Promise<{ subject: string | null; live: boolean }> {
  const ex = await flowExecutionRepo.get(runId);
  if (!ex) return { subject: null, live: false };
  const live = (await envForExecution(runId)) === "live";
  const subject = live ? (ex.flowId ? ((await flowRepo.get(workspaceId, ex.flowId))?.ownerSubject ?? null) : null) : (ex.requestedBySubject ?? null);
  return { subject, live };
}

/** Why this connection cannot be what a run for `subject` acts as, or null when it can. */
function problemWith(conn: PluginConnection | undefined, choice: PiRunAs, piece: string, subject: string | null | undefined, who: string): string | null {
  if (!conn || conn.piece !== piece) return `its ${choice.service} connection “${choice.label}” no longer exists`;
  if (conn.ownerSubject && conn.ownerSubject !== subject) return `it runs as “${choice.label}”, a personal ${choice.service} connection that is not ${who}'s`;
  return null;
}

/**
 * What a revision's choices fail on for its owner — empty when every one holds. Approving, turning on again and a live
 * start all refuse on any of these.
 */
export async function runAsProblems(workspaceId: string, accounts: Record<string, PiRunAs> | undefined, ownerSubject: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const [piece, choice] of Object.entries(accounts ?? {})) {
    // Each person: nothing of the owner's to check — each run checks its own person's connection (`connectionForRun`).
    if (choice.each) continue;
    if (choice.own) {
      const p = await ownAccountProblem(workspaceId, piece, choice.service, ownerSubject);
      if (p) out.push(p);
      continue;
    }
    const conn = await pluginRepo.getConnection(workspaceId, choice.connectionId);
    const p = problemWith(conn, choice, piece, ownerSubject, "the workflow's owner");
    if (p) out.push(p);
  }
  return out;
}

/** Why "its owner's own account" cannot be resolved for this owner, or null: one of theirs, or the one they chose. */
async function ownAccountProblem(workspaceId: string, piece: string, service: string, ownerSubject: string | null): Promise<string | null> {
  if (!ownerSubject) return `it has no owner whose own ${service} account it could use`;
  const mine = (await pluginRepo.listConnections(workspaceId, piece, ownerSubject)).filter((c) => c.ownerSubject === ownerSubject);
  if (!mine.length) return `its owner has not connected their own ${service} account`;
  if (mine.length > 1) {
    const { chosenAccount } = await import("./readiness.service.js");
    if (!(await chosenAccount(workspaceId, ownerSubject, piece, mine))) return `its owner has ${mine.length} ${service} accounts of their own and has not chosen which its runs use`;
  }
  return null;
}

/**
 * The connection a run's call to `tool` goes through, and for whom — read from the run's own record, re-checked now.
 * No choice recorded for the service ⇒ the tool's own (the workspace's) connection, for nobody in particular.
 */
export async function connectionForRun(
  workspaceId: string,
  runId: string,
  tool: Tool,
): Promise<{ secretName?: string; actingSubject?: string | null; label?: string }> {
  const ref = parsePluginUrl(tool.url);
  if (!ref) return {};
  const ex = await flowExecutionRepo.get(runId);
  const choice = ((ex?.runnerJob as { runAs?: Record<string, PiRunAs> } | null)?.runAs ?? {})[ref.piece];
  if (!ex || !choice) return {};
  if (choice.each || choice.own) {
    // ⚠ Each person: the connection of whoever STARTED this run — never the owner's, never the workspace's.
    // Its owner's own (My space, Q3): the owner's for a live run, the tester's for a test — never the workspace's.
    const who = choice.own ? (await actingSubjectForRun(workspaceId, runId)).subject : (ex.requestedBySubject ?? null);
    if (!who) {
      throw refusal(
        choice.own
          ? `This run cannot call ${choice.service}: it is in My space, so it runs on its owner's own ${choice.service} account, and it has no owner. Nothing was sent.`
          : `This run cannot call ${choice.service}: the workflow runs on each person's own ${choice.service} account, and nobody started this run. Nothing was sent.`,
      );
    }
    const mine = (await pluginRepo.listConnections(workspaceId, ref.piece, who)).filter((c) => c.ownerSubject === who);
    if (!mine.length) throw refusal(`This run cannot call ${choice.service}: it runs on your own ${choice.service} account, and you have not connected one. Nothing was sent; connect it on the ${choice.service} connector's page ("For me"), then run it again.`);
    // Several of their own: the one they chose (phase 4, P3-I1) — never a guess.
    const { chosenAccount } = await import("./readiness.service.js");
    const use = mine.length === 1 ? mine[0]! : await chosenAccount(workspaceId, who, ref.piece, mine);
    if (!use) throw refusal(`This run cannot call ${choice.service}: you have ${mine.length} ${choice.service} accounts of your own (${mine.map((c) => `“${c.label}”`).join(", ")}) and have not chosen which your runs use. Nothing was sent; choose one on the workflow's page, then run it again.`);
    return { secretName: use.secretName, actingSubject: who, label: use.label };
  }
  const { subject, live } = await actingSubjectForRun(workspaceId, runId);
  const conn = await pluginRepo.getConnection(workspaceId, choice.connectionId);
  const p = problemWith(conn, choice, ref.piece, subject, live ? "the workflow's owner" : "the person who started this test");
  if (p) throw refusal(`This run cannot call ${choice.service}: ${p}. Nothing was sent; choose its connection again on the workflow's page.`);
  return { secretName: conn!.secretName, actingSubject: conn!.ownerSubject ?? null, label: choice.label };
}

/**
 * Turn off every workflow whose APPROVED revision runs as one of these connections — the connection is gone, or its
 * owner no longer is the workflow's. Revoking (never deleting) keeps the record and says why; nothing falls back to
 * another account. Returns the names of the workflows turned off.
 */
export async function suspendRunningAs(workspaceId: string, connectionIds: string[] | ((c: PiRunAs, flow: { ownerSubject: string | null }) => boolean), reason: string, by: string): Promise<string[]> {
  const test = typeof connectionIds === "function" ? connectionIds : (c: PiRunAs) => connectionIds.includes(c.connectionId);
  const off: string[] = [];
  for (const flow of await flowRepo.listByWorkspace(workspaceId)) {
    if (flow.armedRevision == null || flow.runtime !== "foundry") continue;
    const row = await flowRepo.getRevision(flow.id, flow.armedRevision);
    const accounts = (row?.modelJson as { accounts?: Record<string, PiRunAs> } | undefined)?.accounts ?? {};
    if (!Object.values(accounts).some((c) => test(c, flow))) continue;
    const { flowApprovalService } = await import("./flow-approval.service.js");
    await flowApprovalService.revoke(workspaceId, flow.id, { reason, revokedBy: by });
    off.push(flow.name);
  }
  return off;
}

/** One service a workflow uses, as its page shows it: what the draft runs as, what is approved, and what it could be. */
export type RunAsService = {
  piece: string;
  service: string;
  /** The draft's choice (what is saved next and approved next), or null when none is recorded. */
  current: PiRunAs | null;
  /** The approved revision's choice, when the workflow is approved. */
  approved: PiRunAs | null;
  /** What it may run as: the workspace's connection, and — for the workflow's owner only — their own ones. */
  options: PiRunAs[];
};

/**
 * The "Runs as" section of a workflow's page. ⚠ A personal connection is offered only to the workflow's OWNER: nobody
 * may make a workflow act as someone else's account, and another person's connection is never even listed.
 */
export async function runAsView(workspaceId: string, flowId: string, viewerSubject: string | null): Promise<{ services: RunAsService[]; owner: boolean; approved: boolean; shared: boolean; mySpace: boolean }> {
  const { piFlowService, forgeRefsOf } = await import("./pi-flow.service.js");
  const { flow, model } = await piFlowService.load(workspaceId, flowId);
  const armed = flow.armedRevision != null ? await flowRepo.getRevision(flow.id, flow.armedRevision) : null;
  const armedAccounts = (armed ? await effectiveAccounts(workspaceId, flow, armed.modelJson as never) : undefined) ?? {};
  const draftAccounts = (await effectiveAccounts(workspaceId, flow, model)) ?? {};
  const mySpace = inMySpace(flow);
  const owner = !!viewerSubject && flow.ownerSubject === viewerSubject;
  const { connectorPieces } = await import("./plugin-connector.service.js");
  const pieces = await connectorPieces().catch(() => []);
  const services: RunAsService[] = [];
  for (const [piece, tool] of await piecesUsed(workspaceId, forgeRefsOf(model), flow.ownerSubject ?? null)) {
    const service = pieces.find((p) => p.name === piece)?.displayName ?? piece.replace("@activepieces/piece-", "");
    const as = (c: PluginConnection): PiRunAs => ({ connectionId: c.id, label: c.label, personal: c.ownerSubject != null, service });
    const all = await pluginRepo.listConnections(workspaceId, piece, owner ? viewerSubject : null);
    const theTools = all.filter((c) => !c.ownerSubject && c.secretName === tool.secretEnvName);
    const options = [...theTools, ...all.filter((c) => owner && c.ownerSubject === viewerSubject)].map(as);
    // Each person is a choice only once others can run it: nobody else enters My space (sharing-boundaries Q3).
    if (!mySpace) options.push(eachPerson(service));
    // In My space there is nothing to choose: it uses its owner's own account (Q3).
    services.push({ piece, service, current: draftAccounts[piece] ?? null, approved: armedAccounts[piece] ?? null, options: mySpace ? [] : options });
  }
  return { services, owner, approved: flow.armedRevision != null, shared: !mySpace, mySpace };
}

/**
 * Change what a service runs as: a NEW draft revision with the same workflow and the new choice — which needs approving
 * again before a live run acts as it. Only an option the view offers this person is accepted.
 */
export async function setRunAs(
  workspaceId: string,
  flowId: string,
  piece: string,
  connectionId: string,
  viewerSubject: string | null,
  author: Parameters<(typeof import("./pi-flow.service.js"))["piFlowService"]["save"]>[0]["author"],
): Promise<{ revision: number }> {
  const view = await runAsView(workspaceId, flowId, viewerSubject);
  const svc = view.services.find((x) => x.piece === piece);
  if (!svc) throw refusal("This workflow does not use that service.", 404);
  if (view.mySpace) throw refusal(`It is in My space, so it always uses its owner's own ${svc.service} account. Move it to a project or the Workspace to choose another.`, 409);
  const choice = connectionId === EACH_PERSON ? svc.options.find((o) => o.each) : svc.options.find((o) => !o.each && o.connectionId === connectionId);
  if (!choice) {
    if (connectionId === EACH_PERSON) throw refusal(`Share this workflow with the workspace first: each person's own ${svc.service} account is a choice only for a workflow others can run.`, 409);
    throw refusal(`That is not a ${svc.service} connection this workflow can run as${view.owner ? "" : " (only its owner may choose their own account)"}.`, 403);
  }
  const { piFlowService } = await import("./pi-flow.service.js");
  const { flow, model } = await piFlowService.load(workspaceId, flowId);
  const saved = await piFlowService.save({
    workspaceId,
    flowId,
    bundle: { workflow: model.workflow, files: model.files },
    name: flow.name,
    description: null,
    author,
    accounts: { ...(model.accounts ?? {}), [piece]: choice },
  });
  return { revision: saved.revision };
}
