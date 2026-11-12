"use client";

// A chat's secret vault: keys for websites that Forge uses BY NAME and never sees.
//
// ⚠ A secret's value is only ever typed into a password input here and sent to create/updateChatSecret. It is never
// put in the composer, never kept in browser storage, and never rendered: the server does not send it back.
import { useCallback, useEffect, useState } from "react";
import { createChatSecret, deleteChatSecret, listChatSecrets, updateChatSecret, type ChatSecret, type ChatSecretPlacement } from "@/lib/pi-builder";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { StatusPill } from "@/components/ui/Badge";

type Kind = ChatSecretPlacement["kind"];

const KIND_LABEL: Record<Kind, string> = {
  bearer: "Bearer token (Authorization header)",
  header: "Header",
  query: "Query parameter",
};

/** The placement sent to the server: a bearer token has no name; a header or query parameter needs one. */
function placementOf(kind: Kind, name: string): ChatSecretPlacement {
  return kind === "bearer" ? { kind, name: null } : { kind, name: name.trim() };
}

function howSent(p: ChatSecretPlacement): string {
  return p.kind === "bearer" ? "Bearer token" : p.kind === "header" ? `Header ${p.name}` : `Query parameter ${p.name}`;
}

const msg = (e: unknown) => (e as Error).message || "Something went wrong.";

function KindSelect({ kind, onKind, name, onName, label = "How it's sent" }: { kind: Kind; onKind: (k: Kind) => void; name: string; onName: (n: string) => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[12rem] flex-1">
        <Field label={label}>
          <Select value={kind} onChange={(e) => onKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {kind !== "bearer" ? (
        <div className="min-w-[8rem] flex-1">
          <Field label="Name">
            <Input value={name} onChange={(e) => onName(e.target.value)} placeholder={kind === "header" ? "X-API-Key" : "api_key"} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function SecretRow({ s, onChanged, onError, workspaceId, chatId }: { s: ChatSecret; onChanged: () => void; onError: (m: string | null) => void; workspaceId: string; chatId: string }) {
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const hosts = [s.host, ...s.extraHosts].filter(Boolean).join(", ");
  return (
    <li className="rounded-lg border border-line p-3" aria-label={`Secret ${s.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] text-text">{s.name}</span>
        {s.status === "pending" ? <StatusPill status="warn">Needs a website</StatusPill> : null}
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRotating((r) => !r)}>
            Rotate
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => deleteChatSecret(workspaceId, chatId, s.name))}>
            Delete
          </Button>
        </span>
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
        {s.status === "active" ? (
          <>
            <dt>Website</dt>
            <dd className="break-all">{hosts}</dd>
            <dt>Sent as</dt>
            <dd>{howSent(s.placement)}</dd>
          </>
        ) : null}
        <dt>Last used</dt>
        <dd>{s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "Never"}</dd>
        {s.expiresAt ? (
          <>
            <dt>Expires</dt>
            <dd>{new Date(s.expiresAt).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
      {rotating ? (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value) return;
            void run(async () => {
              await updateChatSecret(workspaceId, chatId, s.name, { value });
              setValue("");
              setRotating(false);
            });
          }}
        >
          <div className="flex-1">
            <Field label="New value">
              <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <Button size="sm" type="submit" disabled={busy || !value}>
            Save
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export function SecretsDialog({ workspaceId, chatId, open, onClose }: { workspaceId: string; chatId: string; open: boolean; onClose: () => void }) {
  const [secrets, setSecrets] = useState<ChatSecret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<Kind>("bearer");
  const [pname, setPname] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSecrets((await listChatSecrets(workspaceId, chatId)).secrets);
    } catch (e) {
      setError(msg(e));
    }
  }, [workspaceId, chatId]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const canSave = !!name.trim() && !!host.trim() && !!value && (kind === "bearer" || !!pname.trim());
  const add = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await createChatSecret(workspaceId, chatId, { name: name.trim(), host: host.trim(), placement: placementOf(kind, pname), value });
      setValue("");
      setName("");
      await refresh();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Secrets in this chat">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">Forge uses a secret by name and never sees its value. It is only sent to the website you choose.</p>
        {error ? <Notice tone="danger" title="Could not save">{error}</Notice> : null}
        {secrets.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Secrets">
            {secrets.map((s) => (
              <SecretRow key={s.id} s={s} workspaceId={workspaceId} chatId={chatId} onChanged={() => void refresh()} onError={setError} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-dim">No secrets in this chat yet.</p>
        )}
        <form
          className="flex flex-col gap-3 border-t border-line pt-3"
          aria-label="Add secret"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h3 className="text-[13px] font-medium text-text">Add secret</h3>
          <Field label="Name" hint="Lowercase letters, digits, dashes.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="twitterapi-key" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Website">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="api.example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <KindSelect kind={kind} onKind={setKind} name={pname} onName={setPname} />
          <Field label="Value">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <div>
            <Button size="sm" type="submit" disabled={busy || !canSave}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function PendingRow({ s, workspaceId, chatId, onDone }: { s: ChatSecret; workspaceId: string; chatId: string; onDone: () => void }) {
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<Kind>("bearer");
  const [pname, setPname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const canSave = !!host.trim() && (kind === "bearer" || !!pname.trim());
  return (
    <div className="mb-2 rounded-lg border border-warn-line bg-warn-bg p-3" role="region" aria-label={`Pasted key ${s.name}`}>
      <p className="text-sm text-text">
        Looks like you pasted a key. It was saved to this chat&apos;s vault as <span className="font-mono">{s.name}</span> and was not sent to Forge. Which website is it for?
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1">
          <Field label="Website">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="api.example.com" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <div className="min-w-[14rem] flex-1">
          <KindSelect kind={kind} onKind={setKind} name={pname} onName={setPname} />
        </div>
        <Button size="sm" disabled={busy || !canSave} onClick={() => void run(() => updateChatSecret(workspaceId, chatId, s.name, { host: host.trim(), placement: placementOf(kind, pname) }))}>
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => deleteChatSecret(workspaceId, chatId, s.name))}>
          Discard
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** Keys pasted into a message are moved to the vault; until the person names the website they are 'pending' and unusable. */
export function PastedSecretBanner({ workspaceId, chatId, refreshKey }: { workspaceId: string; chatId: string | null; refreshKey: number }) {
  const [secrets, setSecrets] = useState<ChatSecret[]>([]);
  const refresh = useCallback(async () => {
    if (!chatId) return setSecrets([]);
    try {
      setSecrets((await listChatSecrets(workspaceId, chatId)).secrets);
    } catch {
      // The banner is a convenience; the dialog shows errors.
    }
  }, [workspaceId, chatId]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  const pending = secrets.filter((s) => s.status === "pending");
  if (!chatId || pending.length === 0) return null;
  return (
    <div data-testid="pasted-secret-banner">
      {pending.map((s) => (
        <PendingRow key={s.id} s={s} workspaceId={workspaceId} chatId={chatId} onDone={() => void refresh()} />
      ))}
    </div>
  );
}
