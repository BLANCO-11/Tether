// @vitest-environment jsdom
//
// ⚠ **jsdom performs no layout**, so nothing here can assert that the panel is on the
// right or that the backdrop covers the page. What it CAN assert is the behaviour that
// makes the drawer usable without a mouse and recoverable without one either — and that
// is the half that breaks silently.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Drawer } from "./Drawer";

afterEach(cleanup);

describe("Drawer", () => {
  it("renders NOTHING when closed", () => {
    const { container } = render(
      <Drawer open={false} onClose={() => {}} title="Ada Lovelace">
        <p>body</p>
      </Drawer>,
    );
    // ⚠ Not "is hidden". A drawer rendered with `display:none` still puts its contents
    // in the accessibility tree for some assistive technology, and still runs every
    // effect its children declare.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("body")).toBeNull();
  });

  it("renders the title, the subtitle and the body when open", () => {
    render(
      <Drawer open onClose={() => {}} title="Ada Lovelace" subtitle="admin" footer={<button>Save</button>}>
        <p>body</p>
      </Drawer>,
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T">
        <p>body</p>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click on the backdrop closes it, and a click INSIDE does not", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T">
        <p>body</p>
      </Drawer>,
    );
    // CONTROL first: without this, an `onClick` that fires on everything passes the
    // backdrop assertion and closes the drawer every time somebody edits a field in it.
    fireEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the X button closes it", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T">
        <p>body</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focus moves INTO the drawer on open and back to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <Drawer open onClose={() => {}} title="T">
        <p>body</p>
      </Drawer>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    rerender(
      <Drawer open={false} onClose={() => {}} title="T">
        <p>body</p>
      </Drawer>,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("page scroll is locked while open and RESTORED to what it was, not to ''", () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <Drawer open onClose={() => {}} title="T">
        <p>body</p>
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <Drawer open={false} onClose={() => {}} title="T">
        <p>body</p>
      </Drawer>,
    );
    // ⚠ The previous value, not a blank. Blanking it is the version that works on every
    // page whose body has no overflow set and breaks the one page that does.
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });

  it("labels itself by ITS OWN title id — two drawers do not share one", () => {
    // ⚠ This is `Modal`'s bug, and it is the reason this component exists as a copy
    // rather than a prop. With a constant id, two open dialogs both carried
    // `aria-labelledby="modal-title"`, that id existed twice in the document, every
    // resolver takes the first, and a screen reader announced one dialog under the
    // other's title.
    render(
      <>
        <Drawer open onClose={() => {}} title="First">
          <p>a</p>
        </Drawer>
        <Drawer open onClose={() => {}} title="Second">
          <p>b</p>
        </Drawer>
      </>,
    );
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(2);
    const a = dialogs[0]!.getAttribute("aria-labelledby");
    const b = dialogs[1]!.getAttribute("aria-labelledby");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // …and each one resolves to its OWN title, which is the property that actually
    // matters. An id that is merely unique but points at the wrong node is no better.
    expect(document.getElementById(a!)?.textContent).toBe("First");
    expect(document.getElementById(b!)?.textContent).toBe("Second");
  });

  it("Tab wraps from the last focusable element back to the first", () => {
    render(
      <Drawer open onClose={() => {}} title="T" footer={<button>Last</button>}>
        <button>Middle</button>
      </Drawer>,
    );
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // The first focusable in the panel is the Close button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });
});

/**
 * ⚠ **NO SINGLE EDGE OF THE PANEL IS TREATED DIFFERENTLY FROM THE OTHER THREE.**
 *
 * It carried `border-l border-line/60`. `--line` is lighter than `--surface` and the
 * scrim darkens everything to the panel's left, so that one rule read as a highlighted
 * seam down the full height of the viewport — reported on `/admin/members` as one side
 * of the drawer being highlighted.
 *
 * jsdom performs no layout, so this asserts CLASS INTENT, which is the same bound every
 * other styling test in this repo states. The CONTROL matters more than usual here: the
 * assertion is an ABSENCE, and an absence passes just as happily against a panel that
 * could not be found at all.
 */
describe("the panel has no one-sided border, and floats from sm up", () => {
  const panelOf = () =>
    render(
      <Drawer open onClose={() => {}} title="Ada Lovelace">
        <p>body</p>
      </Drawer>,
    ).container.querySelector('[role="dialog"]') as HTMLElement;

  it("CONTROL: the panel is found, and it does carry its other layout classes", () => {
    const panel = panelOf();
    expect(panel).toBeTruthy();
    // Without this, every assertion below passes over `null.className ?? ""`.
    expect(panel.className).toContain("depth-3");
    expect(panel.className).toContain("flex-col");
  });

  it("carries no directional border class of any kind", () => {
    const panel = panelOf();
    for (const side of ["border-l", "border-r", "border-t", "border-b"]) {
      expect(panel.className.split(/\s+/)).not.toContain(side);
    }
  });

  it("is flush with no border at phone width, and a FLOATING closed shape from sm up", () => {
    // 2026-10-11: from `sm` the drawer floats 12px from every edge with a radius, so the
    // all-round hairline that `Modal` uses is right for it too — a closed shape, no edge
    // treated differently. At phone width it is a flush sheet, so no border at all.
    const cls = panelOf().className.split(/\s+/);
    expect(cls).not.toContain("border");
    for (const c of ["sm:border", "sm:m-3", "sm:rounded-[14px]"]) expect(cls).toContain(c);
  });
});
