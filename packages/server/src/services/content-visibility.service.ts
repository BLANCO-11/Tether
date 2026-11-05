/**
 * Who may see whose content — ONE module, every list and every by-id read goes through it (rbac-observability,
 * 2026-10-15).
 *
 * Two regions:
 *   - PRIVATE: a person's chats, draft automations, test runs and usage. Its owner sees it; so does anybody holding
 *     `content.read.others` (the Admin preset).
 *   - PUBLISHED: an automation its owner made public (`flows.visibility = 'public'`), and its live runs. The whole
 *     workspace sees it. Who sees it is separate from whether it is switched on (plugins phase 9): approving no longer
 *     publishes, and a private automation can run on its own. Migration 0112 made every automation approved before
 *     then public, which is what published meant until it.
 *
 * Reviewers (`flows.approve`) judge whether a workflow is VALID (sharing-boundaries 2026-10-30). They see a public
 * one, and a private one only when its owner asked them to approve it (`review_requested_revision`) or once it is live
 * (`armed_revision`) — and every run of what they may see, test runs included, because they cannot judge what they
 * cannot read. Not other people's private drafts, chats or usage. Changing an automation is its owner's, or an
 * Admin's: a Reviewer approves, arms and replays (the routes those permissions guard), and does not edit somebody
 * else's work.
 *
 * Content a person may not see answers NOT FOUND, never forbidden: a 403 confirms the thing exists.
 */
import { and, eq, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailSends, flowExecutions, flows, piChats, projectMembers, projects, usageEvents, flowStepApprovals } from "../db/schema.js";
import { effectivePermissionsService, type Identity, type PlatformRoleCache } from "./effective-permissions.service.js";

export interface Viewer {
  /** Null for an identity that names nobody — sees nothing private. */
  subject: string | null;
  /** `content.read.others` — sees and changes everything in the workspace. */
  all: boolean;
  /** `flows.approve` — sees what has been put in front of a reviewer (`reviewable`), to judge it. */
  reviewer: boolean;
  /** `flows.write` — may build and change automations at all (an Observer may not). Absent is treated as no. */
  write?: boolean;
  /** The projects this person is in (sharing-boundaries phase 5) — membership IS access to what lives in them. */
  projects?: ReadonlySet<string>;
  /** Chats shared with this person by id (personal thin Phase 5) — read-only; not a place move. */
  sharedChats?: ReadonlySet<string>;
  /** Runs shared with this person by id (personal thin Phase 5) — read-only. */
  sharedRuns?: ReadonlySet<string>;
}

export interface FlowFacts {
  ownerSubject: string | null;
  /** `private` or `public` — anything else reads as private. */
  visibility: string;
  /** Live (or turned off after being live): a reviewer may see it. */
  armedRevision: number | null;
  /** Its owner asked for approval: a reviewer may see it. */
  reviewRequestedRevision: number | null;
  /** Shared and editable by its members (0123, D2) — or view-only when false. Meaningless while private. */
  othersMayEdit: boolean;
  /** The project it lives in (0128), or null: My space (private) or the Workspace (public). */
  projectId?: string | null;
}

export interface RunFacts {
  /** Present when checking a specific execution (Phase 5 per-person share). */
  id?: string;
  requestedBySubject: string | null;
  kestraNamespace: string;
  /** Whose own account the run acted as (0124); NULL = the workspace's connections only. */
  actsAsSubject?: string | null;
}

/** A run in a `.draft` namespace is a test run — private like the draft it tested. */
export function isLiveRun(run: Pick<RunFacts, "kestraNamespace">): boolean {
  return !run.kestraNamespace.endsWith(".draft");
}

export function isPublished(flow: Pick<FlowFacts, "visibility">): boolean {
  return flow.visibility === "public";
}

/**
 * Is this item shared with this person — in the Workspace (public), or in a project they are in (sharing-boundaries
 * phase 5)? Where an item lives decides who sees it: My space (its owner), a project (its members), the Workspace
 * (everyone). The one definition every rule below uses.
 */
export function sharedWith(v: Pick<Viewer, "projects">, item: { visibility: string; projectId?: string | null }): boolean {
  if (item.projectId) return v.projects?.has(item.projectId) === true;
  return item.visibility === "public";
}

/** What has been put in front of a reviewer: public, live, or its owner asked for approval. */
export function isReviewable(flow: FlowFacts): boolean {
  return isPublished(flow) || flow.armedRevision != null || flow.reviewRequestedRevision != null;
}

/** "In a project this person is in", as SQL — the list form of `sharedWith`'s project half. */
function inMyProjects(column: AnyColumn, subject: string): SQL {
  return sql`(${column} is not null and ${column} in (select ${projectMembers.projectId} from ${projectMembers} where ${projectMembers.subject} = ${subject}))`;
}

/** The same rule as SQL, for lists. Keep the two in step — `content-visibility.service.test.ts` pins both. */
const reviewableSql = sql`(${flows.visibility} = 'public' or ${flows.armedRevision} is not null or ${flows.reviewRequestedRevision} is not null)`;

export const contentVisibility = {
  async viewer(identity: Identity | undefined, workspaceId: string, cache?: PlatformRoleCache): Promise<Viewer> {
    const eff = await effectivePermissionsService.forWorkspace(identity, workspaceId, cache);
    const subject = identity?.subject ?? null;
    const mine = subject
      ? await db
          .select({ id: projectMembers.projectId })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(and(eq(projects.workspaceId, workspaceId), eq(projectMembers.subject, subject)))
      : [];
    // Per-person shares (Phase 5): loaded here so every chatVisible / runVisible path sees them without a second query.
    const { itemShareService } = await import("./item-share.service.js");
    const [sharedChats, sharedRuns] = subject
      ? await Promise.all([itemShareService.idsFor(workspaceId, subject, "chat"), itemShareService.idsFor(workspaceId, subject, "run")])
      : [new Set<string>(), new Set<string>()];
    return {
      subject,
      all: eff.permissions.includes("content.read.others"),
      reviewer: eff.permissions.includes("flows.approve"),
      write: eff.permissions.includes("flows.write"),
      projects: new Set(mine.map((r) => r.id)),
      sharedChats,
      sharedRuns,
    };
  },

  flowVisible(v: Viewer, f: FlowFacts): boolean {
    return v.all || sharedWith(v, f) || (v.reviewer && isReviewable(f)) || (v.subject != null && f.ownerSubject === v.subject);
  },

  /**
   * EDIT it — its steps, name, inputs, versions, canvas; build on it in chat; test-run and run it (sharing-boundaries
   * phase 2, D2): its owner, an Admin, or — when it is shared and not view-only — any member who may build (`flows.write`;
   * an Observer may not). Editing never changes what runs unattended: an approval binds a revision.
   */
  flowChangeable(v: Viewer, f: FlowFacts): boolean {
    if (this.flowManageable(v, f)) return true;
    return sharedWith(v, f) && f.othersMayEdit && v.write === true;
  },

  /**
   * MANAGE it — delete it, make it private or view-only, change whose account it acts as, switch it on or off, ask for
   * approval: its owner's, or an Admin's, whoever else may edit it. Taking a shared thing away from everybody, or
   * deciding whose credentials it uses, is not an edit.
   */
  flowManageable(v: Viewer, f: Pick<FlowFacts, "ownerSubject">): boolean {
    return v.all || (v.subject != null && f.ownerSubject === v.subject);
  },

  /**
   * May this person copy a workflow into something the whole workspace sees (a template)? Only a public one they can
   * see, or their own. Seeing a private workflow (an Admin, a Reviewer) is not leave to publish it for its owner.
   */
  flowCopyableToWorkspace(v: Viewer, f: FlowFacts): boolean {
    if (isPublished(f) && !f.projectId) return this.flowVisible(v, f);
    return v.subject != null && f.ownerSubject === v.subject;
  },

  runVisible(v: Viewer, r: RunFacts, flow: FlowFacts | null): boolean {
    if (v.all) return true;
    if (v.subject != null && r.requestedBySubject === v.subject) return true;
    if (r.id != null && v.sharedRuns?.has(r.id) === true) return true;
    if (!flow) return false;
    if (v.reviewer && isReviewable(flow)) return true;
    if (v.subject != null && flow.ownerSubject === v.subject) return true;
    return sharedWith(v, flow) && isLiveRun(r);
  },

  /**
   * WHAT a visible run did — its steps, outputs, emails, its replay. A run that acted as one person's own account
   * (sharing-boundaries D4) is that person's and an Admin's to read; everyone else who may see the run sees that it
   * ran and its status only.
   */
  runDataVisible(v: Viewer, r: Pick<RunFacts, "actsAsSubject">): boolean {
    return v.all || !r.actsAsSubject || r.actsAsSubject === v.subject;
  },

  /**
   * A chat its owner shared with the workspace (0122), put in a project they are in, shared with them by id
   * (Phase 5), or theirs / an Admin's.
   */
  chatVisible(
    v: Viewer,
    c: { id?: string; createdBySubject: string | null; visibility: string; projectId?: string | null },
  ): boolean {
    if (v.all || sharedWith(v, c) || (v.subject != null && c.createdBySubject === v.subject)) return true;
    return c.id != null && v.sharedChats?.has(c.id) === true;
  },

  /**
   * Continue it, rename it, delete it, share it: its owner's, or an Admin's — never a reader's (sharing-boundaries P1-I5
   * "A": a shared chat is shared to read; two people driving one Forge process was not chosen).
   */
  chatChangeable(v: Viewer, c: { createdBySubject: string | null }): boolean {
    return v.all || (v.subject != null && c.createdBySubject === v.subject);
  },

  /** `flows` rows this viewer may list. */
  flowsWhere(v: Viewer): SQL | undefined {
    if (v.all) return undefined;
    const workspace = sql`(${flows.projectId} is null and ${flows.visibility} = 'public')`;
    const seen = v.reviewer ? sql`(${workspace} or ${reviewableSql})` : workspace;
    return v.subject ? or(seen, eq(flows.ownerSubject, v.subject), inMyProjects(flows.projectId, v.subject)) : seen;
  },

  /** `flow_executions` rows this viewer may list. Subqueries, not a join, so a caller's row shape never changes. */
  runsWhere(v: Viewer): SQL | undefined {
    if (v.all) return undefined;
    const shared = v.subject
      ? sql`((${flows.projectId} is null and ${flows.visibility} = 'public') or ${inMyProjects(flows.projectId, v.subject)})`
      : sql`(${flows.projectId} is null and ${flows.visibility} = 'public')`;
    const liveOfShared = sql`(${flowExecutions.kestraNamespace} not like '%.draft' and ${flowExecutions.flowId} in (select ${flows.id} from ${flows} where ${shared}))`;
    const liveOfPublished = v.reviewer ? sql`(${liveOfShared} or ${flowExecutions.flowId} in (select ${flows.id} from ${flows} where ${reviewableSql}))` : liveOfShared;
    if (!v.subject) return liveOfPublished;
    return sql`(${flowExecutions.requestedBySubject} = ${v.subject} or ${flowExecutions.flowId} in (select ${flows.id} from ${flows} where ${flows.ownerSubject} = ${v.subject}) or ${liveOfPublished})`;
  },

  /**
   * The person's OWN runs — the dashboard's "Mine": runs they started, and runs of automations they own. Narrows
   * `runsWhere`, never widens it; an identity naming nobody owns nothing.
   */
  runsMineWhere(v: Viewer): SQL {
    if (!v.subject) return sql`false`;
    return sql`(${flowExecutions.requestedBySubject} = ${v.subject} or ${flowExecutions.flowId} in (select ${flows.id} from ${flows} where ${flows.ownerSubject} = ${v.subject}))`;
  },

  /** Whether "Mine / Everyone" is a choice: only for those who see beyond their own work (Admins and Reviewers). */
  choosesRunScope(v: Viewer): boolean {
    return v.all || v.reviewer;
  },

  /** `email_sends` rows: a message follows the run that sent it; one no run sent is an Admin's (or Reviewer's). */
  emailsWhere(v: Viewer): SQL | undefined {
    const runs = this.runsWhere(v);
    if (!runs) return undefined;
    return sql`${emailSends.flowExecutionId} in (select ${flowExecutions.id} from ${flowExecutions} where ${runs})`;
  },

  /**
   * Who decides a run's pause (sharing-boundaries P1-D1/D2): the workflow's OWNER — reviewers judge whether a
   * workflow is valid, not its execution. An Admin decides only a pause whose workflow has nobody to own it, so a run
   * is never parked for ever. (A person the step names will join this when an approval step can name one.)
   */
  /**
   * Who decides a run's pause: the person whose own account the run used, else the workflow's owner (`decider`), and
   * also the member the approval step names (`named`). With nobody at all, an Admin.
   */
  mayDecidePause(v: Viewer, decider: string | null, named?: string | null): boolean {
    if (named && v.subject != null && named === v.subject) return true;
    if (decider) return v.subject != null && decider === v.subject;
    return v.all;
  },

  /** The inbox: pauses this person decides — the list form of `mayDecidePause`. */
  pausesWhere(v: Viewer): SQL {
    const mine = v.subject ? sql`${flows.ownerSubject} = ${v.subject}` : sql`false`;
    const orphaned = v.all ? sql`${flows.ownerSubject} is null` : sql`false`;
    const owned = sql`(${flowExecutions.actsAsSubject} is null and ${flowExecutions.flowId} in (select ${flows.id} from ${flows} where ${mine} or ${orphaned}))`;
    if (!v.subject) return owned;
    // A run on someone's own account is theirs to decide (P3-I2); a step that names a member is theirs too (P1-I3).
    return sql`(${owned} or ${flowExecutions.actsAsSubject} = ${v.subject} or ${flowStepApprovals.deciderSubject} = ${v.subject})`;
  },

  chatsWhere(v: Viewer): SQL | undefined {
    if (v.all) return undefined;
    const shared = sql`(${piChats.projectId} is null and ${piChats.visibility} = 'public')`;
    return v.subject ? or(shared, eq(piChats.createdBySubject, v.subject), inMyProjects(piChats.projectId, v.subject)) : shared;
  },

  /**
   * `usage_events` rows this viewer may see: their own, plus usage recorded with nobody behind it (a schedule, a
   * trigger) on an automation they own.
   */
  usageWhere(v: Viewer): SQL | undefined {
    if (v.all) return undefined;
    if (!v.subject) return sql`false`;
    return sql`(${usageEvents.subject} = ${v.subject} or (${usageEvents.subject} is null and ${usageEvents.flowId} in (select ${flows.id} from ${flows} where ${flows.ownerSubject} = ${v.subject})))`;
  },
};
