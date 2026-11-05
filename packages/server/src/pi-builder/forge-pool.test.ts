import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeBusyError, ForgePool, type ForgeLike } from "./forge-pool.js";

class FakeForge implements ForgeLike {
  alive = true;
  busy = false;
  killed = 0;
  private exits: Array<() => void> = [];
  kill() {
    this.killed++;
    this.alive = false;
    for (const f of this.exits.splice(0)) f();
  }
  onExit(fn: () => void) {
    this.exits.push(fn);
  }
}

const IDLE = 5 * 60_000;
const LEAVE = 30_000;

function pool(opts: { maxLive?: number; maxPerWorkspace?: number } = {}) {
  const spawned: Record<string, FakeForge[]> = {};
  const p = new ForgePool<FakeForge>({
    spawn: (_ws, sid) => {
      const f = new FakeForge();
      (spawned[sid] ??= []).push(f);
      return f;
    },
    maxLive: opts.maxLive ?? 10,
    maxPerWorkspace: opts.maxPerWorkspace ?? 10,
    idleMs: IDLE,
    leaveGraceMs: LEAVE,
  });
  return { p, spawned };
}

describe("Forge's live processes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one process per conversation and reuses it between turns", () => {
    const { p, spawned } = pool();
    const a = p.acquire("ws", "s1");
    p.turnStarted("s1");
    p.turnEnded("s1");
    expect(p.acquire("ws", "s1")).toBe(a);
    expect(spawned.s1).toHaveLength(1);
  });

  it("exits after 5 minutes without a turn, and the next message starts a new one", () => {
    const { p, spawned } = pool();
    p.connect("s1");
    p.acquire("ws", "s1");
    vi.advanceTimersByTime(IDLE - 1);
    expect(p.isLive("s1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(p.isLive("s1")).toBe(false);
    expect(spawned.s1![0]!.killed).toBe(1);
    p.acquire("ws", "s1");
    expect(spawned.s1).toHaveLength(2);
  });

  it("a turn resets the idle clock", () => {
    const { p } = pool();
    p.connect("s1");
    p.acquire("ws", "s1");
    vi.advanceTimersByTime(IDLE - 1000);
    p.turnStarted("s1");
    p.turnEnded("s1");
    vi.advanceTimersByTime(IDLE - 1000);
    expect(p.isLive("s1")).toBe(true);
  });

  it("exits 30 seconds after the last page closes — and coming back within them keeps it", () => {
    const { p } = pool();
    p.connect("s1");
    p.acquire("ws", "s1");
    p.disconnect("s1");
    vi.advanceTimersByTime(LEAVE - 1);
    p.connect("s1"); // reopened in time
    vi.advanceTimersByTime(LEAVE * 2);
    expect(p.isLive("s1")).toBe(true);
    p.disconnect("s1");
    vi.advanceTimersByTime(LEAVE);
    expect(p.isLive("s1")).toBe(false);
  });

  it("waits for every tab: one closing while another is open does nothing", () => {
    const { p } = pool();
    p.connect("s1");
    p.connect("s1");
    p.acquire("ws", "s1");
    p.disconnect("s1");
    vi.advanceTimersByTime(LEAVE * 2);
    expect(p.isLive("s1")).toBe(true);
  });

  it("lets a turn running when the page closes finish, then starts the 30 seconds", () => {
    const { p, spawned } = pool();
    p.connect("s1");
    const f = p.acquire("ws", "s1");
    p.turnStarted("s1");
    f.busy = true;
    p.disconnect("s1");
    vi.advanceTimersByTime(LEAVE * 4);
    expect(p.isLive("s1")).toBe(true);
    f.busy = false;
    p.turnEnded("s1");
    vi.advanceTimersByTime(LEAVE);
    expect(p.isLive("s1")).toBe(false);
    expect(spawned.s1![0]!.killed).toBe(1);
  });

  it("when full, ends the longest-idle process to make room", () => {
    const { p, spawned } = pool({ maxLive: 2 });
    p.acquire("ws", "old");
    vi.advanceTimersByTime(1000);
    p.acquire("ws", "newer");
    p.acquire("ws", "third");
    expect(spawned.old![0]!.killed).toBe(1);
    expect(p.isLive("newer")).toBe(true);
    expect(p.isLive("third")).toBe(true);
  });

  it("refuses only when every live process is mid-turn — per workspace and overall", () => {
    const { p } = pool({ maxLive: 3, maxPerWorkspace: 2 });
    p.acquire("ws", "a").busy = true;
    p.acquire("ws", "b").busy = true;
    expect(() => p.acquire("ws", "c")).toThrow(ForgeBusyError);
    p.acquire("other", "d").busy = true;
    expect(() => p.acquire("third-ws", "e")).toThrow(ForgeBusyError);
  });

  it("warming a chat on open never throws when full — the first message starts it instead", () => {
    const { p } = pool({ maxLive: 1 });
    p.acquire("ws", "a").busy = true;
    expect(() => p.warm("ws", "b")).not.toThrow();
    expect(p.isLive("b")).toBe(false);
  });

  it("forgets a process that exits on its own, so the next acquire starts a fresh one", () => {
    const { p, spawned } = pool();
    p.acquire("ws", "s1").kill();
    expect(p.isLive("s1")).toBe(false);
    p.acquire("ws", "s1");
    expect(spawned.s1).toHaveLength(2);
  });
});
