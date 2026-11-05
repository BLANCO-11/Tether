import { describe, expect, it } from "vitest";
import { summariseRun } from "./flow-runner.service.js";
import type { RunnerStepResult } from "../repositories/runner-step-result.repo.js";

const step = (stepId: string, status: string, scope = ""): RunnerStepResult => ({ stepId, status, scope } as unknown as RunnerStepResult);

describe("the sentence a person reads about a test", () => {
  it("names the failed step and nothing written for Forge", () => {
    const run = { status: "failed", timedOut: false, steps: [step("build_report", "failed"), step("email_report", "skipped")] };
    const said = summariseRun(run);
    expect(said).toBe("The test run failed at step build_report.");
    expect(said).not.toMatch(/VERIFY|Traceback|FoundryError|→/);
  });
  it("empty data says so; a loop item's failure is not named as the step", () => {
    expect(summariseRun({ status: "failed", timedOut: false, steps: [step("b", "failed")] }, true)).toBe("The test ran, but a step returned empty data at step b.");
    expect(summariseRun({ status: "failed", timedOut: false, steps: [step("inner", "failed", "0")] })).toBe("The test run failed.");
  });
  it("passing, waiting and timing out each have their own words", () => {
    expect(summariseRun({ status: "succeeded", timedOut: false, steps: [] })).toBe("The test run passed.");
    expect(summariseRun({ status: "waiting", timedOut: false, steps: [] })).toMatch(/waiting for an approval/);
    expect(summariseRun({ status: "running", timedOut: true, steps: [] })).toMatch(/did not finish in time/);
  });
});
