// @vitest-environment jsdom
//
// The connections a Forge Agent chat uses: one quiet control naming them, a panel saying whose account each goes
// through, Change forgetting a choice, and nothing at all when the chat has made none.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PiAccountChoice } from "@/lib/pi-builder";
import { ChatConnections } from "./ChatConnections";

afterEach(cleanup);

const choice = (service: string, label: string, personal: boolean): PiAccountChoice => ({
  connectionId: `c-${service}`,
  label,
  personal,
  identity: null,
  service,
  chosenBy: "Ada",
  at: "",
});
const BOTH = { "piece-github": choice("GitHub", "foundry-test-personal", true), "piece-azure-devops": choice("Azure DevOps", "Team", false) };

describe("the connections a chat uses", () => {
  it("is one closed control naming them, and opens to say whose account each goes through", () => {
    render(<ChatConnections accounts={BOTH} busy={false} onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: /2 connections/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull(); // nothing spread across the chat until asked
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Connections this chat uses" })).toBeTruthy();
    expect(screen.getByText("Your own · foundry-test-personal")).toBeTruthy();
    expect(screen.getByText("The workspace's · Team")).toBeTruthy();
  });

  it("names a single service rather than counting it", () => {
    render(<ChatConnections accounts={{ "piece-github": BOTH["piece-github"] }} busy={false} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /GitHub/ })).toBeTruthy();
  });

  it("Change forgets that service's choice; Escape closes the panel", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<ChatConnections accounts={BOTH} busy={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /2 connections/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change the Azure DevOps connection for this chat" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("piece-azure-devops"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed change is said in the panel", async () => {
    render(<ChatConnections accounts={BOTH} busy={false} onChange={vi.fn().mockRejectedValue(new Error("could not forget it"))} />);
    fireEvent.click(screen.getByRole("button", { name: /2 connections/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change the GitHub connection for this chat" }));
    expect(await screen.findByText("could not forget it")).toBeTruthy();
  });

  it("while Forge is working, Change waits", () => {
    render(<ChatConnections accounts={BOTH} busy onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /2 connections/ }));
    expect((screen.getByRole("button", { name: "Change the GitHub connection for this chat" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("CONTROL: no choice made, nothing drawn", () => {
    const { container } = render(<ChatConnections accounts={{}} busy={false} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
