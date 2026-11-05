// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * GAPS §3.3 — the fire audit trail, and the two answers it has to keep apart.
 *
 * The route has existed since Phase 3 with no client method, so the trail was
 * API-only. It is the screen someone opens when an automation is silent, and
 * silence has two causes with completely different fixes:
 *
 *   * it never fired — nothing tried to start the automation;
 *   * it fired and was refused — gate 2, almost always.
 *
 * ⚠ Which is why the empty state and the failure state must never look alike.
 * "No rows" is the strongest finding this screen produces, so rendering it in
 * response to a FAILED request would be `faFallback` in miniature: a server
 * problem presented as a confident answer about the product.
 */

const listTriggerFires = vi.fn();
vi.mock("@/lib/api", () => ({ listTriggerFires: (id: string) => listTriggerFires(id) }));

const { TriggerFires } = await import("./TriggerFires");

afterEach(() => {
  cleanup();
  listTriggerFires.mockReset();
});

describe("the fire audit trail", () => {
  it("says a fire started nothing, rather than omitting the row", async () => {
    listTriggerFires.mockResolvedValue([
      { id: "f1", how: "manually", when: "2h ago", whenIso: null, startedRunId: null, startedRunStatus: null },
    ]);
    render(<TriggerFires triggerId="t-1" />);
    expect(await screen.findByText(/started nothing/)).toBeTruthy();
  });

  it("links a fire that did start a run", async () => {
    // The control. A component that printed "started nothing" unconditionally
    // would pass the assertion above and be useless.
    listTriggerFires.mockResolvedValue([
      { id: "f2", how: "by a webhook", when: "1m ago", whenIso: null, startedRunId: "fe-9", startedRunStatus: "succeeded" },
    ]);
    render(<TriggerFires triggerId="t-1" />);
    const link = await screen.findByRole("link", { name: /started a run/ });
    expect(link.getAttribute("href")).toBe("/runs/fe-9");
    expect(screen.queryByText(/started nothing/)).toBeNull();
  });

  it("distinguishes 'never fired' from 'could not load'", async () => {
    listTriggerFires.mockResolvedValue([]);
    render(<TriggerFires triggerId="t-1" />);
    expect(await screen.findByText(/has never fired/)).toBeTruthy();
  });

  /**
   * ⚠ The regression this file mainly exists for. `useAsync` hands back
   * `{ data, loading, error }`, and a component that destructures it and never
   * reads `error` renders `data ?? []` — which here is the empty state, i.e. the
   * sentence "this trigger has never fired" shown because the server was down.
   */
  it("reports a failed request as a failure, and NOT as 'never fired'", async () => {
    listTriggerFires.mockRejectedValue(new Error("502 from the parent API"));
    render(<TriggerFires triggerId="t-1" />);
    await waitFor(() => expect(screen.getByText(/Could not load the fire history/)).toBeTruthy());
    expect(screen.queryByText(/has never fired/)).toBeNull();
    expect(screen.getByText(/502 from the parent API/)).toBeTruthy();
  });
});
