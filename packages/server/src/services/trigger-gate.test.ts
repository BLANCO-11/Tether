import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../db/index.js";
import { workspaces, flows, flowRevisions, flowExecutions, triggers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { triggerService, createTriggerSchema } from "./trigger.service.js";
import { triggerRepo } from "../repositories/trigger.repo.js";

/**
 * The trigger enable gate — **rewritten for flows in Phase 4 (task 4.11)**, not
 * deleted with the scripts it used to test.
 * WS-H0.4 · archive/kestra-migration/05-lifecycle-and-flows.md §6.5
 *
 * The gate's original subject (`scripts`, `execution_results`) is gone, but
 * every property it asserted is still a property of the product and each one
 * exists because it was once wrong:
 *
 *   * `enabled` defaults to FALSE — it was `true`, so a client that omitted the
 *     field armed the trigger on creation.
 *   * A trigger arms only after ONE completed run. Generation passing its own
 *     self-test is not evidence: measured 2026-07-26, a script with
 *     `status="completed"`, `tests_passed=true` and audit `clean` hardcoded
 *     `period="2023-10"` and emailed 0 of 11 people.
 *   * A FAILED run is not a run. Reading "has any execution row" instead of
 *     "has a succeeded one" would arm a trigger on the strength of a crash.
 *   * Disabling is ALWAYS allowed. Pausing a trigger must never be the operation
 *     that fails.
 *
 * **And the gate still proves only that it ran, never that it was right.** Only
 * the oracle does that. The green "Ran successfully" chip is not a quality gate.
 *
 * Runs against the real parent database, because the gate is a query and a
 * mocked repository would only prove the mock.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[WS-H0] SKIPPING trigger-gate tests — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let wsId: string;
/** Has a revision but has never run — the state the old gate let through. */
let unrunFlowId: string;
/** No revision at all. */
let emptyFlowId: string;
/** Has a revision AND one succeeded execution. */
let provenFlowId: string;

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `ws-h0-test-${Date.now()}`, description: "WS-H0 gate test; safe to delete" })
    .returning();
  wsId = ws.id;

  const mk = async (name: string, draftRevision: number) => {
    const [f] = await db
      .insert(flows)
      .values({
        workspaceId: wsId,
        name,
        kestraFlowId: `gate-${name}-${Date.now()}`,
        draftRevision,
        status: draftRevision > 0 ? "draft" : "draft",
      })
      .returning();
    return f.id;
  };
  unrunFlowId = await mk("unrun", 1);
  emptyFlowId = await mk("empty", 0);
  provenFlowId = await mk("proven", 1);

  await db.insert(flowExecutions).values({
    flowId: provenFlowId,
    workspaceId: wsId,
    flowRevision: 1,
    kestraExecutionId: `gate-proven-${Date.now()}`,
    kestraNamespace: "foundry.gate.test",
    kestraFlowId: "gate-proven",
    status: "succeeded",
  });
  // A FAILED run on the unrun flow must not count as evidence it works.
  await db.insert(flowExecutions).values({
    flowId: unrunFlowId,
    workspaceId: wsId,
    flowRevision: 1,
    kestraExecutionId: `gate-unrun-${Date.now()}`,
    kestraNamespace: "foundry.gate.test",
    kestraFlowId: "gate-unrun",
    status: "failed",
  });
});

afterAll(async () => {
  if (reachable && wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await pool.end().catch(() => {});
});

const create = (flowId: string, over: Record<string, unknown> = {}) =>
  triggerService.createForFlow(
    wsId,
    flowId,
    createTriggerSchema.parse({ name: "t", type: "manual", ...over }),
  );

describe.skipIf(!reachable)("WS-H0.2 trigger enable gate", () => {
  it("defaults a new trigger to disabled", async () => {
    const t = await create(provenFlowId);
    expect(t.enabled).toBe(false);
  });

  it("refuses to enable a flow that has never completed a run, and says why", async () => {
    const t = await create(unrunFlowId);
    expect(t.enableReady).toBe(false);
    expect(t.enableBlockedReason).toMatch(/never completed a run/i);

    await expect(triggerService.update(t.id, { enabled: true })).rejects.toMatchObject({
      statusCode: 409,
    });
    // And the refusal must not have partially applied.
    expect((await triggerRepo.get(t.id))!.enabled).toBe(false);
  });

  it("does not accept a FAILED execution as evidence the automation works", async () => {
    const r = await triggerService.flowEnableReadiness(wsId, unrunFlowId);
    expect(r.ready).toBe(false);
  });

  it("refuses a flow that has no revision yet", async () => {
    const t = await create(emptyFlowId);
    expect(t.enableReady).toBe(false);
    expect(t.enableBlockedReason).toMatch(/no revision/i);
  });

  it("allows enable after one successful execution", async () => {
    const t = await create(provenFlowId);
    expect(t.enableReady).toBe(true);
    expect(t.enableBlockedReason).toBeNull();
    const updated = await triggerService.update(t.id, { enabled: true });
    expect(updated!.enabled).toBe(true);
  });

  it("always allows disabling, gate or no gate", async () => {
    const t = await create(provenFlowId, { enabled: true });
    const off = await triggerService.update(t.id, { enabled: false });
    expect(off!.enabled).toBe(false);
    const blocked = await create(emptyFlowId);
    await expect(triggerService.update(blocked.id, { enabled: false })).resolves.toBeDefined();
  });

  it("gates creation-as-enabled by the same rule", async () => {
    await expect(create(unrunFlowId, { enabled: true })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reports the bound automation so a trigger card can name what it starts", async () => {
    const t = await create(provenFlowId);
    expect(t.flowId).toBe(provenFlowId);
    expect(t.automationName).toBe("proven");
  });

  /**
   * Gate 2 is reported ALONGSIDE gate 1, never folded into it. A trigger blocked
   * on approval must say "waiting for approval" rather than "not ready", or the
   * Triggers page shows a dead switch with no explanation.
   */
  it("reports the approval block separately from the run-once block", async () => {
    const t = await create(provenFlowId);
    expect(t.enableReady).toBe(true);
    expect(t.approvalBlockedReason).toMatch(/no approved revision/i);
  });
});

describe.skipIf(!reachable)("WS-H0.4 firing", () => {
  it("2. firing a trigger on a flow with no approved revision is refused, and still audited", async () => {
    const t = await create(provenFlowId);
    await expect(triggerService.fire(t.id, "manual")).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });

    // The attempt is still audited — a fire that produced nothing is precisely
    // what someone debugging a silent automation needs to find.
    const fires = await triggerRepo.listFires(t.id);
    expect(fires).toHaveLength(1);
    expect(fires[0].executionId).toBeNull();
  });

  /**
   * GAPS §3.3 — the fire audit trail, and the join that makes it worth reading.
   *
   * "A fire that started nothing still writes a row" is only useful if a reader
   * can tell those rows apart from the ones that DID start something. The
   * obvious column for that — `trigger_fires.execution_id` — is a leftover from
   * the `execution_results` table Phase 4 deleted, and a flow fire always leaves
   * it NULL. A view built on it reports "started nothing" for every fire ever
   * made, including the ones that ran perfectly, which is the most misleading
   * possible answer on the screen someone opens when an automation is silent.
   *
   * The real link runs the other way: `flow_executions.trigger_fire_id`, set by
   * `begin` from the execution's labels. This test is the pair — one fire that
   * started nothing and one that did — because either assertion alone passes
   * against the broken join.
   */
  it("distinguishes a fire that started a run from one that started nothing", async () => {
    const t = await create(provenFlowId);
    await expect(triggerService.fire(t.id, "manual")).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });
    const [refused] = await triggerRepo.listFires(t.id);

    // A second fire, linked to a run the way `begin` links one.
    const linkedFire = await triggerRepo.recordFire({
      triggerId: t.id,
      executionId: null,
      firedBy: "manual",
      payload: { note: "linked" },
    });
    const [execution] = await db
      .insert(flowExecutions)
      .values({
        flowId: provenFlowId,
        workspaceId: wsId,
        flowRevision: 1,
        kestraExecutionId: `gate-fire-${Date.now()}`,
        kestraNamespace: "foundry.gate.test",
        kestraFlowId: "gate-proven",
        triggerFireId: linkedFire.id,
        status: "succeeded",
      })
      .returning();

    const fires = await triggerService.fires(t.id);
    const byId = new Map(fires.map((f) => [f.id, f]));

    expect(byId.get(linkedFire.id)?.flowExecutionId).toBe(execution.id);
    expect(byId.get(linkedFire.id)?.flowExecutionStatus).toBe("succeeded");
    // The control. Without it, a view that linked EVERY fire to the same run
    // would score full marks on the assertion above.
    expect(byId.get(refused.id)?.flowExecutionId).toBeNull();
  });

  /**
   * A webhook body is arbitrary third-party JSON arriving on an unauthenticated
   * public URL, recorded verbatim for the audit trail. It is now also rendered,
   * so it is redacted server-side — the same rule as every other run surface
   * (D-07): redacting in the browser would be theatre, the value having already
   * crossed the wire.
   */
  it("redacts credential-shaped keys out of a recorded fire payload", async () => {
    const t = await create(provenFlowId);
    await triggerRepo.recordFire({
      triggerId: t.id,
      executionId: null,
      firedBy: "webhook",
      payload: { employee: "e-1", api_key: "sk-live-must-not-be-served" },
    });
    const [fire] = await triggerService.fires(t.id);
    const payload = fire.payload as Record<string, unknown>;
    expect(payload.employee).toBe("e-1");
    expect(payload.api_key).not.toBe("sk-live-must-not-be-served");
  });

  it("8. deleting the automation cascades its triggers away", async () => {
    const doomed = await (async () => {
      const [f] = await db
        .insert(flows)
        .values({
          workspaceId: wsId,
          name: "doomed",
          kestraFlowId: `gate-doomed-${Date.now()}`,
          draftRevision: 1,
          status: "draft",
        })
        .returning();
      return f.id;
    })();
    const t = await create(doomed);
    await db.delete(flows).where(eq(flows.id, doomed));
    expect(await triggerRepo.get(t.id)).toBeUndefined();
  });

  it("1. a trigger cannot exist without a binding", async () => {
    // `flow_id` is nullable in the schema — it had to be while `script_id`
    // existed beside it (Phase 3), and dropping `scripts` in 4.11 did not make
    // the column NOT NULL retroactively. So the SERVICE enforces it: an unknown
    // flow is a 404 rather than an orphan row.
    await expect(
      triggerService.createForFlow(wsId, "00000000-0000-0000-0000-000000000000", {
        name: "orphan",
        type: "manual",
        enabled: false,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const all = await db.select().from(triggers).where(eq(triggers.workspaceId, wsId));
    expect(all.every((t) => !!t.flowId)).toBe(true);
  });

  /**
   * §5.4 as a test. A Foundry `schedule` row for a flow would be a second way to
   * fire it on a timer that no approval covers — the exact bypass gate 2 exists
   * to close. The cron lives on the flow MODEL and approval deploys it.
   */
  it("refuses to create a schedule trigger for a flow, and explains why", async () => {
    await expect(create(provenFlowId, { type: "schedule" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

/**
 * Drafting a trigger when the automation is created — ui-upgrade Phase 7.1,
 * D-107.
 *
 * ⚠ **Drafting is not arming, and these tests are the Foundry-side half of
 * that.** The other half is asserted against KESTRA by
 * `kestra:trigger-draft`, because Foundry's row and the engine legitimately
 * disagree and the row is the one that lies (D-13). A test here that read
 * `enabled === false` and stopped would be proving the weaker of the two.
 */
describe.skipIf(!reachable)("Phase 7.1 — a drafted trigger", () => {
  /** A flow whose model declares inputs, one with a default and one without. */
  const mkWithInputs = async (name: string) => {
    const [f] = await db
      .insert(flows)
      .values({
        workspaceId: wsId,
        name,
        kestraFlowId: `draft-${name}-${Date.now()}`,
        draftRevision: 1,
        status: "draft",
      })
      .returning();
    await db.insert(flowRevisions).values({
      flowId: f.id,
      revision: 1,
      modelJson: {
        id: f.kestraFlowId,
        inputs: [
          { id: "period", type: "STRING", required: true },
          { id: "region", type: "STRING", required: true, defaults: "emea" },
          { id: "blank", type: "STRING", defaults: "" },
          { id: "note", type: "STRING" },
        ],
        schedule: { cron: "0 6 * * MON" },
        steps: [{ id: "s1", kind: "transform", expr: "{{ 1 }}" }],
      },
      structureHash: `hash-${Date.now()}-${Math.random()}`,
      compiledYamlHash: `yaml-${Date.now()}-${Math.random()}`,
      createdBy: "test",
      createdByKind: "system",
    });
    return f.id;
  };

  it("creates a disabled MANUAL trigger and a disabled API address, and nothing else", async () => {
    /**
     * ⚠ **THIS ASSERTED ONE ROW UNTIL 2026-09-08, AND THE D-18 PROPERTY IT WAS
     * WRITTEN FOR IS UNCHANGED.** It read *"`manual` and only `manual`"* — but
     * its own comment says what that was guarding: a `schedule` row would be a
     * second way to fire on a timer that no approval covers, which
     * `createForFlow` refuses by name, and drafting must not become the route
     * around it. That is asserted below, by type, and is what still matters.
     *
     * What changed is that a flow now also gets an API ADDRESS at creation,
     * because *"every workflow ever that is published should be able to be
     * called using api"* and an address is a `triggers` row. It routes around
     * nothing: an `api` row is creatable by hand anyway, and this one arrives
     * `enabled: false` so gate 1 still decides whether it can ever fire.
     */
    const flowId = await mkWithInputs("solo");
    const { drafted, skipped } = await triggerService.draftForFlow(wsId, flowId);
    expect(skipped).toBeNull();
    expect(drafted!.type).toBe("manual");
    expect(drafted!.enabled).toBe(false);

    const rows = await triggerRepo.listByFlow(flowId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type).sort()).toEqual(["api", "manual"]);
    // ⚠ THE D-18 PROPERTY, stated as what is forbidden rather than as a count:
    // no timer may be drafted, ever.
    expect(rows.some((r) => r.type === "schedule")).toBe(false);
    expect(rows.some((r) => r.type === "poll")).toBe(false);
    // ⚠ BOTH disabled. Drafting is not arming, and creating the api row
    // enabled would make flow creation the quiet way around gate 1.
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    // The api row has a token, or it is an address that addresses nothing.
    expect(rows.find((r) => r.type === "api")!.webhookToken).toBeTruthy();
    // ⚠ And `webhook` can never be drafted — the type is retired.
    expect(rows.some((r) => r.type === "webhook")).toBe(false);
  });

  it("invents NO value — not for a required input, and not from the plan's default", async () => {
    // ⚠ The load-bearing assertion of D-107. An input the plan does not name a
    // value for is one nobody knows the value of, and writing one anyway is the
    // measured failure this migration exists to fix (`period="2023-10"`, 0 of 11
    // emailed, exit 0) relocated one layer out, where it arrives pre-filled in a
    // box that looks reviewed. A declared default is not copied either — a copy
    // freezes, and an edited default would then disagree with what fires.
    const flowId = await mkWithInputs("empty-config");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);
    const stored = (await triggerRepo.get(drafted!.id))!.config as { inputs?: Record<string, unknown> };
    expect(stored.inputs).toEqual({});
  });

  it("reports who supplies each declared input rather than storing it", async () => {
    const flowId = await mkWithInputs("sources");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);
    const by = Object.fromEntries(drafted!.declaredInputs.map((i) => [i.id, i]));
    expect(by.period).toMatchObject({ source: "none", value: null, required: true });
    expect(by.region).toMatchObject({ source: "plan", value: "emea" });
    expect(by.blank).toMatchObject({ source: "plan", value: "", required: true });
    expect(by.note).toMatchObject({ source: "none", required: true });
  });

  it("warns about a required input nobody supplies — and does NOT block on it", async () => {
    // ⚠ D-108. The third sentence is a WARNING: the failure it describes is loud
    // (Kestra rejects the execution and the fire row is written first), and a
    // third refusal inside `assertEnableAllowed` would change what every harness
    // in the regression net measures.
    const flowId = await mkWithInputs("warned");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);
    expect(drafted!.inputsWarning).toMatch(/"period"/);
    expect(drafted!.inputsWarning).not.toMatch(/region/);
    // The gate that DOES apply is gate 1, and it is unchanged: this flow has
    // never run. The warning is not what is refusing.
    expect(drafted!.enableBlockedReason).toMatch(/never completed a run/i);
  });

  it("reports the model's cron without putting it on the trigger", async () => {
    const flowId = await mkWithInputs("cron");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);
    expect(drafted!.scheduleCron).toBe("0 6 * * MON");
    const stored = (await triggerRepo.get(drafted!.id))!.config as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain("0 6 * * MON");
  });

  it("⚠ drafts nothing on a second call — neither a manual nor a SECOND address", async () => {
    /**
     * ⚠ **TWO IDEMPOTENCIES, BY DIFFERENT KEYS, AND BOTH ARE ASSERTED HERE.**
     * `draftForFlow` guards on "has a non-api trigger" — regeneration, import
     * and template instantiation all reach flow creation and a second thing to
     * arm is one nobody asked for. `ensureApiAddress` guards separately, BY
     * TYPE, because a second api row is a second credential to rotate and a
     * coin flip about which URL somebody pasted.
     *
     * A single count would have caught only one of them, which is why the
     * types are asserted rather than the length alone.
     */
    const flowId = await mkWithInputs("twice");
    await triggerService.draftForFlow(wsId, flowId);
    const second = await triggerService.draftForFlow(wsId, flowId);
    expect(second.drafted).toBeNull();
    expect(second.skipped).toMatch(/already has a trigger/i);
    const rows = await triggerRepo.listByFlow(flowId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.type === "api")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "manual")).toHaveLength(1);
  });

  it("⚠ a flow that has ONLY a manual trigger still gets an address", async () => {
    /**
     * The reported defect, as its own test. `draftForFlow`'s guard returns
     * early when the flow has any trigger — so with the address ensured INSIDE
     * that guard, a flow with a manual trigger would keep getting no api one,
     * for ever, and its API tab would keep saying there is no URL to call it
     * on. The ensure therefore runs BEFORE the guard.
     */
    const flowId = await mkWithInputs("manualonly");
    await triggerRepo.create({
      workspaceId: wsId,
      flowId,
      name: `hand-made ${flowId.slice(0, 8)}`,
      type: "manual",
      config: { inputs: {} },
      enabled: false,
      webhookToken: null,
    });
    const res = await triggerService.draftForFlow(wsId, flowId);
    // It correctly declines to draft a second manual…
    expect(res.drafted).toBeNull();
    // …and an address exists anyway.
    const rows = await triggerRepo.listByFlow(flowId);
    expect(rows.filter((r) => r.type === "api")).toHaveLength(1);
    expect(rows.find((r) => r.type === "api")!.webhookToken).toBeTruthy();
  });

  it("lets a person set a value, and lets them take it back off", async () => {
    // Phase 7.4. Clearing must REMOVE the entry so the input falls back to the
    // plan's own default, where it is authoritative — storing `""` would look
    // like a value on every surface and send one.
    const flowId = await mkWithInputs("editable");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);

    const set = await triggerService.update(drafted!.id, { inputs: { period: "2026-06" } });
    expect(set!.declaredInputs.find((i) => i.id === "period")).toMatchObject({
      source: "trigger",
      value: "2026-06",
    });
    // ⚠ Asserted as "no longer names `period`", NOT as null. This expected the
    // whole warning to clear until 2026-09-02, which was only ever true if
    // `period` were the sole unsupplied required input — and this fixture
    // deliberately also carries a bare `note` to prove Kestra's own
    // `required` default (see "reports who supplies each declared input").
    // Setting one value cannot clear a warning about a different one, so the
    // product was right and the assertion was reading the wrong subject.
    expect(set!.inputsWarning).not.toMatch(/"period"/);
    // The control — the warning is still present and still naming what really
    // is unsupplied, so the assertion above passes by the value being SET
    // rather than by the warning having quietly stopped being produced.
    expect(set!.inputsWarning).toMatch(/"note"/);

    const cleared = await triggerService.update(drafted!.id, { inputs: { period: "" } });
    expect(cleared!.declaredInputs.find((i) => i.id === "period")).toMatchObject({ source: "none" });
    const stored = (await triggerRepo.get(drafted!.id))!.config as { inputs: Record<string, unknown> };
    expect("period" in stored.inputs).toBe(false);
  });

  it("merges an input write instead of replacing the whole config", async () => {
    // ⚠ `config` replaces wholesale. A client sending the whole object back to
    // change one value drops every key it does not know about — `draftedFrom`
    // today, and whatever a later version adds.
    const flowId = await mkWithInputs("merge");
    const { drafted } = await triggerService.draftForFlow(wsId, flowId);
    await triggerService.update(drafted!.id, { inputs: { period: "2026-06" } });
    await triggerService.update(drafted!.id, { inputs: { note: "hello" } });
    const stored = (await triggerRepo.get(drafted!.id))!.config as {
      draftedFrom?: string;
      inputs: Record<string, string>;
    };
    expect(stored.inputs).toEqual({ period: "2026-06", note: "hello" });
    expect(stored.draftedFrom).toBe("plan");
  });
});
