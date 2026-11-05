// The prompt-boundary warning copy, and the one rule it must not break.
import { describe, expect, it } from "vitest";
import {
  PROMPT_BOUNDARY_EXPLAINER,
  PROMPT_BOUNDARY_TITLE,
  PROMPT_BOUNDARY_UNREADABLE,
  truncationNotice,
  warningLocation,
  type PromptBoundaryWarning,
  type PromptBoundaryWarnings,
} from "@/lib/prompt-boundary-copy";

const w = (over: Partial<PromptBoundaryWarning> = {}): PromptBoundaryWarning => ({
  source: "tool",
  itemName: "send_email",
  field: "description",
  pattern: "instruction_override",
  describes: "reads as an instruction to the model",
  excerpt: "ignore previous instructions and…",
  ...over,
});

const wrap = (over: Partial<PromptBoundaryWarnings> = {}): PromptBoundaryWarnings => ({
  items: [w()],
  truncated: false,
  total: 1,
  cap: 50,
  ...over,
});

describe("warningLocation — where to go and look", () => {
  it("names the kind of thing and the field", () => {
    expect(warningLocation(w())).toBe("Tool “send_email” · description");
    expect(warningLocation(w({ source: "datasource", itemName: "hr" }))).toContain("Data source");
    expect(warningLocation(w({ source: "schema", itemName: "employees" }))).toContain("Schema of");
  });
});

describe("truncationNotice — a short list must never read as the whole list", () => {
  it("says nothing when nothing was cut", () => {
    expect(truncationNotice(wrap())).toBeNull();
  });

  it("⚠ announces the cut with both numbers", () => {
    const notice = truncationNotice(wrap({ truncated: true, total: 120 }))!;
    expect(notice).toContain("1 of 120");
  });
});

/**
 * ⚠ The rule from the detector's own design: findings can inform, their ABSENCE
 * must never be presented as safety. The patterns are a known-bad list, so
 * matching nothing means exactly that and no more.
 */
describe("the copy never claims safety", () => {
  it("⚠ has no all-clear string anywhere in it", () => {
    for (const s of [PROMPT_BOUNDARY_TITLE, PROMPT_BOUNDARY_EXPLAINER, PROMPT_BOUNDARY_UNREADABLE]) {
      const l = s.toLowerCase();
      expect(l).not.toContain("no issues");
      expect(l).not.toContain("no problems");
      expect(l).not.toContain("is safe");
      expect(l).not.toContain("secure");
    }
  });

  it("⚠ states that the flagged content is still sent UNALTERED", () => {
    // The detector alters nothing and pins the manifest's byte-identity. A panel
    // implying the text had been cleaned would hide that and become false
    // reassurance.
    const l = PROMPT_BOUNDARY_EXPLAINER.toLowerCase();
    expect(l).toContain("still sent");
    expect(l).toContain("nothing has been removed or rewritten");
  });

  it("⚠ the unreadable state says the check DID NOT RUN, not that nothing matched", () => {
    // The third state exists because the other two are not enough: an empty list
    // means "matched nothing" and a failed read means "nobody knows". Rendering
    // the second as the first is the deleted `faFallback` shape.
    expect(PROMPT_BOUNDARY_UNREADABLE.toLowerCase()).toContain("did not run");
    expect(PROMPT_BOUNDARY_UNREADABLE.toLowerCase()).toContain("not a statement");
  });
});
