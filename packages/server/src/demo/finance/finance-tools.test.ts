/**
 * The Finance catalogue is a different set of DESCRIPTIONS over the SAME
 * endpoints — these tests are what makes that claim checkable.
 *
 * Two things could go wrong and neither would fail anywhere else. A Finance tool
 * could drift onto a different URL, method or auth style from the HR tool of the
 * same name, so "same service, same credential" quietly stops being true. Or an
 * `hr_*` tool could be added here, handing a Finance flow a network route into
 * another tenant's employee directory — a cross-tenant read that no datasource
 * boundary catches, because it does not go through a datasource.
 */
import { describe, expect, it } from "vitest";
import { demoToolCatalogue } from "../tool-catalogue.js";
import { financeToolCatalogue, FINANCE_OPS_SERVICES } from "./finance-tools.js";
import { OPS_SECRET_ENV } from "../../services/ops-client.service.js";

const finance = financeToolCatalogue();
const hr = demoToolCatalogue();
const hrByName = new Map(hr.map((t) => [t.name, t]));

describe("the Finance tool catalogue", () => {
  it("registers no hr_* tool", () => {
    const leaked = finance.filter((t) => t.name.startsWith("hr_")).map((t) => t.name);
    expect(leaked, "an hr_* tool in Finance is a cross-tenant read over HTTP").toEqual([]);
  });

  it("holds no credential for the HR directory service", () => {
    expect(FINANCE_OPS_SERVICES).not.toContain("hr");
    const envNames = finance.map((t) => t.secretEnvName);
    expect(envNames).not.toContain(OPS_SECRET_ENV.hr);
  });

  it("points every shared tool at the same endpoint, method and auth as HR's", () => {
    // Not a subset check — an exact per-field comparison, because a Finance tool
    // that 401s or 404s is a demo that fails in front of somebody.
    for (const t of finance) {
      const twin = hrByName.get(t.name);
      expect(twin, `${t.name} has no HR counterpart — is it a new endpoint?`).toBeDefined();
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
  });

  it("declares the same parameters as HR's for every shared tool", () => {
    // The prose differs on purpose; the interface must not. A Finance drafter
    // reading a `recipients` that HR calls `to` would write a flow that 400s.
    for (const t of finance) {
      const twin = hrByName.get(t.name)!;
      expect(Object.keys(t.paramsSchema ?? {}).sort(), `${t.name} parameters`).toEqual(
        Object.keys(twin.paramsSchema ?? {}).sort(),
      );
    }
  });

  it("describes finance channels and templates, not HR's", () => {
    // The whole reason this catalogue exists rather than a filter over HR's.
    const chat = finance.find((t) => t.name === "chat_post_message")!;
    expect(chat.description).toContain("#ap-alerts");
    expect(chat.description).not.toContain("#hr-ops");

    const tpl = finance.find((t) => t.name === "mail_send_template")!;
    expect(tpl.description).toContain("invoice_chase");
    expect(tpl.description).not.toContain("attendance_warning");
  });

  it("holds a credential for every service its tools authenticate against", () => {
    const used = new Set(finance.map((t) => t.secretEnvName));
    const held = new Set(FINANCE_OPS_SERVICES.map((s) => OPS_SECRET_ENV[s]));
    for (const name of used) {
      expect(held.has(name!), `${name} is used by a tool but never seeded`).toBe(true);
    }
  });
});
