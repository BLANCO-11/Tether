/**
 * The real sender reaches the drafter, and cannot be mistaken for the fake one.
 * email-send-tool · US1, US5 · plan.md Decision 6, 7
 *
 * ── Why this asserts against the RENDERED MANIFEST ───────────────────────────
 *
 * A registered tool that is absent from the manifest is invisible to the drafter,
 * and a registration with no `<auth>` element produces a `401` the audit calls
 * clean. Neither failure is visible in the `tools` row — both are properties of
 * what `manifestBuilderService` renders. So the assertion is made there, on a real
 * workspace, in the same place the model actually reads.
 *
 * ⚠ These hit the real database and clean up after themselves, like
 * `workspace-slug.test.ts`. `workspaceService.create` now registers platform tools
 * itself (T032), so most of this suite is asserting on what a plain workspace
 * creation already produced — which is the property that matters.
 */
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { workspaceService } from "./workspace.service.js";
import { manifestBuilderService } from "./manifest-builder.service.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { shadowedSecretCollisions, workspaceSecretService } from "./workspace-secret.service.js";
import {
  EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME,
  platformToolCatalogue,
  registerPlatformTools,
} from "./platform-tool-catalogue.js";
import { mailServiceKey, MAIL_SECRET_ENV, MAIL_KEY_HEADER } from "./mail-service-key.js";
import { demoToolCatalogue } from "../demo/tool-catalogue.js";

const created: string[] = [];

async function makeWorkspace(name: string) {
  const ws = await workspaceService.create({ name });
  created.push(ws.id);
  return ws.id;
}

afterAll(async () => {
  if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  await pool.end();
});

describe("the catalogue itself", () => {
  const catalogue = platformToolCatalogue();

  it("is exactly the email tool, the summary tool and web_fetch — a platform capability list, not a demo dataset", () => {
    // Asserted so that adding a platform tool is a deliberate act that passes through the rules below rather than an
    // entry nobody re-read. web_fetch joined 2026-10-30.
    expect(catalogue.map((t) => t.name)).toEqual([EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME]);
  });

  it("web_fetch reads and nothing else: an address, raw HTML or not, GET or HEAD — no body, no headers, no credentials", () => {
    const web = catalogue.find((t) => t.name === WEB_FETCH_TOOL_NAME)!;
    expect(Object.keys(web.paramsSchema ?? {}).sort()).toEqual(["method", "raw", "url"]);
    expect(web.url).toMatch(/\/api\/web\/fetch$/);
    for (const phrase of ["Public addresses only", "does not sign in"]) expect(String(web.description)).toContain(phrase);
  });

  it("warns the drafter that llm_complete decides nothing (D-34)", () => {
    const llm = catalogue.find((t) => t.name === LLM_TOOL_NAME)!;
    for (const phrase of ["NOT deterministic", "nothing later may read it", "JSON"]) {
      expect(String(llm.description)).toContain(phrase);
    }
    // One text field back; a `format` or `schema` parameter is the change this guards.
    expect(Object.keys(llm.paramsSchema ?? {}).sort()).toEqual(["input", "instruction", "max_tokens", "model"]);
  });

  it("llm_complete calls Foundry's own endpoint with its derived key, never the provider key (ops-api retired 2026-10-30)", () => {
    const llm = catalogue.find((t) => t.name === LLM_TOOL_NAME)!;
    expect(llm.secretEnvName).toBe("FOUNDRY_LLM_KEY");
    expect(llm.url).toMatch(/\/api\/llm\/complete$/);
    expect(catalogue.map((t) => t.secretEnvName)).not.toContain("LLM_API_KEY");
  });

  it("points at FOUNDRY, never at graph.microsoft.com", () => {
    /**
     * ⚠ plan.md Decision 1, and the single most important assertion about this
     * tool. Graph delivers to whatever the request body names — a tool aimed at
     * Microsoft would hand the model the destination and no recipient policy could
     * exist anywhere.
     */
    expect(String(catalogue[0].url)).toMatch(/\/api\/mail\/send$/);
    expect(String(catalogue[0].url)).not.toContain("graph.microsoft.com");
    expect(String(catalogue[0].url)).not.toContain("login.microsoftonline.com");
  });

  it("carries a credential, and NOT the simulated service's one", () => {
    expect(catalogue[0].secretEnvName).toBe(MAIL_SECRET_ENV);
    expect(catalogue[0].authStyle).toBe("header");
    expect(catalogue[0].authParamName).toBe(MAIL_KEY_HEADER);
    // ⚠ `MAIL_API_KEY` is the *simulated* mail service's secret. Reusing that name
    // would trip `shadowedSecretCollisions` and fail the step with a confusing 409.
    expect(catalogue[0].secretEnvName).not.toBe("MAIL_API_KEY");
  });

  it("declares the eight params, with `to` and every attachment param optional", () => {
    const params = catalogue[0].paramsSchema as Record<
      string,
      { type: string; required?: boolean; description?: string }
    >;
    expect(Object.keys(params).sort()).toEqual([
      "attach_format", "attach_name", "attach_rows", "attachments", "body", "cc", "subject", "to",
    ]);
    // The flat attachment is extra too — optional, or every email flow written before it opens a hole.
    for (const k of ["attach_rows", "attach_name", "attach_format"]) expect(params[k]!.required).toBeFalsy();
    expect(params.subject.required).toBe(true);
    expect(params.body.required).toBe(true);
    // ⚠ `to` MUST be optional. Omitting it is the only form that works without an
    // allowlist entry, it is what "email me" means, and it is the form in which the
    // model never has to produce an address and so cannot get one wrong.
    expect(params.to.required).toBeFalsy();
    expect(params.cc.required).toBeFalsy();
    expect(params.to.description).toMatch(/OMIT/);
    // An attachment is extra, never required — every flow written before it
    // existed must still validate against this schema.
    expect(params.attachments.required).toBeFalsy();
    expect(params.attachments.type).toBe("array");
    // Both ways to attach are taught here: the text form and the generated one.
    expect(params.attachments.description).toMatch(/content/);
    expect(params.attachments.description).toMatch(/rows/);
  });

  it("US5 — opens with the real-delivery clause", () => {
    // First words, not somewhere in the paragraph. A caveat a model may not weight
    // is not a control.
    expect(String(catalogue[0].description)).toMatch(/^REAL DELIVERY to a live mailbox/);
  });
});

describe("US5 — the real tool and the simulated ones do not read alike", () => {
  it("the two simulated mail tools open with SIMULATED", () => {
    const simulated = demoToolCatalogue().filter((t) => t.name.startsWith("mail_send"));
    expect(simulated).toHaveLength(2);
    for (const t of simulated) {
      expect(String(t.description)).toMatch(/^SIMULATED/);
    }
  });

  it("no name collision between the real sender and the simulated pair", () => {
    const names = new Set(demoToolCatalogue().map((t) => t.name));
    expect(names.has(EMAIL_TOOL_NAME)).toBe(false);
  });
});

describe("registration reaches the manifest", () => {
  it("a NEW workspace lists tether_email_send with its params and <auth>", async () => {
    // No explicit registration call — `workspaceService.create` does it (T032).
    const workspaceId = await makeWorkspace("Platform Tools — fresh");
    const manifest = await manifestBuilderService.buildAndPersist(workspaceId);
    const xml = manifest.manifestXml;

    expect(xml).toContain(`name="${EMAIL_TOOL_NAME}"`);
    expect(xml).toContain("REAL DELIVERY to a live mailbox");
    for (const param of ["subject", "body", "to", "cc"]) {
      expect(xml).toContain(`name="${param}"`);
    }

    /**
     * ⚠ The `<auth>` element, not just `<secretRef>`. WS-B.4's measured failure:
     * `<secretRef>` alone tells the agent a key exists but not where it goes, so it
     * guesses between bearer/header/query/basic — and a wrong guess is a 401 the
     * audit calls `clean`. A registration missing this would 401 silently on every
     * email step.
     */
    expect(xml).toMatch(
      new RegExp(`<auth style="header" name="${MAIL_KEY_HEADER}" env="${MAIL_SECRET_ENV}"/>`),
    );
  });

  it("stores FOUNDRY_MAIL_KEY with the derived value", async () => {
    const workspaceId = await makeWorkspace("Platform Tools — secret");

    // ⚠ Asserted through the audit's `missing` list, not by reading the value
    // back: the secret service never returns a stored value, which is the property
    // that makes this safe in the first place.
    const audit = await workspaceSecretService.audit(workspaceId);
    expect(audit.missing.map((m: { envName: string }) => m.envName)).not.toContain(
      MAIL_SECRET_ENV,
    );

    // And the derived key is stable, so a re-registration puts an identical value.
    expect(mailServiceKey()).toBe(mailServiceKey());
    expect(mailServiceKey()).toHaveLength(40);
  });

  it("does not collide with the simulated mail service's secret", async () => {
    // A collision here trips `shadowedSecretCollisions` and fails the step with a
    // 409 about a secret the flow author never touched.
    const workspaceId = await makeWorkspace("Platform Tools — no collision");
    expect(await shadowedSecretCollisions(workspaceId, MAIL_SECRET_ENV)).toEqual([]);
  });

  it("is idempotent — re-registering updates rather than duplicating", async () => {
    const workspaceId = await makeWorkspace("Platform Tools — idempotent");

    const second = await registerPlatformTools(workspaceId);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME]);

    const tools = await toolRepo.listByWorkspace(workspaceId);
    expect(tools.filter((t) => t.name === EMAIL_TOOL_NAME)).toHaveLength(1);
  });

  it("carries auth on the UPDATE path too, not only on create", async () => {
    /**
     * ⚠ WS-B.5's measured failure, restated for this tool: leaving
     * `secretEnvName`/`authStyle`/`authParamName` off the update meant
     * re-provisioning an existing workspace silently produced a tool with no
     * `<auth>` element, and every call 401'd. So the assertion is made *after* an
     * update, against the rendered manifest.
     */
    const workspaceId = await makeWorkspace("Platform Tools — update keeps auth");
    await registerPlatformTools(workspaceId); // the update path

    const manifest = await manifestBuilderService.buildAndPersist(workspaceId);
    expect(manifest.manifestXml).toMatch(
      new RegExp(`<auth style="header" name="${MAIL_KEY_HEADER}" env="${MAIL_SECRET_ENV}"/>`),
    );
  });

  it("rebuildManifest:false leaves the version alone, so a reseed bumps it once", async () => {
    const workspaceId = await makeWorkspace("Platform Tools — no bump");
    const before = await manifestBuilderService.buildAndPersist(workspaceId);

    const r = await registerPlatformTools(workspaceId, { rebuildManifest: false });
    expect(r.manifestVersion).toBeNull();

    // Nothing about the catalogue changed, so a rebuild is content-identical and
    // the version does not move — which is what makes step 5b in `provision.ts`
    // safe to run before step 6's single render.
    const after = await manifestBuilderService.buildAndPersist(workspaceId);
    expect(after.version).toBe(before.version);
  });
});
