import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flowRevisions, flows, platformUsers, triggerFires, triggers, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * The dashboard's "Runs and health" (2026-10-23), through the REAL app: the figures count live and test runs apart,
 * partly done is its own outcome, "Mine / Everyone" is a choice only for those who see beyond their own work, and
 * every run says what started it.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const ALICE = { subject: `oid-rh-alice-${stamp}`, email: `alice-${stamp}@acme-hr.example`, name: "Alice Example" };
const BOB = { subject: `oid-rh-bob-${stamp}`, email: `bob-${stamp}@acme-hr.example` };
const ADA = { subject: `oid-rh-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` };

const ws = await workspaceRepo.create({ name: `runs health ${stamp}`, tenantSlug: "rhwire", slug: `rhwire-${stamp}` });
const reachable = !!ws;

const ids = { published: randomUUID(), bobs: randomUUID(), scheduled: randomUUID(), partial: randomUUID(), failed: randomUUID(), hooked: randomUUID(), forgeTest: randomUUID(), trigger: randomUUID(), fire: randomUUID() };

async function identity(who: { subject: string; email: string; name?: string }): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.name ?? who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

type Summary = {
  scope: string;
  choosesScope: boolean;
  env: string;
  health: { current: { runs: number; succeeded: number; failed: number; partial: number; settled: number }; failedAutomations: number };
  recent: Array<{ id: string; startedBy: { kind: string; label: string; detail: string | null; cron?: string | null } }>;
};

async function summary(as: { subject: string; email: string; name?: string }, q: string): Promise<Summary> {
  const res = await fetch(`${base}/api/workspaces/${ws!.id}/flow-executions?view=summary&${q}`, {
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as) },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  const w = ws!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: w, subject: ALICE.subject, email: ALICE.email, role: "author", grantedBy: "test" },
    { workspaceId: w, ...BOB, role: "author", grantedBy: "test" },
    { workspaceId: w, ...ADA, role: "admin", grantedBy: "test" },
  ]);
  await db.insert(platformUsers).values({ subject: ALICE.subject, email: ALICE.email, name: ALICE.name }).onConflictDoNothing();
  await db.insert(flows).values([
    { id: ids.published, workspaceId: w, name: "Invoice chase", kestraFlowId: `p-${stamp}`, ownerSubject: ALICE.subject, armedRevision: 1, status: "armed" },
    { id: ids.bobs, workspaceId: w, name: "Bob's draft", kestraFlowId: `b-${stamp}`, ownerSubject: BOB.subject },
  ]);
  await db.insert(flowRevisions).values({
    flowId: ids.published,
    revision: 1,
    modelJson: { workflow: { schedule: { cron: "0 9 * * 1-5" } } },
    compiledYamlHash: "sha256:x",
    structureHash: "sha256:x",
    createdByKind: "system",
  });
  await db.insert(triggers).values({ id: ids.trigger, workspaceId: w, flowId: ids.published, name: "expenses-in", type: "webhook" });
  await db.insert(triggerFires).values({ id: ids.fire, triggerId: ids.trigger, firedBy: "webhook" });
  const ns = `foundry.rhwire.rhwire-${stamp}`;
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000);
  const base_ = { workspaceId: w, kestraFlowId: `p-${stamp}` };
  await db.insert(flowExecutions).values([
    { ...base_, id: ids.scheduled, flowId: ids.published, flowRevision: 1, kestraNamespace: ns, kestraExecutionId: `fr-s-${stamp}`, status: "succeeded", requestedByKind: "schedule", startedAt: at(50), endedAt: at(49) },
    { ...base_, id: ids.partial, flowId: ids.published, kestraNamespace: ns, kestraExecutionId: `fr-p-${stamp}`, status: "partial", requestedBy: ALICE.email, requestedBySubject: ALICE.subject, requestedByKind: "user", startedAt: at(40), endedAt: at(39) },
    { ...base_, id: ids.hooked, flowId: ids.published, kestraNamespace: ns, kestraExecutionId: `fr-h-${stamp}`, status: "succeeded", requestedBy: "trigger:expenses-in", requestedByKind: "trigger", triggerFireId: ids.fire, startedAt: at(30), endedAt: at(29) },
    // Bob's own run of his unpublished automation: Alice must not see it, and it is the one failure.
    { ...base_, id: ids.failed, flowId: ids.bobs, kestraFlowId: `b-${stamp}`, kestraNamespace: ns, kestraExecutionId: `fr-f-${stamp}`, status: "failed", requestedBy: BOB.email, requestedBySubject: BOB.subject, requestedByKind: "user", startedAt: at(20), endedAt: at(19) },
    { ...base_, id: ids.forgeTest, flowId: ids.published, kestraNamespace: `${ns}.draft`, kestraExecutionId: `fr-t-${stamp}`, status: "succeeded", requestedBy: "system", requestedByKind: "system", autoTest: true, startedAt: at(10), endedAt: at(9) },
  ]);
});

afterAll(async () => {
  if (reachable) {
    await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
    await db.delete(platformUsers).where(eq(platformUsers.subject, ALICE.subject));
  }
  server?.close();
});

describe.skipIf(!reachable)("Runs and health, at the wire", () => {
  it("an Admin sees every live run, with partly done counted apart from success and failure", async () => {
    const s = await summary(ADA, "range=7d&env=live");
    expect(s.choosesScope).toBe(true);
    expect(s.scope).toBe("everyone");
    expect(s.health.current).toMatchObject({ runs: 4, settled: 4, succeeded: 2, failed: 1, partial: 1 });
    expect(s.health.failedAutomations).toBe(1);
    expect(s.recent.map((r) => r.id)).not.toContain(ids.forgeTest);
  });

  it("test runs are only the draft namespace — Forge's own tests included", async () => {
    const s = await summary(ADA, "range=7d&env=test");
    expect(s.recent.map((r) => r.id)).toEqual([ids.forgeTest]);
    expect(s.recent[0]!.startedBy).toEqual({ kind: "test", label: "Forge", detail: "test after a build" });
  });

  it("'Mine' narrows an Admin to their own runs — Ada started none and owns none", async () => {
    const s = await summary(ADA, "range=7d&env=live&scope=mine");
    expect(s.scope).toBe("mine");
    expect(s.health.current.runs).toBe(0);
  });

  it("a Creator gets no choice, and never sees another Creator's private run", async () => {
    const s = await summary(ALICE, "range=7d&env=live&scope=mine");
    expect(s.choosesScope).toBe(false);
    expect(s.scope).toBe("everyone");
    expect(s.recent.map((r) => r.id)).not.toContain(ids.failed);
    expect(s.health.current.failed).toBe(0);
  });

  it("every run says what started it: a person by name, a schedule with its cron, a trigger by kind and name", async () => {
    const by = new Map((await summary(ADA, "range=7d&env=live")).recent.map((r) => [r.id, r.startedBy]));
    expect(by.get(ids.partial)).toEqual({ kind: "person", label: "Alice Example", detail: "manual" });
    expect(by.get(ids.scheduled)).toEqual({ kind: "schedule", label: "Schedule", detail: null, cron: "0 9 * * 1-5" });
    expect(by.get(ids.hooked)).toEqual({ kind: "trigger", label: "Webhook", detail: "expenses-in" });
    expect(by.get(ids.failed)).toEqual({ kind: "person", label: BOB.email, detail: "manual" });
  });
});
