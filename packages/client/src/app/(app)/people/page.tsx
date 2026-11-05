"use client";

/**
 * Personal fork — allowed people and invitations.
 *
 * Replaces the enterprise Admin → People tree with a single thin surface:
 * who can use this Foundry, and pending email invites into your space.
 */
import { FormEvent, useMemo, useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAsync } from "@/lib/hooks";
import { foundryApi, type FAPeopleView, type FAWorkspaceRole } from "@/lib/foundry-client";
import { expiresLabel } from "@/lib/people";
import { useWorkspace } from "@/lib/workspace";

function inviteExpiry(i: { expiresAt: string; expired: boolean }): string {
  return expiresLabel(i);
}

const ROLES: FAWorkspaceRole[] = ["viewer", "author", "approver", "admin"];

export default function PeoplePage() {
  const { workspaceId } = useWorkspace();
  const people = useAsync(() => foundryApi.getPeople(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<FAWorkspaceRole>("author");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const view = people.data as FAPeopleView | null;
  const inviteTargets = useMemo(
    () => (view?.workspaces ?? []).filter((w) => w.canAddPeople),
    [view],
  );
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

  return (
    <Page>
      <PageHeader
        eyebrow="Access"
        title="People"
        purpose="Who may use this Foundry, and invitations waiting for them to sign in."
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
                <li key={p.subject} className="px-3 py-2.5">
                  <div className="text-sm text-text">{p.name || p.email || p.subject}</div>
                  <div className="text-xs text-muted">
                    {p.email}
                    {p.workspaces.length
                      ? ` · ${p.workspaces.map((w) => `${w.name}${w.role ? ` (${w.role})` : ""}`).join(", ")}`
                      : " · no workspace yet"}
                    {p.signIn === "local" ? " · local sign-in" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Zone>
    </Page>
  );
}
