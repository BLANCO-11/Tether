// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PiFlowOverview } from "./PiFlowOverview";
import type { FlowSummary } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/flows/f1" }));

const flow = { id: "f1", name: "Monthly hours", description: "Hours per employee", runtime: "foundry" } as unknown as FlowSummary;

describe("the flow page for a Pi workflow", () => {
  afterEach(cleanup);
  it("shows its inputs, steps and runs, with Edit leading to the builder", () => {
    render(
      <PiFlowOverview
        flow={flow}
        workflow={{
          inputs: { month: { type: "integer", description: "Month number" } },
          steps: [
            { id: "load", outputs: ["rows"], allow_empty: [{ output: "rows", reason: "a quiet month" }] },
            { id: "report", outputs: ["file"] },
          ],
        }}
        runs={[{ id: "run-1", status: "succeeded", engineStatus: "success", startedAt: new Date().toISOString() }]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("month")).toBeTruthy();
    // A step with no description reads as words, not as its id.
    expect(screen.getByText("Load")).toBeTruthy();
    expect(screen.getByText(/May be empty: rows \(a quiet month\)/)).toBeTruthy();
    // A run in plain words, never the engine's spelling.
    const recentRuns = screen.getByRole("heading", { name: "Recent runs" }).closest("section")!;
    expect(within(recentRuns).getByText("Succeeded")).toBeTruthy();
    expect(screen.queryByText("success")).toBeNull();
    expect(screen.getByRole("link", { name: /Edit workflow/ }).getAttribute("href")).toBe("/flows/f1/builder");
  });

  it("never shows the builder prompt (the description) under the title", () => {
    render(<PiFlowOverview flow={flow} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />);
    expect(screen.queryByText("Hours per employee")).toBeNull();
    expect(screen.queryByText("Built with Forge.")).toBeNull();
  });

  it("a described step leads with its sentence, its id beneath", () => {
    render(
      <PiFlowOverview
        flow={flow}
        workflow={{ steps: [{ id: "send", description: "Email each manager", uses: ["tool:tether_email_send"] }] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("Email each manager")).toBeTruthy();
    expect(screen.getByText("send")).toBeTruthy();
    expect(screen.getByText("Action")).toBeTruthy();
    expect(screen.getByText("uses tether_email_send")).toBeTruthy();
  });

  it("a paused run says it is waiting for approval; the rate counts settled runs only", () => {
    render(
      <PiFlowOverview
        flow={flow}
        workflow={{ steps: [] }}
        runs={[
          { id: "a", status: "running", engineStatus: "paused", startedAt: new Date().toISOString() },
          { id: "b", status: "succeeded", engineStatus: "success", startedAt: new Date().toISOString() },
          { id: "c", status: "running", engineStatus: "running", startedAt: new Date().toISOString() },
        ]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("turned off by a person: Turn back on, not Approve", () => {
    render(
      <PiFlowOverview
        flow={{ ...flow, draftRevision: 3, armedRevision: 3, status: "suspended", staleReason: null } as FlowSummary}
        workflow={{ steps: [] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("Turn back on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.queryByText(/Run now/)).toBeNull();
  });

  it("says when the steps could not be read rather than showing none", () => {
    render(<PiFlowOverview flow={flow} workflow={null} runs={[]} onRename={async () => {}} />);
    expect(screen.getByText(/steps could not be read/)).toBeTruthy();
  });

  it("not approved yet: offers Approve, never Run now", () => {
    render(<PiFlowOverview flow={{ ...flow, draftRevision: 2, armedRevision: null, status: "draft" } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByText(/Run now/)).toBeNull();
  });

  it("approved and unchanged: Run now with its inputs prefilled, and Turn off — no Approve", () => {
    render(
      <PiFlowOverview
        flow={{ ...flow, draftRevision: 3, armedRevision: 3, status: "approved", version: 1 } as FlowSummary}
        workflow={{ inputs: { month: { type: "integer", description: "Which month", default: 8 } }, steps: [] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText(/Run now/)).toBeTruthy();
    expect((screen.getByLabelText("month") as HTMLInputElement).value).toBe("8");
    expect(screen.getByText("Turn off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("the Status tile names the state with a tag — Live, Changes pending, Draft, Turned off", () => {
    const tag = () => screen.getByTestId("flow-status-tag").textContent;
    const cases: Array<[Partial<FlowSummary>, string]> = [
      [{ draftRevision: 3, armedRevision: 3, status: "approved" }, "Live"],
      [{ draftRevision: 4, armedRevision: 3, status: "draft_pending" }, "Changes pending"],
      [{ draftRevision: 2, armedRevision: null, status: "draft" }, "Draft"],
      [{ draftRevision: 3, armedRevision: 3, status: "suspended", staleReason: null }, "Turned off"],
    ];
    for (const [f, want] of cases) {
      render(<PiFlowOverview flow={{ ...flow, ...f } as FlowSummary} workflow={{ steps: [] }} runs={[]} onRename={async () => {}} />);
      expect(tag()).toBe(want);
      cleanup();
    }
  });

  it("changes pending: the approved version keeps running, and the action approves the changes", () => {
    render(
      <PiFlowOverview
        flow={{ ...flow, draftRevision: 4, armedRevision: 3, status: "draft_pending", version: 2 } as FlowSummary}
        workflow={{ steps: [] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("Approve changes")).toBeTruthy();
    expect(screen.getByTestId("flow-status-tag").getAttribute("title")).toBe("v2 is live. Your edits need approval.");
    expect(screen.getByText(/Run now/)).toBeTruthy();
  });

  it("the header carries the version tag and no status pill", () => {
    render(
      <PiFlowOverview
        flow={{ ...flow, draftRevision: 3, armedRevision: 3, status: "approved", version: 1 } as FlowSummary}
        workflow={{ steps: [] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.queryByText("Approved")).toBeNull();
  });

  it("Run now comes before Details in the aside", () => {
    render(
      <PiFlowOverview
        flow={{ ...flow, draftRevision: 3, armedRevision: 3, status: "approved" } as FlowSummary}
        workflow={{ steps: [] }}
        runs={[]}
        onRename={async () => {}}
      />,
    );
    const run = screen.getByRole("heading", { name: "Run it now" });
    const details = screen.getByRole("heading", { name: "Details" });
    expect(run.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
