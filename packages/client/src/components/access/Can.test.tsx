// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Can } from "./Can";
import { PermissionGate } from "./PermissionGate";
import type { PermissionsValue } from "@/lib/permissions";

const state = { value: "denied" as "allowed" | "denied" | "unreadable" };
vi.mock("@/lib/permissions", () => ({
  usePermissions: (): PermissionsValue => ({
    data:
      state.value === "unreadable"
        ? null
        : {
            workspaceId: "ws-1",
            permissions: state.value === "allowed" ? ["secrets.write"] : [],
            provenance: {},
            memberRole: "author",
            superAdmin: false,
            platformRoles: [],
            platformPermissions: [],
          },
    loading: false,
    error: state.value === "unreadable" ? new Error("down") : null,
    can: () => state.value,
    // ⚠ A whole-module `vi.mock` replaces the module, so a method omitted here comes
    // back `undefined` and crashes whatever calls it. `Can` does not, but the typed
    // return is what caught the omission — keep it typed.
    canPlatform: () => state.value,
    why: () => [],
    refresh: () => {},
  }),
}));

afterEach(cleanup);

describe("Can — three states", () => {
  it("renders the children when allowed", () => {
    state.value = "allowed";
    render(<Can permission="secrets.write">
      <button>Add a credential</button>
    </Can>);
    expect(screen.getByText("Add a credential")).toBeTruthy();
  });

  it("renders the fallback when denied", () => {
    state.value = "denied";
    render(
      <Can permission="secrets.write" fallback={<span>not for you</span>}>
        <button>Add a credential</button>
      </Can>,
    );
    expect(screen.queryByText("Add a credential")).toBeNull();
    expect(screen.getByText("not for you")).toBeTruthy();
  });

  /**
   * ⚠ The one that matters. Hiding on unreadable would make a broken permissions
   * endpoint look exactly like a correctly-restricted screen, and the person would have
   * no way to tell "you may not" from "we could not find out". The server refuses if they
   * are not entitled, so showing is the safe direction here.
   */
  it("does NOT hide when the check could not run", () => {
    state.value = "unreadable";
    render(
      <Can permission="secrets.write" fallback={<span>not for you</span>}>
        <button>Add a credential</button>
      </Can>,
    );
    expect(screen.getByText("Add a credential")).toBeTruthy();
    expect(screen.queryByText("not for you")).toBeNull();
  });
});

describe("PermissionGate — visible and disabled, with a reason", () => {
  it("renders the control untouched when allowed", () => {
    state.value = "allowed";
    render(
      <PermissionGate permission="secrets.write" action="add a credential">
        <button>Add</button>
      </PermissionGate>,
    );
    expect(screen.getByText("Add")).toBeTruthy();
    expect(screen.queryByTestId("permission-denied")).toBeNull();
  });

  /**
   * ⚠ **VISIBLE AND DISABLED, NOT HIDDEN, AND THAT IS THE DECISION.** A hidden control is
   * indistinguishable from a control that does not exist, so a person who needs it has
   * nothing to ask for and nobody to ask.
   */
  it("keeps the control on screen when denied, names the permission and who can grant it", () => {
    state.value = "denied";
    render(
      <PermissionGate permission="secrets.write" action="add a credential">
        <button>Add</button>
      </PermissionGate>,
    );
    expect(screen.getByText("Add")).toBeTruthy();
    expect(screen.getByTestId("permission-denied")).toBeTruthy();
    expect(screen.getByText(/secrets\.write/)).toBeTruthy();
    expect(screen.getByText(/add a credential/)).toBeTruthy();
    // FR-016 / SC-013 — a next step, not a dead end.
    expect(screen.getByText(/administrator/i)).toBeTruthy();
  });

  it("⚠ never names WHO holds the permission", () => {
    state.value = "denied";
    const { container } = render(
      <PermissionGate permission="secrets.write">
        <button>Add</button>
      </PermissionGate>,
    );
    // FR-021 — a screen is not a 403, but publishing the accounts worth attacking is not
    // an affordance either.
    expect(container.textContent).not.toMatch(/@/);
  });

  it("leaves the control ENABLED when the check could not run, and says so", () => {
    state.value = "unreadable";
    render(
      <PermissionGate permission="secrets.write">
        <button>Add</button>
      </PermissionGate>,
    );
    expect(screen.getByTestId("permission-unreadable")).toBeTruthy();
    expect(screen.queryByTestId("permission-denied")).toBeNull();
    // ⚠ Disabling on a failed check would deny access on the strength of a network error.
    expect(screen.getByText(/could not check/i)).toBeTruthy();
  });
});
