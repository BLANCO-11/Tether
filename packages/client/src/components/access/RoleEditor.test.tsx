// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoleEditor } from "./RoleEditor";

const catalogue = { value: "ok" as "ok" | "error" };
const CATALOGUE = {
  permissions: [
    { key: "flows.read", tier: "workspace", label: "Read automations", description: "x".repeat(30) },
    { key: "secrets.read", tier: "workspace", label: "Read credential names", description: "x".repeat(30) },
    { key: "platform.users.read", tier: "platform", label: "Read the people list", description: "x".repeat(30) },
  ],
  presets: [],
  platformConfers: {},
  conferrable: [],
};
vi.mock("@/lib/foundry-client", () => ({
  foundryApi: {
    permissionCatalogue: () =>
      catalogue.value === "error" ? Promise.reject(new Error("down")) : Promise.resolve(CATALOGUE),
  },
}));

// The author holds `flows.read` and NOT `secrets.read`.
vi.mock("@/lib/permissions", () => ({
  usePermissions: () => ({
    data: {
      workspaceId: "ws-1",
      permissions: ["flows.read"],
      provenance: {},
      memberRole: "author",
      superAdmin: false,
      platformRoles: [],
      platformPermissions: [],
    },
    loading: false,
    error: null,
    can: (p: string) => (p === "flows.read" ? "allowed" : "denied"),
    why: () => [],
    refresh: () => {},
  }),
}));

beforeEach(() => {
  catalogue.value = "ok";
  vi.clearAllMocks();
});
afterEach(cleanup);

/**
 * Open every band.
 *
 * ⚠ **A CLOSED BAND'S CHECKBOXES ARE NOT IN THE DOM**, deliberately — see
 * `PermissionBand`. So this is not ceremony: without it, every assertion below would be
 * asserting over an absence, and `queryByLabelText(...)` returning null would prove
 * nothing about filtering. Each test that reads a checkbox opens the bands first.
 */
async function expandBands() {
  const heads = await screen.findAllByRole("button", { expanded: false });
  for (const h of heads) fireEvent.click(h);
  return heads.length;
}

describe("RoleEditor — the catalogue is the server's", () => {
  it("offers every WORKSPACE permission the server named, and no platform one", async () => {
    render(<RoleEditor onSave={() => {}} />);
    // CONTROL — the bands rendered at all, and opening them is what puts the
    // checkboxes on screen.
    expect(await expandBands()).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    expect(screen.getByLabelText("Read credential names")).toBeTruthy();
    // ⚠ INV-8 — a workspace role can never carry a platform permission, so it is not
    // even offered. The server also refuses it, and so does a CHECK constraint.
    expect(screen.queryByLabelText("Read the people list")).toBeNull();
  });

  /**
   * ⚠ FR-009 — DISABLED, NOT HIDDEN. Hiding would leave somebody composing a role and
   * quietly wondering why a permission they have seen elsewhere is not on the list.
   */
  it("shows a permission the author does not hold as DISABLED, with the reason", async () => {
    render(<RoleEditor onSave={() => {}} />);
    await expandBands();
    await waitFor(() => expect(screen.getByLabelText("Read credential names")).toBeTruthy());
    expect((screen.getByLabelText("Read credential names") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("blocked-secrets.read")).toBeTruthy();
    // CONTROL: one they DO hold is enabled.
    expect((screen.getByLabelText("Read automations") as HTMLInputElement).disabled).toBe(false);
  });

  it("⚠ the reason never lists what the author DOES hold", async () => {
    render(<RoleEditor onSave={() => {}} />);
    await expandBands();
    await waitFor(() => expect(screen.getByTestId("blocked-secrets.read")).toBeTruthy());
    expect(screen.getByTestId("blocked-secrets.read").textContent).not.toContain("flows.read");
  });

  it("saves the name, description and chosen permissions", async () => {
    const onSave = vi.fn();
    render(<RoleEditor onSave={onSave} />);
    await expandBands();
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Finance Reviewer" } });
    fireEvent.click(screen.getByLabelText("Read automations"));
    fireEvent.click(screen.getByText("Save role"));
    expect(onSave).toHaveBeenCalledWith({
      name: "Finance Reviewer",
      description: "",
      permissions: ["flows.read"],
    });
  });

  it("refuses to save a role with no name or no permissions", async () => {
    render(<RoleEditor onSave={() => {}} />);
    await waitFor(() => expect(screen.getByText("Save role")).toBeTruthy());
    expect((screen.getByText("Save role") as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * ⚠ The third state. An empty list would say "there are no permissions", which is a
   * claim nobody made.
   */
  it("an unreadable catalogue says the check did not run, NOT that there are none", async () => {
    catalogue.value = "error";
    render(<RoleEditor onSave={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("catalogue-unreadable")).toBeTruthy());
    expect(screen.getByText(/not a statement that there are no permissions/i)).toBeTruthy();
    expect(screen.queryByText("Save role")).toBeNull();
  });

  /**
   * ⚠ **A BAND ALREADY CARRYING A CHOICE STARTS OPEN, and the empty case is the control.**
   * Editing an existing role behind a closed head hides the very thing being edited — the
   * count would say `1 of 2` and the box producing that 1 would be a click away. A new
   * role has chosen nothing, so nothing opens.
   */
  it("a band holding an already-chosen permission starts OPEN; an empty one starts closed", async () => {
    const { unmount } = render(
      <RoleEditor initialPermissions={["flows.read"]} onSave={() => {}} />,
    );
    // Open, so the box is on screen with no click at all.
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    expect((screen.getByLabelText("Read automations") as HTMLInputElement).checked).toBe(true);
    unmount();

    // CONTROL — nothing chosen, so the same band is closed and the same box is absent.
    render(<RoleEditor onSave={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("permission-band-ungrouped")).toBeTruthy());
    expect(screen.queryByLabelText("Read automations")).toBeNull();
  });

  /**
   * ⚠ **A CLOSED BAND STILL SAYS SOMETHING TRUE.** Collapsing may remove detail and must
   * never remove evidence: the count is in the head, so a closed band reads as "two here,
   * none chosen" rather than as an absence.
   */
  it("a closed band still carries its count and its hint", async () => {
    render(<RoleEditor onSave={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("permission-band-ungrouped")).toBeTruthy());
    const band = screen.getByTestId("permission-band-ungrouped");
    expect(band.textContent).toContain("0 of 2");
    expect(band.textContent).toMatch(/No built-in role carries these/);
    // …and the disclosure declares its own state to a screen reader.
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  });
});
