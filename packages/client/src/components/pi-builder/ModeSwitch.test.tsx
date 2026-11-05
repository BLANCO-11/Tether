// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModeSwitch } from "./ModeSwitch";
import { chatMatches, isUnsavedDraft } from "@/lib/pi-builder";

const quiet = { loadDefault: async () => "workflow" as const, saveDefault: async (m: "workflow" | "agent") => m };

describe("the chat's mode switch", () => {
  afterEach(cleanup);

  it("is not shown where the workspace does not offer Forge Agent, and reads nothing", () => {
    const loadDefault = vi.fn(quiet.loadDefault);
    const { container } = render(<ModeSwitch mode="workflow" agentAllowed={false} busy={false} onSwitch={async () => {}} loadDefault={loadDefault} />);
    expect(container.textContent).toBe("");
    expect(loadDefault).not.toHaveBeenCalled();
  });

  it("switches to the other mode, and not while Forge is answering", async () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<ModeSwitch mode="workflow" agentAllowed busy={false} onSwitch={onSwitch} {...quiet} />);
    expect(screen.getByRole("switch", { name: "Forge Agent" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Forge Agent" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("agent"));
    rerender(<ModeSwitch mode="workflow" agentAllowed busy onSwitch={onSwitch} {...quiet} />);
    expect((screen.getByRole("switch", { name: "Forge Agent" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns off to Workflow Builder", async () => {
    const onSwitch = vi.fn(async () => {});
    render(<ModeSwitch mode="agent" agentAllowed busy={false} onSwitch={onSwitch} {...quiet} />);
    expect(screen.getByRole("switch", { name: "Forge Agent" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Forge Agent" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("workflow"));
  });

  it("says why a switch was refused, in the server's words", async () => {
    const onSwitch = async () => {
      throw new Error('403 {"message":"Forge Agent is not turned on for this workspace."}');
    };
    render(<ModeSwitch mode="workflow" agentAllowed busy={false} onSwitch={onSwitch} {...quiet} />);
    fireEvent.click(screen.getByRole("switch", { name: "Forge Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Forge Agent is not turned on for this workspace.");
  });

  it("offers to make the current mode the default only when it is not already", async () => {
    const saveDefault = vi.fn(async (m: "workflow" | "agent") => m);
    render(<ModeSwitch mode="agent" agentAllowed busy={false} onSwitch={async () => {}} loadDefault={quiet.loadDefault} saveDefault={saveDefault} />);
    fireEvent.click(await screen.findByText("Make default"));
    await waitFor(() => expect(saveDefault).toHaveBeenCalledWith("agent"));
    await waitFor(() => expect(screen.queryByText("Make default")).toBeNull());
  });

  it("lets a Forge Agent chat whose workspace turned it off be turned back to Workflow Builder", () => {
    render(<ModeSwitch mode="agent" agentAllowed={false} busy={false} onSwitch={async () => {}} {...quiet} />);
    expect((screen.getByRole("switch", { name: "Forge Agent" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the Chats page's filters", () => {
  const chat = (over: Partial<{ flowId: string | null; draftSteps: number; mode: "workflow" | "agent" }>) => ({ flowId: null, draftSteps: 0, ...over });
  it("finds unsaved builds, and each mode, an older chat counting as Workflow Builder", () => {
    expect(isUnsavedDraft(chat({ draftSteps: 3 }))).toBe(true);
    expect(isUnsavedDraft(chat({ draftSteps: 3, flowId: "f" }))).toBe(false);
    expect(isUnsavedDraft(chat({}))).toBe(false);
    expect(chatMatches(chat({ mode: "agent" }), "agent")).toBe(true);
    expect(chatMatches(chat({}), "workflow")).toBe(true);
    expect(chatMatches(chat({ mode: "agent" }), "workflow")).toBe(false);
    expect(chatMatches(chat({ draftSteps: 2 }), "drafts")).toBe(true);
    expect(chatMatches(chat({ mode: "agent" }), "all")).toBe(true);
  });
});
