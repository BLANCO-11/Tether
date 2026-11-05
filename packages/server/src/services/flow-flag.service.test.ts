import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flowFlagService } from "./flow-flag.service.js";
import type { FlowStepFlag } from "./flow-flag.service.js";

function flag(overrides: Partial<FlowStepFlag> & { stepNumber?: number | null; blocking: boolean; status: FlowStepFlag["status"] }): FlowStepFlag {
  const hasStep = Object.prototype.hasOwnProperty.call(overrides, "stepNumber");
  const stepNumber = hasStep ? (overrides as { stepNumber?: number | null }).stepNumber : 1;
  const { stepNumber: _omit, ...rest } = overrides as Record<string, unknown>;
  return {
    id: "00000000-0000-0000-0000-000000000000",
    flowRevisionId: "11111111-1111-1111-1111-111111111111",
    stepNumber: stepNumber as number | null,
    kind: "missing-input",
    title: "t",
    consequence: "Up to 27 emails",
    options: null,
    createdAt: new Date(),
    ...(rest as Record<string, unknown>),
  } as unknown as FlowStepFlag;
}

describe("flowFlagService.canTest / canPublish (B-12 AC-05-13)", () => {
  it("canTest ignores draft-level (step_number null) blocker", () => {
    const flags: FlowStepFlag[] = [
      flag({ stepNumber: null, blocking: true, status: "open", title: "No successful test run" }),
      flag({ stepNumber: 7, blocking: false, status: "open" }),
    ];
    expect(flowFlagService.canTest(flags)).toBe(true);
    // canPublish must see the draft-level blocker
    expect(flowFlagService.canPublish(flags)).toBe(false);
  });

  it("canTest is false when a step-level blocker is open", () => {
    const flags: FlowStepFlag[] = [
      flag({ stepNumber: 7, blocking: true, status: "open" }),
      flag({ stepNumber: null, blocking: true, status: "open" }),
    ];
    expect(flowFlagService.canTest(flags)).toBe(false);
    expect(flowFlagService.canPublish(flags)).toBe(false);
  });

  it("canPublish requires zero open blockers (including draft-level)", () => {
    const flags: FlowStepFlag[] = [
      flag({ stepNumber: 7, blocking: true, status: "resolved" }),
      flag({ stepNumber: null, blocking: true, status: "resolved" }),
      flag({ stepNumber: 4, blocking: false, status: "open" }),
    ];
    expect(flowFlagService.canTest(flags)).toBe(true);
    expect(flowFlagService.canPublish(flags)).toBe(true);
  });

  it("deferred still counts as not-open for both gates", () => {
    const flags: FlowStepFlag[] = [flag({ stepNumber: 7, blocking: true, status: "deferred" })];
    expect(flowFlagService.canTest(flags)).toBe(true);
    expect(flowFlagService.canPublish(flags)).toBe(true);
  });
});

describe("flowFlagService validation (consequence required)", () => {
  it("assertKind rejects unknown kind", () => {
    expect(() => flowFlagService.assertKind(" invent ")).toThrow();
    expect(() => flowFlagService.assertKind("restricted")).not.toThrow();
    expect(() => flowFlagService.assertKind("unresolved-decision")).not.toThrow();
  });
});

describe("migration 0043_flow_step_flags (B-12)", () => {
  it("sql file exists and enforces consequence NOT NULL + kind + status checks", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const sql = await readFile(path.join(dir, "0043_flow_step_flags.sql"), "utf8");
    expect(sql).toContain("flow_step_flags");
    expect(sql).toContain("consequence");
    expect(sql).toContain("NOT NULL");
    expect(sql).toContain("restricted");
    expect(sql).toContain("low-confidence");
    expect(sql).toContain("assumption");
    expect(sql).toContain("blocking");
    expect(sql).toContain("boolean NOT NULL");
    expect(sql).toContain("step_number");
    expect(sql).toContain("flow_revision_id");
  });

  it("journal contains idx43 for 0043_flow_step_flags", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const txt = await readFile(path.join(dir, "meta/_journal.json"), "utf8");
    const j = JSON.parse(txt) as { entries: Array<{ idx: number; tag: string }> };
    const e = j.entries.find((x) => x.tag === "0043_flow_step_flags");
    expect(e).toBeDefined();
    expect(e?.idx).toBe(43);
  });
});
