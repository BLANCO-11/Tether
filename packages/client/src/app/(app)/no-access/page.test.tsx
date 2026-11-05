// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as api from "@/lib/api";
import NoAccessPage from "./page";

vi.mock("@/lib/api", () => ({ getMe: vi.fn(), listWorkspaces: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const me = (over: Partial<{ superAdminConfigured: boolean }> = {}) => ({
  subject: "oid-x",
  email: "nobody@acme-hr.example",
  superAdmin: false,
  superAdminConfigured: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/**
 * FR-016 / SC-013 — the page exists so that being refused is not a DEAD END.
 *
 * Before this feature a person with no grant met a workspace switcher with nothing in it
 * and no explanation, which reads as a broken product rather than as a permission they
 * have not been given.
 */
describe("the no-access page names the next step", () => {
  it("⚠ NEVER an empty picker — with no workspaces it says who can grant access", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me() as never);
    vi.mocked(api.listWorkspaces).mockResolvedValue([]);
    render(<NoAccessPage />);
    await waitFor(() =>
      expect(screen.getByText(/do not have access to any workspace/i)).toBeTruthy(),
    );
    expect(screen.getByText(/super-admin list/i)).toBeTruthy();
    expect(screen.queryByTestId("no-access-workspaces")).toBeNull();
  });

  /**
   * ⚠ **TWO REFUSALS, TWO ACTIONS.** One is a person; the other is an environment
   * variable on the API server. A single shared sentence sends somebody looking for an
   * administrator who does not exist.
   */
  it("with NO super admin configured, it names the variable instead of a person", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdminConfigured: false }) as never);
    vi.mocked(api.listWorkspaces).mockResolvedValue([]);
    render(<NoAccessPage />);
    await waitFor(() => expect(screen.getByText(/SUPER_ADMIN_EMAILS/)).toBeTruthy());
    expect(screen.getByText(/nobody can grant access yet/i)).toBeTruthy();
  });

  it("with workspaces visible, it offers them rather than explaining the deployment", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me() as never);
    vi.mocked(api.listWorkspaces).mockResolvedValue([
      { id: "ws-1", name: "Finance" },
    ] as never);
    render(<NoAccessPage />);
    await waitFor(() => expect(screen.getByTestId("no-access-workspaces")).toBeTruthy());
    expect(screen.getByText("Finance")).toBeTruthy();
    expect(screen.queryByText(/SUPER_ADMIN_EMAILS/)).toBeNull();
  });

  /**
   * ⚠ The third state, on the page whose entire job is explaining a refusal. Telling
   * somebody they have been refused when the truth is that the check did not run is the
   * failure this repo keeps writing down.
   */
  it("a failed read says the check did not run — NOT that you have no access", async () => {
    vi.mocked(api.getMe).mockRejectedValue(new Error("api down"));
    vi.mocked(api.listWorkspaces).mockResolvedValue([]);
    render(<NoAccessPage />);
    await waitFor(() => expect(screen.getByText(/could not check your access/i)).toBeTruthy());
    expect(screen.getByText(/not a statement about what you can do/i)).toBeTruthy();
    expect(screen.queryByText(/do not have access to any workspace/i)).toBeNull();
  });

  it("CONTROL: it renders something in every state — no blank screen", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me() as never);
    vi.mocked(api.listWorkspaces).mockResolvedValue([]);
    const { container } = render(<NoAccessPage />);
    await waitFor(() => expect(container.textContent!.length).toBeGreaterThan(40));
  });
});
