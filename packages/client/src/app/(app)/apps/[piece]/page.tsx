// src/app/(app)/apps/[piece]/page.tsx — one connector: this workspace's connections to it, which of its actions
// automations may use, and (for whoever installs connectors) the deployment's install of it.
// plans/plugins-2026-10-27, phase 5.
//
// ⚠ The id comes from `useParams()`, never a `params` prop or `use(params)` (React 18 has no `use()`; see CLAUDE.md,
// the Next 16 section).
//
// ⚠ A connection's value is never displayed. The list shows its NAME, which fields it holds and what its last test
// said; changing it opens an empty form where a blank field keeps the stored value.
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  connectorOauthApp,
  createConnectorConnection,
  removeConnectorOauthApp,
  setConnectorOauthApp,
  startConnectorOauth,
  deleteConnectorConnection,
  listConnectorInstalls,
  listWorkspaceConnectors,
  personalConnector,
  setConnectorActions,
  setMyConnectorActions,
  setPersonalUse,
  setConnectorHosts,
  testConnectorConnection,
  uninstallConnector,
  updateConnectorConnection,
  upgradeConnector,
} from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { actionEffect, connectableAuths, connectionState, fieldInput, offerable, parseHosts, scopeLine, workspaceState } from "@/lib/connector-ui";
import type { ConnectorAction, ConnectorAuth, ConnectorConnection, ConnectorInstall, ConnectorOauthApp, PersonalConnectorView, WorkspaceConnector } from "@/lib/types";
import { useToast } from "@/lib/toast";
import { useCan, useCanPlatform } from "@/components/access/Can";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Confirm } from "@/components/ui/Confirm";
import { ConnectorMark } from "@/components/connectors/ConnectorMark";
import { ConnectionForm } from "@/components/connectors/ConnectionForm";
import { DeclaredCalls, MyDeclaredCalls } from "@/components/connectors/DeclaredCalls";

export default function ConnectorPage() {
  const { piece } = useParams<{ piece: string }>();
  const ws = useAsync(listWorkspaceConnectors, [piece]);
  const enable = useCan("plugins.enable");
  const install = useCanPlatform("platform.plugins.install");
  const p = ws.data?.find((x) => x.short === piece) ?? null;
  const mine = useAsync(() => personalConnector(piece), [piece]);
  const returned = useSignInReturn();
  const [tab, setTab] = useConnectorTab(enable.allowed, enable.state !== "unreadable");
  const reload = () => {
    ws.reload();
    mine.reload();
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Connectors"
        title={p?.displayName ?? piece}
        purpose={p?.description || undefined}
        badge={p ? <StatusPill status={workspaceState(p).tone}>{workspaceState(p).label}</StatusPill> : undefined}
        actions={[{ label: "All connectors", href: "/apps", variant: "ghost" }]}
      />
      <Zone name="notices" gap="tight">
        {ws.error && (
          <Notice tone="danger" title="Could not read this connector">
            {ws.error} — this is a failure to ask, not a statement that it is missing.
          </Notice>
        )}
        {returned?.connected && (
          <Notice tone="ok" title="Signed in and connected">
            The connection is saved{p ? ` and was tested — see it below` : ""}. Choose which actions automations may use.
          </Notice>
        )}
        {returned?.error && (
          <Notice tone="danger" title="The sign-in did not connect">
            {returned.error}
          </Notice>
        )}
        {ws.data && !p && (
          <Notice tone="info" title="Not installed on this deployment">
            {install.allowed ? "Install it from the marketplace first." : "Someone allowed to install connectors has to add it first."}
          </Notice>
        )}
      </Zone>
      {ws.loading && !ws.data && <p className="text-sm text-muted">Reading…</p>}
      {p && (
        <>
          <Zone name="content">
            <div className="flex items-center gap-3 text-xs text-dim">
              <ConnectorMark logoUrl={p.logoUrl} name={p.displayName} size={32} />
              <span>
                {p.displayName} {p.version} · {p.actions.length} actions
              </span>
            </div>
            <div role="tablist" aria-label="Whose actions" className="-mb-px flex flex-wrap items-center gap-1 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-fast ease-app ${tab === t.key ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tab === null ? (
              <p className="text-sm text-muted">Reading…</p>
            ) : tab === "mine" ? (
              <div role="tabpanel" aria-label="For me" className="flex flex-col gap-6">
                <p className="text-xs text-muted">Actions you switch on here work only for you, through your own account: in your Forge chats, and in workflows you own.</p>
                <Connections p={p} only="me" canEnable={enable.allowed} onChange={reload} />
                <MyActions p={p} mine={mine.data} error={mine.error} onChange={reload} />
                {p.actions.some((a) => a.name === "custom_api_call") && mine.data && (
                  <MyDeclaredCalls short={p.short} view={mine.data} workspaceOn={p.enabled.map((e) => e.tool)} onChange={reload} />
                )}
              </div>
            ) : (
              <div role="tabpanel" aria-label="For the workspace" className="flex flex-col gap-6">
                <p className="text-xs text-muted">
                  {enable.allowed
                    ? "Actions switched on here work for everyone in the workspace, through the workspace's connection."
                    : "What your admins have switched on for everyone in this workspace. Only an admin changes these; switch actions on for yourself under For me."}
                </p>
                <Connections p={p} only="workspace" canEnable={enable.allowed} onChange={reload} />
                <WorkspaceActions p={p} canEnable={enable.allowed} onChange={reload} />
                {p.actions.some((a) => a.name === "custom_api_call") && <DeclaredCalls short={p.short} connections={p.connections} canEnable={enable.allowed} />}
                {enable.allowed && <PersonalUsePanel short={p.short} name={p.displayName} allowed={mine.data?.allowed ?? null} onChange={reload} />}
              </div>
            )}
          </Zone>
        </>
      )}
      {install.allowed && <InstallPanel short={piece} onGone={ws.reload} />}
    </Page>
  );
}

// ── Tabs: For me / For the workspace (plans/personal-actions-2026-10-29) ─────────────────────────────────────────────

const TABS = [
  { key: "mine", label: "For me" },
  { key: "workspace", label: "For the workspace" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
/**
 * Which tab opens: the one named in the address (`?tab=mine` — a reload or a shared link keeps it), else "For the
 * workspace" for an admin and "For me" for everyone else. ⚠ Never browser storage: these pages keep nothing in the
 * browser (ui-honesty-check.sh).
 */
function useConnectorTab(admin: boolean, known: boolean): [TabKey | null, (t: TabKey) => void] {
  const [picked, setPicked] = useState<TabKey | null>(() => {
    if (typeof window === "undefined") return null;
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "mine" || t === "workspace" ? t : null;
  });
  // Decided in render, never flipped after: until permissions are known there is no tab to show.
  const tab: TabKey | null = picked ?? (!known ? null : admin ? "workspace" : "mine");
  const setTab = (t: TabKey) => {
    setPicked(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", url.toString());
  };
  return [tab, setTab];
}

// ── Connections ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who a new connection is for: the whole workspace (automations and every chat), or the person alone. */
type Whose = "workspace" | "me";

/** The connections of one tab: the workspace's, or the person's own. */
function Connections({ p, only, canEnable, onChange }: { p: WorkspaceConnector; only: Whose; canEnable: boolean; onChange: () => void }) {
  const toast = useToast();
  const { forms, signIn, notYet, none } = connectableAuths(p.auth);
  const oauth = p.oauth ?? null;
  const canSignIn = !!signIn && !!oauth?.configured;
  const canKey = forms.length > 0;
  const [connecting, setConnecting] = useState<Whose | null>(null);
  const [signingIn, setSigningIn] = useState<{ whose: Whose; again?: ConnectorConnection } | null>(null);
  const [rotating, setRotating] = useState<ConnectorConnection | null>(null);
  const [removing, setRemoving] = useState<ConnectorConnection | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const workspace = p.connections.filter((c) => !c.personal);
  const mine = p.connections.filter((c) => c.personal);
  /** One way to connect ⇒ straight to it; both ⇒ the dialog asks how. */
  const start = (whose: Whose) => (canSignIn && !canKey ? setSigningIn({ whose }) : setConnecting(whose));

  const test = async (c: ConnectorConnection) => {
    setTesting(c.id);
    try {
      const r = await testConnectorConnection(c.id);
      if (!r.checked) toast("This connector has no check of its own; it is tried the first time an action runs.");
      else if (r.valid) toast.success("The service accepted the connection.");
      else toast.error(r.error ?? "The service refused the connection.");
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const row = (c: ConnectorConnection, mayChange: boolean) => {
    const s = connectionState(c);
    const used = p.enabled.filter((e) => e.connection === c.id).length;
    return (
      <li key={c.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {c.label}
            {c.authType === "OAUTH2" && <Tag>Signed in</Tag>}
          </span>
          <span className="block text-xs text-muted">
            Holds {c.fieldNames.length ? c.fieldNames.join(", ") : "no fields"} · added by {c.createdBy}
            {used ? ` · ${used} action${used === 1 ? "" : "s"} run through it` : ""}
          </span>
          {s.detail && <span className="block text-xs text-dim">{s.detail}</span>}
        </span>
        <StatusPill status={s.tone}>{s.label}</StatusPill>
        {mayChange && (
          <span className="flex gap-1">
            <Button size="sm" variant="subtle" disabled={testing === c.id} onClick={() => test(c)}>
              {testing === c.id ? "Testing…" : "Test"}
            </Button>
            {forms.some((f) => f.type === c.authType) && (
              <Button size="sm" variant="ghost" onClick={() => setRotating(c)}>
                Change
              </Button>
            )}
            {c.authType === "OAUTH2" && canSignIn && (
              <Button size="sm" variant="ghost" onClick={() => setSigningIn({ whose: c.personal ? "me" : "workspace", again: c })}>
                Sign in again
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>
              Remove
            </Button>
          </span>
        )}
      </li>
    );
  };

  const connectable = !none && !notYet && (canSignIn || canKey);
  return (
    <section aria-labelledby="connections-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="connections-h" className="text-base font-semibold">
          {only === "me" ? "Your connections" : "The workspace's connections"}
        </h2>
        {connectable && only === "me" && (
          <Button size="sm" onClick={() => start("me")}>
            Connect as yourself
          </Button>
        )}
        {connectable && only === "workspace" && canEnable && (
          <Button size="sm" onClick={() => start("workspace")}>
            Connect for the workspace
          </Button>
        )}
      </div>
      {none && <p className="text-sm text-muted">{p.displayName} needs no connection.</p>}
      {notYet && (
        <Notice tone="warn" title={`${p.displayName} connects only through identity federation, which is not available yet`}>
          It is installed and its actions are listed, but it cannot be connected yet.
        </Notice>
      )}
      {signIn && oauth && !oauth.configured && !canKey && (
        <Notice tone="info" title={`Signing in to ${p.displayName} is not set up yet`}>
          {p.displayName} connects by signing in. Someone allowed to install connectors registers an app with{" "}
          {p.displayName} once, then anyone here can connect by signing in — no key is ever typed.
        </Notice>
      )}
      {!none && !notYet && only === "workspace" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">Automations and everyone&apos;s Forge chats can use these.</p>
          {workspace.length ? (
            <ul className="conn-list" aria-label="Workspace connections">
              {workspace.map((c) => row(c, canEnable))}
            </ul>
          ) : (
            <p className="conn-empty">{canEnable ? "None yet." : "None yet. Someone allowed to connect services can add one."}</p>
          )}
        </div>
      )}
      {!none && !notYet && only === "me" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">Your own account. Only you see these; actions you switch on for yourself run through it.</p>
          {mine.length ? (
            <ul className="conn-list" aria-label="Your connections">
              {mine.map((c) => row(c, true))}
            </ul>
          ) : (
            <p className="conn-empty">{connectable ? "None. Use Connect as yourself to add your own account." : "None."}</p>
          )}
        </div>
      )}

      <ConnectDialog
        whose={connecting}
        p={p}
        forms={forms}
        canSignIn={canSignIn}
        onClose={() => setConnecting(null)}
        onSignIn={(whose) => {
          setConnecting(null);
          setSigningIn({ whose });
        }}
        onConnected={() => {
          setConnecting(null);
          toast.success("Connected. Test it to check the service accepts it.");
          onChange();
        }}
      />
      <Modal open={!!rotating} onClose={() => setRotating(null)} title={`Change “${rotating?.label ?? ""}”`}>
        {rotating && (
          <RotateForm
            c={rotating}
            forms={forms}
            onDone={() => {
              setRotating(null);
              toast.success("Saved. Test it to check the service accepts it.");
              onChange();
            }}
            onCancel={() => setRotating(null)}
          />
        )}
      </Modal>
      {signIn && oauth && (
        <SignInDialog
          open={!!signingIn}
          again={signingIn?.again}
          whose={signingIn?.whose ?? "me"}
          p={p}
          auth={signIn}
          scopes={oauth.scopes}
          onClose={() => setSigningIn(null)}
          onConnected={() => {
            setSigningIn(null);
            toast.success("Connected.");
            onChange();
          }}
        />
      )}
      <Confirm
        open={!!removing}
        danger
        title={`Remove “${removing?.label ?? ""}”?`}
        body="Its stored credential is deleted. A connection that actions still use cannot be removed — switch them off first."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const c = removing!;
          try {
            await deleteConnectorConnection(c.id);
            toast.success(`Removed “${c.label}”.`);
            onChange();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </section>
  );
}

/** What a new connection is for, in one line on the form. */
function whoseLine(whose: Whose, name: string): string {
  return whose === "me"
    ? `Your own ${name} account. Only you can see or use it; in a Forge chat you choose when it is used.`
    : `The workspace's ${name} connection. Automations and everyone's Forge chats can use it.`;
}

/** Connect: by signing in or with a key/token when the service offers both, then the form for the one chosen. */
function ConnectDialog({
  whose,
  p,
  forms,
  canSignIn,
  onClose,
  onSignIn,
  onConnected,
}: {
  whose: Whose | null;
  p: WorkspaceConnector;
  forms: ConnectorAuth[];
  canSignIn: boolean;
  onClose: () => void;
  onSignIn: (whose: Whose) => void;
  onConnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [whose]);
  const title = whose === "me" ? `Connect ${p.displayName} as yourself` : `Connect ${p.displayName} for the workspace`;
  return (
    <Modal open={!!whose} onClose={busy ? () => {} : onClose} title={title}>
      {whose && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">{whoseLine(whose, p.displayName)}</p>
          {canSignIn && (
            <div className="conn-signin">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Sign in with {p.displayName}</span>
                <span className="block text-xs text-muted">You approve access there; nobody types or sees a token.</span>
              </span>
              <Button size="sm" onClick={() => onSignIn(whose)}>
                Sign in
              </Button>
            </div>
          )}
          {canSignIn && <p className="text-center text-caption text-dim">or use a key or token</p>}
          <ConnectionForm
            auths={forms}
            busy={busy}
            error={error}
            onCancel={onClose}
            onSubmit={async (input) => {
              setBusy(true);
              setError(null);
              try {
                await createConnectorConnection(p.short, { ...input, asMe: whose === "me" });
                onConnected();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function RotateForm({ c, forms, onDone, onCancel }: { c: ConnectorConnection; forms: ConnectorAuth[]; onDone: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConnectionForm
      auths={forms.filter((f) => f.type === c.authType)}
      existing={c}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={async (input) => {
        setBusy(true);
        setError(null);
        try {
          await updateConnectorConnection(c.id, {
            ...(input.label !== c.label ? { label: input.label } : {}),
            ...(Object.keys(input.fields).length ? { fields: input.fields } : {}),
          });
          onDone();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The groups an action falls in, in the order shown: what it does to the service decides where it sits. */
const GROUPS = [
  { key: "reads", title: "Reads", note: "Looks things up; changes nothing." },
  { key: "changes", title: "Changes data", note: "Creates or updates. A test run records the call and does not perform it." },
  { key: "deletes", title: "Deletes data", note: "Removes data. Never used from a Forge chat." },
  { key: "unavailable", title: "Not offered", note: "Tether cannot run these yet, or will not." },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];
function groupOf(a: ConnectorAction): GroupKey {
  if (!offerable(a)) return "unavailable";
  if (a.destructive) return "deletes";
  return a.writes ? "changes" : "reads";
}

/**
 * One list of a connector's actions with switches — the workspace's and a person's own use the same one, so a group, a
 * search and a save behave the same on both tabs. `locked` actions show switched on and cannot be changed here.
 */
function ActionList({
  p,
  title,
  summary,
  on: onNames,
  locked,
  editable,
  note,
  extra,
  dirtyExtra,
  onDiscardExtra,
  saveLabel,
  save,
}: {
  p: WorkspaceConnector;
  title: string;
  summary: (on: number, offered: number) => string;
  on: Set<string>;
  locked?: Set<string>;
  /** Switches may be used at all (permission, a connection, the admin's yes). */
  editable: boolean;
  /** Said in place of the switches' meaning when they cannot be used. */
  note?: string | null;
  extra?: React.ReactNode;
  dirtyExtra?: boolean;
  onDiscardExtra?: () => void;
  saveLabel: string;
  save: (names: string[]) => Promise<void>;
}) {
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(onNames);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | "on">("all");
  useEffect(() => setChosen(new Set(onNames)), [onNames]);

  const isOn = (name: string) => chosen.has(name) || !!locked?.has(name);
  const changed = [...chosen].filter((a) => !onNames.has(a)).length + [...onNames].filter((a) => !chosen.has(a)).length;
  const dirty = changed > 0 || !!dirtyExtra;
  const q = query.trim().toLowerCase();
  const visible = p.actions
    .filter((a) => !q || a.displayName.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.name.includes(q))
    .filter((a) => show === "all" || isOn(a.name))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const offered = p.actions.filter(offerable);
  const onCount = offered.filter((a) => isOn(a.name)).length;

  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChosen(next);
  };
  const doSave = async () => {
    setBusy(true);
    try {
      await save([...chosen]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted">{summary(onCount, offered.length)}</p>
        </div>
        {extra}
      </div>
      {note && <p className="conn-empty">{note}</p>}
      <div className="act-toolbar">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${p.actions.length} actions`} aria-label="Search actions" className="max-w-xs" />
        <span className="act-seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>
            All
          </button>
          <button type="button" aria-pressed={show === "on"} onClick={() => setShow("on")}>
            On ({onCount})
          </button>
        </span>
      </div>
      <div className="flex flex-col gap-4" role="list" aria-label="Actions">
        {GROUPS.map((g) => {
          const items = visible.filter((a) => groupOf(a) === g.key);
          if (!items.length) return null;
          const body = (
            <ul className="act-grid">
              {items.map((a) => {
                const can = offerable(a);
                const forEveryone = !!locked?.has(a.name);
                const on = isOn(a.name);
                const effect = actionEffect(a);
                return (
                  <li key={a.name} role="listitem" className={`act-row${on ? " on" : ""}`}>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {a.displayName}
                        {can && effect.label === "May change data" && <Tag>May change data</Tag>}
                        {forEveryone && <Tag>On for everyone</Tag>}
                      </span>
                      <span className="act-desc" title={a.description}>
                        {can ? a.description : a.name === "custom_api_call" ? "Never offered: with the connection it can reach any address of the service." : a.unsupported.join("; ")}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      className="act-switch"
                      aria-label={`Use ${a.displayName}`}
                      aria-checked={on}
                      checked={on}
                      disabled={!editable || !can || forEveryone}
                      title={forEveryone ? "Switched on for everyone in this workspace" : undefined}
                      onChange={() => toggle(a.name)}
                    />
                  </li>
                );
              })}
            </ul>
          );
          return g.key === "unavailable" ? (
            <details key={g.key} className="act-group">
              <summary>
                <span className="act-group-title">{g.title}</span>
                <span className="act-count">{items.length}</span>
                <span className="act-note">{g.note}</span>
              </summary>
              {body}
            </details>
          ) : (
            <div key={g.key} className="act-group">
              <div className="act-group-head">
                <span className="act-group-title">{g.title}</span>
                <span className="act-count">
                  {items.filter((a) => isOn(a.name)).length} / {items.length} on
                </span>
                <span className="act-note">{g.note}</span>
              </div>
              {body}
            </div>
          );
        })}
        {!visible.length && <p className="conn-empty">{show === "on" ? "No action is on." : `No action matches “${query}”.`}</p>}
      </div>
      {editable && dirty && (
        <div className="act-savebar" role="region" aria-label="Unsaved changes">
          <span className="text-sm">{changed ? `${changed} change${changed === 1 ? "" : "s"} not saved` : "The connection changed"}</span>
          <span className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setChosen(new Set(onNames));
                onDiscardExtra?.();
              }}
            >
              Discard
            </Button>
            <Button size="sm" disabled={busy} onClick={doSave}>
              {busy ? "Saving…" : saveLabel}
            </Button>
          </span>
        </div>
      )}
    </section>
  );
}

/** For the workspace: on for everyone, through the workspace's connection. Read-only to anyone but an admin. */
function WorkspaceActions({ p: all, canEnable, onChange }: { p: WorkspaceConnector; canEnable: boolean; onChange: () => void }) {
  const toast = useToast();
  // ⚠ A personal connection is never offered here: an action switched on for the workspace runs through the workspace's.
  const p = useMemo(() => ({ ...all, connections: all.connections.filter((c) => !c.personal) }), [all]);
  const enabledNames = useMemo(() => new Set(p.enabled.map((e) => e.action)), [p.enabled]);
  const current = p.enabled[0]?.connection ?? p.connections[0]?.id ?? "";
  const [connectionId, setConnectionId] = useState(current);
  useEffect(() => setConnectionId(current), [current]);
  const noConnection = p.connections.length === 0;
  return (
    <ActionList
      p={p}
      title="Actions for the workspace"
      summary={(on, offered) => `${on} of ${offered} on. Each one that is on can be used by automations and Forge chats here.`}
      on={enabledNames}
      editable={canEnable && !noConnection}
      note={noConnection ? (canEnable ? `Connect ${p.displayName} for the workspace first, then choose its actions here.` : `The workspace has no ${p.displayName} connection, so nothing is on for everyone.`) : null}
      extra={
        canEnable && p.connections.length > 1 ? (
          <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} aria-label="Through which connection">
            {p.connections.map((c) => (
              <option key={c.id} value={c.id}>
                Run through {c.label}
              </option>
            ))}
          </Select>
        ) : null
      }
      dirtyExtra={connectionId !== current}
      onDiscardExtra={() => setConnectionId(current)}
      saveLabel="Save actions"
      save={async (names) => {
        await setConnectorActions(p.short, connectionId, names);
        toast.success("Saved. Automations and Forge chats in this workspace can use the actions that are on.");
        onChange();
      }}
    />
  );
}

/** For me: on for this person only, through their own connection. What the workspace has on shows locked. */
function MyActions({ p, mine, error, onChange }: { p: WorkspaceConnector; mine: PersonalConnectorView | null | undefined; error: string | null | undefined; onChange: () => void }) {
  const toast = useToast();
  const onNames = useMemo(() => new Set(mine?.actions ?? []), [mine]);
  const locked = useMemo(() => new Set(p.enabled.map((e) => e.action)), [p.enabled]);
  if (error) return <Notice tone="danger" title="Your actions could not be read">{error} — this is a failure to ask, not a statement that none are on.</Notice>;
  if (!mine) return <p className="text-sm text-muted">Reading…</p>;
  const note = !mine.allowed
    ? `An admin has turned off members switching ${p.displayName} actions on for themselves in this workspace.`
    : !mine.connected
      ? `Connect your own ${p.displayName} account first (Connect as yourself); actions you switch on run through it.`
      : null;
  return (
    <ActionList
      p={p}
      title="Your actions"
      summary={(on, offered) => `${on} of ${offered} on for you. Actions on for everyone are included and cannot be switched off here.`}
      on={onNames}
      locked={locked}
      editable={mine.allowed && mine.connected}
      note={note}
      saveLabel="Save my actions"
      save={async (names) => {
        await setMyConnectorActions(p.short, names);
        toast.success("Saved. Your Forge chats and the workflows you own can use them, through your own account.");
        onChange();
      }}
    />
  );
}

/** An admin: may members switch this connector's actions on for themselves here? */
function PersonalUsePanel({ short, name, allowed, onChange }: { short: string; name: string; allowed: boolean | null; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <section aria-labelledby="personal-use-h" className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
      <span className="min-w-0 flex-1">
        <h2 id="personal-use-h" className="text-sm font-semibold">
          Members may use their own {name} account
        </h2>
        <span className="block text-xs text-muted">
          When on, anyone here can switch {name} actions on for themselves, through their own account. Turning it off stops those actions at their next use.
        </span>
      </span>
      {allowed === null ? (
        <span className="text-xs text-muted">Reading…</span>
      ) : (
        <input
          type="checkbox"
          role="switch"
          className="act-switch"
          aria-label={`Members may use their own ${name} account`}
          aria-checked={allowed}
          checked={allowed}
          disabled={busy}
          onChange={async () => {
            setBusy(true);
            try {
              await setPersonalUse(short, !allowed);
              toast.success(!allowed ? "Members may now switch its actions on for themselves." : "Members can no longer use their own account for it.");
              onChange();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}

// ── The deployment's install (platform.plugins.install) ──────────────────────────────────────────────────────────────

function InstallPanel({ short, onGone }: { short: string; onGone: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const res = useAsync(listConnectorInstalls, [short]);
  const i: ConnectorInstall | null = res.data?.find((x) => x.short === short) ?? null;
  const [hostsText, setHostsText] = useState("");
  const [version, setVersion] = useState("");
  const [confirm, setConfirm] = useState<"upgrade" | "uninstall" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setHostsText((i?.hosts ?? []).join("\n")), [i?.hosts]);

  if (res.error) {
    return (
      <Zone name="related">
        <Notice tone="danger" title="Could not read this deployment's installs">
          {res.error}
        </Notice>
      </Zone>
    );
  }
  if (!i) return null;
  const hasSignIn = i.auth.some((a) => a.type === "OAUTH2");
  const unapproved = i.suggestedHosts.filter((h) => !i.hosts.includes(h));
  const saveHosts = async (hosts: string[]) => {
    setBusy(true);
    try {
      await setConnectorHosts(short, hosts);
      toast.success("Approved hosts saved.");
      res.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Zone name="related">
      <section aria-labelledby="install-h" className="flex flex-col gap-3">
        <h2 id="install-h" className="text-base font-semibold">
          Installation (this deployment)
        </h2>
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <span className="text-muted">Version </span>
            {i.version}
          </li>
          <li>
            <span className="text-muted">Licence </span>
            {i.license ?? "not stated by the package"}
          </li>
          <li>
            <span className="text-muted">Installed </span>
            {i.status === "unrecorded"
              ? "before installs were recorded"
              : i.status === "missing"
                ? "— recorded, but the connector service does not have it; install it again"
                : `by ${i.installedBy ?? "unknown"}${i.installedAt ? ` on ${new Date(i.installedAt).toLocaleString()}` : ""}`}
          </li>
        </ul>

        <Field
          label="Approved hosts"
          hint="Beyond the service a connection names, a run of this connector may reach only these. One per line: host, host:port or *.domain. Private and internal addresses are always refused."
        >
          <Textarea rows={3} value={hostsText} onChange={(e) => setHostsText(e.target.value)} aria-label="Approved hosts" />
        </Field>
        {unapproved.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Its code mentions:</span>
            {unapproved.map((h) => (
              <button
                key={h}
                type="button"
                className="rounded border border-line px-2 py-0.5 hover:border-accent"
                onClick={() => setHostsText(parseHosts(`${hostsText}\n${h}`).join("\n"))}
                title="Add to the approved hosts (then save)"
              >
                + {h}
              </button>
            ))}
            <span className="text-dim">— a suggestion from scanning its code, not a list of what it needs.</span>
          </div>
        )}
        {hasSignIn && <OauthAppPanel short={short} name={i.displayName} onChange={onGone} />}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => saveHosts(parseHosts(hostsText))}>
            Save hosts
          </Button>
          <span className="ml-auto flex items-end gap-2">
            <Input className="w-28" placeholder="x.y.z" value={version} onChange={(e) => setVersion(e.target.value.trim())} aria-label="Upgrade to version" />
            <Button size="sm" variant="subtle" disabled={busy || !/^\d+\.\d+\.\d+$/.test(version)} onClick={() => setConfirm("upgrade")}>
              Upgrade
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("uninstall")}>
              Uninstall
            </Button>
          </span>
        </div>
      </section>
      <Confirm
        open={confirm === "upgrade"}
        title={`Upgrade to ${version}?`}
        body="Every workspace moves to the new version. Approved automations that use it are suspended until they are approved again against the new code."
        confirmLabel="Upgrade"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            const r = await upgradeConnector(short, version);
            toast.success(`Upgraded. ${r.toolsRepointed} tool${r.toolsRepointed === 1 ? "" : "s"} moved to ${r.install.version}.`);
            setVersion("");
            res.reload();
            onGone();
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Confirm
        open={confirm === "uninstall"}
        danger
        title="Uninstall from this deployment?"
        body="Refused while any workspace still has a connection to it or actions switched on."
        confirmLabel="Uninstall"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await uninstallConnector(short);
            toast.success("Uninstalled.");
            router.push("/apps");
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </Zone>
  );
}

// ── Signing in (OAuth) ──────────────────────────────────────────────────────────────────────────────────────────────

/** What the sign-in page sent back (`?connected=…` / `?oauthError=…`), read once and then cleared from the address. */
function useSignInReturn(): { connected?: string; error?: string } | null {
  const router = useRouter();
  const [out, setOut] = useState<{ connected?: string; error?: string } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const connected = q.get("connected");
    const error = q.get("oauthError");
    if (connected === null && error === null) return;
    setOut({ ...(connected !== null ? { connected } : {}), ...(error ? { error } : {}) });
    router.replace(window.location.pathname);
  }, [router]);
  return out;
}

/**
 * Connect by signing in. The person names the connection, fills any value the provider's address needs (a tenant),
 * sees what will be asked for, and is sent to the provider. ⚠ Nothing secret is typed here — consent happens there.
 */
function SignInDialog({
  open,
  again,
  p,
  auth,
  scopes,
  whose,
  onClose,
  onConnected,
}: {
  open: boolean;
  again?: ConnectorConnection;
  whose: Whose;
  p: WorkspaceConnector;
  auth: ConnectorAuth;
  scopes: string[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const [label, setLabel] = useState("");
  const asMe = again ? !!again.personal : whose === "me";
  const [props, setProps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLabel(again?.label ?? "");
    setProps({});
    setError(null);
    setBusy(false);
  }, [open, again]);
  const fields = again ? [] : (auth.fields ?? []);

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={again ? `Sign “${again.label}” in again` : `Sign in to ${p.displayName}${whose === "me" ? " as yourself" : " for the workspace"}`}>
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await startConnectorOauth(p.short, again ? { connectionId: again.id } : { label: label.trim(), asMe, props });
            if ("authorizeUrl" in r) {
              window.location.assign(r.authorizeUrl);
              return; // the browser leaves; the provider sends it back to /api/oauth/callback
            }
            onConnected();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="text-muted">
          You will be sent to {p.displayName} to sign in and approve access, then brought back here. Tether stores the
          access it is given, encrypted; nobody types or sees a token.
        </p>
        {!again && (
          <Field label="Name" hint="How this connection is shown here, e.g. the account or organisation it reaches.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} aria-label="Connection name" />
          </Field>
        )}
        {fields.map((f) => (
          <Field key={f.name} label={f.label ?? f.name} hint={f.description || undefined}>
            {fieldInput(f) === "select" ? (
              <Select value={props[f.name] ?? ""} onChange={(e) => setProps({ ...props, [f.name]: e.target.value })} aria-label={f.label ?? f.name}>
                <option value="">Choose…</option>
                {f.options!.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={props[f.name] ?? ""} onChange={(e) => setProps({ ...props, [f.name]: e.target.value })} required={f.required} aria-label={f.label ?? f.name} />
            )}
          </Field>
        ))}
        {!again && <p className="text-xs text-muted">{whoseLine(asMe ? "me" : "workspace", p.displayName)}</p>}
        <p className="text-xs text-dim">
          {p.displayName} will ask you to allow: <span className="text-text">{scopeLine(scopes)}</span>
        </p>
        {error && (
          <Notice tone="danger" title="Could not start the sign-in">
            {error}
          </Notice>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (!again && !label.trim())}>
            {busy ? "Opening…" : `Continue to ${p.displayName}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The OAuth app a connector signs in with (platform.plugins.install). ⚠ The client secret is written and never shown:
 * the field is always empty, and a blank one keeps what is stored.
 */
function OauthAppPanel({ short, name, onChange }: { short: string; name: string; onChange: () => void }) {
  const toast = useToast();
  const res = useAsync(() => connectorOauthApp(short), [short]);
  const app: ConnectorOauthApp | null = res.data ?? null;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [signInApp, setSignInApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (!app) return;
    setClientId(app.clientId ?? "");
    setSecret("");
    setScopes(new Set(app.scopes));
    setSignInApp(app.useSignInApp);
  }, [app]);

  if (res.error) {
    return (
      <Notice tone="danger" title="Could not read this connector's sign-in setup">
        {res.error}
      </Notice>
    );
  }
  if (!app) return null;
  const narrowedTo = app.pieceScopes.filter((x) => scopes.has(x));

  return (
    <section aria-labelledby="oauth-h" className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex items-center gap-2">
        <h3 id="oauth-h" className="text-sm font-semibold">
          Sign-in app
        </h3>
        <StatusPill status={app.configured ? "ok" : "warn"}>{app.configured ? "Set up" : "Not set up"}</StatusPill>
      </div>
      <p className="text-xs text-muted">
        {name} sends people back to Tether only at an address registered with it. Register an OAuth app with {name} once
        {app.newAppUrl ? (
          <>
            {" "}
            (
            <a className="text-accent hover:underline" href={app.newAppUrl} target="_blank" rel="noreferrer">
              open {name}&rsquo;s app page
            </a>
            )
          </>
        ) : null}
        , give it this return address, and enter its client id and secret here. Every workspace then connects by signing
        in.
      </p>
      <Field label="Return address (authorization callback URL)">
        <span className="flex gap-2">
          <Input readOnly value={app.redirectUri} aria-label="Return address" onFocus={(e) => e.currentTarget.select()} />
          <Button
            type="button"
            size="sm"
            variant="subtle"
            onClick={() => navigator.clipboard?.writeText(app.redirectUri).then(() => toast.success("Copied."), () => toast.error("Could not copy; select it instead."))}
          >
            Copy
          </Button>
        </span>
      </Field>
      {app.signInAppOffered && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={signInApp} onChange={(e) => setSignInApp(e.target.checked)} />
          <span>Use Tether&rsquo;s own Microsoft sign-in app — no second app to register; add this return address and the permissions below to it.</span>
        </label>
      )}
      {!signInApp && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client id">
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client id" autoComplete="off" />
          </Field>
          <Field label="Client secret" hint={app.hasClientSecret ? "Stored. Leave blank to keep it." : app.pkce ? "Optional for this connector (it uses PKCE)." : "Shown once by the provider; it is stored encrypted and never shown again."}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Client secret" autoComplete="new-password" />
          </Field>
        </div>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium">Access it asks for</legend>
        <p className="text-xs text-dim">{name} declares these for all its actions. Untick what your enabled actions do not need; nothing can be added.</p>
        <span className="flex flex-wrap gap-3">
          {app.pieceScopes.map((x) => (
            <label key={x} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={scopes.has(x)}
                onChange={() => {
                  const next = new Set(scopes);
                  if (next.has(x)) next.delete(x);
                  else next.add(x);
                  setScopes(next);
                }}
              />
              <code>{x}</code>
            </label>
          ))}
        </span>
      </fieldset>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || (!signInApp && !clientId.trim())}
          onClick={async () => {
            setBusy(true);
            try {
              const all = narrowedTo.length === app.pieceScopes.length;
              await setConnectorOauthApp(short, {
                useSignInApp: signInApp,
                ...(signInApp ? {} : { clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret } : {}) }),
                scopes: all ? [] : narrowedTo,
              });
              setSecret("");
              toast.success("Sign-in app saved.");
              res.reload();
              onChange();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save sign-in app
        </Button>
        {app.configured && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
            Remove
          </Button>
        )}
      </div>
      <Confirm
        open={removing}
        danger
        title="Remove the sign-in app?"
        body="Nobody can connect or sign in again until it is set up again. Existing connections keep working until their access expires and cannot be renewed."
        confirmLabel="Remove"
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          try {
            await removeConnectorOauthApp(short);
            toast.success("Removed.");
            res.reload();
            onChange();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </section>
  );
}
