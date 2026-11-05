// @vitest-environment jsdom
// rbac-observability (2026-10-15): the workflow page says whose it is and who can see it, offers Edit only to someone
// who may change it, and lets an Admin move it to another member.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlowSummary } from "@/lib/types";

const api = vi.hoisted(() => ({
  listMembers: vi.fn(),
  setFlowOwner: vi.fn(),
  approveFlowRevision: vi.fn(),
  rearmFlowApproval: vi.fn(),
  revokeFlowApproval: vi.fn(),
  runFlowLive: vi.fn(),
  // Plugins 8.6 — the page reads "Runs as"; this file is not about it, so it answers "uses no connected service".
  getFlowRunAs: vi.fn(async () => ({ services: [], owner: false, approved: false })),
  getFlowActivation: vi.fn(async (): Promise<unknown> => ({ available: false, reason: "not shared", on: false, paused: null, schedule: null, mine: null })),
  setFlowActivation: vi.fn(async (): Promise<unknown> => ({})),
  getFlowReadiness: vi.fn(async (): Promise<unknown> => ({ ready: true, needs: [] })),
  setMyAccount: vi.fn(async (): Promise<unknown> => ({ ready: true, needs: [] })),
  setFlowRunAs: vi.fn(),
  // Plugins phase 9.
  switchOnFlow: vi.fn(async () => {}),
  switchOffFlow: vi.fn(async () => {}),
  setFlowEditing: vi.fn(async () => {}),
  // Sharing boundaries: the owner asks a reviewer.
  requestFlowReview: vi.fn(async () => {}),
  withdrawFlowReview: vi.fn(async () => {}),
  // Sharing boundaries phase 5: where it lives.
  listProjects: vi.fn(async (): Promise<unknown> => [{ id: "p1", name: "Payroll close", members: 3, mine: true }]),
  movePreview: vi.fn(),
  moveItem: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/foundry-client", () => ({ resolveWorkspaceId: async () => "ws1" }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/flows/f1" }));

const { PiFlowOverview, whoCanSee } = await import("./PiFlowOverview");

const base = {
  id: "f1",
  name: "Monthly hours",
  runtime: "foundry",
  status: "draft",
  draftRevision: 1,
  armedRevision: null,
  ownerSubject: "ada",
  ownerName: "ada@x.example",
} as unknown as FlowSummary;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("who sees a workflow: where it lives (sharing-boundaries phase 6)", () => {
  it("My space, a project or the Workspace — switched on is not shared, and no 'public'/'private' words", () => {
    expect(whoCanSee({ visibility: "public", armedRevision: null })).toBe("Everyone in this workspace.");
    expect(whoCanSee({ visibility: "private", armedRevision: 2 })).toMatch(/^Only its owner and Admins/);
    expect(whoCanSee({ visibility: "private", armedRevision: null, projectId: "p1" }, "Payroll close")).toMatch(/^The members of “Payroll close”/);
    for (const v of ["public", "private"] as const) expect(whoCanSee({ visibility: v, armedRevision: null })).not.toMatch(/public|private|publish/i);
  });
  it("an older server sends no visibility: approved then meant shared with the workspace", () => {
    expect(whoCanSee({ armedRevision: 2 })).toBe("Everyone in this workspace.");
    expect(whoCanSee({ armedRevision: null })).toMatch(/^Only its owner and Admins/);
  });
});

describe("switching it on yourself (plugins phase 9)", () => {
  const own = { allowed: true, ownOnly: true, needsReviewerFor: [], own: ["the AI summary tool"], youMay: true };
  it("its owner sees Switch on — and it switches on the draft, not Approve", async () => {
    render(<PiFlowOverview flow={base} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} selfEnable={own} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(api.switchOnFlow).toHaveBeenCalledWith("f1", 1));
    expect(api.approveFlowRevision).not.toHaveBeenCalled();
  });
  it("⚠ one that uses the workspace's things says why a reviewer approves it, in the server's words", () => {
    const reviewer = { allowed: true, ownOnly: false, needsReviewerFor: ["reads the workspace's data (\"late\")"], own: [], youMay: false };
    render(<PiFlowOverview flow={base} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} selfEnable={reviewer} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch on" })).toBeNull();
    expect(screen.getByText(/A reviewer approves it: it reads the workspace's data/)).toBeTruthy();
  });
  it("its owner turns it off through their own route, not the reviewer's", async () => {
    const live = { ...base, status: "approved", armedRevision: 1, selfEnabled: true } as FlowSummary;
    render(<PiFlowOverview flow={live} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} selfEnable={own} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.switchOffFlow).toHaveBeenCalledWith("f1"));
    expect(api.revokeFlowApproval).not.toHaveBeenCalled();
  });
  it("⚠ where it lives is ONE row with a Move action — no Make public / Make private (phase 6, P6-D4)", async () => {
    render(<PiFlowOverview flow={{ ...base, visibility: "private" } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} />);
    expect(screen.getByText("Where it lives")).toBeTruthy();
    expect(screen.getByText("My space")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(api.listProjects).toHaveBeenCalled();
  });
  it("⚠ in a project: says its members see it, offers Move, and never Make public (sharing-boundaries phase 5)", async () => {
    render(<PiFlowOverview flow={{ ...base, visibility: "private", projectId: "p1", othersMayEdit: true } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} />);
    expect(await screen.findByText(/The members of “Payroll close” and Admins/)).toBeTruthy();
    expect(screen.getByText("Payroll close")).toBeTruthy();
    // An Observer member sees it and cannot edit it, so the line names who can (P6-I3).
    expect(screen.getByText("Anyone in the project who builds workflows")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move…" })).toBeTruthy();
  });
});

describe("the owner on the workflow page", () => {
  it("names the owner and who can see it; no Edit and no Change for someone who may not change it", () => {
    render(
      <PiFlowOverview flow={base} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: false, canChangeOwner: false }} />,
    );
    expect(screen.getByText("ada@x.example")).toBeTruthy();
    expect(screen.getByText(/^Only its owner and Admins/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Edit workflow/ })).toBeNull();
    expect(screen.queryByText("Open canvas")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("an owner whose subject no member or sign-in names reads as a former member; none at all as Nobody", () => {
    const { unmount } = render(
      <PiFlowOverview flow={{ ...base, ownerName: null }} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />,
    );
    expect(screen.getByText("A former member")).toBeTruthy();
    unmount();
    render(<PiFlowOverview flow={{ ...base, ownerName: null, ownerSubject: null }} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />);
    expect(screen.getByText("No owner. Admins look after it.")).toBeTruthy();
  });

  it("an Admin moves it to another member; Observers are not offered", async () => {
    api.listMembers.mockResolvedValue([
      { id: "1", subject: "ada", email: "ada@x.example", role: "author", grantedBy: "x" },
      { id: "2", subject: "bob", email: "bob@x.example", role: "approver", grantedBy: "x" },
      { id: "3", subject: "obs", email: "obs@x.example", role: "viewer", grantedBy: "x" },
    ]);
    api.setFlowOwner.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(
      <PiFlowOverview
        flow={base}
        workflow={{ steps: [] }}
        runs={[]}
        onRename={async () => {}}
        onChanged={onChanged}
        access={{ canChange: true, canChangeOwner: true }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const select = (await screen.findByLabelText("Owner")) as HTMLSelectElement;
    const offered = [...select.options].map((o) => o.value);
    expect(offered).toEqual(["", "ada", "bob"]);
    // Saving the owner it already has does nothing.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setFlowOwner).toHaveBeenCalledWith("f1", "bob"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows the server's refusal and stays open", async () => {
    api.listMembers.mockResolvedValue([{ id: "2", subject: "bob", email: "bob@x.example", role: "author", grantedBy: "x" }]);
    api.setFlowOwner.mockRejectedValue(new Error("That person is not a member of this workspace."));
    render(
      <PiFlowOverview flow={base} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: true }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That person is not a member of this workspace.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("⚠ asking for approval (sharing-boundaries 2026-10-30)", () => {
  const page = (flow: Partial<FlowSummary>) =>
    render(<PiFlowOverview flow={{ ...base, ...flow } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canChangeOwner: false }} />);

  it("its owner asks a reviewer instead of being offered an Approve they cannot use", async () => {
    page({ mine: true });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask for approval" }));
    await waitFor(() => expect(api.requestFlowReview).toHaveBeenCalledWith("f1", 1));
  });

  it("once asked, it says so and offers to withdraw", async () => {
    page({ mine: true, reviewRequestedRevision: 1 });
    expect(screen.getByText(/Approval asked for/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(api.withdrawFlowReview).toHaveBeenCalledWith("f1"));
  });

  it("somebody else (a reviewer) is offered Approve, not Ask", () => {
    page({ mine: false, reviewRequestedRevision: 1 });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask for approval" })).toBeNull();
  });
});

describe("⚠ editing vs managing a shared workflow (sharing-boundaries phase 2)", () => {
  const shared = { ...base, visibility: "public", othersMayEdit: true } as FlowSummary;
  it("an editor is told they can edit it and its owner manages it — no owner switches", () => {
    render(<PiFlowOverview flow={shared} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canManage: false, canChangeOwner: false }} />);
    expect(screen.getByText("You can edit it. Its owner manages it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make view-only" })).toBeNull();
    expect(screen.getByRole("link", { name: /Edit workflow/ })).toBeTruthy();
  });
  it("its owner makes it view-only in one click", async () => {
    render(<PiFlowOverview flow={shared} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: true, canManage: true, canChangeOwner: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Make view-only" }));
    await waitFor(() => expect(api.setFlowEditing).toHaveBeenCalledWith("f1", false));
  });
  it("a view-only workflow says so", () => {
    render(<PiFlowOverview flow={{ ...shared, othersMayEdit: false } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} access={{ canChange: false, canManage: false, canChangeOwner: false }} />);
    expect(screen.getByText(/view-only for others/)).toBeTruthy();
  });
});
