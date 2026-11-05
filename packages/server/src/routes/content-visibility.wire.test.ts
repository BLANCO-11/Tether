import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents, pluginConnections, tools, flowExecutions, flowRevisions, flowStepApprovals, flows, modelPrices, notifications, piChats, usageEvents, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { accessMatrixService } from "../services/access-matrix.service.js";

/**
 * rbac-observability (2026-10-15), measured through the REAL app — permission guard, content guard, routes and SQL:
 *
 *   - a Creator sees their own drafts and every PUBLISHED automation; never somebody else's draft (404, not 403);
 *   - a published automation is everybody's to see and only its owner's (or an Admin's) to change (403);
 *   - a live run of a published automation is everybody's; a test run is its owner's;
 *   - a chat is its owner's — a Reviewer does not see it, an Admin does;
 *   - an Observer reads the published region and builds nothing.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const ALICE = { subject: `oid-cv-alice-${stamp}`, email: `alice-${stamp}@acme-hr.example` };
const BOB = { subject: `oid-cv-bob-${stamp}`, email: `bob-${stamp}@acme-hr.example` };
const ADA = { subject: `oid-cv-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` };
const RITA = { subject: `oid-cv-rita-${stamp}`, email: `rita-${stamp}@acme-hr.example` };
const OLGA = { subject: `oid-cv-olga-${stamp}`, email: `olga-${stamp}@acme-hr.example` };

const ws = await workspaceRepo.create({ name: `content visibility ${stamp}`, tenantSlug: "cvwire", slug: `cvwire-${stamp}` });
const reachable = !!ws;

const MODEL = `priced-model-${stamp}`;
const GH = "@activepieces/piece-github";
const ids = {
  draft: randomUUID(),
  privateOn: randomUUID(),
  published: randomUUID(),
  ownerless: randomUUID(),
  liveRun: randomUUID(),
  testRun: randomUUID(),
  chat: randomUUID(),
  // sharing-boundaries phase 1
  asked: randomUUID(),
  bobChat: randomUUID(),
  pause: randomUUID(),
  viewOnly: randomUUID(),
  // sharing-boundaries phase 3
  ownAccountRun: randomUUID(),
  ownerMode: randomUUID(),
  eachFlow: randomUUID(),
  ownPause: randomUUID(),
  bobGh: randomUUID(),
  ritaGh1: randomUUID(),
  ritaGh2: randomUUID(),
  namedPause: randomUUID(),
};

async function identity(who: { subject: string; email: string }): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

async function call(path: string, as: { subject: string; email: string }, method = "GET", body?: unknown) {
  const res = await fetch(`${base}/api/workspaces/${ws!.id}${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

const flowIds = async (as: { subject: string; email: string }) =>
  (((await call("/flows", as)).body.flows as Array<{ id?: string; flow?: { id: string } }>) ?? []).map((f) => f.id ?? f.flow?.id);
const runIds = async (as: { subject: string; email: string }) =>
  (((await call("/flow-executions", as)).body.executions as Array<{ id: string }>) ?? []).map((r) => r.id);
const chatIds = async (as: { subject: string; email: string }) =>
  (((await call("/pi-builder/chats", as)).body.chats as Array<{ id: string }>) ?? []).map((c) => c.id);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  const w = ws!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: w, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: w, ...BOB, role: "author", grantedBy: "test" },
    { workspaceId: w, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: w, ...RITA, role: "approver", grantedBy: "test" },
    { workspaceId: w, ...OLGA, role: "viewer", grantedBy: "test" },
  ]);
  await db.insert(flows).values([
    { id: ids.draft, workspaceId: w, name: "alice draft", kestraFlowId: `d-${stamp}`, ownerSubject: ALICE.subject },
    { id: ids.published, workspaceId: w, name: "alice published", kestraFlowId: `p-${stamp}`, ownerSubject: ALICE.subject, armedRevision: 1, status: "armed", visibility: "public", othersMayEdit: true },
    // Shared, but view-only (sharing-boundaries phase 2).
    { id: ids.viewOnly, workspaceId: w, name: "alice view-only", kestraFlowId: `v-${stamp}`, ownerSubject: ALICE.subject, visibility: "public", othersMayEdit: false },
    { id: ids.ownerless, workspaceId: w, name: "nobody's", kestraFlowId: `o-${stamp}` },
    // Switched on, and still private (plugins phase 9): approving no longer publishes.
    { id: ids.privateOn, workspaceId: w, name: "alice private, on", kestraFlowId: `po-${stamp}`, ownerSubject: ALICE.subject, armedRevision: 1, status: "approved", visibility: "private" },
    // Private, never live: put in front of reviewers only by its owner asking (sharing-boundaries).
    { id: ids.asked, workspaceId: w, name: "alice asks", kestraFlowId: `a-${stamp}`, ownerSubject: ALICE.subject, draftRevision: 1 },
    // Shared, and its draft runs on Alice's OWN account (sharing-boundaries phase 3).
    { id: ids.ownerMode, workspaceId: w, name: "alice's account", kestraFlowId: `om-${stamp}`, ownerSubject: ALICE.subject, draftRevision: 1, visibility: "public", othersMayEdit: false },
    // Shared, approved, and runs on EACH PERSON's own account: members turn it on for themselves (phase 3).
    { id: ids.eachFlow, workspaceId: w, name: "each person's", kestraFlowId: `ef-${stamp}`, ownerSubject: ALICE.subject, draftRevision: 1, armedRevision: 1, status: "armed", visibility: "public", othersMayEdit: false, runtime: "foundry" },
  ]);
  // A GitHub action switched on for the workspace; Bob has one account of his own, Rita two, Alice none (phase 4).
  await db.insert(tools).values({ workspaceId: w, name: "github_create_issue", url: `plugin://${GH}@0.11.0/create_issue`, secretEnvName: "PLUGIN_GITHUB_TEAM" });
  await db.insert(pluginConnections).values([
    { id: ids.bobGh, workspaceId: w, piece: GH, label: "Bob's", authType: "SECRET_TEXT", secretName: "PLUGIN_GITHUB_ME_B", createdBy: "test", ownerSubject: BOB.subject },
    { id: ids.ritaGh1, workspaceId: w, piece: GH, label: "Rita work", authType: "SECRET_TEXT", secretName: "PLUGIN_GITHUB_ME_R1", createdBy: "test", ownerSubject: RITA.subject },
    { id: ids.ritaGh2, workspaceId: w, piece: GH, label: "Rita home", authType: "SECRET_TEXT", secretName: "PLUGIN_GITHUB_ME_R2", createdBy: "test", ownerSubject: RITA.subject },
  ]);
  const ns = `foundry.cvwire.cvwire-${stamp}`;
  await db.insert(flowExecutions).values([
    { id: ids.liveRun, workspaceId: w, flowId: ids.published, kestraNamespace: ns, kestraFlowId: `p-${stamp}`, kestraExecutionId: `lr-${stamp}` },
    { id: ids.testRun, workspaceId: w, flowId: ids.published, kestraNamespace: `${ns}.draft`, kestraFlowId: `p-${stamp}`, kestraExecutionId: `tr-${stamp}`, requestedBySubject: ALICE.subject },
    // Bob ran Alice's shared workflow on his OWN account (each person): what it did is Bob's.
    { id: ids.ownAccountRun, workspaceId: w, flowId: ids.published, kestraNamespace: ns, kestraFlowId: `p-${stamp}`, kestraExecutionId: `oa-${stamp}`, requestedBySubject: BOB.subject, actsAsSubject: BOB.subject, inputsJson: { repo: "bobs-private-repo" } },
  ]);
  await db.insert(piChats).values([
    { id: ids.chat, workspaceId: w, title: "alice's chat", createdBySubject: ALICE.subject },
    { id: ids.bobChat, workspaceId: w, title: "bob's chat", createdBySubject: BOB.subject, messages: [{ id: "m1", role: "user", text: "hello from bob" }] },
  ]);
  await db.insert(flowRevisions).values([
    { flowId: ids.asked, revision: 1, modelJson: {}, compiledYamlHash: "x", structureHash: "x", createdByKind: "user", createdBy: ALICE.email },
    ...[1, 2].map((revision) => ({
      flowId: ids.eachFlow,
      revision,
      modelJson: { runtime: "foundry", workflow: { steps: [{ id: "open", uses: ["tool:github_create_issue"] }], schedule: { cron: "0 9 * * 1" } }, files: {}, accounts: { [GH]: { connectionId: "", label: "Each person", personal: false, service: "GitHub", each: true } } },
      compiledYamlHash: `e${revision}`,
      structureHash: `e${revision}`,
      createdByKind: "user" as const,
      createdBy: ALICE.email,
    })),
    {
      flowId: ids.ownerMode,
      revision: 1,
      modelJson: { runtime: "foundry", accounts: { gh: { connectionId: randomUUID(), label: "Alice's", personal: true, service: "GitHub" } } },
      compiledYamlHash: "y",
      structureHash: "y",
      createdByKind: "user",
      createdBy: ALICE.email,
    },
  ]);
  // A run of Alice's PUBLISHED automation, paused on a step: who decides it (sharing-boundaries P1-D1/D2).
  await db.insert(flowStepApprovals).values([
    { id: ids.pause, flowExecutionId: ids.liveRun, stepId: "gate", resumeTaskId: "gate_await", summary: "approve the send" },
    // A pause on Bob's run of Alice's workflow on HIS OWN account (P3-I2), and one whose step names Rita (P1-I3).
    { id: ids.ownPause, flowExecutionId: ids.ownAccountRun, stepId: "gate", resumeTaskId: "gate", summary: "approve bob's send" },
    { id: ids.namedPause, flowExecutionId: ids.liveRun, stepId: "gate2", resumeTaskId: "gate2", summary: "rita approves", deciderSubject: RITA.subject },
  ]);
  // Usage: Alice 1M in + 1M out on a priced model (reported cost deliberately WRONG, so the price must win); Bob 2M in
  // on a model with no price (his reported cost must be used as is).
  const hourAgo = new Date(Date.now() - 3600_000);
  await db.insert(modelPrices).values({ model: MODEL, inputPer1m: "2.000000", outputPer1m: "8.000000", effectiveFrom: new Date(Date.now() - 86_400_000) });
  await db.insert(usageEvents).values([
    { workspaceId: w, purpose: "building", kind: "llm", source: "test", subject: ALICE.subject, actor: ALICE.email, model: MODEL, tokensIn: 1_000_000, tokensOut: 1_000_000, costUsd: "999", at: hourAgo },
    { workspaceId: w, purpose: "building", kind: "llm", source: "test", subject: BOB.subject, actor: BOB.email, model: `unpriced-${stamp}`, tokensIn: 2_000_000, tokensOut: 0, costUsd: "3.5", at: hourAgo },
  ]);
});

afterAll(async () => {
  if (reachable) {
    await db.delete(modelPrices).where(eq(modelPrices.model, MODEL));
    await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
  }
  server?.close();
});

describe.skipIf(!reachable)("the private and published regions, at the wire", () => {
  it("CONTROL: the owner sees all of their own work — without it, 'nobody sees anything' passes every refusal below", async () => {
    expect(await flowIds(ALICE)).toEqual(expect.arrayContaining([ids.draft, ids.published]));
    expect(await runIds(ALICE)).toEqual(expect.arrayContaining([ids.liveRun, ids.testRun]));
    expect(await chatIds(ALICE)).toEqual([ids.chat]);
    expect((await call(`/flows/${ids.draft}`, ALICE)).status).toBe(200);
  });

  it("another Creator sees the published automation and not the draft — and the draft is a 404, not a 403", async () => {
    const seen = await flowIds(BOB);
    expect(seen).toContain(ids.published);
    expect(seen).not.toContain(ids.draft);
    expect(seen).not.toContain(ids.ownerless);
    expect((await call(`/flows/${ids.draft}`, BOB)).status).toBe(404);
    expect((await call(`/flows/${ids.published}`, BOB)).status).toBe(200);
  });

  it("⚠ switched on is not published: a private automation that runs is still only its owner's to see (phase 9)", async () => {
    expect(await flowIds(ALICE)).toContain(ids.privateOn);
    expect(await flowIds(BOB)).not.toContain(ids.privateOn);
    expect((await call(`/flows/${ids.privateOn}`, BOB)).status).toBe(404);
    expect(await flowIds(RITA)).toContain(ids.privateOn);
  });

  it("its owner moves it to the Workspace and back; nobody else may, and an unknown place is refused (phase 9 → 7)", async () => {
    expect((await call(`/flows/${ids.privateOn}/move`, BOB, "POST", { to: "workspace" })).status).toBe(404);
    expect((await call(`/flows/${ids.privateOn}/move`, ALICE, "POST", { to: "everyone" })).status).toBe(400);
    expect((await call(`/flows/${ids.privateOn}/move`, ALICE, "POST", { to: "workspace" })).status).toBe(200);
    expect(await flowIds(BOB)).toContain(ids.privateOn);
    expect((await call(`/flows/${ids.privateOn}/move`, BOB, "POST", { to: "mine" })).status).toBe(403);
    expect((await call(`/flows/${ids.privateOn}/move`, ALICE, "POST", { to: "mine" })).status).toBe(200);
    expect(await flowIds(BOB)).not.toContain(ids.privateOn);
  });

  it("⚠ the old public/private switch is refused, pointing at Move — never silently ignored (phase 7, P7-D1)", async () => {
    const r = await call(`/flows/${ids.privateOn}/visibility`, ALICE, "PUT", { visibility: "public" });
    expect([r.status, r.body.error]).toEqual([409, "use_move"]);
    expect(await flowIds(BOB)).not.toContain(ids.privateOn);
    const c = await call(`/pi-builder/chats/${ids.bobChat}`, BOB, "PATCH", { visibility: "public" });
    expect([c.status, c.body.error]).toEqual([409, "use_move"]);
    expect(await chatIds(ALICE)).not.toContain(ids.bobChat);
  });

  it("⚠ a shared workflow is editable by members unless view-only; managing it stays its owner's (phase 2)", async () => {
    // editable: Bob edits it
    expect((await call(`/flows/${ids.published}`, BOB, "PATCH", { description: "edited by bob" })).status).toBe(200);
    // view-only: Bob may not
    expect((await call(`/flows/${ids.viewOnly}`, BOB, "PATCH", { description: "x" })).status).toBe(403);
    // an Observer never edits
    expect((await call(`/flows/${ids.published}`, OLGA, "PATCH", { description: "x" })).status).toBe(403);
    // managing is the owner's, whoever may edit: delete, moving it, view-only, ask for approval
    for (const [path, method, body] of [
      [`/flows/${ids.published}`, "DELETE", undefined],
      [`/flows/${ids.published}/move`, "POST", { to: "mine" }],
      [`/flows/${ids.published}/visibility`, "PUT", { othersMayEdit: false }],
      [`/flows/${ids.published}/review-request`, "POST", {}],
    ] as const) {
      const r = await call(path, BOB, method, body);
      expect([path, method, r.status, r.body.error]).toEqual([path, method, 403, "owner_only"]);
    }
    // duplicating needs only to SEE it — a view-only workflow is what somebody copies to build on
    const dup = await call(`/flows/${ids.viewOnly}/duplicate`, BOB, "POST", {});
    expect([403, 404]).not.toContain(dup.status);
    // its owner makes it view-only; then Bob's edit is refused
    expect((await call(`/flows/${ids.published}/visibility`, ALICE, "PUT", { othersMayEdit: false })).status).toBe(200);
    expect((await call(`/flows/${ids.published}`, BOB, "PATCH", { description: "again" })).status).toBe(403);
  });

  it("⚠ a run on one person's own account: others who see it see its status only — nothing it did (phase 3)", async () => {
    const detail = async (as: { subject: string; email: string }) => (await call(`/flow-executions/${ids.ownAccountRun}`, as)).body;
    // CONTROL: the person whose account it was sees what it did — without it, "hide everything" passes.
    expect((await detail(BOB)).inputs).toEqual({ repo: "bobs-private-repo" });
    expect((await detail(ADA)).inputs).toEqual({ repo: "bobs-private-repo" });
    for (const who of [ALICE, RITA, OLGA]) {
      const d = await detail(who);
      expect([who.email, d.dataHidden, d.inputs, d.steps]).toEqual([who.email, true, {}, []]);
      expect([who.email, (await call(`/flow-executions/${ids.ownAccountRun}/emails`, who)).status]).toEqual([who.email, 403]);
    }
    const listed = ((await call("/flow-executions", ALICE)).body.executions as Array<{ id: string; inputs: unknown; dataHidden?: boolean }>).find((r) => r.id === ids.ownAccountRun);
    expect(listed).toMatchObject({ inputs: {}, dataHidden: true });
  });

  it("⚠ a shared workflow is every member's to RUN live, even view-only; a private one is not (phase 3)", async () => {
    const run = async (flowId: string, as: { subject: string; email: string }) => (await call(`/flows/${flowId}/run`, as, "POST", {})).status;
    // Past the guard: whatever the runner then says (not approved, not configured) is not a refusal of the person.
    expect([403, 404]).not.toContain(await run(ids.viewOnly, BOB));
    expect(await run(ids.draft, BOB)).toBe(404);
    // CONTROL: test-running the same view-only workflow is still its owner's (editing).
    expect((await call(`/flows/${ids.viewOnly}/test-run`, BOB, "POST", {})).status).toBe(403);
  });

  it("⚠ a workflow that runs on its owner's own account cannot be made editable by others (phase 3)", async () => {
    const r = await call(`/flows/${ids.ownerMode}/visibility`, ALICE, "PUT", { othersMayEdit: true });
    expect([r.status, r.body.error]).toEqual([409, "runs_as_owner"]);
    // CONTROL: one that does not may.
    expect((await call(`/flows/${ids.viewOnly}/visibility`, ALICE, "PUT", { othersMayEdit: true })).status).toBe(200);
    await call(`/flows/${ids.viewOnly}/visibility`, ALICE, "PUT", { othersMayEdit: false });
  });

  it("⚠ Turn on for me: a member turns a shared each-person workflow on for THEMSELVES; a change pauses it and tells them (phase 3)", async () => {
    const act = (as: { subject: string; email: string }, body?: unknown) =>
      body === undefined ? call(`/flows/${ids.eachFlow}/activation`, as) : call(`/flows/${ids.eachFlow}/activation`, as, "PUT", body);
    expect((await act(BOB)).body).toMatchObject({ available: true, on: false, schedule: { cron: "0 9 * * 1" } });
    expect((await act(BOB, { on: true })).body).toMatchObject({ on: true, paused: null });
    // Bob's, nobody else's.
    expect((await act(ALICE)).body).toMatchObject({ on: false });
    // An Observer runs nothing; one that does not run on each person's account is its owner's to switch on.
    expect((await act(OLGA, { on: true })).status).toBe(403);
    expect((await call(`/flows/${ids.viewOnly}/activation`, BOB, "PUT", { on: true })).status).toBe(409);
    const { flowActivationService } = await import("../services/flow-activation.service.js");
    expect((await flowActivationService.running()).filter((a) => a.flowId === ids.eachFlow).map((a) => a.subject)).toEqual([BOB.subject]);
    // The schedule tick at its minute (Monday 09:00 UTC) starts Bob's copy AS BOB, and never one with nobody behind it.
    // The start itself is stubbed: this asserts who the tick asks to run, and runs nothing.
    const { flowRunnerService } = await import("../services/flow-runner.service.js");
    const spy = vi.spyOn(flowRunnerService, "startLiveRun").mockResolvedValue({ flowExecutionId: "x", revision: 1 });
    try {
      await flowRunnerService.tickSchedules(new Date("2026-11-02T09:00:30Z"));
      const forThis = spy.mock.calls.map((c) => c[0]).filter((c) => c.flowId === ids.eachFlow);
      expect(forThis.map((c) => c.requester)).toEqual([{ subject: BOB.subject, actor: BOB.email, kind: "schedule" }]);
    } finally {
      spy.mockRestore();
    }
    // A reviewer approves version 2: Bob's copy stops, and he is told.
    await db.update(flows).set({ armedRevision: 2 }).where(eq(flows.id, ids.eachFlow));
    await flowActivationService.noteApproved(ws!.id, ids.eachFlow, 2, "each person's");
    expect((await flowActivationService.running()).filter((a) => a.flowId === ids.eachFlow)).toEqual([]);
    expect((await act(BOB)).body).toMatchObject({ on: true, paused: expect.stringMatching(/changed since you turned it on/) });
    const told = await db.select().from(notifications).where(and(eq(notifications.workspaceId, ws!.id), eq(notifications.subject, BOB.subject), eq(notifications.kind, "activation_paused")));
    expect(told).toHaveLength(1);
    // Looking again and turning it on confirms the new version.
    expect((await act(BOB, { on: true })).body).toMatchObject({ on: true, paused: null });
    expect((await act(BOB, { on: false })).body).toMatchObject({ on: false });
  });

  it("⚠ readiness: what it needs from THIS person, who fixes it — and a live run refused before it exists (phase 4)", async () => {
    const ready = async (who: typeof ALICE) => (await call(`/flows/${ids.eachFlow}/readiness`, who)).body as { ready: boolean; needs: Array<{ cause: string; fixBy: string; options?: Array<{ connectionId: string }> }> };
    expect(await ready(BOB)).toMatchObject({ ready: true, needs: [] });
    expect(await ready(ALICE)).toMatchObject({ ready: false, needs: [{ cause: "not_connected", fixBy: "you" }] });
    const rita = await ready(RITA);
    expect(rita.needs.map((n) => [n.cause, n.options?.length])).toEqual([["choose_account", 2]]);
    // Only one of HER accounts can be chosen; then she is ready.
    expect((await call(`/flows/${ids.eachFlow}/my-account`, RITA, "PUT", { piece: GH, connectionId: ids.bobGh })).status).toBe(403);
    expect((await call(`/flows/${ids.eachFlow}/my-account`, RITA, "PUT", { piece: GH, connectionId: ids.ritaGh2 })).body).toMatchObject({ ready: true });
    // Alice is refused BEFORE a run exists, told what is missing; turning it on is refused the same way.
    const before = (await db.select().from(flowExecutions).where(eq(flowExecutions.flowId, ids.eachFlow))).length;
    // The approval gate (its own tests) is stubbed to pass: what is under test is the check AFTER it, before a run exists.
    const { flowApprovalService } = await import("../services/flow-approval.service.js");
    const gate = vi.spyOn(flowApprovalService, "assertMayRunLive").mockImplementation(async (_w, f) => f.armedRevision!);
    let run: Awaited<ReturnType<typeof call>>;
    try {
      run = await call(`/flows/${ids.eachFlow}/run`, ALICE, "POST", {});
    } finally {
      gate.mockRestore();
    }
    expect([run.status, (run.body.needs as Array<{ cause: string }>)?.[0]?.cause]).toEqual([409, "not_connected"]);
    expect((await db.select().from(flowExecutions).where(eq(flowExecutions.flowId, ids.eachFlow))).length).toBe(before);
    const on = await call(`/flows/${ids.eachFlow}/activation`, ALICE, "PUT", { on: true });
    expect([on.status, (on.body.needs as Array<{ cause: string }>)?.[0]?.cause]).toEqual([409, "not_connected"]);
  });

  it("⚠ a schedule refused three times in a row is stopped, and its person told (phase 4)", async () => {
    const { scheduleRefused } = await import("../services/flow-runner.service.js");
    const { flowActivationService } = await import("../services/flow-activation.service.js");
    await db.update(flows).set({ armedRevision: 2 }).where(eq(flows.id, ids.eachFlow));
    await flowActivationService.set(ws!.id, ids.eachFlow, { subject: BOB.subject, actor: BOB.email }, { on: true });
    const r = { key: `t-${stamp}`, workspaceId: ws!.id, flowId: ids.eachFlow, flowName: "each person's", person: BOB.subject };
    const refused = Object.assign(new Error("it cannot run yet: x"), { statusCode: 409 });
    // A busy workspace is not counted; two refusals are not enough.
    expect(await scheduleRefused(r, Object.assign(new Error("busy"), { statusCode: 429 }))).toBe(false);
    expect(await scheduleRefused(r, refused)).toBe(false);
    expect(await scheduleRefused(r, refused)).toBe(false);
    expect(await scheduleRefused(r, refused)).toBe(true);
    expect((await flowActivationService.view(ws!.id, ids.eachFlow, BOB.subject))!.on).toBe(false);
    const told = await db.select().from(notifications).where(and(eq(notifications.workspaceId, ws!.id), eq(notifications.subject, BOB.subject), eq(notifications.kind, "schedule_stopped")));
    expect(told).toHaveLength(1);
  });

  it("another Creator sees the live run of a published automation, not its test run", async () => {
    const seen = await runIds(BOB);
    expect(seen).toContain(ids.liveRun);
    expect(seen).not.toContain(ids.testRun);
    expect((await call(`/flow-executions/${ids.testRun}`, BOB)).status).toBe(404);
  });

  it("a chat is private: not another Creator, not a Reviewer — an Admin, yes", async () => {
    expect(await chatIds(BOB)).not.toContain(ids.chat);
    expect(await chatIds(RITA)).toEqual([]);
    expect(await chatIds(ADA)).toEqual(expect.arrayContaining([ids.chat, ids.bobChat]));
    expect((await call(`/pi-builder/chats/${ids.chat}`, BOB, "PATCH", { title: "x" })).status).toBe(404);
  });

  it("an Admin sees every automation and every run", async () => {
    expect(await flowIds(ADA)).toEqual(expect.arrayContaining([ids.draft, ids.published, ids.ownerless, ids.asked]));
    expect(await runIds(ADA)).toEqual(expect.arrayContaining([ids.liveRun, ids.testRun]));
  });

  it("⚠ a Reviewer sees what was put in front of them — public, live, or asked for — never a private draft (sharing-boundaries)", async () => {
    const seen = await flowIds(RITA);
    expect(seen).toEqual(expect.arrayContaining([ids.published, ids.privateOn]));
    expect(seen).not.toContain(ids.draft);
    expect(seen).not.toContain(ids.ownerless);
    expect(seen).not.toContain(ids.asked);
    expect((await call(`/flows/${ids.asked}`, RITA)).status).toBe(404);
    // every run of what they may see, test runs included
    expect(await runIds(RITA)).toEqual(expect.arrayContaining([ids.liveRun, ids.testRun]));
  });

  it("⚠ its owner asks for approval: now a Reviewer sees it and it is Awaiting; withdrawing hides it again; nobody else may ask", async () => {
    expect((await call(`/flows/${ids.asked}/review-request`, BOB, "POST", {})).status).toBe(404);
    const asked = await call(`/flows/${ids.asked}/review-request`, ALICE, "POST", {});
    expect(asked.status).toBe(200);
    expect((asked.body.flow as { reviewRequestedRevision: number }).reviewRequestedRevision).toBe(1);
    expect(await flowIds(RITA)).toContain(ids.asked);
    expect((await call(`/flows/${ids.asked}`, RITA)).status).toBe(200);
    expect(await flowIds(BOB)).not.toContain(ids.asked); // asking is for reviewers, not the workspace
    expect((await call(`/flows/${ids.asked}/review-request`, ALICE, "DELETE")).status).toBe(200);
    expect(await flowIds(RITA)).not.toContain(ids.asked);
  });

  it("⚠ a private workflow cannot be copied into the shared template library by anybody but its owner (P0-I4)", async () => {
    // Only the Admin preset holds `templates.write`, and an Admin can see the draft: the refusal must be THIS rule's, not
    // the permission guard's — so it is asserted by its sentence. Seeing is not leave to publish for its owner.
    const r = await call("/flow-templates", ADA, "POST", { flowId: ids.draft, name: `t-${stamp}` });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/Only its owner can save a workflow in their My space as a template/);
  });

  it("⚠ fragment candidates answer for a Creator without reading others' private workflows (P0-I5)", async () => {
    expect((await call("/fragment-candidates", BOB)).status).toBe(200);
  });

  it("⚠ the workflow's OWNER decides its run's pause — not a Reviewer, not an Admin (P1-D1/D2)", async () => {
    // The inbox lists it for the owner only.
    const inbox = async (who: typeof ALICE) => (((await call("/step-approvals", who)).body.approvals as Array<{ id: string }>) ?? []).map((a) => a.id);
    expect(await inbox(ALICE)).toContain(ids.pause);
    expect(await inbox(RITA)).not.toContain(ids.pause);
    expect(await inbox(ADA)).not.toContain(ids.pause);
    for (const who of [RITA, ADA, BOB]) {
      const r = await call(`/step-approvals/${ids.pause}/decide`, who, "POST", { decision: "approved" });
      expect([r.status, r.body.error]).toEqual([403, "not_the_decider"]);
    }
    // The owner gets past who-decides (whatever delivering the decision then does, it is not that refusal).
    const own = await call(`/step-approvals/${ids.pause}/decide`, ALICE, "POST", { decision: "approved" });
    expect(own.body.error).not.toBe("not_the_decider");
    expect(own.body.error).not.toBe("self_decision");
  });

  it("⚠ a run on someone's own account is THEIR pause to decide; a step that names a member is theirs too (P3-I2, P1-I3)", async () => {
    const inbox = async (who: typeof ALICE) => (((await call("/step-approvals", who)).body.approvals as Array<{ id: string }>) ?? []).map((a) => a.id);
    const decide = async (id: string, who: typeof ALICE) => (await call(`/step-approvals/${id}/decide`, who, "POST", { decision: "rejected" })).body.error;
    expect(await inbox(BOB)).toContain(ids.ownPause);
    expect(await inbox(ALICE)).not.toContain(ids.ownPause);
    expect(await decide(ids.ownPause, ALICE)).toBe("not_the_decider");
    expect(await decide(ids.ownPause, BOB)).not.toBe("not_the_decider");
    expect(await inbox(RITA)).toContain(ids.namedPause);
    expect(await inbox(RITA)).not.toContain(ids.pause);
    expect(await decide(ids.namedPause, BOB)).toBe("not_the_decider");
    expect(await decide(ids.namedPause, RITA)).not.toBe("not_the_decider");
  });

  it("⚠ a chat shared with the workspace is shared to READ (P1-D8)", async () => {
    expect(await chatIds(ALICE)).not.toContain(ids.bobChat);
    expect((await call(`/pi-builder/chats/${ids.bobChat}/move`, ALICE, "POST", { to: "workspace" })).status).toBe(404);
    expect((await call(`/pi-builder/chats/${ids.bobChat}/move`, BOB, "POST", { to: "workspace" })).status).toBe(200);
    const listed = ((await call("/pi-builder/chats", ALICE)).body.chats as Array<{ id: string; canChange: boolean; canDelete: boolean }>).find((c) => c.id === ids.bobChat);
    expect(listed).toMatchObject({ canChange: false, canDelete: false });
    const read = await call(`/pi-builder/chats/${ids.bobChat}`, ALICE);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ mine: false, canChange: false });
    expect(JSON.stringify(read.body)).toContain("hello from bob");
    // Reading is not driving: rename, delete and continue are refused.
    expect((await call(`/pi-builder/chats/${ids.bobChat}`, ALICE, "PATCH", { title: "mine now" })).status).toBe(403);
    expect((await call(`/pi-builder/chats/${ids.bobChat}`, ALICE, "DELETE")).status).toBe(403);
    const cont = await call("/pi-builder/sessions", ALICE, "POST", { chatId: ids.bobChat });
    expect([cont.status, cont.body.error]).toEqual([403, "read_only"]);
    // Private again: gone from Alice.
    expect((await call(`/pi-builder/chats/${ids.bobChat}/move`, BOB, "POST", { to: "mine" })).status).toBe(200);
    expect((await call(`/pi-builder/chats/${ids.bobChat}`, ALICE)).status).toBe(404);
  });

  it("an Observer reads the published region and can build nothing", async () => {
    const seen = await flowIds(OLGA);
    expect(seen).toContain(ids.published);
    expect(seen).not.toContain(ids.draft);
    expect((await call("/flows", OLGA, "POST", { name: "nope" })).status).toBe(403);
    expect(await chatIds(OLGA)).toEqual([]);
  });

  it("usage and cost: a Creator sees only their own; an Admin sees everyone's, by person; a set price wins", async () => {
    type Summary = { scope: string; costUsd: number; byPerson: Array<{ subject: string; costUsd: number }> };
    const bob = (await call("/observability", BOB)).body as unknown as Summary;
    expect(bob.scope).toBe("mine");
    expect(bob.byPerson.map((p) => p.subject)).toEqual([BOB.subject]);
    expect(bob.costUsd).toBeCloseTo(3.5, 6); // no price set: the reported cost

    const alice = (await call("/observability", ALICE)).body as unknown as Summary;
    expect(alice.costUsd).toBeCloseTo(10, 6); // 1M × $2 + 1M × $8 — not the reported $999

    const ada = (await call("/observability", ADA)).body as unknown as Summary;
    expect(ada.scope).toBe("workspace");
    expect(ada.byPerson.map((p) => p.subject).sort()).toEqual([ALICE.subject, BOB.subject].sort());
    expect(ada.costUsd).toBeCloseTo(13.5, 6);
    // An Admin can still ask for just their own.
    expect(((await call("/observability?scope=mine", ADA)).body as unknown as Summary).byPerson).toEqual([]);
  });

  it("an Admin opening somebody else's chat leaves ONE audit line; a published read, or a Reviewer's look at a draft, leaves none", async () => {
    const lines = () =>
      // Content reads only — a refused request is audited too (entity `member`), and that is a different record.
      db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, ws!.id), eq(auditEvents.operation, "access"), inArray(auditEvents.entity, ["flow", "chat", "run"])));
    expect((await call(`/flows/${ids.published}`, BOB)).status).toBe(200);
    // A published read leaves nothing.
    expect((await lines()).map((l) => [l.actor, l.entity, l.description])).toEqual([]);
    // ⚠ sharing-boundaries: a Reviewer no longer reads a private draft, so an Admin's look at one IS a look at private
    // work — logged, and its owner is told (a stored notice, Q1).
    expect((await call(`/flows/${ids.draft}`, ADA)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await lines()).map((l) => [l.actor, l.entity, l.entityId])).toEqual([[ADA.email, "flow", ids.draft]]);
    const told = await db.select().from(notifications).where(and(eq(notifications.workspaceId, ws!.id), eq(notifications.subject, ALICE.subject)));
    expect(told.map((n) => [n.kind, n.href])).toEqual([["admin_viewed", `/flows/${ids.draft}`]]);
    // and through the route, to the owner only
    expect(((await call("/notifications", ALICE)).body.notifications as unknown[]).length).toBe(1);
    expect(((await call("/notifications", ADA)).body.notifications as unknown[]).length).toBe(0);
    // A chat is visible ONLY through `content.read.others`: that look is the one the record exists for.
    const file = `/pi-builder/chats/${ids.chat}/files/none.txt`;
    expect((await call(file, ADA)).status).toBe(404); // no such file — but the chat itself was opened
    expect((await call(file, ADA)).status).toBe(404); // a second look within ten minutes is not a second line
    await new Promise((r) => setTimeout(r, 200)); // the record is written after the response
    expect((await lines()).filter((l) => l.entity === "chat").map((l) => [l.actor, l.entity, l.entityId])).toEqual([[ADA.email, "chat", ids.chat]]);
  });

  it("the workflow page says whose it is and what this person may do; an Admin moves an automation to another member", async () => {
    type Detail = { flow: { ownerName: string | null }; canChange: boolean; canChangeOwner: boolean };
    const detail = async (id: string, as: typeof ALICE) => (await call(`/flows/${id}`, as)).body as unknown as Detail;
    const mine = async (as: typeof ALICE) =>
      Object.fromEntries((((await call("/flows", as)).body.flows as Array<{ id: string; mine: boolean }>) ?? []).map((f) => [f.id, f.mine]));
    // Whose, and Mine — the server's answer, per person asking.
    expect((await detail(ids.published, BOB)).flow.ownerName).toBe(ALICE.email);
    expect((await mine(ALICE))[ids.draft]).toBe(true);
    expect((await mine(BOB))[ids.published]).toBe(false);
    // What each may do with it.
    expect(await detail(ids.draft, ALICE)).toMatchObject({ canChange: true, canChangeOwner: false });
    expect(await detail(ids.viewOnly, BOB)).toMatchObject({ canChange: false, canManage: false, canChangeOwner: false });
    expect(await detail(ids.published, OLGA)).toMatchObject({ canChange: false, canChangeOwner: false });
    expect(await detail(ids.published, ADA)).toMatchObject({ canChange: true, canManage: true, canChangeOwner: true });
    // Only an Admin moves it; never to an Observer or a stranger.
    expect((await call(`/flows/${ids.ownerless}/owner`, BOB, "PUT", { subject: BOB.subject })).status).toBe(403);
    expect((await call(`/flows/${ids.ownerless}/owner`, ADA, "PUT", { subject: OLGA.subject })).status).toBe(400);
    expect((await call(`/flows/${ids.ownerless}/owner`, ADA, "PUT", { subject: "oid-nobody-here" })).status).toBe(400);
    expect(await flowIds(BOB)).not.toContain(ids.ownerless);
    const moved = await call(`/flows/${ids.ownerless}/owner`, ADA, "PUT", { subject: BOB.subject });
    expect(moved.status).toBe(200);
    expect((moved.body.flow as { ownerName: string }).ownerName).toBe(BOB.email);
    expect(await flowIds(BOB)).toContain(ids.ownerless);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, ws!.id), eq(auditEvents.operation, "update"), eq(auditEvents.entity, "flow")));
    // The owner change is recorded; the visibility changes above are recorded too, each against its own automation.
    expect(audit.filter((a) => !([ids.privateOn, ids.asked, ids.published, ids.viewOnly, ids.eachFlow] as string[]).includes(a.entityId ?? "")).map((a) => a.entityId)).toEqual([ids.ownerless]);
    // its owner making it view-only is recorded (phase 2)
    expect(audit.filter((a) => a.entityId === ids.published && /view-only/.test(a.description ?? ""))).toHaveLength(1);
    expect(audit.filter((a) => a.entityId === ids.privateOn)).toHaveLength(2);
    // asking for approval and withdrawing it are recorded too (sharing-boundaries)
    expect(audit.filter((a) => a.entityId === ids.asked)).toHaveLength(2);
  });

  it("who can see what: each person's reach in this workspace is their role's, and a Creator may not read the grid", async () => {
    const res = await fetch(`${base}/api/platform/access`, {
      headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(ALICE) },
    });
    expect(res.status).toBe(403);
    const grid = await accessMatrixService.build();
    const reach = (who: typeof ALICE) => grid.people.find((p) => p.subject === who.subject)?.cells[ws!.id];
    expect(reach(OLGA)).toMatchObject({ reach: "published", via: ["Observer"], cost: "own" });
    expect(reach(ALICE)).toMatchObject({ reach: "own", via: ["Creator"] });
    expect(reach(RITA)).toMatchObject({ reach: "review", via: ["Reviewer"] });
    expect(reach(ADA)).toMatchObject({ reach: "everything", via: ["Admin"], cost: "everyone", managesPeople: true });
  });
});
