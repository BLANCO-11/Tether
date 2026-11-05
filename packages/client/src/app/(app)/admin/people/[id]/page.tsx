// src/app/(app)/admin/people/[id]/page.tsx — one person (admin simplify, phase 3).
//
// One question: where does this person work, and as what. Each workspace with their role (changed in place), what that
// lets them see, and Remove; then add them somewhere else; their platform role; and, for a local account, the account.
//
// ⚠ The role is changed where it is shown and nowhere else. Every control is offered only where the server said the
// reader may use it (`canAddPeople`, `can.*`), and every write is still checked by its own route.
"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Tag } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Confirm } from "@/components/ui/Confirm";
import { Modal } from "@/components/ui/Modal";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useCanPlatform } from "@/components/access/Can";
import { foundryApi, type FAPeopleView, type FAPerson, type FAPersonWorkspace, type FAWorkspaceRole } from "@/lib/foundry-client";
import { deleteLocalUser, grantLocalUserAccess, grantMember, revokeLocalUserAccess, revokeMember, setLocalUserActive, setLocalUserPassword } from "@/lib/api";
import { ROLE_HINT, ROLE_LABEL, WORKSPACE_ROLES, roleLabel } from "@/lib/role-labels";
import { MIN_PASSWORD, REACH_LINE, displayName, lastSeenLabel } from "@/lib/people";
import { ADMIN_EYEBROW } from "@/components/admin/AdminGate";

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const subject = decodeURIComponent(String(params?.id ?? ""));
  const read = useCanPlatform("platform.users.read");
  const view = useAsync(() => (read.denied ? Promise.resolve(null) : foundryApi.getPeople()), [read.denied]);
  const person = view.data?.people.find((p) => p.subject === subject) ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title={person ? displayName(person) : "Person"}
        purpose={person?.name && person.email ? person.email : undefined}
      />
      <Zone name="notices">
        <Link href="/admin/people" className="text-caption text-muted hover:text-text">← People</Link>
        {read.denied ? (
          <Notice tone="info" title="This needs permission to see the deployment's people">Ask a super admin or a platform administrator.</Notice>
        ) : view.error ? (
          <Notice tone="danger" title="Could not load this person">{view.error}</Notice>
        ) : view.data && !person ? (
          <Notice tone="warn" title="Not found">Nobody with this id is known here. They may have been merged into another record.</Notice>
        ) : null}
      </Zone>
      {!view.data && !view.error && !read.denied && (
        <Zone name="content"><div className="pane p-4"><Skeleton rows={4} /></div></Zone>
      )}
      {view.data && person && <PersonDetail view={view.data} p={person} reload={view.reload} />}
    </Page>
  );
}

function PersonDetail({ view, p, reload }: { view: FAPeopleView; p: FAPerson; reload: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [removing, setRemoving] = useState<FAPersonWorkspace | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [addWs, setAddWs] = useState("");
  const [addRole, setAddRole] = useState<FAWorkspaceRole>("author");
  const [addPlatform, setAddPlatform] = useState("");
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");

  const canIn = (id: string) => view.workspaces.find((w) => w.id === id)?.canAddPeople === true;
  const memberships = p.workspaces.filter((w) => w.role || !p.superAdmin);
  const elsewhere = view.workspaces.filter((w) => w.canAddPeople && !p.workspaces.some((m) => m.id === w.id && m.role));
  const email = p.email || (p.localAccount ? `${p.localAccount.username}@local` : "");

  const run = async (what: () => Promise<unknown>, done: string) => {
    try {
      await what();
      toast.success(done);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  // A local account has its own access routes: its email may be `name@local`, which the member route refuses.
  const setRole = (workspaceId: string, role: FAWorkspaceRole) =>
    p.localAccount ? grantLocalUserAccess(p.localAccount.id, workspaceId, role) : grantMember(workspaceId, { subject: p.subject, email, role });
  const remove = (workspaceId: string) =>
    p.localAccount ? revokeLocalUserAccess(p.localAccount.id, workspaceId) : revokeMember(workspaceId, p.subject);

  return (
    <>
      <Zone name="content">
        <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
          <span>{p.signIn === "local" ? "Local account" : "Signs in with Microsoft"}</span>
          <span aria-hidden>·</span>
          <span>Last seen: {lastSeenLabel(p.lastSeenAt)}</span>
          {p.superAdmin && <Tag>Super admin</Tag>}
        </div>
        {p.superAdmin && (
          <p className="text-caption text-muted">
            On the super-admin list, so they reach every workspace that is not restricted. That list is set in the
            deployment's settings, not here.
          </p>
        )}

        <section className="pane overflow-hidden" aria-label="Workspaces">
          <h2 className="border-b border-line px-4 py-2.5 text-body font-semibold">Workspaces</h2>
          {memberships.length === 0 ? (
            <p className="px-4 py-3 text-caption text-muted">Not in any workspace yet.</p>
          ) : (
            <ul>
              {memberships.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                  <span className="w-48 truncate font-medium text-text" title={w.name}>{w.name}</span>
                  {w.role && canIn(w.id) ? (
                    <Select
                      value={w.role}
                      onChange={(e) => void run(() => setRole(w.id, e.target.value as FAWorkspaceRole), `Now ${roleLabel(e.target.value)} in ${w.name}.`)}
                      aria-label={`Role in ${w.name}`}
                      title={ROLE_HINT[w.role as FAWorkspaceRole]}
                      className="w-36"
                    >
                      {WORKSPACE_ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="w-36 text-body text-text">{w.role ? roleLabel(w.role) : w.via.join(", ")}</span>
                  )}
                  <span className="min-w-0 flex-1 text-caption text-muted">{REACH_LINE[w.reach]}</span>
                  {w.role && canIn(w.id) && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(w)}>Remove</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {elsewhere.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/40 px-4 py-3">
              <Select value={addWs} onChange={(e) => setAddWs(e.target.value)} aria-label="Add to workspace" className="w-56">
                <option value="">Add to a workspace…</option>
                {elsewhere.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </Select>
              <Select value={addRole} onChange={(e) => setAddRole(e.target.value as FAWorkspaceRole)} aria-label="Role" className="w-36">
                {WORKSPACE_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </Select>
              <Button
                size="sm"
                disabled={!addWs}
                onClick={() =>
                  void run(async () => {
                    await setRole(addWs, addRole);
                    setAddWs("");
                  }, "Added.")
                }
              >
                Add
              </Button>
            </div>
          )}
        </section>

        {(p.platformRoles.length > 0 || view.can.givePlatformRoles) && (
          <section className="pane overflow-hidden" aria-label="Platform role">
            <h2 className="border-b border-line px-4 py-2.5 text-body font-semibold">Platform role</h2>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              {p.platformRoles.length === 0 && <span className="text-caption text-muted">None.</span>}
              {p.platformRoles.map((r) => (
                <span key={r} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-caption">
                  {view.platformRoles.find((x) => x.key === r)?.name ?? r}
                  {view.can.givePlatformRoles && (
                    <button
                      type="button"
                      aria-label={`Remove ${r}`}
                      className="text-muted hover:text-danger"
                      onClick={() => void run(() => foundryApi.unassignPlatformRole(p.subject, r), "Platform role removed.")}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {view.can.givePlatformRoles && view.platformRoles.some((r) => !p.platformRoles.includes(r.key)) && (
                <>
                  <Select value={addPlatform} onChange={(e) => setAddPlatform(e.target.value)} aria-label="Give a platform role" className="ml-auto w-48">
                    <option value="">Give a platform role…</option>
                    {view.platformRoles.filter((r) => !p.platformRoles.includes(r.key)).map((r) => (
                      <option key={r.key} value={r.key}>{r.name}</option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    disabled={!addPlatform}
                    onClick={() =>
                      void run(async () => {
                        await foundryApi.assignPlatformRole({ subject: p.subject, email, roleKey: addPlatform });
                        setAddPlatform("");
                      }, "Platform role given.")
                    }
                  >
                    Give
                  </Button>
                </>
              )}
            </div>
          </section>
        )}

        {p.localAccount && view.can.createLocalAccounts && (
          <section className="pane overflow-hidden" aria-label="Account">
            <h2 className="border-b border-line px-4 py-2.5 text-body font-semibold">Account</h2>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="text-body text-text">
                Username <span className="font-medium">{p.localAccount.username}</span>
              </span>
              {!p.localAccount.active && <Tag>Turned off — cannot sign in</Tag>}
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setResetting(true)}>Reset password</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(
                      () => setLocalUserActive(p.localAccount!.id, !p.localAccount!.active),
                      p.localAccount!.active ? "Turned off. They cannot sign in." : "Turned on.",
                    )
                  }
                >
                  {p.localAccount.active ? "Turn off" : "Turn on"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>Delete</Button>
              </span>
            </div>
          </section>
        )}
      </Zone>

      <Confirm
        open={removing !== null}
        title={removing ? `Remove from ${removing.name}?` : "Remove"}
        body={removing ? `${displayName(p)} will lose access to ${removing.name} at once. What they own there stays.` : ""}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && void run(() => remove(removing.id), `Removed from ${removing.name}.`)}
        onClose={() => setRemoving(null)}
      />

      <Confirm
        open={deleting}
        title={`Delete ${p.localAccount?.username ?? ""}?`}
        body={`They can no longer sign in, and the username becomes free again. Their access does not come back if an account with the same username is made later. Turn off keeps the account.`}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          try {
            await deleteLocalUser(p.localAccount!.id);
            toast.success(`${p.localAccount!.username} deleted.`);
            router.replace("/admin/people");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        }}
        onClose={() => setDeleting(false)}
      />

      <Modal open={resetting} onClose={() => setResetting(false)} title={`New password for ${p.localAccount?.username ?? ""}`}>
        <div className="space-y-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD} characters`}
            aria-label="New password"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResetting(false)}>Cancel</Button>
            <Button
              disabled={password.length < MIN_PASSWORD}
              onClick={() =>
                void run(async () => {
                  await setLocalUserPassword(p.localAccount!.id, password);
                  setPassword("");
                  setResetting(false);
                }, "Password changed. Tell them the new one.")
              }
            >
              Set password
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
