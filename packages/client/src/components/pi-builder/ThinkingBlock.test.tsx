// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PHRASE_MS, PHRASES, ThinkingBlock, WorkingLine, thoughtFor } from "./ThinkingBlock";

afterEach(() => cleanup());

describe("ThinkingBlock", () => {
  it("draws nothing when there is no thinking to show", () => {
    const { container } = render(<ThinkingBlock text="  " ms={4000} />);
    expect(container.innerHTML).toBe("");
  });

  it("a finished reply's thinking is folded to how long it took, and opens on click", () => {
    render(<ThinkingBlock text="Weigh four against four first." ms={12_400} />);
    const head = screen.getByRole("button", { name: /Thought for 12s/ });
    expect(screen.queryByText("Weigh four against four first.")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("Weigh four against four first.")).toBeTruthy();
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("streams open while the model is thinking, with the mark at work", () => {
    const { container } = render(<ThinkingBlock text="Comparing the two readers…" live />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.getByText("Comparing the two readers…")).toBeTruthy();
    expect(container.querySelector(".forge-mark.is-working")).not.toBeNull();
  });

  it("says how long in plain words", () => {
    expect(thoughtFor(300)).toBe("Thought for a moment");
    expect(thoughtFor(9_000)).toBe("Thought for 9s");
    expect(thoughtFor(75_000)).toBe("Thought for 1m 15s");
  });
});

describe("WorkingLine", () => {
  afterEach(() => vi.useRealTimers());
  const visible = (c: HTMLElement) => c.querySelector(".wl-stage > span:last-child")!.textContent;

  it("with nothing to say, shows a phrase about the work beside Forge's mark at work — and tells a screen reader plainly", () => {
    const { container } = render(<WorkingLine label={null} elapsed={0} />);
    expect(PHRASES.map((p) => `${p}…`)).toContain(visible(container));
    expect(container.querySelector(".forge-mark.is-working")).not.toBeNull();
    expect(container.querySelector(".wl-stage")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".sr-only")!.textContent).toBe("Forge is working");
  });

  it("moves on to a different phrase, the old one leaving and the new one coming in", () => {
    vi.useFakeTimers();
    const { container } = render(<WorkingLine label={null} elapsed={0} />);
    const first = visible(container);
    for (let i = 0; i < 4; i++) {
      const before = visible(container);
      act(() => vi.advanceTimersByTime(PHRASE_MS));
      expect(visible(container)).not.toBe(before);
    }
    expect(container.querySelector(".wl-out")).not.toBeNull();
    expect(container.querySelector(".wl-in")).not.toBeNull();
    expect(first).toBeTruthy();
  });

  it("what Forge is doing holds still, comes in the same way, and the clock shows past 15 seconds", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<WorkingLine label={null} elapsed={0} />);
    rerender(<WorkingLine label="Writing the send step…" elapsed={75} />);
    expect(visible(container)).toBe("Writing the send step…");
    expect(container.querySelector(".wl-in")).not.toBeNull();
    act(() => vi.advanceTimersByTime(PHRASE_MS * 3));
    expect(visible(container)).toBe("Writing the send step…");
    expect(screen.getByRole("status").textContent).toContain("1:15");
    expect(container.querySelector(".sr-only")!.textContent).toBe("Writing the send step…");
  });
});
