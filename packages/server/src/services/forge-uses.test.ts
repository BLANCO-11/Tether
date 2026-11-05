/**
 * A Forge run may call only what its workflow.json declares (forge-uses.ts, plugins phase 9). ⚠ What is pinned: the
 * SERVER holds every step call to the declared uses — a tool, a read (by its saved reader, or by its own datasource AND
 * exact statement), a workspace file — and refuses any other step route; a Kestra flow's callbacks are untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ exec: null as Record<string, unknown> | null }));
vi.mock("../repositories/flow-execution.repo.js", () => ({ flowExecutionRepo: { get: async () => m.exec } }));

import { declaredUses, refuseUndeclaredUse, useRefusal } from "./forge-uses.js";

const workflow = {
  reads: {
    late: { datasource: "orders", sql: "select * from orders where due < $1", params: [{ name: "as_of", type: "date" }] },
    saved: { ref: "orders.open_orders" },
    unused: { ref: "orders.everything" },
  },
  steps: [
    { id: "a", entry: "a.py", uses: ["read:late", "tool:llm_complete"] },
    {
      id: "each",
      loop: "rows",
      steps: [{ id: "b", entry: "b.py", uses: ["read:saved", "file:rates.xlsx"] }],
    },
    { id: "pick", branch: [{ when: "x", steps: [{ id: "c", entry: "c.py", uses: ["tool:github_create_issue"] }] }] },
  ],
} as never;

beforeEach(() => {
  m.exec = null;
});

describe("what a workflow declares", () => {
  it("collects every step's uses at any depth — loops and branch paths included", () => {
    const d = declaredUses(workflow);
    expect([...d.tools].sort()).toEqual(["github_create_issue", "llm_complete"]);
    expect([...d.reads].sort()).toEqual(["late", "saved"]);
    expect([...d.files]).toEqual(["rates.xlsx"]);
  });
});

describe("a step call is held to it", () => {
  it("a declared tool passes; any other tool is refused by name", () => {
    expect(useRefusal(workflow, { kind: "tool", ref: "github_create_issue" })).toBeNull();
    expect(useRefusal(workflow, { kind: "tool", ref: "foundry_email_send" })).toMatch(/does not use the tool "foundry_email_send"/);
  });
  it("a saved reader passes by its ref; one declared but used by no step does not", () => {
    expect(useRefusal(workflow, { kind: "read", ref: "orders.open_orders" })).toBeNull();
    expect(useRefusal(workflow, { kind: "read", ref: "orders.everything" })).not.toBeNull();
  });
  it("⚠ a written read passes only with its own datasource AND its exact statement", () => {
    const sql = "select * from orders where due < $1";
    expect(useRefusal(workflow, { kind: "read", ref: "orders.pi:late", sql, datasourceRef: "orders" })).toBeNull();
    expect(useRefusal(workflow, { kind: "read", ref: "orders.pi:late", sql: "select * from customers", datasourceRef: "orders" })).not.toBeNull();
    expect(useRefusal(workflow, { kind: "read", ref: "orders.pi:late", sql, datasourceRef: "hr" })).not.toBeNull();
    // A saved reader's ref carrying a statement is not that reader.
    expect(useRefusal(workflow, { kind: "read", ref: "orders.open_orders", sql: "select 1" })).not.toBeNull();
  });
  it("a declared file passes; another is refused", () => {
    expect(useRefusal(workflow, { kind: "file", name: "rates.xlsx" })).toBeNull();
    expect(useRefusal(workflow, { kind: "file", name: "salaries.xlsx" })).not.toBeNull();
  });
  it("any other step route is refused", () => {
    expect(useRefusal(workflow, { kind: "other", what: "POST /api/steps/http" })).toMatch(/foundry\.read, foundry\.call and foundry\.file/);
  });
});

describe("only a Forge run is checked, from the job it was started with", () => {
  it("a Kestra execution passes untouched", async () => {
    m.exec = { kestraExecutionId: "abc123", runnerJob: null };
    expect(await refuseUndeclaredUse("e1", { kind: "tool", ref: "anything" })).toBeNull();
  });
  it("a runner execution is held to its stored workflow", async () => {
    m.exec = { kestraExecutionId: "fr-1", runnerJob: { workflow } };
    expect(await refuseUndeclaredUse("e1", { kind: "tool", ref: "llm_complete" })).toBeNull();
    expect(await refuseUndeclaredUse("e1", { kind: "tool", ref: "foundry_email_send" })).not.toBeNull();
  });
  it("⚠ a runner execution with no stored workflow refuses everything", async () => {
    m.exec = { kestraExecutionId: "fr-1", runnerJob: {} };
    expect(await refuseUndeclaredUse("e1", { kind: "tool", ref: "llm_complete" })).toMatch(/no workflow on record/);
  });
});
