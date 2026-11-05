/**
 * The `context` a piece's `run(context)` receives — built by us, not by the Activepieces engine.
 *
 * Every field the framework's ActionContext declares is present. What this connector does not serve throws
 * `Unsupported` naming the feature, so a piece that needs it fails by name (and Phase 1 can count it) instead of
 * failing on `undefined` three calls deep.
 */
import { basename } from "node:path";

export class Unsupported extends Error {
  constructor(feature) {
    super(`this connector does not provide ${feature}`);
    this.feature = feature;
  }
}

const no = (feature) => () => {
  throw new Unsupported(feature);
};

/** A file handed to a piece (a FILE prop): the framework's ApFile, duck-typed. */
export function apFile({ name, base64 }) {
  const data = Buffer.from(base64 ?? "", "base64");
  const dot = (name ?? "").lastIndexOf(".");
  return {
    filename: name ?? "file",
    data,
    extension: dot > 0 ? name.slice(dot + 1) : undefined,
    get base64() {
      return data.toString("base64");
    },
  };
}

/**
 * The credential as the framework types it (AppConnectionValue). Foundry stores the fields; the type comes from the
 * piece's own auth declaration, so a caller cannot claim a different kind of credential than the piece asks for.
 */
export function connectionValue(authDecl, fields) {
  if (!authDecl) return undefined;
  const f = fields ?? {};
  switch (authDecl.type) {
    case "SECRET_TEXT":
      return { type: "SECRET_TEXT", secret_text: f.secret_text ?? f.secret ?? "" };
    case "BASIC_AUTH":
      return { type: "BASIC_AUTH", username: f.username ?? "", password: f.password ?? "" };
    case "CUSTOM_AUTH":
      return { type: "CUSTOM_AUTH", props: { ...f } };
    case "OAUTH2":
      // The framework's OAuth2 value. Foundry renews the token before the call and never sends the refresh token.
      return {
        type: "OAUTH2",
        access_token: f.access_token ?? "",
        token_type: f.token_type,
        expires_in: f.expires_in,
        claimed_at: f.claimed_at,
        scope: f.scope,
        props: f.props ?? {},
        data: f.data ?? {},
      };
    default:
      throw new Unsupported(`credentials of type ${authDecl.type}`);
  }
}

/** All files one call may hand back, together. They travel in the answer; nothing is kept on disk. */
export const MAX_FILE_BYTES = Number(process.env.CONNECTOR_MAX_FILE_BYTES ?? 16 << 20);

export class FileLimit extends Error {}

export function buildContext({ auth, propsValue, runId, workspaceId, stepName, store, files }) {
  return {
    executionType: "BEGIN",
    auth,
    propsValue,
    store,
    files: {
      async write({ fileName, data }) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? "");
        const total = files.reduce((n, f) => n + f.bytes, 0) + buf.length;
        if (total > MAX_FILE_BYTES) throw new FileLimit(`the files this call returns pass ${MAX_FILE_BYTES} bytes together`);
        const name = basename(fileName || "file");
        files.push({ name, bytes: buf.length, base64: buf.toString("base64") });
        return name; // Foundry names files by name inside a run
      },
    },
    server: { apiUrl: "", publicUrl: "", token: "" },
    project: { id: workspaceId ?? "poc", externalId: async () => undefined },
    flows: {
      list: no("listing flows"),
      current: { id: runId, version: { id: runId } },
    },
    step: { name: stepName ?? "step" },
    connections: { get: no("reading other connections") },
    tags: { add: async () => {} },
    output: { update: async () => {} },
    agent: { tools: no("agent tools") },
    run: {
      id: runId,
      stop: no("stopping the run from inside a piece"),
      respond: no("responding to a webhook"),
      createWaitpoint: no("waiting for a person or a delay inside a piece (Foundry has its own approval step)"),
      waitForWaitpoint: no("waiting for a person or a delay inside a piece (Foundry has its own approval step)"),
      pause: no("pausing the run inside a piece"),
    },
    generateResumeUrl: no("resume URLs"),
  };
}

/** A store per (workspace, piece) for the life of the process — enough for actions; triggers will need it durable. */
export function memoryStore() {
  const m = new Map();
  return {
    async put(k, v) {
      m.set(k, v);
      return v;
    },
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async delete(k) {
      m.delete(k);
    },
  };
}
