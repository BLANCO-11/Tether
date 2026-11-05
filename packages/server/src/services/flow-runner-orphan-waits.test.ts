/**
 * Unsaved draft waits must not rot in Activity: boot cancels them, expiry cancels
 * (not resume-as-expired), and the Approvals path for saved flows stays untouched.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runnerSrc = readFileSync(join(here, "flow-runner.service.ts"), "utf8");
const indexSrc = readFileSync(join(here, "../index.ts"), "utf8");
const piSrc = readFileSync(join(here, "../pi-builder/service.ts"), "utf8");

describe("orphaned unsaved draft waits cannot linger", () => {
  it("exports a short orphan wait and a boot reconcile", () => {
    expect(runnerSrc).toMatch(/export const DRAFT_ORPHAN_WAIT_MS/);
    expect(runnerSrc).toMatch(/async reconcileOrphanedDraftWaits/);
    expect(runnerSrc).toMatch(/isNull\(flowExecutions\.flowId\)/);
  });

  it("boot calls reconcileOrphanedDraftWaits from index.ts only (not createApp)", () => {
    expect(indexSrc).toMatch(/flowRunnerService\.reconcileOrphanedDraftWaits\(\)/);
    const appSrc = readFileSync(join(here, "../app.ts"), "utf8");
    expect(appSrc).not.toContain("reconcileOrphanedDraftWaits");
  });

  it("expireStaleApprovals cancels flowless orphans and expires saved-flow waits", () => {
    const body = runnerSrc.slice(runnerSrc.indexOf("async expireStaleApprovals"));
    expect(body).toMatch(/orphanCutoff/);
    expect(body).toMatch(/const orphan = e\.flowId == null/);
    expect(body).toMatch(/await this\.cancel\(e\.id\)/);
    expect(body).toMatch(/decision: "expired"/);
  });

  it("Forge session teardown and a new test cancel a prior waiting draft", () => {
    expect(piSrc).toMatch(/function cancelWaitingTest/);
    expect(piSrc).toMatch(/cancelWaitingTest\(s\)/);
    expect(piSrc).toMatch(/could not cancel prior waiting test/);
  });
});
