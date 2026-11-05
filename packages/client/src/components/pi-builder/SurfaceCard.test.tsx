// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

afterEach(cleanup);
import { SurfaceCard } from "./SurfaceCard";
import type { PiProposal } from "@/lib/pi-builder";

function listCard(over: Partial<PiProposal> = {}): PiProposal {
  return {
    id: "c1",
    kind: "surface",
    tool: "show-card",
    connector: "List",
    action: "Devices",
    summary: "Connected",
    params: {},
    status: "pending",
    at: new Date().toISOString(),
    surface: {
      mode: "info",
      type: "list",
      title: "Connected devices",
      items: [
        { id: "d1", title: "This computer", tone: "ok", meta: "online" },
        { id: "d2", title: "Other", tone: "muted" },
      ],
      actions: [{ id: "dismiss", label: "Dismiss list" }],
    },
    ...over,
  };
}

function choiceCard(): PiProposal {
  return {
    id: "c2",
    kind: "surface",
    tool: "show-card",
    connector: "Choice",
    action: "Pick",
    summary: "Which?",
    params: {},
    status: "pending",
    at: new Date().toISOString(),
    surface: {
      mode: "ask",
      type: "choice",
      title: "Which device?",
      items: [
        { id: "d1", title: "This computer" },
        { id: "d2", title: "Hands-free" },
      ],
    },
  };
}

describe("SurfaceCard", () => {
  it("renders an info list", () => {
    render(<SurfaceCard p={listCard()} onDecide={vi.fn()} />);
    expect(screen.getByText("Connected devices")).toBeTruthy();
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByText("Listed")).toBeTruthy();
  });

  it("fires an info action", async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<SurfaceCard p={listCard()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss list" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("c1", "run", undefined, undefined, { actionId: "dismiss" }));
  });

  it("submits a choice", async () => {
    const onDecide = vi.fn(async () => undefined);
    render(<SurfaceCard p={choiceCard()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "This computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("c2", "run", undefined, undefined, { selected: ["d1"] }));
  });
});
