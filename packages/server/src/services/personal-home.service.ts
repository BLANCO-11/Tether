/**
 * Personal-fork home workspace — every signed-in person gets one.
 *
 * Enterprise Foundry refuses an empty membership with /no-access and a
 * SUPER_ADMIN_EMAILS lecture. That is wrong here: sign-in must land in a usable
 * product, so the first workspace list for a memberless identity creates
 * "Personal" and grants them admin.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers } from "../db/schema.js";
import { PERSONAL_HOME_NAME, PERSONAL_HOME_PURPOSE, PERSONAL_PRODUCT } from "../personal.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { workspaceService } from "./workspace.service.js";
import { workspaceMemberService } from "./workspace-member.service.js";

export type HomeIdentity = { subject: string; email?: string | null };

export const personalHomeService = {
  /**
   * Ensure `user` has at least one workspace membership. Idempotent.
   * Returns the home workspace id when it created or repaired one; otherwise null.
   */
  async ensureHome(user: HomeIdentity): Promise<string | null> {
    if (!PERSONAL_PRODUCT) return null;
    if (!user.subject) return null;

    const mine = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.subject, user.subject))
      .limit(1);
    if (mine.length > 0) return null;

    const email = (user.email ?? "").trim() || `${user.subject}@local`;

    // Reuse an empty Personal workspace if one already exists (fresh stack / race).
    const rows = await workspaceRepo.list();
    const existing = rows.find((w) => w.name === PERSONAL_HOME_NAME && (w.kind == null || w.kind === ""));
    if (existing) {
      const members = await workspaceMemberService.list(existing.id);
      if (!members.some((m) => m.subject === user.subject)) {
        await workspaceMemberService.grant(
          existing.id,
          { subject: user.subject, email, role: "admin" },
          email,
          { bySuperAdmin: true },
        );
      }
      return existing.id;
    }

    const created = await workspaceService.create({
      name: PERSONAL_HOME_NAME,
      description: PERSONAL_HOME_PURPOSE,
      assistant: true,
    });
    await workspaceMemberService.grant(
      created.id,
      { subject: user.subject, email, role: "admin" },
      email,
      { bySuperAdmin: true },
    );
    return created.id;
  },
};
