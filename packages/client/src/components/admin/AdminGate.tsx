// src/components/admin/AdminGate.tsx — the four access states every Admin page shows, written once.
//
// ── WHY THIS EXISTS (2026-10-12) ────────────────────────────────────────────
//
// Overview, Release gates, Incidents and Audit each carried the same ~40 lines: checking · could not check · not
// allowed · no workspace selected — and the wording had drifted between them. One component, one set of words.
//
// ⚠ **FOUR STATES, NOT TWO.** "We could not check" renders as neither answer: not as "you may not" (the deleted
// `faFallback` shape) and not as "you may". And "no workspace selected" is nobody having asked yet — neither a
// refusal nor a failed check.
//
// ⚠ **HIDING IS NEVER THE ENFORCEMENT.** Every route behind these pages refuses on its own; this decides only what
// is offered. The `allowed` test is the CALLER's — this component does not decide who may see a page, so moving a
// page onto it cannot change its access.
"use client";

import type { ReactNode } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAsync } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import { getMe, listWorkspaces } from "@/lib/api";
import { ACCESS_UNKNOWN, NOT_SUPER_ADMIN, NO_SUPER_ADMIN_CONFIGURED } from "@/lib/workspace-access-copy";

type Me = NonNullable<Awaited<ReturnType<typeof getMe>>>;
type Spaces = { data: Awaited<ReturnType<typeof listWorkspaces>> | null; error: string | null };

/** Every Admin page's eyebrow — where the page sits, not a second title. */
export const ADMIN_EYEBROW = "Admin";

/**
 * The page while access is being checked: the header and a page-shaped placeholder. The sentence is for a screen
 * reader — a sighted person sees the placeholder, and "Checking your access…" as a subtitle read as the page's purpose.
 */
export function AdminSkeleton({ title }: { title: string }) {
  return (
    <Page measure="wide">
      <PageHeader eyebrow={ADMIN_EYEBROW} title={title} />
      <Zone name="content">
        <p className="sr-only" role="status">Checking your access…</p>
        <div className="pane p-4"><Skeleton rows={2} /></div>
        <div className="pane p-4"><Skeleton rows={6} /></div>
      </Zone>
    </Page>
  );
}

/** A state that has only something to SAY: the header and one notice. */
export function AdminNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page measure="wide">
      <PageHeader eyebrow={ADMIN_EYEBROW} title={title} />
      <Zone name="notices">{children}</Zone>
    </Page>
  );
}

/** The super-admin test these pages have always used. Kept as it was — see the docblock on access. */
export const superAdminOrAdmin = (me: Me) => !!(me.superAdmin || me.capabilities?.includes("admin"));

export function AdminGate({
  title,
  allowed = superAdminOrAdmin,
  needsWorkspace,
  children,
}: {
  title: string;
  allowed?: (me: Me) => boolean;
  /** What the page reads from the workspace, for the "No workspace selected" sentence — omit if it reads none. */
  needsWorkspace?: string;
  children: (ctx: { workspaceId: string | null; me: Me; workspaces: Spaces }) => ReactNode;
}) {
  const { workspaceId } = useWorkspace();
  const me = useAsync(() => getMe(workspaceId), [workspaceId]);
  const workspaces = useAsync(listWorkspaces);

  // ⚠ `!me.data`, never `me.loading`: a re-read must not replace a working page with a placeholder.
  if (!me.data && !me.error) return <AdminSkeleton title={title} />;
  if (!me.data) {
    return (
      <AdminNotice title={title}>
        <Notice tone="warn" title="Access could not be checked">
          {ACCESS_UNKNOWN}
          {me.error ? ` (${me.error})` : ""}
        </Notice>
      </AdminNotice>
    );
  }
  if (!allowed(me.data)) {
    return (
      <AdminNotice title={title}>
        <Notice tone="warn" title={me.data.superAdminConfigured ? "Restricted to a super admin" : "No super admin is configured"}>
          {me.data.superAdminConfigured ? NOT_SUPER_ADMIN : NO_SUPER_ADMIN_CONFIGURED}
        </Notice>
      </AdminNotice>
    );
  }
  if (needsWorkspace && !workspaceId) {
    return (
      <AdminNotice title={title}>
        <Notice tone="warn" title="No workspace selected">
          Pick a workspace in the workspace switcher to read its {needsWorkspace}.
        </Notice>
        {workspaces.error && <Notice tone="danger" title="Could not load workspaces">{workspaces.error}</Notice>}
      </AdminNotice>
    );
  }
  return <>{children({ workspaceId, me: me.data, workspaces })}</>;
}
