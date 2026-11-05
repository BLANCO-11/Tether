/**
 * The Legal catalogue is a different set of DESCRIPTIONS over the SAME endpoints
 * — these tests are what makes that claim checkable.
 *
 * Three things could go wrong and none of them would fail anywhere else:
 *
 *   · A Legal tool could drift onto a different URL, method or auth style from
 *     the HR or Finance tool of the same name, so "same service, same credential"
 *     quietly stops being true and the demo 401s in front of somebody.
 *   · An `hr_*` tool could be added here, handing a Legal flow a network route
 *     into another tenant's employee directory — a cross-tenant read that no
 *     datasource boundary catches, because it does not go through a datasource.
 *   · The catalogue could become a FILTER over Finance's, at which point a Legal
 *     drafter reads Finance's channels and templates and writes a flow that 404s.
 *
 * With three tenants the parity check is now three-way rather than two-way, which
 * is the point: the first divergence between any pair fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoToolCatalogue } from "../tool-catalogue.js";
import { financeToolCatalogue } from "../finance/finance-tools.js";
import { legalToolCatalogue, LEGAL_OPS_SERVICES } from "./legal-tools.js";
import { OPS_SECRET_ENV } from "../../services/ops-client.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const legal = legalToolCatalogue();
const hrByName = new Map(demoToolCatalogue().map((t) => [t.name, t]));
const financeByName = new Map(financeToolCatalogue().map((t) => [t.name, t]));

describe("the Legal tool catalogue", () => {
  it("holds exactly the seven tools Finance holds (llm_complete is a platform tool)", () => {
    // Not a round number for its own sake: it is Finance's set, and the parity
    // assertions below are only meaningful over the same population.
    expect(legal.map((t) => t.name).sort()).toEqual([...financeByName.keys()].sort());
    expect(legal).toHaveLength(7);
  });

  it("registers no hr_* tool", () => {
    const leaked = legal.filter((t) => t.name.startsWith("hr_")).map((t) => t.name);
    expect(leaked, "an hr_* tool in Legal is a cross-tenant read over HTTP").toEqual([]);
  });

  it("holds no credential for the HR directory service", () => {
    expect(LEGAL_OPS_SERVICES).not.toContain("hr");
    const envNames = legal.map((t) => t.secretEnvName);
    expect(envNames).not.toContain(OPS_SECRET_ENV.hr);
  });

  it("points every shared tool at the same endpoint, method and auth as HR's AND Finance's", () => {
    // Not a subset check — an exact per-field comparison against both other
    // tenants, because a Legal tool that 401s or 404s is a demo that fails in
    // front of somebody, and a three-way agreement is what makes "same service"
    // a property rather than a coincidence.
    for (const t of legal) {
      for (const [tenant, twin] of [
        ["HR", hrByName.get(t.name)],
        ["Finance", financeByName.get(t.name)],
      ] as const) {
        expect(twin, `${t.name} has no ${tenant} counterpart — is it a new endpoint?`).toBeDefined();
        expect({ name: t.name, url: t.url, method: t.method }).toEqual({
          name: t.name,
          url: twin!.url,
          method: twin!.method,
        });
        expect({
          secretEnvName: t.secretEnvName,
          authStyle: t.authStyle,
          authParamName: t.authParamName,
        }).toEqual({
          secretEnvName: twin!.secretEnvName,
          authStyle: twin!.authStyle,
          authParamName: twin!.authParamName,
        });
      }
    }
  });

  it("declares the same parameters as HR's and Finance's for every shared tool", () => {
    // The prose differs on purpose; the interface must not. A Legal drafter
    // reading a `recipients` that HR calls `to` would write a flow that 400s.
    for (const t of legal) {
      const mine = Object.keys(t.paramsSchema ?? {}).sort();
      expect(mine, `${t.name} parameters vs HR`).toEqual(
        Object.keys(hrByName.get(t.name)!.paramsSchema ?? {}).sort(),
      );
      expect(mine, `${t.name} parameters vs Finance`).toEqual(
        Object.keys(financeByName.get(t.name)!.paramsSchema ?? {}).sort(),
      );
    }
  });

  it("describes LEGAL channels and templates, not HR's or Finance's", () => {
    // The whole reason this catalogue exists rather than a filter over another's.
    const chat = legal.find((t) => t.name === "chat_post_message")!;
    expect(chat.description).toContain("#legal-ops");
    expect(chat.description).toContain("#contracts-renewals");
    expect(chat.description).not.toContain("#hr-ops");
    expect(chat.description).not.toContain("#ap-alerts");

    const tpl = legal.find((t) => t.name === "mail_send_template")!;
    expect(tpl.description).toContain("renewal_notice");
    expect(tpl.description).toContain("non_renewal_notice");
    expect(tpl.description).toContain("obligation_reminder");
    expect(tpl.description).not.toContain("invoice_chase");
    expect(tpl.description).not.toContain("attendance_warning");
  });

  it("warns, in the tool prose, that the two notice templates say opposite things", () => {
    // This is the domain's worst failure mode and the prose is the only place a
    // drafting model will meet it. If this assertion is deleted, the warning can
    // be edited away and nothing else notices.
    const tpl = legal.find((t) => t.name === "mail_send_template")!.description;
    expect(tpl).toMatch(/opposite/i);
    expect(tpl).toContain("contracts_renewal_due");
    expect(tpl).toContain("contracts_expiring_no_autorenew");
  });

  it("tells a flow that an unserved legal notice is an escalation, not a logged warning", () => {
    const mail = legal.find((t) => t.name === "mail_send")!.description;
    expect(mail).toMatch(/notice period never started/i);
    expect(mail).toMatch(/escalat/i);
  });

  it("holds a credential for every service its tools authenticate against", () => {
    const used = new Set(legal.map((t) => t.secretEnvName));
    const held = new Set(LEGAL_OPS_SERVICES.map((s) => OPS_SECRET_ENV[s]));
    for (const name of used) {
      expect(held.has(name!), `${name} is used by a tool but never seeded`).toBe(true);
    }
  });

  it("is a catalogue in its own right, not a filter over Finance's", () => {
    // Read off disk: the property is the ABSENCE of a call, which is not
    // observable at runtime. A filter would inherit Finance's prose, which is the
    // one thing this file exists to prevent.
    //
    // ⚠ Asserted over the IMPORT LINES ONLY, not over the whole file. The
    // docblock NAMES `financeToolCatalogue()` deliberately, to explain why this
    // catalogue is not a filter over it — so a whole-file substring check makes
    // the honest explanation the thing that fails, and the cheapest way to go
    // green is to delete the explanation. You cannot call what you have not
    // imported, so the import list is both the stronger and the fairer check.
    const src = readFileSync(join(here, "legal-tools.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
    expect(imports.join("\n")).not.toMatch(/finance|tool-catalogue|hr-dataset/);
    // Control: the import scan can actually find something.
    expect(imports.length).toBeGreaterThan(2);
    expect(src).toContain("legalToolCatalogue");
    expect(src.length).toBeGreaterThan(4000);
  });
});

/**
 * `foundry_email_send` is NOT in the catalogue above, and must not be — it is a
 * product capability, not demo data, so it is registered by
 * `registerPlatformTools` rather than by the Legal tool list.
 *
 * That split is exactly why the three-way parity test above could pass while the
 * Legal workspace had no email tool: parity is asserted over the DEMO catalogues,
 * and the platform tool is in neither of them. The gap is real and was measured on
 * this deployment — the Finance workspace held its 8 demo tools for 74 minutes
 * carrying no `foundry_email_send`, because the only thing that registers it on
 * the Finance/Legal path is `workspaceService.create`, which fires once and
 * deliberately SWALLOWS failure.
 *
 * So the provisioner must re-register it on every run. Read off disk because the
 * property is a call the provisioner makes, and its ORDER relative to the manifest
 * build — neither is observable from the catalogue at runtime.
 */
describe("the Legal provisioner and the platform email tool", () => {
  const src = readFileSync(join(here, "provision-legal.ts"), "utf8");

  it("re-registers the platform tools on every run, not only at workspace creation", () => {
    const imports = src.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
    expect(imports.join("\n")).toContain("platform-tool-catalogue.js");
    // The import alone proves nothing — assert the call too.
    expect(src).toMatch(/await registerPlatformTools\(workspaceId/);
  });

  it("registers it BEFORE the manifest is built, or the manifest omits it", () => {
    // A manifest built first would hash a catalogue with no email tool in it, and
    // the drafter reads the manifest — so the tool would exist in the database and
    // still be invisible to every flow. Order is the whole property.
    const register = src.indexOf("await registerPlatformTools(workspaceId");
    const manifest = src.indexOf("manifestBuilderService.buildAndPersist(workspaceId)");
    expect(register).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(-1);
    expect(register).toBeLessThan(manifest);
  });

  it("does not bump the manifest version itself", () => {
    // Step 8 renders the manifest once for everything. Rebuilding here as well
    // would make the version a count of provisioning steps rather than of
    // catalogue changes, and every reseed would look like a catalogue change.
    expect(src).toMatch(/registerPlatformTools\(workspaceId, \{ rebuildManifest: false \}\)/);
  });
});
