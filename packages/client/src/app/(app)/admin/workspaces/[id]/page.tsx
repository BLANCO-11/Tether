// src/app/(app)/admin/workspaces/[id]/page.tsx — one workspace (admin simplify, phase 4).
//
// One question: who is in here, and how is it set up. Three tabs, in the URL:
//   Members  — its people with their role (changed in place), the people invited to it, and Add people (email + role)
//   Settings — name, what it is for and what Forge may do, Restricted, Delete
//   Limits   — how much it may run at once and per day
//
// ⚠ The workspace is named in the URL and the title, never taken from the top-bar switcher. Every control is offered
// from the server's answer for THIS workspace (`GET …/me/permissions`), and every write is still checked by its route.
"use client";

import { Suspense, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Tag } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Confirm } from "@/components/ui/Confirm";
import { RowMenu } from "@/components/ui/RowMenu";
import { useAsync } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import { useToast } from "@/lib/toast";
import { foundryApi, type FAWorkspaceRole } from "@/lib/foundry-client";
import { deleteWorkspace, grantMember, listMembers, listWorkspaces, renameWorkspace, revokeMember, updateWorkspaceSetup } from "@/lib/api";
import type { Workspace, WorkspaceMember } from "@/lib/types";
import { ROLE_HINT, ROLE_LABEL, WORKSPACE_ROLES, roleLabel } from "@/lib/role-labels";
import { expiresLabel } from "@/lib/people";
import { workspaceAbilities, type WorkspaceAbilities } from "@/lib/workspace-abilities";
import { RestrictionPanel } from "@/components/workspace/RestrictionPanel";
import { WorkspaceLimits } from "@/components/workspace/WorkspaceLimits";
import { PURPOSE_MIN, SetupFields, said } from "@/components/workspace/WorkspaceSetupFields";
import { ADMIN_EYEBROW } from "@/components/admin/AdminGate";

const TABS = [
  { key: "members", label: "Members" },
  { key: "settings", label: "Settings" },
  { key: "limits", label: "Limits" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function WorkspacePageContent() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("tab");
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : "members";

  const spaces = useAsync(() => listWorkspaces(), []);
  const { workspaceId: current, switchWorkspace } = useWorkspace();
  // Don't leave the person standing in a workspace that no longer exists.
  const afterDelete = () => {
    if (current === id) {
      const next = (spaces.data ?? []).find((w) => w.id !== id);
      if (next) switchWorkspace(next.id);
    }
    router.replace("/organization");
  };
  const perms = useAsync(() => foundryApi.myPermissions(id), [id]);
  const ws = spaces.data?.find((w) => w.id === id) ?? null;
  const can = perms.data ? workspaceAbilities(perms.data, ws?.restricted === true) : null;

  return (
    <Page measure="wide">
      <PageHeader eyebrow={ADMIN_EYEBROW} title={ws?.name ?? "Workspace"} badge={ws?.restricted ? <Tag>Restricted</Tag> : undefined} />
      <Zone name="notices">
        <Link href="/organization" className="text-caption text-muted hover:text-text">← Workspaces</Link>
        {spaces.error ? (
          <Notice tone="danger" title="Could not load the workspace">{spaces.error}</Notice>
        ) : spaces.data && !ws ? (
          <Notice tone="warn" title="Not found">This workspace does not exist, or you are not in it.</Notice>
        ) : perms.error ? (
          <Notice tone="warn" title="Your access here could not be checked">
            Nothing is offered until it can be. ({perms.error})
          </Notice>
        ) : null}
      </Zone>
      {ws && can && (
        <>
          <Zone name="controls" gap="tight">
            <div role="tablist" aria-label="Workspace" className="-mb-px flex gap-1 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={t.key === tab}
                  onClick={() => router.replace(`/admin/workspaces/${id}?tab=${t.key}`)}
                  className={`-mb-px border-b-2 px-3 py-2 text-body transition-colors duration-150 ${
                    t.key === tab ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Zone>
          <Zone name="content">
            {tab === "members" ? (
              <MembersTab ws={ws} can={can} />
            ) : tab === "settings" ? (
              <SettingsTab ws={ws} can={can} onChanged={spaces.reload} onDeleted={afterDelete} />
            ) : can.readLimits ? (
              <WorkspaceLimits workspaceId={ws.id} canChange={can.changeLimits} />
            ) : (
              <p className="text-caption text-muted">You cannot see this workspace's limits.</p>
            )}
          </Zone>
        </>
      )}
      {!spaces.error && !perms.error && (!spaces.data || !perms.data) && (
        <Zone name="content"><div className="pane p-4"><Skeleton rows={4} /></div></Zone>
      )}
    </Page>
  );
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <WorkspacePageContent />
    </Suspense>
  );
}

function MembersTab({ ws, can }: { ws: Workspace; can: WorkspaceAbilities }) {
  const toast = useToast();
  const members = useAsync(() => (can.readMembers ? listMembers(ws.id) : Promise.resolve([] as WorkspaceMember[])), [ws.id, can.readMembers]);
  const invites = useAsync(
    () => (can.readMembers ? foundryApi.listInvitations().then((r) => r.invitations) : Promise.resolve([])),
    [can.readMembers],
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<FAWorkspaceRole>("author");
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const [busy, setBusy] = useState(false);
  const invited = (invites.data ?? []).flatMap((i) =>
    i.workspaces.filter((w) => w.workspaceId === ws.id).map((w) => ({ ...i, role: w.role })),
  );

  const run = async (what: () => Promise<unknown>, done: string) => {
    try {
      await what();
      toast.success(done);
      members.reload();
      invites.reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  const add = async () => {
    setBusy(true);
    await run(async () => {
      const r = await foundryApi.invite({ email: email.trim(), workspaces: [{ workspaceId: ws.id, role }] });
      setEmail("");
      return r;
    }, `${email.trim()} added.`);
    setBusy(false);
  };

  if (!can.readMembers) return <p className="text-caption text-muted">You cannot see who is in this workspace.</p>;

  return (
    <>
      {can.addPeople && (
        <section className="pane flex flex-wrap items-center gap-2 p-3" aria-label="Add people">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Add by email: name@company.com"
            aria-label="Email"
            className="min-w-0 flex-1"
          />
          <Select value={role} onChange={(e) => setRole(e.target.value as FAWorkspaceRole)} aria-label="Role" title={ROLE_HINT[role]} className="w-36">
            {WORKSPACE_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </Select>
          <Button disabled={busy || !/^[^@\s]+@[^@\s]+$/.test(email.trim())} onClick={() => void add()}>
            Add people
          </Button>
          <p className="w-full text-caption text-dim">Somebody who has not signed in yet is ready here the moment they do.</p>
        </section>
      )}

      <section className="pane overflow-hidden" aria-label="Members">
        {members.error ? (
          <p className="px-4 py-3 text-caption text-warn">Could not load the members. ({members.error})</p>
        ) : !members.data ? (
          <div className="p-4"><Skeleton rows={3} /></div>
        ) : members.data.length === 0 && invited.length === 0 ? (
          <p className="px-4 py-3 text-caption text-muted">Nobody is in this workspace yet.</p>
        ) : (
          <ul>
            {members.data.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                <span className="min-w-0 flex-1 truncate text-body text-text" title={m.email}>{m.email}</span>
                {can.addPeople ? (
                  <Select
                    value={m.role}
                    onChange={(e) =>
                      void run(() => grantMember(ws.id, { subject: m.subject, email: m.email, role: e.target.value as FAWorkspaceRole }), `${m.email} is now ${roleLabel(e.target.value)}.`)
                    }
                    aria-label={`Role of ${m.email}`}
                    className="w-36"
                  >
                    {WORKSPACE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </Select>
                ) : (
                  <span className="w-36 text-body text-text">{roleLabel(m.role)}</span>
                )}
                {can.addPeople && (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>Remove</Button>
                )}
              </li>
            ))}
            {invited.length > 0 && <li className="bg-surface-2/40 px-4 py-1.5 text-caption font-medium text-dim">Invited, not signed in yet</li>}
            {invited.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                <span className="min-w-0 flex-1 truncate text-body text-text" title={i.email}>{i.email}</span>
                <span className="w-36 text-body text-text">{roleLabel(i.role)}</span>
                <span className={`text-caption ${i.expired ? "text-warn" : "text-muted"}`}>{expiresLabel(i)}</span>
                {can.addPeople && (
                  <RowMenu
                    actions={[
                      {
                        label: "Withdraw",
                        icon: "delete",
                        danger: true,
                        onClick: () => void run(() => foundryApi.removeInvitationWorkspace(i.id, ws.id), `Invitation for ${i.email} withdrawn.`),
                      },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Confirm
        open={removing !== null}
        title={removing ? `Remove ${removing.email}?` : "Remove"}
        body={removing ? `They lose access to ${ws.name} at once. What they own here stays.` : ""}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && void run(() => revokeMember(ws.id, removing.subject), `${removing.email} removed.`)}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}

function SettingsTab({ ws, can, onChanged, onDeleted }: { ws: Workspace; can: WorkspaceAbilities; onChanged: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(ws.name);
  const [purpose, setPurpose] = useState(ws.purpose ?? "");
  const [assistant, setAssistant] = useState(ws.assistant === true);
  const [agentChanges, setAgentChanges] = useState(ws.agentChanges === true);
  const [selfEnable, setSelfEnable] = useState(ws.selfEnable !== false);
  const [webAccess, setWebAccess] = useState(ws.webAccess !== false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const setupChanged =
    purpose.trim() !== (ws.purpose ?? "") ||
    assistant !== (ws.assistant === true) ||
    agentChanges !== (ws.agentChanges === true) ||
    selfEnable !== (ws.selfEnable !== false) ||
    webAccess !== (ws.webAccess !== false);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="pane space-y-3 p-4" aria-label="Name">
        <h2 className="text-body font-semibold">Name</h2>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!can.changeSettings} aria-label="Workspace name" />
          {can.changeSettings && (
            <Button disabled={busy || !name.trim() || name.trim() === ws.name} onClick={() => void run(() => renameWorkspace(ws.id, name.trim()), "Renamed.")}>
              Save
            </Button>
          )}
        </div>
      </section>

      <section className="pane space-y-3 p-4" aria-label="Purpose and Forge">
        <fieldset disabled={!can.changeSettings} className="space-y-3">
          <SetupFields
            purpose={purpose}
            onPurpose={setPurpose}
            assistant={assistant}
            onAssistant={(v) => {
              setAssistant(v);
              if (!v) setAgentChanges(false);
            }}
            agentChanges={agentChanges}
            onAgentChanges={setAgentChanges}
            selfEnable={selfEnable}
            onSelfEnable={setSelfEnable}
            webAccess={webAccess}
            onWebAccess={setWebAccess}
          />
        </fieldset>
        {can.changeSettings && (
          <div className="flex justify-end">
            <Button
              disabled={busy || !setupChanged || purpose.trim().length < PURPOSE_MIN}
              onClick={() =>
                void run(
                  // Only what changed: switching a setting off has effects (Forge Agent chats, self-enabled workflows),
                  // so an unchanged value is never re-sent.
                  () =>
                    updateWorkspaceSetup(ws.id, {
                      ...(purpose.trim() !== (ws.purpose ?? "") ? { purpose: purpose.trim() } : {}),
                      ...(assistant !== (ws.assistant === true) ? { assistant } : {}),
                      ...(agentChanges !== (ws.agentChanges === true) ? { agentChanges } : {}),
                      ...(selfEnable !== (ws.selfEnable !== false) ? { selfEnable } : {}),
                      ...(webAccess !== (ws.webAccess !== false) ? { webAccess } : {}),
                    }),
                  "Saved. It applies from the next message in every chat.",
                )
              }
            >
              Save
            </Button>
          </div>
        )}
      </section>

      <RestrictionPanel workspaceId={ws.id} workspaceName={ws.name} restricted={ws.restricted === true} canChange={can.addPeople} onChanged={onChanged} />

      {can.changeSettings && (
        <section className="pane flex flex-wrap items-center gap-3 border-danger/30 p-4" aria-label="Delete">
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold">Delete this workspace</span>
            <span className="block text-caption text-muted">Removes it and everything in it. This cannot be undone.</span>
          </span>
          <Button variant="danger" onClick={() => setDeleting(true)}>Delete…</Button>
        </section>
      )}

      <Confirm
        open={deleting}
        title={`Delete "${ws.name}"?`}
        body="This removes the workspace and everything registered in it: tools, data sources, workflows and run history. Any schedule stops. This cannot be undone."
        confirmLabel="Delete workspace"
        danger
        onConfirm={async () => {
          try {
            await deleteWorkspace(ws.id);
            toast.success(`"${ws.name}" deleted.`);
            onDeleted();
          } catch (e) {
            toast.error(said(e));
          }
        }}
        onClose={() => setDeleting(false)}
      />
    </>
  );
}
