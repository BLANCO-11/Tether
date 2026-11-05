// @vitest-environment jsdom
//
// The builder page opens a workflow in Forge (the Pi workbench). ⚠ 2026-10-11: the compiled builder is deleted with
// Kestra's role in building, so a workflow whose runtime is not `foundry` is SAID rather than opened in an editor that
// cannot read it. This file used to test the compiled builder's two modes, drawer and save flow — all deleted with it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";

const getFlowDetail = vi.fn();
vi.mock("@/lib/api", () => ({ getFlowDetail: (...a: unknown[]) => getFlowDetail(...a) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/pi-builder/PiBuilderWorkbench", () => ({
  PiBuilderWorkbench: ({ flowId }: { flowId: string }) => <div data-testid="pi-workbench">{flowId}</div>,
}));

vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return { useParams: () => routeParams.current };
});
import BuilderPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const detail = (runtime: string) => ({ flow: { id: "f-1", name: "Weekly digest", runtime }, runs: [] });

describe("the builder page", () => {
  it("opens a Forge workflow in the Pi workbench", async () => {
    getFlowDetail.mockResolvedValue(detail("foundry"));
    render(atRoute("f-1", <BuilderPage />));
    expect((await screen.findByTestId("pi-workbench")).textContent).toBe("f-1");
  });

  it("says a retired-builder workflow cannot be edited, rather than opening an editor", async () => {
    getFlowDetail.mockResolvedValue(detail("kestra"));
    render(atRoute("f-1", <BuilderPage />));
    expect(await screen.findByText("This workflow was built with the retired builder")).toBeTruthy();
    expect(screen.queryByTestId("pi-workbench")).toBeNull();
  });

  it("says when the workflow could not be read", async () => {
    getFlowDetail.mockRejectedValue(new Error("boom"));
    render(atRoute("f-1", <BuilderPage />));
    expect(await screen.findByText("This flow could not be opened")).toBeTruthy();
  });
});
