// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TestRunPanel } from "./TestRunPanel";
import type { FlowInputDecl } from "@/lib/types";

afterEach(cleanup);

const period: FlowInputDecl = { id: "period", type: "STRING", required: true };

describe("TestRunPanel", () => {
  it("requires only required declarations that have no persistent default", () => {
    render(
      <TestRunPanel
        inputs={[{ id: "cc", type: "STRING", required: false }]}
        busy={false}
        lastRun={null}
        onRun={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Run test" })).not.toHaveProperty("disabled", true);
  });

  it("resets its fields when a revision reload changes the declaration", () => {
    const onRun = vi.fn();
    const view = render(
      <TestRunPanel inputs={[period]} busy={false} lastRun={null} onRun={onRun} />,
    );

    fireEvent.change(screen.getByLabelText("Test value for period"), {
      target: { value: "temporary" },
    });
    view.rerender(
      <TestRunPanel
        inputs={[{ ...period, defaults: "2026-08" }]}
        busy={false}
        lastRun={null}
        onRun={onRun}
      />,
    );

    expect(screen.getByLabelText("Test value for period")).toHaveProperty("value", "2026-08");
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(onRun).toHaveBeenCalledWith({ period: "2026-08" });
  });

  it("preserves typed values across ordinary rerenders", () => {
    const onRun = vi.fn();
    const view = render(
      <TestRunPanel inputs={[period]} busy={false} lastRun={null} onRun={onRun} />,
    );
    fireEvent.change(screen.getByLabelText("Test value for period"), {
      target: { value: "2026-09" },
    });

    view.rerender(<TestRunPanel inputs={[{ ...period }]} busy lastRun={null} onRun={onRun} />);
    expect(screen.getByLabelText("Test value for period")).toHaveProperty("value", "2026-09");
  });
});
