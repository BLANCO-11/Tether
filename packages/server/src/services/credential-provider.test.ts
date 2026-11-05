import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces, flows } from "../db/schema.js";
import { encrypt } from "../utils/encryptor.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { triggerService } from "./trigger.service.js";
import { credentialProviderService } from "./credential-provider.service.js";

/**
 * Phase 5 — unified workspace credentials + vault-relay seam.
 *
 * The seam must present the three EXISTING encrypted stores as one list and one
 * resolver, without ever returning a value through the list, and refuse the
 * kinds it does not own rather than editing a store behind another surface's
 * back.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[Phase 5 credentials] SKIPPING — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let wsId: string;
let triggerCredName: string;
let triggerCredToken: string;

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `credential-test-${Date.now()}`, description: "Phase 5 credential seam test; safe to delete" })
    .returning();
  wsId = ws.id;

  const [flow] = await db
    .insert(flows)
    .values({
      workspaceId: wsId,
      name: "credential-api-flow",
      kestraFlowId: `credential-flow-${Date.now()}`,
      draftRevision: 1,
      status: "draft",
    })
    .returning();

  // One credential per store the seam reads — plus a legacy secret row written
  // before the `kind` column existed.
  await credentialProviderService.upsertCredential(wsId, {
    kind: "tool",
    name: "MAIL_API_KEY",
    value: "mail-secret-value",
  });
  await credentialProviderService.upsertCredential(wsId, {
    kind: "llm",
    name: "GATEWAY_KEY",
    value: "gateway-secret-value",
  });
  await workspaceSecretRepo.create({
    workspaceId: wsId,
    name: "LEGACY_KEY",
    description: null,
    kind: null,
    label: null,
    valueEnc: encrypt("legacy-secret-value"),
    sandboxValueEnc: null,
  });
  await datasourceRepo.create({
    workspaceId: wsId,
    name: "hr",
    type: "postgres",
    connectionStringEnc: encrypt("postgres://u:p@h/db"),
    secretEnvName: null,
    schemaAllowlist: ["public"],
    testStatus: null,
  });
  /**
   * ⚠ **THE SUBJECT CHANGED AND THE PROPERTY DID NOT.** This was a `webhook`
   * trigger until 2026-09-08, when that type was retired in favour of `api`
   * (see `FLOW_TRIGGER_TYPES`). What this file tests is that a token-bearing
   * TRIGGER resolves through the credential seam and that its value never
   * appears in a listing — true of `api` exactly as it was of `webhook`, since
   * both store their token in the same `webhook_token` column and both resolve
   * to it. Deleting these tests because the type was renamed would have thrown
   * away coverage of the seam itself.
   */
  const created = await triggerService.createForFlow(wsId, flow.id, {
    name: "hr-api",
    type: "api",
    enabled: false,
  });
  triggerCredName = created.name;
  triggerCredToken = (await triggerRepo.get(created.id))!.webhookToken!;
});

afterAll(async () => {
  if (reachable && wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await pool.end().catch(() => {});
});

describe.skipIf(!reachable)("Phase 5 — unified credentials (vault-relay seam)", () => {
  it("lists tool + database + api + llm kinds with hasValue and NO values", async () => {
    const list = await credentialProviderService.listCredentials(wsId);
    const byRef = new Map(list.map((c) => [c.ref, c]));

    for (const ref of ["MAIL_API_KEY", "GATEWAY_KEY", "LEGACY_KEY", "hr", triggerCredName]) {
      expect(byRef.has(ref), `missing ${ref} in ${list.map((c) => c.ref).join(", ")}`).toBe(true);
    }

    const kinds = new Set(list.map((c) => c.kind));
    for (const expected of ["tool", "database", "api", "llm", "generic"] as const) {
      expect(kinds.has(expected), `no ${expected} kind in ${[...kinds].join(", ")}`).toBe(true);
    }

    // Presence is reported; content is not — the whole point of the seam.
    const body = JSON.stringify(list);
    for (const secret of ["mail-secret-value", "gateway-secret-value", "legacy-secret-value", "postgres://u:p@h/db", triggerCredToken]) {
      expect(body).not.toContain(secret);
    }
    for (const c of list) {
      expect(c).not.toHaveProperty("value");
      expect(c).not.toHaveProperty("valueEnc");
    }

    expect(byRef.get("MAIL_API_KEY")!.hasValue).toBe(true);
    expect(byRef.get("GATEWAY_KEY")!.hasValue).toBe(true);
    expect(byRef.get("hr")!.hasValue).toBe(true);
    expect(byRef.get(triggerCredName)!.hasValue).toBe(true);
  });

  it("renders rows written before the kind column existed as generic", async () => {
    const list = await credentialProviderService.listCredentials(wsId);
    const legacy = list.find((c) => c.ref === "LEGACY_KEY");
    expect(legacy?.kind).toBe("generic");
    expect(legacy?.hasValue).toBe(true);
  });

  it("resolves a secret value and a DSN through the same interface", async () => {
    const secret = await credentialProviderService.resolveCredential(wsId, "MAIL_API_KEY");
    expect(secret.value).toBe("mail-secret-value");
    expect(secret.metadata).toMatchObject({ kind: "tool", source: "workspace_secret", ref: "MAIL_API_KEY" });

    const dsn = await credentialProviderService.resolveCredential(wsId, "hr");
    expect(dsn.value).toBe("postgres://u:p@h/db");
    expect(dsn.metadata).toMatchObject({ kind: "database", source: "datasource" });

    const token = await credentialProviderService.resolveCredential(wsId, triggerCredName);
    expect(token.value).toBe(triggerCredToken);
    // ⚠ `api`, not `webhook` — the retired type would now be unreachable here.
    expect(token.metadata).toMatchObject({ kind: "api", source: "trigger" });
  });

  it("refuses an unknown ref cleanly, in resolve and delete alike", async () => {
    await expect(
      credentialProviderService.resolveCredential(wsId, "DOES_NOT_EXIST"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      credentialProviderService.deleteCredential(wsId, "DOES_NOT_EXIST"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("upserts a secret-backed credential: creates, then updates label without touching the value", async () => {
    const created = await credentialProviderService.upsertCredential(wsId, {
      kind: "tool",
      name: "SCRATCH_API_KEY",
      value: "scratch-value",
      label: "Scratch key",
    });
    expect(created).toMatchObject({ kind: "tool", ref: "SCRATCH_API_KEY", label: "Scratch key", hasValue: true });

    const updated = await credentialProviderService.upsertCredential(wsId, {
      kind: "tool",
      name: "SCRATCH_API_KEY",
      label: "Scratch key (renamed)",
    });
    expect(updated.label).toBe("Scratch key (renamed)");
    // The omitted value was NOT overwritten.
    const resolved = await credentialProviderService.resolveCredential(wsId, "SCRATCH_API_KEY");
    expect(resolved.value).toBe("scratch-value");
  });

  it("refuses a new secret-backed credential without a value", async () => {
    await expect(
      credentialProviderService.upsertCredential(wsId, { kind: "tool", name: "EMPTY_API_KEY" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses kinds the seam does not own, pointing at the owning surface", async () => {
    await expect(
      credentialProviderService.upsertCredential(wsId, {
        kind: "database",
        name: "some-db",
        value: "x",
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: /data sources page/ });
    await expect(
      credentialProviderService.deleteCredential(wsId, "hr"),
    ).rejects.toMatchObject({ statusCode: 409, message: /data sources page/ });
    await expect(
      credentialProviderService.deleteCredential(wsId, triggerCredName),
    ).rejects.toMatchObject({ statusCode: 409, message: /triggers page/ });
  });

  it("deletes a secret-backed credential by ref", async () => {
    await credentialProviderService.upsertCredential(wsId, {
      kind: "llm",
      name: "SCRATCH_LLM_KEY",
      value: "llm-value",
    });
    const ok = await credentialProviderService.deleteCredential(wsId, "SCRATCH_LLM_KEY");
    expect(ok).toBe(true);
    await expect(
      credentialProviderService.resolveCredential(wsId, "SCRATCH_LLM_KEY"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
