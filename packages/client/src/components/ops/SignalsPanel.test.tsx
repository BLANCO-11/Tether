// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SignalsPanel } from "./SignalsPanel";

/**
 * GAPS §6.1b on screen.
 *
 * Two things are worth testing and neither is that a list renders:
 *
 *  * **A failure to READ the signals is not a green.** This is a monitoring
 *    surface; showing nothing wrong because the check itself broke is the
 *    precise lie the whole product's honesty rules exist to stop.
 *  * **The caveats survive to the pixel.** Each signal states what it cannot
 *    see, and those sentences are the difference between a tick that means
 *    something and one that means nobody looked.
 */

vi.mock("@/lib/api", () => ({ listSignals: vi.fn() }));
const api = await import("@/lib/api");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const signal = (over: Record<string, unknown> = {}) => ({
  name: "scheduled_flows_firing",
  state: "ok" as const,
  detail: "3 scheduled flow(s) firing on schedule",
  caveat: "The period is LEARNED from history and the cron is never parsed.",
  ...over,
});

describe("SignalsPanel", () => {
  it("⚠ says an unreadable check is NOT the same as a healthy system", async () => {
    vi.mocked(api.listSignals).mockRejectedValue(new Error("connection refused"));
    render(<SignalsPanel />);
    await waitFor(() => expect(screen.getByText(/connection refused/)).toBeTruthy());
    expect(screen.getByText(/not the same as the system being/)).toBeTruthy();
  });

  it("keeps each signal's caveat as its tooltip, not as body text", async () => {
    vi.mocked(api.listSignals).mockResolvedValue({
      state: "ok",
      checkedAt: "2026-08-04T07:00:00.000Z",
      signals: [signal()],
    });
    const { container } = render(<SignalsPanel />);
    await waitFor(() => expect(screen.getByText(/3 scheduled flow/)).toBeTruthy());
    expect(container.textContent).not.toMatch(/the cron is never parsed/);
    expect(container.querySelector('[title*="the cron is never parsed"]')).toBeTruthy();
  });

  it('⚠ draws `unknown` as "no data", never as a pass', async () => {
    // `unknown` means the signal had nothing to go on. It ranks below `warn`
    // server-side so it cannot shout over a real warning; a UI that drew it as a
    // tick would undo that from the other end.
    vi.mocked(api.listSignals).mockResolvedValue({
      state: "unknown",
      checkedAt: "2026-08-04T07:00:00.000Z",
      signals: [signal({ state: "unknown", detail: "fewer than 3 runs to judge by" })],
    });
    const { container } = render(<SignalsPanel />);
    await waitFor(() => expect(screen.getAllByText(/no data/).length).toBeGreaterThan(0));
    expect(container.textContent).not.toMatch(/\bok\b/);
  });

  it("says the check plainly: no engineer's footer, no backticks", async () => {
    vi.mocked(api.listSignals).mockResolvedValue({
      state: "ok",
      checkedAt: "2026-08-04T07:00:00.000Z",
      signals: [signal({ name: "execution_slots", detail: "no workspace is holding an old `running` execution" })],
    });
    const { container } = render(<SignalsPanel />);
    await waitFor(() => expect(screen.getByText(/No runs are stuck/)).toBeTruthy());
    expect(container.textContent).not.toMatch(/pnpm|`/);
    expect(container.textContent).toMatch(/old running execution/);
  });
});
