/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TURNING A FLOW'S DECLARED INPUTS INTO A FORM A PERSON CAN FILL IN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **Reported from use, and the words are worth keeping**: *"it is asking for
 * an as_of value but user has no idea what value to enter apart from it being
 * iso timestamp — a normal user will absolutely have no idea of what iso
 * timestamp is."*
 *
 * What that person was shown was a text box labelled `as_of`, hinted *"Defaults
 * to 2026-09-04T11:21:39.237Z"*. Both are accurate and neither is usable: `id`
 * is slug-shaped because expressions interpolate it (`{{ inputs.as_of }}`), and
 * the default is a machine timestamp because the drafter wrote one.
 *
 * ⚠ **This module is presentation, and the line it must not cross is guessing
 * SEMANTICS.** `humanLabel` reshapes an identifier — a transform on the string
 * itself, which cannot be wrong about what the flow means. The control comes
 * from `formatFor`: the SERVER's derived format wins, otherwise the DECLARED
 * type — never an inference from an id or from the shape of a default. That
 * inference is available and is refused, because `period` on the HR flows is
 * `"2026-06"` — a month, which looks like a date to a regex and is not one,
 * and a date picker there would write `2026-06-01` into a query expecting
 * `YYYY-MM`.
 *
 * So a STRING stays a text box unless the server derived `month` for it. The
 * fix for an existing flow declaring a date as STRING is to re-draft it now
 * the prompt teaches `DATE`/`DATETIME` — not to have this file second-guess it.
 */
import type { FlowInputDecl } from "@/lib/types";
// ⚠ lib → components reads oddly; the direction is acyclic (`TypedInput`
// imports only `ui/Field` plus type-only `lib/types`) and it keeps the
// type→format fallback in the one module that owns the typed control.
import { formatFor } from "@/components/automation/TypedInput";

/**
 * The words shown above the box.
 *
 * `label` when the flow declares one. Otherwise the id, humanised: separators
 * become spaces and the first letter is capitalised — `as_of` → "As of",
 * `period` → "Period". Nothing is expanded or renamed; a reader who knows the
 * id still recognises it, which matters because the id is what appears in
 * expressions and in the engine's error messages.
 */
export function humanLabel(d: Pick<FlowInputDecl, "id" | "label">): string {
  if (d.label?.trim()) return d.label.trim();
  const words = d.id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : d.id;
}


/**
 * The sentence under the box.
 *
 * ⚠ **Order matters and the fallback is NOT a written sentence.** The flow's own
 * `description` wins. Failing that, a person is told whether the field is needed
 * and — only for a text box — what the default looks like, because a text box is
 * the one control that gives no format cue of its own. A date picker showing a
 * calendar needs no sentence explaining what a date is.
 *
 * ⚠ There is deliberately no invented per-field prose ("Enter the reporting
 * period"). Guessing what an input means and printing it as guidance is the
 * failure this whole module exists to fix, restated more confidently.
 */
export function hintFor(d: FlowInputDecl): string | undefined {
  if (d.description?.trim()) return d.description.trim();
  const optional = d.required === false;
  const format = formatFor(d);
  if (d.defaults !== undefined && d.defaults !== "" && format === "text") {
    return optional
      ? `Optional. Leave as it is to use ${d.defaults}.`
      : `Leave as it is to use ${d.defaults}.`;
  }
  if (d.defaults !== undefined && d.defaults !== "") {
    return optional ? "Optional — a value is already filled in." : "A value is already filled in.";
  }
  return optional ? "Optional" : "Required";
}
