// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThinkingLevel } from "./ThinkingLevel";

afterEach(() => cleanup());

describe("ThinkingLevel", () => {
  it("shows the level as bars, and the slider is hidden until clicked", () => {
    render(<ThinkingLevel level="balanced" disabled={false} onChange={vi.fn()} />);
    const bars = screen.getByRole("button", { name: "Thinking: Balanced" });
    expect(bars.querySelectorAll('rect[fill="var(--accent)"]')).toHaveLength(2);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("dragging and letting go sets the level and hides the slider", async () => {
    const onChange = vi.fn(async () => undefined);
    render(<ThinkingLevel level="balanced" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking: Balanced" }));
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getByRole("dialog").textContent).toContain("Ultra high");
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("ultra"));
    await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
  });

  it("Escape leaves the level as it was", () => {
    const onChange = vi.fn();
    render(<ThinkingLevel level="low" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking: Low" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the slider open and says why when the change is refused", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("Forge is still working.");
    });
    render(<ThinkingLevel level="balanced" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking: Balanced" }));
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(await screen.findByText("Forge is still working.")).toBeTruthy();
    expect(screen.queryByRole("slider")).not.toBeNull();
  });

  it("cannot be opened while Forge is working", () => {
    render(<ThinkingLevel level="high" disabled onChange={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Thinking: High" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
