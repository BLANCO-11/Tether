// @vitest-environment jsdom
//
// `CopyableId` is the one place both the Workflow ID and Run ID columns in
// History get their truncate/copy/toast behavior, so a bug here is a bug in
// two columns at once. See history/page.tsx and CLAUDE.md's spec entry for
// "flow-history-name-snapshot" User Story 4.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });
vi.mock("@/lib/toast", () => ({
  useToast: () => toast,
}));

import { CopyableId } from "./CopyableId";

afterEach(() => {
  cleanup();
  toast.mockReset();
  // Reset between tests; jsdom has no real clipboard to begin with.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

const FULL_ID = "e8a82948-431f-4eaf-89bf-a731448f0746";

describe("CopyableId", () => {
  it("shows only the first 5 characters, plus an ellipsis — never the full id inline", () => {
    render(<CopyableId id={FULL_ID} />);
    expect(screen.getByText("e8a82…")).toBeTruthy();
    expect(screen.queryByText(FULL_ID)).toBeNull();
  });

  it("carries the full id in `title`, for anyone who hovers", () => {
    render(<CopyableId id={FULL_ID} />);
    expect(screen.getByText("e8a82…").getAttribute("title")).toBe(FULL_ID);
  });

  it("clicking the copy button writes the FULL id to the clipboard, not the truncated form", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyableId id={FULL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

    expect(writeText).toHaveBeenCalledWith(FULL_ID);
    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/copied/i));
  });

  it("a clipboard failure reports itself via toast — never a silent no-op", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("no clipboard"));
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyableId id={FULL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

    await Promise.resolve();
    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not copy/i));
  });

  it("an absent clipboard API (plain http, non-localhost) reports failure the same way", async () => {
    // ⚠ `navigator.clipboard` is genuinely undefined in that case, not a
    // rejected promise — the same best-effort shape as FlowIntegrationPanel.tsx
    // and AllowRequest.tsx already handle.
    render(<CopyableId id={FULL_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not copy/i));
  });

  it("renders a placeholder and NO copy button when the id is null", () => {
    render(<CopyableId id={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy id" })).toBeNull();
  });

  it("a short id (fewer than 5 characters) is shown whole, still with an ellipsis", () => {
    // The truncation rule is "first 5 characters"; an id shorter than that has
    // no 6th character to hide, but the ellipsis stays so the cell's shape is
    // uniform rather than one row looking different from the rest.
    render(<CopyableId id="ab1" />);
    expect(screen.getByText("ab1…")).toBeTruthy();
  });
});

describe("CopyableId — navigating to the id's own page (User Story 7)", () => {
  it("with an `href`, the truncated text is a link to it", () => {
    render(<CopyableId id={FULL_ID} href="/flows/some-flow-id" />);
    const link = screen.getByRole("link", { name: "e8a82…" });
    expect(link.getAttribute("href")).toBe("/flows/some-flow-id");
    // The full id is still what a hover reveals — linking must not cost the
    // existing title affordance.
    expect(link.getAttribute("title")).toBe(FULL_ID);
  });

  it("without an `href`, it stays a plain span — no behavior change for existing callers", () => {
    render(<CopyableId id={FULL_ID} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("e8a82…").tagName).not.toBe("A");
  });

  it("the copy button and the link are independent — clicking copy does not require or touch the link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyableId id={FULL_ID} href="/flows/some-flow-id" />);
    // ⚠ The button must not be INSIDE the link — a button nested in an <a>
    // is ambiguous for both click handling and assistive tech, which is
    // exactly the bug a naive "wrap the whole cell in a Link" would add.
    const link = screen.getByRole("link", { name: "e8a82…" });
    const button = screen.getByRole("button", { name: "Copy id" });
    expect(link.contains(button)).toBe(false);
    expect(button.contains(link)).toBe(false);

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(FULL_ID);
    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/copied/i));
  });

  it("`id: null` renders no link even if `href` is somehow passed — nothing to point at", () => {
    render(<CopyableId id={null} href="/flows/some-flow-id" />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
