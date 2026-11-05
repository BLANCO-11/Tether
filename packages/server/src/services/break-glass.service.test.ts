import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { db, pool } from "../db/index.js";
import { auditEvents, breakGlassSessions, incidents, workspaces } from "../db/schema.js";
import { incidentService } from "./incident.service.js";
import { breakGlassService } from "./break-glass.service.js";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)("B-16 incidents/break-glass", () => {
  let ws: string;
  let wsOther: string;
  const stamp = Date.now().toString(36);
  const actor = `tester-${stamp}@example.com`;

  beforeAll(async () => {
    const [a] = await db
      .insert(workspaces)
      .values({ name: `b16-ws-${stamp}-a`, slug: `b16-${stamp}-a` })
      .returning();
    const [b] = await db
      .insert(workspaces)
      .values({ name: `b16-ws-${stamp}-b`, slug: `b16-${stamp}-b` })
      .returning();
    ws = a.id;
    wsOther = b.id;

    await db.delete(breakGlassSessions).where(eq(breakGlassSessions.workspaceId, ws));
    await db.delete(breakGlassSessions).where(eq(breakGlassSessions.workspaceId, wsOther));
    await db.delete(incidents).where(eq(incidents.workspaceId, ws));
    await db.delete(incidents).where(eq(incidents.workspaceId, wsOther));
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws));
  });

  afterAll(async () => {
    await db.delete(breakGlassSessions).where(eq(breakGlassSessions.workspaceId, ws));
    await db.delete(breakGlassSessions).where(eq(breakGlassSessions.workspaceId, wsOther));
    await db.delete(incidents).where(eq(incidents.workspaceId, ws));
    await db.delete(incidents).where(eq(incidents.workspaceId, wsOther));
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws));
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, wsOther));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
    await db.delete(workspaces).where(eq(workspaces.id, wsOther));
  });

  it("migration applies idx47: tables and indexes exist", async () => {
    const tables = await pool.query(
      "select tablename from pg_tables where tablename in ('incidents','break_glass_sessions')",
    );
    const names = tables.rows.map((r: { tablename: string }) => r.tablename);
    expect(names).toContain("incidents");
    expect(names).toContain("break_glass_sessions");

    const idx = await pool.query(
      "select indexname from pg_indexes where tablename in ('incidents','break_glass_sessions')",
    );
    const idxNames = idx.rows.map((r: { indexname: string }) => r.indexname);
    expect(idxNames).toContain("idx_incidents_workspace_status");
    expect(idxNames).toContain("idx_break_glass_workspace_incident");
  });

  it("incident list is workspace-scoped and create respects enum", async () => {
    const inc = await incidentService.create({
      workspaceId: ws,
      id: `INC-${stamp}-0001`,
      title: "Unusual HRIS access",
      severity: "sev2",
      ownerSubject: actor,
    });
    expect(inc.severity).toBe("sev2");

    const wsList = await incidentService.list(ws);
    expect(wsList.some((r) => r.id === inc.id)).toBe(true);

    const otherList = await incidentService.list(wsOther);
    expect(otherList.some((r) => r.id === inc.id)).toBe(false);
  });

  it("SEV1 gate: 4h rejected for sev2, allowed for sev1 (400 server-side)", async () => {
    const sev2Id = `INC-${stamp}-sev2-gate`;
    await incidentService.create({
      workspaceId: ws,
      id: sev2Id,
      title: "SEV2 incident",
      severity: "sev2",
    });

    await expect(
      breakGlassService.activate({
        workspaceId: ws,
        incidentId: sev2Id,
        scope: "hris-unmasked",
        duration: 4,
        justification: "This justification is definitely longer than twenty chars",
        acknowledged: true,
        activatedBy: actor,
      }),
    ).rejects.toThrow(/4 hour.*SEV1/i);

    const sev1Id = `INC-${stamp}-sev1-gate`;
    await incidentService.create({
      workspaceId: ws,
      id: sev1Id,
      title: "SEV1 incident",
      severity: "sev1",
    });

    const session = await breakGlassService.activate({
      workspaceId: ws,
      incidentId: sev1Id,
      scope: "hris-unmasked",
      duration: 4,
      justification: "SEV1 emergency justification with more than 20 chars",
      acknowledged: true,
      activatedBy: actor,
    });
    expect(session.durationHours).toBe(4);
    expect(session.status).toBe("active");
    const expires = new Date(session.expiresAt as unknown as string).getTime();
    const activated = new Date(session.activatedAt as unknown as string).getTime();
    expect(expires - activated).toBe(4 * 3600 * 1000);

    await breakGlassService.revoke({ workspaceId: ws, sessionId: session.id });
  });

  it("justification length >=20 enforced server-side (400)", async () => {
    const incId = `INC-${stamp}-justif`;
    await incidentService.create({
      workspaceId: ws,
      id: incId,
      title: "Justification test",
      severity: "sev1",
    });

    await expect(
      breakGlassService.activate({
        workspaceId: ws,
        incidentId: incId,
        scope: "payroll-restricted",
        duration: 1,
        justification: "too short",
        acknowledged: true,
        activatedBy: actor,
      }),
    ).rejects.toThrow(/justification.*20/i);

    await expect(
      breakGlassService.activate({
        workspaceId: ws,
        incidentId: incId,
        scope: "payroll-restricted",
        duration: 1,
        justification: "01234567890123456789",
        acknowledged: true,
        activatedBy: actor,
      }),
    ).resolves.toBeDefined();

    const active = await breakGlassService.active(ws);
    for (const s of active) {
      if (s.incidentId === incId) await breakGlassService.revoke({ workspaceId: ws, sessionId: s.id });
    }
  });

  it("acknowledged must be true else 400", async () => {
    const incId = `INC-${stamp}-ack`;
    await incidentService.create({
      workspaceId: ws,
      id: incId,
      title: "Ack test",
      severity: "sev1",
    });
    await expect(
      breakGlassService.activate({
        workspaceId: ws,
        incidentId: incId,
        scope: "hris-unmasked",
        duration: 2,
        justification: "Valid justification longer than 20 characters",
        acknowledged: false,
        activatedBy: actor,
      }),
    ).rejects.toThrow(/acknowledgement/i);
  });

  it("activates ties to auditService.record and is workspace-scoped", async () => {
    // Free capacity under 5 concurrent open limit (prior tests accumulated 5)
    await pool.query("update incidents set status='closed' where workspace_id=$1 and status != 'closed'", [ws]);
    await pool.query("update break_glass_sessions set status='revoked' where workspace_id=$1 and status='active'", [ws]);
    const incId = `INC-${stamp}-audit`;
    await incidentService.create({
      workspaceId: ws,
      id: incId,
      title: "Audit trail test",
      severity: "sev2",
    });

    const session = await breakGlassService.activate({
      workspaceId: ws,
      incidentId: incId,
      scope: "payroll-restricted",
      duration: 2,
      justification: "Audit trail justification that is long enough here",
      acknowledged: true,
      activatedBy: actor,
    });

    const audits = await pool.query(
      "select * from audit_events where workspace_id=$1 and entity='incident' and entity_id=$2",
      [ws, incId],
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(1);
    const audit = audits.rows.find((r: { description: string }) => r.description.includes("Break-glass"));
    expect(audit).toBeDefined();

    await expect(
      breakGlassService.activate({
        workspaceId: wsOther,
        incidentId: incId,
        scope: "hris-unmasked",
        duration: 1,
        justification: "Valid justification longer than 20 characters for other ws",
        acknowledged: true,
        activatedBy: actor,
      }),
    ).rejects.toThrow(/not found/i);

    const activeWs = await breakGlassService.active(ws);
    expect(activeWs.some((s) => s.id === session.id)).toBe(true);
    const activeOther = await breakGlassService.active(wsOther);
    expect(activeOther.some((s) => s.id === session.id)).toBe(false);

    await breakGlassService.revoke({ workspaceId: ws, sessionId: session.id });
  });

  it("no any in B-16 files (static check)", async () => {
    // ⚠ Resolved against THIS FILE, never against the process cwd. These were
    // repo-root-relative until 2026-09-02, so the check passed only when the
    // runner happened to start at the repo root and threw ENOENT under
    // `pnpm --filter @foundry/server test` — the command this package
    // documents. The subject never moved; the path resolution was wrong.
    const files = [
      "./incident.service.ts",
      "./break-glass.service.ts",
      "../routes/incidents.ts",
      "../routes/break-glass.ts",
      "../db/schema.ts",
    ];
    for (const f of files) {
      const abs = fileURLToPath(new URL(f, import.meta.url));
      const txt = await fs.readFile(abs, "utf8");
      // The control: a path that resolves to something unexpected but readable
      // would otherwise pass by matching nothing. A file with no content cannot
      // satisfy a "does not contain" assertion honestly.
      expect(txt.length, `${f} must be a real, non-empty source file`).toBeGreaterThan(200);
      const anyMatches = txt.match(/:\s*any\b/g);
      expect(anyMatches, `${f} must not contain ': any'`).toBeNull();
    }
  });

  it("expire cron stub marks expired", async () => {
    const incId = `INC-${stamp}-expire`;
    await incidentService.create({
      workspaceId: ws,
      id: incId,
      title: "Expire test",
      severity: "sev1",
    });
    const session = await breakGlassService.activate({
      workspaceId: ws,
      incidentId: incId,
      scope: "hris-unmasked",
      duration: 1,
      justification: "Expire test justification long enough for validation",
      acknowledged: true,
      activatedBy: actor,
    });
    await pool.query("update break_glass_sessions set activated_at = now() - interval '2 hours' where id=$1", [
      session.id,
    ]);
    const expiredCount = await breakGlassService.expire();
    expect(expiredCount).toBeGreaterThanOrEqual(1);
    const [updated] = await db.select().from(breakGlassSessions).where(eq(breakGlassSessions.id, session.id));
    expect(updated.status).toBe("expired");
  });
});
