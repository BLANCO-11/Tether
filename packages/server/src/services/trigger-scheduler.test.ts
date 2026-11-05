import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { _tick } from "./trigger-scheduler.js";
import { lookup } from "node:dns/promises";

const mockedLookup = vi.mocked(lookup);

/**
 * FR-008/User Story 3 (research.md Decision 2) — a poll trigger's `config.url`
 * is operator/tenant-supplied and must never be dialed if it resolves to a
 * private/loopback/link-local address. `guardedFetch(STRICT)` replaces the
 * bare `fetch` at this call site only.
 */
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

describe("trigger-scheduler poll pass — egress policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never dials a poll trigger whose url resolves to a private/loopback/link-local address", async () => {
    vi.spyOn(triggerRepo, "listEnabledByType").mockResolvedValue([
      {
        id: "t1",
        name: "evil-poll",
        config: { url: "http://169.254.169.254/latest/meta-data", intervalSeconds: 1 },
      } as never,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await _tick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dials a poll trigger whose url resolves to a public address, exactly as before", async () => {
    vi.spyOn(triggerRepo, "listEnabledByType").mockResolvedValue([
      {
        id: "t2",
        name: "normal-poll",
        config: { url: "https://example.com/webhook", intervalSeconds: 1 },
      } as never,
    ]);
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("body"));

    await _tick();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});

/**
 * ── Why the poll pass is bounded ────────────────────────────────────────────
 *
 * The loop is sequential and each dial waits up to 8s, and the
 * approval-staleness sweep runs after it in the SAME tick. So enough due poll
 * triggers do not merely slow polling down — they starve the sweep, which is one
 * of the four silent-failure signals precisely because its silence looks like
 * success (D-66). Unbounded work in front of a watchdog is what is bounded.
 */
describe("trigger-scheduler poll pass — the per-tick bound", () => {
  /**
   * ⚠ Unique ids PER TEST, and this is not cosmetic. `lastPollAt` is module-level
   * state that outlives a test case, so reusing ids means test 2 inherits test
   * 1's stamps, sees only a handful of due triggers, and passes or fails for a
   * reason that has nothing to do with the cap. That is exactly how a bounded
   * loop gets a test suite that cannot see the bound.
   */
  const many = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${tag}-p${i}`,
      name: `poll-${tag}-${i}`,
      config: { url: `https://example.com/${tag}/${i}`, intervalSeconds: 1 },
    })) as never[];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  });

  it("dials at most `pollTriggersPerTick` URLs in one tick", async () => {
    const { config } = await import("../config/index.js");
    const cap = config.pollTriggersPerTick;
    vi.spyOn(triggerRepo, "listEnabledByType").mockResolvedValue(many(cap + 5, "cap"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A fresh Response per call: one shared instance has its body consumed by the
    // first `res.text()`, and every later call then throws "Body is already used"
    // — which would look like the cap working while nothing was polled at all.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("body"));

    await _tick();

    expect(fetchSpy).toHaveBeenCalledTimes(cap);
    warn.mockRestore();
  });

  /**
   * ⚠ NEVER A SILENT CAP. A tick that quietly dropped work reads exactly like a
   * tick with nothing to do, and the report is "my trigger sometimes doesn't
   * fire" with nothing in the log to point at.
   */
  it("says how much it did not poll, and names the knob", async () => {
    const { config } = await import("../config/index.js");
    vi.spyOn(triggerRepo, "listEnabledByType").mockResolvedValue(
      many(config.pollTriggersPerTick + 3, "log"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("body"));

    await _tick();

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("poll triggers due");
    expect(logged).toContain("POLL_TRIGGERS_PER_TICK");
    warn.mockRestore();
  });

  /**
   * ⚠ THE CONTROL, and the fairness property in one. A skipped trigger must stay
   * DUE — `lastPollAt` is stamped only for the ones actually polled — or the cap
   * would starve the tail permanently instead of deferring it by one tick.
   */
  it("CONTROL — a skipped trigger is polled on the next tick", async () => {
    const { config } = await import("../config/index.js");
    const cap = config.pollTriggersPerTick;
    vi.spyOn(triggerRepo, "listEnabledByType").mockResolvedValue(many(cap + 2, "fair"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("body"));

    await _tick();
    const firstPass = fetchSpy.mock.calls.map((c) => String(c[0]));
    await _tick();
    const secondPass = fetchSpy.mock.calls.map((c) => String(c[0])).slice(firstPass.length);

    // The two it could not reach first time are the ones it starts with next time.
    expect(secondPass).toContain(`https://example.com/fair/${cap}`);
    expect(secondPass).toContain(`https://example.com/fair/${cap + 1}`);
    warn.mockRestore();
  });
});
