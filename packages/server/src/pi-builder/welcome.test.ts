import { describe, expect, it } from "vitest";
import { firstNameOf, GREETING_LINES, newWelcome, savedWelcome } from "./welcome.js";

const first = () => 0;
const cat = {
  entries: [
    { ref: "Attendance_DB.employee_hours", kind: "operation" },
    { ref: "foundry_email_send", kind: "tool" },
    { ref: "ticket_create", kind: "tool" },
  ],
  datasources: [{ name: "Attendance_DB", tables: [{ name: "attendance_day" }, { name: "employee" }, { name: "leave_applied" }, { name: "report_parameters" }] }],
};

describe("the builder's welcome", () => {
  it("is two short lines: the person and the workspace, then an invitation", () => {
    const t = newWelcome("Himanshu", "HR", cat, first);
    expect(t).toBe("Hi Himanshu. What should we automate in HR?\n\nDescribe it in your own words.");
  });

  it("draws from a large set: many different greetings, none repeated in the lists, none needing a name it lacks", () => {
    const all = [...GREETING_LINES.NEW_OPENERS, ...GREETING_LINES.NEW_FOLLOW_UPS, ...GREETING_LINES.SAVED_OPENERS, ...GREETING_LINES.SAVED_FOLLOW_UPS];
    expect(new Set(all).size).toBe(all.length);
    expect(GREETING_LINES.NEW_OPENERS.length).toBeGreaterThanOrEqual(20);
    expect(GREETING_LINES.NEW_FOLLOW_UPS.length).toBeGreaterThanOrEqual(12);
    const seen = new Set<string>();
    let x = 0.1234;
    const rand = () => (x = (x * 9301 + 0.49297) % 1); // a fresh number on every draw, like Math.random
    for (let i = 0; i < 400; i++) {
      seen.add(newWelcome("Ana", "HR", cat, rand));
      const anon = newWelcome(null, "HR", cat, rand);
      expect(anon).not.toMatch(/\{|\}| \.|, \./);
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  it("does not recite the workspace's databases, tables or tools", () => {
    const t = newWelcome("Himanshu", "HR", cat, () => 0.99);
    expect(t).not.toMatch(/Attendance_DB|employee|tools?\b/);
    expect(t.split("\n\n")).toHaveLength(2);
  });

  it("is not one fixed string: a different draw reads differently", () => {
    expect(newWelcome("Himanshu", "HR", cat, () => 0)).not.toBe(newWelcome("Himanshu", "HR", cat, () => 0.99));
  });

  it("an empty workspace says nothing is connected, rather than inviting a build it cannot do", () => {
    expect(newWelcome(null, "Empty", { entries: [], datasources: [] }, first)).toMatch(/Nothing is connected here yet/);
  });

  it("a reopened flow is welcomed back by name, briefly", () => {
    const t = savedWelcome("Himanshu", { name: "Monthly hours", workflow: { steps: [{ id: "a", uses: [] }] } }, first);
    expect(t).toBe("Welcome back, Himanshu. “Monthly hours” is just as you left it.\n\nWhat should change?");
  });

  it("sounds like a person: no em or en dash in any greeting, however it is drawn", () => {
    const flow = { name: "F", workflow: { inputs: { m: {} }, reads: { r: { datasource: "D" } }, steps: [{ id: "a", uses: ["tool:t"] }] } };
    for (const r of Array.from({ length: 50 }, (_, i) => i / 50)) {
      for (const t of [newWelcome("A", "W", cat, () => r), newWelcome(null, null, { entries: [], datasources: [] }, () => r), savedWelcome("A", flow, () => r)]) {
        expect(t).not.toMatch(/[—–]/);
      }
    }
  });

  it("a first name comes from the display name, else the address, else nothing", () => {
    expect(firstNameOf({ name: "himanshu saini" })).toBe("Himanshu");
    expect(firstNameOf({ email: "mayank.lohani@microland.com" })).toBe("Mayank");
    expect(firstNameOf({ email: "x1@acme.example" })).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});
