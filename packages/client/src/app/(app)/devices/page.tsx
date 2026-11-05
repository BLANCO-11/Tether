// src/app/(app)/devices/page.tsx — edge agent setup (curl → Approve → credential).
"use client";

import { useState } from "react";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import {
  approveEdgeConnect,
  approveEdgeJob,
  beginEdgePairing,
  denyEdgeConnect,
  enqueueEdgeJob,
  listEdgeDevices,
  listEdgePending,
  mintEdgeSetupLink,
  revokeEdgeDevice,
  type EdgeDevice,
  type EdgeJob,
} from "@/lib/edge";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Confirm } from "@/components/ui/Confirm";

function said(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const body = text.replace(/^\d{3}\s*/, "");
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body;
  }
}

export default function DevicesPage() {
  const toast = useToast();
  const devices = useAsync(() => listEdgeDevices(), []);
  const pending = useAsync(() => listEdgePending(), []);
  const [setup, setSetup] = useState<{ curl: string; expiresAt: string; label: string } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; name: string } | null>(null);
  const [showOtp, setShowOtp] = useState(false);
  const [name, setName] = useState("This computer");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<EdgeDevice | null>(null);
  const [cmdDevice, setCmdDevice] = useState<string | null>(null);
  const [command, setCommand] = useState("uname -a");

  const mintCurl = async () => {
    setBusy(true);
    try {
      const out = await mintEdgeSetupLink(name.trim() || "This computer");
      setSetup({ curl: out.curl, expiresAt: out.expiresAt, label: out.label });
      setPairing(null);
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCurl = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.curl);
      toast.success("Copied — paste into your agent.");
    } catch {
      toast.error("Could not copy. Select the curl and copy manually.");
    }
  };

  const startPair = async () => {
    setBusy(true);
    try {
      const out = await beginEdgePairing(name.trim() || "This computer");
      setPairing({ code: out.pairingCode, expiresAt: out.expiresAt, name: out.device.name });
      setSetup(null);
      devices.reload();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  const enqueue = async () => {
    if (!cmdDevice || !command.trim()) return;
    setBusy(true);
    try {
      const job = await enqueueEdgeJob(cmdDevice, "run_command", { command: command.trim() });
      toast.success(job.status === "awaiting_approval" ? "Waiting for your approval below." : "Queued.");
      pending.reload();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  const approveJob = async (job: EdgeJob) => {
    try {
      await approveEdgeJob(job.id);
      toast.success("Approved — the agent will pick it up.");
      pending.reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  const approveConnect = async (d: EdgeDevice) => {
    try {
      await approveEdgeConnect(d.id);
      toast.success(`Approved “${d.name}” — the agent can collect its credential.`);
      pending.reload();
      devices.reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  const denyConnect = async (d: EdgeDevice) => {
    try {
      await denyEdgeConnect(d.id);
      toast.success("Denied.");
      pending.reload();
      devices.reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  const connects = pending.data?.connects ?? [];
  const jobs = pending.data?.jobs ?? [];
  const activeDevices = (devices.data ?? []).filter((d) => d.status === "active" || d.status === "pairing");

  return (
    <Page>
      <PageHeader
        eyebrow="Devices"
        title="This computer"
        purpose="Copy a setup curl for an agent. When it requests connect, Approve here — then it gets a credential and can run approved jobs."
      />
      <Zone name="content">
        <div className="flex max-w-2xl flex-col gap-6">
          <section className="pane">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Set up an agent</h2>
            </div>
            <div className="space-y-3 px-4 py-3">
              <p className="text-caption text-muted">
                Paste the curl into Cursor, Claude, or a terminal. The agent gets instructions and registers — you Approve before any credential is issued.
              </p>
              <Input aria-label="Device name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="MacBook" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => void mintCurl()}>
                  {busy ? "…" : "Get setup curl"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowOtp((v) => !v)}>
                  {showOtp ? "Hide pairing code" : "Use pairing code instead"}
                </Button>
              </div>
              {setup ? (
                <Notice tone="ok" title={`Setup for “${setup.label}”`}>
                  <pre className="mt-2 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">
                    {setup.curl}
                  </pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void copyCurl()}>
                      Copy curl
                    </Button>
                  </div>
                  <p className="mt-2 text-caption text-muted">
                    After the agent registers, Approve the connect request below (or in Needs you). Expires{" "}
                    {new Date(setup.expiresAt).toLocaleTimeString()}.
                  </p>
                </Notice>
              ) : null}
              {showOtp ? (
                <div className="space-y-2 border-t border-line pt-3">
                  <p className="text-caption text-muted">Legacy: 6-digit code. Prefer the setup curl.</p>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void startPair()}>
                    Get pairing code
                  </Button>
                  {pairing ? (
                    <Notice tone="ok" title={`Code ${pairing.code}`}>
                      <p className="mt-1 font-mono text-[15px] tracking-widest">{pairing.code}</p>
                      <p className="mt-2 text-caption">
                        On the host:{" "}
                        <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">
                          node scripts/edge-agent.mjs pair --code {pairing.code}
                        </code>
                        , then <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">node scripts/edge-agent.mjs run</code>.
                        Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.
                      </p>
                    </Notice>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          {connects.length > 0 ? (
            <section className="pane" aria-label="Pending connect requests">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Approve connect</h2>
              </div>
              <div className="px-4 py-3">
                <ul className="flex flex-col gap-2">
                  {connects.map((d) => (
                    <li key={d.id} className="flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-body font-medium">{d.name}</p>
                        <p className="text-caption text-muted">
                          Waiting for you
                          {d.agentLabel ? ` · ${d.agentLabel}` : ""}
                          {d.pairingExpiresAt ? ` · expires ${new Date(d.pairingExpiresAt).toLocaleTimeString()}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" onClick={() => void approveConnect(d)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void denyConnect(d)}>
                          Deny
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="pane" aria-label="Paired devices">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Paired</h2>
            </div>
            <div className="px-4 py-3">
              {devices.error ? (
                <Notice tone="danger" title="Could not load devices">
                  {devices.error}
                </Notice>
              ) : devices.loading && !devices.data ? (
                <Skeleton />
              ) : !activeDevices.length ? (
                <p className="text-caption text-muted">None yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {activeDevices.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-body font-medium">{d.name}</p>
                        <p className="text-caption text-muted">
                          {d.status}
                          {d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {d.status === "active" ? (
                          <Button size="sm" variant="ghost" onClick={() => setCmdDevice(d.id)}>
                            Run…
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(d)}>
                          Revoke
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {cmdDevice ? (
            <section className="pane">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Queue a command</h2>
              </div>
              <div className="space-y-3 px-4 py-3">
                <Input aria-label="Shell command" className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !command.trim()} onClick={() => void enqueue()}>
                    Queue (needs approval)
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCmdDevice(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="pane" aria-label="Pending edge job approvals">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Needs approval</h2>
            </div>
            <div className="px-4 py-3">
              {jobs.length === 0 ? (
                <p className="text-caption text-muted">No edge jobs waiting.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {jobs.map((j) => (
                    <li key={j.id} className="flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-caption font-medium uppercase text-muted">{j.kind}</p>
                        <p className="font-mono text-[13px] text-text">{JSON.stringify(j.payload)}</p>
                      </div>
                      <Button size="sm" onClick={() => void approveJob(j)}>
                        Approve
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </Zone>

      <Confirm
        open={!!revoking}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        body="The host can no longer claim jobs. Set up again to reconnect."
        confirmLabel="Revoke"
        danger
        onConfirm={() =>
          revoking &&
          void (async () => {
            try {
              await revokeEdgeDevice(revoking.id);
              toast.success("Revoked.");
              devices.reload();
            } catch (e) {
              toast.error(said(e));
            } finally {
              setRevoking(null);
            }
          })()
        }
        onClose={() => setRevoking(null)}
      />
    </Page>
  );
}
