// @vitest-environment jsdom
/**
 * What a TEST run of this datasource reads, and the four answers to it.
 *
 * -----------------------------------------------------------------------------
 * WARNING: THREE OF THE FOUR MEAN "READS PRODUCTION", AND THEY ARE NOT THE SAME
 * -----------------------------------------------------------------------------
 *
 *   no sandbox      nobody has asked for one
 *   building        one is being generated, and this run still reads production
 *   failed          one was attempted and did not work, and here is why
 *   sandbox         a draft run reads fixtures
 *
 * Collapsing the middle two into the first is the deleted `faFallback` shape --
 * an absence standing in for an error -- and it is the specific regression
 * these tests exist to catch. The three "reads production" states must ALL
 * carry the exposure sentence, including while a build is running: that is the
 * moment it is most likely to be read and easiest to suppress by accident.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SandboxPanel } from "./SandboxPanel";

vi.mock("@/lib/api", () => ({ getDatasourceSandbox: vi.fn() }));
import * as api from "@/lib/api";
const getDatasourceSandbox = vi.mocked(api.getDatasourceSandbox);

const EXPOSURE =
  'no sandbox is provisioned for "hr_demo", so a DRAFT (test) run of any flow that reads it reads PRODUCTION data';

const base = {
  datasourceId: "d1",
  datasourceName: "hr_demo",
  hasSandbox: false,
  dbName: null,
  fixtureVersion: null,
  frozenAt: null,
  generatedBy: null,
  model: null,
  taxonomy: null,
  dateRange: null,
  drift: null,
  buildStatus: null as "building" | "ready" | "failed" | null,
  buildError: null as string | null,
  buildStartedAt: null as string | null,
  exposure: EXPOSURE,
};

beforeEach(() => getDatasourceSandbox.mockReset());
// ⚠ Without this every render accumulates in one body and the "not.toContain"
// assertions read the PREVIOUS test's output — they passed for the wrong
// reason before it was added, which is the shape this whole file is about.
afterEach(() => cleanup());

describe("the three ways a datasource reads production", () => {
  it("no sandbox — the exposure sentence, verbatim, and no build language", async () => {
    getDatasourceSandbox.mockResolvedValue({ ...base });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(new RegExp(EXPOSURE.slice(0, 40)))).toBeTruthy());
    expect(document.body.textContent).toContain("production data");
    expect(document.body.textContent).not.toContain("Building a synthetic copy");
    expect(document.body.textContent).not.toContain("could not be built");
  });

  it("building — says so, AND still says a test run reads production", async () => {
    getDatasourceSandbox.mockResolvedValue({ ...base, buildStatus: "building" });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("Building a synthetic copy"));
    // The half that is easy to lose: a build in progress is not a sandbox.
    expect(screen.getByText(new RegExp(EXPOSURE.slice(0, 40)))).toBeTruthy();
    // And it states where the rows come from, because "synthetic" is the claim
    // people will repeat and the generator never sees real data.
    expect(document.body.textContent).toContain("schema only");
  });

  it("failed — renders the REASON, and is not silently the same as no sandbox", async () => {
    getDatasourceSandbox.mockResolvedValue({
      ...base,
      buildStatus: "failed",
      buildError: "31 tables — an automatic build is capped at 25",
    });
    render(<SandboxPanel datasourceId="d1" />);
    // ⚠ The wording moved from "could not be built" to "did not finish" on
    // 2026-09-17, when the failure stopped being its own danger-red panel above
    // the exposure and became a reason attached to it. The PROPERTY is
    // unchanged and is what this test is for: a failed build still says a build
    // was attempted, still gives the reason, and still carries the exposure —
    // the three facts the old two-box version rendered, minus the duplication.
    await waitFor(() => expect(document.body.textContent).toContain("did not finish"));
    expect(document.body.textContent).toContain("capped at 25");
    expect(screen.getByText(new RegExp(EXPOSURE.slice(0, 40)))).toBeTruthy();
    // ⚠ And the exposure appears ONCE. Two boxes both ending on "a draft run
    // reads production" read as two problems; that is the defect being closed,
    // so it needs an assertion or it comes straight back.
    expect(screen.getAllByText(new RegExp(EXPOSURE.slice(0, 40)))).toHaveLength(1);
  });

  it("failed with no recorded reason still says a build was attempted", async () => {
    // "No reason was recorded" is worse than a reason and much better than
    // rendering the state as though nobody had ever asked.
    getDatasourceSandbox.mockResolvedValue({ ...base, buildStatus: "failed", buildError: null });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("did not finish"));
    expect(document.body.textContent).toContain("No reason was recorded");
  });

  it("a sandbox — fixtures, and the caveat that a green run is not a correct one", async () => {
    getDatasourceSandbox.mockResolvedValue({
      ...base,
      hasSandbox: true,
      buildStatus: "ready",
      dbName: "foundry_sbx_abc",
      fixtureVersion: 1,
      generatedBy: "model",
      frozenAt: "2026-09-04T16:52:44.360Z",
      dateRange: { from: "2026-07-01", to: "2026-09-04" },
      exposure: null,
    });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("foundry_sbx_abc"));
    expect(document.body.textContent).toContain(
      "A green run against fixtures does not mean the flow is correct against production",
    );
    // The window, because a flow asking for a period outside it reads zero rows
    // and looks broken — measured on the first real run.
    expect(document.body.textContent).toContain("2026-07-01");
  });

  it("unreadable — says the check did not run, and claims nothing either way", async () => {
    // ⚠ `…Once`, deliberately. Plain `mockRejectedValue` stores one rejected
    // promise on the mock; vitest's unhandled-rejection tracker sees it settle
    // before `useAsync` attaches its catch and fails the test with the
    // rejection itself — which reads as the component crashing rather than as
    // the test's own setup. Measured: identical assertions, red then green.
    getDatasourceSandbox.mockRejectedValueOnce(new Error("boom"));
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("Could not read the sandbox state"));
    expect(document.body.textContent).not.toContain("production data");
    expect(document.body.textContent).not.toContain("sandbox fixtures");
  });
});

/**
 * ⚠ **THE CRASH, 2026-09-17.** Reported from the datasource page as
 * `TypeError: can't access property "map", r.taxonomy.items is undefined`, which
 * took the whole page down rather than this panel.
 *
 * `datasource_fixtures.taxonomy_json` legitimately holds `{}` — every fixture
 * `mock-dataset.service.ts` writes carries it, because a mock dataset runs no
 * taxonomy. `{}` is truthy, so `data.taxonomy && …items.map` passed the guard
 * and threw. It had never fired before because the block is behind `hasSandbox`
 * and the only two datasources that had a sandbox both carried a model-written
 * report; making the mock-built ones usable is what walked the path.
 */
describe("a fixture with no taxonomy report", () => {
  const withSandbox = {
    hasSandbox: true,
    buildStatus: "ready" as const,
    dbName: "foundry_sbx_abc",
    fixtureVersion: 1,
    generatedBy: "mock",
    frozenAt: "2026-09-17T00:00:00.000Z",
    dateRange: null,
    exposure: null,
  };

  it("renders rather than crashing when `taxonomy` is an empty object", async () => {
    // ⚠ The literal shape off the database, not a tidied one. `{}` is what the
    // column holds and `{}` is what has to be survivable.
    // ⚠ `as never` and NOT a tidied fixture. The declared type says `taxonomy`
    // always carries `items`; the DATABASE says otherwise — 11 of 13 rows hold
    // `{}` — and the gap between those two is the entire bug. Making this
    // fixture typecheck by filling in `items` would test a shape that never
    // occurred and leave the one that crashed the page uncovered.
    getDatasourceSandbox.mockResolvedValue({ ...base, ...withSandbox, taxonomy: {} as never });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("foundry_sbx_abc"));
  });

  it("says no checks were recorded — an absent list must not read as a pass", async () => {
    getDatasourceSandbox.mockResolvedValue({ ...base, ...withSandbox, taxonomy: null });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("No edge-case checks were recorded"));
    // ⚠ And no tick anywhere: every satisfied category carries evidence (D-54)
    // precisely so a check nobody ran cannot look like one that passed.
    expect(document.body.textContent).not.toContain("✓");
  });

  it("CONTROL: a real report still renders its categories and evidence", async () => {
    getDatasourceSandbox.mockResolvedValue({
      ...base,
      ...withSandbox,
      generatedBy: "model",
      // Only `items` is read by this panel; `integrity`/`passed` are elsewhere
      // in the type and irrelevant here, so the cast keeps the fixture about
      // the one field under test.
      taxonomy: {
        items: [{ id: "empty_group", title: "a group with no members", evidence: "1 row of employees", satisfied: true }],
      } as never,
    });
    render(<SandboxPanel datasourceId="d1" />);
    await waitFor(() => expect(document.body.textContent).toContain("empty_group"));
    expect(document.body.textContent).toContain("1 row of employees");
    expect(document.body.textContent).not.toContain("No edge-case checks were recorded");
  });
});
