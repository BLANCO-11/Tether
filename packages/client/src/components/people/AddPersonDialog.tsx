"use client";

// Add person — the ONE form that puts somebody into the deployment (admin simplify, phase 3).
//
// An email, then the workspaces they should be in with a role each, and optionally a platform role. If they have
// already signed in, it applies now; if not, they are ready the moment they first sign in (an invitation, kept 30
// days). Ticking "Local account" creates a username-and-password account instead, with the same workspaces.
//
// ⚠ It never asks for an id. Every workspace and role it offers is one the server said this person may hand out
// (`canAddPeople`, `can.*`), and every request is still checked by its own route.

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { useToast } from "@/lib/toast";
import { foundryApi, type FAPeopleView, type FAWorkspaceRole } from "@/lib/foundry-client";
import { createLocalUser, grantLocalUserAccess } from "@/lib/api";
import { ROLE_HINT, ROLE_LABEL, WORKSPACE_ROLES } from "@/lib/role-labels";
import { MIN_PASSWORD } from "@/lib/people";

type Row = { workspaceId: string; role: FAWorkspaceRole };

export function AddPersonDialog({
  open,
  onClose,
  onDone,
  view,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  view: FAPeopleView;
}) {
  const toast = useToast();
  const grantable = view.workspaces.filter((w) => w.canAddPeople);
  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<Row[]>([{ workspaceId: grantable[0]?.id ?? "", role: "author" }]);
  const [platformRole, setPlatformRole] = useState("");
  const [local, setLocal] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const known = useMemo(
    () => view.people.find((p) => p.email && p.email.toLowerCase() === email.trim().toLowerCase() && p.lastSeenAt),
    [view.people, email],
  );
  const chosen = rows.filter((r) => r.workspaceId);
  const emailOk = /^[^@\s]+@[^@\s]+$/.test(email.trim());
  const ready = local
    ? username.trim().length > 0 && password.length >= MIN_PASSWORD && (!email.trim() || emailOk)
    : emailOk && (chosen.length > 0 || !!platformRole);

  const reset = () => {
    setEmail("");
    setRows([{ workspaceId: grantable[0]?.id ?? "", role: "author" }]);
    setPlatformRole("");
    setLocal(false);
    setUsername("");
    setName("");
    setPassword("");
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (local) {
        const user = await createLocalUser({
          username: username.trim(),
          password,
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        });
        for (const r of chosen) await grantLocalUserAccess(user.id, r.workspaceId, r.role);
        if (platformRole) {
          await foundryApi.assignPlatformRole({ subject: user.subject, email: user.email ?? `${user.username}@local`, roleKey: platformRole });
        }
        toast.success(`${user.username} can sign in now.`);
      } else {
        const r = await foundryApi.invite({ email: email.trim(), workspaces: chosen, platformRole: platformRole || null });
        toast.success(r.applied ? `${r.email} has access now.` : `${email.trim()} is set up and ready when they first sign in.`);
      }
      reset();
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unused = (current: string) => grantable.filter((w) => w.id === current || !rows.some((r) => r.workspaceId === w.id));

  return (
    <Modal open={open} onClose={onClose} title="Add person">
      <div className="space-y-5">
        <label className="block space-y-1.5">
          <span className="text-caption font-medium text-text">Email{local ? " (optional)" : ""}</span>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            aria-label="Email"
            list="people-emails"
            autoFocus
          />
          <datalist id="people-emails">
            {view.people.filter((p) => p.email && p.lastSeenAt).map((p) => (
              <option key={p.subject} value={p.email}>{p.name ?? ""}</option>
            ))}
          </datalist>
          {!local && emailOk && (
            <span className="block text-caption text-muted">
              {known ? "Has signed in before — access applies now." : "Not signed in yet — everything is ready when they first sign in."}
            </span>
          )}
        </label>

        <fieldset className="space-y-2">
          <legend className="text-caption font-medium text-text">Workspaces</legend>
          {grantable.length === 0 ? (
            <p className="text-caption text-muted">You cannot add people to any workspace.</p>
          ) : (
            <>
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={r.workspaceId} onChange={(e) => setRow(i, { workspaceId: e.target.value })} aria-label="Workspace" className="flex-1">
                    <option value="">Choose a workspace…</option>
                    {unused(r.workspaceId).map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </Select>
                  <Select
                    value={r.role}
                    onChange={(e) => setRow(i, { role: e.target.value as FAWorkspaceRole })}
                    aria-label="Role"
                    title={ROLE_HINT[r.role]}
                    className="w-36"
                  >
                    {WORKSPACE_ROLES.map((k) => (
                      <option key={k} value={k}>{ROLE_LABEL[k]}</option>
                    ))}
                  </Select>
                  {rows.length > 1 && (
                    <Button size="sm" variant="ghost" aria-label="Remove this workspace" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      ×
                    </Button>
                  )}
                </div>
              ))}
              {rows.length < grantable.length && (
                <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, { workspaceId: "", role: "author" }])}>
                  + Another workspace
                </Button>
              )}
            </>
          )}
        </fieldset>

        {view.can.givePlatformRoles && view.platformRoles.length > 0 && (
          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-text">Platform role (optional)</span>
            <Select value={platformRole} onChange={(e) => setPlatformRole(e.target.value)} aria-label="Platform role">
              <option value="">None</option>
              {view.platformRoles.map((r) => (
                <option key={r.key} value={r.key}>{r.name}</option>
              ))}
            </Select>
          </label>
        )}

        {view.can.createLocalAccounts && (
          <div className="space-y-3 border-t border-line pt-4">
            <label className="flex items-center gap-2 text-body text-text">
              <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
              Local account — they sign in with a username and password, not Microsoft
            </label>
            {local && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" aria-label="Username" />
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={`Password (at least ${MIN_PASSWORD} characters)`}
                  aria-label="Password"
                  className="sm:col-span-2"
                />
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!ready || busy}>{busy ? "Adding…" : "Add person"}</Button>
        </div>
      </div>
    </Modal>
  );
}
