// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MultiSelect } from "./MultiSelect";

afterEach(cleanup);

const OPTIONS = [
  { id: "a", label: "HR" },
  { id: "b", label: "Finance" },
  { id: "c", label: "Legal" },
];

/** A caller that owns the state, which is the only way this component is meant to be used. */
function Harness({ initial = [] as string[] }) {
  const [sel, setSel] = useState<string[]>(initial);
  return (
    <>
      <MultiSelect options={OPTIONS} selected={sel} onChange={setSel} label="Workspaces" />
      <p data-testid="echo">{sel.join(",")}</p>
    </>
  );
}

describe("MultiSelect", () => {
  it("the button counts the selection, not the names", () => {
    render(<Harness initial={["a", "b"]} />);
    expect(screen.getByRole("button", { name: "Workspaces" }).textContent).toContain("2 of 3 selected");
  });

  it("zero selected is REPRESENTABLE and reads as zero, not as all", () => {
    // ⚠ The component does not decide what zero means. It must not silently promote an
    // empty selection to "everything" — the caller disables submit on it, and a control
    // that quietly submitted to all three would be the opposite of what was asked.
    render(<Harness initial={[]} />);
    expect(screen.getByRole("button", { name: "Workspaces" }).textContent).toContain("0 of 3 selected");
  });

  it("opens on click, reports aria-expanded, and the list is multi-selectable", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Workspaces" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("ticking one option reports it to the caller and leaves the rest alone", () => {
    render(<Harness initial={["a"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    fireEvent.click(screen.getByLabelText("Legal"));
    expect(screen.getByTestId("echo").textContent).toBe("a,c");
  });

  it("Select all ticks everything, and pressing it again clears everything", () => {
    render(<Harness initial={["a"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByTestId("echo").textContent).toBe("a,b,c");
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByTestId("echo").textContent).toBe("");
  });

  it("the INDETERMINATE state appears at a partial selection — and only there", () => {
    // ⚠ `indeterminate` is a DOM PROPERTY. `indeterminate={true}` in JSX compiles,
    // renders and does nothing, so a partial selection would draw an EMPTY box — which
    // says "none of these" over a list where some are picked. This is the assertion that
    // catches that, and it needs both controls to mean anything.
    const { rerender } = render(<Harness initial={["a"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    const all = screen.getByLabelText("Select all") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    // CONTROL 1 — everything selected is CHECKED, not indeterminate.
    fireEvent.click(all);
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);

    // CONTROL 2 — nothing selected is neither.
    fireEvent.click(all);
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(false);
    rerender(<Harness initial={[]} />);
  });

  it("a click outside closes it, and a click INSIDE does not", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    // CONTROL: an outside-click handler that fires on everything would close the popover
    // the instant somebody ticked a box, which makes multi-select single-select.
    fireEvent.mouseDown(screen.getByLabelText("Finance"));
    expect(screen.queryByRole("listbox")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("an empty list says so rather than rendering an empty box with Select all", () => {
    render(<MultiSelect options={[]} selected={[]} onChange={() => {}} label="Workspaces" emptyLabel="No workspaces exist yet." />);
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    expect(screen.getByText("No workspaces exist yet.")).toBeTruthy();
    // ⚠ A "Select all" over nothing is a control that cannot do anything, which reads as
    // a broken page rather than an empty list.
    expect(screen.queryByLabelText("Select all")).toBeNull();
  });

  it("disabled cannot be opened", () => {
    render(<MultiSelect options={OPTIONS} selected={[]} onChange={vi.fn()} label="Workspaces" disabled />);
    const button = screen.getByRole("button", { name: "Workspaces" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
