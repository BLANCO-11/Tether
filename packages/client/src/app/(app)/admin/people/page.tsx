// src/app/(app)/admin/people/page.tsx — People (admin simplify, phase 3).
//
// One question: who is here, and where do they work. One row per person with the workspaces they reach and their role
// in each; people invited but not yet signed in below them. One primary action: Add person. Click a row for the person.
//
// ⚠ Every row is the server's answer (`GET /api/platform/people`, the access grid's own per-workspace decision). This
// page filters what came back and never works out access itself.
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Input, Select } from "@/components/ui/Field";
import { Tag } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { RowMenu } from "@/components/ui/RowMenu";
import { Plus, Search } from "@/components/ui/icons";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useCanPlatform } from "@/components/access/Can";
import { foundryApi, type FAInvitation, type FAPerson } from "@/lib/foundry-client";
import { ROLE_LABEL, WORKSPACE_ROLES, roleLabel } from "@/lib/role-labels";
import { displayName, expiresLabel, invitationMatches, lastSeenLabel, personMatches, type PeopleFilter } from "@/lib/people";
import { AddPersonDialog } from "@/components/people/AddPersonDialog";
import { ADMIN_EYEBROW } from "@/components/admin/AdminGate";

const PAGE_SIZES = [10, 25, 50] as const;
const NO_FILTER: PeopleFilter = { q: "", workspaceId: "", role: "" };

/** "Finance · Admin" — the role in words, or how they reach it when there is no membership. */
function WorkspaceChip({ name, role, via }: { name: string; role: string | null; via?: string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-2 px-2.5 py-0.5 text-caption text-muted">
      <span className="font-medium text-text">{name}</span>
      <span className="text-dim">·</span>
      {role ? roleLabel(role) : (via?.[0] ?? "")}
    </span>
  );
}

/** Initials from a name or an address: "Priya Shah" → "PS", "sam@x.example" → "SA". */
function initials(text: string): string {
  const words = text.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return two.toUpperCase();
}

const TINTS = ["bg-accent/15 text-accent", "bg-ok-bg text-ok", "bg-warn-bg text-warn", "bg-surface-2 text-text"];
function Avatar({ text }: { text: string }) {
  const tint = TINTS[[...text].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length];
  return (
    <span aria-hidden className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-semibold ${tint}`}>
      {initials(text)}
    </span>
  );
}

type Row = { kind: "person"; p: FAPerson } | { kind: "invite"; i: FAInvitation };

export default function PeoplePage() {
  const read = useCanPlatform("platform.users.read");
  const toast = useToast();
  const view = useAsync(() => (read.denied ? Promise.resolve(null) : foundryApi.getPeople()), [read.denied]);
  const [filter, setFilter] = useState<PeopleFilter>(NO_FILTER);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);

  // People first, then the invited (they have no last-seen to sort by); one list, one count.
  const rows = useMemo<Row[]>(
    () => [
      ...(view.data?.people ?? []).filter((p) => personMatches(p, filter)).map((p) => ({ kind: "person" as const, p })),
      ...(view.data?.invitations ?? []).filter((i) => invitationMatches(i, filter)).map((i) => ({ kind: "invite" as const, i })),
    ],
    [view.data, filter],
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * pageSize, (at + 1) * pageSize);
  const filtered = filter.q !== "" || filter.workspaceId !== "" || filter.role !== "";
  const canAdd = !!view.data && (view.data.workspaces.some((w) => w.canAddPeople) || view.data.can.givePlatformRoles || view.data.can.createLocalAccounts);
  const count = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const setF = (f: PeopleFilter) => {
    setFilter(f);
    setPage(0);
  };

  const withdraw = async (i: FAInvitation) => {
    try {
      await foundryApi.revokeInvitation(i.id);
      toast.success(`Invitation for ${i.email} withdrawn.`);
      view.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page measure="wide">
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title="People"
        purpose="Manage access and roles across your workspaces."
        actions={canAdd ? [{ label: "Add person", onClick: () => setAdding(true), icon: <Plus s={15} /> }] : undefined}
      />
      <Zone name="notices">
        {read.denied ? (
          <Notice tone="info" title="This needs permission to see the deployment's people">
            Ask a super admin or a platform administrator. To manage one workspace's members, open it from Workspaces.
          </Notice>
        ) : view.error ? (
          <Notice tone="danger" title="Could not load people">{view.error}</Notice>
        ) : null}
      </Zone>

      {!read.denied && !view.error && (
        <>
          <Zone name="controls" gap="tight">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative sm:flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"><Search s={14} /></span>
                <Input value={filter.q} onChange={(e) => setF({ ...filter, q: e.target.value })} placeholder="Search name or email" aria-label="Search people" className="pl-9" />
              </div>
              <div className="sm:w-56">
                <Select value={filter.workspaceId} onChange={(e) => setF({ ...filter, workspaceId: e.target.value })} aria-label="Workspace">
                  <option value="">Any workspace</option>
                  {(view.data?.workspaces ?? []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              </div>
              <div className="sm:w-56">
                <Select value={filter.role} onChange={(e) => setF({ ...filter, role: e.target.value })} aria-label="Role">
                  <option value="">Any role</option>
                  {WORKSPACE_ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </Select>
              </div>
              <button
                type="button"
                onClick={() => setF(NO_FILTER)}
                disabled={!filtered}
                className="self-start whitespace-nowrap px-1 py-2 text-caption font-medium text-accent hover:underline disabled:cursor-default disabled:text-dim disabled:no-underline sm:self-auto"
              >
                Clear filters
              </button>
            </div>
          </Zone>

          <Zone name="content" gap="tight">
            {!view.data ? (
              <div className="pane p-4"><Skeleton rows={5} /></div>
            ) : rows.length === 0 ? (
              <EmptyState title={view.data.people.length || view.data.invitations.length ? "No people found. Try a different name, email, workspace or role." : "Nobody yet — add the first person with Add person."} />
            ) : (
              <>
                <p className="text-caption text-muted" aria-live="polite">{count(rows.length)}</p>
                <div className="pane overflow-x-auto">
                  <table className="w-full min-w-[46rem] table-fixed text-body">
                    <colgroup>
                      <col className="w-[38%]" />
                      <col />
                      <col className="w-40" />
                      <col className="w-14" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-line text-left text-caption text-dim">
                        <th scope="col" className="px-5 py-3 font-medium">Person</th>
                        <th scope="col" className="px-5 py-3 font-medium">Workspaces</th>
                        <th scope="col" className="px-5 py-3 font-medium">Last seen</th>
                        <th scope="col" className="px-5 py-3"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) =>
                        r.kind === "person" ? <PersonRow key={r.p.subject} p={r.p} /> : <InviteRow key={r.i.id} i={r.i} onWithdraw={() => void withdraw(r.i)} />,
                      )}
                    </tbody>
                  </table>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-caption text-muted">
                    <span>
                      Showing {pages > 1 ? `${at * pageSize + 1}–${at * pageSize + shown.length} of ${rows.length}` : count(rows.length)}
                    </span>
                    <span className="flex items-center gap-3">
                      {pages > 1 && (
                        <span className="flex items-center gap-2">
                          <button type="button" onClick={() => setPage(at - 1)} disabled={at === 0} className="text-accent hover:underline disabled:text-dim disabled:no-underline">Previous</button>
                          <button type="button" onClick={() => setPage(at + 1)} disabled={at >= pages - 1} className="text-accent hover:underline disabled:text-dim disabled:no-underline">Next</button>
                        </span>
                      )}
                      <label className="flex items-center gap-2">
                        Rows per page
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setPage(0);
                          }}
                          className="h-7 rounded-md border border-line bg-bg px-2 text-caption text-text"
                        >
                          {PAGE_SIZES.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                    </span>
                  </div>
                </div>
              </>
            )}
            {view.data && view.data.closedWorkspaces.length > 0 && (
              <p className="text-caption text-dim">
                Not shown: who is in {view.data.closedWorkspaces.join(", ")} (restricted; only its own admins can see).
              </p>
            )}
          </Zone>
        </>
      )}

      {view.data && (
        <AddPersonDialog
          open={adding}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            view.reload();
          }}
          view={view.data}
        />
      )}
    </Page>
  );
}

function PersonRow({ p }: { p: FAPerson }) {
  const router = useRouter();
  const href = `/admin/people/${encodeURIComponent(p.subject)}`;
  const shown = p.superAdmin ? p.workspaces.filter((w) => w.role) : p.workspaces;
  return (
    <tr className="relative border-b border-line last:border-0 hover:bg-surface-2">
      <td className="px-5 py-3">
        {/* The whole row opens the person; the link sits on the name so it is one focusable target. */}
        <Link href={href} className="flex items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none">
          <Avatar text={displayName(p)} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-text">{displayName(p)}</span>
              {p.signIn === "local" && <Tag>Local</Tag>}
              {p.superAdmin && <Tag>Super admin</Tag>}
              {p.localAccount && !p.localAccount.active && <Tag>Turned off</Tag>}
            </span>
            {p.name && p.email && <span className="block truncate text-caption text-muted">{p.email}</span>}
          </span>
        </Link>
      </td>
      <td className="px-5 py-3">
        <span className="flex flex-wrap gap-1.5">
          {/* A super admin reaches every open workspace; listing each one would bury their real memberships. */}
          {p.superAdmin && <span className="text-caption text-muted">Every workspace</span>}
          {shown.length === 0 && !p.superAdmin ? (
            <span className="text-caption text-dim">No workspaces</span>
          ) : (
            shown.map((w) => <WorkspaceChip key={w.id} name={w.name} role={w.role} via={w.via} />)
          )}
          {p.platformRoles.map((r) => (
            <Tag key={r}>{r}</Tag>
          ))}
        </span>
      </td>
      <td className="px-5 py-3 text-caption text-muted">{lastSeenLabel(p.lastSeenAt)}</td>
      <td className="px-3 py-3 text-right">
        <span className="relative z-10">
          <RowMenu label={`Actions for ${displayName(p)}`} actions={[{ label: "Open", onClick: () => router.push(href) }]} />
        </span>
      </td>
    </tr>
  );
}

function InviteRow({ i, onWithdraw }: { i: FAInvitation; onWithdraw: () => void }) {
  return (
    <tr className="border-b border-line last:border-0 hover:bg-surface-2">
      <td className="px-5 py-3">
        <span className="flex items-center gap-3">
          <Avatar text={i.email} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-text" title={i.email}>{i.email}</span>
            <span className="block text-caption text-muted">Pending invitation</span>
          </span>
        </span>
      </td>
      <td className="px-5 py-3">
        <span className="flex flex-wrap gap-1.5">
          {i.workspaces.map((w) => (
            <WorkspaceChip key={w.workspaceId} name={w.workspaceName} role={w.role} />
          ))}
          {i.platformRole && <Tag>{i.platformRole}</Tag>}
        </span>
      </td>
      <td className="px-5 py-3 text-caption">
        <span className="block text-muted">Not signed in yet</span>
        <span className={`block ${i.expired ? "text-warn" : "text-dim"}`}>{expiresLabel(i)}</span>
      </td>
      <td className="px-3 py-3 text-right">
        <RowMenu label={`Actions for ${i.email}`} actions={[{ label: "Withdraw", icon: "delete", danger: true, onClick: onWithdraw }]} />
      </td>
    </tr>
  );
}
