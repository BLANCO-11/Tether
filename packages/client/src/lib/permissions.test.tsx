// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PermissionsProvider, usePermissions } from "@/lib/permissions";

const myPermissions = vi.fn();
vi.mock("@/lib/foundry-client", () => ({
  foundryApi: { myPermissions: (...a: unknown[]) => myPermissions(...a) },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/**
 * ⚠ **THE THIRD STATE IS THE SUBJECT OF THIS FILE** (FR-032).
 *
 * A check that could not run is NEITHER answer. Rendering it as "denied" is the failure
 * this repo has written down three times — `listPromptBoundaryWarnings` returning
 * `{items: []}` on an error reads as *"no flagged content"*; `/organization`'s fourth
 * state exists for the same reason; and the deleted `faFallback` answered every server
 * failure with fabricated rows. **"We could not check" must never render as "you may
 * not", and must never render as "you may".**
 */
function Probe({ permission }: { permission: string }) {
  const { can, loading, error } = usePermissions();
  return (
    <div>
      <span data-testid="state">{can(permission)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{String(!!error)}</span>
    </div>
  );
}

const render1 = (permission = "flows.write") =>
  render(
    <PermissionsProvider workspaceId="ws-1">
      <Probe permission={permission} />
    </PermissionsProvider>,
  );

describe("the workspace placeholder", () => {
  /**
   * The layout passes the context value, which is `ws_it` until the resolver answers.
   * Asking about it reached the server as a non-uuid and logged a 400 per page load.
   */
  it("never asks about the unresolved placeholder, and asks once the real id lands", async () => {
    const { UNRESOLVED_WORKSPACE } = await import("@/lib/workspace-choice");
    myPermissions.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: ["flows.write"],
      provenance: {},
      memberRole: "author",
      superAdmin: false,
      platformRoles: [],
      platformPermissions: [],
    });
    const { rerender } = render(
      <PermissionsProvider workspaceId={UNRESOLVED_WORKSPACE}>
        <Probe permission="flows.write" />
      </PermissionsProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("unreadable");
    expect(myPermissions).not.toHaveBeenCalled();
    rerender(
      <PermissionsProvider workspaceId="ws-1">
        <Probe permission="flows.write" />
      </PermissionsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("allowed"));
    expect(myPermissions.mock.calls.flat()).toEqual(["ws-1"]);
  });
});

describe("the three states", () => {
  it("allowed when the server says the permission is held", async () => {
    myPermissions.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: ["flows.write", "flows.read"],
      provenance: { "flows.write": [{ via: "preset", role: "author" }] },
      memberRole: "author",
      superAdmin: false,
      platformRoles: [],
      platformPermissions: [],
    });
    render1();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("allowed"));
  });

  it("denied when the server answers and the permission is absent", async () => {
    myPermissions.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: ["flows.read"],
      provenance: {},
      memberRole: "author",
      superAdmin: false,
      platformRoles: [],
      platformPermissions: [],
    });
    render1("secrets.write");
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("denied"));
  });

  /** ⚠ THE ONE THAT MATTERS. */
  it("UNREADABLE — not denied — when the check itself could not run", async () => {
    myPermissions.mockRejectedValue(new Error("api down"));
    render1();
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("true"));
    expect(screen.getByTestId("state").textContent).toBe("unreadable");
    // ⚠ Explicitly NOT "denied". A network failure is not a refusal, and rendering it as
    // one tells somebody they have been refused when nobody refused them.
    expect(screen.getByTestId("state").textContent).not.toBe("denied");
  });

  it("an empty permission list from a SUCCESSFUL read IS denied — the distinction is real", async () => {
    // The other half: "the server answered and you hold nothing" is a real answer and
    // must not be softened into unreadable, or a genuinely unentitled person is offered
    // controls that will refuse them.
    myPermissions.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: [],
      provenance: {},
      memberRole: null,
      superAdmin: false,
      platformRoles: [],
      platformPermissions: [],
    });
    render1();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("denied"));
  });

  it("unreadable while there is no workspace to ask about", async () => {
    render(
      <PermissionsProvider workspaceId={null}>
        <Probe permission="flows.write" />
      </PermissionsProvider>,
    );
    // Not "denied": we have not asked, so we do not know.
    expect(screen.getByTestId("state").textContent).toBe("unreadable");
    expect(myPermissions).not.toHaveBeenCalled();
  });

  it("unreadable OUTSIDE a provider, never denied", async () => {
    // A component rendered where the provider was forgotten must not quietly hide every
    // control and look like a correctly-restricted screen.
    render(<Probe permission="flows.write" />);
    expect(screen.getByTestId("state").textContent).toBe("unreadable");
  });
});

describe("provenance travels with the answer", () => {
  it("says WHY, including the platform conferral", async () => {
    myPermissions.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: ["members.grant"],
      provenance: {
        "members.grant": [
          { via: "platform", role: "platform-admin", permission: "platform.members.grant" },
        ],
      },
      memberRole: null,
      superAdmin: false,
      platformRoles: ["platform-admin"],
      platformPermissions: ["platform.members.grant"],
    });

    function WhyProbe() {
      const { why } = usePermissions();
      return <span data-testid="why">{why("members.grant").map((p) => p.via).join(",")}</span>;
    }
    render(
      <PermissionsProvider workspaceId="ws-1">
        <WhyProbe />
      </PermissionsProvider>,
    );
    // ⚠ FR-020 / INV-19: `platform`, never `preset`. A screen must be able to say
    // "because they administer the platform" rather than implying a membership row.
    await waitFor(() => expect(screen.getByTestId("why").textContent).toBe("platform"));
  });
});

describe("it never reads the sign-in session", () => {
  it("CONTROL: the source contains no next-auth session read", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/permissions.tsx", "utf8");
    expect(src.length).toBeGreaterThan(500); // the scan found the file
    // ⚠ **WHAT IS FORBIDDEN IS CALLING IT, NOT MENTIONING IT** — I-62, and the first
    // version of this assertion made exactly that mistake: the docblock EXPLAINS at
    // length why the session's roles must not be read, and a bare /user\.roles/ flagged
    // the explanation. A guard that cries wolf gets widened, and the widening is what
    // permits the defect. So this states the forbidden thing: an import from next-auth,
    // and a CALL to useSession.
    expect(src).not.toMatch(/from\s+["']next-auth/);
    expect(src).not.toMatch(/useSession\s*\(/);
    // ⚠ Not a bare `session.user.roles` either — the docblock names it, deliberately,
    // and flagging the explanation is the same mistake one line up. A CODE read would be
    // preceded by an identifier or a `const`, never by a backtick or a space in prose.
    expect(src).not.toMatch(/=\s*session[?.]*\.user[?.]*\.roles/);
    expect(src).not.toMatch(/\buseSession\b[^.]*\.roles/);
  });
});

/**
 * ⚠ **THE TWO TIERS ARE SEPARATE QUESTIONS, AND ASKING THE WRONG ONE FAILS SILENTLY.**
 *
 * `can` answers from `data.permissions` — the workspace-tier union for one workspace. A
 * platform permission is never in it. So `can("platform.roles.write")` answers `denied`
 * for a super admin holding all eleven, and a control gated on it disappears for exactly
 * the person entitled to use it.
 *
 * That is not hypothetical: the platform-roles surface was unreachable for months, and
 * gating its controls on `can` would have shipped it still unreachable while every test
 * passed. `canPlatform` reads `data.platformPermissions`, which the server has always
 * sent on this same payload — the other half of one answer, not a second computation.
 */
function TierProbe({ permission }: { permission: string }) {
  const { can, canPlatform } = usePermissions();
  return (
    <div>
      <span data-testid="workspace">{can(permission)}</span>
      <span data-testid="platform">{canPlatform(permission)}</span>
    </div>
  );
}

const renderTiers = (permission: string) =>
  render(
    <PermissionsProvider workspaceId="ws-1">
      <TierProbe permission={permission} />
    </PermissionsProvider>,
  );

describe("the platform tier is a separate question", () => {
  const SUPER = {
    workspaceId: "ws-1",
    permissions: ["flows.write"],
    provenance: {},
    memberRole: "admin",
    superAdmin: true,
    platformRoles: [],
    platformPermissions: ["platform.roles.write", "platform.members.grant"],
  };

  it("answers a platform permission from platformPermissions, not from the workspace set", async () => {
    myPermissions.mockResolvedValue(SUPER);
    renderTiers("platform.roles.write");
    await waitFor(() => expect(screen.getByTestId("platform").textContent).toBe("allowed"));
  });

  it("REGRESSION: `can` says denied for the same permission — which is why canPlatform exists", async () => {
    myPermissions.mockResolvedValue(SUPER);
    renderTiers("platform.roles.write");
    // Not an endorsement of the answer — a pin on the reason the second reader is
    // needed. If `can` ever starts answering platform permissions, this goes red and
    // somebody decides deliberately rather than finding out from a hidden control.
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("denied"));
  });

  it("denied when the read succeeded and the platform permission is absent", async () => {
    myPermissions.mockResolvedValue({ ...SUPER, superAdmin: false, platformPermissions: [] });
    renderTiers("platform.roles.write");
    await waitFor(() => expect(screen.getByTestId("platform").textContent).toBe("denied"));
  });

  it("UNREADABLE — not denied — when the check could not run", async () => {
    myPermissions.mockRejectedValue(new Error("down"));
    renderTiers("platform.roles.write");
    await waitFor(() => expect(screen.getByTestId("platform").textContent).toBe("unreadable"));
  });

  it("a workspace permission still answers from the workspace set", async () => {
    myPermissions.mockResolvedValue(SUPER);
    renderTiers("flows.write");
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("allowed"));
    // CONTROL: and is NOT quietly served by the platform set.
    expect(screen.getByTestId("platform").textContent).toBe("denied");
  });
});
