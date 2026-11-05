// src/app/(app)/organization/page.tsx — Workspaces: the team boundary every
// resource lives inside.
//
// Real CRUD against /api/workspaces. This page used to read `mockdb`, which made
// the workspace list — the control that scopes every other page — localStorage
// while the pages it scoped read the server. Creating a workspace here appeared to
// work and then contained nothing, because no workspace had been created.
//
// Two sections were removed rather than kept as fakes:
//
//   * The ORG header. There is no organization model server-side; the title was
//     `mocks/data.ts`'s invented company name.
//   * MEMBERS. There was no user model at all — one shared PARENT_API_KEY
//     (ISSUES.md I-13) — and a members table of invented people with invented
//     roles, on a page about who can see what, was the most misleading thing this
//     UI contained. ⚠ THAT CHANGED: GAPS §1.1 added real workspace membership,
//     and `MembersPanel` became the real list against the real routes. The rule
//     it inherited is the same one that removed the fake: the screen may claim
//     exactly what the server enforces and not a word more, which is why it says
//     a role is granted access rather than a verified person.
//     ⚠ **AND IT LEFT AGAIN ON 2026-09-13 — this time for a different reason.**
//     Not because it was false, but because the same surface exists on
//     `/admin/members`, which is the page a person looking for people goes to and
//     the one row in the rail that says so. Two places to manage the same thing is
//     two places to look for the one that is already correct. The sentence about
//     granted access travelled with it.
//
// ⚠ **THIS PAGE IS ABOUT WORKSPACES NOW** — the list, and creating one. Who works in one, its settings and its
// limits are on its own page, `/admin/workspaces/<id>`; a person's places are on `/admin/people`.
//
// ⚠ **Somebody who is not a super admin gets the workspaces they are in, as links** (admin simplify, phase 6): a
// workspace's own admin reaches its page from here. That page offers only what they may do there.
//
// ⚠ **CREATING IS SUPER-ADMIN-ONLY, and the gate here is NOT the control.**
// Every route it calls — create, rename, delete — refuses a non-super-admin
// server-side (`requireSuperAdmin`). This gate exists so the person sees one
// honest sentence instead of a page whose every action 403s.
// ⚠ It said "assign, remove" too until 2026-09-13; those routes are not called
// from here any more.
//
// ⚠ FOUR states, and the fourth is the one that would be got wrong. Super admin;
// signed in but not one; nobody configured on this deployment (a different
// problem with a different fix — an environment variable); and **`/api/me`
// failed**, which must read as "we could not check" rather than as either
// answer. The same rule `PromptBoundaryWarnings` follows: unreadable renders as
// unreadable.
//
// ⚠ It does NOT read `session.user.roles`, which is sitting right there and
// already says `["superadmin","admin"]` for the local account. See `Me`.
//
// "Archive" is gone too. It set a local flag that hid the row from the switcher
// while the workspace stayed completely live — schedules armed, triggers firing.
// The server offers delete; that is what the button now does, and it says so.
"use client";

import { useState } from "react";
import Link from "next/link";
import { listWorkspaces, createWorkspace, listClosedWorkspaces, startEmergencyAccess } from "@/lib/api";
import type { ClosedWorkspace } from "@/lib/types";
import { RESTRICTED_EXPLAINED } from "@/components/workspace/RestrictionPanel";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useWorkspace } from "@/lib/workspace";
import type { Workspace } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { Tag } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Plus, Search } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtWhen } from "@/lib/stats";
import { PURPOSE_MIN, SetupFields, said } from "@/components/workspace/WorkspaceSetupFields";
import { Skeleton } from "@/components/ui/Skeleton";
import { AdminNotice, AdminSkeleton, ADMIN_EYEBROW } from "@/components/admin/AdminGate";

const TITLE = "Workspaces";
import { getMe } from "@/lib/api";
import {
  ACCESS_UNKNOWN,
  NOT_SUPER_ADMIN,
  NO_SUPER_ADMIN_CONFIGURED,
} from "@/lib/workspace-access-copy";

export default function OrganizationPage() {
  const toast = useToast();
  // ⚠ Asked before anything else is rendered. `spaces` is still fetched
  // unconditionally — the workspace list is not the secret here, the actions are,
  // and every one of those is refused by the server independently.
  const me = useAsync(getMe, []);
  const spaces = useAsync(() => listWorkspaces({ counts: true }));
  /** Restricted workspaces this person is outside of — names and admins only (restricted workspaces, phase 4). */
  const closed = useAsync(listClosedWorkspaces);
  const [emergency, setEmergency] = useState<{ w: ClosedWorkspace; reason: string; hours: 1 | 2 | 4 } | null>(null);
  const [q, setQ] = useState("");
  const { workspaceId, switchWorkspace } = useWorkspace();

  const [newWs, setNewWs] = useState("");
  const [newPurpose, setNewPurpose] = useState("");
  const [newAssistant, setNewAssistant] = useState(false);
  const [newRestricted, setNewRestricted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  // The mock's avatar: initials in a tinted circle. There is no avatar model
  // server-side, so the initials come from the name — the same rule as "the
  // screen may claim exactly what the server enforces" (see the header note).
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";

  const create = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const w = await createWorkspace({ name: newWs.trim(), purpose: newPurpose.trim(), assistant: newAssistant, restricted: newRestricted });
      setNewWs("");
      setNewPurpose("");
      setNewAssistant(false);
      setNewRestricted(false);
      toast.success(`Workspace "${w.name}" created`);
      spaces.reload();
      return true;
    } catch (e) {
      toast.error(`Could not create the workspace: ${said(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const askEmergency = async () => {
    if (!emergency) return;
    setBusy(true);
    try {
      const r = await startEmergencyAccess({ workspaceId: emergency.w.id, reason: emergency.reason.trim(), hours: emergency.hours });
      toast.success(`You are in "${emergency.w.name}" until ${new Date(r.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}. Its admins: ${r.notified}.`);
      setEmergency(null);
      spaces.reload();
      closed.reload();
    } catch (e) {
      toast.error(`Could not open emergency access: ${said(e)}`);
    } finally {
      setBusy(false);
    }
  };


  // ── The gate. Ordered so no state can fall through to another's answer. ──
  if (!me.data && !me.error) return <AdminSkeleton title={TITLE} />;
  if (me.error || !me.data) {
    // ⚠ NOT "you are not allowed". We do not know.
    return (
      <AdminNotice title={TITLE}>
        <Notice tone="warn" title="Access could not be checked">
          {ACCESS_UNKNOWN}
          {me.error ? ` (${me.error})` : ""}
        </Notice>
      </AdminNotice>
    );
  }
  if (!me.data.superAdmin && me.data.superAdminConfigured && (spaces.data?.length ?? 0) > 0) {
    return (
      <Page>
        <PageHeader eyebrow={ADMIN_EYEBROW} title={TITLE} purpose="The workspaces you are in. Open one to see its members and settings." />
        <Zone name="content">
          <ul className="pane overflow-hidden" aria-label="Your workspaces">
            {spaces.data!.map((w) => (
              <li key={w.id} className="border-b border-line last:border-0">
                <Link href={`/admin/workspaces/${w.id}`} className="block px-4 py-3 font-medium text-text hover:bg-surface-2/50">
                  {w.name}
                </Link>
              </li>
            ))}
          </ul>
        </Zone>
      </Page>
    );
  }
  if (!me.data.superAdmin) {
    // Two different refusals, because they need two different actions: ask a person, versus set an environment
    // variable on the server.
    return (
      <AdminNotice title={TITLE}>
        <Notice tone="warn" title={me.data.superAdminConfigured ? "Restricted to a super admin" : "No super admin is configured"}>
          {me.data.superAdminConfigured ? NOT_SUPER_ADMIN : NO_SUPER_ADMIN_CONFIGURED}
        </Notice>
      </AdminNotice>
    );
  }

  return (
    <Page>
      {/* ⚠ The old page's title was `org.data ? org.data.name : "Organization"` —
          a real company name sourced entirely from `mocks/data.ts`, invented
          from nothing. There is still no organization model server-side
          (`getOrganization` is gone, not faked — see `lib/api.ts`'s comment
          above `listWorkspaces`), so this title still invents no company name.
          Renamed from the literal fallback "Organization" to "Manage
          Workspaces" (`old-ui-restoration/ui-changes-2026-08-06.md` §3) to agree with the
          sidebar's nav label — naming what the page manages rather than an
          organization that has no model here. */}
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title={TITLE}
        purpose="Each workspace has its own credentials, data sources and workflows."
        actions={[{ label: "New workspace", onClick: () => setCreating(true), icon: <Plus s={15} /> }]}
      />

      <Zone name="notices">
        {spaces.error && (
          <Notice tone="danger" title="Could not load workspaces">{spaces.error}</Notice>
        )}
      </Zone>

      <Zone name="content">
        {(spaces.data?.length ?? 0) > 6 && (
          <div className="relative w-64">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"><Search s={13} /></span>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces" aria-label="Search workspaces" className="pl-8" />
          </div>
        )}
        {!spaces.data && !spaces.error ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pane p-4"><Skeleton rows={4} /></div>
            ))}
          </div>
        ) : spaces.error ? (
          <p className="text-caption text-muted">Not loaded — see above.</p>
        ) : (spaces.data ?? []).length === 0 ? (
          <EmptyState title="No workspaces yet — create the first one with New workspace." />
        ) : (
          // Real tenants first; harness fixtures last and labelled — marked rather than hidden, because a hidden
          // workspace is one nobody notices has broken.
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Workspaces">
            {(spaces.data ?? [])
              .filter((w) => !q.trim() || w.name.toLowerCase().includes(q.trim().toLowerCase()))
              .slice()
              .sort((a, b) => (a.kind === "fixture" ? 1 : 0) - (b.kind === "fixture" ? 1 : 0) || a.name.localeCompare(b.name))
              .map((w) => {
                const current = w.id === workspaceId;
                const c = w.counts;
                return (
                  <li key={w.id} className={`pane relative flex flex-col p-4 hover:bg-surface-2 ${current ? "border-accent/50" : ""}`}>
                    <div className="flex items-start gap-3">
                      {/* ⚠ Decorative — the name beside it always carries the meaning. */}
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-bg-2 text-caption font-semibold text-accent">
                        {initials(w.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                              {/* The whole card opens the workspace's own page: members, settings, limits. */}
                              <Link href={`/admin/workspaces/${w.id}`} className="truncate text-body font-medium text-text after:absolute after:inset-0 hover:underline">
                                {w.name}
                              </Link>
                              {current && <Tag>Current</Tag>}
                              {/* Not a team's workspace. `demo:rehearse` provisions and requires it, so it must not be
                                  deleted — saying what it is beats hiding it or leaving people to guess. */}
                              {w.kind === "fixture" && <Tag>test fixture</Tag>}
                              {w.assistant && <Tag>Forge Agent</Tag>}
                              {w.restricted && <Tag>Restricted</Tag>}
                            </div>
                            {w.purpose && <p className="mt-0.5 line-clamp-2 text-caption text-muted">{w.purpose}</p>}
                            {w.kind === "fixture" && (
                              <p className="mt-0.5 text-caption text-dim">
                                Exists so the swap rehearsal has a differently-shaped dataset to test against. Not a team
                                workspace, and deleting it breaks that check.
                              </p>
                            )}
                        </>
                      </div>
                    </div>

                    {/* What it holds. ⚠ "—" when the counts did not arrive, never 0 — an absent count is not an empty
                        workspace. */}
                    <dl className="mb-4 mt-4 flex gap-6">
                      <Count label="Workflows" value={c ? String(c.workflows) : "—"} note={c && c.live ? `${c.live} live` : undefined} />
                      <Count label="Data sources" value={c ? String(c.datasources) : "—"} />
                      <Count label="Members" value={c ? String(c.members) : "—"} />
                    </dl>

                    <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
                      <span className="min-w-0 flex-1 truncate text-caption text-dim">
                        {c?.lastRunAt ? `Last run ${fmtWhen(c.lastRunAt, Date.now())}` : c ? "No runs yet" : ""}
                      </span>
                      {/* Above the card's link (z-10), so it switches rather than opening the workspace page. */}
                      {!current && (
                        <Button size="sm" variant="subtle" className="relative z-10" onClick={() => switchWorkspace(w.id)}>
                          Switch to
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
        {(closed.data?.length ?? 0) > 0 && (
          <section aria-label="Restricted workspaces you are not in" className="space-y-2">
            <h2 className="pt-2 text-body font-semibold">Restricted workspaces you are not in</h2>
            <p className="text-caption text-muted">{RESTRICTED_EXPLAINED}</p>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(closed.data ?? []).map((w) => (
                <li key={w.id} className="pane flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-body font-medium text-text">{w.name}</span>
                    <Tag>Restricted</Tag>
                  </div>
                  <p className="text-caption text-muted">
                    {w.admins.length ? `Its admins: ${w.admins.join(", ")}` : "It has no admin."}
                  </p>
                  <div className="mt-auto flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setEmergency({ w, reason: "", hours: 1 })}>
                      Emergency access
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {closed.error && <p className="text-caption text-warn">Restricted workspaces could not be checked ({closed.error}).</p>}
      </Zone>

      <Modal open={emergency != null} onClose={() => setEmergency(null)} title={emergency ? `Emergency access to "${emergency.w.name}"` : "Emergency access"}>
        {emergency ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              For when its admins cannot be reached. Your reason and the time are recorded in the workspace&apos;s audit log,
              its admins are emailed where they can be, and they can end it at any time. It ends on its own.
            </p>
            <label className="block space-y-1">
              <span className="text-caption text-dim">Why do you need to get in? (at least 20 characters)</span>
              <Input value={emergency.reason} onChange={(e) => setEmergency({ ...emergency, reason: e.target.value })} aria-label="Reason" autoFocus />
            </label>
            <label className="block space-y-1">
              <span className="text-caption text-dim">For how long</span>
              <Select
                aria-label="For how long"
                value={String(emergency.hours)}
                onChange={(e) => setEmergency({ ...emergency, hours: Number(e.target.value) as 1 | 2 | 4 })}
              >
                <option value="1">1 hour</option>
                <option value="2">2 hours</option>
                <option value="4">4 hours</option>
              </Select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEmergency(null)}>Cancel</Button>
              <Button disabled={busy || emergency.reason.trim().length < 20} onClick={() => void askEmergency()}>
                Get in
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* The mock's "New workspace" is a modal; the inline form it replaces sat
          at the bottom of the list, where a creation surface reads as one more
          row. Behaviour is unchanged — same handler, same validation. */}
      <Modal open={creating} onClose={() => setCreating(false)} title="New workspace">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Each workspace has its own credentials, data sources and automations — a new one starts
            empty.
          </p>
          <Input
            value={newWs}
            onChange={(e) => setNewWs(e.target.value)}
            placeholder="e.g. Finance Automation"
            aria-label="New workspace name"
            autoFocus
          />
          <SetupFields purpose={newPurpose} onPurpose={setNewPurpose} assistant={newAssistant} onAssistant={setNewAssistant} />
          <label className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${newRestricted ? "border-accent/60 bg-accent-bg-2/40" : "border-line"}`}>
            <input type="checkbox" className="mt-0.5" checked={newRestricted} onChange={(e) => setNewRestricted(e.target.checked)} aria-label="Restricted" />
            <span>
              <span className="block text-body font-medium text-text">Restricted</span>
              <span className="block text-caption text-muted">{RESTRICTED_EXPLAINED} You become its first admin.</span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              disabled={!newWs.trim() || newPurpose.trim().length < PURPOSE_MIN || busy}
              onClick={async () => {
                if (await create()) setCreating(false);
              }}
            >
              <Plus s={13} /> Create workspace
            </Button>
          </div>
        </div>
      </Modal>


    </Page>
  );
}

/** One figure on a workspace card: the number, what it counts, and an optional note beside it. */
function Count({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-caption text-dim">{label}</dt>
      <dd className="text-lg tabular-nums text-text">
        {value}
        {note && <span className="ml-1.5 text-caption text-ok">{note}</span>}
      </dd>
    </div>
  );
}
