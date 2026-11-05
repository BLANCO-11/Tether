/**
 * Restricted workspaces — the ONE rule for who above a workspace may reach into it (plans/restricted-workspaces-
 * 2026-10-29). A restricted workspace is closed to everyone its own admins did not add:
 *   - a SUPER ADMIN holds nothing in it, unless they hold an active emergency access (a reason, a few hours, audited
 *     in that workspace, shown to its admins, who can end it);
 *   - a PLATFORM ADMIN's conferral (`members.read` + `members.grant` everywhere, D-9) does not apply in it.
 * Its members get exactly what they get anywhere else. Every place that asked `config.isSuperAdmin` about a
 * workspace asks `superAdminHere` instead, so there is one answer to "does the allowlist count here".
 */
import { and, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { workspaceEmergencyAccess, workspaces } from "../db/schema.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { auditService } from "./audit.service.js";
import { mailService } from "./mail.service.js";
import { EMAIL_RE, isReservedDomain } from "./mail-recipients.js";

type Who = { subject?: string | null; email?: string | null } | null | undefined;

export type EmergencyAccess = typeof workspaceEmergencyAccess.$inferSelect;

/** True for a restricted workspace. A workspace that does not exist is not restricted (the route 404s on its own). */
export async function isRestricted(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ restricted: workspaces.restricted }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row?.restricted === true;
}

/** Who this access is for: the subject, or the email (the allowlist matches either). */
function whoIs(who: Who): SQL | undefined {
  const parts: SQL[] = [];
  if (who?.subject) parts.push(eq(workspaceEmergencyAccess.subject, who.subject));
  if (who?.email) parts.push(eq(workspaceEmergencyAccess.email, who.email.toLowerCase()));
  return parts.length ? or(...parts) : undefined;
}

/** The person's emergency access to this workspace that is open now, if any. */
export async function activeEmergencyAccess(workspaceId: string, who: Who, now = new Date()): Promise<EmergencyAccess | undefined> {
  const match = whoIs(who);
  if (!match) return undefined;
  const [row] = await db
    .select()
    .from(workspaceEmergencyAccess)
    .where(and(eq(workspaceEmergencyAccess.workspaceId, workspaceId), match, isNull(workspaceEmergencyAccess.endedAt), gt(workspaceEmergencyAccess.expiresAt, now)))
    .limit(1);
  return row;
}

/**
 * Does the super-admin allowlist count for this person in this workspace? Yes when they are on it and the workspace
 * is not restricted, or it is and they hold an active emergency access. Everywhere a workspace decision used to read
 * `config.isSuperAdmin`, it reads this.
 */
export async function superAdminHere(who: Who, workspaceId: string): Promise<boolean> {
  if (!config.isSuperAdmin(who ?? null)) return false;
  if (!(await isRestricted(workspaceId))) return true;
  return !!(await activeEmergencyAccess(workspaceId, who));
}

/**
 * Is this person one of the workspace's OWN admins — a membership row with the `admin` role — or a super admin who
 * counts here? What turning restriction on or off, and renaming or deleting a restricted workspace, require. Never a
 * permission: a platform admin's conferred `members.grant` is exactly what restriction keeps out.
 */
export async function isOwnAdmin(who: Who, workspaceId: string): Promise<boolean> {
  if (await superAdminHere(who, workspaceId)) return true;
  if (!who?.subject) return false;
  const member = await workspaceMemberService.find(workspaceId, who.subject);
  return member?.role === "admin";
}

/**
 * The restricted workspaces this person is OUTSIDE of — not a member, and no open emergency access — by id → name.
 * What every view across workspaces (the list, the access grid, the platform audit, spend, signals) asks, so a
 * restricted workspace shows there as its name only (phase 3). Three short queries for the whole deployment; `null`
 * (no person: a harness, the CLI) is outside every one.
 */
export async function closedTo(who: Who): Promise<Map<string, string>> {
  const restricted = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.restricted, true), isNull(workspaces.deletedAt)));
  const out = new Map(restricted.map((w) => [w.id, w.name]));
  if (!out.size || !who?.subject) return out;
  // Inside = holds anything there, by the resolver every request is checked against (a membership, a custom role, an
  // individual grant or an open emergency access). Dynamic import: the resolver imports this module.
  const { effectivePermissionsService } = await import("./effective-permissions.service.js");
  for (const id of [...out.keys()]) {
    const eff = await effectivePermissionsService.forWorkspace({ subject: who.subject, email: who.email ?? null }, id);
    if (eff.permissions.length > 0) out.delete(id);
  }
  return out;
}

/**
 * One of this workspace's OWN people: a membership row (any role), or a super admin who counts here. Never platform
 * conferral — the emergency-access record and the restriction switch are the workspace's, and a platform admin's
 * conferred `members.read` / `members.grant` (D-9) must not reach them (`rbac:platform-verify`'s bound of 11).
 */
export async function isOwnPerson(who: Who, workspaceId: string): Promise<boolean> {
  if (await superAdminHere(who, workspaceId)) return true;
  if (!who?.subject) return false;
  return !!(await workspaceMemberService.find(workspaceId, who.subject));
}

/** Turn restriction on or off. The caller has already been checked with `isOwnAdmin`. */
export async function setRestricted(workspaceId: string, restricted: boolean, by: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ restricted, restrictedBy: restricted ? by : null, restrictedAt: restricted ? new Date() : null, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}

type Refusal = Error & { statusCode: number };
const refuse = (message: string, statusCode: number): Refusal => Object.assign(new Error(message), { statusCode });

export const EMERGENCY_HOURS = [1, 2, 4] as const;

/**
 * A super admin's emergency access to a restricted workspace (phase 2). Only for a restricted workspace — anywhere
 * else they already have access. One open at a time per person per workspace: asking again while one is open answers
 * that one. Recorded in THAT workspace's audit log, so its admins read it; its admins are emailed when this deployment
 * can send mail, and the answer says whether they were.
 */
export async function startEmergencyAccess(
  workspaceId: string,
  who: { subject: string; email?: string | null },
  input: { reason: string; hours: (typeof EMERGENCY_HOURS)[number] },
): Promise<{ access: EmergencyAccess; notified: string }> {
  if (!config.isSuperAdmin(who)) throw refuse("only a super admin can ask for emergency access", 403);
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws || ws.deletedAt) throw refuse("workspace not found", 404);
  if (!ws.restricted) throw refuse("this workspace is not restricted — you already have access to it", 409);
  const open = await activeEmergencyAccess(workspaceId, who);
  if (open) return { access: open, notified: "already open" };
  const now = new Date();
  const [access] = await db
    .insert(workspaceEmergencyAccess)
    .values({
      workspaceId,
      subject: who.subject,
      email: who.email ? who.email.toLowerCase() : null,
      reason: input.reason,
      startedAt: now,
      expiresAt: new Date(now.getTime() + input.hours * 3_600_000),
    })
    .returning();
  const by = who.email ?? who.subject;
  const until = access!.expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  await auditService.record({
    workspaceId,
    actor: by,
    operation: "access",
    entity: "policy",
    entityId: workspaceId,
    description: `Emergency access to restricted workspace "${ws.name}" by super admin ${by}, until ${until}. Reason: ${input.reason}`,
    whereText: `Organization · ${ws.name}`,
    raw: { emergencyAccessId: access!.id, hours: input.hours },
  });
  const notified = await tellAdmins(workspaceId, ws.name, by, input.reason, until);
  return { access: access!, notified };
}

/** Email the workspace's own admins. Never throws: the access is recorded either way, and the answer says what happened. */
async function tellAdmins(workspaceId: string, name: string, by: string, reason: string, until: string): Promise<string> {
  try {
    const to = (await workspaceMemberService.list(workspaceId))
      .filter((m) => m.role === "admin" && EMAIL_RE.test(m.email) && !isReservedDomain(m.email.split("@")[1] ?? ""))
      .map((m) => m.email);
    if (!to.length) return "not emailed: this workspace has no admin with a deliverable address";
    const sent = await mailService.send({
      subject: `Emergency access to "${name}"`,
      body:
        `${by}, a super admin, opened emergency access to the restricted workspace "${name}" until ${until}.\n\n` +
        `Reason given: ${reason}\n\n` +
        "You can see it, and end it, in the workspace's settings. It is recorded in the workspace's audit log.",
      to,
    });
    return sent.ok ? `emailed ${to.length} admin${to.length === 1 ? "" : "s"}` : `not emailed: ${sent.message}`;
  } catch (e) {
    return `not emailed: ${(e as Error).message}`;
  }
}

/** Open and recent emergency accesses to a workspace — for its admins. */
export async function listEmergencyAccess(workspaceId: string): Promise<EmergencyAccess[]> {
  return db.select().from(workspaceEmergencyAccess).where(eq(workspaceEmergencyAccess.workspaceId, workspaceId)).orderBy(desc(workspaceEmergencyAccess.startedAt)).limit(50);
}

/** End an open emergency access — by the workspace's own admins, or by the super admin who holds it. Audited. */
export async function endEmergencyAccess(workspaceId: string, id: string, who: Who): Promise<EmergencyAccess> {
  const [row] = await db
    .select()
    .from(workspaceEmergencyAccess)
    .where(and(eq(workspaceEmergencyAccess.workspaceId, workspaceId), eq(workspaceEmergencyAccess.id, id)))
    .limit(1);
  if (!row) throw refuse("no such emergency access", 404);
  const holder = (!!who?.subject && who.subject === row.subject) || (!!who?.email && who.email.toLowerCase() === row.email);
  if (!holder && !(await isOwnAdmin(who, workspaceId))) throw refuse("only this workspace's admins, or the person holding it, can end it", 403);
  if (row.endedAt || row.expiresAt <= new Date()) return row;
  const by = who?.email ?? who?.subject ?? "unknown";
  const [ended] = await db
    .update(workspaceEmergencyAccess)
    .set({ endedAt: new Date(), endedBy: by })
    .where(eq(workspaceEmergencyAccess.id, id))
    .returning();
  await auditService
    .record({
      workspaceId,
      actor: by,
      operation: "access",
      entity: "policy",
      entityId: workspaceId,
      description: `Ended ${row.email ?? row.subject}'s emergency access${holder ? " (by them)" : ""}.`,
      whereText: "Organization",
      raw: { emergencyAccessId: id },
    })
    .catch((e) => console.warn(`[restriction] could not record ending emergency access ${id}: ${(e as Error).message}`));
  return ended!;
}
