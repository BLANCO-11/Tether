// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UploadsToast, type UploadItem } from "./UploadsToast";

afterEach(cleanup);

const item = (over: Partial<UploadItem> = {}): UploadItem => ({ key: "k", name: "a.csv", progress: 0.5, abort: vi.fn(), ...over });
const show = (uploads: UploadItem[], h = { onHide: vi.fn(), onDismissItem: vi.fn() }) => {
  render(<UploadsToast uploads={uploads} {...h} />);
  return h;
};
const tone = () => screen.getByTestId("uploads-toast").getAttribute("data-tone");
const pill = () => screen.getByRole("status");

describe("UploadsToast", () => {
  it("draws nothing when there is nothing to show", () => {
    show([]);
    expect(screen.queryByTestId("uploads-toast")).toBeNull();
  });

  it("is ONE pill, top centre, with a short label however many files", () => {
    show([item({ key: "1" }), item({ key: "2" }), item({ key: "3" })]);
    expect(screen.getAllByTestId("uploads-toast")).toHaveLength(1);
    expect(screen.getByText("Uploading 3 files")).toBeTruthy();
    expect(screen.getByTestId("uploads-toast").className).toMatch(/left-1\/2/);
    expect(screen.getByTestId("uploads-toast").className).toMatch(/top-3/);
    expect(tone()).toBe("running");
  });

  it("is neutral and blurred while uploading, and has NO cancel control and no dismiss", () => {
    show([item({ key: "1" }), item({ key: "2" })]);
    expect(pill().className).toMatch(/bg-surface-2\/80/);
    expect(pill().className).toMatch(/backdrop-blur/);
    expect(screen.queryByText(/cancel/i)).toBeNull();
    expect(screen.queryByLabelText(/cancel/i)).toBeNull();
    expect(screen.queryByLabelText("Dismiss uploads")).toBeNull();
  });

  it("shows progress as a RING: a circle whose dash offset follows the overall progress", () => {
    const { container } = render(<UploadsToast uploads={[item({ progress: 0.25 }), item({ key: "2", progress: 0.75 })]} onHide={vi.fn()} onDismissItem={vi.fn()} />);
    const arc = container.querySelectorAll("circle")[1]!;
    const c = 2 * Math.PI * 7.5;
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeCloseTo(c * 0.5, 2);
    expect(container.querySelector('[role="progressbar"], .h-1')).toBeNull(); // the old horizontal bar is gone
  });

  it("goes red when any file failed, and says how many, and the failure stays listed", () => {
    show([item({ key: "1" }), item({ key: "2", name: "b.csv", error: "too big", abort: undefined })]);
    expect(tone()).toBe("failed");
    expect(pill().className).toMatch(/bg-danger-bg/);
    expect(screen.getByText("Uploading 1 file · 1 failed")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show file list"));
    expect(screen.getByText("too big")).toBeTruthy();
  });

  it("when nothing is still running, a failure alone is the headline", () => {
    show([item({ error: "too big", abort: undefined })]);
    expect(screen.getByText("1 upload failed")).toBeTruthy();
  });

  it("goes green and smaller when everything has finished — the SAME pill, so it can animate", () => {
    const first = render(<UploadsToast uploads={[item({ key: "1" })]} onHide={vi.fn()} onDismissItem={vi.fn()} />);
    const before = screen.getByRole("status");
    expect(before.className).toMatch(/scale-100/);
    first.rerender(<UploadsToast uploads={[item({ key: "1", done: true, progress: 1, abort: undefined })]} onHide={vi.fn()} onDismissItem={vi.fn()} />);
    const after = screen.getByRole("status");
    expect(after).toBe(before); // not unmounted and re-created: the transition has an element to run on
    expect(tone()).toBe("done");
    expect(after.className).toMatch(/bg-ok-bg/);
    expect(after.className).toMatch(/scale-95/);
    expect(after.className).toMatch(/transition-\[width,transform,background-color/);
    expect(screen.getByText("1 file uploaded")).toBeTruthy();
  });

  it("once nothing is running, an X dismisses the pill", () => {
    const h = show([item({ done: true, abort: undefined })]);
    fireEvent.click(screen.getByLabelText("Dismiss uploads"));
    expect(h.onHide).toHaveBeenCalledOnce();
  });

  it("clicking the pill lists the files; only a failed file has a dismiss, and running files cannot be cancelled", () => {
    const abort = vi.fn();
    const h = show([item({ key: "1", abort }), item({ key: "2", name: "b.csv", error: "no", abort: undefined })]);
    fireEvent.click(screen.getByLabelText("Show file list"));
    expect(screen.getByText("a.csv")).toBeTruthy();
    expect(screen.queryByLabelText("Cancel a.csv")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dismiss b.csv"));
    expect(h.onDismissItem).toHaveBeenCalledWith("2");
    expect(abort).not.toHaveBeenCalled();
  });
});
