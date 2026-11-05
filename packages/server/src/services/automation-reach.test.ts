/**
 * What an automation touches (automation-reach.ts, plugins phase 9). ⚠ What is pinned: only the owner's OWN connection,
 * the AI summary tool and steps that only compute are the owner's; a workspace datasource, a workspace file, the org
 * mailbox, the workspace's connection, another person's connection, any other tool and anything missing are the
 * workspace's — and an automation with no owner is never its owner's to switch on.
 */
import { describe, expect, it } from "vitest";
import { classifyReach, type ReachFacts } from "./automation-reach.js";

const GH = "@activepieces/piece-github";
const facts: ReachFacts = {
  tools: new Map<string, { url: string | null }>([
    ["llm_complete", { url: "http://ops-api:4004/llm/complete" }],
    ["foundry_email_send", { url: "http://server:4000/api/mail/send" }],
    ["github_create_issue", { url: `plugin://${GH}@0.11.0/create_issue` }],
    ["crm_lookup", { url: "https://crm.example/api" }],
  ]),
  connections: new Map([
    ["c-alice", { piece: GH, ownerSubject: "alice" }],
    ["c-bob", { piece: GH, ownerSubject: "bob" }],
    ["c-team", { piece: GH, ownerSubject: null }],
  ]),
};
const step = (...uses: string[]) => ({ steps: [{ id: "s", entry: "s.py", uses }] }) as never;
const mine = { [GH]: { connectionId: "c-alice", label: "Mine", personal: true, service: "GitHub" } };

describe("the owner's own things", () => {
  it("steps that only compute, and the AI summary tool, are the owner's", () => {
    expect(classifyReach({ workflow: step() }, facts, "alice")).toMatchObject({ ownOnly: true, workspace: [] });
    expect(classifyReach({ workflow: step("tool:llm_complete") }, facts, "alice")).toMatchObject({ ownOnly: true, own: ["the AI summary tool"] });
  });
  it("a service called through the owner's OWN connection is the owner's", () => {
    const r = classifyReach({ workflow: step("tool:github_create_issue"), accounts: mine }, facts, "alice");
    expect(r.ownOnly).toBe(true);
    expect(r.own).toEqual(["your own github connection “Mine”"]);
  });
});

describe("⚠ anything of the workspace's needs a reviewer", () => {
  const cases: Array<[string, Parameters<typeof classifyReach>[0], RegExp]> = [
    ["a read of the workspace's data", { workflow: step("read:late") }, /reads the workspace's data/],
    ["a file in the shared Files library", { workflow: step("file:rates.xlsx") }, /from the workspace's Files/],
    ["the org mailbox", { workflow: step("tool:foundry_email_send") }, /workspace's mailbox/],
    ["a service with no connection chosen (the workspace's)", { workflow: step("tool:github_create_issue") }, /through the workspace's connection/],
    [
      "a service through the workspace's connection",
      { workflow: step("tool:github_create_issue"), accounts: { [GH]: { connectionId: "c-team", label: "Team", personal: false, service: "GitHub" } } },
      /through the workspace's connection/,
    ],
    ["any other tool (it carries the workspace's credentials)", { workflow: step("tool:crm_lookup") }, /workspace's credentials/],
    ["a tool this workspace does not have", { workflow: step("tool:gone") }, /does not have/],
  ];
  for (const [what, model, says] of cases) {
    it(what, () => {
      const r = classifyReach(model, facts, "alice");
      expect(r.ownOnly).toBe(false);
      expect(r.workspace.join("; ")).toMatch(says);
    });
  }
  it("another person's own connection is not this owner's", () => {
    const bobs = { [GH]: { connectionId: "c-bob", label: "Bob's", personal: true, service: "GitHub" } };
    expect(classifyReach({ workflow: step("tool:github_create_issue"), accounts: bobs }, facts, "alice").ownOnly).toBe(false);
  });
  it("one workspace thing among own things is enough", () => {
    const r = classifyReach({ workflow: step("tool:llm_complete", "tool:github_create_issue", "read:late"), accounts: mine }, facts, "alice");
    expect(r.ownOnly).toBe(false);
    expect(r.workspace).toHaveLength(1);
  });
  it("an automation with no owner is nobody's to switch on", () => {
    expect(classifyReach({ workflow: step() }, facts, null)).toMatchObject({ ownOnly: false, workspace: ["has no owner"] });
  });
});
