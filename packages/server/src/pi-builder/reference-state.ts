/**
 * Workflow references — what a session holds and how it is read from the database (references.ts builds the card and
 * writes the folder). Kept out of service.ts so the session code only calls in.
 *
 * Rules (plans/workflow-references-2026-10-16/, a label — plans/ is gitignored):
 * - same workspace only; saved workflows only (a revision whose bundle is a Forge bundle); never the chat's own;
 * - a reference pins ONE saved version; only the person moves it;
 * - the card and the code are kept on the reference, so a deleted workflow's reference stays readable.
 */
import { randomUUID } from "node:crypto";
import { flowRepo } from "../repositories/flow.repo.js";
import { piChatReferenceRepo, type SavedVersion } from "../repositories/pi-chat-reference.repo.js";
import { piFlowService } from "../services/pi-flow.service.js";
import { contentVisibility, type Viewer } from "../services/content-visibility.service.js";
import { buildCard, slugFor, versionLabel, type FolderReference, type ReferenceBundle } from "./references.js";

export type SessionRef = {
  /** The row id once stored; a temporary id while the chat has no record yet (before the first message). */
  id: string;
  stored: boolean;
  /** Null once the referenced workflow has been deleted. */
  flowId: string | null;
  name: string;
  revision: number;
  approvedAs: number | null;
  cardMd: string;
  bundle: ReferenceBundle;
  addedBy: string | null;
};

/** What the chips show. */
export type ReferenceView = {
  id: string;
  flowId: string | null;
  name: string;
  revision: number;
  label: string;
  cardMd: string;
  deleted: boolean;
  /** The newest saved version, when it is newer than the pinned one. */
  newer: number | null;
  /** Every saved version, oldest first — the version list. Empty for a deleted workflow. */
  versions: Array<{ revision: number; savedAt: string | null; approvedAs: number | null; label: string }>;
};

export type Referenceable = {
  flowId: string;
  name: string;
  latest: number;
  latestLabel: string;
  savedAt: string | null;
};

class RefError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

/** Saved versions of the workspace's Forge workflows, keyed by flow. */
async function versionsOf(workspaceId: string, flowIds: string[]): Promise<Map<string, SavedVersion[]>> {
  return piChatReferenceRepo.savedVersions(workspaceId, flowIds);
}

/**
 * The workspace's saved workflows a chat may reference — never the chat's own, and (given a viewer) only those the
 * person may see: somebody else's private draft is not offered (rbac-observability).
 */
export async function listReferenceable(workspaceId: string, ownFlowId: string | null, viewer?: Viewer): Promise<Referenceable[]> {
  const flows = (await flowRepo.listByWorkspace(workspaceId)).filter(
    (f) => f.runtime === "foundry" && f.id !== ownFlowId && (!viewer || contentVisibility.flowVisible(viewer, f)),
  );
  const versions = await versionsOf(workspaceId, flows.map((f) => f.id));
  const out: Referenceable[] = [];
  for (const f of flows) {
    const v = versions.get(f.id);
    const last = v?.[v.length - 1];
    if (!last) continue; // never saved
    out.push({ flowId: f.id, name: f.name, latest: last.revision, latestLabel: versionLabel(last.revision, last.approvedAs), savedAt: last.savedAt?.toISOString() ?? null });
  }
  return out;
}

/** One saved version of one workflow, as a reference holds it: name, card and code. Refuses what cannot be referenced. */
export async function snapshotOf(
  workspaceId: string,
  flowId: string,
  revision?: number,
  viewer?: Viewer,
): Promise<Omit<SessionRef, "id" | "stored" | "addedBy">> {
  const flow = await flowRepo.get(workspaceId, flowId);
  // A workflow the person may not see reads exactly as one that is not there (404, never 403).
  if (!flow || (viewer && !contentVisibility.flowVisible(viewer, flow))) throw new RefError("That workflow is not in this workspace.", 404);
  if (flow.runtime !== "foundry") throw new RefError("That workflow was built with the previous builder and cannot be referenced.", 409);
  const versions = (await versionsOf(workspaceId, [flowId])).get(flowId) ?? [];
  if (!versions.length) throw new RefError("That workflow has no saved version yet. Only saved workflows can be referenced.", 409);
  const want = revision ?? versions[versions.length - 1]!.revision;
  const v = versions.find((x) => x.revision === want);
  if (!v) throw new RefError(`That workflow has no saved version ${want}.`, 404);
  const { model } = await piFlowService.load(workspaceId, flowId, want);
  const bundle: ReferenceBundle = { workflow: model.workflow as ReferenceBundle["workflow"], files: model.files ?? {} };
  return {
    flowId,
    name: flow.name,
    revision: want,
    approvedAs: v.approvedAs,
    cardMd: buildCard({ name: flow.name, description: flow.description, revision: want, savedAt: v.savedAt, approvedAs: v.approvedAs, bundle }),
    bundle,
  };
}

/** A chat's stored references. */
export async function loadRefs(workspaceId: string, chatId: string): Promise<SessionRef[]> {
  const rows = await piChatReferenceRepo.listByChat(workspaceId, chatId);
  const versions = await versionsOf(workspaceId, rows.flatMap((r) => (r.flowId ? [r.flowId] : [])));
  return rows.map((r) => ({
    id: r.id,
    stored: true,
    flowId: r.flowId,
    name: r.flowNameSnapshot,
    revision: r.revision,
    approvedAs: (r.flowId ? versions.get(r.flowId)?.find((v) => v.revision === r.revision)?.approvedAs : null) ?? null,
    cardMd: r.cardMd,
    bundle: r.bundleJson as ReferenceBundle,
    addedBy: r.addedBySubject,
  }));
}

/** Store a reference held on a session before its chat had a record. */
export async function storeRef(workspaceId: string, chatId: string, r: SessionRef): Promise<SessionRef> {
  const row = await piChatReferenceRepo.add({
    chatId,
    workspaceId,
    flowId: r.flowId!,
    flowNameSnapshot: r.name.slice(0, 200),
    revision: r.revision,
    cardMd: r.cardMd,
    bundleJson: r.bundle,
    addedBySubject: r.addedBy,
  });
  return { ...r, id: row.id, stored: true };
}

export function newRef(snap: Omit<SessionRef, "id" | "stored" | "addedBy">, addedBy: string | null): SessionRef {
  return { ...snap, id: randomUUID(), stored: false, addedBy };
}

/**
 * The flows a session's references point at that are gone now (deleted, or moved out of the workspace). Their
 * references stay, readable from the copy, marked deleted.
 */
export async function goneFlows(workspaceId: string, refs: SessionRef[]): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const r of refs) {
    if (r.flowId && !(await flowRepo.get(workspaceId, r.flowId))) gone.add(r.flowId);
  }
  return gone;
}

/** The references as the folder and the prompt see them, each with its folder name. */
export function folderRefs(refs: SessionRef[]): FolderReference[] {
  const taken = new Set<string>();
  return refs.map((r) => ({
    slug: slugFor(r.name, taken),
    name: r.name,
    label: versionLabel(r.revision, r.approvedAs),
    cardMd: r.cardMd,
    bundle: r.bundle,
    deleted: r.flowId === null,
  }));
}

/** The references as the chips show them: pinned version, a newer one if any, and the version list. */
export async function viewsOf(workspaceId: string, refs: SessionRef[]): Promise<ReferenceView[]> {
  const versions = await versionsOf(workspaceId, refs.flatMap((r) => (r.flowId ? [r.flowId] : [])));
  return refs.map((r) => {
    const v = (r.flowId && versions.get(r.flowId)) || [];
    const last = v[v.length - 1];
    const deleted = r.flowId === null || v.length === 0;
    return {
      id: r.id,
      flowId: r.flowId,
      name: r.name,
      revision: r.revision,
      label: versionLabel(r.revision, r.approvedAs),
      cardMd: r.cardMd,
      deleted,
      newer: !deleted && last && last.revision > r.revision ? last.revision : null,
      versions: deleted
        ? []
        : v.map((x) => ({ revision: x.revision, savedAt: x.savedAt?.toISOString() ?? null, approvedAs: x.approvedAs, label: versionLabel(x.revision, x.approvedAs) })),
    };
  });
}
