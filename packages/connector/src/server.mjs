/**
 * The connector service — Foundry's only way to run an Activepieces piece.
 *
 *   GET  /healthz
 *   GET  /pieces                          installed pieces: description, approved hosts, suggested hosts
 *   POST /pieces/install {name, version, integrity?, hosts?}
 *   POST /pieces/hosts   {name, hosts}    replace a piece's approved hosts
 *   POST /pieces/uninstall {name}
 *   POST /run {piece, version?, action, props, auth?, authType?, mode: "execute"|"capture", runId?, workspaceId?, connectionId?}
 *   POST /store/forget {workspaceId, piece, connectionId}   (a removed connection's piece memory)
 *   POST /validate {piece, authType?, auth}   the piece's own connection check → {checked, valid?, error?}
 *
 * Every route but /healthz needs `x-connector-secret`. This process never loads piece code (worker.mjs does, one
 * process per job) and has no route out but connector-egress. A credential arrives with the one call that uses it.
 */
import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { installPiece, verifyInstalled, pieceSource, pieceDir, InstallError } from "./install.mjs";
import { RunError } from "./run.mjs";
import { DECLARED_PREFIX, buildDeclaredCall, declarationHash, declaredOutput } from "./declared.mjs";
import { runInWorker, SEPARATE_WORKER_USER, configureStore, deleteStoresFor, forgetStore, storeKey } from "./workers.mjs";
import { mintProxyAuth, normalisePattern } from "./egress-token.mjs";
import { connectionHosts, suggestHosts } from "./hosts.mjs";

const PORT = Number(process.env.PORT ?? 4010);
const DATA = process.env.CONNECTOR_DATA ?? "/data";
const SECRET = process.env.CONNECTOR_SECRET ?? "";
const EGRESS_URL = (process.env.CONNECTOR_EGRESS_URL ?? "").replace(/\/+$/, "");
const EGRESS_SECRET = process.env.CONNECTOR_EGRESS_SECRET ?? "";
const RUN_TIMEOUT_MS = Number(process.env.CONNECTOR_RUN_TIMEOUT_MS ?? 60_000);
const REGISTRY_HOSTS = ["registry.npmjs.org"];

if (SECRET.length < 16) {
  console.error("CONNECTOR_SECRET must be set (16+ characters); refusing to start without it.");
  process.exit(1);
}
if (!EGRESS_URL || EGRESS_SECRET.length < 16) {
  console.warn("connector: no CONNECTOR_EGRESS_URL / CONNECTOR_EGRESS_SECRET — pieces run with NO proxy. Development only.");
}
if (!SEPARATE_WORKER_USER) {
  console.warn("connector: not running as root — workers share this process's user and could read its environment. Development only.");
}
const PIECES = join(DATA, "pieces");
const MANIFEST = join(DATA, "installed.json");
mkdirSync(PIECES, { recursive: true });
// Pieces' stores, written through (workers.mjs). A piece's files travel in the answer and are never kept on disk.
configureStore(join(DATA, "store"));

/** This run's way out: proxy credentials naming exactly the hosts it may reach. */
function proxyUrl(runId, hosts) {
  if (!EGRESS_URL || EGRESS_SECRET.length < 16) return null;
  const { user, pass } = mintProxyAuth(EGRESS_SECRET, { runId, hosts, ttlMs: RUN_TIMEOUT_MS + 60_000 });
  const u = new URL(EGRESS_URL);
  return `${u.protocol}//${user}:${pass}@${u.host}`;
}

/** name → {info: {name, version, dir, integrity, license}, description, hosts, suggestedHosts} */
const installed = new Map();

function saveManifest() {
  const rows = [...installed.values()].map((x) => ({ name: x.info.name, version: x.info.version, integrity: x.info.integrity, license: x.info.license, hosts: x.hosts }));
  writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(rows, null, 2));
  renameSync(`${MANIFEST}.tmp`, MANIFEST);
}

async function describeIn(info) {
  return runInWorker({ op: "describe", dir: info.dir, name: info.name, info }, { proxyUrl: null, timeoutMs: 60_000, storeKey: "describe", persistStore: false });
}

async function register(info, hosts) {
  const description = await describeIn(info);
  const entry = {
    info,
    description,
    hosts: [...new Set((hosts ?? []).map(normalisePattern).filter(Boolean))],
    suggestedHosts: suggestHosts(pieceSource(info.dir, info.name)),
  };
  const prior = installed.get(info.name);
  installed.set(info.name, entry);
  if (prior && prior.info.version !== info.version) rmSync(prior.info.dir, { recursive: true, force: true });
  saveManifest();
  return entry;
}

const view = (x) => ({ ...x.description, hosts: x.hosts, suggestedHosts: x.suggestedHosts });

// After a restart: what was installed comes back from disk, re-verified against its pinned integrity, offline.
if (existsSync(MANIFEST)) {
  for (const spec of JSON.parse(readFileSync(MANIFEST, "utf8"))) {
    try {
      await register(verifyInstalled(PIECES, spec), spec.hosts);
      console.log(`loaded ${spec.name}@${spec.version}`);
    } catch (e) {
      console.error(`could not reload ${spec.name}@${spec.version}: ${e.message}`);
    }
  }
}

function authorised(req) {
  const got = Buffer.from(String(req.headers["x-connector-secret"] ?? ""));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 << 20) throw new RunError("validation", "request body over 64 MB");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function refusalError(piece, refused, pieceError) {
  const first = refused[0];
  // Two causes, two remedies: a private address can never be approved; a public host can.
  const remedy = /private or internal/.test(first.why)
    ? "A connection may not point at a private or internal address; check the connection's address."
    : `An administrator can approve ${first.host} for this connector.`;
  return new RunError("egress_refused", `${piece} tried to reach ${first.host}:${first.port}, which was refused (${first.why}). ${remedy}`, { refused, pieceError });
}

const STATUS = { version_mismatch: 409, unknown_action: 404, unknown_piece: 404, validation: 400, unsupported: 422, too_large: 413, timeout: 504, action_failed: 502, egress_refused: 502 };

/**
 * A run that failed may have failed because the proxy refused it — the piece itself only saw "fetch failed". Ask the
 * proxy what it refused for this job and, if anything, say so instead.
 */
async function refusedFor(proxyRunId) {
  if (!EGRESS_URL || EGRESS_SECRET.length < 16) return [];
  try {
    const r = await fetch(`${EGRESS_URL}/refusals?run=${encodeURIComponent(proxyRunId)}`, { headers: { "x-egress-secret": EGRESS_SECRET }, signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()).refusals ?? []) : [];
  } catch {
    return [];
  }
}
const need = (name) => {
  const x = installed.get(name);
  if (!x) throw new RunError("unknown_piece", `${name} is not installed`, { installed: [...installed.keys()] });
  return x;
};

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true, pieces: installed.size, egress: !!EGRESS_URL });
    if (!authorised(req)) return send(res, 401, { error: "unauthorised" });

    if (req.method === "GET" && req.url === "/pieces") return send(res, 200, { pieces: [...installed.values()].map(view) });

    if (req.method === "POST" && req.url === "/pieces/install") {
      const spec = await body(req);
      const info = await installPiece(PIECES, spec, { proxyUrl: proxyUrl("install", REGISTRY_HOSTS) });
      return send(res, 200, view(await register(info, spec.hosts ?? installed.get(spec.name)?.hosts)));
    }
    if (req.method === "POST" && req.url === "/pieces/hosts") {
      const { name, hosts } = await body(req);
      const x = need(name);
      x.hosts = [...new Set((Array.isArray(hosts) ? hosts : []).map(normalisePattern).filter(Boolean))];
      saveManifest();
      return send(res, 200, view(x));
    }
    if (req.method === "POST" && req.url === "/pieces/uninstall") {
      const { name } = await body(req);
      const x = need(name);
      installed.delete(name);
      saveManifest();
      deleteStoresFor((k) => k.split(":")[1] === name);
      rmSync(pieceDir(PIECES, x.info.name, x.info.version), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/store/forget") {
      const { workspaceId, piece, connectionId } = await body(req);
      if (!workspaceId || !piece || !connectionId) return send(res, 400, { error: "workspaceId, piece and connectionId are required" });
      forgetStore(storeKey(workspaceId, piece, connectionId));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/validate") {
      const r = await body(req);
      const x = need(r.piece);
      const proxyRunId = `validate:${randomUUID()}`;
      try {
        const result = await runInWorker(
          { op: "validate", dir: x.info.dir, name: x.info.name, req: { authType: r.authType, auth: r.auth } },
          { proxyUrl: proxyUrl(proxyRunId, [...x.hosts, ...connectionHosts(r.auth)]), timeoutMs: RUN_TIMEOUT_MS, storeKey: "validate", persistStore: false },
        );
        // A check that failed because the proxy refused it is a refusal, not "wrong password".
        const refused = result.checked && !result.valid ? await refusedFor(proxyRunId) : [];
        if (refused.length) throw refusalError(r.piece, refused, result.error);
        return send(res, 200, { ok: true, ...result });
      } catch (e) {
        if (e instanceof RunError && (e.kind === "action_failed" || e.kind === "timeout")) {
          const refused = await refusedFor(proxyRunId);
          if (refused.length) throw refusalError(r.piece, refused, e.message);
        }
        throw e;
      }
    }
    if (req.method === "POST" && req.url === "/run") {
      const r = await body(req);
      const x = need(r.piece);
      // A tool's address names the version it was approved against; never run other code under that name.
      if (r.version && r.version !== x.info.version) {
        throw new RunError("version_mismatch", `${r.piece} is installed at ${x.info.version}, but this call was made for ${r.version}`, { installed: x.info.version });
      }
      // ⚠ The raw call never runs as such: it takes a free URL and method. Only a DECLARED call reaches it, its inputs
      // built here, in the parent, from the declaration and the values (declared.mjs).
      if (r.action === "custom_api_call") throw new RunError("validation", "the raw API call runs only as a declared call");
      let declaredWrites;
      if (typeof r.action === "string" && r.action.startsWith(DECLARED_PREFIX)) {
        if (`${DECLARED_PREFIX}${declarationHash(r.declared ?? {})}` !== r.action) {
          throw new RunError("validation", `declared call: the declaration sent does not match ${r.action}`);
        }
        const built = buildDeclaredCall(r.declared, r.props);
        r.action = "custom_api_call";
        r.props = built.props;
        declaredWrites = built.writes;
        delete r.declared;
      }
      const runId = String(r.runId ?? `adhoc-${Date.now()}`);
      const hosts = [...x.hosts, ...connectionHosts(r.auth)];
      const started = Date.now();
      // The proxy's run id is per JOB, so its refusals are this call's and no other's.
      const proxyRunId = `${runId}:${randomUUID()}`;
      let result;
      try {
        result = await runInWorker(
          { op: "run", dir: x.info.dir, name: x.info.name, req: { ...r, runId, ...(declaredWrites === undefined ? {} : { declaredWrites }) } },
          { proxyUrl: proxyUrl(proxyRunId, hosts), timeoutMs: RUN_TIMEOUT_MS, storeKey: storeKey(r.workspaceId, r.piece, r.connectionId) },
        );
      } catch (e) {
        const refused = e instanceof RunError && (e.kind === "action_failed" || e.kind === "timeout") ? await refusedFor(proxyRunId) : [];
        if (!refused.length) throw e;
        throw refusalError(r.piece, refused, e.message);
      }
      console.log(JSON.stringify({ run: r.runId ?? null, piece: r.piece, action: r.action, mode: r.mode ?? "execute", captured: result.captured, hosts, ms: Date.now() - started }));
      return send(res, 200, { ok: true, ...result, ...(declaredWrites === undefined ? {} : { output: declaredOutput(result.output) }) });
    }
    send(res, 404, { error: "not_found" });
  } catch (e) {
    if (e instanceof InstallError) return send(res, 400, { ok: false, kind: "install", error: e.message });
    if (e instanceof RunError) {
      const { kind, message, ...extra } = e;
      return send(res, STATUS[kind] ?? 500, { ok: false, kind, error: message, ...extra });
    }
    if (e instanceof SyntaxError) return send(res, 400, { ok: false, kind: "validation", error: "body is not JSON" });
    console.error(e);
    send(res, 500, { ok: false, kind: "internal", error: "internal_error" });
  }
}).listen(PORT, () => console.log(`connector listening on ${PORT}, ${installed.size} piece(s), egress ${EGRESS_URL || "NONE"}`));
