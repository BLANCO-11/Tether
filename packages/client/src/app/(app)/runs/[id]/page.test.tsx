// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";
import type { FlowExecutionDetail, StepRun } from "@/lib/types";

let currentDetail: FlowExecutionDetail | null = null;
let technical = "0";

vi.mock("@/lib/flow-stream", () => ({
  isLive: (s: string) => ["running", "created", "paused"].includes(s),
  openFlowStream: (_id: string, h: { onUpdate: (d: FlowExecutionDetail) => void }) => {
    if (currentDetail) queueMicrotask(() => h.onUpdate(currentDetail as FlowExecutionDetail));
    return { close: vi.fn() };
  },
}));
vi.mock("@/lib/api", () => ({
  getFlowPositions: async () => new Map<string, { x: number; y: number }>(),
  listExecutionApprovals: async () => [],
  // ⚠ `vi.mock` replaces the WHOLE module: a read the page makes that is missing here comes back undefined and
  // crashes every test. `emailsForRun` was added to the page and not here, which failed this file at HEAD.
  emailsForRun: async () => [],
  callsForRun: async () => ({ calls: [], truncated: false }),
  cancelFlowExecution: async () => ({ cancelled: true, status: "cancelled" }),
}));
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return {
  useParams: () => routeParams.current,
  useSearchParams: () => ({ get: (k: string) => (k === "technical" ? technical : null) }),
  };
});
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: string }) => {
    const React = require("react");
    return React.createElement("a", { href }, children as unknown);
  },
}));

import RunPage from "./page";

function step(over: Partial<StepRun> & { stepId: string }): StepRun {
  return {
    status: "success",
    kind: null,
    platform: false,
    ref: null,
    readFrom: null,
    attempt: 1,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    request: null,
    responseCode: null,
    output: null,
    error: null,
    logs: [],
    kestraTaskrunId: null,
    auditVerdict: null,
    oracleScore: null,
    ...over,
  } as StepRun;
}
function detail(over: Partial<FlowExecutionDetail> = {}): FlowExecutionDetail {
  return {
    id: "RUN-2026-08-08-test",
    workspaceId: "ws-1",
    flowId: "flow-1",
    flowName: "Monthly back-to-office compliance",
    status: "running",
    engineStatus: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    inputs: {},
    replayOfId: null,
    replayFromStep: null,
    steps: [],
    graph: null,
    expectations: [],
    ...over,
  } as FlowExecutionDetail;
}
const flagshipSteps: StepRun[] = [
  step({ stepId: "Run monthly on the 1st at 02:00", status: "success", durationMs: 1000 }),
  step({ stepId: "Read swipe records from S3", status: "success", durationMs: 34000 }),
  step({ stepId: "Read headcount report from SFTP", status: "success", durationMs: 12000 }),
  step({ stepId: "Read leave records from PostgreSQL", status: "success", durationMs: 18000 }),
  step({ stepId: "Pair swipe-in and swipe-out by employee", status: "success", durationMs: 27000 }),
  step({ stepId: "Calculate hours in office per day", status: "success", durationMs: 31000 }),
  step({ stepId: "Apply attendance policy", status: "running" }),
  step({ stepId: "Mark employees as compliant or non-compliant", status: "created" }),
  step({ stepId: "Check for approved exceptions", status: "created" }),
  step({ stepId: "Send non-compliance notifications", status: "created" }),
  step({ stepId: "Refresh HR and employee dashboards", status: "created" }),
  step({ stepId: "Deliver monthly compliance report", status: "created" }),
];
beforeEach(() => {
  technical = "0";
  currentDetail = detail({ steps: flagshipSteps, engineStatus: "running" });
});
afterEach(() => {
  cleanup();
  currentDetail = null;
  technical = "0";
});
/**
 * ⚠ THESE TESTS WERE REWRITTEN, NOT DELETED, AND WHY MATTERS.
 *
 * The previous 26 asserted the design pack's CAPTURE COPY verbatim — test names
 * literally read "renders four verbatim figures", "renders eyebrow TEST RUN ·
 * DRAFT V4", "shows technical host/port on the failure line". Every one of them
 * passed, and every one of them was pinning fabricated content: the page
 * discarded `run.steps` on failure and rendered a fixed contractor-timesheet
 * story with a `leave-db-prod.internal:5432` timeout, for any failed run of any
 * flow (`UXI-032`).
 *
 * **A test that asserts a mockup's strings cannot tell a rendered mockup from a
 * rendered run.** That is how the fabrication survived a green suite. So these
 * assert the PROPERTY — this run's own data reaches the screen, and no other
 * run's does — and each names the perturbation that turns it red.
 */

const uuidSteps: StepRun[] = [
  step({ stepId: "8f2c1a0e-4d3b-4c5a-9e1f-2b3c4d5e6f70", ref: "finance_demo.invoices_overdue", status: "success", durationMs: 1200 }),
  step({ stepId: "b7e4d2c9-1a8f-4e6b-8c3d-5f7a9b1c2d3e", ref: "mail_send", status: "failed", error: "SMTP 550 mailbox unavailable for vendor@acme-finance.example", durationMs: 800, attempt: 3 }),
  step({ stepId: "c9a1f3e7-2b4d-4a8c-9f1e-3d5b7c9e1a2f", ref: "ticket_create", status: "created" }),
];

describe("the failed run renders ITS OWN steps", () => {
  it("shows the failed step's real error, and no fabricated host", async () => {
    currentDetail = detail({ id: "RUN-REAL", flowName: "Chase overdue invoices", engineStatus: "failed", status: "failed", steps: uuidSteps });
    render(atRoute("RUN-REAL", <RunPage />));
    await waitFor(() =>
      expect(screen.getAllByText(/SMTP 550 mailbox unavailable/).length).toBeGreaterThan(0),
    );
    // ⚠ The control. Perturbation: restore the PACK_STEPS branch and this fails.
    expect(screen.queryByText(/leave-db-prod\.internal/)).toBeNull();
    expect(screen.queryByText(/Contractor timesheet chase/i)).toBeNull();
  });

  it("names the failed step by its own ref, at its own ordinal", async () => {
    currentDetail = detail({ id: "RUN-REAL", flowName: "Chase overdue invoices", engineStatus: "failed", status: "failed", steps: uuidSteps });
    render(atRoute("RUN-REAL", <RunPage />));
    await waitFor(() => expect(screen.getAllByText(/Failed at step 2 · mail_send/).length).toBeGreaterThan(0));
  });

  it("uses the run's own flow name as the eyebrow", async () => {
    currentDetail = detail({ id: "RUN-REAL", flowName: "Chase overdue invoices", engineStatus: "failed", status: "failed", steps: uuidSteps });
    render(atRoute("RUN-REAL", <RunPage />));
    await waitFor(() => expect(screen.getAllByText(/CHASE OVERDUE INVOICES/).length).toBeGreaterThan(0));
  });

  it("a run that failed with no failed step says so rather than inventing a cause", async () => {
    currentDetail = detail({ id: "RUN-BARE", flowName: "Bare", engineStatus: "failed", status: "failed", steps: [] });
    render(atRoute("RUN-BARE", <RunPage />));
    await waitFor(() =>
      expect(screen.getAllByText(/No step recorded a reason/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/leave-db-prod\.internal/)).toBeNull();
  });

  it("reports steps-that-ran as a real count, never four verbatim figures", async () => {
    currentDetail = detail({ id: "RUN-REAL", flowName: "F", engineStatus: "failed", status: "failed", steps: uuidSteps });
    render(atRoute("RUN-REAL", <RunPage />));
    await waitFor(() => expect(screen.getAllByText("2 of 3").length).toBeGreaterThan(0));
    expect(screen.queryByText("78 of 142")).toBeNull();
  });
});

describe("the live run stops fabricating", () => {
  it("shows Stop while running — cancel route exists (personal Phase 2)", async () => {
    currentDetail = detail({ steps: uuidSteps.slice(0, 1), engineStatus: "running" });
    render(atRoute("RUN-1", <RunPage />));
    await waitFor(() => expect(screen.getByText("Live execution trace")).toBeTruthy());
    expect(screen.getByTestId("run-stop")).toBeTruthy();
    expect(screen.queryByText("Stop test")).toBeNull();
  });

  it("does not print the literal DRAFT V4 eyebrow", async () => {
    currentDetail = detail({ flowName: "Monthly compliance", steps: uuidSteps.slice(0, 1), engineStatus: "running" });
    render(atRoute("RUN-1", <RunPage />));
    await waitFor(() => expect(screen.getByText("Live execution trace")).toBeTruthy());
    expect(screen.queryByText(/DRAFT V4/)).toBeNull();
  });

  it("the scenario panel reports what the run READ, not \"Mock data\"", async () => {
    currentDetail = detail({
      steps: [step({ stepId: "s1", ref: "q", readFrom: "production", status: "success" })],
      engineStatus: "running",
    });
    render(atRoute("RUN-1", <RunPage />));
    await waitFor(() => expect(screen.getAllByText("Production data").length).toBeGreaterThan(0));
    expect(screen.queryByText("142 employees")).toBeNull();
  });

  it("the sandbox caveat does NOT render over a production run", async () => {
    currentDetail = detail({
      steps: [step({ stepId: "s1", ref: "q", readFrom: "production", status: "success" })],
      engineStatus: "running",
    });
    render(atRoute("RUN-1", <RunPage />));
    await waitFor(() => expect(screen.getAllByText("Production data").length).toBeGreaterThan(0));
    // ⚠ The control. Over a production run this text is a false statement about
    // where the rows came from, not a caveat.
    expect(screen.queryByTestId("mock-caveat")).toBeNull();
  });

  it("the sandbox caveat DOES render over a sandbox run", async () => {
    currentDetail = detail({
      steps: [step({ stepId: "s1", ref: "q", readFrom: "sandbox", status: "success" })],
      engineStatus: "running",
    });
    render(atRoute("RUN-1", <RunPage />));
    await waitFor(() => expect(screen.getByTestId("mock-caveat")).toBeTruthy());
  });
});

describe("a run on someone else's own account (sharing-boundaries phase 3)", () => {
  it("says it ran and how it ended, and why nothing more is shown — not an empty run", async () => {
    currentDetail = detail({ engineStatus: "success", status: "succeeded", dataHidden: true, steps: [] });
    render(atRoute("RUN-2026-08-08-test", <RunPage />));
    await waitFor(() => expect(screen.getByText("This run used someone's own account")).toBeTruthy());
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.getByText(/only they and Admins/)).toBeTruthy();
    expect(screen.queryByText("Live execution trace")).toBeNull();
  });

  it("CONTROL: a run whose data this person may see draws its trace", async () => {
    currentDetail = detail({ steps: flagshipSteps, engineStatus: "running" });
    render(atRoute("RUN-2026-08-08-test", <RunPage />));
    await waitFor(() => expect(screen.getByText("Live execution trace")).toBeTruthy());
    expect(screen.queryByText("This run used someone's own account")).toBeNull();
  });
});
