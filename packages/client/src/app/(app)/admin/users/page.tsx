"use client";

/**
 * Who can sign in to this Tether with an email code, and who can manage that list.
 * The server decides who is a user admin (`userAdmin` on /api/me); this page only asks, and
 * never fetches or shows the list unless that answer is a clear yes.
 */
import { FormEvent, useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAsync } from "@/lib/hooks";
import { foundryApi, type FAAllowedUser } from "@/lib/foundry-client";

type Role = "admin" | "user";
const ROLES: Role[] = ["user", "admin"];
const SELF_TITLE = "You cannot remove your own admin access";

function Header() {
  return (
    <PageHeader
      eyebrow="Access"
      title="Users"
      purpose="Who can sign in to this Tether with an email code, and who can manage that list."
    />
  );
}

export default function UsersPage() {
  const me = useAsync(() => foundryApi.me(), []);

  if (me.loading) {
    return (
      <Page>
        <Header />
        <Zone name="content">
          <p className="text-sm text-muted">Loading…</p>
        </Zone>
      </Page>
    );
  }
  if (me.error) {
    return (
      <Page>
        <Header />
        <Zone name="content">
          <p className="text-sm text-warn" role="alert">
            Could not check whether you can manage users.
          </p>
        </Zone>
      </Page>
    );
  }
  if (me.data?.userAdmin !== true) {
    return (
      <Page>
        <Header />
        <Zone name="content">
          <p className="text-sm text-muted">Only an admin can manage who signs in.</p>
        </Zone>
      </Page>
    );
  }
  return <UsersAdmin myEmail={me.data.email} />;
}

function UsersAdmin({ myEmail }: { myEmail: string }) {
  const list = useAsync(() => foundryApi.listAllowedUsers(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const users = list.data?.users ?? [];
  const superAdmins = list.data?.superAdmins ?? [];
  const isMe = (u: FAAllowedUser) => u.email.toLowerCase() === myEmail.toLowerCase();

  async function run(action: () => Promise<unknown>, fallback: string, done?: string) {
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      await action();
      list.reload();
      if (done) setNotice(done);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    await run(
      async () => {
        await foundryApi.addAllowedUser({ email: trimmed, role });
        setEmail("");
      },
      "Could not add that email.",
      `Added ${trimmed}. They can now sign in with an email code.`,
    );
  }

  function onRemove(u: FAAllowedUser) {
    if (!window.confirm(`Remove ${u.email}? They will be signed out within a few minutes.`)) return;
    void run(() => foundryApi.removeAllowedUser(u.id), "Could not remove that user.");
  }

  return (
    <Page>
      <Header />
      <Zone name="content" className="space-y-8">
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
          <h2 className="text-sm font-semibold text-text">Add someone</h2>
          <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-muted">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9 rounded-md border border-line bg-bg px-3 text-sm text-text"
                placeholder="friend@example.com"
                disabled={busy}
              />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="h-9 rounded-md border border-line bg-bg px-2 text-sm text-text"
                disabled={busy}
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
              disabled={busy}
            >
              Add
            </button>
          </form>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Users</h2>
          {list.loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {list.error ? (
            <p className="text-sm text-warn" role="alert">
              Could not load users: {list.error}
            </p>
          ) : null}
          {!list.loading && !list.error && users.length === 0 ? (
            <p className="text-sm text-muted">Nobody added yet.</p>
          ) : null}
          {users.length > 0 ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {users.map((u) => {
                const self = isMe(u);
                return (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm text-text">
                        {u.email}
                        {self ? " · you" : ""}
                      </div>
                      <div className="text-xs text-muted">
                        {u.role}
                        {!u.enabled ? " · Disabled" : ""}
                        {" · "}
                        {u.lastLoginAt
                          ? `Last sign-in: ${new Date(u.lastLoginAt).toLocaleString()}`
                          : "Never signed in"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <select
                        aria-label={`Role for ${u.email}`}
                        value={u.role}
                        disabled={busy || (self && u.role === "admin")}
                        title={self ? SELF_TITLE : undefined}
                        className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-text"
                        onChange={(e) =>
                          void run(
                            () => foundryApi.updateAllowedUser(u.id, { role: e.target.value as Role }),
                            "Could not change role.",
                          )
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="text-xs text-muted underline hover:text-text disabled:opacity-50"
                        disabled={busy || (self && u.enabled)}
                        title={self ? SELF_TITLE : undefined}
                        onClick={() =>
                          void run(
                            () => foundryApi.updateAllowedUser(u.id, { enabled: !u.enabled }),
                            "Could not update that user.",
                          )
                        }
                      >
                        {u.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-muted underline hover:text-warn disabled:opacity-50"
                        disabled={busy || self}
                        title={self ? SELF_TITLE : undefined}
                        onClick={() => onRemove(u)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        {superAdmins.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-text">Always allowed</h2>
            <p className="text-xs text-muted">Set by SUPER_ADMIN_EMAILS on the server. Always admins.</p>
            <ul className="divide-y divide-line rounded-md border border-line">
              {superAdmins.map((s) => (
                <li key={s} className="px-3 py-2 text-sm text-text">
                  {s}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Zone>
    </Page>
  );
}
