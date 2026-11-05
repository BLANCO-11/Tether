import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces, tools, datasources, workspaceSecrets } from "../db/schema.js";
import { encrypt } from "../utils/encryptor.js";
import {
  workspaceSecretService,
  resolveForExecution,
  resolveForGeneration,
  shadowedSecretCollisions,
} from "./workspace-secret.service.js";
import { createToolSchema } from "./tool.service.js";
import { manifestBuilderService } from "./manifest-builder.service.js";
import { redactSecrets } from "../utils/redact.js";
import { config } from "../config/index.js";

/**
 * WS-B verification (plans/production-substitution-plan.md §5).
 *
 * The gaps being closed are G2 (tool secrets never injected at execution), G3
 * (never pushed at generation) and G5 (the manifest cannot say HOW to
 * authenticate). Each has a test that would have failed before the change.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[WS-B] SKIPPING — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let wsId: string;

/**
 * Scope every mutation to THIS test's workspace.
 *
 * A bare `where(eq(tools.name, "mail_send"))` also matched the HR DEMO workspace's
 * tool, and this suite's cleanup only drops its own workspace — so the tests passed
 * while silently rewriting the live demo registry, giving `mail_send` an
 * `authStyle` the mail stub does not require. Tool names are unique PER WORKSPACE,
 * not globally; never filter on one alone.
 */
const mine = (toolName: string) => and(eq(tools.workspaceId, wsId), eq(tools.name, toolName));

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `ws-b-test-${Date.now()}`, description: "WS-B test; safe to delete" })
    .returning();
  wsId = ws.id;
});

afterAll(async () => {
  if (reachable && wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await pool.end().catch(() => {});
});

describe.skipIf(!reachable)("WS-B.3 workspace secret store", () => {
  it("never returns a value, in any response shape", async () => {
    const created = await workspaceSecretService.create(wsId, {
      name: "MAIL_API_KEY",
      value: "super-secret-value-1",
      description: "test",
    });
    const listed = await workspaceSecretService.list(wsId);
    const body = JSON.stringify({ created, listed });
    expect(body).not.toContain("super-secret-value-1");
    // Presence is reported; content is not.
    expect(created.hasValue).toBe(true);
    expect(created).not.toHaveProperty("value");
  });

  it("stores the value encrypted, not in plaintext", async () => {
    const [row] = await db
      .select()
      .from(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, wsId), eq(workspaceSecrets.name, "MAIL_API_KEY")))
      .limit(1);
    expect(row.valueEnc).not.toContain("super-secret-value-1");
    expect(row.valueEnc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // iv:tag:ciphertext
  });

  it("rejects a duplicate name rather than shadowing the existing value", async () => {
    await expect(
      workspaceSecretService.create(wsId, { name: "MAIL_API_KEY", value: "other" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a name that could not be an env var", async () => {
    await expect(
      workspaceSecretService.create(wsId, { name: "not a valid name", value: "x" }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!reachable)("WS-B.1 injection at execution (G2)", () => {
  it("resolves a tool's credential — the whole point of the gap", async () => {
    await db.insert(tools).values({
      workspaceId: wsId,
      name: "mail_send",
      url: "http://stubs.local/mail",
      method: "POST",
      secretEnvName: "MAIL_API_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });

    const { secrets, missing, collisions } = await resolveForExecution(wsId);
    expect(collisions).toEqual([]);
    expect(missing).toEqual([]);
    const mail = secrets.find((s) => s.name === "MAIL_API_KEY");
    expect(mail?.value).toBe("super-secret-value-1");
    expect(mail?.source).toBe("workspace_secret");
  });

  it("reports a declared-but-unstored secret instead of silently injecting nothing", async () => {
    await db.insert(tools).values({
      workspaceId: wsId,
      name: "chat_post",
      url: "http://stubs.local/chat",
      method: "POST",
      secretEnvName: "CHAT_TOKEN", // never stored
    });
    const { missing } = await resolveForExecution(wsId);
    expect(missing).toEqual([{ envName: "CHAT_TOKEN", neededBy: 'tool "chat_post"' }]);
  });

  it("skips inactive tools", async () => {
    await db.update(tools).set({ isActive: false }).where(mine("chat_post"));
    const { missing } = await resolveForExecution(wsId);
    expect(missing).toEqual([]);
    await db.update(tools).set({ isActive: true }).where(mine("chat_post"));
  });

  it("flags a tool/datasource name collision rather than letting one shadow the other", async () => {
    // Two different values under one env name: whichever is injected second wins,
    // and the failure looks like a wrong credential rather than a config error.
    await db.insert(datasources).values({
      workspaceId: wsId,
      name: "clashing_db",
      type: "postgres",
      connectionStringEnc: encrypt("postgres://u:p@h/db"),
      secretEnvName: "MAIL_API_KEY",
    });
    const { collisions } = await resolveForExecution(wsId);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain("MAIL_API_KEY");
    await db
      .delete(datasources)
      .where(and(eq(datasources.workspaceId, wsId), eq(datasources.name, "clashing_db")));
  });

  it("does NOT flag two tools legitimately sharing one workspace secret", async () => {
    // The reason the store is per-workspace rather than per-tool.
    await db.insert(tools).values({
      workspaceId: wsId,
      name: "mail_send_bulk",
      url: "http://stubs.local/mail/bulk",
      method: "POST",
      secretEnvName: "MAIL_API_KEY",
    });
    const { collisions, secrets } = await resolveForExecution(wsId);
    expect(collisions).toEqual([]);
    // One env var, not two.
    expect(secrets.filter((s) => s.name === "MAIL_API_KEY")).toHaveLength(1);
  });
});

/**
 * I-120 — the same rule, asked about ONE name, at the moment of use.
 *
 * `resolveForExecution` above is the AUDIT's computation and its only production
 * caller is `audit`. The refusal the docs promised had no call site at all between
 * Kestra Phase 4 and 2026-08-10, so a shadowed credential was silent. These tests
 * cover the scoped query; `step-execution.test.ts` covers the refusal that uses it.
 */
describe.skipIf(!reachable)("WS-B.1 the execution-time refusal (I-120)", () => {
  it("reports a tool/datasource collision for the one name asked about", async () => {
    await db.insert(datasources).values({
      workspaceId: wsId,
      name: "clashing_db",
      type: "postgres",
      connectionStringEnc: encrypt("postgres://u:p@h/db"),
      secretEnvName: "MAIL_API_KEY",
    });

    const collisions = await shadowedSecretCollisions(wsId, "MAIL_API_KEY");

    // ⚠ TWO entries, not one, and that is correct — one per DISAGREEING
    // DECLARATION rather than one per name. By this point `mail_send` and
    // `mail_send_bulk` both declare MAIL_API_KEY, and each disagrees with the
    // datasource's DSN. The first version of this test asserted 1 and failed; the
    // count is a property of how many things declare the name, so asserting it as
    // a constant would break the moment a fixture gained a tool.
    expect(collisions.length).toBeGreaterThanOrEqual(1);
    // Every entry names the env var and the datasource it disagrees with, because
    // the fix is a rename and the reader has to know which two to look at.
    for (const c of collisions) {
      expect(c).toContain("MAIL_API_KEY");
      expect(c).toContain('datasource "clashing_db"');
      expect(c).toContain("tool");
    }
    // Both tools are accounted for: a report that named only the first would leave
    // the second silently shadowed after the first was fixed.
    expect(collisions.join(" ")).toContain('tool "mail_send"');
    expect(collisions.join(" ")).toContain('tool "mail_send_bulk"');
  });

  it("⚠ agrees with the audit's own answer, so the two views cannot drift", async () => {
    // The scoped walk and the full walk share `declarationsIn` + `dedupe` for
    // exactly this reason. Asserted rather than trusted: two implementations of
    // "is this shadowed?" would drift in the direction where the cheap one says
    // no, which is the direction that fails silently.
    const scoped = await shadowedSecretCollisions(wsId, "MAIL_API_KEY");
    const { collisions: full } = await resolveForExecution(wsId);

    expect(scoped).toEqual(full.filter((c) => c.startsWith("MAIL_API_KEY")));
    expect(scoped.length).toBeGreaterThan(0); // control: not comparing two empty lists
  });

  it("⚠ THE CONTROL: says nothing about a name that does not collide", async () => {
    // A check that refuses the normal case is worse than none (I-38), and two
    // tools sharing one vendor key IS the normal case — it is the reason this
    // store is per workspace rather than per tool.
    await db
      .delete(datasources)
      .where(and(eq(datasources.workspaceId, wsId), eq(datasources.name, "clashing_db")));

    // `mail_send` and `mail_send_bulk` both declare MAIL_API_KEY at this point.
    expect(await shadowedSecretCollisions(wsId, "MAIL_API_KEY")).toEqual([]);
    // And a name nothing declares is not a collision either.
    expect(await shadowedSecretCollisions(wsId, "NOT_DECLARED_ANYWHERE")).toEqual([]);
  });

  it("⚠ two TOOLS at different values is UNREACHABLE, and this records why", async () => {
    // `checkpoint.md` 1.1 asked for a test of "two tools declaring one name with
    // DIFFERENT values → 409". That state cannot exist: every tool resolves its
    // credential through `workspaceSecretRepo.getByName(workspaceId, envName)` —
    // the same row — so two tools always contribute an identical value. A test
    // asserting the 409 would have had to fabricate the state to observe it, and
    // would then have been testing the fabrication.
    //
    // Asserting the property directly instead: the two tools sharing the name
    // resolve to ONE value, from ONE source.
    const { secrets } = await resolveForExecution(wsId);
    const mail = secrets.filter((s) => s.name === "MAIL_API_KEY");
    expect(mail).toHaveLength(1);
    expect(mail[0].source).toBe("workspace_secret");
  });

  it("⚠ the refusal HAS A CALL SITE — the assertion I-120 existed for", async () => {
    // This is the shape of check that would have caught I-120, and it is the
    // repo's existing idiom for "a control that is satisfied by a grep": see the
    // one-reader-per-secret assertion in `kestra-boundary-check.sh` and the
    // source-reading test in `flow-refine.service.ts`'s suite.
    //
    // A correct detector nothing calls is precisely what this issue was, so the
    // detector's own tests cannot close it.
    /**
     * ⚠ **Reads `tool-invoke.ts` as of 2026-08-20, not `step-execution.service.ts`.**
     * The refusal MOVED there with the rest of the dial (tool-probe T02), and this
     * guard going red is exactly what it is for: the call site is the whole claim,
     * so a check that kept reading the old file would have passed only until
     * someone deleted the call along with the code around it.
     *
     * ⚠ **It also reads the OLD file and asserts the call is NOT there**, which is
     * the half that makes this a move rather than a duplication. Two live
     * resolutions of the same credential — one guarded, one not — is I-120 with
     * extra steps, and the way that happens is a copy left behind.
     */
    const dial = await readFile(new URL("./tool-invoke.ts", import.meta.url), "utf8");

    // ⚠ The control against a vacuous pass: without it, a renamed or moved file
    // would read as an empty string and every assertion below would hold.
    expect(dial.length).toBeGreaterThan(1000);
    expect(dial).toContain("dialTool");

    expect(dial).toContain("shadowedSecretCollisions");
    expect(dial).toMatch(/status:\s*409|,\s*409,/);

    // And the dial is what the step path actually calls — a guarded resolution in
    // a module nothing invokes is I-120 again.
    const service = await readFile(
      new URL("./step-execution.service.ts", import.meta.url),
      "utf8",
    );
    expect(service.length).toBeGreaterThan(1000);
    expect(service).toContain("invokeTool");
    expect(service).toContain("resolveToolAuth");
    expect(service).not.toContain("shadowedSecretCollisions(");
  });
});

describe.skipIf(!reachable)("WS-B.2 generation-time secrets (G3, §13 Q1)", () => {
  it("pushes the production value when no sandbox value is configured", async () => {
    const forGen = await resolveForGeneration(wsId);
    expect(forGen.find((s) => s.name === "MAIL_API_KEY")?.value).toBe("super-secret-value-1");
  });

  it("prefers a sandbox-scoped value, keeping the production key out of the agent workspace", async () => {
    const [row] = await db
      .select()
      .from(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, wsId), eq(workspaceSecrets.name, "MAIL_API_KEY")))
      .limit(1);
    await workspaceSecretService.update(wsId, row.id, { sandboxValue: "sandbox-only-value" });

    const forGen = await resolveForGeneration(wsId);
    const s = forGen.find((x) => x.name === "MAIL_API_KEY");
    expect(s?.value).toBe("sandbox-only-value");
    expect(s?.source).toBe("workspace_secret_sandbox");

    // Execution must STILL use the production value — that is the whole point.
    const { secrets } = await resolveForExecution(wsId);
    expect(secrets.find((x) => x.name === "MAIL_API_KEY")?.value).toBe("super-secret-value-1");
  });
});

describe.skipIf(!reachable)("WS-B.4 manifest <auth> (G5)", () => {
  it("renders the style and the header name, not just that a key exists", async () => {
    const m = await manifestBuilderService.buildAndPersist(wsId);
    expect(m.manifestXml).toContain('<secretRef env="MAIL_API_KEY"/>');
    expect(m.manifestXml).toContain(
      '<auth style="header" name="X-API-Key" env="MAIL_API_KEY"/>',
    );
    // And never the value.
    expect(m.manifestXml).not.toContain("super-secret-value-1");
    expect(m.summaryXml).not.toContain("super-secret-value-1");
  });

  it("omits name= for styles that do not take one", async () => {
    await db.update(tools).set({ authStyle: "bearer", authParamName: null }).where(mine("mail_send"));
    const m = await manifestBuilderService.buildAndPersist(wsId);
    expect(m.manifestXml).toContain('<auth style="bearer" env="MAIL_API_KEY"/>');
    expect(m.manifestXml).not.toContain('style="bearer" name=');
  });

  it("bumps the manifest version when the auth style changes", async () => {
    // An agent that was told "bearer" must be re-told when it becomes a header.
    const before = await manifestBuilderService.buildAndPersist(wsId);
    await db.update(tools).set({ authStyle: "query", authParamName: "api_key" }).where(mine("mail_send"));
    const after = await manifestBuilderService.buildAndPersist(wsId);
    expect(after.changed).toBe(true);
    expect(after.version).toBe(before.version + 1);
  });
});

/**
 * ui-upgrade Phase 8 — a secret can be renamed, and a rename is a BREAKING
 * change that has to present as one (D-110).
 *
 * ⚠ These run LAST on purpose. They rename rows, and the suite above shares one
 * workspace across its describes; a rename half way up would move a name a later
 * assertion reads. They still use their own rows rather than relying on that.
 */
describe.skipIf(!reachable)("ui-upgrade 8 — renaming a secret", () => {
  let orphanId: string;
  let loneId: string;

  it("sets up a referenced secret and an unreferenced one", async () => {
    orphanId = (await workspaceSecretService.create(wsId, {
      name: "TICKETING_API_KEY",
      value: "tk-1",
    })).id;
    loneId = (await workspaceSecretService.create(wsId, {
      name: "NOBODY_READS_THIS",
      value: "nr-1",
    })).id;
    await db.insert(tools).values({
      workspaceId: wsId,
      name: "ticket_create",
      url: "http://stubs.local/tickets",
      method: "POST",
      secretEnvName: "TICKETING_API_KEY",
    });
    expect(orphanId).toBeTruthy();
  });

  it("names what reads the secret, without doing anything", async () => {
    const impact = (await workspaceSecretService.renameImpact(wsId, orphanId, "TICKET_KEY"))!;
    expect(impact.name).toBe("TICKETING_API_KEY");
    expect(impact.newName).toBe("TICKET_KEY");
    expect(impact.references.map((r) => r.label)).toEqual(['tool "ticket_create"']);
    expect(impact.orphanWarning).toContain("TICKETING_API_KEY");
    // Asked, not done.
    const still = await workspaceSecretService.list(wsId);
    expect(still.map((s) => s.name)).toContain("TICKETING_API_KEY");
  });

  it("⚠ reports references, NEVER willSuspendFlows — the consequence is different in kind", async () => {
    // D-84's named-query impact reports a suspension: the sweep unarms the flows
    // and they STOP. A secret rename moves no fingerprint, so every armed flow
    // stays armed and keeps running — it just signs in with nothing. A field
    // named `willSuspendFlows` here would promise a stop that never comes.
    //
    // ⚠ Read off a REAL response. `Object.keys({} as RenameImpact)` is `[]` at
    // runtime, so that version of this test could never have failed (I-38).
    const impact = (await workspaceSecretService.renameImpact(wsId, orphanId, "TICKET_KEY"))!;
    expect(Object.keys(impact)).toContain("references");
    expect(Object.keys(impact)).not.toContain("willSuspendFlows");
    // And the sentence says so out loud, because "breaking change" is a phrase
    // people read as "the thing stops". Here it does not stop; it keeps running.
    expect(impact.orphanWarning).toMatch(/does not suspend/);
  });

  it("REFUSES a rename that orphans a reference, rather than doing it quietly", async () => {
    await expect(
      workspaceSecretService.update(wsId, orphanId, { name: "TICKET_KEY" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // And the refusal names what breaks — a 409 saying "conflict" would send
    // someone looking for a duplicate name that does not exist.
    await expect(
      workspaceSecretService.update(wsId, orphanId, { name: "TICKET_KEY" }),
    ).rejects.toThrow(/ticket_create/);
  });

  it("⚠ `confirmOrphans: false` is not a confirmation", async () => {
    // The check is `!== true`, so an explicit false, an omitted field and a
    // truthy-looking string all refuse. A `Boolean(input.confirmOrphans)` would
    // accept the string.
    await expect(
      workspaceSecretService.update(wsId, orphanId, { name: "TICKET_KEY", confirmOrphans: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows it once confirmed, and reports what it just orphaned", async () => {
    const out = (await workspaceSecretService.update(wsId, orphanId, {
      name: "TICKET_KEY",
      confirmOrphans: true,
    }))!;
    expect(out.secret.name).toBe("TICKET_KEY");
    expect(out.rename).toMatchObject({ from: "TICKETING_API_KEY", to: "TICKET_KEY" });
    expect(out.rename!.orphaned.map((r) => r.label)).toEqual(['tool "ticket_create"']);
  });

  it("and the audit catches the orphan IMMEDIATELY — the exit criterion", async () => {
    // ⚠ This is the whole reason the rename has to be confirmed. Nothing was
    // suspended, no fingerprint moved, no manifest changed and no error was
    // raised anywhere. The only surface that notices is `missing`, and it has to
    // notice on the very next read — not after a sweep, not after a run.
    const audit = await workspaceSecretService.audit(wsId);
    expect(audit.missing).toContainEqual({
      envName: "TICKETING_API_KEY",
      neededBy: 'tool "ticket_create"',
    });
    expect(audit.configured).not.toContain("TICKETING_API_KEY");
    // ⚠ And the NEW name is not in `configured` either — I-96. `configured` is
    // computed from `resolveForExecution`, which walks DECLARATIONS, so it means
    // "stored AND referenced by something", not "stored". A renamed secret that
    // nothing references yet is therefore invisible to the audit in both
    // directions. That is not a lie on screen — `/keys` lists every stored
    // secret in its own table — but the field's docblock said "names with a
    // stored value", which is not what it computes.
    expect(audit.configured).not.toContain("TICKET_KEY");
    expect((await workspaceSecretService.list(wsId)).map((s) => s.name)).toContain("TICKET_KEY");
  });

  it("needs no confirmation when nothing references the name", async () => {
    // Refusing every rename would make the confirmation a formality people click
    // through — which is how a control stops being read.
    const out = (await workspaceSecretService.update(wsId, loneId, { name: "STILL_NOBODY" }))!;
    expect(out.secret.name).toBe("STILL_NOBODY");
    expect(out.rename!.orphaned).toEqual([]);
  });

  it("refuses a rename onto a name another secret already holds", async () => {
    await expect(
      workspaceSecretService.update(wsId, loneId, { name: "TICKET_KEY", confirmOrphans: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reports a datasource collision but does NOT refuse it", async () => {
    // A datasource declaring the same env name is a COLLISION, and a collision
    // fails the execution with a 409 rather than picking one at random. That is
    // loud. This route refuses the silent case only.
    await db.insert(datasources).values({
      workspaceId: wsId,
      name: "collide_db",
      type: "postgres",
      connectionStringEnc: encrypt("postgres://u:p@h/db"),
      secretEnvName: "SHARED_NAME",
    });
    const impact = (await workspaceSecretService.renameImpact(wsId, loneId, "SHARED_NAME"))!;
    expect(impact.collidesWithDatasource).toBe("collide_db");
    expect(impact.nameTaken).toBe(false);
    const out = (await workspaceSecretService.update(wsId, loneId, { name: "SHARED_NAME" }))!;
    expect(out.secret.name).toBe("SHARED_NAME");
    await db
      .delete(datasources)
      .where(and(eq(datasources.workspaceId, wsId), eq(datasources.name, "collide_db")));
  });

  it("reports what a rename would ADOPT — the case where it is the fix", async () => {
    // Someone stores a key under the wrong name; the tool has been 401ing ever
    // since. Renaming it is the repair, and a dialog that only says "this breaks
    // things" would talk them out of it.
    const impact = (await workspaceSecretService.renameImpact(wsId, loneId, "TICKETING_API_KEY"))!;
    expect(impact.adopts.map((r) => r.label)).toEqual(['tool "ticket_create"']);
    expect(impact.references).toEqual([]);
  });

  it("still refuses a name that could not be an env var", async () => {
    await expect(
      workspaceSecretService.update(wsId, loneId, { name: "not a valid name" }),
    ).rejects.toThrow();
  });

  it("⚠ no response shape gained a value", async () => {
    const impact = await workspaceSecretService.renameImpact(wsId, loneId, "ANOTHER");
    const out = await workspaceSecretService.update(wsId, loneId, { value: "nr-2" });
    const body = JSON.stringify({ impact, out });
    expect(body).not.toContain("nr-2");
    expect(body).not.toContain("tth_live_test");
    expect(out!.secret).not.toHaveProperty("value");
  });

  it("returns undefined for a secret that is not there, rather than throwing", async () => {
    const gone = "00000000-0000-0000-0000-000000000000";
    expect(await workspaceSecretService.renameImpact(wsId, gone, "X")).toBeUndefined();
    expect(await workspaceSecretService.update(wsId, gone, { description: "x" })).toBeUndefined();
  });
});

describe("WS-B.4 tool validation", () => {
  it("refuses an auth style with no secret to read", () => {
    expect(() =>
      createToolSchema.parse({
        name: "t",
        url: "http://x.local/a",
        method: "GET",
        authStyle: "bearer",
      }),
    ).toThrow(/requires a secretEnvName/);
  });

  it("refuses header/query auth with no param name", () => {
    expect(() =>
      createToolSchema.parse({
        name: "t",
        url: "http://x.local/a",
        method: "GET",
        secretEnvName: "K",
        authStyle: "header",
      }),
    ).toThrow(/requires authParamName/);
  });

  it("accepts bearer with only a secret name", () => {
    expect(() =>
      createToolSchema.parse({
        name: "t",
        url: "http://x.local/a",
        method: "GET",
        secretEnvName: "K",
        authStyle: "bearer",
      }),
    ).not.toThrow();
  });
});

describe("WS-B.6 never persist a credential", () => {
  it("redacts credential-shaped keys from anything written to the call log", () => {
    // A script that wrongly sends the key as ?api_key= would otherwise write it
    // verbatim into the tool call log, where it survives 2000 rows.
    const r = redactSecrets({
      api_key: "sk-live-123",
      "X-Api-Key": "sk-live-123",
      authorization: "Bearer sk-live-123",
      token: "t",
      password: "p",
      nested: { secret: "s", title: "keep me" },
      list: [{ apikey: "a" }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toContain("sk-live-123");
    expect(r.api_key).toBe("[redacted]");
    expect(r["X-Api-Key"]).toBe("[redacted]");
    expect(r.authorization).toBe("[redacted]");
    expect((r.nested as Record<string, unknown>).secret).toBe("[redacted]");
    expect((r.nested as Record<string, unknown>).title).toBe("keep me");
    expect((r.list as Record<string, unknown>[])[0].apikey).toBe("[redacted]");
  });

  it("leaves ordinary fields alone", () => {
    const r = redactSecrets({ subject: "Attendance", to: ["a@b.example"], count: 3 });
    expect(r).toEqual({ subject: "Attendance", to: ["a@b.example"], count: 3 });
  });
});
