// @vitest-environment jsdom
//
// Typed-build phase 2: the checker's diagnostics land ON the step they name.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { canvasFromRawModel, withTypeErrors } from "@/lib/canvas-model";
import { heightFor, widthFor } from "@/lib/canvas-layout";
import { diagnosticsByStep } from "@/lib/step-diagnostics";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

afterEach(() => cleanup());

const MODEL = {
  steps: [
    { id: "read", kind: "query", ref: "hr_demo.rows" },
    { id: "send", kind: "tool", ref: "mail_send", dependsOn: ["read"] },
  ],
};
const BY_STEP = diagnosticsByStep({
  diagnostics: [
    { code: "FT0202", severity: "error", span: { stepId: "send", port: "to" }, message: "expected string, got null", help: "bind an email", owner: "wiring" },
    { code: "FT0204", severity: "error", span: { stepId: "send" }, message: "a required input is unbound", owner: "wiring" },
    { code: "FT0101", severity: "error", span: {}, message: "flow-wide", owner: "skeleton" },
  ],
});

describe("withTypeErrors", () => {
  it("paints only the named step, and flow-wide diagnostics onto no card", () => {
    const g = withTypeErrors(canvasFromRawModel(MODEL), BY_STEP);
    expect(g.nodes.find((n) => n.id === "send")?.typeErrors).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === "read")?.typeErrors).toBeUndefined();
  });

  it("CONTROL: keeps the graph's identity when nothing matched (I-66)", () => {
    const base = canvasFromRawModel(MODEL);
    expect(withTypeErrors(base, new Map())).toBe(base);
    expect(withTypeErrors(base, diagnosticsByStep({ findings: ["FT0202 gone: m"] }))).toBe(base);
  });
});

describe("the canvas card", () => {
  it("shows a badge on the step with a diagnostic and none on the step without", () => {
    const graph = withTypeErrors(canvasFromRawModel(MODEL), BY_STEP);
    const { container } = render(<FlowCanvas graph={graph} />);
    const badges = screen.getAllByTestId("type-error-badge");
    expect(badges).toHaveLength(1);
    const badge = badges[0]!;
    // Words, not only colour: the first code and how many more.
    expect(badge.textContent).toBe("FT0202 +1");
    expect(badge.getAttribute("aria-label")).toMatch(/^2 type errors: FT0202 to: expected string, got null/);
    expect(badge.getAttribute("title")).toContain("FT0204: a required input is unbound");
    // It is on the SEND card, not the read card.
    const send = badge.closest(".node-card") as HTMLElement;
    expect(send.textContent).toContain("send");
    expect(send.textContent).not.toContain("hr_demo.rows");
    const cards = [...container.querySelectorAll<HTMLElement>(".node-card")];
    const read = cards.find((c) => c.textContent?.includes("hr_demo.rows"))!;
    expect(read.querySelector('[data-testid="type-error-badge"]')).toBeNull();
  });

  it("does not change the card's declared size", () => {
    const plain = canvasFromRawModel(MODEL);
    const graph = withTypeErrors(plain, BY_STEP);
    const { container } = render(<FlowCanvas graph={graph} />);
    const send = graph.nodes.find((n) => n.id === "send")!;
    const card = screen.getByTestId("type-error-badge").closest(".node-card") as HTMLElement;
    expect(card.style.width).toBe(`${widthFor(send)}px`);
    expect(card.style.height).toBe(`${heightFor(send)}px`);
    // …and the size functions ignore the overlay entirely.
    const bare = plain.nodes.find((n) => n.id === "send")!;
    expect(widthFor(send)).toBe(widthFor(bare));
    expect(heightFor(send)).toBe(heightFor(bare));
    expect(container).toBeTruthy();
  });

  it("CONTROL: no diagnostics, no badge", () => {
    const graph = canvasFromRawModel(MODEL);
    render(<FlowCanvas graph={graph} />);
    expect(screen.queryByTestId("type-error-badge")).toBeNull();
  });
});
