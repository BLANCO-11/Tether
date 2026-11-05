// @vitest-environment jsdom
/**
 * `ApprovalCard` — the note that is recorded when nobody types one.
 *
 * ⚠ **This suite exists because of run `71be8add`, where a real approval was
 * recorded and never delivered.** The note box was left blank; the engine's
 * `onResume` declares `note` as a required STRING, so the resume came back 422,
 * the row was stamped `decided`, the run stayed paused, and the inbox stopped
 * listing it (`listPending` filters `decided_at IS NULL`). Nothing on any screen
 * said the run was still waiting.
 *
 * So the property under test is narrow and behavioural: **the request never
 * carries an empty note, and which default it carries depends on the button.**
 * A test that only checked the hint text renders would pass over a card that
 * displays the default and still sends `undefined`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalCard, defaultNote } from "./ApprovalCard";

const decideApproval = vi.fn();
vi.mock("@/lib/api", () => ({
  decideApproval: (...a: unknown[]) => decideApproval(...a),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { email: "a@b.example" } }) }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));

function approval(over: Record<string, unknown> = {}) {
  return {
    id: "ap1",
    flowExecutionId: "ex1",
    flowId: "f1",
    stepId: "approve_report",
    kind: "gate",
    summary: "Send the department budget report",
    context: null,
    questions: null,
    answers: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    appliedAt: null,
    note: null,
    createdAt: "2026-08-21T06:47:00Z",
    ...over,
  } as never;
}

beforeEach(() => decideApproval.mockReset().mockResolvedValue({}));
afterEach(() => cleanup());

describe("the note is never sent empty", () => {
  it("⚠ a blank note approves with the APPROVED default, not with nothing", async () => {
    render(<ApprovalCard approval={approval()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and continue" }));

    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    const [, decision, note] = decideApproval.mock.calls[0]!;
    expect(decision).toBe("approved");
    // The exact failure being prevented: an empty string, or nothing at all.
    expect(note).toBeTruthy();
    expect(note).toBe(defaultNote("approved", false));
  });

  it("⚠ a blank note rejects with the REJECTED default — the button chooses it", async () => {
    render(<ApprovalCard approval={approval()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    // Rejecting is confirmed first, because it kills the run.
    fireEvent.click(screen.getByRole("button", { name: "Reject and stop" }));

    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    const [, decision, note] = decideApproval.mock.calls[0]!;
    expect(decision).toBe("rejected");
    expect(note).toBe(defaultNote("rejected", false));
    // ⚠ And it is not the approving default — a single constant would pass the
    // test above while writing "Approved" into a rejection's audit row.
    expect(note).not.toBe(defaultNote("approved", false));
  });

  it("a typed note is sent verbatim — the default only fills a blank", async () => {
    render(<ApprovalCard approval={approval()} />);
    fireEvent.change(screen.getByPlaceholderText("Note (optional)"), {
      target: { value: "checked the 11 rows against the ledger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve and continue" }));

    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(decideApproval.mock.calls[0]![2]).toBe("checked the 11 rows against the ledger");
  });

  it("says what will be recorded while the box is empty, and stops once it is not", () => {
    render(<ApprovalCard approval={approval()} />);
    expect(screen.getByText(/Left empty, the note is recorded as/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Note (optional)"), { target: { value: "ok" } });
    expect(screen.queryByText(/Left empty, the note is recorded as/)).toBeNull();
  });

  it("⚠ a QUESTION gets its own wording — 'Approved' describes neither answering nor declining", () => {
    // Four distinct strings, so an audit row says which of the four acts happened.
    const all = [
      defaultNote("approved", false),
      defaultNote("rejected", false),
      defaultNote("approved", true),
      defaultNote("rejected", true),
    ];
    expect(new Set(all).size).toBe(4);
    expect(defaultNote("approved", true)).toMatch(/Answered/);
    expect(defaultNote("rejected", true)).toMatch(/Declined/);
  });

  it("⚠ no default reads as a judgement — the note is the approver's own words", () => {
    // A default like "looks fine" or "verified" would put a finding nobody made
    // into the one row that records what a person decided.
    for (const n of [
      defaultNote("approved", false),
      defaultNote("rejected", false),
      defaultNote("approved", true),
      defaultNote("rejected", true),
    ]) {
      expect(n.toLowerCase()).not.toMatch(/verified|checked|looks|fine|ok\b|correct|reviewed/);
      // And it says a note was not given, rather than implying one was.
      expect(n).toMatch(/no note given/);
    }
  });
});
