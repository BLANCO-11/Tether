/**
 * Projects (sharing-boundaries phase 5, D6) — a smaller circle inside a workspace, with shared context.
 *
 * Where an item lives decides who sees it, and an item lives in ONE place:
 *   My space   — `project_id` NULL, `visibility` private: its owner (and Admins, who are shown to the owner).
 *   a project  — `project_id` set: the project's members (and Admins; Reviewers only what is put in front of them).
 *   Workspace  — `project_id` NULL, `visibility` public: everyone in the workspace.
 *
 * Members come from the workspace only; the project's owner (or an Admin) adds and removes them. MEMBERSHIP IS THE
 * ACCESS: removing somebody takes everything in the project from them at once, because every rule asks membership
 * (`contentVisibility.sharedWith`) rather than copying it onto items. Items they owned pass to the project's owner (Q4:
 * others may own items in a project). Deleting a project returns each item to its OWNER's My space — never to the
 * workspace, which would widen who sees it.
 *
 * Moving an item that narrows who sees it says first who loses sight and what relies on it (Q5); the move itself is
 * its manager's (owner or Admin), and into a project only for somebody in it.
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowActivations, flows, piChats, platformUsers, projectFiles, projectMembers, projects, workspaceMembers } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { auditService } from "./audit.service.js";
import { contentVisibility, type Viewer } from "./content-visibility.service.js";
import { effectiveAccounts, type PiRunAs } from "./run-as.service.js";
import { notificationService } from "./notification.service.js";
import { projectMemoryService } from "./project-memory.service.js";

export type Project = typeof projects.$inferSelect;
/** Where an item lives, as a person names it. */
export type Place = { kind: "mine" } | { kind: "workspace" } | { kind: "project"; projectId: string };

type Refusal = Error & { statusCode: number };
const refusal = (message: string, statusCode = 409): Refusal => Object.assign(new Error(message), { statusCode });

/** Parse "mine" | "workspace" | "project:<id>". */
export function parsePlace(to: string): Place | null {
  if (to === "mine") return { kind: "mine" };
  if (to === "workspace") return { kind: "workspace" };
  const m = to.match(/^project:([0-9a-f-]{36})$/i);
  return m ? { kind: "project", projectId: m[1]! } : null;
}

export function placeOf(item: { visibility: string; projectId?: string | null }): Place {
  if (item.projectId) return { kind: "project", projectId: item.projectId };
  return item.visibility === "public" ? { kind: "workspace" } : { kind: "mine" };
}

/**
 * What a LIVE workflow's approved version would run as, here and there, when the two differ — one line per service.
 * Where it lives decides its accounts (Q3: My space = its owner's own), so a move can change whose account an
 * unattended run uses; that needs approving again, and is said before the move.
 */
async function runsAsChange(workspaceId: string, flow: { id: string; armedRevision: number | null; visibility: string; projectId: string | null; ownerSubject: string | null }, to: Place): Promise<string[]> {
  if (flow.armedRevision == null) return [];
  const row = await flowRepo.getRevision(flow.id, flow.armedRevision);
  const model = row?.modelJson as { workflow?: unknown; files?: Record<string, string>; accounts?: Record<string, PiRunAs> } | undefined;
  if (!model?.workflow) return [];
  const target = { visibility: to.kind === "workspace" ? "public" : "private", projectId: to.kind === "project" ? to.projectId : null, ownerSubject: flow.ownerSubject };
  const before = (await effectiveAccounts(workspaceId, flow, model)) ?? {};
  const after = (await effectiveAccounts(workspaceId, target, model)) ?? {};
  const say = (a: PiRunAs | undefined) => (!a ? "the workspace's account" : a.own ? "its owner's own account" : a.each ? "each person's own account" : a.personal ? `its owner's own “${a.label}”` : `the workspace's “${a.label}”`);
  const out: string[] = [];
  for (const piece of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[piece];
    const a = after[piece];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    out.push(`${(a ?? b)!.service} would use ${say(a)} instead of ${say(b)}`);
  }
  return out;
}

async function memberSubjects(projectId: string): Promise<string[]> {
  return (await db.select({ s: projectMembers.subject }).from(projectMembers).where(eq(projectMembers.projectId, projectId))).map((r) => r.s);
}

/**
 * A person as people know them: their name from sign-in, else their email — from sign-in or their membership row.
 * Never the sign-in id while anything better exists: somebody reaching the workspace without a membership row (a
 * super admin, an Admin by platform role) has no membership email, and the id is all that was shown for them.
 */
async function nameOf(workspaceId: string, subjects: Iterable<string | null> = []): Promise<(subject: string | null) => string> {
  const rows = await db.select({ subject: workspaceMembers.subject, email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
  const m = new Map(rows.map((r) => [r.subject, r.email]));
  const wanted = [...new Set([...m.keys(), ...[...subjects].filter((s): s is string => !!s)])];
  if (wanted.length) {
    for (const u of await db.select({ subject: platformUsers.subject, email: platformUsers.email, name: platformUsers.name }).from(platformUsers).where(inArray(platformUsers.subject, wanted))) {
      const best = u.name?.trim() || u.email || m.get(u.subject);
      if (best) m.set(u.subject, best);
    }
  }
  return (s) => (s ? (m.get(s) ?? s) : "nobody");
}

/** Who sees an item in a place, Admins aside (they always do). The owner always does. */
async function audience(workspaceId: string, place: Place, owner: string | null): Promise<Set<string>> {
  const out = new Set<string>(owner ? [owner] : []);
  if (place.kind === "workspace") {
    for (const r of await db.select({ s: workspaceMembers.subject }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))) out.add(r.s);
  } else if (place.kind === "project") {
    for (const s of await memberSubjects(place.projectId)) out.add(s);
  }
  return out;
}

export const projectService = {
  /** The projects this person is in — every project, for an Admin. */
  async list(workspaceId: string, v: Viewer): Promise<Array<Project & { members: number; mine: boolean; owned: boolean }>> {
    const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(asc(projects.name));
    const counts = new Map<string, number>();
    if (rows.length) {
      for (const r of await db.select({ p: projectMembers.projectId }).from(projectMembers).where(inArray(projectMembers.projectId, rows.map((x) => x.id)))) {
        counts.set(r.p, (counts.get(r.p) ?? 0) + 1);
      }
    }
    return rows
      .filter((p) => v.all || v.projects?.has(p.id))
      .map((p) => ({ ...p, members: counts.get(p.id) ?? 0, mine: v.projects?.has(p.id) === true, owned: p.ownerSubject === v.subject }));
  },

  /** One project, if this person may see it: its members (with names) and what lives in it that they may see. */
  async get(workspaceId: string, projectId: string, v: Viewer) {
    const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (!p || !(v.all || v.projects?.has(p.id))) return null;
    const memberRows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, p.id)).orderBy(asc(projectMembers.addedAt));
    const flowRows = await db.select({ id: flows.id, name: flows.name, ownerSubject: flows.ownerSubject, updatedAt: flows.updatedAt }).from(flows).where(eq(flows.projectId, p.id));
    const chatRows = await db.select({ id: piChats.id, title: piChats.title, createdBySubject: piChats.createdBySubject, flowId: piChats.flowId, updatedAt: piChats.updatedAt }).from(piChats).where(eq(piChats.projectId, p.id));
    const name = await nameOf(workspaceId, [p.ownerSubject, ...memberRows.map((m) => m.subject), ...flowRows.map((f) => f.ownerSubject), ...chatRows.map((c) => c.createdBySubject)]);
    const members = memberRows.map((m) => ({
      subject: m.subject,
      name: name(m.subject),
      owner: m.subject === p.ownerSubject,
      you: v.subject != null && m.subject === v.subject,
      addedAt: m.addedAt,
    }));
    const items = {
      flows: flowRows.map((f) => ({ ...f, ownerName: name(f.ownerSubject) })),
      chats: chatRows.map((c) => ({
        ...c,
        ownerName: name(c.createdBySubject),
        // A member READS somebody else's chat here; only its starter (or an Admin) continues it.
        canChange: contentVisibility.chatChangeable(v, c),
      })),
    };
    return { ...p, ownerName: name(p.ownerSubject), members, items, manages: this.manages(v, p), mine: v.projects?.has(p.id) === true };
  },

  /** Every project's name in the workspace, for labelling where listed items live. One query per list. */
  async namesIn(workspaceId: string): Promise<Map<string, string>> {
    const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.workspaceId, workspaceId));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /**
   * What a chat in the project is given each turn: its name, shared instructions, file names, and active memory
   * ledger items (Phase 4). Null when it is gone.
   */
  async contextOf(
    workspaceId: string,
    projectId: string | null | undefined,
  ): Promise<{
    name: string;
    instructions: string;
    files: string[];
    memories: Array<{ kind: string; body: string }>;
    memoryEnabled: boolean;
  } | null> {
    if (!projectId) return null;
    const [p] = await db
      .select({ name: projects.name, instructions: projects.instructions, memoryEnabled: projects.memoryEnabled })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (!p) return null;
    const files = (await db.select({ name: projectFiles.name }).from(projectFiles).where(eq(projectFiles.projectId, projectId)).orderBy(asc(projectFiles.name))).map((r) => r.name);
    const memories =
      p.memoryEnabled === false
        ? []
        : await projectMemoryService.activeForInject(workspaceId, projectId).catch(() => [] as Array<{ kind: string; body: string }>);
    return { ...p, memoryEnabled: p.memoryEnabled !== false, files, memories };
  },

  manages(v: Viewer, p: Pick<Project, "ownerSubject">): boolean {
    return v.all || (v.subject != null && p.ownerSubject === v.subject);
  },

  async create(workspaceId: string, who: { subject: string; actor: string }, input: { name: string; description?: string | null; instructions?: string }): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw refusal("A project needs a name.", 400);
    const existing = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.workspaceId, workspaceId));
    if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw refusal(`There is already a project called “${name}” here.`);
    const [p] = await db
      .insert(projects)
      .values({ workspaceId, name, description: input.description ?? null, instructions: input.instructions ?? "", ownerSubject: who.subject })
      .returning();
    // The owner is a member like any other, so one membership rule answers for everybody.
    await db.insert(projectMembers).values({ projectId: p!.id, subject: who.subject, addedBy: who.actor });
    await audit(workspaceId, who.actor, p!.id, `Created the project “${name}”`);
    return p!;
  },

  async update(
    workspaceId: string,
    projectId: string,
    v: Viewer,
    actor: string,
    input: { name?: string; description?: string | null; instructions?: string; memoryEnabled?: boolean },
  ): Promise<Project> {
    const p = await this._managed(workspaceId, projectId, v);
    const set: Partial<Project> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw refusal("A project needs a name.", 400);
      set.name = name;
    }
    if (input.description !== undefined) set.description = input.description;
    if (input.instructions !== undefined) set.instructions = input.instructions;
    if (input.memoryEnabled !== undefined) set.memoryEnabled = input.memoryEnabled;
    const [out] = await db.update(projects).set(set).where(eq(projects.id, p.id)).returning();
    const bits = [
      input.instructions !== undefined ? "its shared instructions" : null,
      input.memoryEnabled !== undefined ? (input.memoryEnabled ? "memory on" : "memory off") : null,
    ].filter(Boolean);
    await audit(workspaceId, actor, p.id, `Changed the project “${out!.name}”${bits.length ? ` (${bits.join(", ")})` : ""}`);
    return out!;
  },

  /** Delete a project: everything in it goes back to its owner's My space, and its owners are told. */
  async remove(workspaceId: string, projectId: string, v: Viewer, actor: string): Promise<{ returned: number }> {
    const p = await this._managed(workspaceId, projectId, v);
    const owned = await db.select({ id: flows.id, name: flows.name, owner: flows.ownerSubject }).from(flows).where(eq(flows.projectId, p.id));
    const chats = await db.select({ id: piChats.id, owner: piChats.createdBySubject }).from(piChats).where(eq(piChats.projectId, p.id));
    await db.update(flows).set({ projectId: null, visibility: "private" }).where(eq(flows.projectId, p.id));
    await db.update(piChats).set({ projectId: null, visibility: "private" }).where(eq(piChats.projectId, p.id));
    await db.delete(projects).where(eq(projects.id, p.id));
    const told = new Set([...owned.map((f) => f.owner), ...chats.map((c) => c.owner)].filter((s): s is string => !!s && s !== v.subject));
    for (const s of told) {
      await notificationService.add({ workspaceId, subject: s, kind: "project_changed", title: `The project “${p.name}” was deleted`, body: "What you had in it is back in your My space, seen only by you.", href: "/flows" });
    }
    await audit(workspaceId, actor, p.id, `Deleted the project “${p.name}”: ${owned.length + chats.length} item(s) went back to their owners' My space`);
    return { returned: owned.length + chats.length };
  },

  /** Add a workspace member to a project. */
  async addMember(workspaceId: string, projectId: string, v: Viewer, actor: string, subject: string): Promise<void> {
    const p = await this._managed(workspaceId, projectId, v);
    const [m] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.subject, subject)));
    if (!m) throw refusal("Only a member of this workspace can be added to one of its projects.", 400);
    await db.insert(projectMembers).values({ projectId: p.id, subject, addedBy: actor }).onConflictDoNothing();
    await notificationService.add({ workspaceId, subject, kind: "project_changed", title: `You were added to “${p.name}”`, body: "You can now see what is in it, and its chats start with its shared instructions.", href: `/projects/${p.id}` });
    await audit(workspaceId, actor, p.id, `Added ${m.email} to the project “${p.name}”`);
  },

  /**
   * Remove somebody from a project (its manager; or the person leaving it themselves). They lose everything in it at
   * once. What they owned there passes to the project's owner; their "Turn on for me" copies of its workflows stop.
   */
  async removeMember(workspaceId: string, projectId: string, v: Viewer, actor: string, subject: string, opts: { leaving?: boolean } = {}): Promise<{ handedOver: number }> {
    const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (!p) throw refusal("Not found.", 404);
    const self = v.subject === subject;
    if (!self && !opts.leaving && !this.manages(v, p)) throw refusal("Only the project's owner or an Admin removes its members.", 403);
    if (subject === p.ownerSubject) throw refusal("The project's owner cannot be removed. Hand the project to someone else, or delete it.", 409);
    const handedOver = await this._handOver(workspaceId, p, subject, actor);
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.subject, subject)));
    if (!self) {
      await notificationService.add({ workspaceId, subject, kind: "project_changed", title: `You were removed from “${p.name}”`, body: "You no longer see what is in it.", href: "/flows" });
    }
    await audit(workspaceId, actor, p.id, `${self ? "Left" : "Removed somebody from"} the project “${p.name}”${handedOver ? `; ${handedOver} item(s) they owned passed to its owner` : ""}`);
    return { handedOver };
  },

  /** Hand the project to another of its members. */
  async setOwner(workspaceId: string, projectId: string, v: Viewer, actor: string, subject: string): Promise<void> {
    const p = await this._managed(workspaceId, projectId, v);
    if (!(await memberSubjects(p.id)).includes(subject)) throw refusal("Only a member of the project can own it. Add them first.", 400);
    await db.update(projects).set({ ownerSubject: subject, updatedAt: new Date() }).where(eq(projects.id, p.id));
    await audit(workspaceId, actor, p.id, `Handed the project “${p.name}” to another member`);
  },

  /**
   * Somebody left the WORKSPACE: out of every project in it. A project they owned passes to its longest-standing other
   * member, or — with nobody else in it — is deleted (its items return to their owners' My space). Called BEFORE their
   * own workflows are released (`releaseOwnedBy`), so what they owned in a project goes to its owner, not to nobody.
   */
  async memberLeftWorkspace(workspaceId: string, subject: string, actor: string): Promise<void> {
    const theirs = await db
      .select({ p: projects })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.workspaceId, workspaceId), eq(projectMembers.subject, subject)));
    for (const { p } of theirs) {
      if (p.ownerSubject === subject) {
        const next = (await db.select().from(projectMembers).where(eq(projectMembers.projectId, p.id)).orderBy(asc(projectMembers.addedAt))).find((m) => m.subject !== subject);
        if (!next) {
          await this.remove(workspaceId, p.id, { subject: null, all: true, reviewer: false }, actor);
          continue;
        }
        await db.update(projects).set({ ownerSubject: next.subject, updatedAt: new Date() }).where(eq(projects.id, p.id));
        await notificationService.add({ workspaceId, subject: next.subject, kind: "project_changed", title: `You own “${p.name}” now`, body: "Its owner left the workspace, and you were its longest-standing member.", href: `/projects/${p.id}` });
        p.ownerSubject = next.subject;
      }
      await this._handOver(workspaceId, p, subject, actor);
      await db.delete(projectMembers).where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.subject, subject)));
    }
  },

  /**
   * What moving an item would change, said BEFORE it moves (Q5): who would stop seeing it, whether it runs on its own,
   * who turned it on for themselves and would lose it, and the chats that use it as a reference.
   */
  async movePreview(workspaceId: string, item: { kind: "flow"; id: string } | { kind: "chat"; id: string }, to: Place) {
    const row =
      item.kind === "flow"
        ? await flowRepo.get(workspaceId, item.id)
        : (await db.select().from(piChats).where(and(eq(piChats.id, item.id), eq(piChats.workspaceId, workspaceId))))[0];
    if (!row) return null;
    const owner = item.kind === "flow" ? (row as { ownerSubject: string | null }).ownerSubject : (row as { createdBySubject: string | null }).createdBySubject;
    const from = placeOf(row as { visibility: string; projectId: string | null });
    const before = await audience(workspaceId, from, owner);
    const after = await audience(workspaceId, to, owner);
    const name = await nameOf(workspaceId, [...before, ...after]);
    const loses = [...before].filter((s) => !after.has(s));
    const gains = [...after].filter((s) => !before.has(s));
    let live = false;
    let turnedOnBy: string[] = [];
    let referencedBy: string[] = [];
    let runsAs: string[] = [];
    let switchesOff: string | null = null;
    if (item.kind === "flow") {
      const f = row as { id: string; armedRevision: number | null; visibility: string; projectId: string | null; ownerSubject: string | null };
      runsAs = await runsAsChange(workspaceId, f, to);
      if (runsAs.length) {
        switchesOff = "It is switched off until a reviewer approves it again, because whose account it uses changes.";
      } else if (to.kind !== "mine" && f.armedRevision != null && (await flowRepo.currentApproval(f.id, f.armedRevision))?.selfEnabled) {
        switchesOff = "Its owner switched it on without a reviewer, which only My space allows. It is switched off until a reviewer approves it.";
      }
      live = (row as { armedRevision: number | null }).armedRevision != null;
      turnedOnBy = (await db.select({ s: flowActivations.subject }).from(flowActivations).where(eq(flowActivations.flowId, item.id))).map((r) => r.s).filter((s) => !after.has(s));
      referencedBy = (await db.select({ title: piChats.title, flowId: piChats.flowId }).from(piChats).where(and(eq(piChats.workspaceId, workspaceId), isNotNull(piChats.flowId), eq(piChats.flowId, item.id)))).map((c) => c.title ?? "a chat");
    }
    return {
      from,
      to,
      loses: loses.map(name),
      gains: gains.length,
      live,
      turnedOnBy: turnedOnBy.map(name),
      referencedBy,
      /** A live workflow whose accounts change with the move: one line per service. It is turned off until approved. */
      runsAs,
      /** Said before the move: it stops running on its own, and why. */
      switchesOff,
      narrows: loses.length > 0,
    };
  },

  /**
   * Move an item to My space, a project, or the Workspace. The caller has already been held to MANAGING it (owner or
   * Admin). Into a project: only for somebody in it (an Admin included). Leaving My space for a shared place turns off
   * a workflow its owner switched on without a reviewer (Q2). People who turned a workflow on for themselves and lose
   * sight of it have their copy turned off, and are told.
   */
  async move(workspaceId: string, item: { kind: "flow"; id: string } | { kind: "chat"; id: string }, to: Place, v: Viewer, actor: string): Promise<{ turnedOff: boolean }> {
    if (to.kind === "project") {
      const [p] = await db.select().from(projects).where(and(eq(projects.id, to.projectId), eq(projects.workspaceId, workspaceId)));
      if (!p) throw refusal("That project is not in this workspace.", 404);
      if (!v.all && !v.projects?.has(p.id)) throw refusal("You can only move things into a project you are in.", 403);
    }
    const preview = await this.movePreview(workspaceId, item, to);
    if (!preview) throw refusal("Not found.", 404);
    const set = to.kind === "project" ? { projectId: to.projectId, visibility: "private" } : { projectId: null, visibility: to.kind === "workspace" ? "public" : "private" };
    let turnedOff = false;
    if (item.kind === "chat") {
      await db.update(piChats).set(set).where(and(eq(piChats.id, item.id), eq(piChats.workspaceId, workspaceId)));
    } else {
      const flow = (await flowRepo.get(workspaceId, item.id))!;
      await flowRepo.update(flow.id, set);
      // ⚠ Whose account it acts as changes with where it lives: an unattended run must not start using other
      // credentials without someone approving that (Q2/Q3). Off until approved again, saying why.
      if (preview.runsAs.length) {
        const { flowApprovalService } = await import("./flow-approval.service.js");
        await flowApprovalService.revoke(workspaceId, flow.id, { reason: `It was moved, and ${preview.runsAs.join("; ")}. A reviewer approves it again.`, revokedBy: actor });
        turnedOff = true;
      } else if (to.kind !== "mine" && flow.armedRevision != null) {
        const current = await flowRepo.currentApproval(flow.id, flow.armedRevision);
        if (current?.selfEnabled) {
          const { flowApprovalService } = await import("./flow-approval.service.js");
          await flowApprovalService.revoke(workspaceId, flow.id, {
            reason: "It was shared. Its owner switched it on while it was in My space; shared workflows need a reviewer to approve them.",
            revokedBy: actor,
          });
          turnedOff = true;
        }
      }
      // Who turned it on for themselves and can no longer see it: their copy stops, and they are told.
      const after = await audience(workspaceId, to, flow.ownerSubject);
      const gone = (await db.select().from(flowActivations).where(eq(flowActivations.flowId, flow.id))).filter((a) => !after.has(a.subject));
      for (const a of gone) {
        await db.delete(flowActivations).where(eq(flowActivations.id, a.id));
        await notificationService.add({ workspaceId, subject: a.subject, kind: "project_changed", title: `“${flow.name}” stopped running for you`, body: "It was moved somewhere you do not see, so it was turned off for you.", href: "/flows" });
      }
    }
    const where = to.kind === "project" ? "a project" : to.kind === "workspace" ? "the Workspace" : "My space";
    await auditService
      .record({ workspaceId, actor, operation: "update", entity: item.kind === "flow" ? "flow" : "chat", entityId: item.id, description: `Moved to ${where}${preview.loses.length ? `; ${preview.loses.length} person(s) no longer see it` : ""}`, whereText: where })
      .catch((e) => console.error("[projects] move not audited:", e));
    return { turnedOff };
  },

  async _managed(workspaceId: string, projectId: string, v: Viewer): Promise<Project> {
    const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (!p || !(v.all || v.projects?.has(p.id))) throw refusal("Not found.", 404);
    if (!this.manages(v, p)) throw refusal("Only the project's owner or an Admin can do this.", 403);
    return p;
  },

  /** What `subject` owned in the project passes to its owner; their "for me" copies of its workflows stop. */
  async _handOver(workspaceId: string, p: Project, subject: string, actor: string): Promise<number> {
    const theirFlows = await db.select().from(flows).where(and(eq(flows.projectId, p.id), eq(flows.ownerSubject, subject)));
    for (const f of theirFlows) {
      await flowRepo.setOwner(workspaceId, f.id, p.ownerSubject);
      // ⚠ One approved to act as the leaver's own account must not act as it for the new owner (plugins 8.6).
      if (f.armedRevision != null) {
        const { runAsProblems } = await import("./run-as.service.js");
        const row = await flowRepo.getRevision(f.id, f.armedRevision);
        const problems = await runAsProblems(workspaceId, (row?.modelJson as { accounts?: never } | undefined)?.accounts, p.ownerSubject);
        if (problems.length) {
          const { flowApprovalService } = await import("./flow-approval.service.js");
          await flowApprovalService.revoke(workspaceId, f.id, { reason: `It passed to the project's owner and ${problems.join("; ")}. Choose its connection again, then approve it.`, revokedBy: actor });
        }
      }
    }
    const theirChats = await db.update(piChats).set({ createdBySubject: p.ownerSubject }).where(and(eq(piChats.projectId, p.id), eq(piChats.createdBySubject, subject))).returning({ id: piChats.id });
    const projectFlows = (await db.select({ id: flows.id }).from(flows).where(eq(flows.projectId, p.id))).map((f) => f.id);
    if (projectFlows.length) {
      await db.delete(flowActivations).where(and(eq(flowActivations.subject, subject), inArray(flowActivations.flowId, projectFlows)));
    }
    return theirFlows.length + theirChats.length;
  },
};

async function audit(workspaceId: string, actor: string, projectId: string, description: string): Promise<void> {
  await auditService
    .record({ workspaceId, actor, operation: "update", entity: "project", entityId: projectId, description, whereText: "Projects" })
    .catch((e) => console.error("[projects] not audited:", e));
}

