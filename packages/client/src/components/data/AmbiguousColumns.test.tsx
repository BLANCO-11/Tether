// @vitest-environment jsdom
/**
 * Which table a bare column name came from — Jev programme phase 4a.3.
 *
 * ── What this surface is for ─────────────────────────────────────────────────
 *
 * `compileOperation` resolves a bare column against the join chain and the
 * FIRST table holding it wins. That has always been deterministic, and it was
 * always **invisible**: join two tables that both have `id` or `status` and the
 * operation read one of them with nothing anywhere saying a choice had been
 * made. CLAUDE.md records it as a real gap in the *visual* builder too.
 *
 * The compiler now reports the choice; this is where a person can disagree with
 * it. A report no screen renders is a value computed and discarded (I-120), the
 * defect this repo has recorded four separate times.
 *
 * ⚠ **Three properties, and two of them are about NOT saying things.**
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AmbiguousColumns, ProposalReview } from "./OperationReview";
import type { FAOperationProposal } from "@/lib/foundry-client";

describe("a column name two joined tables both have", () => {
  it("names the column, the table that won, and the other table", () => {
    render(
      <AmbiguousColumns
        columns={[{ column: "status", resolvedTo: "attendance_monthly", alsoOn: ["employees"] }]}
      />,
    );
    expect(screen.getAllByText("status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("attendance_monthly").length).toBeGreaterThan(0);
    expect(screen.getAllByText("employees").length).toBeGreaterThan(0);
  });

  it("shows the qualified spelling that overrides it", () => {
    // ⚠ The remedy is on screen beside the report, deliberately. A warning
    // whose fix is not visible is one people learn to scroll past — and the
    // qualified spelling is not something anyone would guess.
    render(
      <AmbiguousColumns
        columns={[{ column: "status", resolvedTo: "attendance_monthly", alsoOn: ["employees"] }]}
      />,
    );
    expect(screen.getAllByText("employees.status").length).toBeGreaterThan(0);
  });

  it("renders NOTHING when there is no ambiguity", () => {
    // ⚠ Not an all-clear. This knows only that no two tables share a name, never
    // that the right table was chosen — so a green tick here would be a safety
    // claim it cannot make. Same rule as `PromptBoundaryWarnings`' empty case.
    const { container } = render(<AmbiguousColumns columns={[]} />);
    expect(container.textContent).toBe("");
  });

  it("does not read as an error", () => {
    // The SQL is correct and deterministic; the open question is whether it is
    // the one the author meant. Error words here would make a correct compile
    // look broken — the S1/S2 failure, where the guardrail's most defensible
    // moment presented as the product breaking.
    render(
      <AmbiguousColumns
        columns={[{ column: "id", resolvedTo: "orders", alsoOn: ["customers"] }]}
      />,
    );
    expect(screen.queryByText(/error|failed|invalid|problem/i)).toBeNull();
  });

  it("lists every other owner, not just the first", () => {
    render(
      <AmbiguousColumns
        columns={[{ column: "id", resolvedTo: "orders", alsoOn: ["customers", "shipments"] }]}
      />,
    );
    expect(screen.getAllByText("customers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("shipments").length).toBeGreaterThan(0);
  });
});

/**
 * ⚠ **The MOUNT, which is a separate property from the component working.**
 *
 * Removing `<AmbiguousColumns …>` from `ProposalReview` turned **nothing** red
 * — every test above still passed against a component no screen rendered. That
 * is I-120's exact shape, which this repo has now recorded four times: a value
 * computed, correct, tested, and consumed by nothing. A detector's own tests
 * cannot close it; only an assertion about the call site can.
 */
const proposal = (ambiguousColumns: FAOperationProposal["ambiguousColumns"]): FAOperationProposal =>
  ({
    status: "ok",
    name: "low_attendance",
    description: "",
    spec: { base: { table: "attendance_monthly" }, columns: [], joins: [], filters: [] },
    readback: [],
    outputColumns: [],
    ambiguousColumns,
    compiledSql: "SELECT 1",
    paramsSchema: {},
    attempts: 1,
  }) as unknown as FAOperationProposal;

describe("the review surface actually renders it", () => {
  const props = {
    name: "n",
    onName: () => {},
    nameError: null,
    busy: null,
    onApprove: () => {},
    onDiscard: () => {},
  };

  it("shows the ambiguity inside a full proposal review", () => {
    render(
      <ProposalReview
        {...props}
        proposal={proposal([{ column: "status", resolvedTo: "orders", alsoOn: ["customers"] }])}
      />,
    );
    expect(screen.getAllByText("status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("customers.status").length).toBeGreaterThan(0);
  });

  it("the control: a proposal with no ambiguity adds nothing to the review", () => {
    // Without this, a `ProposalReview` that rendered the section unconditionally
    // — heading and all, over an empty list — would pass the assertion above.
    //
    // ⚠ Scoped to `container`, not `screen`. This suite has no auto-cleanup, so
    // a `screen` query reads every earlier test's DOM as well and this control
    // failed against the PREVIOUS test's output — an assertion that was about
    // the wrong document.
    const { container } = render(<ProposalReview {...props} proposal={proposal([])} />);
    expect(container.textContent).not.toContain("Which table these came from");
  });
});
