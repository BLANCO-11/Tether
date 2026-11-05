// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMeter, meterTone } from "./ContextMeter";

afterEach(() => cleanup());
const ctx = (percent: number | null) => ({ tokens: percent == null ? null : percent * 1000, window: 100_000, percent, at: "" });

describe("meterTone", () => {
  it("is amber past 70%, red past 90%, and unknown when pi does not know", () => {
    expect(meterTone(40)).toBe("ok");
    expect(meterTone(71)).toBe("warn");
    expect(meterTone(93)).toBe("danger");
    expect(meterTone(null)).toBe("unknown");
  });
});

describe("ContextMeter", () => {
  it("opens to the numbers, and Compact now calls back", async () => {
    const onCompact = vi.fn(async () => undefined);
    render(<ContextMeter context={ctx(75)} compacting={false} canCompact onCompact={onCompact} />);
    fireEvent.click(screen.getByLabelText("Conversation 75% full"));
    expect(screen.getByText(/75k of 100k tokens/)).toBeTruthy();
    fireEvent.click(screen.getByText("Compact now"));
    await waitFor(() => expect(onCompact).toHaveBeenCalled());
  });

  it("says when the size is not known, and cannot compact while Forge is working", () => {
    render(<ContextMeter context={ctx(null)} compacting={false} canCompact={false} onCompact={async () => undefined} />);
    fireEvent.click(screen.getByLabelText(/not known yet/));
    expect(screen.getByText(/measured after Forge/)).toBeTruthy();
    expect((screen.getByText("Compact now") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error when compacting fails", async () => {
    render(<ContextMeter context={ctx(50)} compacting={false} canCompact onCompact={async () => { throw new Error("Nothing was changed."); }} />);
    fireEvent.click(screen.getByLabelText("Conversation 50% full"));
    fireEvent.click(screen.getByText("Compact now"));
    expect(await screen.findByText("Nothing was changed.")).toBeTruthy();
  });
});
