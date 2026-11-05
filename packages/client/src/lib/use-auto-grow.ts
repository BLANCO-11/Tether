// A textarea that grows with what is typed, smoothly, up to a cap — then scrolls.
//
// The height is measured on an off-screen MIRROR, never on the textarea itself: the usual trick (set height to
// `auto`, read scrollHeight, set it back) makes the browser compute `auto` as the transition's starting value, so the
// box jumps instead of easing. Measuring a copy leaves the real box's height untouched until the new value is set, and
// the CSS transition animates from the old height to the new one.
"use client";

import { useLayoutEffect, type RefObject } from "react";

const COPIED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderTopWidth",
  "borderBottomWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
] as const;

let mirror: HTMLTextAreaElement | null = null;

function mirrorFor(el: HTMLTextAreaElement): HTMLTextAreaElement {
  if (!mirror) {
    mirror = document.createElement("textarea");
    mirror.setAttribute("aria-hidden", "true");
    mirror.tabIndex = -1;
    Object.assign(mirror.style, { position: "absolute", top: "-9999px", left: "-9999px", height: "0", overflow: "hidden", visibility: "hidden" });
    document.body.appendChild(mirror);
  }
  const cs = getComputedStyle(el);
  for (const k of COPIED) mirror.style[k] = cs[k];
  // The width is the textarea's own, so a line wraps in the mirror exactly where it wraps on screen.
  mirror.style.width = `${el.clientWidth}px`;
  return mirror;
}

/** The pixel height `value` needs in `el`, between `min` and `max`. */
export function grownHeight(el: HTMLTextAreaElement, value: string, min: number, max: number): number {
  const m = mirrorFor(el);
  m.value = value || " ";
  const needed = m.scrollHeight;
  return Math.max(min, Math.min(max, Math.ceil(needed)));
}

/** `mountKey`: anything that changes when the textarea appears (it may mount after the hook first runs). */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  opts: { min: number; max: number; mountKey?: unknown },
) {
  const { min, max, mountKey } = opts;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = grownHeight(el, value, min, max);
    el.style.height = `${h}px`;
    // Scroll only once the cap is reached; below it the box shows everything.
    el.style.overflowY = h >= max ? "auto" : "hidden";
  }, [ref, value, min, max, mountKey]);

  // A narrower box wraps sooner: measure again when the chat pane changes width.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.height = `${grownHeight(el, el.value, min, max)}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min, max, mountKey]);
}
