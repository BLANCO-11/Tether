// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";
import { TOAST_MS } from "./toast-timing";

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.success("it worked")}>s</button>
      <button onClick={() => toast.error("it broke")}>e</button>
      <button onClick={() => toast.warn("careful")}>w</button>
      <button onClick={() => toast("fyi")}>i</button>
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const kindOf = (text: string) => screen.getByText(text).closest("[data-kind]")!.getAttribute("data-kind");

describe("toast", () => {
  it("each call shows its own kind; a bare call is neutral", () => {
    render(<ToastProvider><Buttons /></ToastProvider>);
    for (const b of ["s", "e", "w", "i"]) fireEvent.click(screen.getByText(b));
    expect(kindOf("it worked")).toBe("success");
    expect(kindOf("it broke")).toBe("error");
    expect(kindOf("careful")).toBe("warn");
    expect(kindOf("fyi")).toBe("info");
  });

  it("every kind has the same colour tokens as its Notice and a different look from the others", () => {
    render(<ToastProvider><Buttons /></ToastProvider>);
    for (const b of ["s", "e", "w", "i"]) fireEvent.click(screen.getByText(b));
    const cls = (t: string) => screen.getByText(t).closest("[data-kind]")!.className;
    expect(cls("it worked")).toMatch(/bg-ok-bg/);
    expect(cls("it broke")).toMatch(/bg-danger-bg/);
    expect(cls("careful")).toMatch(/bg-warn-bg/);
    expect(new Set(["it worked", "it broke", "careful", "fyi"].map(cls)).size).toBe(4);
  });

  it("all kinds share one width", () => {
    render(<ToastProvider><Buttons /></ToastProvider>);
    for (const b of ["s", "e", "w", "i"]) fireEvent.click(screen.getByText(b));
    for (const t of ["it worked", "it broke", "careful", "fyi"]) {
      expect(screen.getByText(t).closest("[data-kind]")!.className).toMatch(/\bw-80\b/);
    }
  });

  it("goes away after 6 seconds, not before", () => {
    expect(TOAST_MS).toBe(6000);
    render(<ToastProvider><Buttons /></ToastProvider>);
    fireEvent.click(screen.getByText("e"));
    act(() => void vi.advanceTimersByTime(5900));
    expect(screen.queryByText("it broke")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByText("it broke")).toBeNull();
  });

  it("a click dismisses it sooner", () => {
    render(<ToastProvider><Buttons /></ToastProvider>);
    fireEvent.click(screen.getByText("s"));
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("it worked")).toBeNull();
  });

  it("the function keeps one identity across renders (callers list it in effect deps)", () => {
    const seen = new Set<unknown>();
    function Probe() {
      seen.add(useToast());
      const [n, setN] = (require("react") as typeof import("react")).useState(0);
      return <button onClick={() => setN(n + 1)}>rerender {n}</button>;
    }
    render(<ToastProvider><Probe /></ToastProvider>);
    fireEvent.click(screen.getByText(/rerender/));
    fireEvent.click(screen.getByText(/rerender/));
    expect(seen.size).toBe(1);
  });
});
