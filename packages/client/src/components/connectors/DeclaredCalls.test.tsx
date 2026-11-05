// @vitest-environment jsdom
//
// Declared API calls on a connector page (plans/declared-api-calls-2026-10-29, phase 3). Pinned: a pack is switched on
// through a WORKSPACE connection; someone who may not enable sees no buttons; the calls list says which change data;
// switching one off asks first; writing one sends the call the server checks, and an obvious gap is said before a round
// trip; an unreadable list says the check did not run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ConnectorConnection } from "@/lib/types";

const api = vi.hoisted(() => ({
  listDeclaredCalls: vi.fn(),
  declareCall: vi.fn(),
  enableCallPack: vi.fn(),
  removeDeclaredCall: vi.fn(),
  enableMyCallPack: vi.fn(),
  removeMyDeclaredCall: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));

import { DeclaredCalls, MyDeclaredCalls } from "./DeclaredCalls";

const conn = (id: string, label: string, personal = false): ConnectorConnection =>
  ({ id, piece: "p", label, authType: "CUSTOM_AUTH", fieldNames: [], createdBy: "x", createdAt: "", updatedAt: "", lastTestedAt: null, lastTestOk: null, lastTestMessage: null, personal }) as ConnectorConnection;
const PACK = {
  key: "azure-repos",
  displayName: "Azure Repos",
  description: "Read repositories.",
  needs: "Code (Read).",
  calls: [
    { name: "list_repositories", displayName: "List repositories", writes: false },
    { name: "create_pull_request", displayName: "Open a pull request", writes: true },
  ],
};
const CALL = {
  name: "list_repositories",
  tool: "azure_devops_list_repositories",
  on: true,
  displayName: "List repositories",
  description: "x",
  pack: "azure-repos",
  writes: false,
  declaration: { method: "GET", path: "/{project}/_apis/git/repositories", query: {}, params: [], returns: "json" },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listDeclaredCalls.mockResolvedValue({ calls: [], packs: [PACK] });
});
afterEach(cleanup);

describe("declared calls on a connector page", () => {
  it("a pack is switched on through the workspace connection — never a personal one", async () => {
    api.enableCallPack.mockResolvedValue({ pack: "azure-repos", calls: [{ name: "a" }, { name: "b" }] });
    render(<DeclaredCalls short="azure-devops" connections={[conn("mine", "Mine", true), conn("team", "Team")]} canEnable />);
    expect((await screen.findByText("Code (Read).")).textContent).toBeTruthy();
    expect(screen.getByText(/Open a pull request · changes data/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch on Azure Repos" }));
    await waitFor(() => expect(api.enableCallPack).toHaveBeenCalledWith("azure-devops", "azure-repos", "team"));
  });

  it("someone who may not enable sees the calls and no buttons", async () => {
    api.listDeclaredCalls.mockResolvedValue({ calls: [CALL], packs: [PACK] });
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable={false} />);
    expect(await screen.findByText("GET /{project}/_apis/git/repositories")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch on|Switch off|Add a call/ })).toBeNull();
  });

  it("switching one off asks first", async () => {
    api.listDeclaredCalls.mockResolvedValue({ calls: [CALL], packs: [] });
    api.removeDeclaredCall.mockResolvedValue({ name: "x", on: false });
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch off" }));
    expect(api.removeDeclaredCall).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Switch off" }).at(-1)!);
    await waitFor(() => expect(api.removeDeclaredCall).toHaveBeenCalledWith("azure-devops", "list_repositories"));
  });

  it("writing one: a path blank gets its input, a gap is said first, and the server gets the call", async () => {
    api.declareCall.mockResolvedValue({ name: "x", hash: "h", writes: false, changed: false });
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a call" }));
    fireEvent.change(screen.getByLabelText("Short name"), { target: { value: "list_prs" } });
    fireEvent.change(screen.getByLabelText("Name people read"), { target: { value: "List PRs" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/{project}/_apis/git/pullrequests" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and switch on" }));
    expect(await screen.findByText("Say in a sentence what it does.")).toBeTruthy();
    expect(api.declareCall).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What it does"), { target: { value: "Pull requests in a project." } });
    fireEvent.change(screen.getByLabelText("Fixed query"), { target: { value: "api-version=7.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and switch on" }));
    await waitFor(() =>
      expect(api.declareCall).toHaveBeenCalledWith("azure-devops", "team", {
        name: "list_prs",
        displayName: "List PRs",
        description: "Pull requests in a project.",
        method: "GET",
        path: "/{project}/_apis/git/pullrequests",
        query: { "api-version": "7.1" },
        params: [{ name: "project", in: "path", type: "string", required: true, description: "" }],
        returns: "json",
      }),
    );
  });

  it("a write may fix body fields by place; a GET is offered no body at all", async () => {
    api.declareCall.mockResolvedValue({ name: "x", hash: "h", writes: true, changed: false });
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a call" }));
    expect(screen.queryByLabelText("Fixed body")).toBeNull(); // CONTROL: GET by default
    fireEvent.change(screen.getByLabelText("Short name"), { target: { value: "new_branch" } });
    fireEvent.change(screen.getByLabelText("Name people read"), { target: { value: "New branch" } });
    fireEvent.change(screen.getByLabelText("What it does"), { target: { value: "Creates a branch at a commit." } });
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "POST" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/refs" } });
    fireEvent.change(screen.getByLabelText("Fixed body"), { target: { value: "[0].oldObjectId=0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an input" }));
    fireEvent.change(screen.getByLabelText("Input 1 name"), { target: { value: "branch" } });
    fireEvent.change(screen.getByLabelText("Input 1 goes in"), { target: { value: "body" } });
    expect((screen.getByLabelText("Input 1 sent as") as HTMLInputElement).placeholder).toMatch(/place in the body/);
    fireEvent.change(screen.getByLabelText("Input 1 sent as"), { target: { value: "[0].name" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and switch on" }));
    await waitFor(() =>
      expect(api.declareCall).toHaveBeenCalledWith(
        "azure-devops",
        "team",
        expect.objectContaining({ method: "POST", body: { "[0].oldObjectId": "0000" }, params: [{ name: "branch", in: "body", type: "string", required: false, description: "", key: "[0].name" }] }),
      ),
    );
  });

  it("the server's refusal is shown where the person typed", async () => {
    api.declareCall.mockRejectedValue(new Error("the call is not valid: the path may not contain . or .. segments"));
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a call" }));
    fireEvent.change(screen.getByLabelText("Short name"), { target: { value: "climb" } });
    fireEvent.change(screen.getByLabelText("Name people read"), { target: { value: "Climb" } });
    fireEvent.change(screen.getByLabelText("What it does"), { target: { value: "Tries to leave." } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/../other" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and switch on" }));
    expect(await screen.findByText(/may not contain \. or \.\. segments/)).toBeTruthy();
  });

  it("⚠ an unreadable list says the check did not run", async () => {
    api.listDeclaredCalls.mockRejectedValue(new Error("boom"));
    render(<DeclaredCalls short="azure-devops" connections={[conn("team", "Team")]} canEnable />);
    expect(await screen.findByText(/These calls could not be read/)).toBeTruthy();
  });
});

describe("the same packs, for me (plans/personal-actions-2026-10-29)", () => {
  const view = (over: Record<string, unknown> = {}) => ({ allowed: true, connected: true, actions: [], calls: [], packs: [PACK], ...over });
  const MY = { ...CALL, pack: "azure-repos", declaration: { ...CALL.declaration } };

  it("switches a pack on for you only — never the workspace's route", async () => {
    api.enableMyCallPack.mockResolvedValue(view({ calls: [MY] }));
    const onChange = vi.fn();
    render(<MyDeclaredCalls short="azure-devops" view={view() as never} workspaceOn={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch on Azure Repos for me" }));
    await waitFor(() => expect(api.enableMyCallPack).toHaveBeenCalledWith("azure-devops", "azure-repos"));
    expect(api.enableCallPack).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("a pack the workspace has on for everyone is said so, with no personal copy offered", () => {
    render(<MyDeclaredCalls short="azure-devops" view={view() as never} workspaceOn={["azure_devops_list_repositories", "azure_devops_create_pull_request"]} onChange={vi.fn()} />);
    expect(screen.getByText("On for everyone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /for me/ })).toBeNull();
  });

  it("without your own connection, or with personal use off, says why instead of a button", () => {
    render(<MyDeclaredCalls short="azure-devops" view={view({ connected: false }) as never} workspaceOn={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/Connect your own account first/)).toBeTruthy();
    cleanup();
    render(<MyDeclaredCalls short="azure-devops" view={view({ allowed: false }) as never} workspaceOn={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/An admin has turned off/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /for me/ })).toBeNull();
  });

  it("switching one of yours off asks first, then switches it off for you", async () => {
    api.removeMyDeclaredCall.mockResolvedValue(view());
    render(<MyDeclaredCalls short="azure-devops" view={view({ calls: [MY] }) as never} workspaceOn={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch off" }));
    expect(api.removeMyDeclaredCall).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(api.removeMyDeclaredCall).toHaveBeenCalledWith("azure-devops", "list_repositories"));
  });
});
