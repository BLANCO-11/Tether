/**
 * The per-item fold (phase F, F3 — D-367), on taskruns shaped as a real loop run reports them (2026-09-30): a ForEach's direct
 * children carry `value` (the numbered item), a task inside an `If` arm carries only `parentTaskRunId`.
 */
import { describe, expect, it } from "vitest";
import { foldLoopItems, itemsOfRuns, type RunRef } from "./flow-visibility-loops.js";
import type { StepStatus, StepView } from "./flow-visibility.service.js";

const view = (stepId: string, status: StepStatus, extra: Partial<StepView> = {}): StepView => ({
  stepId, status, kind: "transform", platform: false, ref: null, attempt: 1, startedAt: "2026-09-30T10:00:00.000Z", endedAt: "2026-09-30T10:00:01.000Z", durationMs: 1000,
  request: null, responseCode: null, output: { value: "{}" }, error: null, logs: [], kestraTaskrunId: "x", auditVerdict: null, oracleScore: null, readFrom: null, ...extra,
} as StepView);
const item = (i: number, n: number) => JSON.stringify({ n, _i: i });

// read → each (3 items): test → when (IF n > 10 → big, ELSE → small, a call per ELSE item) → pick; then results.
function run(failSmallOf?: number) {
  const runs: RunRef[] = [{ id: "r_read", taskId: "read" }, { id: "r_each", taskId: "each" }];
  const views: StepView[] = [view("read", "success"), view("each", "success", { kind: "for_each" })];
  [5, 50, 7].forEach((n, i) => {
    const v = item(i, n);
    runs.push({ id: `t${i}`, taskId: "test", parentTaskRunId: "r_each", value: v }, { id: `w${i}`, taskId: "when", parentTaskRunId: "r_each", value: v });
    views.push(view("test", "success"), view("when", "success", { kind: "branch" }));
    if (n > 10) { runs.push({ id: `b${i}`, taskId: "big", parentTaskRunId: `w${i}` }); views.push(view("big", "success")); }
    else {
      runs.push({ id: `s${i}`, taskId: "small", parentTaskRunId: `w${i}` }, { id: `c${i}`, taskId: "notify", parentTaskRunId: `w${i}` });
      const fails = failSmallOf === i;
      views.push(view("small", "success"), view("notify", fails ? "failed" : "success", { kind: "tool", error: fails ? "HTTP 502" : null }));
    }
    runs.push({ id: `p${i}`, taskId: "each-pick", parentTaskRunId: "r_each", value: v });
    views.push(view("each-pick", "success", { platform: true, kind: null, output: { value: JSON.stringify({ i, r: failSmallOf === i ? "__no_result__" : JSON.stringify({ line: `${n > 10 ? "big" : "small"}: ${n}` }) }) } }));
  });
  runs.push({ id: "r_results", taskId: "results" });
  views.push(view("results", "success", { kind: "collect" }));
  return { runs, views };
}
const isLoop = (id: string) => id === "each";

describe("a loop's taskruns, folded to one view per step", () => {
  it("places every taskrun under its item, arm tasks through their If", () => {
    const { runs } = run();
    const at = itemsOfRuns(runs, isLoop);
    expect(at.get("b1")).toEqual({ loop: "each", i: 1 });
    expect(at.get("c2")).toEqual({ loop: "each", i: 2 });
    expect(at.has("r_read")).toBe(false);
    expect(at.has("r_results")).toBe(false);
  });
  it("each body step appears once, counted per item; the loop carries its items in input order, with their paths and results", () => {
    const { runs, views } = run();
    const out = foldLoopItems(views, runs, isLoop);
    expect(out.map((v) => v.stepId)).toEqual(["read", "each", "test", "when", "small", "notify", "each-pick", "big", "results"]);
    expect(out.find((v) => v.stepId === "test")!.perItem).toEqual({ ran: 3, succeeded: 3, failed: 0 });
    expect(out.find((v) => v.stepId === "notify")!.perItem).toEqual({ ran: 2, succeeded: 2, failed: 0 });
    expect(out.find((v) => v.stepId === "test")!.output).toBeNull();
    const loop = out.find((v) => v.stepId === "each")!;
    expect(loop.items!.map((x) => [x.i, x.status, x.path.join(">"), x.result])).toEqual([
      [0, "success", "test>when>small>notify", { line: "small: 5" }],
      [1, "success", "test>when>big", { line: "big: 50" }],
      [2, "success", "test>when>small>notify", { line: "small: 7" }],
    ]);
  });
  it("one failing item: that item failed with its step named and no result, the others fine; the step reads WARNING (some failed)", () => {
    const { runs, views } = run(2);
    const out = foldLoopItems(views, runs, isLoop);
    const loop = out.find((v) => v.stepId === "each")!;
    expect(loop.items![2]).toMatchObject({ i: 2, status: "failed", error: "notify: HTTP 502", result: null });
    expect(loop.items!.slice(0, 2).every((x) => x.status === "success")).toBe(true);
    expect(loop.perItem).toEqual({ ran: 3, succeeded: 2, failed: 1 });
    expect(out.find((v) => v.stepId === "notify")!.status).toBe("warning");
    expect(out.find((v) => v.stepId === "notify")!.error).toBe("HTTP 502");
  });
  it("a loop over an empty list still reports its items — none", () => {
    const out = foldLoopItems([view("each", "success", { kind: "for_each" })], [{ id: "e", taskId: "each" }], isLoop);
    expect(out[0]!.items).toEqual([]);
    expect(out[0]!.perItem).toEqual({ ran: 0, succeeded: 0, failed: 0 });
  });
  it("a BATCHED loop (D-370): each chunk spread back into its items — a per-item failure, and a whole batch that did not finish", () => {
    const rows = (...is: number[]) => JSON.stringify(is.map((i) => ({ name: `n${i}`, _i: i })));
    const env = JSON.stringify({ results: [{ ok: true, data: { sent: "n0" } }, { ok: false, error: "HTTP 400" }], succeeded: 1, failed: 1 });
    const runs: RunRef[] = [{ id: "r_each", taskId: "each" },
      { id: "c0", taskId: "post", parentTaskRunId: "r_each", value: rows(0, 1) }, { id: "p0", taskId: "each-pick", parentTaskRunId: "r_each", value: rows(0, 1) },
      { id: "c1", taskId: "post", parentTaskRunId: "r_each", value: rows(2) }, { id: "p1", taskId: "each-pick", parentTaskRunId: "r_each", value: rows(2) }];
    const views = [view("each", "success", { kind: "for_each" }),
      view("post", "success", { kind: "tool" }), view("each-pick", "success", { platform: true, kind: null, output: { value: JSON.stringify({ is: [0, 1], r: env }) } }),
      view("post", "failed", { kind: "tool", error: "HTTP 502" }), view("each-pick", "success", { platform: true, kind: null, output: { value: JSON.stringify({ is: [2], r: "__no_result__" }) } })];
    const out = foldLoopItems(views, runs, isLoop);
    const loop = out.find((v) => v.stepId === "each")!;
    expect(loop.items!.map((x) => [x.i, x.status, x.path.join(">"), x.error, x.result])).toEqual([
      [0, "success", "post", null, { sent: "n0" }],
      [1, "failed", "post", "post: HTTP 400", null],
      [2, "failed", "post", "post: HTTP 502", null], // the whole batch failed: its call's own error
    ]);
    expect(loop.perItem).toEqual({ ran: 3, succeeded: 1, failed: 2 });
    // The call: ONE view, counted per ITEM (3), not per chunk (2); some failed ⇒ warning.
    const post = out.filter((v) => v.stepId === "post");
    expect(post.length).toBe(1);
    expect([post[0]!.perItem, post[0]!.status]).toEqual([{ ran: 3, succeeded: 1, failed: 2 }, "warning"]);
  });
  it("a run with no loop passes through untouched", () => {
    const views = [view("read", "success"), view("t", "success")];
    expect(foldLoopItems(views, [{ id: "a", taskId: "read" }, { id: "b", taskId: "t" }], () => false)).toBe(views);
  });
});
