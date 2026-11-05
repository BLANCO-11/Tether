// @vitest-environment jsdom
//
// ── ⚠ THE BUILT-IN ROLES USED TO LOAD ONLY SOMETIMES ────────────────────────────────
//
// Reported from `/admin/members?tab=roles`: the roles and their permission lines
// intermittently rendered as "could not be read", and reloading the page fixed it.
//
// The cause was not the roles read. `useWorkspace()` holds `UNRESOLVED_WORKSPACE`
// (`ws_it`) until the resolver answers, and this panel took that value STRAIGHT to the
// wire — `GET /api/workspaces/ws_it/roles`, which names no workspace and is not a uuid.
// Nothing here retried; what sometimes rescued it was `app/(app)/layout.tsx`'s
// `key={workspaceId}` remounting `<main>` when the real id landed, which is a
// coincidence rather than a mechanism, and is exactly why the failure was intermittent.
//
// ⚠ **`workspace-placeholder.test.ts`'s CONTROL WAS ALREADY RED ON THIS**, naming
// `listWorkspaceRoles`, `createWorkspaceRole` and `retireWorkspaceRole`. This file is
// the behavioural half: it drives the panel with the placeholder in the context and
// requires the roles to render anyway.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UNRESOLVED_WORKSPACE } from "@/lib/workspace-choice";

const REAL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

/** Every workspace id that reached the wire, in order. */
const wire: string[] = [];

/**
 * ⚠ **THE SERVER'S BEHAVIOUR, NOT A STUB THAT ALWAYS SAYS YES.** The placeholder is not
 * a workspace, so a read for it must FAIL here — otherwise the test passes just as
 * happily against the bug.
 */
vi.mock("@/lib/foundry-client", () => ({
  foundryApi: {
    listWorkspaceRoles: async (workspaceId: string) => {
      wire.push(workspaceId);
      if (workspaceId !== REAL) throw new Error(`invalid input syntax for type uuid: "${workspaceId}"`);
      return {
        roles: [
          { id: null, name: "author", description: null, permissions: ["flows.read", "flows.write"], builtin: true, retiredAt: null, assignees: 3 },
          { id: null, name: "admin", description: null, permissions: ["members.grant"], builtin: true, retiredAt: null, assignees: 1 },
        ],
      };
    },
  },
  resolveWorkspaceId: async () => REAL,
  FoundryApiError: class extends Error {},
  NO_WORKSPACE_MESSAGE: "none",
}));

let contextWorkspace: string = UNRESOLVED_WORKSPACE;
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: contextWorkspace, switchWorkspace: vi.fn() }),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/components/access/Can", () => ({
  useCan: () => ({ allowed: true, denied: false, unreadable: false }),
}));
vi.mock("@/components/access/PermissionGate", () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { WorkspaceRolesPanel } from "./WorkspaceRolesPanel";

beforeEach(() => {
  wire.length = 0;
  contextWorkspace = UNRESOLVED_WORKSPACE;
});
afterEach(cleanup);

describe("the Roles tab reads the RESOLVED workspace", () => {
  it("CONTROL: with a real id already in the context, the roles render", async () => {
    // Without this, "renders the roles" below could be passing for a reason that has
    // nothing to do with the placeholder.
    contextWorkspace = REAL;
    render(<WorkspaceRolesPanel />);
    expect(await screen.findByTestId("role-list")).toBeTruthy();
    expect(wire).toEqual([REAL]);
  });

  it("renders the built-in roles and their permission lines while the context still holds the placeholder", async () => {
    render(<WorkspaceRolesPanel />);
    expect(await screen.findByTestId("role-list")).toBeTruthy();
    expect(screen.getByText("author")).toBeTruthy();
    // The permission line is the "description" a person reads under each role.
    expect(screen.getByText("flows.read · flows.write")).toBeTruthy();
  });

  it("⚠ THE PLACEHOLDER NEVER REACHES THE WIRE", async () => {
    render(<WorkspaceRolesPanel />);
    await screen.findByTestId("role-list");
    expect(wire).not.toContain(UNRESOLVED_WORKSPACE);
    expect(wire).toEqual([REAL]);
  });

  it("does not render the unreadable notice once the read has succeeded", async () => {
    render(<WorkspaceRolesPanel />);
    await screen.findByTestId("role-list");
    // ⚠ Three states, and this is the one the bug produced. It must not be on screen
    // beside a list that loaded.
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});
