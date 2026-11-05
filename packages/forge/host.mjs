/**
 * forge-host — runs Forge (the `pi` agent) for the API server, in its own container (2026-10-13).
 *
 * Why: Forge used to be a child of the API server, in the container holding every secret and a route to Postgres,
 * and its bash could read other chats' folders. Here each conversation's Forge runs as its OWN Linux user, in its
 * folder (0700), with /proc hidden (entrypoint.sh) and resource limits, on a network whose only way out is the egress
 * proxy (the AI gateway, nothing else). This container holds no secret of its own: the AI key arrives per process,
 * from the server, and only that process gets it.
 *
 * Protocol, one TCP connection per Forge process (no dependencies, JSON lines):
 *   server → host, first line: {"secret", "workspaceId", "sessionId", "args": [...], "env": {...}}
 *   server → host, then:       pi's RPC commands, one per line (written to pi's stdin); {"type":"__forge_kill"} stops it
 *   host → server:             pi's stdout lines, then {"type":"__forge_exit","code":n,"stderr":"…"} and close
 * The connection closing stops the process, so a server restart leaves nothing running here.
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve, sep } from "node:path";

const PORT = Number(process.env.FORGE_HOST_PORT ?? 4100);
const SECRET = process.env.FORGE_HOST_SECRET ?? "";
const SANDBOXES_ROOT = resolve(process.env.FORGE_SANDBOXES_ROOT ?? "/repo/packages/server/.pi-sandboxes");
const PI_BIN = process.env.PI_BIN ?? "/usr/local/bin/pi";
const AGENT_TEMPLATE = "/opt/pi-agent";
const UID_LOCKS = "/var/lib/forge-uids";
const UID_FIRST = 30000;
const UID_LAST = 59999;
/** A conversation's folder past this is refused its next message: Forge's files are documents, not a disk. */
const MAX_FOLDER_BYTES = Number(process.env.FORGE_MAX_FOLDER_BYTES ?? 300 * 1024 * 1024);
const EGRESS = process.env.FORGE_EGRESS_PROXY ?? "http://forge-egress:3128";
const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 3000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * Memory groups (entrypoint.sh): each conversation's processes live in work/conv-<uid>, under their own memory cap,
 * and are killed together when they pass it — the conversation dies, not the container with every other one in it.
 * An address-space rlimit cannot do this: node reserves far more than it uses.
 */
const CGROUP_WORK = "/sys/fs/cgroup/work";
const CONVERSATION_MEMORY = Number(process.env.FORGE_CONVERSATION_MEMORY_BYTES ?? 1024 * 1024 * 1024);
const GROUPS = existsSync(join(CGROUP_WORK, "cgroup.procs"));

const log = (event, detail) => console.log(JSON.stringify({ svc: "forge-host", event, ...detail }));

if (!SECRET || SECRET.length < 16) {
  log("refusing_to_start", { why: "FORGE_HOST_SECRET is empty or shorter than 16 characters" });
  process.exit(3);
}

function sameSecret(given) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A uid no live Forge holds: the lock is a directory, and mkdir is atomic. */
function claimUid() {
  mkdirSync(UID_LOCKS, { recursive: true, mode: 0o700 });
  const span = UID_LAST - UID_FIRST + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const uid = UID_FIRST + ((start + i) % span);
    try {
      mkdirSync(join(UID_LOCKS, String(uid)), { mode: 0o700 });
      return uid;
    } catch {
      /* held */
    }
  }
  throw new Error("no free Forge uid");
}

function releaseUid(uid) {
  try {
    rmdirSync(join(UID_LOCKS, String(uid)));
  } catch {
    /* already gone */
  }
}

const groupOf = (uid) => join(CGROUP_WORK, `conv-${uid}`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Kill whatever is left in a conversation's group and remove it. rmdir succeeds once the last process is gone. */
function removeGroup(dir) {
  if (!existsSync(dir)) return;
  try {
    writeFileSync(join(dir, "cgroup.kill"), "1");
  } catch {
    /* empty, or a kernel without cgroup.kill — killStrays has already run */
  }
  for (let i = 0; i < 40; i++) {
    try {
      return rmdirSync(dir);
    } catch (e) {
      if (e.code === "ENOENT") return;
      pause(50);
    }
  }
  log("group_not_removed", { dir });
}

/** A fresh group for a conversation's uid, capped. Null when memory groups are off (entrypoint said so). */
function makeGroup(uid) {
  if (!GROUPS) return null;
  const dir = groupOf(uid);
  removeGroup(dir); // left behind by a host that died mid-conversation
  mkdirSync(dir);
  writeFileSync(join(dir, "memory.max"), String(CONVERSATION_MEMORY));
  try {
    writeFileSync(join(dir, "memory.swap.max"), "0");
  } catch {
    /* no swap accounting */
  }
  writeFileSync(join(dir, "memory.oom.group"), "1");
  return dir;
}

/** How many times the kernel killed something in this group for running out of memory. */
function oomKills(dir) {
  try {
    return Number(/^oom_kill (\d+)/m.exec(readFileSync(join(dir, "memory.events"), "utf8"))?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Give the whole folder to the conversation's uid: dirs 0700, files 0600, links left as links (lchown, never followed —
 * a link Forge made to somewhere else must not hand that somewhere else to it). Run before every message, because the
 * server writes into the folder between turns (answers, attachments, the goal) as root.
 */
function handOver(root, uid) {
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      lchownSync(p, uid, uid);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
      chmodSync(p, 0o700);
    } else {
      chmodSync(p, 0o600);
    }
    lchownSync(p, uid, uid);
  };
  walk(root);
}

/**
 * The workflows this chat references (`sandbox/references/`, written by the server before the message): readable by the
 * conversation's uid, never writable — root-owned, dirs 0755, files 0644, links left as links (lchown, never followed).
 * The uid owns `sandbox/` itself, so it can still rename `references/` away; the server removes and rewrites the folder
 * before every message and never reads it back, which is the other half.
 */
function lockReferences(root) {
  const refs = join(root, "sandbox", "references");
  if (!existsSync(refs)) return;
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      lchownSync(p, 0, 0);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
      chmodSync(p, 0o755);
    } else {
      chmodSync(p, 0o644);
    }
    lchownSync(p, 0, 0);
  };
  walk(refs);
}

/**
 * The shared folder's top levels, locked: a conversation may pass through to its own folder but list nothing — not the
 * other conversations of its workspace, not other workspaces — and the server's own stores (`_catalog`, which holds
 * every workspace's catalogue) are root's alone. The server creates these as it goes, readable by all, so this runs at
 * boot and before every message.
 */
function lockTops() {
  chmodSync(SANDBOXES_ROOT, 0o711);
  for (const name of readdirSync(SANDBOXES_ROOT)) {
    const p = join(SANDBOXES_ROOT, name);
    const st = lstatSync(p);
    if (!st.isDirectory()) continue;
    chmodSync(p, name.startsWith("_") ? 0o700 : 0o711);
  }
}

function folderBytes(root) {
  let n = 0;
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else n += st.size;
  };
  try {
    walk(root);
  } catch {
    /* changing under us; a later check catches it */
  }
  return n;
}

/**
 * Before each message: the catalogue becomes a COPY in the sandbox (the server keeps one per workspace under _catalog,
 * which a conversation's uid cannot enter), and pi's own settings dir exists in the folder.
 */
function prepare(root, workspaceId, uid) {
  const sbx = join(root, "sandbox");
  const cat = join(SANDBOXES_ROOT, "_catalog", workspaceId, "catalogue.json");
  const inSandbox = join(sbx, "catalogue.json");
  if (existsSync(cat) && existsSync(sbx)) {
    try {
      if (lstatSync(inSandbox).isSymbolicLink() || existsSync(inSandbox)) unlinkSync(inSandbox);
    } catch {
      /* none yet */
    }
    copyFileSync(cat, inSandbox);
  }
  const agent = join(root, ".pi-agent");
  mkdirSync(agent, { recursive: true });
  for (const f of ["settings.json"]) {
    if (!existsSync(join(agent, f))) copyFileSync(join(AGENT_TEMPLATE, f), join(agent, f));
  }
  mkdirSync(join(root, ".home"), { recursive: true });
  mkdirSync(join(root, ".tmp"), { recursive: true });
  handOver(root, uid);
  lockReferences(root);
  lockTops();
}

/** Every process of `uid` except `keep` — what a finished turn's background commands leave behind. */
function killStrays(uid, keep) {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === keep) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m && Number(m[1]) === uid) process.kill(Number(pid), "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function folderOf(workspaceId, sessionId) {
  if (!ID.test(workspaceId) || !ID.test(sessionId) || workspaceId.startsWith("_")) return null;
  const root = join(SANDBOXES_ROOT, workspaceId, sessionId);
  if (!existsSync(root)) return null;
  const real = realpathSync(root);
  const rel = relative(realpathSync(SANDBOXES_ROOT), real);
  if (rel.startsWith("..") || rel.split(sep).length !== 2) return null;
  return real;
}

/** The environment a Forge gets: what the server sent (the AI settings), plus its own home and the egress proxy. */
function envFor(root, sent) {
  const allowed = {};
  for (const [k, v] of Object.entries(sent ?? {})) {
    if (typeof v === "string" && /^(LITELLM_|PI_|LANG$|LC_|TZ$|TERM$)/.test(k)) allowed[k] = v;
  }
  return {
    ...allowed,
    PATH: `/opt/forge-py/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: join(root, ".home"),
    TMPDIR: join(root, ".tmp"),
    PI_CODING_AGENT_DIR: join(root, ".pi-agent"),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
    // Every way out goes through the proxy, which lets through the AI gateway only. Node's fetch honours these with
    // NODE_USE_ENV_PROXY; a command that ignores them has no route at all (the network has no gateway).
    HTTPS_PROXY: EGRESS,
    HTTP_PROXY: EGRESS,
    https_proxy: EGRESS,
    http_proxy: EGRESS,
    NO_PROXY: "server,localhost,127.0.0.1",
    no_proxy: "server,localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",
    // Turning that on prints "EnvHttpProxyAgent is experimental" at the head of EVERY tool's output, which Forge then
    // reads as part of each answer. Only that one warning is silenced; every other warning still prints.
    NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
  };
}

const server = createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  let child = null;
  let uid = null;
  let group = null;
  let root = null;
  let workspaceId = null;
  let stderr = "";
  let ended = false;
  const send = (obj) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`);
  };
  const stop = () => {
    if (!child || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, KILL_GRACE_MS).unref();
  };
  const finish = (code) => {
    if (ended) return;
    ended = true;
    if (uid != null) {
      killStrays(uid, -1);
      if (group) {
        if (oomKills(group) > 0) {
          const mb = Math.round(CONVERSATION_MEMORY / 1024 / 1024);
          stderr += `\nforge-host: this conversation went over its ${mb} MB of memory and was stopped.`;
          log("out_of_memory", { workspaceId, uid });
        }
        removeGroup(group);
      }
      releaseUid(uid);
    }
    send({ type: "__forge_exit", code, stderr: stderr.slice(-STDERR_TAIL) });
    sock.end();
  };

  const start = (head) => {
    if (!sameSecret(head.secret)) {
      log("refused", { why: "bad secret" });
      send({ type: "__forge_exit", code: null, stderr: "forge-host refused the connection" });
      return sock.destroy();
    }
    workspaceId = String(head.workspaceId ?? "");
    root = folderOf(workspaceId, String(head.sessionId ?? ""));
    if (!root) {
      send({ type: "__forge_exit", code: null, stderr: "forge-host: no such conversation folder" });
      return sock.end();
    }
    const args = Array.isArray(head.args) ? head.args.map(String) : [];
    try {
      uid = claimUid();
      prepare(root, workspaceId, uid);
      group = makeGroup(uid);
    } catch (e) {
      send({ type: "__forge_exit", code: null, stderr: `forge-host could not prepare the folder: ${e.message}` });
      return sock.end();
    }
    // prlimit (util-linux) sets the limits, then becomes pi, as the conversation's uid. No address-space limit: node
    // reserves far more than it uses — memory is the group's cap instead.
    const limited = ["prlimit", "--nproc=256", "--nofile=4096", `--fsize=${256 * 1024 * 1024}`, "--core=0", "--", PI_BIN, ...args];
    const opts = { cwd: join(root, "sandbox"), env: envFor(root, head.env), detached: true, stdio: ["pipe", "pipe", "pipe"] };
    // With a group, a root shell joins it FIRST and only then becomes the uid (setpriv), so nothing of the
    // conversation ever runs outside it — moving the pid in after spawn would race the first fork. The uid could not
    // join on its own: the group's files are root's.
    const enter = 'echo $$ > "$1/cgroup.procs" || exit 126; shift; exec "$@"';
    const asUid = ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--inh-caps=-all"];
    child = group
      ? spawn("sh", ["-c", enter, "forge-enter", group, ...asUid, ...limited], opts)
      : spawn(limited[0], limited.slice(1), { ...opts, uid, gid: uid });
    log("started", { workspaceId, uid, pid: child.pid, memoryGroup: Boolean(group) });
    child.stdout.setEncoding("utf8");
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!sock.destroyed) sock.write(`${line}\n`);
        // A turn ended: whatever its commands left running in the background stops now, before the server reads the
        // folder — nothing keeps writing (or making links) behind the server's back.
        if (line.includes('"type":"agent_end"')) killStrays(uid, child.pid);
      }
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => {
      stderr += `\n${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  };

  const onLine = (line) => {
    if (!child) {
      let head;
      try {
        head = JSON.parse(line);
      } catch {
        return sock.destroy();
      }
      return start(head);
    }
    let cmd = null;
    try {
      cmd = JSON.parse(line);
    } catch {
      /* passed through as it is */
    }
    if (cmd?.type === "__forge_kill") return stop();
    if (cmd?.type === "prompt") {
      // Each message: the folder is handed back to its uid (the server wrote into it meanwhile), and refused if full.
      if (folderBytes(root) > MAX_FOLDER_BYTES) {
        const mb = Math.round(MAX_FOLDER_BYTES / 1024 / 1024);
        return send({ type: "response", command: "prompt", success: false, error: `This conversation's files are over ${mb} MB. Remove some, or start a new chat.` });
      }
      try {
        prepare(root, workspaceId, uid);
      } catch (e) {
        log("prepare_failed", { why: e.message });
      }
    }
    if (child.exitCode === null) child.stdin.write(`${line}\n`);
  };

  sock.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > 64 * 1024 * 1024) return sock.destroy();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  sock.on("close", () => stop());
  sock.on("error", () => stop());
});

// A restart: no Forge survives it, so no uid is held — and no conversation group is in use.
rmSync(UID_LOCKS, { recursive: true, force: true });
mkdirSync(UID_LOCKS, { recursive: true, mode: 0o700 });
if (GROUPS) {
  for (const name of readdirSync(CGROUP_WORK)) if (name.startsWith("conv-")) removeGroup(join(CGROUP_WORK, name));
}
log("memory_groups", GROUPS ? { on: true, perConversationBytes: CONVERSATION_MEMORY } : { on: false });
// Every conversation needs root to create a folder, hand it to the conversation's uid and lock its mode. A share that
// squashes root (NFS root_squash — Azure Files' default) or has no POSIX owners (SMB) allows none of that, and every
// chat would fail while this process looked healthy. So prove it once, here, and refuse to start if it does not hold.
try {
  const probe = join(SANDBOXES_ROOT, `.forge-boot-${process.pid}`);
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { mode: 0o700 });
  lchownSync(probe, UID_FIRST, UID_FIRST);
  chmodSync(probe, 0o700);
  const st = lstatSync(probe);
  rmSync(probe, { recursive: true, force: true });
  if (st.uid !== UID_FIRST || (st.mode & 0o777) !== 0o700) throw new Error(`owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)} did not stick`);
  lockTops();
} catch (e) {
  log("sandboxes_unusable", {
    why: e.message,
    fix: "the chat folder must let root create, chown and chmod: NFS with root squash OFF (Azure Files NFS: No Root Squash), never SMB",
  });
  process.exit(3);
}
writeFileSync("/tmp/forge-host.ready", "");
server.listen(PORT, () => log("listening", { port: PORT, sandboxes: SANDBOXES_ROOT }));
