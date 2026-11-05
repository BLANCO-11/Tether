/**
 * Running one action of one installed piece.
 *
 * `mode: "capture"` is the draft-run rule: an action that WRITES (or does not declare that it only reads) is not
 * run — the call is recorded and returned as what would have happened. A read runs in both modes.
 */
import { apFile, buildContext, connectionValue, FileLimit, memoryStore, Unsupported } from "./context.mjs";
import { describeAction } from "./describe.mjs";

const RUN_TIMEOUT_MS = Number(process.env.CONNECTOR_RUN_TIMEOUT_MS ?? 60_000);

export class RunError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** `store` is the parent's (over IPC, workers.mjs); without one — a unit test — a throwaway store is used. */
export async function runAction(piece, req, { store = memoryStore() } = {}) {
  const action = piece.getAction?.(req.action) ?? piece.actions()[req.action];
  if (!action) {
    throw new RunError("unknown_action", `${req.piece} has no action "${req.action}"`, {
      available: Object.keys(piece.actions()).sort(),
    });
  }
  const meta = describeAction(action);
  // A declared call (declared.mjs, built in the parent) says itself whether it changes data: a GET reads, so a draft
  // run runs it; the raw call's own classification (WRITE) would capture every one.
  if (typeof req.declaredWrites === "boolean") meta.writes = req.declaredWrites;
  const propsValue = prepareProps(action, req.props ?? {});

  if (req.mode === "capture" && meta.writes) {
    return { captured: true, writes: true, action: req.action, props: summarise(propsValue) };
  }

  const auths = piece.auth == null ? [] : Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  const authDecl = req.authType ? auths.find((a) => a.type === req.authType) : auths[0];
  if (action.requireAuth !== false && auths.length && !req.auth) {
    throw new RunError("validation", `${req.piece} needs a connection (${auths.map((a) => a.type).join(" or ")})`);
  }
  const auth = req.auth ? connectionValue(authDecl, req.auth) : undefined;

  const files = [];
  const ctx = buildContext({
    auth,
    propsValue,
    runId: req.runId ?? `poc-${Date.now()}`,
    workspaceId: req.workspaceId,
    stepName: req.action,
    store,
    files,
  });

  let timer;
  try {
    const output = await Promise.race([
      action.run(ctx),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RunError("timeout", `${req.action} took longer than ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS);
      }),
    ]);
    return { captured: false, writes: meta.writes, output: output ?? null, files };
  } catch (e) {
    if (e instanceof Unsupported) throw new RunError("unsupported", e.message, { feature: e.feature });
    if (e instanceof FileLimit) throw new RunError("too_large", e.message);
    if (e instanceof RunError) throw e;
    throw new RunError("action_failed", describeError(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Defaults, required inputs, numbers given as text, and files given as {name, base64}. Nothing more is guessed. */
function prepareProps(action, given) {
  const out = {};
  const missing = [];
  for (const [n, p] of Object.entries(action.props ?? {})) {
    if (p.type === "MARKDOWN") continue;
    let v = given[n];
    if (v === undefined || v === null || v === "") v = p.defaultValue;
    if (v === undefined || v === null || v === "") {
      if (p.required) missing.push(n);
      continue;
    }
    if (p.type === "NUMBER" && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) v = Number(v);
    if (p.type === "FILE") {
      if (typeof v !== "object" || typeof v.base64 !== "string") throw new RunError("validation", `input "${n}" must be a file {name, base64}`);
      v = apFile(v);
    }
    out[n] = v;
  }
  const unknown = Object.keys(given).filter((k) => !(k in (action.props ?? {})));
  if (missing.length || unknown.length) {
    const why = [missing.length && `missing: ${missing.join(", ")}`, unknown.length && `not inputs of this action: ${unknown.join(", ")}`];
    throw new RunError("validation", why.filter(Boolean).join("; "), { inputs: Object.keys(action.props ?? {}) });
  }
  return out;
}

function summarise(props) {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, v && typeof v === "object" && "data" in v && "filename" in v ? { file: v.filename, bytes: v.data.length } : v]),
  );
}

function describeError(e) {
  const status = e?.response?.status ?? e?.status ?? e?.$metadata?.httpStatusCode;
  const body = e?.response?.data ?? e?.response?.body;
  const msg = e?.message ?? String(e);
  // ⚠ A 401/403 on an ACTION is usually not a dead credential — the connection's own test can pass while this request is
  // refused, because the credential lacks the permission (scope) this action needs. Saying only "HTTP 401" sent people
  // (and Forge) to reconnect with the same credential, which changes nothing.
  const hint =
    status === 401 || status === 403
      ? "The service refused this request with the stored credential. If the connection's Test passes, the credential most likely lacks the permission (scope) this action needs — widen it at the service — or the resource named does not exist or is not visible to it."
      : null;
  return [status && `HTTP ${status}`, msg, body && JSON.stringify(body).slice(0, 400), hint].filter(Boolean).join(" — ");
}
