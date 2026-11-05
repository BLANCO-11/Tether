// Edge agent (Phase 6): setup curl → register → Approve → credential; legacy OTP; jobs.
import { resolveWorkspaceId } from "@/lib/foundry-client";
import { signInIfEnded } from "@/lib/session-expiry";

const PROXY = "/api/foundry";

/** Derived from status + lastSeenAt (agent claim poll ~2s). */
export type EdgeConnection = "online" | "offline" | "pairing" | "awaiting_connect" | "revoked";

export type EdgeDevice = {
  id: string;
  workspaceId: string;
  name: string;
  ownerSubject: string;
  status: "pairing" | "awaiting_connect" | "active" | "revoked";
  /** Live connection: online while the agent is polling. */
  connection?: EdgeConnection;
  pairingExpiresAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  agentLabel?: string | null;
};

/** Fallback when an older server omits `connection`. */
export function edgeConnectionOf(d: EdgeDevice, now = Date.now()): EdgeConnection {
  if (d.connection) return d.connection;
  if (d.status === "pairing") return "pairing";
  if (d.status === "awaiting_connect") return "awaiting_connect";
  if (d.status === "revoked") return "revoked";
  if (d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 15_000) return "online";
  return "offline";
}

export function edgeConnectionLabel(c: EdgeConnection): string {
  switch (c) {
    case "online":
      return "Connected";
    case "offline":
      return "Offline";
    case "pairing":
      return "Waiting for code";
    case "awaiting_connect":
      return "Waiting for approval";
    case "revoked":
      return "Revoked";
  }
}

export type EdgeJob = {
  id: string;
  deviceId: string;
  kind: "run_command" | "read_path" | "write_path";
  payload: Record<string, unknown>;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
};

async function said(res: Response): Promise<string> {
  const text = await res.text();
  signInIfEnded(res.status, text);
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || `The request failed (${res.status}).`;
  }
}

const base = async () => `${PROXY}/workspaces/${await resolveWorkspaceId()}/edge`;

export async function listEdgeDevices(): Promise<EdgeDevice[]> {
  const res = await fetch(`${await base()}/devices`, { cache: "no-store" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { devices: EdgeDevice[] }).devices;
}

/** Mint a copy-paste curl for an agent. Fetching instructions does not pair; registering only requests connect. */
export async function mintEdgeSetupLink(name?: string): Promise<{ curl: string; url: string; expiresAt: string; label: string }> {
  const res = await fetch(`${await base()}/setup-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await said(res));
  return res.json();
}

export async function approveEdgeConnect(deviceId: string): Promise<EdgeDevice> {
  const res = await fetch(`${await base()}/devices/${deviceId}/approve-connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { device: EdgeDevice }).device;
}

export async function denyEdgeConnect(deviceId: string): Promise<void> {
  const res = await fetch(`${await base()}/devices/${deviceId}/deny-connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(await said(res));
}

/** Legacy OTP mint (advanced). */
export async function beginEdgePairing(name?: string): Promise<{ device: EdgeDevice; pairingCode: string; expiresAt: string }> {
  const res = await fetch(`${await base()}/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await said(res));
  return res.json();
}

export async function revokeEdgeDevice(deviceId: string): Promise<void> {
  const res = await fetch(`${await base()}/devices/${deviceId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await said(res));
}

export async function enqueueEdgeJob(
  deviceId: string,
  kind: EdgeJob["kind"],
  payload: Record<string, unknown>,
): Promise<EdgeJob> {
  const res = await fetch(`${await base()}/devices/${deviceId}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, payload }),
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { job: EdgeJob }).job;
}

export async function approveEdgeJob(jobId: string): Promise<EdgeJob> {
  const res = await fetch(`${await base()}/jobs/${jobId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { job: EdgeJob }).job;
}

export async function rejectEdgeJob(jobId: string): Promise<EdgeJob> {
  const res = await fetch(`${await base()}/jobs/${jobId}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { job: EdgeJob }).job;
}

export async function listEdgePending(): Promise<{ jobs: EdgeJob[]; connects: EdgeDevice[] }> {
  const res = await fetch(`${await base()}/pending`, { cache: "no-store" });
  if (!res.ok) throw new Error(await said(res));
  const body = (await res.json()) as { jobs?: EdgeJob[]; connects?: EdgeDevice[] };
  return { jobs: body.jobs ?? [], connects: body.connects ?? [] };
}

/** Jobs awaiting approval (Needs you badge / Devices). */
export async function listPendingEdgeJobs(): Promise<EdgeJob[]> {
  return (await listEdgePending()).jobs;
}

export async function listPendingEdgeConnects(): Promise<EdgeDevice[]> {
  return (await listEdgePending()).connects;
}
