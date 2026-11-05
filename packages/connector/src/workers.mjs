/**
 * Starting a worker (worker.mjs) for one job, and the store the workers share through it.
 *
 * A worker gets a stripped environment — no CONNECTOR_SECRET, no egress secret, nothing of the parent's — plus its own
 * proxy credentials, a heap cap and a wall-clock limit. It ends after one job.
 */
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunError } from "./run.mjs";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const HEAP_MB = Number(process.env.CONNECTOR_WORKER_HEAP_MB ?? 512);
/**
 * ⚠ A worker must not run as the parent's user: same uid can read `/proc/<parent>/environ`, which holds the egress
 * secret — and with it a piece could mint proxy credentials for any host. ⚠ Nor as ANOTHER WORKER's user: measured,
 * one uid for every worker let a run read a concurrent run's environment, i.e. its proxy credentials and so its hosts
 * (possibly another workspace's). So as root (SETUID/SETGID/KILL only) the parent starts each job as its own uid from
 * a pool, free again when the worker exits. Not root (local development): same uid as the parent, stated at start.
 */
const UID_BASE = Number(process.env.CONNECTOR_WORKER_UID_BASE ?? 30001);
const UID_POOL = Number(process.env.CONNECTOR_WORKER_UIDS ?? 1000);
export const SEPARATE_WORKER_USER = typeof process.getuid === "function" && process.getuid() === 0;
const uidsInUse = new Set();
let nextUid = 0;
function takeUid() {
  for (let i = 0; i < UID_POOL; i++) {
    const uid = UID_BASE + ((nextUid + i) % UID_POOL);
    if (!uidsInUse.has(uid)) {
      nextUid = (nextUid + i + 1) % UID_POOL;
      uidsInUse.add(uid);
      return uid;
    }
  }
  return null;
}
/**
 * A piece's store (ctx.store), one per `${workspace}:${piece}:${connection}` (`storeKey`, below) — one person's own
 * connection never shares a store with another's or with the workspace's (plugins 8.2). Kept in memory and written through to
 * `<dir>/<sha256(key)>.json`, so it survives a restart. Values are JSON, as the framework's store requires.
 * `persist: false` (describe) keeps a throwaway one.
 */
const stores = new Map();
let storeDir = null;
const MAX_STORE_BYTES = Number(process.env.CONNECTOR_MAX_STORE_BYTES ?? 1 << 20);
export function configureStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  storeDir = dir;
}
const storeFile = (key) => join(storeDir, `${createHash("sha256").update(key).digest("hex")}.json`);
function storeFor(key, persist) {
  if (stores.has(key)) return stores.get(key);
  let m = new Map();
  if (persist && storeDir && existsSync(storeFile(key))) {
    try {
      m = new Map(Object.entries(JSON.parse(readFileSync(storeFile(key), "utf8")).values ?? {}));
    } catch (e) {
      console.error(JSON.stringify({ event: "store_unreadable", key, why: e.message }));
    }
  }
  const entry = { m, persist: persist && !!storeDir, key };
  stores.set(key, entry);
  return entry;
}
function saveStore(entry) {
  if (!entry.persist) return;
  const f = storeFile(entry.key);
  if (!entry.m.size) return rmSync(f, { force: true });
  writeFileSync(`${f}.tmp`, JSON.stringify({ key: entry.key, values: Object.fromEntries(entry.m) }), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}
/** The store a run uses. ⚠ `-` only for a piece that needs no connection; never shared across connections. */
export const storeKey = (workspaceId, piece, connectionId) => `${workspaceId ?? "-"}:${piece}:${connectionId ?? "-"}`;
/** Forget one store, loaded or not — a removed connection's piece memory goes with it. */
export function forgetStore(key) {
  const e = stores.get(key);
  if (e) e.m.clear();
  stores.delete(key);
  if (storeDir) rmSync(storeFile(key), { force: true });
}
export function deleteStoresFor(prefixTest) {
  for (const [k, e] of stores) if (prefixTest(k)) { e.m.clear(); saveStore(e); stores.delete(k); }
}

export function runInWorker(job, { proxyUrl, timeoutMs, storeKey, persistStore = true }) {
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", NODE_NO_WARNINGS: "1" };
  if (proxyUrl) Object.assign(env, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "" });
  const uid = SEPARATE_WORKER_USER ? takeUid() : null;
  if (SEPARATE_WORKER_USER && uid === null) return Promise.reject(new RunError("action_failed", `all ${UID_POOL} worker users are busy; try again shortly`));
  const child = fork(WORKER, [], {
    env,
    execArgv: [`--max-old-space-size=${HEAP_MB}`],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    ...(uid !== null ? { uid, gid: uid } : {}),
  });
  // Released on exit, not on the answer: a uid is free only once nothing runs as it.
  child.once("exit", () => uidsInUse.delete(uid));
  const entry = storeFor(storeKey, persistStore);
  const store = entry.m;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const ok = finish(resolve);
    const fail = finish(reject);
    let started = false;
    child.once("spawn", () => (started = true));
    const timer = setTimeout(() => {
      // ⚠ kill() does not throw on EPERM; it returns false (and emits "error"). Then the process outlives its run —
      // measured without CAP_KILL: a worker of another uid cannot be stopped by a root with no capabilities.
      if (!child.kill("SIGKILL")) console.error(JSON.stringify({ event: "worker_kill_failed", pid: child.pid }));
      fail(new RunError("timeout", `the piece took longer than ${timeoutMs} ms and was stopped`));
    }, timeoutMs);

    child.on("message", (m) => {
      if (m?.type === "store") {
        let error = null;
        if (m.op === "put") {
          const size = Buffer.byteLength(JSON.stringify(m.value ?? null));
          if (size > MAX_STORE_BYTES) error = `a stored value may be at most ${MAX_STORE_BYTES} bytes`;
          else store.set(m.key, m.value);
        }
        if (m.op === "delete") store.delete(m.key);
        if (!error && m.op !== "get") saveStore(entry);
        child.send({ type: "store-reply", id: m.id, error, value: m.op === "get" ? (store.has(m.key) ? store.get(m.key) : null) : null });
      } else if (m?.type === "done") {
        if (m.ok) ok(m.value);
        else fail(new RunError(m.kind, m.message, m.extra ?? {}));
      }
    });
    child.on("exit", (code, signal) => {
      fail(new RunError("action_failed", `the piece's process ended unexpectedly (${signal ?? `exit ${code}`})`));
    });
    child.on("error", (e) => {
      if (!started) fail(new RunError("action_failed", `could not start the piece's process: ${e.message}`));
      else console.error(JSON.stringify({ event: "worker_error", pid: child.pid, why: e.message }));
    });
    child.send({ type: "job", ...job });
  });
}
