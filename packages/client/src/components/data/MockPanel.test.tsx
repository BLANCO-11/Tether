// @vitest-environment jsdom
//
// MockPanel — the four mock states plus the unreadable fifth. An unreadable
// read is never rendered as any readiness, and "no fixture row" (never
// onboarded) is never rendered as "failed".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// ⚠ `vi.mock` is a WHOLE-MODULE replacement: every function this component
// imports must appear here or it arrives as `undefined`. Omitting one is how
// `tools/page.test.tsx` once failed all 27 of its tests at once. Adding a read
// or an action to MockPanel means adding it here too.
vi.mock("@/lib/api", () => ({ getDatasourceMock: vi.fn(), rebuildDatasourceMock: vi.fn() }));
import { getDatasourceMock, rebuildDatasourceMock } from "@/lib/api";
import { MockPanel } from "./MockPanel";

const mock = vi.mocked(getDatasourceMock);
const rebuild = vi.mocked(rebuildDatasourceMock);

afterEach(() => {
  cleanup();
  mock.mockReset();
  rebuild.mockReset();
  vi.unstubAllGlobals();
});

describe("MockPanel", () => {
  it("says it is checking while the read is in flight", () => {
    const promise = new Promise<never>(() => {});
    mock.mockReturnValue(promise);
    render(<MockPanel datasourceId="d1" />);
    expect(screen.getByText("Checking mock data…")).toBeTruthy();
  });
  it("an unreadable read says the check did not run — never a readiness", async () => {
    mock.mockRejectedValue(new Error("workspace unreachable"));
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
    expect(screen.queryByText(/Mock data is ready/)).toBeNull();
    expect(screen.queryByText(/still building|Building mock/)).toBeNull();
    expect(screen.queryByText(/could not be built/)).toBeNull();
  });

  it("no fixture row is 'not yet', not 'failed'", async () => {
    mock.mockResolvedValue({ status: null, error: null, version: null, fingerprint: null });
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/No mock data has been built/)).toBeTruthy());
    expect(screen.queryByText(/could not be built/)).toBeNull();
  });

  // ⚠ Was "building names the wait and the CLI-only rebuild", asserting the
  // sentence "Rebuilding is an operator (CLI) action, not a button here". That
  // sentence is gone (2026-09-17) — the button exists. The half of this test
  // that was about the WAIT is unchanged and still the point: a person looking
  // at a build in flight needs to know it is in flight.
  it("building names the wait, and still offers the rebuild", async () => {
    mock.mockResolvedValue({ status: "building", error: null, version: null, fingerprint: null });
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/Building mock data/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy();
  });

  it("failed names the server's reason, and refuses silently reading prod", async () => {
    mock.mockResolvedValue({ status: "failed", error: "too many tables", version: null, fingerprint: null });
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/could not be built/)).toBeTruthy());
    expect(screen.getByText(/too many tables/)).toBeTruthy();
    expect(screen.getByText(/never silently read production/)).toBeTruthy();
  });

  it("ready names the version and the schema-only provenance", async () => {
    mock.mockResolvedValue({ status: "ready", error: null, version: 3, fingerprint: "abc" });
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/Mock data is ready/)).toBeTruthy());
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/schema alone/)).toBeTruthy();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The rebuild button.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ It exists because the panel used to say "Rebuilding is an operator (CLI)
 * action, not a button here" — including on the `failed` state, where it left a
 * person reading that test runs would refuse until the mock was fixed, with no
 * way to fix it short of shell access. That state is the reason for the feature,
 * so it is the one asserted first.
 */
describe("MockPanel — rebuilding", () => {
  const ok = (confirmed: boolean) => vi.stubGlobal("confirm", vi.fn(() => confirmed));

  it("⚠ offers the rebuild on the FAILED state — the dead end it exists for", async () => {
    mock.mockResolvedValue({ status: "failed", error: "46 tables", version: null, fingerprint: null });
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByText(/could not be built/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy();
  });

  it("offers it on every other readable state too", async () => {
    for (const status of ["ready", "building", null] as const) {
      mock.mockResolvedValue({ status, error: null, version: 1, fingerprint: null });
      render(<MockPanel datasourceId="d1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
      cleanup();
    }
  });

  it("reports the version the SERVER returned, not that the click happened", async () => {
    mock.mockResolvedValue({ status: "failed", error: "x", version: null, fingerprint: null });
    rebuild.mockResolvedValue({ started: true, version: 7 });
    ok(true);
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
    screen.getByRole("button", { name: /Rebuild mock data/ }).click();
    await waitFor(() => expect(screen.getByText(/version 7/)).toBeTruthy());
  });

  it("⚠ renders a DECLINE as its reason, never as a failure or a success", async () => {
    // A decline is a state of the datasource and comes back 200. Reporting it as
    // a failure sends somebody to retry a button that cannot work here; reporting
    // it as a success is the false green.
    mock.mockResolvedValue({ status: null, error: null, version: null, fingerprint: null });
    rebuild.mockResolvedValue({ started: false, why: "not_postgres" });
    ok(true);
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
    screen.getByRole("button", { name: /Rebuild mock data/ }).click();
    await waitFor(() => expect(screen.getByText(/only built for PostgreSQL and SQLite/)).toBeTruthy());
    expect(screen.queryByText(/rebuilt \(version/)).toBeNull();
  });

  it("⚠ names the raw code for a reason this build has never heard of", async () => {
    // D-66's ranking: an unknown state must not borrow the words of a known one.
    mock.mockResolvedValue({ status: null, error: null, version: null, fingerprint: null });
    rebuild.mockResolvedValue({ started: false, why: "brand_new_reason" });
    ok(true);
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
    screen.getByRole("button", { name: /Rebuild mock data/ }).click();
    await waitFor(() => expect(screen.getByText(/brand_new_reason/)).toBeTruthy());
  });

  it("does NOT rebuild when the confirmation is declined", async () => {
    mock.mockResolvedValue({ status: "ready", error: null, version: 2, fingerprint: null });
    ok(false);
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
    screen.getByRole("button", { name: /Rebuild mock data/ }).click();
    await waitFor(() => expect(rebuild).not.toHaveBeenCalled());
  });

  it("surfaces a thrown error instead of reporting success", async () => {
    mock.mockResolvedValue({ status: "ready", error: null, version: 2, fingerprint: null });
    rebuild.mockRejectedValue(new Error("forbidden"));
    ok(true);
    render(<MockPanel datasourceId="d1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
    screen.getByRole("button", { name: /Rebuild mock data/ }).click();
    await waitFor(() => expect(screen.getByText(/forbidden/)).toBeTruthy());
  });

  it("⚠ no longer claims rebuilding is CLI-only anywhere", async () => {
    for (const status of ["ready", "failed", "building", null] as const) {
      mock.mockResolvedValue({ status, error: "e", version: 1, fingerprint: null });
      render(<MockPanel datasourceId="d1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /Rebuild mock data/ })).toBeTruthy());
      expect(document.body.textContent).not.toContain("operator (CLI)");
      cleanup();
    }
  });
});

/**
 * ── 2026-09-17 — the control names its own scope ────────────────────────────
 *
 * Reported from use as *"we only regenerate using a button for a selected
 * table"*. It never was table-scoped: `POST /:dsId/mock/rebuild` is the only
 * mock route and takes no table. The layout is what misled — this panel sits
 * directly above `MockViewer`'s `Table ▾` picker — so the fix is the label.
 */
describe("MockPanel — the rebuild's scope is stated", () => {
  it("names the table count when the page supplies one", async () => {
    mock.mockResolvedValue({ status: "ready", version: 3, error: null, fingerprint: null });
    render(<MockPanel datasourceId="ds1" tableCount={46} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Rebuild mock data for all 46 tables/ })).toBeTruthy(),
    );
  });

  it("confirms against the same scope it advertises", async () => {
    mock.mockResolvedValue({ status: "ready", version: 3, error: null, fingerprint: null });
    const confirmed = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirmed);
    render(<MockPanel datasourceId="ds1" tableCount={46} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /all 46 tables/ })).toBeTruthy(),
    );
    screen.getByRole("button", { name: /all 46 tables/ }).click();
    await waitFor(() => expect(confirmed).toHaveBeenCalled());
    expect(confirmed.mock.calls[0]![0]).toContain("all 46 tables");
    // ⚠ And it really did not fire: a confirm answered `false` must not rebuild.
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("falls back to the scope-free wording when no count is supplied", async () => {
    // ⚠ NOT "all 0 tables". The count is the page's to know; a panel used
    // without one must not claim a number it does not have (D-66).
    mock.mockResolvedValue({ status: "ready", version: 3, error: null, fingerprint: null });
    render(<MockPanel datasourceId="ds1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Rebuild mock data$/ })).toBeTruthy());
  });

  it("says ONE table without the plural", async () => {
    mock.mockResolvedValue({ status: "ready", version: 3, error: null, fingerprint: null });
    render(<MockPanel datasourceId="ds1" tableCount={1} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Rebuild mock data for all 1 table$/ })).toBeTruthy(),
    );
  });
});
