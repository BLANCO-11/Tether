import { describe, expect, it } from "vitest";
import { buildSteps, executionBase } from "./flow-visibility.service.js";
import type { KestraExecution } from "./kestra-client.service.js";

/**
 * The attempt count, and why it has a test of its own.
 *
 * `StepView.attempt` is rendered by `StepGraph` as an "attempt N" badge, by
 * `StepDetail` as a field, and by `StepStrip` in its tooltip. It was computed as
 * `tr.attempt ?? 1` against a scalar **Kestra does not publish**, so the fallback
 * was the only branch that ever ran and the badge was unreachable.
 *
 * Nothing caught it. The field is declared on `KestraTaskRun`, so review and the
 * typechecker both saw a plain read; no fixture ever had more than one attempt,
 * because the compiler emitted no `retry:` block until Stage 4. It surfaced the
 * first time a real retry happened, as `attempt: undefined` beside an `attempts`
 * array of length 2.
 *
 * So the test is not "does the count work" — it is "is the count derived from
 * the field the engine actually sends", which is the thing that was wrong.
 */

const taskrun = (taskId: string, states: string[]) => ({
  id: `tr-${taskId}`,
  taskId,
  executionId: "ex1",
  state: { current: states[states.length - 1], histories: [] },
  // The shape Kestra really returns: one entry per attempt, each with its own
  // state. Measured against v1.3.29 — a recovered task comes back FAILED, SUCCESS.
  attempts: states.map((s) => ({ state: { current: s } })),
  outputs: {},
});

const execution = (taskRunList: unknown[]): KestraExecution =>
  ({
    id: "ex1",
    namespace: "foundry.acme.hr.draft",
    flowId: "f",
    state: { current: "WARNING" },
    taskRunList,
  }) as KestraExecution;

const build = (taskRunList: unknown[]) => buildSteps(execution(taskRunList), new Map(), new Map());

describe("StepView.attempt comes from `attempts.length`, not a scalar the engine never sends", () => {
  it("reports 2 for a task that failed and then succeeded", () => {
    const [step] = build([taskrun("probe", ["FAILED", "SUCCESS"])]);
    expect(step.attempt).toBe(2);
    // The final state, not the first: a recovery is a success that took two goes.
    expect(step.status).toBe("success");
  });

  it("reports 1 for a task that ran once — the common case, and the old bug's disguise", () => {
    // This assertion passed against the broken implementation too. It is here as
    // the control: on its own it proves nothing, and that is exactly why the bug
    // survived. Only the pair discriminates.
    const [step] = build([taskrun("probe", ["SUCCESS"])]);
    expect(step.attempt).toBe(1);
  });

  it("reports the count even when every attempt failed", () => {
    // An exhausted retry. The count says the engine tried; the status says it
    // never got there. Reporting 1 here would make an exhausted retry look like
    // a step that failed on its only try — a different diagnosis entirely.
    const [step] = build([taskrun("probe", ["FAILED", "FAILED", "FAILED"])]);
    expect(step.attempt).toBe(3);
    expect(step.status).toBe("failed");
  });

  it("falls back to 1 when the engine sends no attempts array at all", () => {
    const [step] = build([
      { id: "t", taskId: "probe", executionId: "ex1", state: { current: "SUCCESS" }, outputs: {} },
    ]);
    expect(step.attempt).toBe(1);
  });

  it("ignores a stray `attempt` scalar — it is not a field Kestra publishes", () => {
    // The regression guard. Someone re-adding `tr.attempt ?? …` would make this
    // read 7, and the count would once again be whatever a stale type said rather
    // than what the engine did.
    const [step] = build([
      { ...taskrun("probe", ["FAILED", "SUCCESS"]), attempt: 7 },
    ]);
    expect(step.attempt).toBe(2);
  });
});

/**
 * I-23 / GAPS §3.2 — two id spaces under one name.
 *
 * `list()` and `get()` both set `flowId: r.kestraFlowId`, so an execution's
 * `flowId` was the engine's SLUG while `flowId` everywhere else in the API —
 * `/flows/:flowId`, `FAFlow.id`, `replayOfId` — is a uuid. Nothing failed,
 * because the only consumers rendered it as a label and a slug reads perfectly
 * well as one.
 *
 * That is the shape of the bug worth testing for: a field whose only consumer
 * prints it will type-check, look right and stay wrong indefinitely. So the
 * assertions below are about MEANING, not about the value being non-empty —
 * `toBeTruthy()` on either field passes against the version that was broken.
 */
const row = {
  id: "fe-1",
  workspaceId: "ws-1",
  flowId: "3f2b9a4c-0000-4000-8000-000000000001",
  kestraFlowId: "attendance-monitoring",
  flowNameSnapshot: null,
  flowIdSnapshot: null,
  status: "running",
  startedAt: new Date("2026-06-01T10:00:00Z"),
  endedAt: new Date("2026-06-01T10:00:07Z"),
  inputsJson: { period: "2026-06" },
  replayOfId: null,
  replayFromStep: null,
  // GAPS §1.1b. A run that predates migration 0029 has neither, and this
  // fixture is deliberately one: `executionBase` must default the kind rather
  // than hand a client a null.
  requestedBy: null,
  requestedByKind: null,
};

describe("an execution's `flowId` is FOUNDRY's flow uuid, and the slug is its own field", () => {
  it("returns the Foundry uuid as `flowId` — the id a client can filter by", () => {
    // The failure this prevents is silent: a client holding a flow uuid (which
    // is what every other route returns) filtered the executions list and got
    // ZERO rows, which is indistinguishable from "this flow has never run".
    expect(executionBase(row).flowId).toBe("3f2b9a4c-0000-4000-8000-000000000001");
    expect(executionBase(row).flowId).not.toBe("attendance-monitoring");
  });

  it("keeps the slug reachable as `flowName`, so the label did not regress", () => {
    // Deleting the slug outright would have been the tidy fix and a visible
    // regression: `/runs/[id]`'s page title and history's automation column both
    // rendered it, and a uuid in either place is worse than the wrong id space.
    expect(executionBase(row).flowName).toBe("attendance-monitoring");
  });

  it("carries a NULL `flowId` for flowless history rather than inventing one", () => {
    // `flow_executions.flow_id` is nullable — `ON DELETE SET NULL`, plus Phase-1
    // runs that predate the `flows` table. The slug is NOT NULL and is copied
    // onto the row at `begin`, so it survives the flow being deleted and is the
    // only label such a run has.
    const orphan = executionBase({ ...row, flowId: null });
    expect(orphan.flowId).toBeNull();
    expect(orphan.flowName).toBe("attendance-monitoring");
  });

  it("is ONE projection, so `list()` and `get()` cannot drift apart again", () => {
    // I-23 was two identical bugs, one per method. Both now build this shape
    // through `executionBase`, which is why there is one thing to assert.
    const keys = Object.keys(executionBase(row)).sort();
    expect(keys).toContain("flowId");
    expect(keys).toContain("flowName");
    // No engine addressing on the view at all (R5, I-22) — not the namespace,
    // not the Kestra execution id.
    expect(keys).not.toContain("namespace");
    expect(keys).not.toContain("kestraExecutionId");
  });
});

describe("`flowNameSnapshot` — the flow's name AT THE MOMENT this run began", () => {
  it("is copied straight through, distinct from the slug", () => {
    const named = executionBase({ ...row, flowNameSnapshot: "Rachit V1" });
    expect(named.flowNameSnapshot).toBe("Rachit V1");
    // The slug is unaffected — the two fields are independent copies made at
    // `begin`, not one derived from the other.
    expect(named.flowName).toBe("attendance-monitoring");
  });

  it("is null for a run that predates the column, same as `row` above", () => {
    expect(executionBase(row).flowNameSnapshot).toBeNull();
  });

  it("survives an orphaned run exactly like the slug does", () => {
    const orphan = executionBase({ ...row, flowId: null, flowNameSnapshot: "Rachit V1" });
    expect(orphan.flowId).toBeNull();
    expect(orphan.flowNameSnapshot).toBe("Rachit V1");
  });
});

describe("`flowIdSnapshot` — the flow's id AT THE MOMENT this run began (mirrors flowNameSnapshot above)", () => {
  it("is copied straight through, distinct from the live `flowId`", () => {
    const snapshotted = executionBase({ ...row, flowIdSnapshot: "3f2b9a4c-0000-4000-8000-000000000001" });
    expect(snapshotted.flowIdSnapshot).toBe("3f2b9a4c-0000-4000-8000-000000000001");
    expect(snapshotted.flowId).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });

  it("is null for a run that predates the column, same as `row` above", () => {
    expect(executionBase(row).flowIdSnapshot).toBeNull();
  });

  it("survives an orphaned run exactly like flowNameSnapshot does — the whole point of the field", () => {
    const orphan = executionBase({
      ...row,
      flowId: null,
      flowIdSnapshot: "3f2b9a4c-0000-4000-8000-000000000001",
    });
    expect(orphan.flowId).toBeNull();
    expect(orphan.flowIdSnapshot).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });
});

describe("who asked for a run — GAPS §1.1b", () => {
  it("defaults a run with no record to `unknown`, never to null and never to `schedule`", () => {
    // ⚠ Both wrong answers matter. `null` makes every client write its own
    // fallback; `schedule` asserts nobody was involved, which for the 111 rows
    // backfilled by migration 0029 is a fact nobody established.
    expect(executionBase(row).requestedByKind).toBe("unknown");
    expect(executionBase(row).requestedBy).toBeNull();
  });

  it("reports the requester on the SUMMARY, including for the boring kinds", () => {
    // A field that only appears when a person was involved is one nobody builds
    // a habit of reading — `readFrom`'s argument (D-52), applied here.
    const scheduled = executionBase({ ...row, requestedBy: null, requestedByKind: "schedule" });
    expect(scheduled.requestedByKind).toBe("schedule");
    const person = executionBase({
      ...row,
      requestedBy: "alice@acme-hr.example",
      requestedByKind: "user",
    });
    expect(person.requestedBy).toBe("alice@acme-hr.example");
  });
});
