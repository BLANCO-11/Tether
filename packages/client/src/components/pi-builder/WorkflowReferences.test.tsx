// @vitest-environment jsdom
/**
 * Workflow references on screen: `@` finds a mention (never an email address), chips say "saved N" (never a bare
 * vN), offer a newer saved version without taking it, say when a workflow was deleted, grey out in Forge Agent, and
 * a list that could not be read says so rather than looking empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { KeyboardEvent } from "react";

const api = vi.hoisted(() => ({ listReferenceable: vi.fn() }));
vi.mock("@/lib/pi-builder", async (orig) => ({ ...(await orig<typeof import("@/lib/pi-builder")>()), listReferenceable: api.listReferenceable }));

import { mentionAt, withoutMention, type WorkflowReference } from "@/lib/pi-builder";
import { ReferenceChips, ReferencePicker } from "./WorkflowReferences";

afterEach(() => {
  cleanup();
  api.listReferenceable.mockReset();
});

describe("mentionAt", () => {
  it("finds the @mention being typed, with spaces in the name", () => {
    expect(mentionAt("use @Monthly Att", 16)).toEqual({ start: 4, query: "Monthly Att" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("is not an email address, not past a new line, and not when the caret is before the @", () => {
    expect(mentionAt("mail a@b.com", 12)).toBeNull();
    expect(mentionAt("@x\nmore", 7)).toBeNull();
    expect(mentionAt("hello @x", 3)).toBeNull();
  });
  it("takes the mention out of the text when a workflow is picked", () => {
    expect(withoutMention("like @Month please", 5, 11)).toBe("like please");
    expect(withoutMention("@Month", 0, 6)).toBe("");
  });
});

const ref = (over: Partial<WorkflowReference> = {}): WorkflowReference => ({
  id: "r1",
  flowId: "f1",
  name: "Monthly Attendance Report + Pivot",
  revision: 1,
  label: "saved 1 · not approved",
  cardMd: "# Monthly Attendance Report + Pivot\nSaved version 1, saved 2026-10-12, not approved.\n",
  deleted: false,
  newer: null,
  versions: [{ revision: 1, savedAt: "2026-10-12T09:00:00Z", approvedAs: null, label: "saved 1 · not approved" }],
  ...over,
});

const chips = (refs: WorkflowReference[] | null, extra: Partial<Parameters<typeof ReferenceChips>[0]> = {}) => {
  const onSetVersion = vi.fn(async () => true);
  const onRemove = vi.fn(async () => true);
  render(
    <ReferenceChips refs={refs} error={null} mode="workflow" busy={false} onDismissError={() => {}} onSetVersion={onSetVersion} onRemove={onRemove} {...extra} />,
  );
  return { onSetVersion, onRemove };
};

describe("the chips", () => {
  it("draw nothing with no references", () => {
    const { container } = render(
      <ReferenceChips refs={[]} error={null} mode="workflow" busy={false} onDismissError={() => {}} onSetVersion={async () => true} onRemove={async () => true} />,
    );
    expect(container.textContent).toBe("");
  });

  it('say "saved N" and never a bare vN, and open the card Forge sees', () => {
    chips([ref()]);
    const list = screen.getByRole("list", { name: "Referenced workflows" });
    expect(list.textContent).toContain("saved 1 · not approved");
    expect(list.textContent).not.toMatch(/\bv1\b/);
    fireEvent.click(screen.getByRole("button", { name: /^Monthly Attendance Report/ }));
    expect(screen.getByLabelText("Reference: Monthly Attendance Report + Pivot").textContent).toContain("Saved version 1, saved 2026-10-12");
  });

  it("offer a newer saved version and take it only when clicked", () => {
    const { onSetVersion } = chips([
      ref({
        newer: 2,
        versions: [
          { revision: 1, savedAt: null, approvedAs: null, label: "saved 1 · not approved" },
          { revision: 2, savedAt: null, approvedAs: 1, label: "saved 2 · approved as v1" },
        ],
      }),
    ]);
    expect(onSetVersion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /saved 2 available/ }));
    expect(onSetVersion).toHaveBeenCalledWith("r1", 2);
  });

  it("let an older version be chosen from the list", () => {
    const { onSetVersion } = chips([
      ref({
        revision: 2,
        label: "saved 2 · not approved",
        versions: [
          { revision: 1, savedAt: null, approvedAs: null, label: "saved 1 · not approved" },
          { revision: 2, savedAt: null, approvedAs: null, label: "saved 2 · not approved" },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Monthly Attendance Report/ }));
    fireEvent.click(screen.getByRole("radio", { name: /saved 1/ }));
    expect(onSetVersion).toHaveBeenCalledWith("r1", 1);
  });

  it("say a deleted workflow is deleted, with no version list", () => {
    chips([ref({ deleted: true, flowId: null, versions: [] })]);
    expect(screen.getByRole("list", { name: "Referenced workflows" }).textContent).toContain("deleted");
    fireEvent.click(screen.getByRole("button", { name: /^Monthly Attendance Report/ }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText(/Forge still reads the copy of saved 1/)).toBeTruthy();
  });

  it("remove a reference", () => {
    const { onRemove } = chips([ref()]);
    fireEvent.click(screen.getByRole("button", { name: "Stop referencing Monthly Attendance Report + Pivot" }));
    expect(onRemove).toHaveBeenCalledWith("r1");
  });

  it("say they are used in Workflow Builder only, in Forge Agent", () => {
    chips([ref()], { mode: "agent" });
    expect(screen.getByText("Used in Workflow Builder only")).toBeTruthy();
  });

  it("show an error rather than an empty list when the references could not be read", () => {
    chips(null, { error: "Could not load the referenced workflows: 500" });
    expect(screen.getByRole("alert").textContent).toContain("Could not load the referenced workflows");
  });
});

describe("the @ picker", () => {
  const keys = { current: null as ((e: KeyboardEvent<HTMLTextAreaElement>) => boolean) | null };
  const key = (k: string) => {
    let handled = false;
    act(() => {
      handled = keys.current!({ key: k } as KeyboardEvent<HTMLTextAreaElement>);
    });
    return handled;
  };

  it("lists saved workflows filtered by the query, and Enter picks the highlighted one", async () => {
    api.listReferenceable.mockResolvedValue([
      { flowId: "a", name: "Monthly Attendance Report", latest: 1, latestLabel: "saved 1 · not approved", savedAt: null },
      { flowId: "b", name: "Leave balance", latest: 3, latestLabel: "saved 3 · approved as v1", savedAt: null },
    ]);
    const onPick = vi.fn();
    render(<ReferencePicker workspaceId="w" sessionId="s" query="" mode="workflow" count={0} keys={keys} onPick={onPick} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("listbox").textContent).toContain("saved 3 · approved as v1");
    key("ArrowDown");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("filters by name", async () => {
    api.listReferenceable.mockResolvedValue([
      { flowId: "a", name: "Monthly Attendance Report", latest: 1, latestLabel: "saved 1 · not approved", savedAt: null },
      { flowId: "b", name: "Leave balance", latest: 3, latestLabel: "saved 3 · not approved", savedAt: null },
    ]);
    render(<ReferencePicker workspaceId="w" sessionId="s" query="leave" mode="workflow" count={0} keys={keys} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").textContent).toContain("Leave balance");
  });

  it("says why it cannot add: at the limit, and in Forge Agent — without asking the server", () => {
    const { unmount } = render(<ReferencePicker workspaceId="w" sessionId="s" query="" mode="workflow" count={3} keys={keys} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain("already references 3 workflows");
    unmount();
    render(<ReferencePicker workspaceId="w" sessionId="s" query="" mode="agent" count={0} keys={keys} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain("Workflow Builder only");
    expect(api.listReferenceable).not.toHaveBeenCalled();
  });

  it("says the list could not be read, never that there is nothing to reference", async () => {
    api.listReferenceable.mockRejectedValue(new Error('500 {"error":"internal_error"}'));
    render(<ReferencePicker workspaceId="w" sessionId="s" query="" mode="workflow" count={0} keys={keys} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not load the saved workflows"));
    expect(screen.queryByText(/no other saved workflows/)).toBeNull();
  });

  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(<ReferencePicker workspaceId="w" sessionId="s" query="" mode="agent" count={0} keys={keys} onPick={() => {}} onClose={onClose} />);
    expect(key("Escape")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
