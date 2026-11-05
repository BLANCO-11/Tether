// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BannerText } from "./PiBuilderWorkbench";

describe("the builder's banner", () => {
  afterEach(cleanup);
  const raw = 'VERIFY FAIL\n  - read "muster_rows": this join cannot use an index';
  it("says one sentence and keeps the raw result behind Details", () => {
    render(<BannerText state={{ text: "The workflow did not pass its checks, so the test did not start.", detail: raw }} />);
    expect(screen.getByText(/did not pass its checks/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText(/VERIFY FAIL/).closest("details")).toBeTruthy();
  });
  it("has no Details when there is nothing more to show", () => {
    render(<BannerText state={{ text: "Could not save." }} />);
    expect(screen.queryByText("Details")).toBeNull();
  });
  describe("needs real data (2026-11-03)", () => {
    const state = { text: "The test needs real data.", needsRealData: true };
    it("offers the button to an admin, and runs only after the confirm step", () => {
      const onRun = vi.fn();
      render(<BannerText state={state} realData={{ canRun: true, busy: false, onRun }} />);
      fireEvent.click(screen.getByRole("button", { name: "Test on real data" }));
      expect(onRun).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Test on real data" }));
      expect(onRun).toHaveBeenCalledTimes(1);
    });
    it("tells everyone else to ask an admin, with no button", () => {
      render(<BannerText state={state} realData={{ canRun: false, busy: false, onRun: vi.fn() }} />);
      expect(screen.getByText("Ask an admin to run it on real data.")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });
    it("adds nothing when the test did not need real data", () => {
      render(<BannerText state={{ text: "Could not save." }} realData={{ canRun: true, busy: false, onRun: vi.fn() }} />);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText(/real data/)).toBeNull();
    });
  });
});
