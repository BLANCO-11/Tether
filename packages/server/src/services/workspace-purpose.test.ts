/**
 * The workspace purpose and assistant mode (2026-10-12): a person creating a workspace must say what it is for, and
 * Forge is told the purpose and the mode on every turn.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceSchema, updateWorkspaceSchema } from "./workspace.service.js";
import { workspaceLines } from "../pi-builder/service.js";

describe("creating a workspace", () => {
  it("needs a purpose of a sentence; the assistant is off unless chosen", () => {
    expect(createWorkspaceSchema.safeParse({ name: "HR" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "HR", description: "  people  " }).success).toBe(false);
    const ok = createWorkspaceSchema.parse({ name: "HR", description: "  Attendance, leave and payroll checks for HR.  " });
    expect(ok.description).toBe("Attendance, leave and payroll checks for HR.");
    expect(ok.assistant).toBeUndefined();
    expect(createWorkspaceSchema.parse({ name: "HR", description: "Attendance and leave for HR.", assistant: true }).assistant).toBe(true);
  });

  it("an update may change either, but cannot empty the purpose", () => {
    expect(updateWorkspaceSchema.safeParse({ assistant: true }).success).toBe(true);
    expect(updateWorkspaceSchema.safeParse({ description: "" }).success).toBe(false);
  });
});

describe("what Forge is told each turn", () => {
  it("states the purpose and whether Forge may read the real data", () => {
    const on = workspaceLines({ purpose: "Attendance and leave for HR.", assistant: true }).join("\n");
    expect(on).toContain("Workspace purpose: Attendance and leave for HR.");
    expect(on).toContain("Real data: you may read it");
    expect(on).toContain("tools/ask-data.mjs");
    const off = workspaceLines({ purpose: null, assistant: false }).join("\n");
    expect(off).toContain("not stated");
    expect(off).toContain("Real data: this workspace does not let you read it");
  });

  it("lists the workspace's Files by name, says none when there are none, and says nothing when they could not be read", () => {
    const some = workspaceLines({ purpose: null, assistant: false, files: ["HC Report.xlsx", "Muster, Oct.xlsx"] }).join("\n");
    expect(some).toContain('"HC Report.xlsx", "Muster, Oct.xlsx"');
    expect(some).toContain("never ask for one of these to be uploaded");
    expect(workspaceLines({ purpose: null, assistant: false, files: [] }).join("\n")).toContain("Workspace Files (Resources → Files): none.");
    expect(workspaceLines({ purpose: null, assistant: false }).join("\n")).not.toContain("Workspace Files");
    const many = workspaceLines({ purpose: null, assistant: false, files: Array.from({ length: 65 }, (_, i) => `f${i}.csv`) }).join("\n");
    expect(many).toContain("and 5 more in catalogue.json");
    expect(many).not.toContain('"f60.csv"');
  });

  it("⚠ a chat in a project is told the project and its shared instructions, and unread Files still says nothing (sharing-boundaries phase 5)", () => {
    const ws = { purpose: "HR.", assistant: false, project: { name: "Payroll close", instructions: "Always cite the pay period." } };
    const lines = workspaceLines(ws);
    expect(lines.join("\n")).toContain("This chat is in the project “Payroll close”");
    expect(lines.join("\n")).toContain("Always cite the pay period.");
    // Files unread: the line is left out wherever it sits, and the project's lines stay.
    expect(lines.join("\n")).not.toContain("Workspace Files");
    expect(lines.some((l) => l.includes("\u0000"))).toBe(false);
    expect(lines.join("\n")).toContain("Real data:");
    // CONTROL: no project, no project line; an empty instruction adds no instructions line.
    expect(workspaceLines({ purpose: null, assistant: false }).join("\n")).not.toContain("project");
    expect(workspaceLines({ purpose: null, assistant: false, project: { name: "P", instructions: "  " } }).join("\n")).not.toContain("shared instructions");
  });
});
