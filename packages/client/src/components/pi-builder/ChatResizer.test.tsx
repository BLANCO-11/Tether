// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CANVAS_MIN_W, CHAT_MAX_W, CHAT_MIN_W, ChatResizer, clampChatWidth } from "./ChatResizer";

describe("the chat's width", () => {
  afterEach(cleanup);
  it("stays between its bounds and never crowds the canvas out", () => {
    expect(clampChatWidth(100, 2000)).toBe(CHAT_MIN_W);
    expect(clampChatWidth(5000, 3000)).toBe(CHAT_MAX_W);
    expect(clampChatWidth(800, 1000)).toBe(1000 - CANVAS_MIN_W);
    expect(clampChatWidth(500.4, 2000)).toBe(500);
    // A workbench too narrow for both: the chat keeps its minimum.
    expect(clampChatWidth(500, 500)).toBe(CHAT_MIN_W);
  });

  it("moves with the arrow keys and resets with Home or a double-click", () => {
    const onChange = vi.fn();
    render(<ChatResizer width={480} onChange={onChange} />);
    const handle = screen.getByRole("separator", { name: "Resize the chat" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(496);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(416);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.doubleClick(handle);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
