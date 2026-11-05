/**
 * Which connection a chat call uses (connection-choice.ts, plugins 8.5). ⚠ The person decides: one connection is used
 * and named, several are asked about unless the chat has a choice that is still one of them, none is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const GH = "@activepieces/piece-github";
type Conn = { id: string; workspaceId: string; piece: string; label: string; secretName: string; ownerSubject: string | null; lastTestOk: boolean | null; lastTestMessage: string | null };
const m = vi.hoisted(() => ({ conns: [] as Conn[] }));
vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    connectionBySecret: async (ws: string, name: string) => m.conns.find((c) => c.workspaceId === ws && c.secretName === name),
    listConnections: async (ws: string, piece: string, viewer?: string | null) =>
      m.conns.filter((c) => c.workspaceId === ws && c.piece === piece && (!c.ownerSubject || c.ownerSubject === viewer)),
  },
}));

import { resolveAccount } from "./connection-choice.js";

const team: Conn = { id: "c-team", workspaceId: "w", piece: GH, label: "Team GitHub", secretName: "PLUGIN_GITHUB_TEAM", ownerSubject: null, lastTestOk: true, lastTestMessage: "Connected as BLANCO-11" };
const alice: Conn = { id: "c-alice", workspaceId: "w", piece: GH, label: "Mine", secretName: "PLUGIN_GITHUB_ME_a", ownerSubject: "alice", lastTestOk: null, lastTestMessage: null };
const bob: Conn = { id: "c-bob", workspaceId: "w", piece: GH, label: "Bob's", secretName: "PLUGIN_GITHUB_ME_b", ownerSubject: "bob", lastTestOk: true, lastTestMessage: "Connected as bob" };
const workspaceTool = { secretEnvName: team.secretName };
const resolve = (subject: string | null, choices = {}, tool = workspaceTool) => resolveAccount("w", GH, "GitHub", tool, subject, choices);

beforeEach(() => {
  m.conns = [team, alice, bob];
});

describe("which connection a chat call uses", () => {
  it("⚠ the workspace's and the person's own are both possible ⇒ ASK, listing exactly those two (never another person's)", async () => {
    const r = await resolve("alice");
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") return;
    expect(r.question.options.map((o) => o.connectionId)).toEqual(["c-team", "c-alice"]);
    expect(r.question.options[0]).toMatchObject({ personal: false, identity: "Connected as BLANCO-11" });
    expect(r.question.options[1]).toMatchObject({ personal: true, identity: null });
    expect(JSON.stringify(r.question)).not.toMatch(/PLUGIN_/); // the card never carries a credential's name
  });
  it("only one possible ⇒ it is used without asking", async () => {
    expect(await resolve("carol")).toMatchObject({ kind: "use", account: { connectionId: "c-team" } });
    m.conns = [alice];
    expect(await resolve("alice")).toMatchObject({ kind: "use", account: { connectionId: "c-alice", personal: true } });
  });
  it("the chat's choice is used while it is still possible; a stale one asks again", async () => {
    const chose = (id: string) => ({ [GH]: { connectionId: id, label: "", personal: true, identity: null, service: "GitHub", chosenBy: "alice", at: "" } });
    expect(await resolve("alice", chose("c-alice"))).toMatchObject({ kind: "use", account: { connectionId: "c-alice" } });
    expect(await resolve("alice", chose("c-bob"))).toMatchObject({ kind: "ask" }); // not alice's to use
    m.conns = [team, bob];
    expect(await resolve("alice", chose("c-alice"))).toMatchObject({ kind: "use", account: { connectionId: "c-team" } }); // deleted ⇒ the only one left
  });
  it("an action allowed in the chat through the person's OWN connection never offers the workspace's", async () => {
    expect(await resolve("alice", {}, { secretEnvName: alice.secretName })).toMatchObject({ kind: "use", account: { connectionId: "c-alice" } });
  });
  it("none usable ⇒ refused, saying how to connect", async () => {
    m.conns = [bob];
    const r = await resolve("alice", {}, { secretEnvName: bob.secretName });
    expect(r).toMatchObject({ kind: "none", why: expect.stringMatching(/Connect it as yourself/) });
  });

  it("⚠ building a workflow in My space offers only the person's own — never the workspace's (sharing-boundaries Q3)", async () => {
    const mySpace = (subject: string) => resolveAccount("w", GH, "GitHub", workspaceTool, subject, {}, { ownOnly: true });
    expect(await mySpace("alice")).toMatchObject({ kind: "use", account: { connectionId: "c-alice", personal: true } });
    const none = await mySpace("carol");
    expect(none).toMatchObject({ kind: "none", why: expect.stringMatching(/in My space, so it uses your own GitHub account/) });
    // CONTROL: elsewhere both are offered.
    expect((await resolve("alice")).kind).toBe("ask");
  });
});
