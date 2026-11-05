// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { FadingText, resetStreamedText, useSmoothText, useStreamedText } from "./StreamedText";

const reduced = (on: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: on, media: q })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "setInterval"] });
  resetStreamedText();
  reduced(false);
});
afterEach(() => vi.useRealTimers());

const GREETING = "Hi Himanshu. What should we automate in Finance?\n\nDescribe it in your own words.";

describe("useStreamedText — the greeting", () => {
  it("reveals smoothly from nothing, partway after a moment, whole within a couple of seconds", () => {
    const { result } = renderHook(() => useStreamedText("m1", GREETING));
    expect(result.current.shown).toBe("");
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.shown.length).toBeGreaterThan(0);
    expect(result.current.shown.length).toBeLessThan(GREETING.length);
    expect(GREETING.startsWith(result.current.shown)).toBe(true);
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toEqual({ shown: GREETING, done: true });
  });

  it("a greeting already shown in this tab is shown whole, not revealed again", () => {
    const first = renderHook(() => useStreamedText("m2", GREETING));
    act(() => vi.advanceTimersByTime(3000));
    first.unmount();
    const again = renderHook(() => useStreamedText("m2", GREETING));
    expect(again.result.current).toEqual({ shown: GREETING, done: true });
  });

  it("reduced motion shows it whole straight away", () => {
    reduced(true);
    const { result } = renderHook(() => useStreamedText("m3", GREETING));
    act(() => vi.advanceTimersByTime(16));
    expect(result.current.done).toBe(true);
  });
});

describe("useSmoothText — a reply arriving in bursts", () => {
  it("follows the text as it grows and catches up with a big burst quickly", () => {
    const { result, rerender } = renderHook(({ t }) => useSmoothText(t), { initialProps: { t: "Hello" } });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(5);
    const burst = "Hello" + " and a much longer piece of text that arrived all at once from the model".repeat(3);
    rerender({ t: burst });
    act(() => vi.advanceTimersByTime(900));
    expect(result.current).toBe(burst.length);
  });

  it("starts again for a new text rather than continuing the old one", () => {
    const { result, rerender } = renderHook(({ t }) => useSmoothText(t), { initialProps: { t: "First reply." } });
    act(() => vi.advanceTimersByTime(1000));
    rerender({ t: "Next" });
    expect(result.current).toBeLessThanOrEqual(4);
  });
});

describe("FadingText", () => {
  it("fades the newest characters in, and leaves nothing faint once it is all there", () => {
    const { container, rerender } = render(<FadingText shown={GREETING.slice(0, 30)} full={GREETING} />);
    expect(container.querySelectorAll("span[style]").length).toBeGreaterThan(0);
    rerender(<FadingText shown={GREETING} full={GREETING} />);
    expect(container.querySelectorAll("span[style]").length).toBe(0);
    // A screen reader is given the whole text once.
    expect(container.querySelector(".sr-only")?.textContent).toBe(GREETING);
  });
});
