// @vitest-environment jsdom
// What a run called (2026-10-30): read from Foundry's own records, a web read listed with its address and answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const callsForRun = vi.fn();
vi.mock("@/lib/api", () => ({ callsForRun: (id: string) => callsForRun(id), emailsForRun: async () => [] }));

const { ToolActivity } = await import("./ToolActivity");

afterEach(() => {
  cleanup();
  callsForRun.mockReset();
});

describe("ToolActivity", () => {
  it("lists a web read with its address, and a failed call as failed", async () => {
    callsForRun.mockResolvedValue({
      truncated: false,
      calls: [
        { id: "1", kind: "web", name: "web_fetch", stepId: "read_feed", ok: true, durationMs: 120, at: new Date().toISOString(), detail: "https://feeds.example/news · 200 · 1024 bytes" },
        { id: "2", kind: "tool", name: "llm_complete", stepId: "summarise", ok: false, durationMs: 50, at: new Date().toISOString(), detail: null },
      ],
    });
    render(<ToolActivity runId="r1" />);
    expect(await screen.findByText("https://feeds.example/news · 200 · 1024 bytes")).toBeTruthy();
    expect(callsForRun).toHaveBeenCalledWith("r1");
    expect(screen.getByText("llm_complete").parentElement!.textContent).toContain("failed");
  });

  it("an unreadable record says so, never an empty list", async () => {
    callsForRun.mockRejectedValue(new Error("404 not found"));
    render(<ToolActivity runId="r1" />);
    expect(await screen.findByText(/not evidence that the run called/)).toBeTruthy();
  });
});
