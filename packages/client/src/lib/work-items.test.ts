// src/lib/work-items.test.ts — the diff, and the four rules that stop the
// notification area from crying wolf.
//
//   1. the first look announces nothing;
//   2. a dropped poll does not re-announce everything;
//   3. work that vanishes from the window is not reported as finished;
//   4. a refusal is never called a failure.
import { describe, expect, it } from "vitest";
import {
  diffWork,
  inFlightSignature,
  toastLine,
  workFromRuns,
  type WorkItem,
} from "./work-items";
import type { FlowExecutionSummary, StepStatus } from "./types";

const run = (id: string, engineStatus: StepStatus | null, name = "Chase invoices"): FlowExecutionSummary => ({
  id,
  workspaceId: "w",
  flowId: "f",
  flowName: name,
  flowNameSnapshot: null,
  flowIdSnapshot: null,
  status: "running",
  engineStatus,
  startedAt: "2026-08-07T09:00:00.000Z",
  endedAt: null,
  durationMs: null,
  inputs: {},
  replayOfId: null,
  replayFromStep: null,
});


const map = (items: WorkItem[]) => new Map(items.map((i) => [i.key, i]));

describe("workFromRuns", () => {
  it("treats a null engineStatus as still live, never as success", () => {
    // ⚠ `engineStatus` is null when Kestra could not be asked. A run whose state
    // nobody could read is not a run that succeeded, and this is the easiest
    // place in the codebase to lose that distinction.
    const [item] = workFromRuns([run("r1", null)]);
    expect(item!.live).toBe(true);
    expect(item!.outcome).toBeNull();
  });

  it("settles an unrecognised engine state as `unknown`, not as live and not as ok", () => {
    // ⚠ Three cases, and this is the third: the engine ANSWERED, with something
    // this build has no mapping for. Live forever would leave it spinning in the
    // bell; `ok` would be D-66's exact refusal — an unrecognised state must not
    // read as fine. This branch used to be unreachable, which made `unknown` a
    // control that could not fire.
    const [item] = workFromRuns([run("r1", "skipped")]);
    expect(item!.live).toBe(false);
    expect(item!.outcome).toBe("unknown");
  });

  it("maps the engine's terminal states", () => {
    expect(workFromRuns([run("r1", "success")])[0]!.outcome).toBe("ok");
    expect(workFromRuns([run("r1", "warning")])[0]!.outcome).toBe("ok");
    expect(workFromRuns([run("r1", "failed")])[0]!.outcome).toBe("failed");
    expect(workFromRuns([run("r1", "cancelled")])[0]!.outcome).toBe("failed");
  });

  it("counts `paused` as live — a gate waiting for a person has not finished", () => {
    expect(workFromRuns([run("r1", "paused")])[0]!.live).toBe(true);
  });

  it("uses the flow's NAME, never its id", () => {
    // I-23: the two swapped once, and only the label survived being wrong.
    expect(workFromRuns([run("r1", "success", "finance-invoice-chase")])[0]!.title).toBe(
      "finance-invoice-chase",
    );
  });

  it("prefers flowNameSnapshot, and maps the draft slug pi-adhoc to Draft test", () => {
    const withSnap = run("r1", "running", "pi-adhoc");
    withSnap.flowNameSnapshot = "Monthly hours";
    expect(workFromRuns([withSnap])[0]!.title).toBe("Monthly hours");
    expect(workFromRuns([run("r2", "running", "pi-adhoc")])[0]!.title).toBe("Draft test");
  });
});

describe("diffWork", () => {
  it("announces NOTHING on the first look", () => {
    // ⚠ The rule the whole surface depends on. `null` means "never looked": on
    // the first poll everything is new to this browser and almost nothing is new
    // to the world. Without this, opening the app pops a toast for every run of
    // the last hour, and the tenth time nobody reads any of them.
    const items = workFromRuns([run("r1", "success"), run("r2", null)]);
    expect(diffWork(null, items)).toEqual([]);
  });

  it("distinguishes `never looked` from `last time there was nothing`", () => {
    // An empty map is a real observation: something appearing since IS news.
    const started = diffWork(new Map(), workFromRuns([run("r1", null)]));
    expect(started).toHaveLength(1);
    expect(started[0]!.event).toBe("started");
  });

  it("announces a settle, with the outcome", () => {
    const before = map(workFromRuns([run("r1", null)]));
    const after = workFromRuns([run("r1", "failed")]);
    const [n] = diffWork(before, after);
    expect(n!.event).toBe("settled");
    expect(n!.outcome).toBe("failed");
  });

  it("does NOT announce something that was already finished when first seen", () => {
    // It settled before anyone was watching. "Started" would be stale, and
    // "settled" is indistinguishable from the first-poll flood.
    expect(diffWork(new Map(), workFromRuns([run("r1", "success")]))).toEqual([]);
  });

  it("says nothing about work that fell out of the window", () => {
    // ⚠ The lists are windowed. A run that disappeared might have finished,
    // might have been purged, might have been pushed off the end by newer rows.
    // "It vanished" is not an outcome, and reporting a completion nobody can
    // verify is the plausible-but-unfalsifiable answer this codebase refuses.
    expect(diffWork(map(workFromRuns([run("r1", null)])), [])).toEqual([]);
  });

  it("does not re-announce anything when it is called twice with the same state", () => {
    const items = workFromRuns([run("r1", "success")]);
    const first = diffWork(map(workFromRuns([run("r1", null)])), items);
    expect(first).toHaveLength(1);
    expect(diffWork(map(items), items)).toEqual([]);
  });
});

describe("inFlightSignature", () => {
  it("is stable while the same work is running", () => {
    // ⚠ Pages put this in their `useAsync` deps. A value that changed every poll
    // would turn one shell request into every open page refetching every few
    // seconds — a load pattern nobody chose and nothing on screen would explain.
    const a = workFromRuns([run("r1", null), run("r2", null)]);
    const b = workFromRuns([run("r2", null), run("r1", null)]);
    expect(inFlightSignature(a)).toBe(inFlightSignature(b));
  });

  it("changes when something starts or finishes", () => {
    const running = workFromRuns([run("r1", null)]);
    expect(inFlightSignature(running)).not.toBe(inFlightSignature(workFromRuns([run("r1", "success")])));
    expect(inFlightSignature(running)).not.toBe(
      inFlightSignature(workFromRuns([run("r1", null), run("r2", null)])),
    );
  });

  it("ignores settled work entirely", () => {
    expect(inFlightSignature(workFromRuns([run("r1", "success"), run("r2", "failed")]))).toBe("");
  });
});

describe("toastLine", () => {
  it("does not report an unreadable outcome as a failure", () => {
    const before = map(workFromRuns([run("r1", null)]));
    // A run that leaves the engine's known states — the outcome is `unknown`,
    // and saying "did not finish" would be a claim nobody checked.
    const after = workFromRuns([run("r1", "skipped")]);
    const [n] = diffWork(before, after);
    expect(n!.outcome).toBe("unknown");
    expect(toastLine(n!)).toMatch(/could not be read/i);
  });
});
