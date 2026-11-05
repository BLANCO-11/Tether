/**
 * The content guard — who may open WHICH automation, chat, run or Forge session (rbac-observability, 2026-10-15).
 *
 * The permission guard answers "may this person use this area of this workspace"; this answers "may they see THIS
 * one". It is spliced at boot by `mountPermissionGuards`, right after the permission guard, onto every route whose
 * path names a piece of content — so a new route with `:flowId` in it is covered the day it is written, with no
 * route file remembering to call anything.
 *
 * The rules live in `content-visibility.service.ts`; this only finds the content a path names and asks.
 *
 *   - Not visible → 404, never 403: a refusal would confirm the thing exists.
 *   - Visible but not the caller's to change → 403. Only the routes whose permission is building or test-running
 *     (`flows.write`, `flows.run`) need ownership; approving, arming, replaying and pinning need only to see it.
 *   - Content the path names but the database does not hold → pass through; the route answers its own 404.
 */
import type { NextFunction, Request, Response } from "express";
import type { WorkspacePermission } from "../auth/permissions.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { contentVisibility, sharedWith, type Viewer } from "../services/content-visibility.service.js";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Permissions whose routes CHANGE an automation, and so need its owner (or an Admin). */
const CHANGES: ReadonlySet<string> = new Set<WorkspacePermission>(["flows.write", "flows.run"]);

/**
 * `flows.write` routes that do NOT change the workflow they name (sharing-boundaries phase 2): duplicating one makes the
 * person's OWN copy, so seeing it is enough — a view-only shared workflow is exactly what somebody duplicates to build
 * on. Matched on the route's own path, so a mount at another prefix cannot widen it.
 */
const READS_THE_NAMED_FLOW = /\/:flowId\/duplicate$/;

/**
 * Running a workflow's APPROVED revision live — now, or on your own schedule ("Turn on for me") — (sharing-boundaries
 * phase 3) changes nothing in it, so a SHARED one is every member's to run who may run workflows — on whose account is the workflow's Runs as, which the page states
 * before Run. A private one stays its owner's (and an Admin's). Matched on the route's own path.
 */
const RUNS_THE_NAMED_FLOW_LIVE = /\/:flowId\/(run|activation)$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Error {
  return Object.assign(new Error("Not found."), { statusCode: 404 });
}
/** A run on another person's own account: it ran, and what it did is theirs. */
function actedAsSomeoneElse(): Error {
  return Object.assign(new Error("This run used another person's own account. Only they and Admins can see what it did."), {
    statusCode: 403,
  });
}
function notYours(): Error {
  return Object.assign(new Error("Only the automation's owner or an Admin can change it."), { statusCode: 403 });
}

/** What kind of content a route path names, if any. */
export type ContentKind = "flow" | "run" | "chat" | "session" | "thread";

export function contentParams(path: string): Array<{ kind: ContentKind; param: string }> {
  const out: Array<{ kind: ContentKind; param: string }> = [];
  if (path.includes(":flowId")) out.push({ kind: "flow", param: "flowId" });
  if (/\/flow-executions\/:id(\/|$)/.test(path)) out.push({ kind: "run", param: "id" });
  if (path.includes(":executionId")) out.push({ kind: "run", param: "executionId" });
  if (path.includes("/pi-builder/chats/:chatId")) out.push({ kind: "chat", param: "chatId" });
  if (path.includes("/pi-builder/sessions/:sessionId")) out.push({ kind: "session", param: "sessionId" });
  if (path.includes(":threadId")) out.push({ kind: "thread", param: "threadId" });
  return out;
}

/**
 * Somebody else's private work, opened ONLY because the caller holds `content.read.others` — an Admin reading a
 * person's chat leaves this behind (rbac-observability). A draft or a test run is a Reviewer's to read too (and the
 * Admin preset includes reviewing), so looking at one is the review the role exists for and is not logged here.
 */
/** `owner` is whom to tell (sharing-boundaries Q1: the owner is SHOWN an Admin's look); `href` is where it opens. */
export type AdminRead = { entity: "chat" | "flow" | "run"; id: string; label: string; owner: string | null; href: string };

/** A chat opens in its workflow's builder when it built one, else on the new-workflow page (the client's `chatHref`). */
export const chatRead = (chat: { id: string; title: string; createdBySubject: string | null; flowId: string | null }): AdminRead => ({
  entity: "chat",
  id: chat.id,
  label: chat.title,
  owner: chat.createdBySubject,
  href: chat.flowId ? `/flows/${chat.flowId}/builder` : `/flows/new?chat=${chat.id}`,
});

/** Would this be visible WITHOUT `content.read.others`? If not, the read is an Admin's look at private work. */
const plain = (v: Viewer): Viewer => ({ ...v, all: false });

async function checkFlow(v: Viewer, ws: string, flowId: string, change: boolean | "live-run", reads: AdminRead[]): Promise<Error | null> {
  if (!UUID_RE.test(flowId)) return null;
  const flow = await flowRepo.get(ws, flowId);
  if (!flow) return null;
  if (!contentVisibility.flowVisible(v, flow)) return notFound();
  if (change === "live-run" ? !(sharedWith(v, flow) || contentVisibility.flowChangeable(v, flow)) : change && !contentVisibility.flowChangeable(v, flow)) return notYours();
  if (!contentVisibility.flowVisible(plain(v), flow)) reads.push({ entity: "flow", id: flow.id, label: flow.name, owner: flow.ownerSubject, href: `/flows/${flow.id}` });
  return null;
}

async function checkOne(
  v: Viewer,
  ws: string,
  kind: ContentKind,
  id: string,
  change: boolean | "live-run",
  reads: AdminRead[],
  status: { allowed: boolean; only: boolean } = { allowed: false, only: false },
): Promise<Error | null> {
  switch (kind) {
    case "flow":
      return checkFlow(v, ws, id, change, reads);
    case "run": {
      if (!UUID_RE.test(id)) return null;
      const run = await flowExecutionRepo.get(id);
      if (!run || run.workspaceId !== ws) return null;
      const flow = run.flowId ? ((await flowRepo.get(ws, run.flowId)) ?? null) : null;
      if (!contentVisibility.runVisible(v, run, flow)) return notFound();
      // ⚠ It acted as somebody else's own account (sharing-boundaries D4): its status, nothing it did.
      if (!contentVisibility.runDataVisible(v, run)) {
        if (!status.allowed) return actedAsSomeoneElse();
        status.only = true;
      }
      // A private run is whoever started it's, else its workflow's owner's.
      if (!contentVisibility.runVisible(plain(v), run, flow)) {
        reads.push({ entity: "run", id: run.id, label: flow?.name ?? run.kestraFlowId, owner: run.requestedBySubject ?? flow?.ownerSubject ?? null, href: `/runs/${run.id}` });
      }
      return null;
    }
    case "chat": {
      if (!UUID_RE.test(id)) return null;
      const chat = await piChatRepo.get(ws, id);
      if (!chat) return null;
      if (!contentVisibility.chatVisible(v, chat)) return notFound();
      if (!contentVisibility.chatVisible(plain(v), chat)) reads.push(chatRead(chat));
      return null;
    }
    case "session": {
      const { piBuilderService } = await import("../pi-builder/service.js");
      const scope = piBuilderService.sessionScope(ws, id);
      if (!scope) return null;
      if (scope.chatId) {
        const chat = await piChatRepo.get(ws, scope.chatId);
        // A session DRIVES the chat: reading it (a shared chat) is not enough — it must be the caller's to continue.
        if (chat && !contentVisibility.chatChangeable(v, chat)) return notFound();
        if (chat && !contentVisibility.chatVisible(plain(v), chat)) reads.push(chatRead(chat));
      }
      // A session is a building conversation: its workflow must be the caller's to change, not merely to see.
      if (scope.flowId) {
        const err = await checkFlow(v, ws, scope.flowId, true, reads);
        if (err) return notFound();
      }
      if (!scope.chatId && !scope.flowId && !v.all && scope.requesterSubject !== v.subject) return notFound();
      return null;
    }
    case "thread": {
      if (!UUID_RE.test(id)) return null;
      const thread = await flowChatRepo.getThread(ws, id);
      if (!thread?.flowId) return null;
      return checkFlow(v, ws, thread.flowId, true, reads);
    }
  }
}

/**
 * One audit line per person per item per ten minutes. Opening one automation fires a dozen requests (its steps,
 * phases, positions, runs…), and the record is "Ada opened Alice's draft", not twelve lines saying so. In memory —
 * one server process (as the auth throttle) — so a restart may write one extra line, never one fewer.
 */
const NOTED = new Map<string, number>();
const NOTE_WINDOW_MS = 10 * 60_000;

export function noteAdminReads(req: Request, ws: string, reads: AdminRead[]): void {
  const actor = req.user?.email ?? req.user?.subject ?? "unknown";
  const now = Date.now();
  for (const r of reads) {
    const key = `${actor}|${r.entity}|${r.id}`;
    if ((NOTED.get(key) ?? 0) > now - NOTE_WINDOW_MS) continue;
    NOTED.set(key, now);
    if (NOTED.size > 10_000) for (const [k, t] of NOTED) if (t <= now - NOTE_WINDOW_MS) NOTED.delete(k);
    const what = r.entity === "chat" ? "chat" : r.entity === "flow" ? "private automation" : "private test run";
    void import("../services/audit.service.js")
      .then(({ auditService }) =>
        auditService.record({
          workspaceId: ws,
          actor,
          operation: "access",
          entity: r.entity,
          entityId: r.id,
          description: `Opened somebody else's ${what} "${r.label}" as an Admin.`,
          whereText: r.entity === "chat" ? `Chats · ${r.label}` : r.entity === "flow" ? `Automations · ${r.label}` : `Runs · ${r.label}`,
          whereEntityType: r.entity,
          whereEntityId: r.id,
          raw: { reason: "content.read.others", method: req.method },
        }),
      )
      .catch((e) => console.warn(`[content-guard] admin read not audited: ${(e as Error).message}`));
    // ⚠ The owner is SHOWN it, not only audited (sharing-boundaries Q1): a notice that stays until they have seen it.
    // Same ten-minute window as the audit line, so opening one workflow is one notice, not a dozen.
    if (r.owner && r.owner !== req.user?.subject) {
      const owner = r.owner;
      void import("../services/notification.service.js")
        .then(({ notificationService }) =>
          notificationService.add({
            workspaceId: ws,
            subject: owner,
            kind: "admin_viewed",
            title: `An Admin opened your ${what}`,
            body: `${actor} opened "${r.label}". Admins can see what is in your My space, and you are told each time they do.`,
            href: r.href,
          }),
        )
        .catch((e) => console.warn(`[content-guard] owner not notified of an admin read: ${(e as Error).message}`));
    }
  }
}

/**
 * What content THIS request names, from its matched parameters. Decided per request, not from the path at boot,
 * because one router may be mounted at two paths — `release-gates` is, with and without `:flowId` — and both mounts
 * share the same handlers.
 */
function contentOf(req: Request): Array<{ kind: ContentKind; param: string }> {
  const p = req.params as Record<string, string | undefined>;
  const out: Array<{ kind: ContentKind; param: string }> = [];
  if (p.flowId) out.push({ kind: "flow", param: "flowId" });
  if (p.id && /\/flow-executions\/[^/]+/.test(`${req.baseUrl}${req.path}`)) out.push({ kind: "run", param: "id" });
  if (p.executionId) out.push({ kind: "run", param: "executionId" });
  if (p.chatId) out.push({ kind: "chat", param: "chatId" });
  if (p.sessionId) out.push({ kind: "session", param: "sessionId" });
  if (p.threadId) out.push({ kind: "thread", param: "threadId" });
  return out;
}

/** The one read that shows a run's status alone: `GET …/flow-executions/:id`. Its route strips the rest. */
function isRunStatusRead(req: Request): boolean {
  return req.method === "GET" && req.route?.path === "/:id" && /\/flow-executions$/.test(req.baseUrl);
}

/**
 * The guard for one workspace route. `permission` is the route's declared permission: it decides whether the route
 * changes what it names. A request that names no content passes straight through.
 */
export function contentGuard(permission: WorkspacePermission, workspaceParam: string): Handler {
  const change = CHANGES.has(permission);
  return function contentGuardHandler(req: Request, res: Response, next: NextFunction) {
    const params = contentOf(req);
    const ws = req.params[workspaceParam];
    if (!params.length || !ws) return next();
    void (async () => {
      const v = await contentVisibility.viewer(req.user, ws);
      const reads: AdminRead[] = [];
      for (const { kind, param } of params) {
        const id = req.params[param];
        if (!id) continue;
        const status = { allowed: kind === "run" && isRunStatusRead(req), only: false };
        const path = req.route?.path ?? "";
        const mode = !change || READS_THE_NAMED_FLOW.test(path) ? false : RUNS_THE_NAMED_FLOW_LIVE.test(path) && (req.method === "POST" || req.method === "PUT") ? "live-run" : true;
        const err = await checkOne(v, ws, kind, id, mode, reads, status);
        if (err) return next(err);
        if (status.only) res.locals.runStatusOnly = true;
      }
      if (reads.length) noteAdminReads(req, ws, reads);
      next();
    })().catch(next);
  };
}

/**
 * MANAGING a workflow — delete, private/view-only, whose account, switch on/off, ask for approval — is its owner's or an
 * Admin's, even where others may edit it (sharing-boundaries phase 2). The content guard has already answered "may
 * this person see/edit it"; routes that manage call this. Null when allowed (or the workflow is not here — the route
 * answers its own 404), else the refusal to send.
 */
export async function manageRefusal(user: Request["user"], workspaceId: string, flowId: string): Promise<{ error: string; message: string } | null> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) return null;
  if (contentVisibility.flowManageable(await contentVisibility.viewer(user, workspaceId), flow)) return null;
  return { error: "owner_only", message: "Only its owner or an Admin can do this. You can edit this shared workflow, not manage it." };
}

/** `manageRefusal` as route middleware, for a route under `/:flowId`. */
export function requireFlowManager(req: Request, res: Response, next: NextFunction): void {
  const ws = req.params.workspaceId;
  const flowId = req.params.flowId;
  if (!ws || !flowId) {
    // A wiring mistake is a 500 naming itself, never a pass.
    res.status(500).json({ error: "misconfigured", message: "requireFlowManager is mounted where :workspaceId/:flowId are not in scope" });
    return;
  }
  manageRefusal(req.user, ws, flowId)
    .then((refused) => (refused ? void res.status(403).json(refused) : next()))
    .catch(next);
}

/**
 * For a workflow named in a request BODY, which the path-based guard cannot see. True when the caller may change
 * it — or when it does not exist, so the route answers its own 404.
 */
export async function mayChangeFlowNamedInBody(user: Request["user"], workspaceId: string, flowId: string | null | undefined): Promise<boolean> {
  if (!flowId || !UUID_RE.test(flowId)) return true;
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) return true;
  return contentVisibility.flowChangeable(await contentVisibility.viewer(user, workspaceId), flow);
}
