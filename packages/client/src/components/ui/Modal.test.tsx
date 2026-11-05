// @vitest-environment jsdom
//
// A dialog keeps the focus where the person put it while they type, even when the page passes a new onClose on every
// render (an inline arrow — the usual way). It used to re-run its open-time focus on each keystroke (2026-10-12).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Modal } from "./Modal";

function Form() {
  const [text, setText] = useState("");
  return (
    <Modal open onClose={() => setText("")} title="New workspace">
      <textarea aria-label="Purpose" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

afterEach(cleanup);

describe("Modal", () => {
  it("typing in a field keeps the focus in that field", () => {
    render(<Form />);
    const box = screen.getByLabelText("Purpose") as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: "A" } });
    fireEvent.change(box, { target: { value: "AB" } });
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("AB");
  });

  it("Escape still closes with the latest onClose", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<Modal open onClose={first} title="t"><span /></Modal>);
    rerender(<Modal open onClose={latest} title="t"><span /></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
