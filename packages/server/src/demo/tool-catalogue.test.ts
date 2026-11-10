import { describe, expect, it } from "vitest";
import { demoToolCatalogue } from "./tool-catalogue.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, type OpsService } from "../services/ops-client.service.js";

/**
 * Stage 5's central claim about the tool layer, as an assertion.
 *
 * Before Stage 5, three of fourteen tools authenticated. The reason recorded at
 * the time was that one broken credential should not take the whole demo down —
 * a defensible trade for routes inside the parent process, and the wrong one
 * for a service on its own port. The result was that the credential path (secret
 * storage → manifest `<auth>` → injection at execution → a correctly signed
 * request) was exercised by 21% of the catalogue.
 *
 * These tests exist because that is a property of a LIST, and a list quietly
 * loses an entry. A tool added without auth would otherwise be caught
 * only by someone re-reading the catalogue — which is why `http_request`
 * (fixed-URL POST, deliberately credential-less) is carved out BY NAME in the
 * rules below rather than by loosening them.
 */
describe("the demo tool catalogue authenticates", () => {
  const catalogue = demoToolCatalogue();

  it("registers 15 tools", () => {
    // 14 operational endpoints + `http_request` (a fixed-URL generic POST with no
    // credential). `llm_complete` is a PLATFORM tool now (platform-tool-catalogue),
    // registered for every workspace, so no demo catalogue carries it. The count is
    // asserted so that adding one is a deliberate act that passes through the rules below.
    expect(catalogue).toHaveLength(15);
  });

  it("marks both mail tools SIMULATED, so the drafter can tell them from the real sender", () => {
    /**
     * email-send-tool US5. `tether_email_send` sits in the same manifest as these
     * two and delivers to real mailboxes; these two deliver nothing. The names
     * (`mail_send` vs `tether_email_send`) do not carry that difference, and the
     * cost of confusing them is asymmetric — picking the simulated one wastes a
     * redraft, picking the real one emails a stranger.
     *
     * ⚠ The prefix is asserted at the START of the description, not merely present
     * in it. A caveat in the middle of a paragraph is a caveat a model may not
     * weight.
     */
    const mailTools = catalogue.filter((t) => t.name.startsWith("mail_send"));
    expect(mailTools.map((t) => t.name)).toEqual(["mail_send", "mail_send_template"]);
    for (const t of mailTools) {
      expect(String(t.description)).toMatch(/^SIMULATED \(demo mail service — nothing is delivered\)\./);
    }
  });

  it("gives every operational tool a secret and an auth style", () => {
    // `http_request` is the one deliberate exception: a fixed-URL POST with no
    // credential (`authStyle: null`). Named here so a second naked tool fails.
    const naked = catalogue.filter((t) => !t.secretEnvName || !t.authStyle);
    expect(naked.map((t) => t.name)).toEqual(["http_request"]);
  });

  it("points every ops-api tool at ops-api, never back at the parent", () => {
    // The move is only real if the registrations followed it. A tool still
    // pointing at `:4000/stub-api` would 404 — but one pointing at `:4000`
    // anything is the shape of the regression that matters: a tool call
    // terminating in the control plane. `http_request` is exempt by name: its
    // URL is fixed at seed time and deliberately external.
    const scoped = catalogue.filter((t) => t.name !== "http_request");
    const wrong = scoped.filter((t) => /:4000|\/stub-api/.test(String(t.url)));
    expect(wrong.map((t) => t.name)).toEqual([]);
    expect(scoped.every((t) => String(t.url).includes(":4004"))).toBe(true);
  });

  it("uses a style consistent with the service the URL names", () => {
    // The registration and the endpoint agree because both read one table. This
    // asserts that they still do — a hand-edited entry is exactly how a tool
    // ends up presenting `bearer` to an endpoint that reads a header, which
    // 401s with a correct credential.
    const serviceOf = (url: string): OpsService =>
      url.includes("/hr/")
        ? "hr"
        : url.includes("/mail/")
          ? "mail"
          : url.includes("/chat/")
            ? "chat"
            : url.includes("/llm/")
              ? "llm"
              : "ticketing";
    for (const t of catalogue.filter((t) => t.name !== "http_request")) {
      const service = serviceOf(String(t.url));
      expect(t.secretEnvName, t.name).toBe(OPS_SECRET_ENV[service]);
      expect(t.authStyle, t.name).toBe(OPS_AUTH_STYLE[service].style);
      expect(t.authParamName ?? null, t.name).toBe(OPS_AUTH_STYLE[service].paramName);
    }
  });

  it("covers three distinct auth styles across the catalogue", () => {
    // `basic` is the fourth and belongs to the probe, which is registered by
    // `showcase:seed` rather than here — deliberately, since a fifteenth tool
    // whose job is to fail would be a standing asterisk on every count
    // `demo:verify` and `demo:rehearse` report. Asserting THREE here rather
    // than four keeps that split honest instead of quietly counting a tool this
    // function does not return.
    // `http_request` carries `authStyle: null` by design (see above); it is
    // excluded by name so a second style-less tool still fails.
    const styles = new Set(
      catalogue.filter((t) => t.name !== "http_request").map((t) => t.authStyle),
    );
    expect([...styles].sort()).toEqual(["bearer", "header", "query"]);
  });

});
