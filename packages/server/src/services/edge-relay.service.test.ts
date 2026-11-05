/**
 * Edge plugin relay: device Bearer only; wrong device cannot read; writes need Approve settle.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const insertReturning = vi.fn();
const selectLimit = vi.fn();
const updateWhere = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    insert: () => ({ values: () => ({ returning: insertReturning }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
    update: () => ({ set: () => ({ where: updateWhere }) }),
  },
}));

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: {
    listByWorkspace: vi.fn(async () => [
      {
        id: "t1",
        name: "slack_send",
        url: "plugin://@activepieces/piece-slack@0.1.0/send_message",
        isActive: true,
        secretEnvName: "SECRET_SLACK",
        description: "Send",
        paramsSchema: {},
        workspaceId: "ws",
        method: "POST",
      },
      {
        id: "t2",
        name: "slack_list",
        url: "plugin://@activepieces/piece-slack@0.1.0/list_channels",
        isActive: true,
        secretEnvName: "SECRET_SLACK",
        description: "List",
        paramsSchema: {},
        workspaceId: "ws",
        method: "POST",
      },
    ]),
  },
}));

vi.mock("./personal-actions.js", () => ({
  personalTools: vi.fn(async () => []),
}));

vi.mock("./plugin-connector.service.js", () => ({
  isPluginTool: () => true,
  parsePluginUrl: (url: string) => {
    if (url.includes("/send_message")) return { piece: "@activepieces/piece-slack", action: "send_message", version: "0.1.0" };
    if (url.includes("/list_channels")) return { piece: "@activepieces/piece-slack", action: "list_channels", version: "0.1.0" };
    return null;
  },
  connectorPieces: vi.fn(async () => [
    {
      name: "@activepieces/piece-slack",
      displayName: "Slack",
      version: "0.1.0",
      actions: [
        { name: "send_message", displayName: "Send message", writes: true, destructive: false, unsupported: [], params: {} },
        { name: "list_channels", displayName: "List channels", writes: false, destructive: false, unsupported: [], params: {} },
      ],
    },
  ]),
  invokePluginTool: vi.fn(async () => ({
    results: [{ ok: true, data: { channels: ["#general"] }, status: 200 }],
  })),
}));

vi.mock("../pi-builder/agent-changes.js", () => ({
  changesAllowed: vi.fn(async () => ({ ok: true })),
  checkValues: vi.fn(async () => undefined),
  performConfirmed: vi.fn(async () => ({ status: "done", result: "sent" })),
}));

vi.mock("../pi-builder/connection-choice.js", () => ({
  accountOptions: vi.fn(async () => [
    { connectionId: "c1", label: "Workspace Slack", personal: false, identity: null, secretName: "SECRET_SLACK" },
  ]),
}));

vi.mock("./audit.service.js", () => ({
  auditService: { record: vi.fn(async () => undefined) },
}));

const { edgeRelayService, registerRelayCardAttacher } = await import("./edge-relay.service.js");
const { invokePluginTool } = await import("./plugin-connector.service.js");

const device = {
  id: "dev-1",
  workspaceId: "ws-1",
  ownerSubject: "local-admin",
  name: "Mac",
  status: "active",
} as never;

describe("edgeRelayService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerRelayCardAttacher(async () => ({ sessionId: "sess-1", chatId: "chat-1" }));
    insertReturning.mockResolvedValue([
      {
        id: "relay-1",
        workspaceId: "ws-1",
        deviceId: "dev-1",
        ownerSubject: "local-admin",
        tool: "slack_send",
        params: {},
        summary: "Post a hello",
        status: "awaiting_approval",
        proposalId: "prop-1",
        sessionId: "sess-1",
        chatId: "chat-1",
        result: null,
        resultJson: null,
        error: null,
        createdAt: new Date("2026-01-01"),
        finishedAt: null,
      },
    ]);
    selectLimit.mockResolvedValue([
      {
        id: "relay-1",
        deviceId: "dev-1",
        tool: "slack_send",
        summary: "Post a hello",
        status: "awaiting_approval",
        proposalId: "prop-1",
        result: null,
        error: null,
        createdAt: new Date("2026-01-01"),
        finishedAt: null,
      },
    ]);
    updateWhere.mockResolvedValue(undefined);
  });

  it("runs a read immediately without an Approve card", async () => {
    insertReturning.mockResolvedValueOnce([
      {
        id: "relay-r",
        workspaceId: "ws-1",
        deviceId: "dev-1",
        ownerSubject: "local-admin",
        tool: "slack_list",
        params: {},
        summary: "List channels now",
        status: "done",
        proposalId: null,
        sessionId: null,
        chatId: null,
        result: '{"channels":["#general"]}',
        resultJson: { channels: ["#general"] },
        error: null,
        createdAt: new Date(),
        finishedAt: new Date(),
      },
    ]);
    const out = await edgeRelayService.create(device, { tool: "slack_list", summary: "List channels now", params: {} });
    expect(out.status).toBe("done");
    expect(out.writes).toBe(false);
    expect(invokePluginTool).toHaveBeenCalled();
  });

  it("queues a write as awaiting_approval and attaches a card", async () => {
    const out = await edgeRelayService.create(device, {
      tool: "slack_send",
      summary: "Post a hello in #general",
      params: { text: "hi" },
    });
    expect(out.status).toBe("awaiting_approval");
    expect(out.writes).toBe(true);
    expect(out.message).toMatch(/Approve/i);
  });

  it("get refuses another device's relay id", async () => {
    selectLimit.mockResolvedValueOnce([]);
    const other = {
      id: "dev-other",
      workspaceId: "ws-1",
      ownerSubject: "local-admin",
      name: "Other",
      status: "active",
    } as never;
    await expect(edgeRelayService.get(other, "relay-1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("settleFromProposal marks declined", async () => {
    selectLimit.mockResolvedValueOnce([
      {
        id: "relay-1",
        status: "awaiting_approval",
      },
    ]);
    await edgeRelayService.settleFromProposal(
      {
        id: "prop-1",
        tool: "slack_send",
        connector: "Slack",
        action: "Send",
        summary: "x",
        params: {},
        status: "declined",
        at: "",
        relay: { requestId: "relay-1", deviceId: "dev-1", deviceName: "Mac" },
      },
      { status: "declined", result: "Declined." },
    );
    expect(updateWhere).toHaveBeenCalled();
  });

  it("decideStandalone refuses another owner", async () => {
    selectLimit.mockResolvedValueOnce([
      {
        id: "relay-1",
        workspaceId: "ws-1",
        ownerSubject: "local-admin",
        status: "awaiting_approval",
        deviceId: "dev-1",
        tool: "slack_send",
        summary: "Post a hello",
        params: {},
        proposalId: "prop-1",
        chatId: null,
        createdAt: new Date(),
      },
    ]);
    await expect(
      edgeRelayService.decideStandalone("ws-1", "relay-1", { subject: "other", label: "other" }, "decline"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
