// @vitest-environment jsdom
//
// The card a person decides a Forge Agent change on (plugins phase 6). ⚠ What it pins: the exact values are on screen
// before the click; only a pending card can be decided; a decided one says who decided and what the service said.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProposalCard } from "./ProposalCard";
import type { PiProposal } from "@/lib/pi-builder";

afterEach(cleanup);
const p = (over: Partial<PiProposal> = {}): PiProposal => ({
  id: "p1",
  tool: "azure_devops_update_work_item",
  connector: "Azure DevOps",
  action: "Update Work Item",
  summary: "Close work item 2688 in Foundry",
  params: { project: "Foundry", work_item_id: 2688, state: "Closed", tags: ["a", "b"] },
  status: "pending",
  at: "2026-10-28T10:00:00Z",
  ...over,
});

describe("a proposed change", () => {
  it("shows exactly what will be sent, and Do it / Cancel call through", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard p={p()} onDecide={decide} />);
    expect(screen.getByText("Close work item 2688 in Foundry")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getByText("2688")).toBeTruthy();
    expect(screen.getByText('["a","b"]')).toBeTruthy();
    expect(screen.getByText(/Nothing changes until you click Do it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "run"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "decline"));
  });
  it("⚠ a decided change offers no buttons, and says who decided and what the service answered", () => {
    render(<ProposalCard p={p({ status: "done", result: '{"id":2688,"state":"Closed"}', decidedBy: "h@example.com", via: "personal" })} onDecide={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Done in Azure DevOps")).toBeTruthy();
    // The raw answer is folded under the outcome, not dumped on the card.
    expect(screen.getByText("Show what Azure DevOps answered")).toBeTruthy();
    expect(screen.getByText('{"id":2688,"state":"Closed"}').closest("details")).toBeTruthy();
    expect(screen.getByText(/Confirmed by h@example\.com, through their own connection/)).toBeTruthy();
  });
  it("a refusal from the server (not the asker, already decided) is shown on the card", async () => {
    render(<ProposalCard p={p()} onDecide={vi.fn().mockRejectedValue(new Error("Only the person Forge proposed this change to can confirm or cancel it."))} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(await screen.findByText(/Only the person Forge proposed this change to/)).toBeTruthy();
  });
  it("a failed change says so in the service's words", () => {
    render(<ProposalCard p={p({ status: "failed", result: "action_failed: HTTP 401", decidedBy: "me" })} onDecide={null} />);
    expect(screen.getByText(/The service said: action_failed: HTTP 401/)).toBeTruthy();
  });
  it("⚠ a batch shows every item's exact values in a table, one click for all, and each item's result after", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const items = [{ work_item_id: 2688, state: "Closed" }, { work_item_id: 1722, state: "Closed", comment: "deferred/reassigned task" }];
    const { rerender } = render(<ProposalCard p={p({ summary: "Close 2 items", params: items })} onDecide={decide} />);
    expect(screen.getByRole("table", { name: /one row per item/ })).toBeTruthy();
    expect(screen.getByText("1722")).toBeTruthy();
    expect(screen.getByText("deferred/reassigned task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "run"));
    rerender(
      <ProposalCard
        p={p({ summary: "Close 2 items", params: items, status: "partial", result: "1 of 2 done; 1 failed", results: [{ ok: true, result: "{}" }, { ok: false, result: "HTTP 403" }], decidedBy: "me" })}
        onDecide={decide}
      />,
    );
    expect(screen.getByText("Partly done")).toBeTruthy();
    expect(screen.getByText("HTTP 403")).toBeTruthy();
    expect(screen.getByText("1 of 2 done; 1 failed")).toBeTruthy();
  });
});

describe("a file's content sent as base64", () => {
  it("is shown decoded, and says so; anything that is not readable text is shown as sent", async () => {
    const { decodedBase64 } = await import("./ProposalCard");
    const page = "<!doctype html>\n<h1>Northstar</h1>\n";
    const b64 = btoa(page);
    expect(decodedBase64(b64)).toBe(page);
    expect(decodedBase64("Close work item 2688")).toBeNull();
    expect(decodedBase64(btoa(String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17)))).toBeNull();
    expect(decodedBase64(1234)).toBeNull();
  });
});

describe("switching an action on (a setting card)", () => {
  const setting = (over: Record<string, unknown> = {}) =>
    ({
      id: "s1",
      kind: "setting",
      tool: "github_create_or_update_file",
      connector: "GitHub",
      action: "Create or Update File",
      summary: "Switch on GitHub · Create or Update File",
      params: {},
      status: "pending",
      at: "",
      setting: {
        piece: "@activepieces/piece-github",
        action: "create_or_update_file",
        service: "GitHub",
        title: "Create or Update File",
        on: true,
        describes: "Commits a file.",
        effect: "changes",
        current: "off",
        connection: "Team GitHub (the workspace's connection)",
        identity: "Connected as BLANCO-11",
        scopes: { me: true, workspace: "Switching it on for the whole workspace needs an Admin." },
        reason: "Pushing the mockup needs it",
        ...over,
      },
    }) as PiProposal;

  it("says what it does, through whose connection, what each place means and how to undo it", () => {
    render(<ProposalCard p={setting()} onDecide={vi.fn()} />);
    expect(screen.getByText(/changes data in GitHub/)).toBeTruthy();
    expect(screen.getByText(/Team GitHub \(the workspace's connection\)/)).toBeTruthy();
    expect(screen.getByText(/Connected as BLANCO-11/)).toBeTruthy();
    expect(screen.getByText(/every chat of yours in this workspace, now and later\. No automation and nobody else gains it/)).toBeTruthy();
    expect(screen.getByText(/Every automation and every chat/)).toBeTruthy();
    expect(screen.getByText(/recorded in the workspace's activity.*switch it off/)).toBeTruthy();
    expect(screen.getByText(/still shown to you as its own card/)).toBeTruthy();
  });

  it("the button picks the place; a place this person may not choose is disabled and says why", async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<ProposalCard p={setting()} onDecide={onDecide} />);
    const ws = screen.getByRole("button", { name: "Allow for the workspace" }) as HTMLButtonElement;
    expect(ws.disabled).toBe(true);
    expect(screen.getByText(/The workspace: Switching it on for the whole workspace needs an Admin/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow for me" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("s1", "run", "me"));
  });

  it("switching off is offered only where it is on now", () => {
    render(<ProposalCard p={setting({ on: false, current: "me", scopes: { me: true, workspace: "It is not on for the workspace." } })} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Switch off for me" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch off for the workspace" })).toBeNull();
  });

  it("once applied, says where and by whom", () => {
    render(<ProposalCard p={{ ...setting(), status: "done", scope: "me", decidedBy: "h@example.com", result: "Create or Update File is on for h@example.com in every Forge Agent chat of theirs here." }} onDecide={null} />);
    expect(screen.getByText(/Applied for them by h@example\.com/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
  });
  it("a card decided before actions were kept per person still says it was this chat", () => {
    render(<ProposalCard p={{ ...setting(), status: "done", scope: "chat", decidedBy: "h@example.com", result: "on in this chat only." }} onDecide={null} />);
    expect(screen.getByText(/Applied to this chat by h@example\.com/)).toBeTruthy();
  });
});

describe("an elegant card (2026-10-28)", () => {
  const file = Array.from({ length: 24 }, (_, i) => `<p>line ${i + 1}</p>`).join("\n");
  const commit = (over: Partial<PiProposal> = {}) =>
    p({ connector: "GitHub", action: "Create or Update File", summary: "Add the concept", params: { path: "index.html", content: btoa(file), message: "Add it" }, ...over });

  it("a file's content is folded to its first lines, says it was base64, and opens on Show all", () => {
    const { container } = render(<ProposalCard p={commit()} onDecide={vi.fn()} />);
    expect(screen.getByText("24 lines")).toBeTruthy();
    expect(screen.getByText("base64, shown decoded")).toBeTruthy();
    const code = container.querySelector(".pc-code")!;
    expect(code.className).not.toMatch(/\bopen\b/);
    fireEvent.click(screen.getByRole("button", { name: "Show all 24 lines" }));
    expect(container.querySelector(".pc-code")!.className).toMatch(/\bopen\b/);
  });

  it("done: where to see it, a few facts, and no wall of JSON", () => {
    render(
      <ProposalCard
        p={commit({ status: "done", result: '{"content":{"name":"index.html"}}', link: "https://github.com/o/r/blob/main/index.html", brief: [["name", "index.html"], ["sha", "65def7a"]], decidedBy: "me" })}
        onDecide={null}
      />,
    );
    const open = screen.getByRole("link", { name: "Open in GitHub ↗" }) as HTMLAnchorElement;
    expect(open.href).toBe("https://github.com/o/r/blob/main/index.html");
    expect(open.rel).toMatch(/noopener/);
    expect(screen.getByText("65def7a")).toBeTruthy();
  });
  it("a card decided before links were kept still finds the page in its stored answer", () => {
    render(<ProposalCard p={commit({ status: "done", result: '{"content":{"name":"index.html","html_url":"https://github.com/o/r/blob/main/index.html","git_url":"https://api.github.com/x"}', decidedBy: "me" })} onDecide={null} />);
    expect((screen.getByRole("link", { name: "Open in GitHub ↗" }) as HTMLAnchorElement).href).toBe("https://github.com/o/r/blob/main/index.html");
  });
});

describe("which account (plugins 8.5)", () => {
  const question = {
    piece: "@activepieces/piece-github",
    service: "GitHub",
    options: [
      { connectionId: "c-ws", label: "Team GitHub", personal: false, identity: "Connected as BLANCO-11" },
      { connectionId: "c-me", label: "Mine", personal: true, identity: null },
    ],
  };
  const card = (over: Partial<PiProposal> = {}) =>
    ({ id: "a1", kind: "account", tool: "github_list_issues", connector: "GitHub", action: "Choose a connection", summary: "Which GitHub should Forge use in this chat?", params: {}, status: "pending", at: "", choice: question, ...over }) as PiProposal;

  it("offers each connection by whose it is, and the pick is sent as the choice", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard p={card()} onDecide={decide} />);
    expect(screen.getByText(/Nothing was done yet/)).toBeTruthy();
    expect(screen.getByText("Connected as BLANCO-11")).toBeTruthy();
    fireEvent.click(screen.getByText("“Mine”").closest("button")!);
    await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", "run", undefined, "c-me"));
  });
  it("once chosen, says which, and offers nothing to click", () => {
    render(<ProposalCard p={card({ status: "done", choice: { ...question, chosen: "c-me" }, decidedBy: "h@example.com" })} onDecide={vi.fn()} />);
    expect(screen.getByText(/GitHub in this chat goes through your own “Mine”/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
  it("a change card names the account it goes through, before and after", () => {
    const account = { connectionId: "c-me", label: "Mine", personal: true, identity: "Connected as himanshu-ml" };
    const { rerender } = render(<ProposalCard p={p({ account })} onDecide={vi.fn()} />);
    expect(screen.getByText(/It goes through your own “Mine” \(Connected as himanshu-ml\)/)).toBeTruthy();
    rerender(<ProposalCard p={p({ account, status: "done", decidedBy: "me", result: "{}" })} onDecide={null} />);
    expect(screen.getByText(/Confirmed by me, through their own “Mine”/)).toBeTruthy();
  });
});

describe("plugin relay from a device", () => {
  it("names the device on a pending Approve card", () => {
    render(
      <ProposalCard
        p={p({
          summary: "Post hello from Mac",
          relay: { requestId: "r1", deviceId: "d1", deviceName: "MacBook" },
        })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/MacBook ·/)).toBeTruthy();
    expect(screen.getByText(/Requested from MacBook through Foundry/)).toBeTruthy();
  });
});

describe("edge jobs (remote computer)", () => {
  const edge = (over: Partial<PiProposal> = {}): PiProposal =>
    ({
      id: "e1",
      kind: "edge",
      tool: "edge-run",
      connector: "mac",
      action: "Run a command",
      summary: "Run `npm install` on mac",
      params: { command: "npm install" },
      status: "pending",
      at: "",
      edge: { jobId: "j1", deviceId: "d1", deviceName: "mac", kind: "run_command" },
      ...over,
    }) as PiProposal;

  it("a pending edge job stays a full Approve card", () => {
    render(<ProposalCard p={edge()} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByTestId("edge-action-line")).toBeNull();
  });

  it("a settled edge job collapses to an Actions one-liner", () => {
    render(<ProposalCard p={edge({ status: "done", result: "ok\n" })} onDecide={null} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByTestId("edge-action-line")).toBeTruthy();
    expect(screen.getByText("mac · $ npm install")).toBeTruthy();
  });
});
