/**
 * What happens to a person's workflows when they leave a workspace (sharing-boundaries phase 1, 2026-10-30).
 *
 * They become OWNERLESS, which means "the Admins'": an Admin sees them, changes them, hands them to somebody and
 * decides their runs' pauses (`contentVisibility.mayDecidePause`). Who sees them does not change — a private one stays
 * private (now visible only to Admins), a public one stays public.
 *
 * ⚠ One that its owner switched on with no reviewer is turned off, saying why: that was the leaver's choice about
 * their own things, and with them gone nothing is "only the owner's" any more. One acting as the leaver's own account
 * is already turned off by the run-as check when their personal connections go (plugins 8.7); this does not repeat it.
 */
import { flowRepo } from "../repositories/flow.repo.js";
import { flowApprovalService } from "./flow-approval.service.js";
import { auditService } from "./audit.service.js";

export async function releaseOwnedBy(workspaceId: string, subject: string, actor: string): Promise<number> {
  const owned = (await flowRepo.listByWorkspace(workspaceId)).filter((f) => f.ownerSubject === subject);
  for (const flow of owned) {
    await flowRepo.setOwner(workspaceId, flow.id, null);
    if (flow.armedRevision != null) {
      const current = await flowRepo.currentApproval(flow.id, flow.armedRevision);
      if (current?.selfEnabled) {
        await flowApprovalService.revoke(workspaceId, flow.id, {
          reason: "Its owner left the workspace. They had switched it on themselves; an Admin now looks after it, and a reviewer approves it again.",
          revokedBy: actor,
        });
      }
    }
    await auditService
      .record({
        workspaceId,
        actor,
        operation: "update",
        entity: "flow",
        entityId: flow.id,
        description: `"${flow.name}" has no owner now: its owner left the workspace, and Admins look after it`,
        whereText: flow.name,
        whereEntityType: "flow",
        whereEntityId: flow.id,
      })
      .catch((e) => console.error("[flows] ownership release not audited:", e));
  }
  return owned.length;
}
