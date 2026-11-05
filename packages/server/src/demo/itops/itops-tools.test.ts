/**
 * The IT Operations catalogue is a different set of DESCRIPTIONS over the SAME
 * endpoints — plus TWO tools the other tenants do not have. These tests are what
 * makes both halves of that claim checkable.
 *
 * Four things could go wrong and none of them would fail anywhere else:
 *
 *   · A shared tool could drift onto a different URL, method or auth style from
 *     the HR, Finance or Legal tool of the same name, so "same service, same
 *     credential" quietly stops being true and the demo 401s in front of
 *     somebody. With four tenants the parity check is four-way.
 *   · An `hr_*` tool could be added here, handing an IT Operations flow a
 *     network route into another tenant's employee directory — a cross-tenant
 *     read that no datasource boundary catches, because it does not go through a
 *     datasource.
 *   · The catalogue could become a FILTER over Legal's, at which point a drafter
 *     reads Legal's channels and templates and writes a flow that 404s.
 *   · ⚠ THE PAGING CAPABILITY COULD LEAK. `page_oncall` is the only tool in this
 *     product that wakes a person, and the control that keeps it out of Finance
 *     and Legal is that neither holds a `PAGING_API_TOKEN`. If it appeared in
 *     another catalogue, or if this one stopped being the only holder, the
 *     asymmetry that makes the capability meaningful would be gone with nothing
 *     else reporting it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoToolCatalogue } from "../tool-catalogue.js";
import { financeToolCatalogue } from "../finance/finance-tools.js";
import { legalToolCatalogue, LEGAL_OPS_SERVICES } from "../legal/legal-tools.js";
import { itopsToolCatalogue, ITOPS_OPS_SERVICES } from "./itops-tools.js";
import { OPS_SECRET_ENV } from "../../services/ops-client.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const itops = itopsToolCatalogue();
const hrByName = new Map(demoToolCatalogue().map((t) => [t.name, t]));
const financeByName = new Map(financeToolCatalogue().map((t) => [t.name, t]));
const legalByName = new Map(legalToolCatalogue().map((t) => [t.name, t]));

/** The two this domain adds. Everything else must have a counterpart everywhere. */
const PAGING_TOOLS = ["page_oncall", "page_search"];
const shared = itops.filter((t) => !PAGING_TOOLS.includes(t.name));

describe("the IT Operations tool catalogue", () => {
  it("holds Legal's seven tools plus exactly the two paging ones", () => {
    expect(shared.map((t) => t.name).sort()).toEqual([...legalByName.keys()].sort());
    expect(itops.map((t) => t.name).filter((n) => PAGING_TOOLS.includes(n)).sort()).toEqual(
      [...PAGING_TOOLS].sort(),
    );
    expect(itops).toHaveLength(9);
  });

  it("registers no hr_* tool", () => {
    const leaked = itops.filter((t) => t.name.startsWith("hr_")).map((t) => t.name);
    expect(leaked, "an hr_* tool here is a cross-tenant read over HTTP").toEqual([]);
  });

  it("holds no credential for the HR directory service", () => {
    expect(ITOPS_OPS_SERVICES).not.toContain("hr");
    expect(itops.map((t) => t.secretEnvName)).not.toContain(OPS_SECRET_ENV.hr);
  });

  /**
   * ⚠ THE ASYMMETRY IS THE CONTROL, so it is asserted in both directions.
   *
   * Paging is the only capability in this product that costs a person their
   * sleep. Finance and Legal must not have it, and must not be able to acquire
   * it by a hand-written tool row either — which is what "holds no credential"
   * buys: the endpoint 401s rather than 404s, so the refusal is at the service
   * and not at the catalogue.
   */
  it("is the ONLY tenant that can wake somebody", () => {
    expect(ITOPS_OPS_SERVICES).toContain("paging");
    expect(LEGAL_OPS_SERVICES).not.toContain("paging");
    for (const [tenant, cat] of [
      ["HR", demoToolCatalogue()],
      ["Finance", financeToolCatalogue()],
      ["Legal", legalToolCatalogue()],
    ] as const) {
      const paging = cat.filter((t) => PAGING_TOOLS.includes(t.name)).map((t) => t.name);
      expect(paging, `${tenant} must not be able to page anybody`).toEqual([]);
      expect(
        cat.map((t) => t.secretEnvName),
        `${tenant} must hold no paging credential`,
      ).not.toContain(OPS_SECRET_ENV.paging);
    }
  });

  it("points every SHARED tool at the same endpoint, method and auth as the other three", () => {
    // An exact per-field comparison against all three other tenants, because a
    // tool that 401s or 404s is a demo failing in front of somebody, and a
    // four-way agreement is what makes "same service" a property rather than a
    // coincidence.
    for (const t of shared) {
      for (const [tenant, twin] of [
        ["HR", hrByName.get(t.name)],
        ["Finance", financeByName.get(t.name)],
        ["Legal", legalByName.get(t.name)],
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

  it("declares the same parameters as the other three for every shared tool", () => {
    // The prose differs on purpose; the interface must not. A drafter reading a
    // `recipients` that HR calls `to` would write a flow that 400s.
    for (const t of shared) {
      const mine = Object.keys(t.paramsSchema ?? {}).sort();
      for (const [tenant, m] of [
        ["HR", hrByName],
        ["Finance", financeByName],
        ["Legal", legalByName],
      ] as const) {
        expect(mine, `${t.name} parameters vs ${tenant}`).toEqual(
          Object.keys(m.get(t.name)!.paramsSchema ?? {}).sort(),
        );
      }
    }
  });

  it("describes IT OPERATIONS channels and templates, not another tenant's", () => {
    // The whole reason this catalogue exists rather than a filter over another's.
    const chat = itops.find((t) => t.name === "chat_post_message")!.description!;
    expect(chat).toContain("#it-incidents");
    expect(chat).toContain("#it-changes");
    expect(chat).not.toContain("#legal-ops");
    expect(chat).not.toContain("#ap-alerts");
    expect(chat).not.toContain("#hr-ops");

    const tpl = itops.find((t) => t.name === "mail_send_template")!.description!;
    expect(tpl).toContain("sla_at_risk_warning");
    expect(tpl).toContain("freeze_deferral_notice");
    expect(tpl).not.toContain("renewal_notice");
    expect(tpl).not.toContain("invoice_chase");
    expect(tpl).not.toContain("attendance_warning");
  });

  /**
   * ⚠ THIS DOMAIN'S WORST FAILURE MODE, and the prose is the only place a
   * drafting model meets it: sending an EMAIL where a PAGE was needed. The run
   * goes green, the message is delivered, and the incident is unattended. If
   * this assertion is deleted the warning can be edited away and nothing else
   * notices.
   */
  it("says, in the tool prose, that an email does not wake anybody", () => {
    const mail = itops.find((t) => t.name === "mail_send")!.description!;
    expect(mail).toMatch(/does not wake anybody/i);
    expect(mail).toMatch(/unattended/i);
    const tpl = itops.find((t) => t.name === "mail_send_template")!.description!;
    expect(tpl).toMatch(/NO TEMPLATE FOR A BREACH/i);
  });

  /**
   * ⚠ The suppression rule, and the specific way a model gets it wrong: passing
   * a key that differs every run. That suppresses nothing while looking as
   * though the feature is in use, so the prose has to name the incident code.
   */
  it("tells a flow how deduplication works and what breaks it", () => {
    const page = itops.find((t) => t.name === "page_oncall")!.description!;
    expect(page).toMatch(/dedupe_key/);
    expect(page).toMatch(/INCIDENT CODE, never a timestamp/i);
    expect(page).toMatch(/suppressed/i);
    // And that the outcome is in the body rather than the status code, or a
    // flow branches on an exception that never arrives.
    expect(page).toMatch(/no_responder/);
    expect(page).toMatch(/NOBODY WAS WOKEN/i);
    expect(page).toMatch(/retry/i);
  });

  it("reserves paging for a BREACH and points at ticket_create for the rest", () => {
    const page = itops.find((t) => t.name === "page_oncall")!.description!;
    expect(page).toMatch(/breached its resolve budget/i);
    expect(page).toMatch(/ticket_create/);
    const ticket = itops.find((t) => t.name === "ticket_create")!.description!;
    expect(ticket).toMatch(/wakes nobody/i);
  });

  it("holds a credential for every service its tools authenticate against", () => {
    const used = new Set(itops.map((t) => t.secretEnvName));
    const held = new Set(ITOPS_OPS_SERVICES.map((s) => OPS_SECRET_ENV[s]));
    for (const name of used) {
      expect(held.has(name!), `${name} is used by a tool but never seeded`).toBe(true);
    }
  });

  it("is a catalogue in its own right, not a filter over another tenant's", () => {
    // Read off disk: the property is the ABSENCE of a call, which is not
    // observable at runtime.
    //
    // ⚠ Asserted over the IMPORT LINES ONLY. The docblock names
    // `legalToolCatalogue()` deliberately, to explain why this is not a filter
    // over it — so a whole-file check makes the honest explanation the thing
    // that fails, and the cheapest way to go green is to delete the explanation.
    // You cannot call what you have not imported. (I-62's lesson, applied.)
    const src = readFileSync(join(here, "itops-tools.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
    expect(imports.join("\n")).not.toMatch(/legal|finance|tool-catalogue|hr-dataset/);
    // Control: the import scan can actually find something.
    expect(imports.length).toBeGreaterThan(2);
    expect(src).toContain("itopsToolCatalogue");
    expect(src.length).toBeGreaterThan(4000);
  });
});
