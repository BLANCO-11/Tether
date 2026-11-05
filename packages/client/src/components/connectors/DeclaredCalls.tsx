"use client";

import { useState } from "react";
import { declareCall, enableCallPack, enableMyCallPack, listDeclaredCalls, removeDeclaredCall, removeMyDeclaredCall } from "@/lib/api";
import type { ConnectorConnection, DeclaredParam, PersonalConnectorView } from "@/lib/types";
import { emptyDeclaredCallForm, pathBlanks, toDeclaredCall, type DeclaredCallForm } from "@/lib/declared-call-form";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Badge";
import { Confirm } from "@/components/ui/Confirm";

/**
 * Declared API calls on a connector page (plans/declared-api-calls-2026-10-29, phase 3). A connector's raw call is never
 * offered as such — it would take any address and method at run time. Here a call is FIXED in advance (method, path
 * with blanks, fixed query, what goes in the body) and becomes an ordinary action; a run fills only the blanks, and the
 * connector refuses anything that leaves the template. Curated packs come first; writing one is for `plugins.enable`.
 *
 * ⚠ Three states, as everywhere: calls, none, and UNREADABLE — which says the check did not run.
 */
export const DECLARED_EXPLAINED =
  "Calls to this service that its own actions do not cover, fixed in advance: the address and method cannot change when an automation runs it, only the blanks are filled.";

export function DeclaredCalls({ short, connections, canEnable }: { short: string; connections: ConnectorConnection[]; canEnable: boolean }) {
  const toast = useToast();
  const res = useAsync(() => listDeclaredCalls(short), [short]);
  const workspaceConns = connections.filter((c) => !c.personal);
  const [connectionId, setConnectionId] = useState(workspaceConns[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  const [off, setOff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pack = async (key: string) => {
    setBusy(true);
    try {
      const r = await enableCallPack(short, key, connectionId);
      toast.success(`${r.calls.length} calls switched on. Automations and Forge chats here can use them.`);
      res.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const switchOff = async (name: string) => {
    try {
      await removeDeclaredCall(short, name);
      toast.success("Switched off. An automation that used it now fails, saying so.");
      res.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const data = res.data;
  const offeredPacks = (data?.packs ?? []).filter((p) => !p.calls.every((c) => data?.calls.some((d) => d.name === c.name && d.on)));

  return (
    <section aria-labelledby="declared-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="declared-h" className="text-base font-semibold">
            More calls to this service
          </h2>
          <p className="text-xs text-muted">{DECLARED_EXPLAINED}</p>
        </div>
        {canEnable && workspaceConns.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Add a call
          </Button>
        )}
      </div>

      {res.error ? (
        <p className="text-xs text-warn">These calls could not be read ({res.error}).</p>
      ) : !data ? (
        <p className="text-xs text-muted">Reading…</p>
      ) : (
        <>
          {canEnable && workspaceConns.length > 1 && (offeredPacks.length > 0 || adding) && (
            <Field label="Through the connection">
              <Select aria-label="Through the connection" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {workspaceConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {offeredPacks.map((p) => (
            <div key={p.key} className="pane flex flex-col gap-2 p-3" data-pack={p.key}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{p.displayName}</span>
                <Tag>ready-made</Tag>
              </div>
              <p className="text-xs text-muted">{p.description}</p>
              <ul className="text-xs text-muted">
                {p.calls.map((c) => (
                  <li key={c.name}>
                    {c.displayName}
                    {c.writes ? " · changes data" : ""}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-dim">{p.needs}</p>
              {canEnable ? (
                workspaceConns.length === 0 ? (
                  <p className="text-xs text-muted">Connect this service for the workspace first.</p>
                ) : (
                  <div>
                    <Button size="sm" disabled={busy || !connectionId} onClick={() => void pack(p.key)}>
                      Switch on {p.displayName}
                    </Button>
                  </div>
                )
              ) : null}
            </div>
          ))}
          {data.calls.length === 0 ? (
            offeredPacks.length === 0 && <p className="text-xs text-muted">None yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" aria-label="Declared calls">
              {data.calls.map((c) => (
                <li key={c.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{c.displayName}</span>
                      {c.writes && <Tag>changes data</Tag>}
                      {c.pack && <Tag>{c.pack}</Tag>}
                      {!c.on && <Tag>off</Tag>}
                    </div>
                    <p className="truncate font-mono text-xs text-dim">
                      {c.declaration.method} {c.declaration.path}
                    </p>
                  </div>
                  {canEnable && c.on && (
                    <Button size="sm" variant="ghost" onClick={() => setOff(c.name)}>
                      Switch off
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a call">
        <AddCall
          short={short}
          connectionId={connectionId}
          busy={busy}
          onDone={() => {
            setAdding(false);
            res.reload();
          }}
          onCancel={() => setAdding(false)}
          setBusy={setBusy}
        />
      </Modal>
      <Confirm
        open={off !== null}
        title="Switch this call off?"
        body="Automations that use it will fail, saying it is off, until it is switched on again."
        confirmLabel="Switch off"
        onConfirm={() => off && void switchOff(off)}
        onClose={() => setOff(null)}
      />
    </section>
  );
}

/**
 * For me (plans/personal-actions-2026-10-29): the same packs, switched on for this person only, through their own
 * account. Writing a call of one's own stays an admin's, for the workspace. A pack the workspace already has on for
 * everyone says so instead of offering a personal copy.
 */
export function MyDeclaredCalls({
  short,
  view,
  workspaceOn,
  onChange,
}: {
  short: string;
  view: PersonalConnectorView;
  /** Tool names on for everyone in the workspace. */
  workspaceOn: string[];
  onChange: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState<string | null>(null);
  // The tool name the server gives a call (pluginToolName): service prefix, unless the name already carries it.
  const toolOf = (name: string) => {
    const pre = short.replace(/-/g, "_");
    const n = name.replace(/-/g, "_").toLowerCase();
    return n.startsWith(`${pre}_`) ? n : `${pre}_${n}`;
  };
  const mineHas = (name: string) => view.calls.some((c) => c.name === name);
  const usable = view.allowed && view.connected;
  const pack = async (key: string) => {
    setBusy(true);
    try {
      const r = await enableMyCallPack(short, key);
      toast.success(`${r.calls.length} calls on for you. Your Forge chats and the workflows you own can use them.`);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="my-declared-h" className="flex flex-col gap-3">
      <div>
        <h2 id="my-declared-h" className="text-base font-semibold">
          More calls to this service, for you
        </h2>
        <p className="text-xs text-muted">{DECLARED_EXPLAINED}</p>
      </div>
      {view.packs.map((p) => {
        const everyone = p.calls.every((c) => workspaceOn.includes(toolOf(c.name)));
        const all = p.calls.every((c) => mineHas(c.name) || workspaceOn.includes(toolOf(c.name)));
        if (all && !everyone) return null; // on for you already: listed below
        return (
          <div key={p.key} className="pane flex flex-col gap-2 p-3" data-pack={p.key}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{p.displayName}</span>
              <Tag>ready-made</Tag>
              {everyone && <Tag>On for everyone</Tag>}
            </div>
            <p className="text-xs text-muted">{p.description}</p>
            <ul className="text-xs text-muted">
              {p.calls.map((c) => (
                <li key={c.name}>
                  {c.displayName}
                  {c.writes ? " · changes data" : ""}
                </li>
              ))}
            </ul>
            <p className="text-xs text-dim">{p.needs.replace("The connection's", "Your")}</p>
            {everyone ? (
              <p className="text-xs text-muted">The workspace has these on for everyone already.</p>
            ) : !view.allowed ? (
              <p className="text-xs text-muted">An admin has turned off members switching these on for themselves here.</p>
            ) : !view.connected ? (
              <p className="text-xs text-muted">Connect your own account first (Connect as yourself).</p>
            ) : (
              <div>
                <Button size="sm" disabled={busy || !usable} onClick={() => void pack(p.key)}>
                  Switch on {p.displayName} for me
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {view.calls.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" aria-label="Your declared calls">
          {view.calls.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.displayName}</span>
                  {c.writes && <Tag>changes data</Tag>}
                  {c.pack && <Tag>{c.pack}</Tag>}
                </div>
                <p className="truncate font-mono text-xs text-dim">
                  {c.declaration.method} {c.declaration.path}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOff(c.name)}>
                Switch off
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!view.packs.length && !view.calls.length && <p className="text-xs text-muted">None.</p>}
      <Confirm
        open={off !== null}
        title="Switch this call off for you?"
        body="Your chats stop using it, and workflows you own that call it fail, saying it is off, until you switch it on again."
        confirmLabel="Switch off"
        onConfirm={async () => {
          if (!off) return;
          try {
            await removeMyDeclaredCall(short, off);
            toast.success("Switched off for you.");
            onChange();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
        onClose={() => setOff(null)}
      />
    </section>
  );
}

function AddCall({
  short,
  connectionId,
  busy,
  setBusy,
  onDone,
  onCancel,
}: {
  short: string;
  connectionId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<DeclaredCallForm>(emptyDeclaredCallForm);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<DeclaredCallForm>) => setF({ ...f, ...patch });
  const setParam = (i: number, patch: Partial<DeclaredParam>) => set({ params: f.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const blank = (name = "", where: DeclaredParam["in"] = "query"): DeclaredParam => ({ name, in: where, type: "string", required: where === "path", description: "" });

  const onPath = (path: string) => {
    // A blank named in the path gets its input at once; the person only describes it.
    const have = new Set(f.params.filter((p) => p.in === "path").map((p) => p.name));
    const added = pathBlanks(path).filter((b) => !have.has(b)).map((b) => blank(b, "path"));
    set({ path, params: [...f.params, ...added] });
  };

  const submit = async () => {
    const r = toDeclaredCall(f);
    if ("problem" in r) return setProblem(r.problem);
    setProblem(null);
    setBusy(true);
    try {
      const out = await declareCall(short, connectionId, r.call);
      toast.success(out.changed ? "Changed. Automations using it are turned off until approved again." : "Added and switched on.");
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        The path is added to the connection&apos;s own address. Write blanks as {"{name}"}; a run fills only those, and
        never the address. DELETE is not offered.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Short name" hint="lower_snake_case, e.g. list_repositories">
          <Input aria-label="Short name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Name people read">
          <Input aria-label="Name people read" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </Field>
      </div>
      <Field label="What it does">
        <Input aria-label="What it does" value={f.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
        <Field label="Method">
          <Select aria-label="Method" value={f.method} onChange={(e) => set({ method: e.target.value as DeclaredCallForm["method"] })}>
            {["GET", "POST", "PUT", "PATCH"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="Path" hint="e.g. /{project}/_apis/git/repositories">
          <Input aria-label="Path" value={f.path} onChange={(e) => onPath(e.target.value)} className="font-mono" />
        </Field>
      </div>
      <Field label="Fixed query" hint="One key=value per line, sent on every call, e.g. api-version=7.1">
        <Textarea aria-label="Fixed query" rows={2} value={f.query} onChange={(e) => set({ query: e.target.value })} className="font-mono" />
      </Field>
      {f.method !== "GET" && (
        <Field
          label="Fixed body"
          hint="One field=value per line, sent on every call. Dots nest and [n] is a list position, e.g. commits[0].changes[0].changeType=add"
        >
          <Textarea aria-label="Fixed body" rows={2} value={f.body} onChange={(e) => set({ body: e.target.value })} className="font-mono" />
        </Field>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">Inputs</span>
          <Button size="sm" variant="ghost" onClick={() => set({ params: [...f.params, blank()] })}>
            Add an input
          </Button>
        </div>
        {f.params.map((p, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr_90px_90px_1fr_auto]">
            <Input aria-label={`Input ${i + 1} name`} value={p.name} disabled={p.in === "path"} onChange={(e) => setParam(i, { name: e.target.value })} />
            <Select aria-label={`Input ${i + 1} goes in`} value={p.in} disabled={p.in === "path"} onChange={(e) => setParam(i, { in: e.target.value as DeclaredParam["in"] })}>
              {(p.in === "path" ? ["path"] : f.method === "GET" ? ["query"] : ["query", "body"]).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
            <Select aria-label={`Input ${i + 1} type`} value={p.type} onChange={(e) => setParam(i, { type: e.target.value as DeclaredParam["type"] })}>
              {["string", "number", "boolean"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
            <Input aria-label={`Input ${i + 1} description`} placeholder="What to put here" value={p.description} onChange={(e) => setParam(i, { description: e.target.value })} />
            {p.in === "path" ? (
              <span />
            ) : (
              <Button size="sm" variant="ghost" onClick={() => set({ params: f.params.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            )}
            {p.in !== "path" && (
              <Input
                aria-label={`Input ${i + 1} sent as`}
                placeholder={p.in === "body" ? "Sent as (its place in the body, e.g. commits[0].comment)" : "Sent as (if the service names it differently, e.g. $top)"}
                value={p.key ?? ""}
                onChange={(e) => setParam(i, { key: e.target.value })}
                className="sm:col-span-5"
              />
            )}
          </div>
        ))}
      </div>
      {problem && <p className="text-xs text-danger">{problem}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || !connectionId} onClick={() => void submit()}>
          Add and switch on
        </Button>
      </div>
    </div>
  );
}
