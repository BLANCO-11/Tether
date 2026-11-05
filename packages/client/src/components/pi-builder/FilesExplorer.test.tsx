// @vitest-environment jsdom
/**
 * The Files pane as an explorer (2026-10-28): in a chat with no workflow it shows only the chat's files, grouped by who
 * made them, opens Forge's file at once, keeps one toolbar over it (name, Page/Source, download) and lets the list be
 * hidden and the files take the whole width.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("with no workflow: no list column, one bar, Forge's file open, the name switches files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    render(pane());
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
    expect(screen.queryByText("Workflow")).toBeNull();
    expect(document.querySelectorAll(".pis-bar")).toHaveLength(1);
    expect(await screen.findByTestId("html-preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(await screen.findByTestId("code-view")).toBeTruthy();
    // The name is the menu: every file, Forge's first, and how full the folder is.
    fireEvent.click(screen.getByRole("button", { name: /mock\.html/ }));
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items[0]).toMatch(/^.*mock\.html.*by Forge/);
    expect(items[1]).toMatch(/brief\.pdf.*yours/);
    expect(screen.getByText(/of 300 MB used by this chat/)).toBeTruthy();
  });

  it("picking a file opens it, and Esc closes only the menu", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
    const onView = vi.fn();
    render(pane({ onView }));
    fireEvent.click(screen.getByRole("button", { name: /mock\.html/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /mock\.html/ }));
    fireEvent.click(screen.getAllByRole("menuitem")[1]!);
    expect(onView).toHaveBeenCalledWith({ kind: "files", path: "chat:brief.pdf" });
  });

  it("shows the open file full screen, and Esc leaves full screen without closing the pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ onView }));
    fireEvent.click(screen.getByRole("button", { name: "Full screen preview" }));
    const full = screen.getByRole("dialog", { name: "mock.html, full screen" });
    expect(full.parentElement).toBe(document.body);
    expect(full.querySelector("[role=tablist]")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onView).not.toHaveBeenCalled();
    // A click on the dark backdrop leaves too; a click on the file itself does not.
    fireEvent.click(screen.getByRole("button", { name: "Full screen preview" }));
    const again = screen.getByRole("dialog");
    fireEvent.mouseDown(again.querySelector(".pis-full-card")!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(again);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CONTROL: with a workflow, the list column is there (it shows real structure), and it can be hidden", () => {
    render(pane({ workflow: { name: "w", steps: [{ id: "a", entry: "steps/a/main.py" }] } as never, chatFiles: [] }));
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.getByLabelText("Contents of workflow.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the file list" }));
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  });
});
