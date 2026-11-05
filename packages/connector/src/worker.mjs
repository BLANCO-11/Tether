/**
 * One piece, one job, one process — started by `workers.mjs`, never by hand.
 *
 * The parent NEVER loads piece code: a piece's top-level code would run in the process that holds the connector's
 * secrets. Here the environment carries only PATH, HOME and this run's proxy credentials (`NODE_USE_ENV_PROXY`), so
 * the only way out is connector-egress with this run's allowlist. The store lives in the parent and is reached over
 * IPC; a crash, a leak or a hang ends this process and no other run.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { loadPiece } from "./install.mjs";

/**
 * ⚠ `NODE_USE_ENV_PROXY` covers fetch and the GLOBAL agents only. A library that builds its own agent (the AWS SDK
 * does) would dial directly — which on connector-net fails closed, so S3 simply broke. Every agent created in this
 * process now defaults to the run's proxy; one that names its own `proxyEnv` keeps it. Raw `net.connect` (SMTP,
 * database drivers) still has no way out, by design.
 */
if (process.env.HTTPS_PROXY) {
  for (const mod of [http, https]) {
    const Base = mod.Agent;
    mod.Agent = class ProxiedAgent extends Base {
      constructor(options = {}) {
        super({ proxyEnv: process.env, ...options });
      }
    };
  }
  syncBuiltinESMExports();
}
import { describePiece } from "./describe.mjs";
import { runAction } from "./run.mjs";
import { validateConnection } from "./validate.mjs";

let seq = 0;
const pending = new Map();
function ask(op, key, value) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.value ?? null)));
    process.send({ type: "store", id, op, key, value });
  });
}
process.on("message", (m) => {
  if (m?.type === "store-reply") {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
});

function done(payload) {
  process.send({ type: "done", ...payload }, () => process.exit(0));
}

process.once("message", async (job) => {
  if (job?.type !== "job") return;
  try {
    const piece = loadPiece(job.dir, job.name);
    if (job.op === "describe") return done({ ok: true, value: describePiece(piece, job.info) });
    if (job.op === "validate") return done({ ok: true, value: await validateConnection(piece, job.req) });
    const store = { put: (k, v) => ask("put", k, v).then(() => v), get: (k) => ask("get", k), delete: (k) => ask("delete", k).then(() => undefined) };
    const result = await runAction(piece, job.req, { store });
    done({ ok: true, value: result });
  } catch (e) {
    const { kind, message, ...extra } = e ?? {};
    done({ ok: false, kind: kind ?? "action_failed", message: message ?? String(e), extra: JSON.parse(JSON.stringify(extra ?? {})) });
  }
});
