// @vitest-environment jsdom
// Plugins 8.6 — a workflow's "Runs as": whose account each connected service uses. ⚠ What is pinned: only the OWNER
// is given a choice; a published workflow that acts as a person's own account says so on the page, before Run now
// (to anyone but the owner) and before approving; a change says it needs approving.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlowSummary } from "@/lib/types";

const api = vi.hoisted(() => ({
  listMembers: vi.fn(),
  setFlowOwner: vi.fn(),
  approveFlowRevision: vi.fn(async () => ({})),
  rearmFlowApproval: vi.fn(),
  revokeFlowApproval: vi.fn(),
  runFlowLive: vi.fn(),
  getFlowRunAs: vi.fn(),
  getFlowActivation: vi.fn(async (): Promise<unknown> => ({ available: false, reason: "not shared", on: false, paused: null, schedule: null, mine: null })),
  setFlowActivation: vi.fn(async (): Promise<unknown> => ({})),
  getFlowReadiness: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ready: true, needs: [] })),
  setMyAccount: vi.fn(async (): Promise<unknown> => ({ ready: true, needs: [] })),
  setFlowRunAs: vi.fn(async () => ({})),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/foundry-client", () => ({ resolveWorkspaceId: async () => "ws1" }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/flows/f1" }));

const { PiFlowOverview } = await import("./PiFlowOverview");

const GH = "@activepieces/piece-github";
const team = { connectionId: "c-team", label: "Team", personal: false, service: "GitHub" };
const mine = { connectionId: "c-me", label: "Mine", personal: true, service: "GitHub" };
const flow = (over: Record<string, unknown> = {}) =>
  ({ id: "f1", name: "Weekly issues", runtime: "foundry", status: "draft", draftRevision: 2, armedRevision: null, ownerSubject: "ada", ownerName: "Ada", ...over }) as unknown as FlowSummary;
const page = (f: FlowSummary) => render(<PiFlowOverview flow={f} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Runs as", () => {
  it("the owner chooses between the workspace's and their own; the change is sent and says it needs approving", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: team, approved: null, options: [team, mine] }], owner: true, approved: false });
    page(flow());
    const pick = (await screen.findByLabelText("GitHub runs as")) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.text)).toEqual(["The workspace's “Team”", "Your own “Mine”"]);
    fireEvent.change(pick, { target: { value: "c-me" } });
    await waitFor(() => expect(api.setFlowRunAs).toHaveBeenCalledWith("f1", GH, "c-me"));
  });
  it("⚠ someone who is not the owner is given no choice — only the statement", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: mine, approved: null, options: [team] }], owner: false, approved: false });
    page(flow());
    expect(await screen.findByText("Ada's own “Mine”")).toBeTruthy();
    expect(screen.queryByLabelText("GitHub runs as")).toBeNull();
  });
  it("⚠ published as a person's own account: the page says so, and Run now warns anyone but the owner", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: mine, approved: mine, options: [team] }], owner: false, approved: true });
    page(flow({ status: "armed", armedRevision: 2 }));
    expect(await screen.findByText(/Whenever it runs, on demand or on its schedule or triggers, it acts as Ada's own GitHub/)).toBeTruthy();
    expect(screen.getByText(/It acts as Ada's own GitHub: running it uses that person's account/)).toBeTruthy();
  });
  it("⚠ approving a version that acts as a person's own account asks first, and says who it acts as", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: mine, approved: null, options: [team, mine] }], owner: true, approved: false });
    page(flow());
    await screen.findByLabelText("GitHub runs as");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(/When it runs — on demand, or on a schedule or trigger — it acts as that account/)).toBeTruthy();
    expect(api.approveFlowRevision).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" }).at(-1)!);
    await waitFor(() => expect(api.approveFlowRevision).toHaveBeenCalledWith("f1", 2));
  });
  it("a workflow that uses no connected service shows no Runs as at all", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: true, approved: false });
    page(flow());
    await waitFor(() => expect(api.getFlowRunAs).toHaveBeenCalled());
    expect(screen.queryByText("Runs as")).toBeNull();
  });

  it("⚠ a shared workflow offers each person's own account; choosing it sends \"each\" and says what it means (phase 3)", async () => {
    const each = { connectionId: "", label: "Each person", personal: false, service: "GitHub", each: true };
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: each, approved: null, options: [team, mine, each] }], owner: true, approved: false, shared: true });
    page(flow());
    const pick = (await screen.findByLabelText("GitHub runs as")) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.text)).toEqual(["The workspace's “Team”", "Your own “Mine”", "Each person's own account"]);
    expect(pick.value).toBe("each");
    expect(screen.getByText(/Whoever runs it uses their own GitHub/)).toBeTruthy();
    fireEvent.change(pick, { target: { value: "c-team" } });
    await waitFor(() => expect(api.setFlowRunAs).toHaveBeenCalledWith("f1", GH, "c-team"));
  });
  it("a shared workflow on its owner's own account says others can only view it; one in My space offers no choice and says why", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: mine, approved: null, options: [team, mine] }], owner: true, approved: false, shared: true });
    page(flow());
    expect(await screen.findByText(/others can view it but not edit it/)).toBeTruthy();
    cleanup();
    // In My space (Q3): no choice at all — it says it uses your own, and how to get a choice.
    const own = { connectionId: "", label: "Its owner's own account", personal: true, service: "GitHub", own: true };
    api.getFlowRunAs.mockResolvedValue({ services: [{ piece: GH, service: "GitHub", current: own, approved: null, options: [] }], owner: true, approved: false, shared: false, mySpace: true });
    page(flow());
    expect(await screen.findByText(/It is in My space, so it always uses your own GitHub. Move it to a project or the Workspace/)).toBeTruthy();
    expect(screen.getByText("your own account")).toBeTruthy();
    expect(screen.queryByLabelText("GitHub runs as")).toBeNull();
  });

});

describe("Turn on for me (sharing-boundaries phase 3)", () => {
  const off = { available: true, reason: null, on: false, paused: null, schedule: { cron: "0 9 * * 1", timezone: "UTC" }, mine: null };
  it("a member turns a shared each-person workflow on for themselves, and is told it runs on their own account", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: false, approved: true });
    api.getFlowActivation.mockResolvedValue(off);
    api.setFlowActivation.mockResolvedValue({ ...off, on: true });
    page(flow({ status: "armed", armedRevision: 2 }));
    expect(await screen.findByText(/It runs on each person's own account/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for me" }));
    await waitFor(() => expect(api.setFlowActivation).toHaveBeenCalledWith("f1", { on: true, cron: null, timezone: null }));
    expect(await screen.findByText("On for you")).toBeTruthy();
  });
  it("a person picks their own time in plain words, in their own timezone (P3-I4)", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: false, approved: true });
    api.getFlowActivation.mockResolvedValue(off);
    api.setFlowActivation.mockResolvedValue({ ...off, on: true, mine: { cron: "0 9 * * 1-5", timezone: "UTC" } });
    page(flow({ status: "armed", armedRevision: 2 }));
    const pick = (await screen.findByLabelText("When it runs for you")) as HTMLSelectElement;
    expect(pick.options[0]!.text).toMatch(/^Its schedule/);
    expect([...pick.options].some((o) => /\*/.test(o.text))).toBe(false);
    fireEvent.change(pick, { target: { value: "0 9 * * 1-5" } });
    expect(api.setFlowActivation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for me" }));
    await waitFor(() => expect(api.setFlowActivation).toHaveBeenCalledWith("f1", { on: true, cron: "0 9 * * 1-5", timezone: expect.any(String) }));
  });
  it("⚠ paused by a newer approved version: says so, and offers to turn it on again", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: false, approved: true });
    api.getFlowActivation.mockResolvedValue({ ...off, on: true, paused: "It changed since you turned it on. Look at what changed, then turn it on again." });
    page(flow({ status: "armed", armedRevision: 3 }));
    expect(await screen.findByText(/It changed since you turned it on/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on again" })).toBeTruthy();
    expect(screen.queryByText("On for you")).toBeNull();
  });
  it("CONTROL: a workflow that cannot be turned on for a person shows no card", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: true, approved: false });
    api.getFlowActivation.mockResolvedValue({ ...off, available: false, reason: "not shared" });
    page(flow());
    await waitFor(() => expect(api.getFlowActivation).toHaveBeenCalled());
    expect(screen.queryByText("For you")).toBeNull();
  });
});

describe("Before it can run (sharing-boundaries phase 4)", () => {
  it("lists what is missing with who fixes it, and a person chooses between their own accounts right there", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: false, approved: true });
    api.getFlowReadiness.mockResolvedValue({
      ready: false,
      needs: [
        { cause: "not_connected", service: "Slack", piece: "@activepieces/piece-slack", message: "The workspace has no Slack account connected for it. An Admin connects one.", fixBy: "an Admin", href: "/apps/x" },
        { cause: "choose_account", service: "GitHub", piece: GH, message: "You have 2 GitHub accounts of your own. Choose which one your runs use.", fixBy: "you", href: null, options: [{ connectionId: "c1", label: "Work" }, { connectionId: "c2", label: "Home" }] },
      ],
    });
    api.setMyAccount.mockResolvedValue({ ready: false, needs: [] });
    page(flow({ status: "armed", armedRevision: 2 }));
    expect(await screen.findByText("Before it can run")).toBeTruthy();
    expect(screen.getByText(/An Admin connects one/)).toBeTruthy();
    expect(screen.getByText(/Who fixes it: an Admin/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your GitHub account"), { target: { value: "c2" } });
    await waitFor(() => expect(api.setMyAccount).toHaveBeenCalledWith("f1", GH, "c2"));
    expect(api.getFlowReadiness).toHaveBeenCalledWith("f1", "approved");
  });
  it("⚠ a newer version waiting for approval: what IT needs is shown too, beside what the running one needs (P4-I1)", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: false, approved: true });
    api.getFlowReadiness.mockImplementation(async (_id: unknown, rev: unknown) =>
      rev === "draft"
        ? { ready: false, needs: [{ cause: "not_enabled", service: "Slack", piece: null, message: "It uses “slack_post”, which is switched off in this workspace.", fixBy: "an Admin", href: null }] }
        : { ready: true, needs: [] },
    );
    page(flow({ status: "draft_pending", armedRevision: 2, draftRevision: 3 }));
    expect(await screen.findByText("The version waiting for approval needs")).toBeTruthy();
    expect(screen.getByText(/slack_post/)).toBeTruthy();
    expect(screen.queryByText("Before it can run")).toBeNull();
    api.getFlowReadiness.mockReset();
  });
  it("CONTROL: a workflow with nothing missing shows no panel", async () => {
    api.getFlowRunAs.mockResolvedValue({ services: [], owner: true, approved: false });
    api.getFlowReadiness.mockResolvedValue({ ready: true, needs: [] });
    page(flow());
    await waitFor(() => expect(api.getFlowReadiness).toHaveBeenCalledWith("f1", "draft"));
    expect(screen.queryByText("Before it can run")).toBeNull();
  });
});
