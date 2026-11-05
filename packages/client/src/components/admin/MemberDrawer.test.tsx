// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemberDrawer } from "./MemberDrawer";
import type { PermissionState } from "@/lib/permissions";

vi.mock("@/lib/api", () => ({
  listMembers: vi.fn(),
  grantMember: vi.fn(),
  revokeMember: vi.fn(),
  listPlatformUsers: vi.fn(async () => ({ users: [], caveat: "c" })),
  listMemberCapabilities: vi.fn(async () => []),
  grantMemberCapability: vi.fn(),
  revokeMemberCapability: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));

let writeState: PermissionState = "allowed";
vi.mock("@/lib/permissions", () => ({
  usePermissions: () => ({
    data: { workspaceId: "ws-1", permissions: [], provenance: {}, memberRole: "admin", superAdmin: false, platformRoles: [], platformPermissions: [] },
    loading: false,
    error: null,
    can: () => writeState,
    canPlatform: () => writeState,
    why: () => [],
    refresh: () => {},
  }),
}));

/**
 * ⚠ The catalogue is the server's, so it is mocked as the server's — **both tiers**.
 * Mocking only the workspace tier would make INV-9's assertion pass vacuously: a list
 * with no platform permissions in it cannot render one.
 */
let catalogueError: string | null = null;
vi.mock("@/components/access/permission-catalogue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/access/permission-catalogue")>();
  return {
    ...actual,
    usePermissionCatalogue: () => ({
      data: catalogueError
        ? null
        : {
            permissions: [
              { key: "flows.read", tier: "workspace", label: "Read automations", description: "" },
              { key: "members.read", tier: "workspace", label: "Read members", description: "" },
              { key: "members.grant", tier: "workspace", label: "Grant members", description: "" },
              { key: "platform.users.read", tier: "platform", label: "Read platform users", description: "" },
              { key: "platform.members.grant", tier: "platform", label: "Grant in any workspace", description: "" },
            ],
            presets: [
              { name: "author", permissions: ["flows.read"] },
              { name: "approver", permissions: ["flows.read"] },
              { name: "admin", permissions: ["flows.read", "members.read", "members.grant"] },
            ],
            platformConfers: {},
            conferrable: [],
          },
      loading: false,
      error: catalogueError,
      reload: () => {},
    }),
  };
});

const api = await import("@/lib/api");

const MEMBER = { id: "1", subject: "sub-1", email: "ada@x.test", role: "admin" as const, grantedBy: "sa" };
const SECOND = { id: "2", subject: "sub-2", email: "bob@x.test", role: "author" as const, grantedBy: "sa" };

beforeEach(() => {
  vi.clearAllMocks();
  writeState = "allowed";
  catalogueError = null;
  vi.mocked(api.listMemberCapabilities).mockResolvedValue([]);
  vi.mocked(api.listMembers).mockResolvedValue([MEMBER, SECOND] as never);
  vi.mocked(api.listPlatformUsers).mockResolvedValue({ users: [], caveat: "c" });
});
afterEach(cleanup);

const drawer = (over: Partial<Parameters<typeof MemberDrawer>[0]> = {}) => (
  <MemberDrawer
    workspaceId="ws-1"
    member={MEMBER}
    members={[MEMBER, SECOND]}
    onClose={() => {}}
    onChanged={() => {}}
    {...over}
  />
);

/**
 * Open every permission band.
 *
 * ⚠ **A CLOSED BAND'S CHECKBOXES ARE NOT IN THE DOM**, deliberately — see
 * `PermissionBand`. `hidden` would have kept every assertion in this file green without
 * anybody touching it, and that is exactly the objection: INV-9's
 * `not.toContain("platform.")` would then have passed over a *closed* drawer rather than
 * over a *filtered* one, which is a control that cannot fail (I-38). Opening first is
 * what keeps these assertions about what a person can see.
 */
async function expandBands() {
  const heads = await screen.findAllByRole("button", { expanded: false });
  for (const h of heads) fireEvent.click(h);
  return heads.length;
}

describe("MemberDrawer", () => {
  it("renders NOTHING when no member is open — there is no empty column any more", () => {
    const { container } = render(drawer({ member: null }));
    expect(container.firstChild).toBeNull();
  });

  it("opens with the clicked person's email, role and permissions", async () => {
    render(drawer());
    expect(screen.getByText("ada@x.test")).toBeTruthy();
    // The stored key stays `admin`; the screen shows its label (rbac-observability, 2026-10-15).
    expect(screen.getByTestId("member-drawer-role").textContent).toBe("Admin");
    await expandBands();
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("admin");
  });

  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(drawer({ onClose }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── INV-9 ──────────────────────────────────────────────────────────────────────────
  it("INV-9: no platform role and no platform.* permission appears in the drawer", async () => {
    const { container } = render(drawer());
    // ⚠ Every band OPEN, or the scan below passes over a closed drawer rather than over
    // a filtered one.
    expect(await expandBands()).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);

    // CONTROL — the scan can find a permission key at all. Without this, a drawer that
    // rendered NOTHING would satisfy the assertion below, and so would a typo in the
    // label the mock supplies.
    expect(screen.getByLabelText("Read members")).toBeTruthy();
    expect(container.textContent).toContain("Read automations");

    // CONTROL — the mocked catalogue really does carry platform permissions, so the
    // filter is doing work rather than passing over an absence.
    const { usePermissionCatalogue } = await import("@/components/access/permission-catalogue");
    const cat = usePermissionCatalogue();
    expect(cat.data!.permissions.some((p) => p.tier === "platform")).toBe(true);

    // The claim.
    expect(container.textContent).not.toContain("platform.");
    expect(screen.queryByLabelText("Read platform users")).toBeNull();
    expect(screen.queryByLabelText("Grant in any workspace")).toBeNull();
  });

  // ── INV-3 ──────────────────────────────────────────────────────────────────────────
  it("the permissions are BANDED by role, not one flat list", async () => {
    render(drawer());
    // ⚠ Asserted with every band CLOSED: the label, the hint and the count live in the
    // head, so collapsing removes detail and never removes evidence.
    await waitFor(() => expect(screen.getByTestId("permission-band-author")).toBeTruthy());
    // The mocked catalogue's presets: author={flows.read}, approver=+{}, admin=+{members.*}.
    expect(screen.getByTestId("permission-band-author")).toBeTruthy();
    expect(screen.getByTestId("permission-band-admin")).toBeTruthy();
    // ⚠ The band says what holding it MEANS, which is the whole reason for banding: the
    // presets are a union, and a flat list throws that away.
    expect(screen.getByTestId("permission-band-admin").textContent).toMatch(/holds everything above, plus/);
  });

  it("⚠ every workspace permission is still reachable — banding is a partition, not a filter", async () => {
    const { container } = render(drawer());
    await expandBands();
    await waitFor(() => expect(screen.getByLabelText("Read automations")).toBeTruthy());
    // CONTROL: the bands found something at all.
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(0);
    // Every workspace permission the catalogue named has a box. A banding that dropped
    // one would leave a permission the server enforces with nothing to tick — the exact
    // defect this area exists to close.
    expect(screen.getByLabelText("Read automations")).toBeTruthy();
    expect(screen.getByLabelText("Read members")).toBeTruthy();
    expect(screen.getByLabelText("Grant members")).toBeTruthy();
    expect(boxes.length).toBe(3);
  });

  /**
   * ⚠ **COLLAPSING REMOVES DETAIL AND MUST NEVER REMOVE EVIDENCE.** The count lives in
   * the head, so a closed band answers *"two here, both held"* — the question somebody
   * opens this drawer to ask — rather than reading as an absence. A disclosure that hid
   * the count would turn a closed drawer into a panel claiming nothing while looking
   * complete.
   */
  it("bands are closed until opened, and a closed one still carries its count", async () => {
    render(drawer());
    await waitFor(() => expect(screen.getByTestId("permission-band-admin")).toBeTruthy());

    // Closed: the member IS an admin, so the count says so with nothing on screen to read.
    expect(screen.getByTestId("permission-band-author").textContent).toContain("1 of 1");
    expect(screen.getByTestId("permission-band-admin").textContent).toContain("2 of 2");
    expect(screen.queryByLabelText("Grant members")).toBeNull();

    // Open it — and only it.
    const admin = screen.getByTestId("permission-band-admin").querySelector("button")!;
    fireEvent.click(admin);
    await waitFor(() => expect(screen.getByLabelText("Grant members")).toBeTruthy());
    expect(admin.getAttribute("aria-expanded")).toBe("true");
    // CONTROL — the other band did not open with it, so this is a per-band disclosure
    // and not one switch over the whole list.
    expect(screen.queryByLabelText("Read automations")).toBeNull();

    // …and it closes again.
    fireEvent.click(admin);
    await waitFor(() => expect(screen.queryByLabelText("Grant members")).toBeNull());
    expect(admin.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("permission-band-admin").textContent).toContain("2 of 2");
  });

  it("INV-3: the role dropdown offers the four PRESETS and nothing else", async () => {
    render(drawer());
    const select = screen.getByLabelText("Role") as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    // ⚠ EXACT, not a superset. A custom role held ALONGSIDE a preset would read here as
    // an alternative TO one, and switching somebody back to their preset would then
    // silently drop it — the resolver is a union with no subtraction.
    expect(values).toEqual(["viewer", "author", "approver", "admin"]);
  });

  it("the last-admin warning appears for the sole admin — and NOT for anybody else", async () => {
    // The sole admin, being demoted.
    const { unmount } = render(drawer({ members: [MEMBER, SECOND] }));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    await waitFor(() => expect(screen.getByTestId("last-admin-warning")).toBeTruthy());
    unmount();

    // CONTROL 1 — a second admin exists, so demoting this one is safe and says nothing.
    const twoAdmins = [MEMBER, { ...SECOND, role: "admin" as const }];
    const { unmount: u2 } = render(drawer({ members: twoAdmins }));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    expect(screen.queryByTestId("last-admin-warning")).toBeNull();
    u2();

    // CONTROL 2 — the person being edited is not an admin at all.
    render(drawer({ member: SECOND, members: [MEMBER, SECOND] }));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "approver" } });
    expect(screen.queryByTestId("last-admin-warning")).toBeNull();
  });

  it("an unreadable grants read says the check did not run, and shows the role bundle anyway", async () => {
    vi.mocked(api.listMemberCapabilities).mockRejectedValue(new Error("boom"));
    render(drawer());
    await waitFor(() => expect(screen.getByText("Granted capabilities could not be read")).toBeTruthy());
    await expandBands();
    // ⚠ NOT an empty list, and not a silent "no grants": the role bundle is still shown.
    expect(screen.getByLabelText("Read automations")).toBeTruthy();
    // …and it cannot be changed, because we do not know what is there to change.
    expect((screen.getByLabelText("Read members") as HTMLInputElement).disabled).toBe(true);
  });

  it("an unreadable catalogue says so rather than rendering an empty permission list", async () => {
    catalogueError = "down";
    render(drawer());
    await waitFor(() => expect(screen.getByText("The permission catalogue could not be read")).toBeTruthy());
    expect(screen.getByText(/not a statement that there are none/)).toBeTruthy();
  });

  it("without members.grant the role select and Save are DISABLED with the permission named", async () => {
    writeState = "denied";
    render(drawer());
    expect((screen.getByLabelText("Role") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId("members-write-denied").textContent).toContain("members.grant");
    // ⚠ Disabled, not hidden: a hidden control is indistinguishable from one that does
    // not exist, so the person has nothing to ask for and nobody to ask.
    expect(screen.getByRole("button", { name: "Save role changes" })).toBeTruthy();
  });

  it("an UNREADABLE grant check leaves the controls enabled and says the check did not run", async () => {
    writeState = "unreadable";
    render(drawer());
    expect((screen.getByLabelText("Role") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByTestId("members-write-unreadable")).toBeTruthy();
  });

  it("saving writes the ROLE only, and reports the diff", async () => {
    const onChanged = vi.fn();
    vi.mocked(api.grantMember).mockResolvedValue(undefined as never);
    render(drawer({ onChanged }));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role changes" }));
    await waitFor(() => expect(api.grantMember).toHaveBeenCalledWith("ws-1", { subject: "sub-1", email: "ada@x.test", role: "author" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // ⚠ No capability write went with it. Grants are saved when their box is ticked.
    expect(api.grantMemberCapability).not.toHaveBeenCalled();
    expect(api.revokeMemberCapability).not.toHaveBeenCalled();
  });
});
