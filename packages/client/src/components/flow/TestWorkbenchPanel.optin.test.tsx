// @vitest-environment jsdom
//
// TestWorkbenchPanel production opt-in — a REAL gate, not the deleted
// ceremony. The flag travels in the request (the server gates it to admins
// and audits every use); the checkbox alone starts nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));

import { TestWorkbenchPanel } from "./TestWorkbenchPanel";

vi.mock("@/lib/api", () => ({ flowReadSources: vi.fn(async () => []) }));
import { flowReadSources } from "@/lib/api";
const readSources = vi.mocked(flowReadSources);

afterEach(() => {
  cleanup();
  toast.mockClear();
  readSources.mockReset();
  readSources.mockResolvedValue([]);
});

function props(over: Record<string, unknown> = {}) {
  return {
    flowId: "flow-1",
    inputs: [],
    testing: false,
    notice: null,
    run: vi.fn(),
    onClose: vi.fn(),
    datasourceRefs: ["hr_demo.attendance_all"],
    ...over,
  };
}

describe("production opt-in", () => {
  it("the box starts unchecked — mock is the default", () => {
    render(<TestWorkbenchPanel {...props()} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("one click still runs mock with a single argument", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({});
  });

  it("checking and running asks for confirmation first — nothing runs yet", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText("Read production data?")).toBeTruthy();
  });

  it("confirming runs with the flag; cancelling runs nothing", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    fireEvent.click(screen.getByRole("button", { name: "Run on production" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({}, { useProductionData: true });
  });

  it("closing the confirm runs nothing", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("mock-vs-prod indicator follows readiness", () => {
  it("a ready mock reads mock data, not the sandbox sentence", async () => {
    readSources.mockResolvedValue([
      { name: "hr_demo", hasSandbox: false, dbName: null, mockStatus: "ready", mockError: null },
    ]);
    render(<TestWorkbenchPanel {...props()} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("mock data"));
    expect(screen.getByTestId("test-reads").textContent).not.toContain("real records");
  });

  it("a building mock refuses — never silent production", async () => {
    readSources.mockResolvedValue([
      { name: "hr_demo", hasSandbox: false, dbName: null, mockStatus: "building", mockError: null },
    ]);
    render(<TestWorkbenchPanel {...props()} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("refuses"));
    expect(screen.getByTestId("test-reads").textContent).not.toContain("real records");
  });

  it("a failed mock names the reason and refuses", async () => {
    readSources.mockResolvedValue([
      { name: "hr_demo", hasSandbox: false, dbName: null, mockStatus: "failed", mockError: "too many tables" },
    ]);
    render(<TestWorkbenchPanel {...props()} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("too many tables"));
    expect(screen.getByTestId("test-reads").textContent).toContain("refuses");
  });
});

describe("a surface that cannot run on production (the Pi builder's draft runs)", () => {
  it("draws no production checkbox at all — a control the run cannot honour is not offered", () => {
    render(<TestWorkbenchPanel {...props({ productionOption: false })} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("asks for each declared input before the run, and runs with what was typed", () => {
    const run = vi.fn();
    render(
      <TestWorkbenchPanel
        {...props({
          run,
          productionOption: false,
          inputs: [{ id: "month", type: "INT", defaults: "6", required: false, description: "Which month?" }],
        })}
      />,
    );
    const box = screen.getByDisplayValue("6");
    fireEvent.change(box, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledWith({ month: "1" });
  });

  it("control: by default the checkbox is still drawn", () => {
    render(<TestWorkbenchPanel {...props()} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
});
