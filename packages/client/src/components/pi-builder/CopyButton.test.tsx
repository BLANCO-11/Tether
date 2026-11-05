// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./CopyButton";

describe("a message's copy button", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("copies the text and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", true);
    render(<CopyButton text="Hello there" label="Copy reply" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy reply" })));
    expect(writeText).toHaveBeenCalledWith("Hello there");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says when it could not copy", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    vi.stubGlobal("isSecureContext", true);
    document.execCommand = vi.fn(() => false);
    render(<CopyButton text="x" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(screen.getByRole("button", { name: "Could not copy" })).toBeTruthy();
  });

  it("is not shown for an empty message", () => {
    const { container } = render(<CopyButton text="  " />);
    expect(container.textContent).toBe("");
  });
});
