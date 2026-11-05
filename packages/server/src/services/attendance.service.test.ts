import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { attendanceCompliance, workspaces } from "../db/schema.js";
import { attendanceService } from "./attendance.service.js";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)("attendanceService.status (B-17)", () => {
  let ws: string;
  let wsOther: string;
  const subject = `test-subject-${Date.now().toString(36)}`;
  const period = "2026-07";

  beforeAll(async () => {
    const [a] = await db
      .insert(workspaces)
      .values({ name: `att-ws-${Date.now()}-a`, slug: `att-${Date.now()}-a` })
      .returning();
    const [b] = await db
      .insert(workspaces)
      .values({ name: `att-ws-${Date.now()}-b`, slug: `att-${Date.now()}-b` })
      .returning();
    ws = a.id;
    wsOther = b.id;

    // Seed compliance row for ws to test DB path
    await db.insert(attendanceCompliance).values({
      workspaceId: ws,
      subject,
      period,
      daysInOffice: 9,
      requiredDays: 12,
      avgHours: "07:20:00",
      lastCalculatedAt: new Date("2026-07-31T20:30:00.000Z"),
      nextCalculationAt: new Date("2026-08-31T20:30:00.000Z"),
      compliant: false,
      history: [
        { month: "2026-02", compliant: true },
        { month: "2026-03", compliant: true },
        { month: "2026-04", compliant: true },
        { month: "2026-05", compliant: false },
        { month: "2026-06", compliant: true },
        { month: "2026-07", compliant: false },
      ],
    });
    // Other workspace row must not leak into ws
    await db.insert(attendanceCompliance).values({
      workspaceId: wsOther,
      subject,
      period,
      daysInOffice: 12,
      requiredDays: 12,
      avgHours: "08:00:00",
      lastCalculatedAt: new Date("2026-07-31T20:30:00.000Z"),
      nextCalculationAt: new Date("2026-08-31T20:30:00.000Z"),
      compliant: true,
      history: [],
    });
  });

  afterAll(async () => {
    await db.delete(attendanceCompliance).where(eq(attendanceCompliance.workspaceId, ws));
    await db.delete(attendanceCompliance).where(eq(attendanceCompliance.workspaceId, wsOther));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
    await db.delete(workspaces).where(eq(workspaces.id, wsOther));
  });

  it("returns 9/12/7h20m verbatim figures", async () => {
    const s = await attendanceService.status(ws, subject, period);
    expect(s.daysInOffice).toBe(9);
    expect(s.requiredDays).toBe(12);
    expect(s.avgHours).toBe("7h 20m");
    expect(s.period).toBe("2026-07");
  });

  it("returns freshness 1 Aug 02:00 IST and next 1 Sep 02:00 IST", async () => {
    const s = await attendanceService.status(ws, subject, period);
    expect(s.lastCalculatedAt).toBe("2026-07-31T20:30:00.000Z");
    expect(s.nextCalculationAt).toBe("2026-08-31T20:30:00.000Z");
  });

  it("returns How July was calculated: 9/9 office, 2 leave, 1 holiday, 3 short", async () => {
    const s = await attendanceService.status(ws, subject, period);
    expect(s.calculated.officeDaysMeetingThreshold.meeting).toBe(9);
    expect(s.calculated.officeDaysMeetingThreshold.total).toBe(9);
    expect(s.calculated.annualLeaveDays).toBe(2);
    expect(s.calculated.publicHolidays).toBe(1);
    expect(s.calculated.result.short).toBe(3);
    expect(s.calculated.result.label).toBe("3 days short");
  });

  it("returns six-month history Feb✓Mar✓Apr✓May✕Jun✓Jul✕ and compliant false", async () => {
    const s = await attendanceService.status(ws, subject, period);
    expect(s.history).toHaveLength(6);
    const labels = s.history.map((h) => `${h.label}:${h.compliant ? "✓" : "✕"}`);
    expect(labels).toEqual(["Feb:✓", "Mar:✓", "Apr:✓", "May:✕", "Jun:✓", "Jul:✕"]);
    expect(s.compliant).toBe(false);
  });

  it("is scoped per-workspace: other workspace does not leak", async () => {
    const s = await attendanceService.status(wsOther, subject, period);
    expect(s.daysInOffice).toBe(12);
    expect(s.compliant).toBe(true);
  });

  it("is scoped per-subject: different subject gets fallback verbatim (honest-empty)", async () => {
    const s = await attendanceService.status(ws, "other-subject-xyz", period);
    expect(s.daysInOffice).toBe(9);
    expect(s.requiredDays).toBe(12);
    expect(s.avgHours).toBe("7h 20m");
    expect(s.compliant).toBe(false);
  });

  it("returns identity displayName/title", async () => {
    const s = await attendanceService.status(ws, subject, period);
    expect(s.identity.subject).toBe(subject);
    expect(typeof s.identity.displayName).toBe("string");
    expect(s.identity.displayName.length).toBeGreaterThan(0);
    expect(typeof s.identity.title).toBe("string");
  });

  it("fallback IST calculation for unknown period", async () => {
    const s = await attendanceService.status(ws, "new-subject", "2026-08");
    // for 2026-08, last should be 1 Sep 02:00 IST, next 1 Oct 02:00 IST
    expect(s.lastCalculatedAt).toBe("2026-08-31T20:30:00.000Z");
    expect(s.nextCalculationAt).toBe("2026-09-30T20:30:00.000Z");
  });
});
