// src/app/(app)/admin/roles/page.tsx — What each role can do (admin simplify, phase 5).
//
// One question: what does each role let somebody do. Read-only: access is given by choosing a role on a person's page
// or a workspace's Members tab, never here. Platform roles are listed with who holds them. Custom roles and one
// member's individual permissions are kept under Advanced, for the workspace named in the URL.
//
// ⚠ The ticks are not written in the browser. Each row names the permissions it stands for (`lib/role-matrix.ts`) and
// each cell is worked out from the permissions the server says that built-in role holds, so the table follows the
// presets. A cell a role holds only partly is shown as such rather than rounded either way.
"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { Check } from "@/components/ui/icons";
import { useAsync } from "@/lib/hooks";
import { listWorkspaceRoles, listWorkspaces } from "@/lib/api";
import { PermissionsProvider } from "@/lib/permissions";
import { WorkspaceRolesPanel } from "@/components/access/WorkspaceRolesPanel";
import { IndividualPermissions } from "@/components/access/IndividualPermissions";
import { PlatformRoleList } from "@/components/access/PlatformRoleList";
import { useCanPlatform } from "@/components/access/Can";
import { ROLE_HINT, ROLE_LABEL, WORKSPACE_ROLES } from "@/lib/role-labels";
import { MATRIX_ROWS, cellFor, presetsFrom } from "@/lib/role-matrix";
import { ADMIN_EYEBROW } from "@/components/admin/AdminGate";

export default function RolesPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <Roles />
    </Suspense>
  );
}

function Roles() {
  const router = useRouter();
  const search = useSearchParams();
  const spaces = useAsync(() => listWorkspaces(), []);
  const list = spaces.data ?? [];
  const chosen = list.find((w) => w.id === search.get("workspace")) ?? list[0] ?? null;
  const roles = useAsync(() => (chosen ? listWorkspaceRoles(chosen.id) : Promise.resolve(null)), [chosen?.id]);
  const presets = roles.data ? presetsFrom(roles.data) : null;
  const failed = spaces.error ?? roles.error;
  const seesPeople = !useCanPlatform("platform.users.read").denied;

  return (
    <Page>
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title="Roles"
        purpose="What each role can do. Give someone a role on their page or in a workspace's Members."
      />
      <Zone name="content">
        <section className="pane overflow-x-auto" aria-label="What each role can do">
          {failed ? (
            <p className="px-4 py-3 text-caption text-warn">The roles could not be read, so nothing is shown. ({failed})</p>
          ) : spaces.data && !chosen ? (
            <p className="px-4 py-3 text-caption text-muted">There is no workspace yet to read the roles from.</p>
          ) : !presets ? (
            <div className="p-4"><Skeleton rows={6} /></div>
          ) : (
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-line text-left text-caption text-muted">
                  <th className="px-4 py-2.5 font-normal">Can…</th>
                  {WORKSPACE_ROLES.map((r) => (
                    <th key={r} className="w-24 px-2 py-2.5 text-center font-semibold text-text" title={ROLE_HINT[r]}>
                      {ROLE_LABEL[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX_ROWS.map((row) => (
                  <tr key={row.label} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="text-text">{row.label}</span>
                      {row.note && <span className="block text-caption text-muted">{row.note}</span>}
                    </td>
                    {WORKSPACE_ROLES.map((r) => {
                      const held = presets[r];
                      const cell = held ? cellFor(row, held) : null;
                      const say = cell === "yes" ? "Yes" : cell === "partly" ? "Partly" : cell === "no" ? "No" : "Not known";
                      return (
                        <td key={r} className="px-2 py-2.5 text-center" aria-label={`${ROLE_LABEL[r]}: ${say}`}>
                          {cell === "yes" ? (
                            <Check className="mx-auto h-4 w-4 text-accent" aria-hidden />
                          ) : cell === "partly" ? (
                            <span className="text-caption text-warn">Partly</span>
                          ) : (
                            <span className="text-dim" aria-hidden>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {seesPeople && <PlatformRoleList />}

        {chosen && (
          <details className="pane">
            <summary className="cursor-pointer px-4 py-3 text-body font-semibold">Advanced: custom roles and individual permissions</summary>
            <div className="border-t border-line px-4 py-3">
              <label className="mb-4 flex items-center gap-2 text-caption text-muted">
                Workspace
                <Select
                  value={chosen.id}
                  onChange={(e) => router.replace(`/admin/roles?workspace=${encodeURIComponent(e.target.value)}`)}
                  aria-label="Workspace for custom roles"
                  className="w-56"
                >
                  {list.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              </label>
              <PermissionsProvider workspaceId={chosen.id}>
                <h3 className="mb-2 text-body font-semibold">Custom roles</h3>
                <WorkspaceRolesPanel workspaceId={chosen.id} />
                <h3 className="mb-2 mt-6 text-body font-semibold">Individual permissions</h3>
                <p className="mb-2 text-caption text-muted">Extra permissions for one member here, on top of their role.</p>
                <IndividualPermissions workspaceId={chosen.id} />
              </PermissionsProvider>
            </div>
          </details>
        )}
      </Zone>
    </Page>
  );
}
