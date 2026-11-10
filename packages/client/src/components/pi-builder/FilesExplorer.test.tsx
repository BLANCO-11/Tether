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

const wf = { name: "w", steps: [{ id: "a", entry: "steps/a/main.py" }] } as never;

describe("the explorer", () => {
  it("lists rows with name and size, grouped by who made them, with no dropdown and no auto-open", () => {
    render(pane());
    expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
    expect(screen.getByText("Made by Forge")).toBeTruthy();
    expect(screen.getByText("Uploaded by you")).toBeTruthy();
    const row = screen.getByRole("button", { name: /mock\.html/ });
    expect(row.textContent).toContain("17 KB");
    expect(row.textContent).toContain("Forge");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("html-preview")).toBeNull();
    expect(screen.getByText(/of 300 MB used by this chat/)).toBeTruthy();
  });

  it("has a single header: no separate 'All files' bar or tree toggle", () => {
    const { container } = render(pane());
    expect(container.querySelectorAll(".pis-bar")).toHaveLength(1);
    expect(screen.queryByText("All files")).toBeNull();
    expect(screen.queryByRole("button", { name: /file list/ })).toBeNull();
  });

  it("leaves out group labels when there is only one group", () => {
    render(pane({ chatFiles: [chatFiles[1]!] }));
    expect(screen.queryByText("Made by Forge")).toBeNull();
  });

  it("says so, in one line, when there are no files", () => {
    render(pane({ chatFiles: [] }));
    expect(screen.getByText(/No files yet/)).toBeTruthy();
  });

  it("toggles to a grid of cards and back", () => {
    render(pane());
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getAllByRole("list").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("clicking a row opens it", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ onView }));
    fireEvent.click(screen.getByRole("button", { name: /mock\.html/ }));
    expect(onView).toHaveBeenCalledWith({ kind: "files", path: "chat:mock.html" });
  });

  it("clicking a grid card opens it too", () => {
    const onView = vi.fn();
    render(pane({ onView }));
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    const grids = screen.getAllByRole("list");
    fireEvent.click(within(grids[0]!).getByRole("button", { name: /mock\.html/ }));
    expect(onView).toHaveBeenCalledWith({ kind: "files", path: "chat:mock.html" });
  });

  it("with a path: the preview opens with a way back, which clears the path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    const onView = vi.fn();
    render(pane({ view: { kind: "files", path: "chat:mock.html" }, onView }));
    expect(await screen.findByTestId("html-preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(await screen.findByTestId("code-view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(onView).toHaveBeenCalledWith({ kind: "files" });
  });

  it("when wide, shows the list and the preview side by side", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>hi</p>")));
    render(pane({ expanded: true, view: { kind: "files", path: "chat:mock.html" } }));
    expect(await screen.findByTestId("html-preview")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
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

  it("folders are tree rows that expand and collapse; clicking a file in one opens it", () => {
    const onView = vi.fn();
    render(pane({ workflow: wf, files: { "steps/a/main.py": "print(1)" }, chatFiles: [], onView }));
    const dir = screen.getByRole("button", { name: /^steps$/ });
    expect(dir.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTitle("steps/a/main.py"));
    expect(onView).toHaveBeenCalledWith({ kind: "files", path: "steps/a/main.py" });
    fireEvent.click(dir);
    expect(dir.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTitle("steps/a/main.py")).toBeNull();
  });

  it("a workflow file opens its code in the same pane", () => {
    render(pane({ workflow: wf, chatFiles: [], view: { kind: "files", path: "workflow.json" } }));
    expect(screen.getByLabelText("Contents of workflow.json")).toBeTruthy();
  });
});
