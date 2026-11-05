// src/lib/palette-drag.ts — the one definition of the palette → canvas drag.
// T7 (builder programme, closed; record removed 2026-09-11)
//
// ⚠ THIS WAS FOUR COPIES, AND TWO OF THEM WERE BARE STRING LITERALS.
//
// `PALETTE_MIME` was declared as a named constant in `FlowBuilder.tsx` and again
// in `builder/BuilderShell.tsx`, and the RECEIVER — `FlowCanvas.tsx` — matched
// `"application/x-foundry-step"` twice as a literal, once in `onDragOver` and
// once in `onDrop`.
//
// The plan's own words were *"`PALETTE_MIME` keeps exactly one definition; a
// second copy drifts toward the drag silently doing nothing"*. That is the exact
// failure available today: change the constant in one sender and the browser
// hands the canvas a payload under a type it does not listen for, so
// `onDragOver` never calls `preventDefault`, the drop is never delivered, and
// **nothing anywhere reports an error**. No exception, no console line, no
// failing type — the node simply does not appear. It is I-38's shape moved into
// the DOM: a control (the type check) that can silently stop matching.
//
// So the type, the writer and the reader all live here, and
// `palette-drag.test.ts` pins that no other file spells the string.

/**
 * The drag type. ⚠ A custom MIME rather than `text/plain`: the canvas must be
 * able to tell a palette row from a dragged selection or a file, and
 * `types.includes` on a specific type is the only check that can.
 */
export const PALETTE_MIME = "application/x-foundry-step";

/** What travels on the drag. `ref` is null for a step kind with no subject yet. */
export type PaletteDrag = { kind: string; ref: string | null };

/**
 * Put a palette row on the drag.
 *
 * `effectAllowed = "copy"` so the browser draws a copy cursor rather than a move
 * one — a palette row stays where it is.
 */
export function setPaletteDrag(dt: DataTransfer, kind: string, ref?: string | null): void {
  dt.setData(PALETTE_MIME, JSON.stringify({ kind, ref: ref ?? null } satisfies PaletteDrag));
  dt.effectAllowed = "copy";
}

/** Is this drag one of ours? Used by `onDragOver`, which must not swallow others. */
export function isPaletteDrag(dt: Pick<DataTransfer, "types">): boolean {
  return Array.prototype.includes.call(dt.types, PALETTE_MIME);
}

/**
 * Read a palette row off the drop.
 *
 * ⚠ Returns null rather than throwing for anything that is not ours — a page
 * that throws inside `onDrop` breaks the browser's default handling for every
 * other drag on it. A payload with no `kind` is not ours either.
 */
export function readPaletteDrag(dt: Pick<DataTransfer, "getData">): PaletteDrag | null {
  const raw = dt.getData(PALETTE_MIME);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<PaletteDrag>;
    if (typeof data.kind !== "string" || data.kind === "") return null;
    return { kind: data.kind, ref: typeof data.ref === "string" ? data.ref : null };
  } catch {
    return null;
  }
}
