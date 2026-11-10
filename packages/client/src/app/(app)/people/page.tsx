"use client";

/**
 * Personal fork — allowed people and invitations.
 *
 * Replaces the enterprise Admin → People tree with a single thin surface:
 * who can use this Foundry, and pending email invites into your space.
 * Admins can change a person's role or remove their access (grantMember / revokeMember).
 */
import { FormEvent, useMemo, useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAsync } from "@/lib/hooks";
import { foundryApi, type FAPeopleView, type FAPerson, type FAWorkspaceRole } from "@/lib/foundry-client";
import { expiresLabel } from "@/lib/people";
import { useWorkspace } from "@/lib/workspace";

function inviteExpiry(i: { expiresAt: string; expired: boolean }): string {
  return expiresLabel(i);
}

const ROLES: FAWorkspaceRole[] = ["viewer", "author", "approver", "admin"];

export default function PeoplePage() {
  const { workspaceId } = useWorkspace();
  const people = useAsync(() => foundryApi.getPeople(), []);
  const me = useAsync(() => foundryApi.me(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<FAWorkspaceRole>("author");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const view = people.data as FAPeopleView | null;
  const mySubject = me.data?.subject ?? null;
  const inviteTargets = useMemo(
    () => (view?.workspaces ?? []).filter((w) => w.canAddPeople),
    [view],
  );
  const manageById = useMemo(() => new Map(inviteTargets.map((w) => [w.id, w])), [inviteTargets]);
  const defaultWorkspaceId =
    inviteTargets.find((w) => w.id === workspaceId)?.id ?? inviteTargets[0]?.id ?? null;

  async function refresh() {
    people.reload();
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    setErr(null);
    if (!defaultWorkspaceId) {
      setErr("No workspace you can add people to yet.");
      return;
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await foundryApi.invite({
        email: trimmed,
        workspaces: [{ workspaceId: defaultWorkspaceId, role }],
      });
      setEmail("");
      if (result.applied) {
        setNotice(`${result.email} already had an account — access applied.`);
      } else {
        setNotice(`Invitation sent to ${result.invitation.email}.`);
      }
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Invite failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setErr(null);
    setBusy(true);
    try {
      await foundryApi.revokeInvitation(id);
      setNotice("Invitation withdrawn.");
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not withdraw invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function onChangeRole(p: FAPerson, workspaceId: string, next: FAWorkspaceRole) {
    setErr(null);
    setBusy(true);
    try {
      await foundryApi.grantMember(workspaceId, { subject: p.subject, email: p.email, role: next });
      setNotice(`Updated ${p.name || p.email || p.subject} to ${next}.`);
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not change role.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(p: FAPerson, workspaceId: string, workspaceName: string) {
    if (mySubject && p.subject === mySubject) {
      setErr("You cannot remove your own access from here.");
      return;
    }
    if (!window.confirm(`Remove ${p.name || p.email || p.subject} from ${workspaceName}?`)) return;
    setErr(null);
    setBusy(true);
    try {
      await foundryApi.revokeMember(workspaceId, p.subject);
      setNotice(`Removed ${p.name || p.email || p.subject} from ${workspaceName}.`);
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not remove access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Access"
        title="People"
        purpose="Who may use this Tether, and invitations waiting for them to sign in."
      />
      <Zone name="content" className="space-y-8">
        {people.loading ? <p className="text-sm text-muted">Loading…</p> : null}
        {people.error ? (
          <p className="text-sm text-warn" role="alert">
            Could not load people: {people.error}
          </p>
        ) : null}

        {notice ? (
          <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-text" role="status">
            {notice}
          </p>
        ) : null}
        {err ? (
          <p className="text-sm text-warn" role="alert">
            {err}
          </p>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Invite someone</h2>
          <p className="text-sm text-muted">
            They get access to{" "}
            <span className="text-text">
              {inviteTargets.find((w) => w.id === defaultWorkspaceId)?.name ?? "your space"}
            </span>{" "}
            when they sign in. No enterprise admin queue — just an email.
          </p>
          <form onSubmit={onInvite} className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-muted">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text"
                placeholder="friend@example.com"
                disabled={busy || !defaultWorkspaceId}
              />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as FAWorkspaceRole)}
                className="h-9 rounded-md border border-line bg-bg px-2 text-sm text-text"
                disabled={busy || !defaultWorkspaceId}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="btn-cta h-9 rounded-md px-4 text-sm font-medium disabled:opacity-50"
              disabled={busy || !defaultWorkspaceId}
            >
              Invite
            </button>
          </form>
          {!defaultWorkspaceId && !people.loading ? (
            <p className="text-sm text-muted">You need admin on a workspace before you can invite.</p>
          ) : null}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Open invitations</h2>
          {(view?.invitations.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">None waiting.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {view!.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-text">{i.email}</div>
                    <div className="text-xs text-muted">
                      {i.workspaces.map((w) => `${w.workspaceName} · ${w.role}`).join(", ")}
                      {" · "}
                      {inviteExpiry(i)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-muted underline hover:text-text"
                    disabled={busy}
                    onClick={() => void onRevoke(i.id)}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">People with access</h2>
          {(view?.people.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">Just you, once the home space is ready.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {view!.people.map((p) => (
                <li key={p.subject} className="space-y-2 px-3 py-2.5">
                  <div>
                    <div className="text-sm text-text">{p.name || p.email || p.subject}</div>
                    <div className="text-xs text-muted">
                      {p.email}
                      {p.signIn === "local" ? " · local sign-in" : ""}
                      {p.subject === mySubject ? " · you" : ""}
                    </div>
                  </div>
                  {p.workspaces.length === 0 ? (
                    <p className="text-xs text-muted">No workspace yet</p>
                  ) : (
                    <ul className="space-y-2">
                      {p.workspaces.map((w) => {
                        const canManage = manageById.has(w.id) && !!w.role;
                        const role = (w.role ?? "viewer") as FAWorkspaceRole;
                        return (
                          <li key={w.id} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="min-w-[8rem] text-muted">{w.name}</span>
                            {canManage ? (
                              <>
                                <label className="sr-only" htmlFor={`role-${p.subject}-${w.id}`}>
                                  Role in {w.name}
                                </label>
                                <select
                                  id={`role-${p.subject}-${w.id}`}
                                  aria-label={`Role for ${p.name || p.email} in ${w.name}`}
                                  value={role}
                                  disabled={busy}
                                  className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-text"
                                  onChange={(e) => void onChangeRole(p, w.id, e.target.value as FAWorkspaceRole)}
                                >
                                  {ROLES.map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="text-xs text-muted underline hover:text-warn disabled:opacity-50"
                                  disabled={busy || p.subject === mySubject}
                                  title={p.subject === mySubject ? "You cannot remove yourself" : `Remove from ${w.name}`}
                                  onClick={() => void onRemove(p, w.id, w.name)}
                                >
                                  Remove
                                </button>
                              </>
                            ) : (
                              <span className="text-muted">{w.role ?? "member"}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </Zone>
    </Page>
  );
}
