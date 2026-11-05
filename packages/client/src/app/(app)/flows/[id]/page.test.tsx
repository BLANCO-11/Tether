// @vitest-environment jsdom
//
// The workflow page loads one workflow and renders `PiFlowOverview` for it (the overview has its own tests).
// ⚠ 2026-10-11: the compiled-flow page this file used to test — four tabs, the approval spine, the API tab, a branch
// of INVENTED figures for one workflow id — is deleted with Kestra's role in building. What is pinned here is the
// loader: a Forge workflow gets the overview, a retired-builder workflow is said, and failures are said.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";

const getFlowDetail = vi.fn();
const getFlowReview = vi.fn();
vi.mock("@/lib/api", () => ({
  getFlowDetail: (...a: unknown[]) => getFlowDetail(...a),
  getFlowReview: (...a: unknown[]) => getFlowReview(...a),
  renameFlow: vi.fn(),
}));
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return { useParams: () => routeParams.current };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/pi-builder/PiFlowOverview", () => ({
  PiFlowOverview: ({ flow, workflow }: { flow: { name: string }; workflow: { steps: unknown[] } | null }) => (
    <div data-testid="overview">
      {flow.name} · {workflow ? `${workflow.steps.length} steps` : "no steps read"}
    </div>
  ),
  PiFlowOverviewSkeleton: () => <div data-testid="skeleton" />,
}));

import FlowPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const detail = (runtime: string) => ({
  flow: { id: "f-1", name: "Weekly digest", runtime, draftRevision: 3 },
  runs: [],
});

describe("the workflow page", () => {
  it("renders the Forge overview with the draft's workflow", async () => {
    getFlowDetail.mockResolvedValue(detail("foundry"));
    getFlowReview.mockResolvedValue({ model: { workflow: { steps: [{ id: "a" }, { id: "b" }] } } });
    render(atRoute("f-1", <FlowPage />));
    expect((await screen.findByTestId("overview")).textContent).toContain("Weekly digest · 2 steps");
    expect(getFlowReview).toHaveBeenCalledWith("f-1", 3);
  });

  it("still renders the overview when the steps cannot be read — the overview says so", async () => {
    getFlowDetail.mockResolvedValue(detail("foundry"));
    getFlowReview.mockRejectedValue(new Error("nope"));
    render(atRoute("f-1", <FlowPage />));
    expect((await screen.findByTestId("overview")).textContent).toContain("no steps read");
  });

  it("says a retired-builder workflow cannot be opened, and never asks for its review", async () => {
    getFlowDetail.mockResolvedValue(detail("kestra"));
    render(atRoute("f-1", <FlowPage />));
    expect(await screen.findByText("This workflow was built with the retired builder")).toBeTruthy();
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(getFlowReview).not.toHaveBeenCalled();
  });

  it("says a deleted workflow no longer exists", async () => {
    getFlowDetail.mockResolvedValue(undefined);
    render(atRoute("f-1", <FlowPage />));
    expect(await screen.findByText("This workflow no longer exists.")).toBeTruthy();
  });
});
