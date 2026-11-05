// src/lib/palette-drag.test.ts — T7.
//
// ⚠ THE POINT OF THIS FILE IS THE LAST DESCRIBE: that the string is spelled in
// exactly ONE place. The behavioural tests above it would all have passed while
// the drag was broken, because they exercise the module rather than the four
// files that used to carry their own copy of its type.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PALETTE_MIME, setPaletteDrag, isPaletteDrag, readPaletteDrag } from "@/lib/palette-drag";

/** A DataTransfer good enough for the three functions under test. */
function dt() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    get types() { return [...store.keys()]; },
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? "",
  };
}

describe("a palette row survives the round trip", () => {
  it("carries the kind and the ref", () => {
    const d = dt();
    setPaletteDrag(d as unknown as DataTransfer, "tool", "mail_send");
    expect(readPaletteDrag(d)).toEqual({ kind: "tool", ref: "mail_send" });
  });

  it("carries a null ref for a kind with no subject yet", () => {
    const d = dt();
    setPaletteDrag(d as unknown as DataTransfer, "transform");
    expect(readPaletteDrag(d)).toEqual({ kind: "transform", ref: null });
  });

  /** The browser draws a copy cursor — a palette row stays where it is. */
  it("marks the drag as a copy", () => {
    const d = dt();
    setPaletteDrag(d as unknown as DataTransfer, "tool");
    expect(d.effectAllowed).toBe("copy");
  });

  it("recognises its own drag and no other", () => {
    const d = dt();
    expect(isPaletteDrag(d as unknown as DataTransfer)).toBe(false);
    setPaletteDrag(d as unknown as DataTransfer, "tool");
    expect(isPaletteDrag(d as unknown as DataTransfer)).toBe(true);
  });
});

describe("what it refuses, and refuses quietly", () => {
  /**
   * ⚠ Null, never a throw. An exception inside `onDrop` breaks the browser's
   * default handling for every other drag on the page.
   */
  it("returns null for a drag that is not ours", () => {
    expect(readPaletteDrag({ getData: () => "" })).toBeNull();
  });

  it("returns null for our type carrying junk", () => {
    expect(readPaletteDrag({ getData: () => "not json" })).toBeNull();
    expect(readPaletteDrag({ getData: () => "{}" })).toBeNull();
    expect(readPaletteDrag({ getData: () => JSON.stringify({ kind: "" }) })).toBeNull();
  });

  it("does not accept a non-string ref as a ref", () => {
    expect(readPaletteDrag({ getData: () => JSON.stringify({ kind: "tool", ref: 7 }) })).toEqual({
      kind: "tool",
      ref: null,
    });
  });
});

/**
 * ⚠ THE CONTROL. `PALETTE_MIME` was spelled in FOUR places — a named constant in
 * `FlowBuilder.tsx`, another in `builder/BuilderShell.tsx`, and twice as a bare
 * literal in the receiver, `FlowCanvas.tsx` (`onDragOver` and `onDrop`).
 *
 * Its only failure mode is SILENCE: change one and the browser hands the canvas
 * a payload under a type it does not listen for, so `onDragOver` never calls
 * `preventDefault`, the drop is never delivered, and nothing raises an error.
 * No exception, no console line, no type error, no failing test. The node simply
 * does not appear.
 *
 * So: the literal may appear in this module and nowhere else. ⚠ Comments are
 * stripped first — `FlowCanvas.tsx` legitimately names the type in prose while
 * explaining the drop zone, and a scan that matched prose would be the house
 * rule this repo has now earned six times.
 */
describe("the drag type is spelled in exactly one place", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const OWNER = "lib/palette-drag.ts";

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
    return out;
  }

  it("no other file carries the literal", () => {
    const files = walk(SRC);
    // Control: the scan really walked the tree and can find the string at all.
    expect(files.length).toBeGreaterThan(100);
    const owner = files.filter((f) => f.endsWith(OWNER));
    expect(owner).toHaveLength(1);

    const offenders = files
      .filter((f) => !f.endsWith(OWNER))
      .filter((f) => {
        const code = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        return code.includes(PALETTE_MIME);
      })
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it("and the senders and the receiver all read it from here", () => {
    // ⚠ `BuilderShell` was a sender until CD-5 deleted its inline picker; the
    // drag now starts in `StepPalette`, which is the ONE renderer of palette
    // rows. Following the move keeps the "exactly one spelling" property
    // meaningful — leaving the old path here would assert a file that no longer
    // drags anything.
    const needs = [
      // 2026-10-11: `FlowBuilder` and `StepPalette` are deleted with the compiled builder; the canvas is the one
      // reader left.
      "components/flow/FlowCanvas.tsx",
    ];
    for (const rel of needs) {
      const src = readFileSync(join(SRC, rel), "utf8");
      expect(src).toContain("@/lib/palette-drag");
    }
  });
});
