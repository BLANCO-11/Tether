// src/services/flow-publish-arms.test.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ PUBLISH MEANS "READY TO RUN IN WHATEVER CAPACITY IT WAS BUILT IN"
// ─────────────────────────────────────────────────────────────────────────────
//
// Measured on this deployment before the change: 14 flows, every one a draft,
// **zero approvals in the whole table's history**, and 8 trigger rows with
// `enabled = false` on every single one. Approval deploys a Kestra Schedule only
// when the model declares a cron (1 revision of 30 does) and every other firing
// mechanism is its own row. So all 14 flows could have read **Live** and nothing
// would ever have fired.
//
// ⚠ Only **1 of those 8** triggers is bound to a flow that has ever completed a
// run, so gate 1 is not a hypothetical here — it is what happens to seven of
// them. That is why the outcome is three values and not a boolean.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ⚠ `vi.mock` is a WHOLE-MODULE replacement — this trap has bitten this repo
// five times. Anything else `flow-approval.service.ts` imports from these two
// modules has to be listed, or it arrives `undefined` and the failure appears
// somewhere unrelated.
const listByFlow = vi.fn();
const update = vi.fn();
vi.mock("../repositories/trigger.repo.js", () => ({
  triggerRepo: { listByFlow: (...a: unknown[]) => listByFlow(...a), update: (...a: unknown[]) => update(...a) },
}));

const flowEnableReadiness = vi.fn();
vi.mock("./flow-arm-readiness.js", () => ({
  flowEnableReadiness: (...a: unknown[]) => flowEnableReadiness(...a),
}));

const { flowApprovalService } = await import("./flow-approval.service.js");

const flow = { id: "f1", kestraFlowId: "k1", draftRevision: 3, armedRevision: null } as never;
const model = (over: Record<string, unknown> = {}) => ({ id: "k1", steps: [], ...over }) as never;
const trig = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Start by hand",
  type: "manual",
  enabled: false,
  flowId: "f1",
  workspaceId: "w1",
  config: {},
  ...over,
});

const arm = (m = model()) => flowApprovalService._armDeclaredCapacity("w1", flow, m);

beforeEach(() => {
  listByFlow.mockReset();
  update.mockReset();
  flowEnableReadiness.mockReset();
  flowEnableReadiness.mockResolvedValue({ ready: true, reason: null });
  update.mockResolvedValue(undefined);
});

describe("what publishing arms", () => {
  it("enables the flow's manual and api triggers", async () => {
    listByFlow.mockResolvedValue([trig(), trig({ id: "t2", name: "Over the API", type: "api" })]);
    const out = await arm();
    expect(out.armed.map((a) => a.name)).toEqual(["Start by hand", "Over the API"]);
    expect(out.held).toEqual([]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith("t1", { enabled: true });
  });

  it("reports the cron, which is NOT a trigger row", async () => {
    // D-18 — a flow's cron lives on its model, so a caller reading only `armed`
    // would conclude a scheduled flow fires nothing.
    listByFlow.mockResolvedValue([]);
    const out = await arm(model({ schedule: { cron: "0 7 * * 1" } }));
    expect(out.schedule).toBe("0 7 * * 1");
    expect(out.armed).toEqual([]);
  });

  it("a flow with no triggers and no cron arms nothing and asks nothing", async () => {
    listByFlow.mockResolvedValue([]);
    const out = await arm();
    expect(out).toEqual({ armed: [], held: [], schedule: null });
    expect(flowEnableReadiness).not.toHaveBeenCalled();
  });
});

describe("gate 1 is asked, and obeyed", () => {
  it("⚠ a flow that has never completed a run arms NOTHING and says why", async () => {
    /**
     * The state 7 of this deployment's 8 triggers are in. Publishing must
     * succeed — gate 1 for APPROVAL was downgraded to a warning on 2026-09-07
     * by explicit request — and must not arm anything, and must say which
     * sentence applies.
     */
    flowEnableReadiness.mockResolvedValue({
      ready: false,
      reason: "The flow has never completed a run. Start a test run…",
    });
    listByFlow.mockResolvedValue([trig()]);
    const out = await arm();
    expect(out.armed).toEqual([]);
    expect(out.held[0]!.reason).toMatch(/never completed a run/);
    expect(update).not.toHaveBeenCalled();
  });

  it("⚠ it carries the server's OWN sentence, not a summary of it", async () => {
    // The reason is always specific and the specific half is the actionable
    // half. Replacing it with "not ready yet" throws that away.
    flowEnableReadiness.mockResolvedValue({
      ready: false,
      reason: 'This flow declares 2 expectation(s) … and 1 of them ("rows") has not passed',
    });
    listByFlow.mockResolvedValue([trig()]);
    expect((await arm()).held[0]!.reason).toContain('("rows")');
  });

  it("CONTROL: the gate can also say YES, so a refusal is a decision not a default", async () => {
    // Without this, a `flowEnableReadiness` that returned `ready: false` for
    // everything would satisfy every assertion above.
    listByFlow.mockResolvedValue([trig()]);
    expect((await arm()).armed).toHaveLength(1);
    flowEnableReadiness.mockResolvedValue({ ready: false, reason: "no" });
    listByFlow.mockResolvedValue([trig()]);
    expect((await arm()).armed).toHaveLength(0);
  });

  it("is asked ONCE however many triggers there are", async () => {
    // It is scoped to the FLOW, so a per-trigger call is the same query N times
    // for the same answer.
    listByFlow.mockResolvedValue([trig(), trig({ id: "t2" }), trig({ id: "t3", type: "api" })]);
    await arm();
    expect(flowEnableReadiness).toHaveBeenCalledTimes(1);
  });
});

describe("what publishing does NOT arm", () => {
  it("⚠ a webhook is HELD — a public endpoint is not turned on as a side effect", async () => {
    listByFlow.mockResolvedValue([trig({ id: "w1", name: "Inbound hook", type: "webhook" })]);
    const out = await arm();
    expect(out.armed).toEqual([]);
    expect(out.held[0]!.reason).toMatch(/public endpoint/i);
    // It must point somewhere: a refusal with no next step is a dead end.
    expect(out.held[0]!.reason).toMatch(/Triggers page/);
    expect(update).not.toHaveBeenCalled();
  });

  it("holds the webhook WITHOUT asking gate 1 — the refusal is categorical", async () => {
    listByFlow.mockResolvedValue([trig({ type: "webhook" })]);
    await arm();
    expect(flowEnableReadiness).not.toHaveBeenCalled();
  });

  it("⚠ a webhook beside an armable trigger holds only the webhook", async () => {
    // Partial is the normal outcome and must not collapse either way.
    listByFlow.mockResolvedValue([
      trig({ id: "t1", type: "manual", name: "By hand" }),
      trig({ id: "w1", type: "webhook", name: "Hook" }),
    ]);
    const out = await arm();
    expect(out.armed.map((a) => a.name)).toEqual(["By hand"]);
    expect(out.held.map((h) => h.name)).toEqual(["Hook"]);
  });
});

describe("publishing twice is an ordinary act", () => {
  it("an already-enabled trigger is REPORTED, not re-written", async () => {
    listByFlow.mockResolvedValue([trig({ enabled: true })]);
    const out = await arm();
    expect(out.armed).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
    // And nothing is asked: the answer could not change what is already true.
    expect(flowEnableReadiness).not.toHaveBeenCalled();
  });

  it("⚠ an already-enabled WEBHOOK is armed, not held", async () => {
    // `materializeDeclaredTriggers` has created model-declared webhooks
    // `enabled: true` with no gate since Phase 6. Reporting one as `held`
    // would tell a person a live endpoint is off.
    listByFlow.mockResolvedValue([trig({ type: "webhook", enabled: true })]);
    expect((await arm()).armed).toHaveLength(1);
    expect((await arm()).held).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The properties that are ABSENCES — read off disk, because you cannot observe
// something not happening by calling it. Same idiom as `flow-armed-pin.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const approvalSrc = here("./flow-approval.service.ts");
const triggerSrc = here("./trigger.service.ts");
const readinessSrc = here("./flow-arm-readiness.ts");

/** The body of one method of the service object, braces balanced. */
function methodBody(source: string, name: string): string {
  const at = source.indexOf(`async ${name}(`);
  if (at === -1) return "";
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  return "";
}

describe("arming does not become a second live-namespace writer", () => {
  const body = methodBody(approvalSrc, "_armDeclaredCapacity");

  it("CONTROL: the method body was actually found", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("triggerRepo.update");
  });

  it("⚠ it touches Kestra NOWHERE — `_deployLive` stays the only writer (§6.5)", () => {
    /**
     * The property that makes "editing cannot change what the schedule runs"
     * checkable by grepping for one caller instead of reading every path. A
     * `triggers` row is not a Kestra object; the schedule is, and the compile
     * owns it.
     */
    expect(body).not.toMatch(/\bkestra\./);
    expect(body).not.toContain("_deployLive");
    expect(body).not.toContain("deployFlow");
  });

  it("⚠ arming is ordered BEFORE the approval row, the fail-visible direction", () => {
    // Triggers on + flow unapproved is refused by `begin` and `fire` — visible.
    // Flow live + triggers off is the silent trap this change removes.
    const armAt = approvalSrc.indexOf("this._armDeclaredCapacity(");
    const rowAt = approvalSrc.indexOf("flowRepo.insertApproval(");
    expect(armAt).toBeGreaterThan(0);
    expect(rowAt).toBeGreaterThan(0);
    expect(armAt).toBeLessThan(rowAt);
  });
});

describe("gate 1 has ONE definition", () => {
  it("⚠ the approval service IMPORTS it and does not re-derive it", () => {
    expect(approvalSrc).toContain('from "./flow-arm-readiness.js"');
    /**
     * ⚠ **SCOPED TO THE ARMING METHOD'S BODY, and the first version of this
     * assertion was WRONG in the way this repo keeps warning about.** It read
     * `expect(approvalSrc).not.toContain("hasSucceeded")` over the whole file
     * and went red against correct code: this service uses `hasSucceeded`
     * twice more, legitimately and for DIFFERENT questions — gate 1 as a
     * `console.warn` on approval (the 2026-09-07 decision) and `state()`
     * computing `blockedReason` for the UI to show as a warning. A guard that
     * cries wolf gets widened, and the widening people reach for permits the
     * defect (I-62). State what is forbidden — re-deriving the gate *inside the
     * arming path* — not a token that resembles it.
     */
    const body = methodBody(approvalSrc, "_armDeclaredCapacity");
    expect(body).toContain("flowEnableReadiness");
    expect(body).not.toContain("hasSucceeded");
    expect(body).not.toContain("gateOutcome");
    expect(body).not.toContain("flowExecutionRepo");
  });

  it("⚠ the trigger service imports it too — the move did not fork it", () => {
    expect(triggerSrc).toContain('from "./flow-arm-readiness.js"');
    expect(triggerSrc).not.toContain("async function flowEnableReadiness");
  });

  it("CONTROL: the gate really is in the leaf, and really does both halves", () => {
    // Without this the two assertions above pass against an empty leaf module.
    expect(readinessSrc).toContain("export async function flowEnableReadiness");
    expect(readinessSrc).toContain("hasSucceeded");
    expect(readinessSrc).toContain("gateOutcome");
  });

  it("⚠ the trigger gate was NOT relaxed to match approval's warning", () => {
    /**
     * Gate 1 for APPROVAL became a `console.warn` on 2026-09-07 at the user's
     * request. The asymmetry is deliberate: approving records that a person
     * read a version; arming lets it fire with nobody watching. This is the
     * one-line "fix" that would erase the distinction.
     */
    expect(triggerSrc).toContain("assertEnableAllowed");
    expect(triggerSrc).toMatch(/if \(!ready\) throw conflict\(/);
  });
});
