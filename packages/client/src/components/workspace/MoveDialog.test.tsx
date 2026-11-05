// @vitest-environment jsdom
//
// Sharing boundaries phase 5 — moving a workflow or a chat. ⚠ What is pinned: the dialog says what a move would change
// BEFORE it happens (who stops seeing it, by name), Move waits for that answer, the place it is in now cannot be
// chosen, and a refusal is shown in the server's own words.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MovePreview } from "@/lib/foundry-client";

const api = vi.hoisted(() => ({
  listProjects: vi.fn(async (): Promise<unknown> => [{ id: "p1", name: "Payroll close", members: 3, mine: true }]),
  movePreview: vi.fn(),
  moveItem: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("@/lib/api", () => api);

const { MoveDialog, placeKey, placeLabel, previewSentences } = await import("./MoveDialog");

const preview = (over: Partial<MovePreview> = {}): MovePreview => ({
  from: { kind: "project", projectId: "p1" },
  to: { kind: "mine" },
  loses: [],
  gains: 0,
  live: false,
  turnedOnBy: [],
  referencedBy: [],
  narrows: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("where it lives, in words", () => {
  it("names the place from the item's own fields", () => {
    expect(placeKey({ visibility: "private" })).toBe("mine");
    expect(placeKey({ visibility: "public" })).toBe("workspace");
    expect(placeKey({ visibility: "public", projectId: "p1" })).toBe("project:p1");
    expect(placeLabel("project:p1", [{ id: "p1", name: "Payroll close" }])).toBe("Payroll close");
    expect(placeLabel("project:zz", [])).toBe("A project");
  });
  it("⚠ says who would stop seeing it by name, who loses a copy they turned on, and what uses it", () => {
    const s = previewSentences(preview({ loses: ["bob@x.example", "cy@x.example"], narrows: true, live: true, turnedOnBy: ["bob@x.example"], referencedBy: ["Weekly chat"] }), "flow");
    expect(s[0]).toBe("These people would stop seeing this workflow: bob@x.example, cy@x.example.");
    expect(s.join(" ")).toContain("bob@x.example turned it on for themselves. It would stop running for them");
    expect(s.join(" ")).toContain("It runs on its own");
    expect(s.join(" ")).toContain("Chats that use it: Weekly chat.");
  });
  it("CONTROL: a move that changes nobody says so, and a widening counts who gains", () => {
    expect(previewSentences(preview(), "chat")).toEqual(["The same people see this chat there."]);
    expect(previewSentences(preview({ gains: 4 }), "chat")).toEqual(["4 more people would see this chat."]);
  });
});

describe("the dialog", () => {
  const open = () =>
    render(<MoveDialog item={{ kind: "flow", id: "f1" }} name="Weekly issues" current="project:p1" onClose={() => {}} onMoved={onMoved} />);
  const onMoved = vi.fn();

  it("⚠ asks first, shows who loses it, and only then moves", async () => {
    api.movePreview.mockResolvedValue(preview({ loses: ["bob@x.example"], narrows: true }));
    open();
    // Where it is now cannot be chosen.
    expect(((await screen.findByLabelText("Payroll close")) as HTMLInputElement).disabled).toBe(true);
    const move = screen.getByRole("button", { name: "Move" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("My space"));
    // Chosen, but not yet answered: still not movable.
    expect(move.disabled).toBe(true);
    expect(await screen.findByText("This person would stop seeing this workflow: bob@x.example.")).toBeTruthy();
    expect(api.movePreview).toHaveBeenCalledWith({ kind: "flow", id: "f1" }, "mine");
    expect(api.moveItem).not.toHaveBeenCalled();
    fireEvent.click(move);
    await waitFor(() => expect(api.moveItem).toHaveBeenCalledWith({ kind: "flow", id: "f1" }, "mine"));
    expect(onMoved).toHaveBeenCalledWith("mine", {}, "My space");
  });

  it("a refusal is shown in the server's words, and nothing is reported moved", async () => {
    api.movePreview.mockResolvedValue(preview({ gains: 5 }));
    api.moveItem.mockRejectedValueOnce(new Error('403 {"message":"Only its owner or an Admin can do this."}'));
    open();
    fireEvent.click(await screen.findByLabelText("Workspace"));
    await screen.findByText("5 more people would see this workflow.");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(await screen.findByText("Only its owner or an Admin can do this.")).toBeTruthy();
    expect(onMoved).not.toHaveBeenCalled();
  });
});
