/**
 * Device → Foundry → plugin relay: a paired edge device asks Foundry to run a connected-plugin
 * action using the owner's configured connection. Devices never hold connector secrets.
 *
 * Reads run in capture/live read mode immediately. Writes become the same Approve card as Forge Agent.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { edgeDevices, edgeRelayRequests } from "../db/schema.js";
import { changesAllowed, checkValues, performConfirmed } from "../pi-builder/agent-changes.js";
import { accountOptions } from "../pi-builder/connection-choice.js";
import type { PiProposal } from "../pi-builder/types.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { auditService } from "./audit.service.js";
import {
  connectorPieces,
  invokePluginTool,
  isPluginTool,
  parsePluginUrl,
  type PieceActionDescription,
} from "./plugin-connector.service.js";
import { personalTools } from "./personal-actions.js";
import type { EdgeDevice } from "./edge-device.service.js";

export type EdgeRelayPending = {
  id: string;
  proposalId: string | null;
  tool: string;
  summary: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  sessionId: string | null;
  chatId: string | null;
};

const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export type EdgeRelayRow = typeof edgeRelayRequests.$inferSelect;

export type EdgeRelayPublic = {
  id: string;
  status: string;
  tool: string;
  summary: string;
  result: string | null;
  error: string | null;
  proposalId: string | null;
  writes: boolean;
  deviceName: string;
  createdAt: string;
  finishedAt: string | null;
};

type ResolvedTool = {
  tool: Tool;
  action: PieceActionDescription;
  connector: string;
  writes: boolean;
};

async function resolveTool(workspaceId: string, ownerSubject: string, toolName: string): Promise<ResolvedTool> {
  const ws = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => t.isActive !== false && isPluginTool(t));
  const mine = await personalTools(workspaceId, ownerSubject).catch(() => [] as Tool[]);
  const tools = [...ws, ...mine.filter((c) => !ws.some((t) => t.name === c.name))];
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    throw httpErr(
      `There is no connected-service tool named "${toolName}". ${tools.length ? `Use one of: ${tools.map((t) => t.name).join(", ")}.` : "This workspace has none."}`,
      404,
    );
  }
  const ref = parsePluginUrl(tool.url);
  if (!ref) throw httpErr(`"${toolName}" is not a plugin tool.`, 400);
  const piece = (await connectorPieces()).find((p) => p.name === ref.piece);
  const action = piece?.actions.find((a) => a.name === ref.action);
  if (!piece || !action) throw httpErr(`"${toolName}" is not available on the connector service right now.`, 409);
  if (action.destructive) {
    throw httpErr(`"${toolName}" deletes or irreversibly changes data, so it cannot be relayed from a device.`, 403);
  }
  return { tool, action, connector: piece.displayName, writes: !!action.writes };
}

function shortResult(data: unknown): string {
  if (data == null) return "Done.";
  if (typeof data === "string") return data.length > 500 ? `${data.slice(0, 499)}…` : data;
  try {
    const s = JSON.stringify(data);
    return s.length > 500 ? `${s.slice(0, 499)}…` : s;
  } catch {
    return "Done.";
  }
}

/** Callback wired from pi-builder to show an Approve card on a live session (or persist onto a chat). */
let attachCard: ((args: {
  workspaceId: string;
  ownerSubject: string;
  sessionId?: string | null;
  chatId?: string | null;
  proposal: PiProposal;
}) => Promise<{ sessionId: string | null; chatId: string | null }>) | null = null;

export function registerRelayCardAttacher(
  fn: NonNullable<typeof attachCard>,
): void {
  attachCard = fn;
}

export const edgeRelayService = {
  async create(
    device: EdgeDevice,
    body: {
      tool: string;
      params?: Record<string, unknown> | Array<Record<string, unknown>>;
      summary: string;
      sessionId?: string | null;
      chatId?: string | null;
    },
  ): Promise<EdgeRelayPublic & { message: string }> {
    if (device.status !== "active") throw httpErr("This device is not connected.", 403);
    const toolName = body.tool.trim();
    const line = (body.summary ?? "").replace(/\s+/g, " ").trim();
    if (!toolName) throw httpErr("Name the connected-service tool to run.", 400);
    if (line.length < 5) throw httpErr("Say in one line what this does, for the Approve card.", 400);
    const params = body.params ?? {};
    const resolved = await resolveTool(device.workspaceId, device.ownerSubject, toolName);
    const options = await accountOptions(device.workspaceId, parsePluginUrl(resolved.tool.url)!.piece, resolved.tool, device.ownerSubject);
    const use = options.find((o) => o.personal) ?? options[0];
    if (!use) throw httpErr(`No ${resolved.connector} connection is available for this workspace.`, 403);

    if (!resolved.writes) {
      // Read: run now through Foundry (capture/live read). No Approve card.
      const { results } = await invokePluginTool(device.workspaceId, resolved.tool, Array.isArray(params) ? params : [params], undefined, {
        actingSubject: device.ownerSubject,
        secretName: use.secretName,
      });
      const r = results[0];
      const ok = !!r?.ok;
      const text = ok ? shortResult(r!.data) : (r?.error ?? "the service gave no answer");
      const [row] = await db
        .insert(edgeRelayRequests)
        .values({
          workspaceId: device.workspaceId,
          deviceId: device.id,
          ownerSubject: device.ownerSubject,
          tool: toolName,
          params,
          summary: line.slice(0, 300),
          status: ok ? "done" : "failed",
          result: text,
          resultJson: ok && r?.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : null,
          error: ok ? null : text,
          sessionId: body.sessionId ?? null,
          chatId: body.chatId ?? null,
          finishedAt: new Date(),
        })
        .returning();
      await auditService
        .record({
          workspaceId: device.workspaceId,
          actor: device.ownerSubject,
          operation: "access",
          entity: "tool",
          description: `Edge relay read via ${device.name}: ${toolName}`,
          whereText: "Devices",
          whereEntityType: "edge_device",
          whereEntityId: device.id,
          raw: { relayId: row!.id, tool: toolName, ok, via: use.personal ? "personal" : "workspace" },
        })
        .catch(() => undefined);
      return {
        ...publicOf(row!, device.name, false),
        message: ok ? "Read finished through Foundry." : `Read failed: ${text}`,
      };
    }

    const allowed = await changesAllowed(device.workspaceId);
    if (!allowed.ok) throw httpErr(allowed.why, 403);
    await checkValues(device.workspaceId, resolved.tool, params, device.ownerSubject, use.secretName);

    const proposalId = randomUUID();
    const [row] = await db
      .insert(edgeRelayRequests)
      .values({
        workspaceId: device.workspaceId,
        deviceId: device.id,
        ownerSubject: device.ownerSubject,
        tool: toolName,
        params,
        summary: line.slice(0, 300),
        status: "awaiting_approval",
        proposalId,
        sessionId: body.sessionId ?? null,
        chatId: body.chatId ?? null,
      })
      .returning();

    const proposal: PiProposal = {
      id: proposalId,
      kind: "action",
      tool: resolved.tool.name,
      connector: resolved.connector,
      action: resolved.action.displayName,
      summary: line.slice(0, 300),
      params,
      status: "pending",
      at: new Date().toISOString(),
      via: use.personal ? "personal" : "workspace",
      account: {
        connectionId: use.connectionId,
        label: use.label,
        personal: use.personal,
        identity: use.identity ?? null,
      },
      relay: { requestId: row!.id, deviceId: device.id, deviceName: device.name },
    };

    let sessionId = body.sessionId ?? null;
    let chatId = body.chatId ?? null;
    if (attachCard) {
      const attached = await attachCard({
        workspaceId: device.workspaceId,
        ownerSubject: device.ownerSubject,
        sessionId,
        chatId,
        proposal,
      });
      sessionId = attached.sessionId;
      chatId = attached.chatId;
      if (sessionId || chatId) {
        await db
          .update(edgeRelayRequests)
          .set({ sessionId, chatId })
          .where(eq(edgeRelayRequests.id, row!.id));
      }
    }

    await auditService
      .record({
        workspaceId: device.workspaceId,
        actor: device.ownerSubject,
        operation: "create",
        entity: "tool",
        description: `Edge relay proposed via ${device.name}: ${line.slice(0, 120)}`,
        whereText: "Devices",
        whereEntityType: "edge_device",
        whereEntityId: device.id,
        raw: { relayId: row!.id, tool: toolName, proposalId, via: use.personal ? "personal" : "workspace" },
      })
      .catch(() => undefined);

    return {
      ...publicOf({ ...row!, sessionId, chatId }, device.name, true),
      message: sessionId || chatId
        ? "Proposed on a Foundry Approve card. Poll this relay id until done or declined."
        : "Proposed. Open a Forge chat in this workspace to Approve (Needs your approval). Poll this relay id.",
    };
  },

  async get(device: EdgeDevice, id: string): Promise<EdgeRelayPublic> {
    const [row] = await db
      .select()
      .from(edgeRelayRequests)
      .where(and(eq(edgeRelayRequests.id, id), eq(edgeRelayRequests.deviceId, device.id)))
      .limit(1);
    if (!row) throw httpErr("No such relay request for this device.", 404);
    const resolved = await resolveTool(device.workspaceId, device.ownerSubject, row.tool).catch(() => null);
    return publicOf(row, device.name, resolved?.writes ?? true);
  },

  /** Owner read (Needs you), not device Bearer. */
  async getForOwner(workspaceId: string, ownerSubject: string, id: string): Promise<EdgeRelayPublic> {
    const [row] = await db
      .select()
      .from(edgeRelayRequests)
      .where(
        and(
          eq(edgeRelayRequests.id, id),
          eq(edgeRelayRequests.workspaceId, workspaceId),
          eq(edgeRelayRequests.ownerSubject, ownerSubject),
        ),
      )
      .limit(1);
    if (!row) throw httpErr("No such plugin relay request.", 404);
    const [dev] = await db.select().from(edgeDevices).where(eq(edgeDevices.id, row.deviceId)).limit(1);
    const resolved = await resolveTool(workspaceId, ownerSubject, row.tool).catch(() => null);
    return publicOf(row, dev?.name ?? "device", resolved?.writes ?? true);
  },

  /** After the person Approves or declines the linked card. */
  async settleFromProposal(
    proposal: PiProposal,
    outcome: { status: "done" | "partial" | "failed" | "declined"; result?: string | null; results?: PiProposal["results"] },
  ): Promise<void> {
    const requestId = proposal.relay?.requestId;
    if (!requestId) return;
    const [row] = await db.select().from(edgeRelayRequests).where(eq(edgeRelayRequests.id, requestId)).limit(1);
    if (!row || row.status !== "awaiting_approval") return;
    const status = outcome.status === "declined" ? "declined" : outcome.status === "failed" ? "failed" : "done";
    await db
      .update(edgeRelayRequests)
      .set({
        status,
        result: outcome.result ?? (status === "declined" ? "Declined." : null),
        resultJson: outcome.results ? { results: outcome.results } : null,
        error: status === "failed" || status === "declined" ? outcome.result ?? status : null,
        finishedAt: new Date(),
      })
      .where(eq(edgeRelayRequests.id, requestId));
  },

  /** Needs you / Devices: awaiting_approval relays for this owner. */
  async listPending(workspaceId: string, ownerSubject: string): Promise<EdgeRelayPending[]> {
    const rows = await db
      .select()
      .from(edgeRelayRequests)
      .where(
        and(
          eq(edgeRelayRequests.workspaceId, workspaceId),
          eq(edgeRelayRequests.ownerSubject, ownerSubject),
          eq(edgeRelayRequests.status, "awaiting_approval"),
        ),
      )
      .orderBy(desc(edgeRelayRequests.createdAt));
    if (rows.length === 0) return [];
    const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
    const devices = await db.select().from(edgeDevices).where(inArray(edgeDevices.id, deviceIds));
    const nameOf = new Map(devices.map((d) => [d.id, d.name]));
    return rows.map((r) => ({
      id: r.id,
      proposalId: r.proposalId,
      tool: r.tool,
      summary: r.summary,
      deviceId: r.deviceId,
      deviceName: nameOf.get(r.deviceId) ?? "device",
      createdAt: r.createdAt.toISOString(),
      sessionId: r.sessionId,
      chatId: r.chatId,
    }));
  },

  /**
   * Approve/decline from Needs you when there is no live chat session holding the card.
   * Prefer `decideProposal` when a session still has the proposal.
   */
  async decideStandalone(
    workspaceId: string,
    relayId: string,
    person: { subject: string; label: string },
    decision: "run" | "decline",
  ): Promise<EdgeRelayPublic> {
    const [row] = await db
      .select()
      .from(edgeRelayRequests)
      .where(and(eq(edgeRelayRequests.id, relayId), eq(edgeRelayRequests.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw httpErr("No such plugin relay request.", 404);
    if (row.ownerSubject !== person.subject) throw httpErr("Only the device owner can Approve this relay.", 403);
    if (row.status !== "awaiting_approval") throw httpErr(`This relay was already ${row.status}.`, 409);

    const [dev] = await db.select().from(edgeDevices).where(eq(edgeDevices.id, row.deviceId)).limit(1);
    const deviceName = dev?.name ?? "device";
    const resolved = await resolveTool(workspaceId, person.subject, row.tool);
    const options = await accountOptions(workspaceId, parsePluginUrl(resolved.tool.url)!.piece, resolved.tool, person.subject);
    const use = options.find((o) => o.personal) ?? options[0];
    if (!use) throw httpErr(`No ${resolved.connector} connection is available.`, 403);

    const proposal: PiProposal = {
      id: row.proposalId ?? randomUUID(),
      kind: "action",
      tool: resolved.tool.name,
      connector: resolved.connector,
      action: resolved.action.displayName,
      summary: row.summary,
      params: row.params,
      status: "pending",
      at: row.createdAt.toISOString(),
      via: use.personal ? "personal" : "workspace",
      account: {
        connectionId: use.connectionId,
        label: use.label,
        personal: use.personal,
        identity: use.identity ?? null,
      },
      relay: { requestId: row.id, deviceId: row.deviceId, deviceName },
    };

    if (decision === "decline") {
      await this.settleFromProposal(proposal, { status: "declined", result: "Declined." });
      await auditService
        .record({
          workspaceId,
          actor: person.subject,
          operation: "update",
          entity: "tool",
          description: `Edge relay declined (Needs you) via ${deviceName}: ${row.summary.slice(0, 120)}`,
          whereText: "Needs you",
          whereEntityType: "edge_relay",
          whereEntityId: row.id,
          raw: { relayId: row.id, tool: row.tool, decision: "decline" },
        })
        .catch(() => undefined);
      const [after] = await db.select().from(edgeRelayRequests).where(eq(edgeRelayRequests.id, row.id)).limit(1);
      return publicOf(after!, deviceName, true);
    }

    const out = await performConfirmed(
      workspaceId,
      proposal,
      person,
      { chatId: row.chatId },
      [],
      { secretName: use.secretName, personal: use.personal, label: use.label },
    );
    await this.settleFromProposal(proposal, {
      status: out.status === "partial" ? "partial" : out.status === "failed" ? "failed" : "done",
      result: out.result,
      results: out.results,
    });
    await auditService
      .record({
        workspaceId,
        actor: person.subject,
        operation: "update",
        entity: "tool",
        description: `Edge relay ${out.status} (Needs you) via ${deviceName}: ${row.summary.slice(0, 120)}`,
        whereText: "Needs you",
        whereEntityType: "edge_relay",
        whereEntityId: row.id,
        raw: { relayId: row.id, tool: row.tool, decision: "run", via: use.personal ? "personal" : "workspace", status: out.status },
      })
      .catch(() => undefined);
    const [after] = await db.select().from(edgeRelayRequests).where(eq(edgeRelayRequests.id, row.id)).limit(1);
    return publicOf(after!, deviceName, true);
  },
};

function publicOf(row: EdgeRelayRow, deviceName: string, writes: boolean): EdgeRelayPublic {
  return {
    id: row.id,
    status: row.status,
    tool: row.tool,
    summary: row.summary,
    result: row.result,
    error: row.error,
    proposalId: row.proposalId,
    writes,
    deviceName,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}
