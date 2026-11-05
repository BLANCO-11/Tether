// src/components/flow/builder/palette.ts — the "From scratch" palette entries.
// T7 · "Extract, never copy." (builder programme, closed; record removed 2026-09-11)
//
// ⚠ THIS WAS TWO LISTS, AND THE COPY HAD DROPPED THE SAFETY HALF OF EVERY ENTRY.
//
// `FlowBuilder.tsx` (the canvas door on `/flows/new`) and
// `builder/BuilderShell.tsx` (the manual door on `/flows/[id]/builder`) each
// carried their own `FROM_SCRATCH`, and the second said so in a comment:
// *"Palette (mirrors FlowBuilder's paletteGroups)"*. A mirror is a copy that has
// been given permission.
//
// Measured 2026-09-02 — **five of five entries had lost their second sentence**,
// and the second sentence is the one that carries the warning:
//
// | kind | what the copy dropped |
// | :--- | :--- |
// | `code` | "No network, no credentials." — R9, the containment property |
// | `transform` | "The place to flatten a date." — I-42's mitigation |
// | `agent` | **"Sends this workspace's rows outside."** — the model seam |
// | `approval` | "Rejecting kills it." — gate 3 does not resume with a "no" |
// | `branch` | "There is no otherwise branch." — the 3.3a claim itself |
//
// ⚠ The `agent` one is the sharpest: the palette on the page most people build
// on offered a step that sends the tenant's rows to an external model, and said
// only "Asks a model about the data." Nothing was broken, no test failed, and
// the honest sentence had simply not been copied across.
//
// So: one list. `palette.test.ts` pins that no other file declares one, and that
// each entry still carries the clause it is here to carry.

import { NODE_TYPES, scratchKinds } from "@foundry/flow-edit";
import { kindIcon } from "@/lib/kind-meta";
import type { StepKind } from "@/lib/flow-authoring";

/** A palette entry — a blank kind, as opposed to a catalogue-backed row. */
export type PaletteEntry = {
  kind: StepKind;
  label: string;
  body: string;
  Icon: (p: { s?: number }) => JSX.Element;
  colour: string;
};

/**
 * The mock's "From scratch" group — the kinds with no catalogue backing.
 * Everything callable (`tool`/`datasource`/`query`) is offered from the
 * workspace catalogue instead, because those rows name a real thing.
 *
 * ⚠ **Every `body` is two sentences, and the second is load-bearing.** The first
 * says what the step is; the second says what it costs, sends, or forecloses.
 * A palette is where somebody decides to add an `agent` step, so it is the last
 * place that sentence can still change the decision.
 *
 * ⚠ Read from the registry (`scratchKinds()`), not written here: the label, the
 * body and the colour are `spec.label`, `spec.summary` and `spec.colour`, so a
 * rename lands on the palette, the canvas and the panel together. `palette.test.ts`
 * pins that no other file declares one, and that each entry still carries the
 * clause it is here to carry.
 */
export const FROM_SCRATCH: PaletteEntry[] = scratchKinds().map((kind) => {
  const spec = NODE_TYPES[kind];
  return { kind, label: spec.label, body: spec.summary, Icon: kindIcon(kind), colour: spec.colour };
});

/**
 * The one substring rule for every component search box.
 *
 * ⚠ **EXTRACT, NEVER COPY, again.** `StepPalette` and the canvas's insert menu
 * each filtered rows with their own inline `includes` — two spellings of "match"
 * that agree today and drift the day one of them learns trimming, casing, or an
 * empty query. Both call this: the caller builds the haystack (label plus
 * whatever sub-text its rows carry), this owns the query half.
 *
 * An empty query matches everything: clearing the box is how a filtered list is
 * un-filtered, and a search that hides everything on clear reads as broken.
 */
export function paletteMatches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return haystack.toLowerCase().includes(q);
}
