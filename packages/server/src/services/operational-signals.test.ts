import { describe, expect, it, beforeEach } from "vitest";
import { schedulerObservability } from "./trigger-scheduler.js";
import { operationalSignals, type Signal } from "./operational-signals.service.js";

/**
 * The operational signals — archive/GAPS.md §6.1.
 *
 * ⚠ **The thing worth testing here is that a signal can say something OTHER
 * than `ok`.** Four checks that all report `ok` against a healthy deployment are
 * indistinguishable from checks that are broken, and that is I-38 in the
 * one place where it is least likely to be noticed — nobody investigates a green
 * monitor. So the sweep signal, which is the one with an in-process input a test
 * can move, is driven through **every** state it can reach.
 *
 * The other three read the live database. They are asserted for the properties
 * that must hold whatever that database contains — a caveat on every signal, a
 * worst-of rollup, and `unknown` never being reported as `ok` — because a test
 * that needed a specific tenant state would either be skipped or be a fixture of
 * the deployment rather than of the code.
 */

const sweepOf = (signals: Signal[]) => signals.find((s) => s.name === "staleness_sweep")!;

/** Put the scheduler's in-memory observability into a known state. */
function setSweep(patch: Partial<typeof schedulerObservability>) {
  Object.assign(schedulerObservability, patch);
}

describe("the staleness-sweep signal reaches every state it claims", () => {
  beforeEach(() => {
    setSweep({
      startedAt: null,
      lastTickAt: null,
      lastSweepAt: null,
      lastSweepChecked: null,
      lastSweepSuspended: null,
      lastSweepError: null,
      ticks: 0,
    });
  });

  it("ALARMS when the scheduler was never started in this process", async () => {
    // The failure nobody would see: a boot path that forgets
    // `startTriggerScheduler()`. Every armed flow keeps firing against refs
    // nothing re-checks, and the sweep's own logging is silent by design.
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("alarm");
    expect(s.detail).toMatch(/never started/);
  });

  it("is UNKNOWN — not ok — in the window after boot before the first sweep", async () => {
    setSweep({ startedAt: Date.now() - 1000 });
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("unknown");
    // The load-bearing half. `ok` here would mean a restarted process reports
    // healthy for a control that has not run once.
    expect(s.state).not.toBe("ok");
  });

  it("ALARMS when the scheduler has been up for ages and never completed a sweep", async () => {
    setSweep({ startedAt: Date.now() - 60 * 60_000 });
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("alarm");
    expect(s.detail).toMatch(/never completed a sweep/);
  });

  it("ALARMS when sweeps stopped, and says how long ago and why", async () => {
    setSweep({
      startedAt: Date.now() - 60 * 60_000,
      lastSweepAt: Date.now() - 30 * 60_000,
      lastSweepError: "connection terminated unexpectedly",
    });
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("alarm");
    expect(s.detail).toMatch(/refs nobody is re-checking/);
    expect(s.detail).toMatch(/connection terminated/);
  });

  it("WARNS when it is sweeping but the last attempt errored", async () => {
    setSweep({
      startedAt: Date.now() - 60 * 60_000,
      lastSweepAt: Date.now() - 1000,
      lastSweepChecked: 4,
      lastSweepSuspended: 0,
      lastSweepError: "boom",
    });
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("warn");
  });

  it("is OK when a sweep completed within the window — the positive control", async () => {
    // Without this the five above are satisfied by a signal that always alarms.
    setSweep({
      startedAt: Date.now() - 60 * 60_000,
      lastSweepAt: Date.now() - 1000,
      lastSweepChecked: 4,
      lastSweepSuspended: 0,
      lastSweepError: null,
    });
    const s = sweepOf((await operationalSignals()).signals);
    expect(s.state).toBe("ok");
    expect(s.detail).toMatch(/checked 4, suspended 0/);
  });
});

describe("the report as a whole", () => {
  beforeEach(() => {
    setSweep({
      startedAt: Date.now() - 60 * 60_000,
      lastSweepAt: Date.now() - 1000,
      lastSweepChecked: 0,
      lastSweepSuspended: 0,
      lastSweepError: null,
    });
  });

  it("reports every signal, and every one names what it cannot detect", async () => {
    const r = await operationalSignals();
    // ⚠ There were four. `agent_poller` watched a runtime that no longer exists,
    // and it went with it — a signal reporting on nothing is worse than an
    // absent one, because it reports `ok`.
    expect(r.signals.map((s) => s.name).sort()).toEqual([
      "execution_slots",
      "scheduled_flows_firing",
      "staleness_sweep",
    ]);
    for (const s of r.signals) {
      // ⚠ A signal read as stronger than it is displaces the manual check that
      // was working, so the bound travels with every one of them.
      expect(s.caveat, `${s.name} must state what it cannot detect`).toBeTruthy();
      expect(s.caveat.length).toBeGreaterThan(40);
      expect(s.detail).toBeTruthy();
    }
  });

  it("rolls up to the WORST state, and `unknown` does not outrank `warn`", async () => {
    const r = await operationalSignals();
    const rank = { ok: 0, unknown: 1, warn: 2, alarm: 3 } as const;
    const worst = r.signals.reduce((w, s) => (rank[s.state] > rank[w] ? s.state : w), "ok" as Signal["state"]);
    expect(r.state).toBe(worst);
    // An `unknown` beside an `ok` must not read as a clean bill, and must not
    // read as louder than a real warning either.
    expect(rank[r.state]).toBeGreaterThanOrEqual(Math.max(...r.signals.map((s) => rank[s.state])));
  });

  it("never reports a signal as absent when it fails — it reports it as unknown", async () => {
    // Every signal is either present with a state, or replaced by an `unknown`
    // entry naming the failure. A report that quietly drops the check that broke
    // is the exact failure mode this endpoint exists to prevent, one level up.
    const r = await operationalSignals();
    // ⚠ Was 4. The agent-poller signal went with the runtime it watched; the
    // assertion is a FLOOR rather than an equality so the number is not a
    // second place to keep the signal list in step.
    expect(r.signals.length).toBeGreaterThanOrEqual(3);
    for (const s of r.signals) {
      expect(["ok", "warn", "alarm", "unknown"]).toContain(s.state);
    }
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

/**
 * Restricted workspaces (phase 3): a restricted workspace the reader is outside of is named, its workflow never. Real
 * rows: one workflow armed with a schedule whose three runs, an hour apart, stopped a day ago — overdue whatever else
 * the database holds.
 */
describe("a restricted workspace's overdue workflow", async () => {
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { flowExecutions, flowRevisions, flows, workspaces } = await import("../db/schema.js");
  const { workspaceRepo } = await import("../repositories/workspace.repo.js");
  const stamp = Date.now().toString(36);
  const ws = await workspaceRepo.create({ name: `signals restricted ${stamp}`, tenantSlug: "sigwire", slug: `sigwire-${stamp}` }).catch(() => undefined);
  const flowId = randomUUID();
  const FLOW_NAME = `secret payroll check ${stamp}`;

  beforeEach(async () => {
    if (!ws) return;
    const [exists] = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, flowId));
    if (exists) return;
    await db.insert(flows).values({ id: flowId, workspaceId: ws.id, name: FLOW_NAME, kestraFlowId: `sig-${stamp}`, armedRevision: 1, status: "armed" });
    await db.insert(flowRevisions).values({ flowId, revision: 1, modelJson: { schedule: { cron: "0 * * * *" }, steps: [] }, compiledYamlHash: "x", structureHash: "x", createdByKind: "system" });
    const day = 86_400_000;
    await db.insert(flowExecutions).values(
      [3, 2, 1].map((h) => ({
        workspaceId: ws.id,
        flowId,
        kestraNamespace: `foundry.sigwire.sigwire-${stamp}`,
        kestraFlowId: `sig-${stamp}`,
        kestraExecutionId: `sig-${stamp}-${h}`,
        startedAt: new Date(Date.now() - day - h * 3_600_000),
      })),
    );
  });

  it("names the workspace and never the workflow — and CONTROL, names the workflow when the reader is inside", async () => {
    if (!ws) return;
    try {
      const scheduled = (r: Awaited<ReturnType<typeof operationalSignals>>) => r.signals.find((s) => s.name === "scheduled_flows_firing")!;
      const outside = scheduled(await operationalSignals(new Map([[ws.id, ws.name]])));
      expect(JSON.stringify(outside)).not.toContain(FLOW_NAME);
      expect(outside.detail).toContain(`restricted workspace "${ws.name}"`);
      const inside = scheduled(await operationalSignals());
      expect(JSON.stringify(inside)).toContain(FLOW_NAME);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    }
  });
});
