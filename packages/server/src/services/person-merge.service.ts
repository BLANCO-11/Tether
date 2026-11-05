import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { invitationService } from "./invitation.service.js";

/**
 * One person, one record (admin simplify, phase 1 — plans/admin-simplify-2026-10-30).
 *
 * A person is keyed on their sign-in id (`subject`). Two ids can turn out to be one person, and when they do the
 * person's access silently stops applying: a role held under the old id is not looked up under the new one. This
 * module moves a person's ACCESS and what they OWN to their current id, and records the old id in
 * `platform_user_aliases` so HISTORY written under it (audit, approvals, usage, runs) still names them. History is
 * never rewritten.
 *
 * ⚠ **When it runs on its own: only when the old id IS the person's email address.** That id was written by somebody
 * who meant "the person with this email" (an admin typing an email where an id was asked for, or an older sign-in).
 * Two different sign-in ids that share an email are NEVER merged on their own: a reused mailbox would hand a new
 * person a former employee's access. That case is an admin's decision (`reason: "admin_merge"`).
 */

/** Access rows with a unique key that includes the subject: the other columns of that key. */
const UNIQUE_ACCESS: { table: string; subject: string; key: string[] }[] = [
  { table: "workspace_role_assignments", subject: "subject", key: ["workspace_id", "role_id"] },
  { table: "workspace_member_capabilities", subject: "subject", key: ["workspace_id", "capability"] },
  { table: "platform_role_assignments", subject: "subject", key: ["role_key"] },
  { table: "project_members", subject: "subject", key: ["project_id"] },
  { table: "plugin_personal_actions", subject: "subject", key: ["workspace_id", "piece", "action"] },
  { table: "person_account_choices", subject: "subject", key: ["workspace_id", "piece"] },
  { table: "pins", subject: "subject", key: ["workspace_id", "flow_id"] },
  { table: "flow_activations", subject: "subject", key: ["flow_id"] },
];

/** What the person owns or is told: moved whole. Columns recording who DID something are history and stay. */
const OWNERSHIP: { table: string; column: string }[] = [
  { table: "flows", column: "owner_subject" },
  { table: "pi_chats", column: "created_by_subject" },
  { table: "projects", column: "owner_subject" },
  { table: "plugin_connections", column: "owner_subject" },
  { table: "datasources", column: "owner_subject" },
  { table: "incidents", column: "owner_subject" },
  { table: "notifications", column: "subject" },
];

export type MergeReason = "email_was_id" | "admin_merge";

export interface MergeResult {
  from: string;
  to: string;
  /** Rows moved per table (only tables where something moved). */
  moved: Record<string, number>;
}

function looksLikeEmail(v: string | null | undefined): v is string {
  return !!v && /^[^@\s]+@[^@\s]+$/.test(v.trim());
}

async function mergeIn(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  from: string,
  to: string,
  opts: { reason: MergeReason; mergedBy: string | null; email: string | null },
): Promise<MergeResult> {
  const moved: Record<string, number> = {};
  const count = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;

  // Workspace membership: where both ids are members, the stronger role (admin > approver > author > viewer) stays.
  await tx.execute(sql`
    UPDATE workspace_members n SET role = o.role
      FROM workspace_members o
     WHERE o.subject = ${from} AND n.subject = ${to} AND n.workspace_id = o.workspace_id
       AND (CASE o.role WHEN 'admin' THEN 4 WHEN 'approver' THEN 3 WHEN 'author' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
         > (CASE n.role WHEN 'admin' THEN 4 WHEN 'approver' THEN 3 WHEN 'author' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)`);
  await tx.execute(sql`
    DELETE FROM workspace_members o
     WHERE o.subject = ${from}
       AND EXISTS (SELECT 1 FROM workspace_members n WHERE n.subject = ${to} AND n.workspace_id = o.workspace_id)`);
  const wm = await tx.execute(sql`UPDATE workspace_members SET subject = ${to} WHERE subject = ${from}`);
  if (count(wm)) moved.workspace_members = count(wm);

  // Other access: where the current id already holds the same thing, the current id's row stands.
  for (const u of UNIQUE_ACCESS) {
    const t = sql.identifier(u.table);
    const s = sql.identifier(u.subject);
    const same = sql.join(
      u.key.map((k) => sql`n.${sql.identifier(k)} = o.${sql.identifier(k)}`),
      sql` AND `,
    );
    await tx.execute(sql`
      DELETE FROM ${t} o WHERE o.${s} = ${from}
         AND EXISTS (SELECT 1 FROM ${t} n WHERE n.${s} = ${to} AND ${same})`);
    const r = await tx.execute(sql`UPDATE ${t} SET ${s} = ${to} WHERE ${s} = ${from}`);
    if (count(r)) moved[u.table] = count(r);
  }

  for (const o of OWNERSHIP) {
    const r = await tx.execute(
      sql`UPDATE ${sql.identifier(o.table)} SET ${sql.identifier(o.column)} = ${to} WHERE ${sql.identifier(o.column)} = ${from}`,
    );
    if (count(r)) moved[`${o.table}.${o.column}`] = count(r);
  }

  // The signed-in list: one row, on the current id, keeping the earliest first sight and any chosen Forge mode.
  await tx.execute(sql`
    INSERT INTO platform_users (subject, email, name, forge_default_mode, first_seen_at, last_seen_at)
    SELECT ${to}, COALESCE(${opts.email}, o.email), o.name, o.forge_default_mode, o.first_seen_at, o.last_seen_at
      FROM platform_users o WHERE o.subject = ${from}
    ON CONFLICT (subject) DO UPDATE SET
      first_seen_at = LEAST(platform_users.first_seen_at, excluded.first_seen_at),
      forge_default_mode = COALESCE(platform_users.forge_default_mode, excluded.forge_default_mode)`);
  const pu = await tx.execute(sql`DELETE FROM platform_users WHERE subject = ${from}`);
  if (count(pu)) moved.platform_users = count(pu);

  await tx.execute(sql`
    INSERT INTO platform_user_aliases (old_subject, subject, email, reason, merged_by)
    VALUES (${from}, ${to}, ${opts.email}, ${opts.reason}, ${opts.mergedBy})
    ON CONFLICT (old_subject) DO NOTHING`);
  // An id that was itself merged into `from` earlier now points at `to`, so history resolves in one step.
  await tx.execute(sql`UPDATE platform_user_aliases SET subject = ${to} WHERE subject = ${from}`);

  return { from, to, moved };
}

/** Subjects processed this process lifetime: the email check runs once per person per process, not per request. */
const checked = new Set<string>();

/** Test seam. */
export function _resetPersonMergeCache(): void {
  checked.clear();
}

export const personMergeService = {
  /**
   * Fold `from` into `to`. Refuses to merge an id into itself or to touch a local account's id as the OLD one (a
   * local account is `local:<row id>`, deactivated and never deleted, so its id must keep meaning that account).
   */
  async merge(
    from: string,
    to: string,
    opts: { reason: MergeReason; mergedBy?: string | null; email?: string | null },
  ): Promise<MergeResult> {
    if (!from.trim() || !to.trim()) throw Object.assign(new Error("both ids are required"), { statusCode: 400 });
    if (from === to) throw Object.assign(new Error("an id cannot be merged into itself"), { statusCode: 400 });
    if (from.startsWith("local:")) {
      throw Object.assign(new Error("a local account's id is never merged away"), { statusCode: 409 });
    }
    return db.transaction((tx) =>
      mergeIn(tx, from, to, { reason: opts.reason, mergedBy: opts.mergedBy ?? null, email: opts.email ?? null }),
    );
  },

  /**
   * Ids that are this person's email address, written somewhere a person's access or record lives, other than the
   * person's own id. Case-insensitive on the email.
   */
  async emailIdsFor(identity: { subject: string; email?: string | null }): Promise<string[]> {
    const email = identity.email?.trim();
    if (!looksLikeEmail(email)) return [];
    const res = await db.execute(sql`
      SELECT DISTINCT subject FROM (
        SELECT subject FROM platform_users
        UNION ALL SELECT subject FROM workspace_members
        UNION ALL SELECT subject FROM platform_role_assignments
        UNION ALL SELECT subject FROM project_members
      ) s
      WHERE lower(subject) = lower(${email}) AND subject <> ${identity.subject}`);
    return (res.rows as { subject: string }[]).map((r) => r.subject);
  },

  /**
   * Called, AWAITED, the first time this process sees a person: an id that is their email becomes theirs, and any
   * invitation for their email is redeemed, before the request is authorised — so access given by email applies on the
   * very first page. Never throws; a failure is logged
   * and retried on the person's next request.
   */
  async onFirstSight(identity: { subject?: string | null; email?: string | null }): Promise<void> {
    const subject = identity.subject?.trim();
    if (!subject || checked.has(subject)) return;
    try {
      const ids = await this.emailIdsFor({ subject, email: identity.email });
      for (const from of ids) {
        const r = await this.merge(from, subject, { reason: "email_was_id", email: identity.email ?? null });
        console.info(`[person-merge] ${from} → ${subject}: ${JSON.stringify(r.moved)}`);
      }
      // Then any invitation waiting for this email (phase 2): their workspaces and roles, in place before page one.
      const got = await invitationService.redeem({ subject, email: identity.email });
      if (got.workspaces || got.platformRole) {
        console.info(`[invitation] ${subject}: ${got.workspaces} workspace(s)${got.platformRole ? `, ${got.platformRole}` : ""}`);
      }
      checked.add(subject);
    } catch (e) {
      console.warn(`[person-merge] could not check ${subject}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
