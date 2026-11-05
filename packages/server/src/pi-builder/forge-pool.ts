/**
 * Which Forge processes are alive, and when each one goes (2026-10-10).
 *
 * - A chat that is OPEN gets a live Forge (warmed when the chat opens).
 * - 5 minutes with no turn → the process exits. The next message starts it again, and it resumes the conversation
 *   from its session file — nothing is re-run.
 * - The page closed (no connection left, any tab): after 30 seconds the process exits. Coming back within 30
 *   seconds keeps it. A turn still running when the page closes is allowed to FINISH (its work is saved); the 30
 *   seconds start when it ends.
 * - A cap on live processes, per deployment and per workspace. When full, the longest-idle process exits to make
 *   room (it is cheap to resume); a new one is refused only when every live process is mid-turn.
 *
 * Processes only — the conversation itself (server memory, sandbox, session file) belongs to the service.
 */

export type ForgeLike = { readonly alive: boolean; readonly busy: boolean; kill(): void; onExit(fn: () => void): void };

type Timer = ReturnType<typeof setTimeout>;

export type ForgePoolOpts<P extends ForgeLike> = {
  spawn: (workspaceId: string, sessionId: string) => P;
  maxLive: number;
  maxPerWorkspace: number;
  idleMs: number;
  leaveGraceMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
};

type Entry<P extends ForgeLike> = { proc: P; workspaceId: string; lastUsed: number; idle: Timer | null };

export class ForgeBusyError extends Error {
  statusCode = 429;
  constructor(message: string) {
    super(message);
  }
}

export class ForgePool<P extends ForgeLike = ForgeLike> {
  private live = new Map<string, Entry<P>>();
  private conns = new Map<string, number>();
  private leave = new Map<string, Timer>();
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => Timer;
  private clearTimer: (t: Timer) => void;

  constructor(private opts: ForgePoolOpts<P>) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? clearTimeout;
  }

  /** The live process for a conversation, or a new one. Refuses (429) only when no room can be made. */
  acquire(workspaceId: string, sessionId: string): P {
    const have = this.live.get(sessionId);
    if (have?.proc.alive) {
      have.lastUsed = this.now();
      return have.proc;
    }
    if (have) this.forget(sessionId);
    this.makeRoom(workspaceId);
    const proc = this.opts.spawn(workspaceId, sessionId);
    const entry: Entry<P> = { proc, workspaceId, lastUsed: this.now(), idle: null };
    this.live.set(sessionId, entry);
    proc.onExit(() => {
      if (this.live.get(sessionId) === entry) this.forget(sessionId);
    });
    this.armIdle(sessionId);
    return proc;
  }

  /** The live process for a conversation, if there is one — never starts one. */
  peek(sessionId: string): P | null {
    const e = this.live.get(sessionId);
    return e?.proc.alive ? e.proc : null;
  }

  /** Warm a process when a chat opens — best effort: a full pool means the first message starts it instead. */
  warm(workspaceId: string, sessionId: string): void {
    try {
      this.acquire(workspaceId, sessionId);
    } catch (e) {
      if (!(e instanceof ForgeBusyError)) throw e;
    }
  }

  turnStarted(sessionId: string): void {
    const e = this.live.get(sessionId);
    if (!e) return;
    e.lastUsed = this.now();
    if (e.idle) this.clearTimer(e.idle);
    e.idle = null;
    this.cancelLeave(sessionId);
  }

  turnEnded(sessionId: string): void {
    const e = this.live.get(sessionId);
    if (!e) return;
    e.lastUsed = this.now();
    this.armIdle(sessionId);
    if ((this.conns.get(sessionId) ?? 0) === 0) this.armLeave(sessionId);
  }

  connect(sessionId: string): void {
    this.conns.set(sessionId, (this.conns.get(sessionId) ?? 0) + 1);
    this.cancelLeave(sessionId);
  }

  disconnect(sessionId: string): void {
    const n = Math.max(0, (this.conns.get(sessionId) ?? 0) - 1);
    if (n === 0) this.conns.delete(sessionId);
    else this.conns.set(sessionId, n);
    const e = this.live.get(sessionId);
    if (n === 0 && e && !e.proc.busy) this.armLeave(sessionId);
  }

  connections(sessionId: string): number {
    return this.conns.get(sessionId) ?? 0;
  }

  /** Stop a conversation's process now (session closed, flow deleted, server stopping). */
  release(sessionId: string): void {
    const e = this.live.get(sessionId);
    this.forget(sessionId);
    e?.proc.kill();
  }

  releaseAll(): void {
    for (const id of [...this.live.keys()]) this.release(id);
  }

  isLive(sessionId: string): boolean {
    return !!this.live.get(sessionId)?.proc.alive;
  }

  stats(): { live: number; busy: number; byWorkspace: Record<string, number> } {
    const byWorkspace: Record<string, number> = {};
    let busy = 0;
    for (const e of this.live.values()) {
      byWorkspace[e.workspaceId] = (byWorkspace[e.workspaceId] ?? 0) + 1;
      if (e.proc.busy) busy++;
    }
    return { live: this.live.size, busy, byWorkspace };
  }

  private makeRoom(workspaceId: string): void {
    const inWs = () => [...this.live.entries()].filter(([, e]) => e.workspaceId === workspaceId);
    while (inWs().length >= this.opts.maxPerWorkspace) {
      if (!this.evictIdlest(inWs())) {
        throw new ForgeBusyError(
          `Forge is busy in this workspace — ${this.opts.maxPerWorkspace} conversations are building right now. Try again when one finishes.`,
        );
      }
    }
    while (this.live.size >= this.opts.maxLive) {
      if (!this.evictIdlest([...this.live.entries()])) {
        throw new ForgeBusyError(`Forge is at capacity — ${this.opts.maxLive} conversations are building right now. Try again shortly.`);
      }
    }
  }

  /** Stop the longest-idle process that is not mid-turn. False when every candidate is busy. */
  private evictIdlest(candidates: Array<[string, Entry<P>]>): boolean {
    const idle = candidates.filter(([, e]) => !e.proc.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (!idle.length) return false;
    this.release(idle[0]![0]);
    return true;
  }

  private armIdle(sessionId: string): void {
    const e = this.live.get(sessionId);
    if (!e) return;
    if (e.idle) this.clearTimer(e.idle);
    e.idle = this.setTimer(() => {
      const cur = this.live.get(sessionId);
      if (cur === e && !e.proc.busy) this.release(sessionId);
    }, this.opts.idleMs);
  }

  private armLeave(sessionId: string): void {
    this.cancelLeave(sessionId);
    this.leave.set(
      sessionId,
      this.setTimer(() => {
        this.leave.delete(sessionId);
        const e = this.live.get(sessionId);
        if (e && !e.proc.busy && (this.conns.get(sessionId) ?? 0) === 0) this.release(sessionId);
      }, this.opts.leaveGraceMs),
    );
  }

  private cancelLeave(sessionId: string): void {
    const t = this.leave.get(sessionId);
    if (t) this.clearTimer(t);
    this.leave.delete(sessionId);
  }

  private forget(sessionId: string): void {
    const e = this.live.get(sessionId);
    if (e?.idle) this.clearTimer(e.idle);
    this.live.delete(sessionId);
    this.cancelLeave(sessionId);
  }
}
