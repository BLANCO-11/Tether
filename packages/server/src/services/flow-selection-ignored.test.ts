import { describe, it, expect } from "vitest";
import {
  preferredRefNames,
  refsUsedBy,
  resolveSelection,
  selectionIgnored,
} from "./flow-selection.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * I-180 · A SCOPED DRAFT THAT READ NONE OF WHAT IT WAS POINTED AT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **The silent cases carry the weight here, not the firing one.** The firing
 * case proves the check exists; the four refusals prove it is not I-62, where a
 * guard that cries wolf gets widened until the widening permits the defect.
 * `draft:measure` has scored 4/4 drafted at 1.0 attempts over exactly the state
 * the first test describes, so the defect is real; the risk of the fix is that
 * it starts refusing correct drafts.
 *
 * ⚠ **The call-site half of this file went with `draftFlow` (phase 8, D-333)**, so
 * `selectionIgnored` and `preferredRefNames` are now called by nothing — I-120's
 * shape. They stay until the builder decides whether a selection scopes it;
 * recorded in phase 8's issues rather than left to be rediscovered.
 */
const DS = new Map([["ds1", "hr_demo"], ["ds2", "finance_demo"]]);
const SEL = { datasourceIds: ["ds1"], toolRefs: [] as string[] };
const OFFERED = ["hr_demo.approved_leave", "hr_demo.headcount"];

describe("it fires only where the draft reached past its selection", () => {
  it("⚠ read data, and none of the data it was pointed at", () => {
    const r = selectionIgnored(SEL, DS, ["finance_demo.overdue_invoices"], OFFERED);
    expect(r).not.toBeNull();
    expect(r!.preferred).toEqual(OFFERED);
    expect(r!.used).toEqual(["finance_demo.overdue_invoices"]);
  });

  it("one preferred ref used is ENOUGH — a selection prioritises, it does not narrow (D-114)", () => {
    // A flow legitimately needs things nobody ticked. "Mostly ignored" is not
    // the defect; ignored ENTIRELY is.
    expect(
      selectionIgnored(SEL, DS, ["hr_demo.approved_leave", "finance_demo.overdue_invoices"], OFFERED),
    ).toBeNull();
  });

  it("⚠ nothing picked means no stated intent to drift from", () => {
    expect(selectionIgnored(null, DS, ["finance_demo.x"], OFFERED)).toBeNull();
    expect(selectionIgnored({ datasourceIds: [], toolRefs: [] }, DS, ["finance_demo.x"], OFFERED)).toBeNull();
  });

  it("⚠ a draft that names NO refs has not reached past its selection — it has not reached", () => {
    // All-transform/code flows read nothing and call nothing.
    expect(selectionIgnored(SEL, DS, [], OFFERED)).toBeNull();
  });

  it("⚠ a selection that offered nothing is emptyDatasources' finding, not this one", () => {
    // A datasource picked before anyone wrote it a reader. Reporting it twice,
    // once as the person's fault, is how one finding becomes two.
    expect(selectionIgnored(SEL, DS, ["finance_demo.x"], [])).toBeNull();
  });

  it("a datasource matches by PREFIX and a tool by EQUALITY", () => {
    // The `mail_send` / `mail_send_template` pair `coversRef` exists to separate.
    const sel = { datasourceIds: [], toolRefs: ["mail_send"] };
    expect(selectionIgnored(sel, DS, ["mail_send"], ["mail_send"])).toBeNull();
    expect(selectionIgnored(sel, DS, ["mail_send_template"], ["mail_send"])).not.toBeNull();
  });

  it("an unresolvable datasource id falls back to the id rather than matching everything", () => {
    const r = selectionIgnored({ datasourceIds: ["gone"], toolRefs: [] }, DS, ["hr_demo.x"], OFFERED);
    expect(r).not.toBeNull();
  });
});

describe("the check and the prompt agree about what was offered (D-197)", () => {
  const available = {
    queries: [
      { datasourceId: "ds1", datasourceName: "hr_demo", name: "approved_leave" },
      { datasourceId: "ds2", datasourceName: "finance_demo", name: "overdue" },
    ],
    tools: [{ name: "tether_email_send" }, { name: "llm_complete" }],
    operations: [{ datasourceId: "ds1", datasourceName: "hr_demo", name: "headcount" }],
  };

  it("preferredRefNames is what resolveSelection preferred, in step spelling", () => {
    const resolved = resolveSelection({ datasourceIds: ["ds1"], toolRefs: ["llm_complete"] }, available);
    expect(preferredRefNames(resolved).sort()).toEqual(
      ["hr_demo.approved_leave", "hr_demo.headcount", "llm_complete"].sort(),
    );
  });

  /**
   * ⚠ The end-to-end property: what the prompt PREFERRED is what the check
   * judges against. Two definitions would drift in the direction where the
   * check blames the model for ignoring something never on the page.
   */
  it("a draft using only the unpreferred half is caught, using resolveSelection's own answer", () => {
    const sel = { datasourceIds: ["ds1"], toolRefs: [] };
    const resolved = resolveSelection(sel, available);
    const r = selectionIgnored(sel, DS, ["finance_demo.overdue"], preferredRefNames(resolved));
    expect(r).not.toBeNull();
    expect(r!.preferred).toContain("hr_demo.approved_leave");
  });
});

describe("refsUsedBy is one definition for the screen and the check", () => {
  it("reads every kind's ref and skips steps that have none", () => {
    expect(
      refsUsedBy({
        steps: [
          { id: "a", kind: "datasource", ref: "hr_demo.x" },
          { id: "b", kind: "transform" },
          { id: "c", kind: "tool", ref: "llm_complete" },
          { id: "d", kind: "code" },
        ],
      }),
    ).toEqual(["hr_demo.x", "llm_complete"]);
  });

  it("survives a null model, an absent steps array and a non-string ref", () => {
    expect(refsUsedBy(null)).toEqual([]);
    expect(refsUsedBy(undefined)).toEqual([]);
    expect(refsUsedBy({})).toEqual([]);
    expect(refsUsedBy({ steps: [{ ref: 3 }, { ref: "" }, null, "x"] })).toEqual([]);
  });
});
