// @vitest-environment jsdom
/**
 * Chat Files explorer: VS Code-style tree + Drive-style overview (no name dropdown).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PiSidePane, type ChatFile } from "./PiSidePane";

vi.mock("@/lib/api", () => ({ flowReadSources: vi.fn(async () => []) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const chatFiles: ChatFile[] = [
  { name: "brief.pdf", size: 2048, type: "application/pdf", from: "you" },
  { name: "mock.html", size: 17_000, type: "text/plain", from: "forge" },
];
const pane = (over: Partial<Parameters<typeof PiSidePane>[0]> = {}) => (
  <PiSidePane
    view={{ kind: "files" }}
    onView={() => undefined}
    docked
    workflow={{ steps: [] } as never}
    files={{}}
    baseFiles={null}
    live={false}
    lastRun={null}
    chatFiles={chatFiles}
    chatFileHref={(n) => `/f/${n}`}
    storage={{ bytes: 1024 * 1024, limit: 300 * 1024 * 1024 } as never}
    {...over}
  />
);

describe("the explorer", () => {
  it("with no workflow: tree + Drive overview, no dropdown menu, no auto-open", () => {
    render(pane());
    expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
    expect(screen.getByText("Made by Forge")).toBeTruthy();
    expect(screen.getByText("From you")).toBeTruthy();
    expect(screen.getByRole("list", { name: "All files in this chat" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("html-preview")).toBeNull();
    expect(screen.getByText(/of 300 MB used by this chat/)).toBeTruthy();
  });

  it("picking a file from the overview opens it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ onView }));
    const grid = screen.getByRole("list", { name: "All files in this chat" });
    fireEvent.click(within(grid).getByRole("button", { name: /mock\.html/ }));
    expect(onView).toHaveBeenCalledWith({ kind: "files", path: "chat:mock.html" });
  });

  it("with a path: preview opens and All files clears the path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ view: { kind: "files", path: "chat:mock.html" }, onView }));
    expect(await screen.findByTestId("html-preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(await screen.findByTestId("code-view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(onView).toHaveBeenCalledWith({ kind: "files" });
  });

  it("shows the open file full screen, and Esc leaves full screen without closing the pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ view: { kind: "files", path: "chat:mock.html" }, onView }));
    await screen.findByTestId("html-preview");
    fireEvent.click(screen.getByRole("button", { name: "Full screen preview" }));
    const full = screen.getByRole("dialog", { name: "mock.html, full screen" });
    expect(full.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onView).not.toHaveBeenCalled();
  });

  it("CONTROL: with a workflow, the list column is there and it can be hidden", () => {
    render(pane({ workflow: { name: "w", steps: [{ id: "a", entry: "steps/a/main.py" }] } as never, chatFiles: [] }));
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.getByLabelText("Contents of workflow.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the file list" }));
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  });
});
