// src/lib/prompt-boundary-copy.ts — the words shown for a prompt-boundary
// warning (guardrail port V4).
//
// ⚠ **THE DETECTOR HAS BEEN CORRECT AND UNSEEN.** `prompt-boundary/detect.ts`
// has scanned every manifest build since the V4 port, and CLAUDE.md records the
// consequence in its own words: *"it is **not on a screen** — nothing in
// `packages/client` reads the manifest at all, so surfacing it needs a placement
// decision rather than a line of code."* This module and
// `components/PromptBoundaryWarnings.tsx` are that decision: the tools page,
// because every warning names a tool, a datasource or a schema entity, and that
// page is where the person who can edit one already is.
//
// The rule the copy has to obey, and it is the whole reason the strings live out
// here where a test can read them:
//
//   findings can inform; their ABSENCE must never be presented as safety.
//
// So there is deliberately no "no issues found" string and no green tick for an
// empty list. The patterns are a known-bad list, so matching nothing means
// exactly that and no more. `POLICY_*`'s file states the same rule for the other
// half of the port.

/** One flagged field, as `detect.ts` emits it. */
export type PromptBoundaryWarning = {
  source: "tool" | "datasource" | "schema";
  itemName: string;
  field: string;
  pattern: string;
  describes: string;
  excerpt: string;
};

/** The detector's whole answer for one manifest build. */
export type PromptBoundaryWarnings = {
  items: PromptBoundaryWarning[];
  truncated: boolean;
  total: number;
  cap: number;
};

export const PROMPT_BOUNDARY_TITLE = "Registered content that reads like an instruction";

/**
 * ⚠ Says out loud that nothing was removed or rewritten.
 *
 * The detector deliberately alters nothing — `detect.ts`'s own docblock calls
 * silent stripping the most likely "improvement" a later change makes, and pins
 * the manifest's byte-identity against it. A panel that let a person assume the
 * text had been cleaned would make that guarantee invisible and turn the
 * warning into false reassurance.
 */
export const PROMPT_BOUNDARY_EXPLAINER =
  "These fields are still sent to the model exactly as registered — nothing has been removed or " +
  "rewritten. They are flagged because their text is shaped like an instruction rather than a " +
  "description, and content from tools and databases is never meant to instruct. Review the item " +
  "and edit it if you did not expect this.";

/** Where the person should go and look. */
export function warningLocation(w: PromptBoundaryWarning): string {
  const where =
    w.source === "tool" ? "Tool" : w.source === "datasource" ? "Data source" : "Schema of";
  return `${where} “${w.itemName}” · ${w.field}`;
}

/**
 * The line shown when the list was capped.
 *
 * ⚠ Truncation is always announced. A silently short list reads as "these are
 * all of them", which is worse than no list at all — the same rule
 * `policy-copy.ts` applies to evidence it could not parse.
 */
export function truncationNotice(w: PromptBoundaryWarnings): string | null {
  if (!w.truncated) return null;
  return `Showing ${w.items.length} of ${w.total}. Fix these and reload to see the rest.`;
}

/**
 * What to say when the detector could not be ASKED.
 *
 * ⚠ This is a third state and it exists because the other two are not enough.
 * An empty list means "the patterns matched nothing"; a failed read means
 * "nobody knows", and rendering that as an empty list is the deleted
 * `faFallback` shape — a page reporting an absence of findings it never
 * obtained. krt's own version of this surface swallowed the error and returned
 * `{items: []}`, which is precisely what `ui-honesty-check.sh` exists to stop.
 */
export const PROMPT_BOUNDARY_UNREADABLE =
  "Couldn't check registered content for instruction-shaped text. This is not a statement that " +
  "there is none — the check did not run.";
