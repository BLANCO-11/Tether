/**
 * Connectors (plans/plugins-2026-10-27) — a tool whose action is an Activepieces piece, run by the
 * connector service (`packages/connector`). OFF unless the connector is configured (`PLUGINS_CONNECTOR_URL` + `PLUGINS_CONNECTOR_SECRET`).
 *
 * A plugin tool is an ordinary `tools` row: `url` = `plugin://<package>@<version>/<action>`, `params_schema` from the
 * piece's own inputs, `secret_env_name` naming a workspace secret whose value is the connection's fields as JSON. So
 * `foundry.call("<tool name>", …)`, the step's `uses` and the catalogue need nothing new.
 *
 * ⚠ **Draft or live is decided HERE, from the execution row (D-52), never by the call.** A draft run sends
 * `mode: "capture"`: the connector runs a READ/SEARCH action and records — does not perform — anything else. A live
 * run sends `execute`. An unknown execution is a draft (fail closed), the same rule `envForExecution` applies.
 *
 * ⚠ The credential is decrypted here and travels with the ONE call that uses it; the connector keeps none and the
 * runner never sees it.
 */
import { assertMayUseConnection } from "./plugin-credentials.js";
import { config } from "../config/index.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { envForExecution } from "./execution-env.service.js";
import { freshConnection, type OauthDecl } from "./plugin-oauth.service.js";
import { StepError } from "./step-error.js";
import { pluginRepo } from "../repositories/plugin.repo.js";
import { DECLARED_PREFIX } from "./declared-call.js";

const SCHEME = "plugin://";

export type PluginRef = { piece: string; version: string; action: string };

/** `plugin://@activepieces/piece-amazon-s3@0.8.1/amazon_s3_upload_file` → its parts; anything else → null. */
export function parsePluginUrl(url: string | null | undefined): PluginRef | null {
  if (!url?.startsWith(SCHEME)) return null;
  const m = url.slice(SCHEME.length).match(/^(@activepieces\/piece-[a-z0-9-]+)@(\d+\.\d+\.\d+)\/([A-Za-z0-9_-]+)$/);
  return m ? { piece: m[1]!, version: m[2]!, action: m[3]! } : null;
}

export function pluginUrl(ref: PluginRef): string {
  return `${SCHEME}${ref.piece}@${ref.version}/${ref.action}`;
}

export function isPluginTool(tool: Pick<Tool, "url">): boolean {
  return config.plugins.enabled && !!tool.url?.startsWith(SCHEME);
}

type ConnectorAnswer = {
  ok: boolean;
  captured?: boolean;
  writes?: boolean;
  output?: unknown;
  props?: unknown;
  files?: Array<{ name: string; bytes: number; base64: string }>;
  kind?: string;
  error?: string;
};

/** One call to the connector. Throws `StepError` for what is systemic (not configured, unreachable, refused). */
export async function callConnector(body: Record<string, unknown>): Promise<{ status: number; answer: ConnectorAnswer }> {
  if (!config.plugins.url || !config.plugins.secret) {
    throw new StepError("plugins are not configured: set PLUGINS_CONNECTOR_URL and PLUGINS_CONNECTOR_SECRET", 503);
  }
  let res: Response;
  try {
    res = await fetch(`${config.plugins.url}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-connector-secret": config.plugins.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new StepError(`the plugin connector could not be reached: ${(e as Error).message}`, 502);
  }
  const answer = (await res.json().catch(() => ({ ok: false, error: `connector answered ${res.status}` }))) as ConnectorAnswer;
  return { status: res.status, answer };
}

/**
 * The connection a tool uses: its value (an OAuth sign-in renewed first if it is about to expire) and its KIND. ⚠ The
 * kind matters: a piece offering several (GitHub: sign-in, an App, a token) is otherwise run as if given its first.
 */
async function connectionFields(
  workspaceId: string,
  tool: Tool,
  piece: string,
  secretName: string | null,
  actingSubject: string | null | undefined,
): Promise<{ auth?: Record<string, unknown>; authType?: string; connectionId?: string }> {
  if (!secretName) return {};
  // ⚠ Before the value is read: only this piece's connections, and a personal one only for its owner (8.1).
  let conn;
  try {
    conn = await assertMayUseConnection(workspaceId, secretName, piece, actingSubject);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 403) throw e;
    throw new StepError(`plugin tool "${tool.name}": ${(e as Error).message}`, 403);
  }
  const stored = await workspaceSecretRepo.getByName(workspaceId, secretName);
  if (!stored) {
    throw new StepError(`plugin tool "${tool.name}" needs its connection "${secretName}", which is not set in this workspace`, 424);
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(decrypt(stored.valueEnc)) as Record<string, unknown>;
  } catch {
    throw new StepError(`the connection "${secretName}" is not a plugin connection (expected its fields as JSON)`, 424);
  }
  return { auth: await freshConnection(workspaceId, secretName, piece, value), authType: conn.authType, connectionId: conn.id };
}

export type PluginItemResult = { ok: boolean; data?: unknown; error?: string; status: number; captured?: boolean };

/**
 * A piece's files arrive in the connector's answer (base64; the connector keeps none). They are put beside the output
 * as `files: [{name, bytes, base64}]` — the piece's own output usually names them — so a later step can use them.
 */
export function withFiles(output: unknown, files: ConnectorAnswer["files"]): unknown {
  if (!files?.length) return output;
  return output && typeof output === "object" && !Array.isArray(output) ? { ...(output as object), files } : { result: output ?? null, files };
}

/** Run a plugin tool once per item, in the mode the execution's environment decides. */
export async function invokePluginTool(
  workspaceId: string,
  tool: Tool,
  items: Array<Record<string, unknown>>,
  runId?: string,
  opts: {
    /**
     * ⚠ Only for a change a PERSON confirmed on a Forge Agent card (`pi-builder/agent-changes.ts`): `execute` without a
     * live run. Every other caller decides by the run.
     */
    confirmed?: boolean;
    /** The connection to use instead of the tool's own (the person's own connection, when that is the one chosen). */
    secretName?: string | null;
    /** Whom the call is made for. A personal connection is refused for anyone else, and when this is absent. */
    actingSubject?: string | null;
  } = {},
): Promise<{ results: PluginItemResult[]; mode: "capture" | "execute" }> {
  const ref = parsePluginUrl(tool.url);
  if (!ref) throw new StepError(`tool "${tool.name}" has a malformed plugin address`, 500);
  const env = opts.confirmed ? "live" : runId ? await envForExecution(runId) : "draft";
  const mode = env === "live" ? "execute" : "capture";
  const { auth, authType, connectionId } = await connectionFields(workspaceId, tool, ref.piece, opts.secretName ?? tool.secretEnvName, opts.actingSubject);
  // A declared call (plans/declared-api-calls-2026-10-29) carries its declaration; the connector rebuilds the request
  // from it and refuses one that does not hash to the address. One whose row is gone fails by name.
  let declared: unknown;
  if (ref.action.startsWith(DECLARED_PREFIX)) {
    const row = await pluginRepo.declaredCall(workspaceId, ref.piece, ref.action.slice(DECLARED_PREFIX.length));
    if (!row) throw new StepError(`plugin tool "${tool.name}": its declared call is not in this workspace any more`, 409);
    declared = row.declaration;
  }

  const results: PluginItemResult[] = [];
  for (const props of items) {
    const { status, answer } = await callConnector({
      piece: ref.piece,
      version: ref.version,
      action: ref.action,
      ...(declared ? { declared } : {}),
      props,
      auth,
      authType,
      mode,
      runId: runId ?? null,
      workspaceId,
      // The piece's memory is per CONNECTION: one person's own never shares it with another's or the workspace's.
      connectionId: connectionId ?? null,
    });
    // Not installed / unauthorised / a connection the piece cannot use: the same for every item — systemic.
    if (status === 401 || answer.kind === "unknown_piece" || answer.kind === "install" || answer.kind === "version_mismatch") {
      throw new StepError(`plugin tool "${tool.name}": ${answer.error ?? `connector answered ${status}`}`, 502);
    }
    if (answer.ok) {
      results.push({
        ok: true,
        status: 200,
        captured: answer.captured === true,
        data: answer.captured
          ? { captured: true, wouldRun: ref.action, with: answer.props, note: "a test run records this call and does not perform it" }
          : withFiles(answer.output, answer.files),
      });
    } else {
      results.push({ ok: false, status, error: `${answer.kind ?? "failed"}: ${answer.error ?? ""}`.trim() });
    }
  }
  return { results, mode };
}

// ── Enabling a piece's actions in a workspace (what the admin screen will do) ─────────────────────────────────────

/** One action as the connector describes it (packages/connector/src/describe.mjs). */
export type PieceActionDescription = {
  name: string;
  displayName: string;
  description: string;
  classification: string | null;
  writes: boolean;
  destructive: boolean;
  idempotent: boolean | null;
  params: Record<string, { type: string; required: boolean; description: string }>;
  unsupported: string[];
};
export type PieceAuthField = {
  name: string;
  label?: string;
  type: string;
  required: boolean;
  secret: boolean;
  description: string;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: unknown }>;
};
export type PieceAuth = {
  type: string;
  displayName: string | null;
  description?: string;
  required: boolean;
  /** Whether the piece itself can test a connection of this kind. */
  checks?: boolean;
  fields?: PieceAuthField[];
  oauth?: OauthDecl;
};
export type PieceDescription = {
  name: string;
  version: string;
  integrity?: string;
  license?: string | null;
  displayName: string;
  description?: string;
  logoUrl?: string;
  categories?: string[];
  auth: PieceAuth[];
  actions: PieceActionDescription[];
  triggers?: number;
  /** Approved hosts (set at install) and hosts the bundle names (a suggestion only). */
  hosts?: string[];
  suggestedHosts?: string[];
};

/** Any connector route but /run. Throws `StepError` carrying the connector's status and its own words. */
export async function connectorRequest<T>(path: string, body?: unknown, timeoutMs = 300_000): Promise<T> {
  if (!config.plugins.url || !config.plugins.secret) {
    throw new StepError("connectors are not set up on this deployment (PLUGINS_CONNECTOR_URL / PLUGINS_CONNECTOR_SECRET)", 503);
  }
  let res: Response;
  try {
    res = await fetch(`${config.plugins.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-connector-secret": config.plugins.secret },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new StepError(`the connector service could not be reached: ${(e as Error).message}`, 502);
  }
  const answer = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new StepError(answer.error ?? `the connector service answered ${res.status}`, res.status === 401 ? 502 : res.status);
  return answer;
}

export async function connectorPieces(): Promise<PieceDescription[]> {
  return (await connectorRequest<{ pieces: PieceDescription[] }>("/pieces", undefined, 30_000)).pieces;
}

/** The Foundry tool name for a piece's action: `amazon_s3_upload_file`, `service_now_create_record`. */
export function pluginToolName(piece: string, action: string): string {
  const short = piece.replace("@activepieces/piece-", "").replace(/-/g, "_");
  const a = action.replace(/-/g, "_").toLowerCase();
  return a.startsWith(`${short}_`) ? a : `${short}_${a}`;
}

/** What a person (and the builder) reads about the action: the piece's own description, plus what it does to the world. */
export function toolDescription(p: PieceDescription, a: PieceActionDescription): string {
  const effect = a.destructive
    ? "DELETES or irreversibly changes data in"
    : a.writes
      ? "CHANGES data in"
      : "Only reads from";
  return `${p.displayName} — ${a.displayName}. ${a.description} (${effect} ${p.displayName}. A test run records a change and does not perform it.)`;
}

/**
 * Store a connection and enable chosen actions of an installed piece as tools of this workspace. Idempotent: a tool
 * of the same name is updated. The connection's fields are stored ENCRYPTED in `workspace_secrets` as one JSON value.
 */
export async function enablePluginActions(input: {
  workspaceId: string;
  piece: string;
  actions: string[];
  connection: { name: string; fields: Record<string, unknown> };
}): Promise<Tool[]> {
  const p = (await connectorPieces()).find((x) => x.name === input.piece);
  if (!p) throw new StepError(`${input.piece} is not installed in the plugin connector`, 404);
  await workspaceSecretRepo.upsertByName({
    workspaceId: input.workspaceId,
    name: input.connection.name,
    description: `${p.displayName} connection (plugin)`,
    kind: "tool",
    valueEnc: encrypt(JSON.stringify(input.connection.fields)),
  } as never);
  const existing = await toolRepo.listByWorkspace(input.workspaceId);
  const out: Tool[] = [];
  for (const actionName of input.actions) {
    const a = p.actions.find((x) => x.name === actionName);
    if (!a) throw new StepError(`${p.name} has no action "${actionName}"`, 404);
    if (a.unsupported.length) throw new StepError(`${p.name} ${actionName} is not offered: ${a.unsupported.join("; ")}`, 422);
    const row = {
      workspaceId: input.workspaceId,
      name: pluginToolName(p.name, a.name),
      url: pluginUrl({ piece: p.name, version: p.version, action: a.name }),
      method: "POST",
      description: toolDescription(p, a),
      paramsSchema: a.params,
      secretEnvName: input.connection.name,
      authStyle: null,
      isActive: true,
    };
    const prior = existing.find((t) => t.name === row.name);
    out.push((prior ? await toolRepo.update(input.workspaceId, prior.id, row) : await toolRepo.create(row))!);
  }
  return out;
}
