import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { config } from "../config/index.js";
import { gatewayHeaders } from "../services/llm-gateway-headers.js";
import { lastModelConnection } from "../services/model-connection.js";
import { resolvePiBin, TEMPLATE_ROOT } from "./paths.js";
import { sandboxDir, sessionRoot } from "./sandbox-fs.js";

export type PiJsonHandler = (ev: Record<string, unknown>) => void;

/**
 * How a turn ended. `exited` = the process died mid-turn; `timeout` = it ran past the turn limit and was killed;
 * `failed` = the model call failed and Pi's own retries ran out (the process is still alive).
 */
export type TurnEnd = {
  ended: "done" | "exited" | "timeout" | "aborted" | "failed" | "refused";
  exitCode: number | null;
  stderr: string;
  /** `refused`: why the message was not taken (the host's own words, e.g. the conversation's files are too big). */
  reason?: string;
};

export function piModel(): string {
  return (process.env.PI_MODEL || config.inference.model || "").replace(/^.*\//, "");
}

/**
 * Env that makes pi send OpenCode's session headers. pi 0.74.2 predates its own OpenCode fix and its `litellm` provider
 * cannot send custom headers, so for OpenCode connections the tether-gateway.js extension registers the gateway as a
 * provider with them (PI_PROVIDER switches to it). The session key is the Forge session id: stable for the whole
 * conversation and across process restarts. `{}` for every other gateway, which stays on litellm.
 */
export function forgeOpenCodeEnv(sessionId: string): Record<string, string> {
  const c = lastModelConnection();
  const baseUrl = (c?.baseUrl || config.inference.baseUrl).replace(/\/+$/, "");
  const providerId = c?.baseUrl ? c.providerId : config.inference.provider;
  const headers = gatewayHeaders({ providerId, baseUrl }, sessionId);
  if (Object.keys(headers).length === 0) return {};
  return { PI_PROVIDER: "tether-gateway", PI_GATEWAY_BASE_URL: baseUrl, PI_GATEWAY_HEADERS: JSON.stringify(headers) };
}

/**
 * The one model connection's gateway (2026-11-04), as last resolved. pi-builder/service.ts resolves it
 * (resolveGenerationProvider) when a chat opens, every turn and on a model change, all before a process is spawned.
 * The environment is the fallback.
 */
export function forgeGateway(): { LITELLM_API_KEY: string; LITELLM_BASE_URL: string } {
  const c = lastModelConnection();
  return {
    LITELLM_API_KEY: c?.apiKey || config.inference.apiKey,
    LITELLM_BASE_URL: (c?.baseUrl || config.inference.baseUrl).replace(/\/v1\/?$/, ""),
  };
}

/** The conversation Forge resumes from — beside the sandbox, not in it, so the agent's file tools are not pointed at it. */
export function forgeSessionFile(workspaceId: string, sessionId: string): string {
  return join(sessionRoot(workspaceId, sessionId), "forge-session.jsonl");
}

/**
 * A stored Forge conversation, moved to a new sandbox (2026-10-12). Pi's session file opens with a header line naming
 * the working directory it was started in, and Pi refuses to resume when that directory no longer exists: "Stored
 * session working directory does not exist". A reopened workflow always gets a NEW sandbox, and the old one is gone
 * (the 30-minute sweep, and since 2.26.18 every restart, delete it), so every reopen after either failed with
 * "Forge stopped unexpectedly" and Try again failed the same way.
 *
 * The header's `cwd` is set to the new sandbox, and every mention of the old sandbox's path in the history becomes
 * the new one, so a file Forge read before is named where it now is. An unreadable header is left alone: Pi then
 * says what is wrong, rather than this guessing.
 */
export function rebaseForgeSession(text: string, cwd: string): string {
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  let header: { type?: string; cwd?: unknown };
  try {
    header = JSON.parse(first) as { type?: string; cwd?: unknown };
  } catch {
    return text;
  }
  if (header.type !== "session" || typeof header.cwd !== "string" || !header.cwd) return text;
  const old = header.cwd;
  const rest = nl === -1 ? "" : text.slice(nl);
  const moved = old === cwd ? rest : rest.split(JSON.stringify(old).slice(1, -1)).join(JSON.stringify(cwd).slice(1, -1));
  return JSON.stringify({ ...header, cwd }) + moved;
}

/** Grace between asking a process to stop and forcing it. */
const KILL_GRACE_MS = 5_000;
/**
 * How long after `agent_end` a turn waits for Pi to start an automatic retry (a transient model error) or an
 * overflow-compaction retry before treating the turn as over. Without it a turn whose model call failed and was being
 * retried was taken as finished mid-build, and the next prompt reached a Pi that was still working (measured
 * 2026-10-10: a reply that was a tool result, then our own prompt recorded as the reply).
 */
const SETTLE_MS = 1_500;

/**
 * What Forge's process may see of the server's environment (2026-10-12): the plain settings a shell needs, the TLS
 * trust and proxy settings a call to the AI service may need, and its own `PI_*`/`LITELLM_*` settings. Nothing else:
 * it used to inherit everything, so a command Forge ran could print the API key, the database address, the
 * encryption key, the identity-signing secret and the mail credentials. Allowlisted rather than blocklisted, so a
 * secret added later is hidden without anyone remembering to hide it. Forge's document tools (python3) come first on
 * its PATH when the image has them (`FORGE_PYTHON_BIN`).
 *
 * Used only when Forge runs as a child of this server (development, tests). In a deployment Forge runs in the forge
 * container (FORGE_HOST), which receives the AI settings alone.
 */
export function forgeEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const SHELL = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR", "NODE_VERSION"];
  const TRUST = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT"];
  const PROXY = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (SHELL.includes(k) || TRUST.includes(k) || PROXY.includes(k) || k.startsWith("PI_") || k.startsWith("LITELLM_")) out[k] = v;
  }
  if (from.FORGE_PYTHON_BIN) out.PATH = `${from.FORGE_PYTHON_BIN}:${out.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  return out;
}

/**
 * ONE live Forge (Pi in `--mode rpc`) for one conversation (2026-10-10). It used to be one `pi --print --no-session`
 * per message: every message started cold and forgot the conversation. Now the process stays while the chat is in
 * use and keeps the conversation in `--session <file>`, so a process that has exited resumes with its history.
 *
 * Spawned DETACHED so it leads its own process group: a stop kills the group — Pi and every command it started —
 * SIGTERM first, SIGKILL after a grace. Killing Pi alone left its children to the server (PID 1), which never
 * reaped them.
 */
export class ForgeProcess {
  /** How lines reach Pi's stdin and how it is stopped: a local child, or a process in the forge container. */
  private io: { write: (line: string) => void; stop: (force: boolean) => void };
  private buf = "";
  private stderrTail = "";
  private listener: PiJsonHandler | null = null;
  private turnDone: ((end: TurnEnd) => void) | null = null;
  private exited = false;
  private exitCode: number | null = null;
  private onExitFns: Array<() => void> = [];
  /** Commands waiting for their `response` line, by the id they were sent with. */
  private pending = new Map<string, (ev: Record<string, unknown>) => void>();
  private nextId = 0;

  /** `effort`: the `reasoning_effort` this process runs with (thinking.ts) — fixed for its life; a change restarts it. `model`: likewise (model-choice.ts). */
  readonly model: string;
  constructor(opts: { workspaceId: string; sessionId: string; effort?: string; model?: string }) {
    const root = sessionRoot(opts.workspaceId, opts.sessionId);
    const sbx = sandboxDir(opts.workspaceId, opts.sessionId);
    this.model = opts.model ? opts.model.replace(/^.*\//, "") : piModel();
    const model = this.model;
    // The extensions come from the server's template every time (the conversation's copies are Forge's to change).
    const ext = join(root, "pi-extensions");
    mkdirSync(ext, { recursive: true });
    for (const f of ["luna-tools-compat.js", "image-budget.js", "bash-timeout.js", "tether-gateway.js"]) copyFileSync(join(TEMPLATE_ROOT, "pi-extensions", f), join(ext, f));
    const ai = {
      ...forgeGateway(),
      // Offline needs ~/.pi/agent/litellm-models.json keyed to the API-key fingerprint; a fresh container has none.
      LITELLM_OFFLINE: process.env.LITELLM_OFFLINE ?? "0",
      PI_PROVIDER: process.env.PI_PROVIDER ?? "litellm",
      PI_MODEL: model,
      // Read by luna-tools-compat.js, which sets the request's reasoning_effort from it. `PI_` so the forge host passes it on.
      PI_FORGE_REASONING_EFFORT: opts.effort ?? "none",
      ...forgeOpenCodeEnv(opts.sessionId),
    };
    const args = [
      "--mode",
      "rpc",
      "--session",
      forgeSessionFile(opts.workspaceId, opts.sessionId),
      "--thinking",
      "off",
      "-e",
      join(ext, "luna-tools-compat.js"),
      "-e",
      join(ext, "image-budget.js"),
      "-e",
      join(ext, "bash-timeout.js"),
      "-e",
      join(ext, "tether-gateway.js"),
      "--provider",
      ai.PI_PROVIDER,
      "--model",
      model,
      "--append-system-prompt",
      join(sbx, "SYSTEM.md"),
    ];
    if (config.forge.host) this.io = this.remote(opts, args, ai);
    else this.io = this.local(sbx, args, { ...forgeEnv(process.env), ...ai });
  }

  /**
   * Forge in the `forge` container (forge-host): one connection per process. The host starts Pi as the conversation's
   * own Linux user; this end only relays lines. The connection closing stops the process there.
   */
  private remote(opts: { workspaceId: string; sessionId: string }, args: string[], env: Record<string, string>) {
    const [host, port] = config.forge.host!.split(":");
    const sock = connect(Number(port || 4100), host!);
    sock.setEncoding("utf8");
    sock.write(`${JSON.stringify({ secret: config.forge.hostSecret, workspaceId: opts.workspaceId, sessionId: opts.sessionId, args, env })}\n`);
    sock.on("data", (chunk: string) => this.onStdout(chunk));
    sock.on("error", (e) => {
      this.stderrTail = `${this.stderrTail}\n${e.message}`.slice(-2000);
    });
    sock.on("close", () => this.markExited(this.exitCode));
    return {
      write: (line: string) => {
        if (!sock.destroyed) sock.write(line);
      },
      stop: (force: boolean) => {
        if (force) sock.destroy();
        else if (!sock.destroyed) sock.write(`${JSON.stringify({ type: "__forge_kill" })}\n`);
      },
    };
  }

  /** Forge as a child of this server — for development and tests without the forge container. */
  private local(sbx: string, args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(resolvePiBin(), args, { cwd: sbx, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdout?.on("data", (b: Buffer) => this.onStdout(b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString("utf8")).slice(-2000);
    });
    child.stdin?.on("error", () => undefined); // a write to a process that just died must not crash the server
    child.on("error", () => this.markExited(null));
    child.on("close", (code) => this.markExited(code));
    return {
      write: (line: string) => {
        child.stdin?.write(line);
      },
      stop: (force: boolean) => {
        if (child.pid == null) return;
        const pid = child.pid;
        const sig: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
        try {
          process.kill(-pid, sig); // the whole group
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      },
    };
  }

  get alive(): boolean {
    return !this.exited;
  }

  get busy(): boolean {
    return this.turnDone !== null;
  }

  onExit(fn: () => void): void {
    if (this.exited) fn();
    else this.onExitFns.push(fn);
  }

  /** A message for the turn that is running (2026-11-03): Pi gives it to the agent after its current step. False when no turn is running. */
  steer(message: string): boolean {
    if (this.exited || !this.turnDone) return false;
    this.send({ type: "steer", message });
    return true;
  }

  /** One turn: resolves when Pi reports `agent_end`, the process dies, the time limit passes, or `signal` aborts. */
  turn(message: string, opts: { onEvent: PiJsonHandler; signal?: AbortSignal; timeoutMs: number }): Promise<TurnEnd> {
    if (this.exited) return Promise.resolve({ ended: "exited", exitCode: this.exitCode, stderr: this.stderrTail });
    if (this.turnDone) throw new Error("a turn is already running on this Forge");
    return new Promise<TurnEnd>((resolve) => {
      let settled = false;
      const finish = (ended: TurnEnd["ended"], reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.listener = null;
        this.turnDone = null;
        resolve({ ended, exitCode: this.exitCode, stderr: this.stderrTail, ...(reason ? { reason } : {}) });
      };
      // A hung turn is not idle, so no idle timer would ever end it: the turn has its own limit, and past it the
      // process is killed — a Forge stuck mid-tool is not one to send the next message to.
      const timer = setTimeout(() => {
        this.kill();
        finish("timeout");
      }, opts.timeoutMs);
      const onAbort = () => {
        // Ask Pi to stop the turn; if it has not within the grace, kill it.
        this.send({ type: "abort" });
        setTimeout(() => {
          if (!settled) {
            this.kill();
            finish("aborted");
          }
        }, KILL_GRACE_MS);
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      let settle: ReturnType<typeof setTimeout> | null = null;
      let retrying = false;
      const cancelSettle = () => {
        if (settle) clearTimeout(settle);
        settle = null;
      };
      this.listener = (ev) => {
        opts.onEvent(ev);
        if (ev.type === "auto_retry_start" || (ev.type === "compaction_end" && ev.willRetry === true)) {
          retrying = true; // Pi is going again: the agent_end that comes before or after this is not the end
          cancelSettle();
        }
        if (ev.type === "auto_retry_end") {
          retrying = false;
          // Retries ran out: Pi sends nothing more, so no agent_end would ever end the turn — it sat "drafting" until
          // the turn limit (measured 2026-10-11: four "403 terminated" replies, then silence). End it as failed.
          if (ev.success === false) {
            cancelSettle();
            settle = setTimeout(() => finish("failed"), SETTLE_MS);
          }
        }
        if (ev.type === "agent_end") {
          if (opts.signal?.aborted) return finish("aborted");
          cancelSettle();
          if (!retrying) settle = setTimeout(() => finish("done"), SETTLE_MS);
        }
        if (ev.type === "agent_start" || ev.type === "turn_start") cancelSettle();
        if (ev.type === "response" && ev.command === "prompt" && ev.success === false) {
          // The message was not taken. Its reason is the person's to read ("this conversation's files are over 300 MB"):
          // ending it as "exited" said "Forge stopped unexpectedly" and dropped why (2026-10-13).
          cancelSettle();
          finish("refused", typeof ev.error === "string" && ev.error.trim() ? ev.error.trim() : undefined);
        }
      };
      this.turnDone = (end) => finish(end.ended);
      this.send({ type: "prompt", message });
    });
  }

  /** Stop the process group: SIGTERM, then SIGKILL if anything is still there after the grace. */
  kill(): void {
    if (this.exited) return;
    this.io.stop(false);
    setTimeout(() => {
      if (!this.exited) this.io.stop(true);
    }, KILL_GRACE_MS).unref();
  }

  /**
   * A command that answers (`get_session_stats`, `compact`): resolves with its `response` line, or rejects when the
   * process exits or `timeoutMs` passes. Pi answers these between turns as well as during one.
   */
  request<T = unknown>(cmd: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.exited) return Promise.reject(new Error("Forge is not running"));
    const id = `req-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${String(cmd.type)} did not answer in time`));
      }, timeoutMs);
      this.pending.set(id, (ev) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (ev.success === false) reject(new Error(String(ev.error ?? `${String(cmd.type)} failed`)));
        else resolve(ev.data as T);
      });
      this.send({ ...cmd, id });
    });
  }

  private send(cmd: Record<string, unknown>): void {
    if (this.exited) return;
    this.io.write(`${JSON.stringify(cmd)}\n`);
  }

  // Strict JSONL: split on \n only (Pi's own rule — readline also splits on U+2028/9, which are valid in JSON).
  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON noise
      }
      if (ev.type === "__forge_exit") {
        // The forge container's word that the process ended (remote only): its exit code and the end of its stderr.
        this.stderrTail = String(ev.stderr ?? "").slice(-2000);
        this.markExited(typeof ev.code === "number" ? ev.code : null);
        continue;
      }
      if (ev.type === "response" && typeof ev.id === "string" && this.pending.has(ev.id)) {
        this.pending.get(ev.id)!(ev);
        continue;
      }
      this.listener?.(ev);
    }
  }

  private markExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.turnDone?.({ ended: "exited", exitCode: code, stderr: this.stderrTail });
    for (const answer of [...this.pending.values()]) answer({ success: false, error: "Forge stopped" });
    for (const fn of this.onExitFns.splice(0)) fn();
  }
}
