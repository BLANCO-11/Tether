/**
 * A ref written as a CALL is normalised; a ref carrying an ARGUMENT is not.
 *
 * ⚠ MEASURED, which is the reason this exists. Rebuilding the UAT flows through
 * the real chat builder on `gpt-5.6-luna`, **2 of 12 turns failed outright** on
 * `support_demo.support_tickets()` — and the finding printed the correct name
 * one line below the rejected one, differing by two characters:
 *
 *   step "open_tickets" references "support_demo.support_tickets()" —
 *   "support_demo" IS a datasource in this workspace, but it has no readable
 *   component named "support_tickets()". Its readable components are:
 *   support_demo.support_tickets
 *
 * D-55's bound is what makes this safe: it maps a NAME to a name and never
 * guesses at structure. A trailing `()` has exactly one reading.
 */
import { describe, expect, it } from "vitest";
import { draftedStepSchema } from "./flow-drafted-shape.js";

/** The parsed step's ref, or null when the shape was refused. */
function parsedRef(ref: string): string | null {
  const r = draftedStepSchema.safeParse({
    id: "read",
    kind: "query",
    ref,
    paramsExpr: '[{"as_of":"{{ inputs.as_of }}"}]',
  });
  if (!r.success) return null;
  return (r.data as { ref?: string }).ref ?? null;
}

describe("a call-form ref is normalised to the component it names", () => {
  it("drops empty parentheses", () => {
    expect(parsedRef("support_demo.support_tickets()")).toBe("support_demo.support_tickets");
  });

  it("drops them with whitespace inside, which is the same mistake", () => {
    expect(parsedRef("support_demo.support_tickets( )")).toBe("support_demo.support_tickets");
  });

  /** The control: an ordinary ref is untouched, byte for byte. */
  it("leaves a plain ref exactly as written", () => {
    expect(parsedRef("support_demo.support_tickets")).toBe("support_demo.support_tickets");
    expect(parsedRef("llm_complete")).toBe("llm_complete");
  });

  /**
   * ⚠ **THE BOUND, and it is the half that matters.** `foo(bar)` is a model
   * trying to pass a parameter through the ref instead of through `paramsExpr`
   * — a STRUCTURAL mistake, which D-55 says must be refused with the finding
   * that names it rather than guessed at. Dropping the argument would silently
   * discard what the model was trying to say and produce a step that compiles
   * and does the wrong thing.
   */
  it("does NOT normalise a ref carrying an argument", () => {
    expect(parsedRef("support_demo.support_tickets(as_of)")).toBe(
      "support_demo.support_tickets(as_of)",
    );
  });

  /** Parentheses anywhere but the very end are not a call form. */
  it("only strips a trailing pair", () => {
    expect(parsedRef("support_demo.tickets()_old")).toBe("support_demo.tickets()_old");
  });

  /** A ref that is only parentheses must still be refused, not normalised to "". */
  it("refuses a ref that would normalise to nothing", () => {
    expect(parsedRef("()")).toBeNull();
  });
});

/**
 * An explicitly unbound binding (`source: null`) must survive the authored
 * shape (2026-09-14). The skipped-`@json` body convention stores exactly
 * this, and the non-nullable union refused it with `inputs.1.source —
 * Invalid input` — failing EVERY turn on the flow no matter the op, even a
 * retype that touched no step.
 */
describe("an unbound binding source parses", () => {
  it("accepts a null source alongside bound ones", () => {
    const r = draftedStepSchema.safeParse({
      id: "email_report",
      kind: "tool",
      ref: "tether_email_send",
      paramsExpr: '[{"subject": "x", "body": ""}]',
      inputs: [
        { name: "subject", source: { from: "literal", value: "x" } },
        { name: "body", source: null },
      ],
    });
    expect(r.success).toBe(true);
  });
});
