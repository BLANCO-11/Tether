// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  activePromptId,
  PromptJumpRail,
  PROMPT_MARK_BASE_W,
  PROMPT_MARK_GAP,
  visualizerWidth,
} from "./PromptJumpRail";

function stubScroller(opts: {
  prompts: { id: string; label: string; top: number }[];
  scrollTop?: number;
  clientHeight?: number;
  clientWidth?: number;
  scrollHeight?: number;
}) {
  const scroller = document.createElement("div");
  const clientHeight = opts.clientHeight ?? 400;
  const scrollTop = opts.scrollTop ?? 0;
  const scrollHeight = opts.scrollHeight ?? 2000;
  for (const p of opts.prompts) {
    const el = document.createElement("div");
    el.dataset.promptId = p.id;
    el.dataset.promptLabel = p.label;
    el.getBoundingClientRect = () => ({
      top: p.top - scrollTop,
      bottom: p.top - scrollTop + 30,
      left: 0,
      right: 0,
      width: 0,
      height: 30,
      x: 0,
      y: p.top - scrollTop,
      toJSON: () => ({}),
    });
    scroller.appendChild(el);
  }
  Object.defineProperty(scroller, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: scrollTop, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(scroller, "clientWidth", { value: opts.clientWidth ?? 480, configurable: true });
  scroller.getBoundingClientRect = () => ({
    top: 0,
    bottom: clientHeight,
    left: 0,
    right: opts.clientWidth ?? 480,
    width: opts.clientWidth ?? 480,
    height: clientHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return scroller;
}

const three = [
  { id: "p1", label: "first ask here", top: 20 },
  { id: "p2", label: "second", top: 800 },
  { id: "p3", label: "third and final prompt text", top: 1200 },
];

describe("PromptJumpRail", () => {
  it("renders nothing with fewer than two prompts", () => {
    const scroller = stubScroller({ prompts: [{ id: "p1", label: "hello", top: 10 }] });
    const { container } = render(<PromptJumpRail scroller={scroller} />);
    expect(container.querySelector(".pi-prompt-rail")).toBeNull();
  });

  it("renders exactly one tick per prompt, uniform at rest", () => {
    const scroller = stubScroller({ prompts: three, scrollTop: 0 });
    render(<PromptJumpRail scroller={scroller} />);
    const rail = screen.getByLabelText("Jump to prompts");
    const buttons = [...rail.querySelectorAll("button")] as HTMLElement[];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.style.width === `${PROMPT_MARK_BASE_W}px`)).toBe(true);
    expect(screen.getByLabelText("Jump to: first ask here").getAttribute("aria-current")).toBe("true");
  });

  it("sticks the active mark to the latest prompt at the bottom of the chat", () => {
    const marks = three.map((p) => ({ id: p.id, y: p.top }));
    const scroller = stubScroller({
      prompts: three,
      scrollTop: 1600,
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(activePromptId(scroller, marks)).toBe("p3");
  });

  it("flares like a visualizer and shows a Prompt N peek card", () => {
    const scroller = stubScroller({ prompts: three });
    const { container } = render(<PromptJumpRail scroller={scroller} />);
    const rail = container.querySelector(".pi-prompt-rail") as HTMLElement;
    rail.getBoundingClientRect = () => ({
      top: 0,
      bottom: 40,
      left: 0,
      right: 14,
      width: 14,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.mouseMove(rail, { clientY: PROMPT_MARK_GAP + 2, clientX: 4 });
    const widths = [...rail.querySelectorAll("button")].map((b) => parseInt((b as HTMLElement).style.width, 10));
    expect(widths[1]!).toBeGreaterThan(widths[0]!);
    expect(widths[1]!).toBeGreaterThan(widths[2]!);
    expect(container.querySelector(".pi-prompt-peek-title")?.textContent).toBe("Prompt 2");
    expect(container.querySelector(".pi-prompt-peek-body")?.textContent).toContain("second");
  });

  it("hides when the chat column is narrower than the threshold", () => {
    const scroller = stubScroller({ prompts: three, clientWidth: 300 });
    const { container } = render(<PromptJumpRail scroller={scroller} />);
    expect(container.querySelector(".pi-prompt-rail")).toBeNull();
  });

  it("keeps resting visualizer widths identical", () => {
    expect(visualizerWidth(0, null)).toBe(PROMPT_MARK_BASE_W);
    expect(visualizerWidth(1, 1)).toBeGreaterThan(visualizerWidth(0, 1));
  });
});
