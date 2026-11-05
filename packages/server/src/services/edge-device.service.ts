/**
 * Edge agent devices (personal thin Phase 6) — secure setup link + connect approval, or legacy OTP.
 *
 * Setup URL bootstrap token only lets a host *request* to connect. The owner Approves in Foundry; the agent then
 * collects a one-time device token and polls jobs. Non-allowlisted run_command / write_path need job approval
 * (in-chat card and/or Needs you / Devices). Harmless commands skip approval — see edge-command-allowlist.ts.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { edgeDevices, edgeJobs, edgeSetupLinks } from "../db/schema.js";
import { edgeJobNeedsApproval } from "./edge-command-allowlist.js";

export type EdgeDevice = typeof edgeDevices.$inferSelect;
export type EdgeJob = typeof edgeJobs.$inferSelect;
export type EdgeJobKind = "run_command" | "read_path" | "write_path";

const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

function mintPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function mintDeviceToken(): string {
  return `edg_${randomBytes(24).toString("base64url")}`;
}

function mintSetupToken(): string {
  return `esetup_${randomBytes(24).toString("base64url")}`;
}

function mintWaitSecret(): string {
  return `ewait_${randomBytes(24).toString("base64url")}`;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SETUP_TTL_MS = 30 * 60 * 1000;
/** Agent polls claim every ~2s and updates lastSeenAt; older than this ⇒ not connected. */
export const EDGE_ONLINE_MS = 15_000;

export type EdgeConnection = "online" | "offline" | "pairing" | "awaiting_connect" | "revoked";

export function connectionOf(row: Pick<EdgeDevice, "status" | "lastSeenAt">, now = Date.now()): EdgeConnection {
  if (row.status === "pairing") return "pairing";
  if (row.status === "awaiting_connect") return "awaiting_connect";
  if (row.status === "revoked") return "revoked";
  if (row.lastSeenAt && now - new Date(row.lastSeenAt).getTime() < EDGE_ONLINE_MS) return "online";
  return "offline";
}

function publicDevice(row: EdgeDevice) {
  const { pairingCodeHash: _p, tokenHash: _t, waitSecretHash: _w, connectTokenOnce: _c, ...rest } = row;
  return { ...rest, connection: connectionOf(row) };
}

export const edgeDeviceService = {
  async list(workspaceId: string, ownerSubject: string): Promise<ReturnType<typeof publicDevice>[]> {
    const rows = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.workspaceId, workspaceId), eq(edgeDevices.ownerSubject, ownerSubject), isNull(edgeDevices.revokedAt)))
      .orderBy(desc(edgeDevices.createdAt));
    return rows.map(publicDevice);
  },

  /** Pending connect requests (agent registered; waiting for you to Approve in Foundry). */
  async pendingConnects(workspaceId: string, ownerSubject: string): Promise<ReturnType<typeof publicDevice>[]> {
    const rows = await db
      .select()
      .from(edgeDevices)
      .where(
        and(
          eq(edgeDevices.workspaceId, workspaceId),
          eq(edgeDevices.ownerSubject, ownerSubject),
          eq(edgeDevices.status, "awaiting_connect"),
          isNull(edgeDevices.revokedAt),
        ),
      )
      .orderBy(desc(edgeDevices.createdAt));
    return rows.map(publicDevice);
  },

  /**
   * Mint a setup link. Copy the curl to an agent; fetching it does not pair — registering only requests connect.
   */
  async mintSetupLink(
    workspaceId: string,
    ownerSubject: string,
    label: string,
    apiBase: string,
  ): Promise<{ curl: string; url: string; expiresAt: Date; label: string }> {
    const clean = label.replace(/\s+/g, " ").trim() || "This computer";
    const token = mintSetupToken();
    const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
    await db.insert(edgeSetupLinks).values({
      workspaceId,
      ownerSubject,
      tokenHash: hash(token),
      label: clean.slice(0, 120),
      expiresAt,
    });
    const base = apiBase.replace(/\/+$/, "");
    const url = `${base}/api/edge/setup?t=${encodeURIComponent(token)}`;
    // One-shot for paste-into-agent: fetch bootstrap shell and run it. After Approve, the script starts the agent loop.
    const curl = `curl -fsSL '${base}/api/edge/setup?t=${encodeURIComponent(token)}&fmt=sh' | bash`;
    return { curl, url, expiresAt, label: clean.slice(0, 120) };
  },

  async resolveSetupToken(raw: string) {
    const token = raw.trim();
    if (!token.startsWith("esetup_")) throw httpErr("That setup link is not valid.", 404);
    const [link] = await db.select().from(edgeSetupLinks).where(eq(edgeSetupLinks.tokenHash, hash(token))).limit(1);
    if (!link) throw httpErr("That setup link is not valid.", 404);
    if (link.expiresAt.getTime() < Date.now()) throw httpErr("That setup link has expired. Mint a new one in Devices.", 410);
    if (link.consumedAt) throw httpErr("That setup link was already used. Mint a new one in Devices.", 410);
    return link;
  },

  /**
   * Bash bootstrap: download edge-agent.mjs from this API, run setup (registers → waits for Approve → starts poll loop).
   * The only human step is Approve in Foundry.
   */
  setupBootstrapShell(apiBase: string, setupToken: string, label: string): string {
    const base = apiBase.replace(/\/+$/, "");
    const safeLabel = label.replace(/'/g, "'\\''");
    return `#!/usr/bin/env bash
# Foundry edge setup for "${label.replace(/"/g, "")}"
# Only human step: Approve in Foundry → Devices (or Needs you). Then this script finishes and starts the agent.
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "Node.js is required (node not found on PATH)." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
BASE='${base}'
TOKEN='${setupToken}'
DIR="$HOME/.foundry-edge"
mkdir -p "$DIR"
chmod 700 "$DIR"
curl -fsSL "$BASE/api/edge/agent.mjs" -o "$DIR/edge-agent.mjs"
chmod 700 "$DIR/edge-agent.mjs"
echo ">>> Opening Foundry connect for '${safeLabel}'."
echo ">>> When prompted, Approve once in Foundry → Devices (or Needs you)."
exec node "$DIR/edge-agent.mjs" setup --token "$TOKEN" --url "$BASE" --name '${safeLabel}'
`;
  },

  /** Markdown for agents/humans: one primary action; Approve is the only pause. */
  setupInstructions(apiBase: string, setupToken: string, label: string): string {
    const base = apiBase.replace(/\/+$/, "");
    const sh = `${base}/api/edge/setup?t=${encodeURIComponent(setupToken)}&fmt=sh`;
    return `# Foundry edge agent setup

Connect **${label}** to Foundry. You do the work; the person only Approves once in the app.

## Do this (one command)

\`\`\`bash
curl -fsSL '${sh}' | bash
\`\`\`

That registers this host, waits until the Foundry user Approves in **Devices** or **Needs you**, saves the credential under \`~/.foundry-edge/\`, and **starts the agent loop**. Do not ask them for further shell steps after Approve.

While waiting, tell them once: **Open Foundry → Devices (or Needs you) and Approve “${label.replace(/"/g, "")}”.** Then keep the command running.

## If you already have the Foundry repo on this machine

\`\`\`bash
node scripts/edge-agent.mjs setup --token '${setupToken}' --url '${base}' --name '${label.replace(/'/g, "")}'
\`\`\`

Same behaviour (auto-starts the poll loop after Approve). Use \`--setup-only\` only if you must not start polling yet.

## Notes
- \`run_command\` / \`write_path\` jobs still need a separate Approve in Foundry when queued from chat or Devices.
- Keep the agent process running (terminal, tmux, or LaunchAgent) so chat can reach this computer.
`;
  },

  /**
   * Agent registers a connect attempt. Does not issue a device token until the owner Approves.
   */
  async registerConnect(
    setupToken: string,
    name: string | undefined,
    agentLabel: string | undefined,
  ): Promise<{ deviceId: string; workspaceId: string; waitSecret: string; name: string; status: string }> {
    const link = await this.resolveSetupToken(setupToken);
    const waitSecret = mintWaitSecret();
    const label = (name?.replace(/\s+/g, " ").trim() || link.label || "This computer").slice(0, 120);
    const [row] = await db
      .insert(edgeDevices)
      .values({
        workspaceId: link.workspaceId,
        name: label,
        ownerSubject: link.ownerSubject,
        status: "awaiting_connect",
        waitSecretHash: hash(waitSecret),
        pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS),
        agentLabel: agentLabel?.slice(0, 200) ?? null,
      })
      .returning();
    // One successful register consumes the setup link (new attempt needs a new copy-paste).
    await db.update(edgeSetupLinks).set({ consumedAt: new Date() }).where(eq(edgeSetupLinks.id, link.id));
    return {
      deviceId: row!.id,
      workspaceId: row!.workspaceId,
      waitSecret,
      name: row!.name,
      status: "awaiting_connect",
    };
  },

  async approveConnect(
    workspaceId: string,
    deviceId: string,
    actorSubject: string,
    asAdmin: boolean,
  ): Promise<ReturnType<typeof publicDevice>> {
    const [row] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.id, deviceId), eq(edgeDevices.workspaceId, workspaceId)));
    if (!row || row.revokedAt) throw httpErr("No such connect request.", 404);
    if (!asAdmin && row.ownerSubject !== actorSubject) throw httpErr("No such connect request.", 404);
    if (row.status !== "awaiting_connect") throw httpErr("That device is not waiting for connect approval.", 409);
    if (row.pairingExpiresAt && row.pairingExpiresAt.getTime() < Date.now()) {
      await db.update(edgeDevices).set({ status: "revoked", revokedAt: new Date() }).where(eq(edgeDevices.id, deviceId));
      throw httpErr("That connect request expired.", 410);
    }
    const token = mintDeviceToken();
    const [updated] = await db
      .update(edgeDevices)
      .set({
        status: "active",
        tokenHash: hash(token),
        connectTokenOnce: token,
        pairingCodeHash: null,
        lastSeenAt: new Date(),
      })
      .where(eq(edgeDevices.id, deviceId))
      .returning();
    return publicDevice(updated!);
  },

  async denyConnect(workspaceId: string, deviceId: string, actorSubject: string, asAdmin: boolean): Promise<void> {
    const [row] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.id, deviceId), eq(edgeDevices.workspaceId, workspaceId)));
    if (!row || row.revokedAt) throw httpErr("No such connect request.", 404);
    if (!asAdmin && row.ownerSubject !== actorSubject) throw httpErr("No such connect request.", 404);
    if (row.status !== "awaiting_connect") throw httpErr("That device is not waiting for connect approval.", 409);
    await db
      .update(edgeDevices)
      .set({ status: "revoked", revokedAt: new Date(), waitSecretHash: null, connectTokenOnce: null })
      .where(eq(edgeDevices.id, deviceId));
  },

  /**
   * Agent polls after register. 202-shaped result via `{ status: "waiting" }` or credentials once.
   */
  async waitForConnect(
    deviceId: string,
    waitSecret: string,
  ): Promise<
    | { status: "waiting" }
    | { status: "ready"; deviceId: string; workspaceId: string; token: string; name: string }
    | { status: "denied" }
  > {
    const [row] = await db.select().from(edgeDevices).where(eq(edgeDevices.id, deviceId)).limit(1);
    if (!row || !row.waitSecretHash || row.waitSecretHash !== hash(waitSecret)) {
      throw httpErr("Unknown device or wait secret.", 404);
    }
    if (row.status === "awaiting_connect") {
      if (row.pairingExpiresAt && row.pairingExpiresAt.getTime() < Date.now()) {
        await db.update(edgeDevices).set({ status: "revoked", revokedAt: new Date() }).where(eq(edgeDevices.id, deviceId));
        return { status: "denied" };
      }
      return { status: "waiting" };
    }
    if (row.status === "revoked") return { status: "denied" };
    if (row.status === "active" && row.connectTokenOnce) {
      const token = row.connectTokenOnce;
      await db.update(edgeDevices).set({ connectTokenOnce: null, lastSeenAt: new Date() }).where(eq(edgeDevices.id, deviceId));
      return { status: "ready", deviceId: row.id, workspaceId: row.workspaceId, token, name: row.name };
    }
    if (row.status === "active") {
      throw httpErr("This device is already paired; the connect token was already collected.", 409);
    }
    return { status: "denied" };
  },

  /** Legacy OTP path (advanced). */
  async beginPairing(
    workspaceId: string,
    ownerSubject: string,
    name: string,
  ): Promise<{ device: ReturnType<typeof publicDevice>; pairingCode: string; expiresAt: Date }> {
    const clean = name.replace(/\s+/g, " ").trim() || "This computer";
    const pairingCode = mintPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const [row] = await db
      .insert(edgeDevices)
      .values({
        workspaceId,
        name: clean.slice(0, 120),
        ownerSubject,
        status: "pairing",
        pairingCodeHash: hash(pairingCode),
        pairingExpiresAt: expiresAt,
      })
      .returning();
    return { device: publicDevice(row!), pairingCode, expiresAt };
  },

  async completePairing(pairingCode: string, name?: string): Promise<{ deviceId: string; workspaceId: string; token: string; name: string }> {
    const code = pairingCode.replace(/\s+/g, "").trim();
    if (!/^\d{6}$/.test(code)) throw httpErr("Enter the 6-digit code from Foundry.", 400);
    const [row] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.pairingCodeHash, hash(code)), eq(edgeDevices.status, "pairing")))
      .limit(1);
    if (!row) throw httpErr("That code is wrong or already used.", 404);
    if (!row.pairingExpiresAt || row.pairingExpiresAt.getTime() < Date.now()) {
      throw httpErr("That code has expired. Start pairing again in Foundry.", 410);
    }
    const token = mintDeviceToken();
    const label = name?.replace(/\s+/g, " ").trim();
    const [updated] = await db
      .update(edgeDevices)
      .set({
        status: "active",
        tokenHash: hash(token),
        pairingCodeHash: null,
        pairingExpiresAt: null,
        lastSeenAt: new Date(),
        ...(label ? { name: label.slice(0, 120) } : {}),
      })
      .where(eq(edgeDevices.id, row.id))
      .returning();
    return { deviceId: updated!.id, workspaceId: updated!.workspaceId, token, name: updated!.name };
  },

  async revoke(workspaceId: string, deviceId: string, ownerSubject: string, asAdmin: boolean): Promise<void> {
    const [row] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.id, deviceId), eq(edgeDevices.workspaceId, workspaceId)));
    if (!row || row.revokedAt) throw httpErr("No such device.", 404);
    if (!asAdmin && row.ownerSubject !== ownerSubject) throw httpErr("No such device.", 404);
    await db
      .update(edgeDevices)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        tokenHash: null,
        pairingCodeHash: null,
        waitSecretHash: null,
        connectTokenOnce: null,
      })
      .where(eq(edgeDevices.id, deviceId));
  },

  async deviceFromToken(token: string): Promise<EdgeDevice | null> {
    if (!token.startsWith("edg_")) return null;
    const [row] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.tokenHash, hash(token)), eq(edgeDevices.status, "active")))
      .limit(1);
    return row ?? null;
  },

  async touch(deviceId: string): Promise<void> {
    await db.update(edgeDevices).set({ lastSeenAt: new Date() }).where(eq(edgeDevices.id, deviceId));
  },

  async enqueue(
    workspaceId: string,
    deviceId: string,
    createdBy: string,
    kind: EdgeJobKind,
    payload: Record<string, unknown>,
  ): Promise<EdgeJob> {
    const [dev] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.id, deviceId), eq(edgeDevices.workspaceId, workspaceId), eq(edgeDevices.status, "active")));
    if (!dev) throw httpErr("No such device, or it is not paired.", 404);
    const needsApproval = edgeJobNeedsApproval(kind, payload);
    const [job] = await db
      .insert(edgeJobs)
      .values({
        workspaceId,
        deviceId,
        kind,
        payload,
        status: needsApproval ? "awaiting_approval" : "approved",
        createdBy,
      })
      .returning();
    return job!;
  },

  async approveJob(workspaceId: string, jobId: string, actorSubject: string, asAdmin: boolean): Promise<EdgeJob> {
    const [job] = await db.select().from(edgeJobs).where(and(eq(edgeJobs.id, jobId), eq(edgeJobs.workspaceId, workspaceId)));
    if (!job) throw httpErr("No such job.", 404);
    if (job.status !== "awaiting_approval") throw httpErr("That job is not waiting for approval.", 409);
    const [dev] = await db.select().from(edgeDevices).where(eq(edgeDevices.id, job.deviceId));
    if (!asAdmin && dev?.ownerSubject !== actorSubject) throw httpErr("Only the device's owner can approve this.", 403);
    const [updated] = await db.update(edgeJobs).set({ status: "approved" }).where(eq(edgeJobs.id, jobId)).returning();
    return updated!;
  },

  async rejectJob(workspaceId: string, jobId: string, actorSubject: string, asAdmin: boolean): Promise<EdgeJob> {
    const [job] = await db.select().from(edgeJobs).where(and(eq(edgeJobs.id, jobId), eq(edgeJobs.workspaceId, workspaceId)));
    if (!job) throw httpErr("No such job.", 404);
    if (job.status !== "awaiting_approval") throw httpErr("That job is not waiting for approval.", 409);
    const [dev] = await db.select().from(edgeDevices).where(eq(edgeDevices.id, job.deviceId));
    if (!asAdmin && dev?.ownerSubject !== actorSubject) throw httpErr("Only the device's owner can decline this.", 403);
    const [updated] = await db
      .update(edgeJobs)
      .set({ status: "revoked", error: "Declined.", finishedAt: new Date() })
      .where(eq(edgeJobs.id, jobId))
      .returning();
    return updated!;
  },

  async claimNext(device: EdgeDevice): Promise<EdgeJob | null> {
    await this.touch(device.id);
    const [job] = await db
      .select()
      .from(edgeJobs)
      .where(and(eq(edgeJobs.deviceId, device.id), eq(edgeJobs.status, "approved")))
      .orderBy(asc(edgeJobs.createdAt))
      .limit(1);
    if (!job) return null;
    const [claimed] = await db
      .update(edgeJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(edgeJobs.id, job.id), eq(edgeJobs.status, "approved")))
      .returning();
    return claimed ?? null;
  },

  async completeJob(
    device: EdgeDevice,
    jobId: string,
    outcome: { ok: true; result?: Record<string, unknown> } | { ok: false; error: string },
  ): Promise<EdgeJob> {
    const [job] = await db
      .select()
      .from(edgeJobs)
      .where(and(eq(edgeJobs.id, jobId), eq(edgeJobs.deviceId, device.id), eq(edgeJobs.status, "running")));
    if (!job) throw httpErr("No such running job on this device.", 404);
    const [updated] = await db
      .update(edgeJobs)
      .set({
        status: outcome.ok ? "succeeded" : "failed",
        result: outcome.ok ? (outcome.result ?? {}) : null,
        error: outcome.ok ? null : outcome.error.slice(0, 2000),
        finishedAt: new Date(),
      })
      .where(eq(edgeJobs.id, jobId))
      .returning();
    await this.touch(device.id);
    return updated!;
  },

  async listJobs(workspaceId: string, deviceId: string, ownerSubject: string, asAdmin: boolean): Promise<EdgeJob[]> {
    const [dev] = await db
      .select()
      .from(edgeDevices)
      .where(and(eq(edgeDevices.id, deviceId), eq(edgeDevices.workspaceId, workspaceId)));
    if (!dev) throw httpErr("No such device.", 404);
    if (!asAdmin && dev.ownerSubject !== ownerSubject) throw httpErr("No such device.", 404);
    return db.select().from(edgeJobs).where(eq(edgeJobs.deviceId, deviceId)).orderBy(desc(edgeJobs.createdAt)).limit(50);
  },

  async pendingApprovals(workspaceId: string, ownerSubject: string): Promise<EdgeJob[]> {
    return db
      .select({ job: edgeJobs })
      .from(edgeJobs)
      .innerJoin(edgeDevices, eq(edgeJobs.deviceId, edgeDevices.id))
      .where(
        and(
          eq(edgeJobs.workspaceId, workspaceId),
          eq(edgeJobs.status, "awaiting_approval"),
          eq(edgeDevices.ownerSubject, ownerSubject),
        ),
      )
      .orderBy(desc(edgeJobs.createdAt))
      .then((rows) => rows.map((r) => r.job));
  },

  async getJob(
    workspaceId: string,
    jobId: string,
    ownerSubject: string,
    asAdmin: boolean,
  ): Promise<EdgeJob & { needsApproval: boolean; deviceName: string | null }> {
    let [row] = await db
      .select({ job: edgeJobs, device: edgeDevices })
      .from(edgeJobs)
      .innerJoin(edgeDevices, eq(edgeJobs.deviceId, edgeDevices.id))
      .where(and(eq(edgeJobs.id, jobId), eq(edgeJobs.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw httpErr("No such job.", 404);
    if (!asAdmin && row.device.ownerSubject !== ownerSubject) throw httpErr("No such job.", 404);
    // Allowlist may have landed after enqueue (or a stuck pre-allowlist whoami): release without a person click.
    if (
      row.job.status === "awaiting_approval" &&
      !edgeJobNeedsApproval(row.job.kind as EdgeJobKind, (row.job.payload ?? {}) as Record<string, unknown>)
    ) {
      const [released] = await db.update(edgeJobs).set({ status: "approved" }).where(eq(edgeJobs.id, row.job.id)).returning();
      if (released) row = { job: released, device: row.device };
    }
    return {
      ...row.job,
      needsApproval: row.job.status === "awaiting_approval",
      deviceName: row.device.name,
    };
  },

  /**
   * Poll a job until terminal or timeout.
   * Keeps waiting through `awaiting_approval` so an in-chat Approve mid-wait can finish in the same poll.
   */
  async waitForJob(
    workspaceId: string,
    jobId: string,
    ownerSubject: string,
    asAdmin: boolean,
    timeoutMs = 60_000,
  ): Promise<EdgeJob & { needsApproval: boolean; deviceName: string | null; timedOut?: boolean }> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1_000), 120_000);
    for (;;) {
      const job = await this.getJob(workspaceId, jobId, ownerSubject, asAdmin);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "revoked") return job;
      if (Date.now() >= deadline) return { ...job, timedOut: true };
      await new Promise((r) => setTimeout(r, 1_500));
    }
  },
};
