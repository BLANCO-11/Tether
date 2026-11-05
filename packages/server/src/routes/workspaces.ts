import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { closedTo, endEmergencyAccess, isOwnAdmin, isOwnPerson, isRestricted, listEmergencyAccess, setRestricted } from "../services/workspace-restriction.service.js";
import { workspaceMemberService } from "../services/workspace-member.service.js";
import { auditService } from "../services/audit.service.js";
import { sql } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.middleware.js";
import { db } from "../db/index.js";
import { config } from "../config/index.js";
import {
  workspaceService,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../services/workspace.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { actorOf, requireIdentity } from "../middleware/identity.middleware.js";
import { requirePlatformPermission } from "../middleware/platform-permission.middleware.js";
import {
  effectivePermissionsService,
  PlatformRoleCache,
} from "../services/effective-permissions.service.js";

export const workspacesRouter = Router();

type PublicWorkspace = NonNullable<Awaited<ReturnType<typeof workspaceService.get>>>;

/**
 * Assistant mode and the purpose shape what Forge does in a workspace, so each change is recorded in that workspace's
 * audit log, by whom, from what to what (2026-10-12). A create records the choices it was made with.
 */
async function recordSetup(user: Request["user"], ws: PublicWorkspace, before: PublicWorkspace | null): Promise<void> {
  const changes: string[] = [];
  if (!before || before.assistant !== ws.assistant) {
    changes.push(ws.assistant ? "assistant mode on: Forge also does everyday tasks and answers from the real data, read-only" : "assistant mode off: Forge builds workflows only");
  }
  if (before ? before.agentChanges !== ws.agentChanges : ws.agentChanges) {
    changes.push(ws.agentChanges ? "Forge Agent may propose changes to connected services, each done only when a person confirms it" : "Forge Agent may not propose changes to connected services");
  }
  if (before && before.selfEnable !== ws.selfEnable) {
    changes.push(ws.selfEnable ? "members may switch on their own automations that use only their own things" : "members may not switch on their own automations; those already on stop running until a reviewer approves them");
  }
  if (before && before.webAccess !== ws.webAccess) {
    changes.push(ws.webAccess ? "web access on: workflows and Forge may read public web addresses" : "web access off: workflows and Forge may not read the web");
  }
  if (!before || (before.description ?? "") !== (ws.description ?? "")) changes.push(`purpose: "${ws.description ?? ""}"`);
  if (!changes.length) return;
  await auditService
    .record({
      workspaceId: ws.id,
      actor: user?.email ?? user?.name ?? user?.subject ?? "unknown",
      operation: before ? "update" : "create",
      entity: "policy",
      entityId: ws.id,
      description: `${before ? "Changed" : "Created"} workspace "${ws.name}": ${changes.join("; ")}.`,
      whereText: `Organization · ${ws.name}`,
      raw: { assistant: { from: before?.assistant ?? null, to: ws.assistant }, agentChanges: { from: before?.agentChanges ?? null, to: ws.agentChanges }, selfEnable: { from: before?.selfEnable ?? null, to: ws.selfEnable }, webAccess: { from: before?.webAccess ?? null, to: ws.webAccess }, purpose: { from: before?.description ?? null, to: ws.description } },
    })
    .catch((e) => console.warn(`[workspaces] could not record the change to ${ws.id}: ${(e as Error).message}`));
}

/** What a workspace holds, for the Workspaces page's cards (2026-10-12). */
export type WorkspaceCounts = {
  workflows: number;
  /** Running unattended — the client's `isRunningUnattended`: armed, approved, or edited since approval. */
  live: number;
  datasources: number;
  members: number;
  lastRunAt: string | null;
};

/**
 * Counts for the given workspaces in FOUR grouped queries — never one per workspace. Only ever called with the
 * workspaces the caller may already see, so it reveals no workspace and no row the list did not.
 */
export async function countsFor(ids: string[]): Promise<Record<string, WorkspaceCounts>> {
  const out: Record<string, WorkspaceCounts> = {};
  for (const id of ids) out[id] = { workflows: 0, live: 0, datasources: 0, members: 0, lastRunAt: null };
  if (ids.length === 0) return out;
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));
  const flows = rows<{ ws: string; n: string; live: string }>(
    await db.execute(sql`select workspace_id as ws, count(*) as n,
      count(*) filter (where status in ('armed','approved','draft_pending')) as live
      from flows where workspace_id in (${list}) group by workspace_id`),
  );
  for (const r of flows) Object.assign(out[r.ws]!, { workflows: Number(r.n), live: Number(r.live) });
  const ds = rows<{ ws: string; n: string }>(
    await db.execute(sql`select workspace_id as ws, count(*) as n from datasources where workspace_id in (${list}) group by workspace_id`),
  );
  for (const r of ds) out[r.ws]!.datasources = Number(r.n);
  const members = rows<{ ws: string; n: string }>(
    await db.execute(sql`select workspace_id as ws, count(*) as n from workspace_members where workspace_id in (${list}) group by workspace_id`),
  );
  for (const r of members) out[r.ws]!.members = Number(r.n);
  const runs = rows<{ ws: string; at: Date | string | null }>(
    await db.execute(sql`select workspace_id as ws, max(started_at) as at from flow_executions where workspace_id in (${list}) group by workspace_id`),
  );
  for (const r of runs) out[r.ws]!.lastRunAt = r.at ? new Date(r.at).toISOString() : null;
  return out;
}

/** `?with=counts` attaches `counts` to each workspace the caller can see; without it the list is unchanged. */
async function withCounts<T extends { id: string }>(list: T[], want: unknown): Promise<Array<T & { counts?: WorkspaceCounts }>> {
  if (want !== "counts") return list;
  const counts = await countsFor(list.map((w) => w.id));
  return list.map((w) => ({ ...w, counts: counts[w.id] }));
}

/**
 * ⚠ **THE LIFECYCLE ROUTES ARE SUPER-ADMIN-ONLY; THE READS ARE NOT.**
 * `specs/20260820-193547-superadmin-workspace-assignment/`
 *
 * Create, rename and delete had **no gate at all** beyond the shared API key —
 * so anybody who could sign in could create a tenant, rename one, or delete one
 * (which cascades). Reads stay open to any authenticated caller: `GET /` is how
 * the UI resolves the workspace it is bound to on every page, and how every
 * harness finds its fixture. Gating the list would break the product for
 * everyone to protect a set of names they are already working inside.
 *
 * ⚠ **MEASURED before gating: no harness creates a workspace over HTTP.** Every
 * `demo:*`, `finance:*`, `legal:*`, `scenarios:*` and `kestra:*` provisioner
 * calls `workspaceService` directly — which is exactly why the authorisation
 * checks in this codebase live at the route and not in the service. `e2e:ui` is
 * the only HTTP-only harness and it does `GET /workspaces` and resolves the
 * existing `HR` by name (`kestra/e2e-ui-journey.ts`), never creating one. So this
 * gate breaks nothing; if a future harness needs to create one, it mints an
 * identity in the allowlist and says so, rather than the gate being relaxed.
 */

// Build (idempotent) + return the current workspace manifest.
workspacesRouter.get(
  "/:id/manifest",
  asyncHandler(async (req, res) => {
    const ws = await workspaceService.get(req.params.id);
    if (!ws) return res.status(404).json({ error: "not_found" });
    const m = await manifestBuilderService.buildAndPersist(req.params.id);
    res.json(m);
  }),
);

/**
 * ⚠ **FR-015 — THE LIST ITSELF IS THE AUTHORISATION.**
 *
 * This route is identity-only: you do not need a permission to ask which workspaces you
 * can see, because needing access in order to discover you have none is a bootstrap
 * nobody can escape. What is authorised is the CONTENTS — a caller sees a workspace only
 * if they hold something in it.
 *
 * ⚠ **`conferredEverywhere` is why an AUDITOR SEES ZERO WORKSPACES, and that is correct
 * rather than a bug** (T069a). An auditor holds `platform.audit.read`, which confers
 * nothing into any workspace (INV-12), so the list is empty for them — they read across
 * tenants through `GET /api/platform/audit` instead. Showing them the list would be
 * tenant metadata they hold no permission for.
 *
 * ⚠ A **platform administrator** sees them all, because D-9 confers `members.read`
 * everywhere. A **super admin** sees them all through the resolver's short-circuit.
 *
 * ⚠ One `PlatformRoleCache` for the whole request (P-5): the platform read is keyed on
 * subject alone, so without it this asks the identical question once per workspace.
 */
workspacesRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const all = await workspaceService.list();
    const cache = new PlatformRoleCache();

    // Anything conferred by the platform tier applies in EVERY workspace, so it is
    // computed once rather than per row.
    const conferred = await effectivePermissionsService.conferredEverywhere(req.user, cache);
    // ⚠ Restricted workspaces (phase 3): the platform tier — anyone who would see every workspace, and the super
    // admins, who need its id to ask for emergency access — sees one it is outside of as its name, "restricted" and
    // its admins, with no counts and no description. Everyone else simply does not list it.
    if (conferred.length > 0 || config.isSuperAdmin(req.user)) {
      const closed = await closedTo(req.user);
      const open = await withCounts(all.filter((w) => !closed.has(w.id)), req.query.with);
      const stubs = await Promise.all(
        all
          .filter((w) => closed.has(w.id))
          .map(async (w) => ({
            id: w.id,
            name: w.name,
            restricted: true,
            closed: true,
            admins: (await workspaceMemberService.list(w.id)).filter((m) => m.role === "admin").map((m) => m.email),
          })),
      );
      return res.json({ workspaces: [...open, ...stubs] });
    }

    const visible: typeof all = [];
    for (const ws of all) {
      const eff = await effectivePermissionsService.forWorkspace(req.user, ws.id, cache);
      if (eff.permissions.length > 0) visible.push(ws);
    }
    res.json({ workspaces: await withCounts(visible, req.query.with) });
  }),
);

workspacesRouter.post(
  "/",
  requireIdentity,
  requirePlatformPermission("platform.workspaces.write"),
  asyncHandler(async (req, res) => {
    const { restricted, ...input } = createWorkspaceSchema.parse(req.body);
    // A restricted workspace needs somebody inside it from the first moment: its creator, as its admin. Without an
    // email there is no membership to write, so it is refused before anything is created.
    if (restricted && (!req.user?.subject || !req.user.email)) {
      return res.status(400).json({ error: "creator_needs_email", message: "A restricted workspace makes its creator its first admin, which needs a signed-in person with an email." });
    }
    const ws = await workspaceService.create(input);
    if (restricted) {
      // Not one transaction (create, grant and restrict each own their writes). A failure after the create would leave
      // an empty OPEN workspace the person asked to be closed, so it is removed and the request fails.
      try {
        await workspaceMemberService.grant(ws.id, { subject: req.user!.subject, email: req.user!.email!, role: "admin" }, actorOf(req), { bySuperAdmin: true });
        await setRestricted(ws.id, true, actorOf(req));
      } catch (e) {
        await workspaceService.remove(ws.id).catch(() => undefined);
        throw e;
      }
    }
    const created = (await workspaceService.get(ws.id)) ?? ws;
    await recordSetup(req.user, created, null);
    res.status(201).json({ workspace: created });
  }),
);

workspacesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const ws = await workspaceService.get(req.params.id);
    if (!ws) return res.status(404).json({ error: "not_found" });
    res.json({ workspace: ws });
  }),
);

workspacesRouter.patch(
  "/:id",
  requireIdentity,
  requirePlatformPermission("platform.workspaces.write"),
  asyncHandler(async (req, res) => {
    const input = updateWorkspaceSchema.parse(req.body);
    // ⚠ A restricted workspace is its own admins' to change, not the platform's (restricted-workspaces).
    if ((await isRestricted(req.params.id!)) && !(await isOwnAdmin(req.user, req.params.id!))) return refuseRestricted(res);
    const before = await workspaceService.get(req.params.id);
    const ws = await workspaceService.update(req.params.id, input);
    if (!ws) return res.status(404).json({ error: "not_found" });
    if (before) await recordSetup(req.user, ws, before);
    res.json({ workspace: ws });
  }),
);

workspacesRouter.delete(
  "/:id",
  requireIdentity,
  requirePlatformPermission("platform.workspaces.write"),
  asyncHandler(async (req, res) => {
    if ((await isRestricted(req.params.id!)) && !(await isOwnAdmin(req.user, req.params.id!))) return refuseRestricted(res);
    const ok = await workspaceService.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);

function refuseRestricted(res: Response) {
  return res.status(403).json({ error: "restricted", message: "This workspace is restricted: only its own admins can change it." });
}

/**
 * Restrict a workspace, or open it again (restricted-workspaces). Only its OWN admins — a membership row with the
 * `admin` role — or a super admin who counts here (an open emergency access). The route's permission is
 * `members.grant`; the handler narrows it to admins by membership, because a platform admin's conferred
 * `members.grant` must not be able to restrict a workspace it does not belong to, nor open one up. Audited.
 */
workspacesRouter.put(
  "/:workspaceId/restricted",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const wsId = req.params.workspaceId!;
    // Asked FIRST — before the body or the row — so a platform admin's conferred members.grant learns nothing here.
    if (!(await isOwnAdmin(req.user, wsId))) {
      return res.status(403).json({ error: "not_own_admin", message: "Only this workspace's own admins can restrict it or open it up." });
    }
    const { restricted } = z.object({ restricted: z.boolean() }).strict().parse(req.body ?? {});
    const ws = await workspaceService.get(wsId);
    if (!ws) return res.status(404).json({ error: "not_found" });
    if (ws.restricted !== restricted) {
      await setRestricted(wsId, restricted, actorOf(req));
      await auditService
        .record({
          workspaceId: wsId,
          actor: actorOf(req) || "unknown",
          operation: "update",
          entity: "policy",
          entityId: wsId,
          description: restricted
            ? `Restricted workspace "${ws.name}": only the people its admins add can get in; platform admins see its name only.`
            : `Opened up workspace "${ws.name}": it is no longer restricted.`,
          whereText: `Organization · ${ws.name}`,
          raw: { restricted: { from: ws.restricted, to: restricted } },
        })
        .catch((e) => console.warn(`[workspaces] could not record the restriction change on ${wsId}: ${(e as Error).message}`));
    }
    res.json({ workspace: await workspaceService.get(wsId) });
  }),
);

/**
 * Emergency accesses to this workspace, open and past (restricted-workspaces phase 2) — so its own people see who came
 * in and why. `members.read`, narrowed to its own people (`isOwnPerson`): never a platform admin's conferral.
 */
workspacesRouter.get(
  "/:workspaceId/emergency-access",
  requireIdentity,
  asyncHandler(async (req, res) => {
    if (!(await isOwnPerson(req.user, req.params.workspaceId!))) return refuseNotOwn(res);
    const now = Date.now();
    const rows = await listEmergencyAccess(req.params.workspaceId!);
    res.json({ accesses: rows.map((r) => ({ ...r, open: !r.endedAt && r.expiresAt.getTime() > now })) });
  }),
);

function refuseNotOwn(res: Response) {
  return res.status(403).json({ error: "not_own_person", message: "Emergency access is for this workspace's own people to see." });
}

/** End an emergency access: this workspace's own admins, or the person holding it. `members.read`; the service narrows. */
workspacesRouter.post(
  "/:workspaceId/emergency-access/:accessId/end",
  requireIdentity,
  asyncHandler(async (req, res) => {
    if (!(await isOwnPerson(req.user, req.params.workspaceId!))) return refuseNotOwn(res);
    res.json({ access: await endEmergencyAccess(req.params.workspaceId!, req.params.accessId!, req.user) });
  }),
);
