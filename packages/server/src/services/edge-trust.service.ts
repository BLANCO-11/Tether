/**
 * Persisted edge trust rules (allow / deny / directory grants) per workspace owner.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { edgeTrustRules } from "../db/schema.js";
import {
  commandTrustPattern,
  evaluateEdgeJobApproval,
  folderPatternFromJob,
  type EdgeTrustEffect,
  type EdgeTrustRule,
  type EdgeTrustScope,
} from "./edge-command-allowlist.js";
import type { EdgeJobKind } from "./edge-device.service.js";

export type EdgeAlways = "command" | "path_read" | "deny";

const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export async function loadEdgeTrustRules(workspaceId: string, ownerSubject: string): Promise<EdgeTrustRule[]> {
  const rows = await db
    .select({
      effect: edgeTrustRules.effect,
      scope: edgeTrustRules.scope,
      pattern: edgeTrustRules.pattern,
    })
    .from(edgeTrustRules)
    .where(and(eq(edgeTrustRules.workspaceId, workspaceId), eq(edgeTrustRules.ownerSubject, ownerSubject)));
  return rows.map((r) => ({
    effect: r.effect as EdgeTrustEffect,
    scope: r.scope as EdgeTrustScope,
    pattern: r.pattern,
  }));
}

/** Whether this job needs in-chat / Needs-you approval, applying built-in allowlist + persisted rules. */
export async function edgeJobNeedsApprovalForOwner(
  workspaceId: string,
  ownerSubject: string,
  kind: EdgeJobKind,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const rules = await loadEdgeTrustRules(workspaceId, ownerSubject);
  return evaluateEdgeJobApproval(kind, payload, rules).needsApproval;
}

async function upsertRule(
  workspaceId: string,
  ownerSubject: string,
  createdBy: string,
  effect: EdgeTrustEffect,
  scope: EdgeTrustScope,
  pattern: string,
): Promise<void> {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > 500) throw httpErr("That trust pattern is not valid.", 400);
  await db
    .insert(edgeTrustRules)
    .values({
      workspaceId,
      ownerSubject,
      effect,
      scope,
      pattern: trimmed,
      createdBy,
    })
    .onConflictDoNothing();
}

/** Persist a directory grant (read + write) for an explicit folder path. */
export async function grantEdgeFolder(
  workspaceId: string,
  ownerSubject: string,
  createdBy: string,
  folder: string,
): Promise<string> {
  const trimmed = folder.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.length > 500) throw httpErr("That folder is not valid.", 400);
  await upsertRule(workspaceId, ownerSubject, createdBy, "allow", "path_read", trimmed);
  await upsertRule(workspaceId, ownerSubject, createdBy, "allow", "path_write", trimmed);
  return trimmed;
}

/**
 * Persist Always-allow / Deny-always from the Edge Approve card, then the job can be approved or revoked.
 * `folderOverride` — when granting a directory from the dock (common ancestor of several pending jobs).
 */
export async function applyEdgeAlways(
  workspaceId: string,
  ownerSubject: string,
  createdBy: string,
  always: EdgeAlways,
  kind: EdgeJobKind,
  payload: Record<string, unknown>,
  folderOverride?: string | null,
): Promise<string | null> {
  if (always === "command" || always === "deny") {
    const cmd = typeof payload.command === "string" ? payload.command : "";
    // Family first (`docker`, `npm`) so Allow always covers later variants — not one fragile argv string.
    const pattern = commandTrustPattern(cmd);
    if (!pattern) throw httpErr("Cannot remember that command — name a tool like docker or npm.", 400);
    await upsertRule(workspaceId, ownerSubject, createdBy, always === "deny" ? "deny" : "allow", "command", pattern);
    return pattern;
  }
  if (always === "path_read") {
    const folder = (folderOverride?.trim() || folderPatternFromJob(kind, payload) || "").replace(/\/+$/, "");
    if (!folder) throw httpErr("Cannot remember a folder for this job — need a single safe path.", 400);
    return grantEdgeFolder(workspaceId, ownerSubject, createdBy, folder);
  }
  return null;
}
