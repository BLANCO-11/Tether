import { createHmac } from "node:crypto";
import { config } from "../config/index.js";

/**
 * The parent's view of `ops-api` — the operational tool layer on :4004.
 *
 * Everything the control plane needs from that service goes through here: the
 * five per-service tool credentials it registers, and the operator reads that
 * back the Outbox page and the harnesses.
 *
 * ── What this file is NOT ───────────────────────────────────────────────────
 *
 * It is not a database client. The parent has no credential for the ops
 * database and must not acquire one — that would leave Stage 5 half-done, the
 * tool layer in its own process but its data still directly readable and
 * writable by the process holding `PARENT_API_KEY` and
 * `CREDENTIAL_ENC_KEY`. Reads go over HTTP against an allowlist of four record
 * sets; there is no path from here to arbitrary SQL.
 */

export type OpsService = "hr" | "mail" | "chat" | "ticketing" | "probe" | "llm" | "paging";

/**
 * The env-var NAME each service's credential is stored and rendered under.
 *
 * ⚠ This table and `OPS_AUTH_STYLE` below are DUPLICATED in
 * `packages/ops-api/src/service-keys.ts`, deliberately. Read that file's
 * docblock before consolidating them: the short version is that redaction
 * drifting is silent and this drifting is loud — the two sides stop agreeing on
 * a value, the first tool call 401s, and the call log names the service. A
 * shared package would also make the control plane take a build dependency on
 * the service it registers, which is the wrong direction for four lines.
 */
export const OPS_SECRET_ENV: Record<OpsService, string> = {
  hr: "HR_DIRECTORY_TOKEN",
  mail: "MAIL_API_KEY",
  chat: "CHAT_ACCESS_TOKEN",
  // Unchanged from the pre-Stage-5 name, so an existing workspace secret and an
  // existing tool registration keep working.
  ticketing: "TICKETING_API_KEY",
  probe: "OPS_PROBE_BASIC",
  // ⚠ What a FLOW presents to ops-api's LLM tool — not the provider key ops-api
  // presents to the gateway. That one is operator configuration held inside
  // ops-api and never seeded into `workspace_secrets`, which is why this is not
  // called `LLM_API_KEY`: the parent must not appear to hold a billable
  // credential it does not have.
  llm: "LLM_TOOL_TOKEN",
  // ⚠ A page is not an email. Its own credential means a workspace can hold the
  // ability to send mail and NOT the ability to wake somebody at 03:00, and
  // revoking one leaves the other. See ops-api's `service-keys.ts`.
  paging: "PAGING_API_TOKEN",
};

/**
 * How each service expects its credential — mirrors `tools.auth_style` /
 * `tools.auth_param_name`, which is what the manifest renders. One identifier,
 * so the manifest, the registration and the endpoint cannot disagree.
 *
 * Each service accepts exactly ONE style and rejects the others even when the
 * value is right, so a wrong guess is detectable. All four styles are in use
 * across the five services on purpose: an automation that gets `bearer` right
 * has proved nothing about `query`, and the demo's value is that the mistake
 * is visible in `auth_ok` rather than absorbed.
 */
export const OPS_AUTH_STYLE: Record<
  OpsService,
  { style: "bearer" | "header" | "query" | "basic"; paramName: string | null }
> = {
  hr: { style: "bearer", paramName: null },
  mail: { style: "header", paramName: "X-Mail-Key" },
  chat: { style: "query", paramName: "access_token" },
  ticketing: { style: "header", paramName: "X-API-Key" },
  // `basic` expects the stored value to be `user:pass`; the executor base64s it.
  probe: { style: "basic", paramName: null },
  // Deliberately not `bearer`: that header is where ops-api puts the PROVIDER
  // key on the way out, and keeping the two in different places means a bug
  // confusing them 401s instead of forwarding a credential.
  llm: { style: "header", paramName: "X-LLM-Key" },
  // `bearer`, which is what real paging services use. `hr` is the other bearer
  // service and its credential is a different derivation, so presenting HR's
  // token here is a 401 rather than a cross-service pass.
  paging: { style: "bearer", paramName: null },
};

/**
 * The credential for one service, derived from the root key.
 *
 * Derived rather than five environment variables because two processes must
 * agree on the values, and five literals in compose is five chances for them to
 * be configured differently — with a 401 that names nothing as the symptom.
 * Must stay byte-identical to `opsServiceKey` in ops-api.
 */
export function opsServiceKey(service: OpsService, root = config.opsApiKey): string {
  const digest = createHmac("sha256", root)
    .update(`ops-api:${service}:v1`)
    .digest("hex")
    .slice(0, 40);
  return service === "probe" ? `probe:${digest}` : digest;
}

/**
 * The role ops-api reads `hr_demo` with, and its password.
 *
 * Deliberately NOT `foundry_ro`. That credential is handed to generated code —
 * encrypted into the `datasources` row, rendered into the manifest, run by a
 * `datasource` step. Sharing it would mean one leak compromises both consumers,
 * and that revoking the script credential in an incident silently takes the tool
 * layer down too.
 *
 * The password derives from `OPS_API_KEY`, not `CREDENTIAL_ENC_KEY` — ops-api
 * must never hold the latter, since it decrypts every stored credential in
 * `foundry_parent`. Deriving from the ops root lets that process compute its own
 * database password from something it is already trusted with. Mirrored
 * byte-for-byte in `packages/ops-api/src/config.ts`; see `opsServiceKey` above
 * for why the duplication is acceptable here and not for redaction.
 *
 * The role is created and granted by `ensureOpsHrRole()`, which must run AFTER
 * the schema DDL — `hr-schema.sql` drops every table and table privileges die
 * with the table.
 */
export const opsHrRoRole = () => process.env.OPS_HR_RO_ROLE ?? "ops_ro";

export function opsHrRoPassword(root = config.opsApiKey): string {
  return createHmac("sha256", root).update("ops-api:hr-ro:v1").digest("hex").slice(0, 32);
}

/** The four record sets the operator surface will serve. Not a table name. */
// ⚠ `pages` added 2026-09-03 with the paging service. It is a FIFTH capture
// table, not a view over `mail` — a page is an interrupt paid for by a person,
// and "how many times did this automation wake somebody" has to be a row count
// rather than a substring search over an outbox.
export type OpsRecordSet = "mail" | "chat" | "tickets" | "pages" | "call-log";

export interface OpsCallLogRow {
  id: string;
  toolName: string | null;
  method: string;
  path: string;
  query: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  statusCode: number;
  resultCount: number | null;
  durationMs: number | null;
  authPresented: boolean | null;
  authOk: boolean | null;
  authVia: string | null;
  /**
   * The Foundry execution that made this call — Phase 7.2, I-110.
   *
   * ⚠ NULL for a call made by a person, a harness, or any run from before this
   * shipped. Absent is a real answer and must render as "not attributable to a
   * run", never be filled in from a timestamp.
   */
  runId: string | null;
  calledAt: string;
}

/** ops-api's provider config as an operator may see it. Has no key, by design. */
export interface LlmProviderView {
  configured: boolean;
  baseUrl: string;
  /** 8 hex of a salted digest — tells two keys apart, reconstructs neither. */
  keyFingerprint: string;
  defaultModel: string;
  allowedModels: string[];
  /** `env` until an operator saves a row; `configured` afterwards. */
  source: "env" | "configured";
  updatedAt: string | null;
}

export interface LlmProviderUpdate {
  baseUrl: string;
  /** Omit to keep the stored key. The empty string is refused, not stored. */
  apiKey?: string;
  defaultModel: string;
  allowedModels: string[];
}

export interface LlmTestResult {
  ok: boolean;
  model?: string;
  text?: string;
  latencyMs?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export class OpsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${config.opsAdminBase}/admin${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${config.opsApiKey}` },
    });
  } catch (e) {
    // Name the service and the URL. "fetch failed" against a service that only
    // came into existence in Stage 5 is otherwise read as a parent-side bug.
    throw new OpsApiError(
      503,
      `ops-api unreachable at ${config.opsAdminBase} (${(e as Error).message}) — ` +
        `is the ops-api container up? OPS_ADMIN_BASE overrides the address. ` +
        `Note this is NOT OPS_API_BASE: that one is stored on tool rows and must ` +
        `resolve from the parent container; this one must resolve from here.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpsApiError(res.status, `ops-api ${res.status} for ${path}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const opsClient = {
  /** Newest-first rows from one of the four capture tables. */
  async records<T = Record<string, unknown>>(set: OpsRecordSet, limit = 100): Promise<T[]> {
    const r = await admin<{ records: T[] }>(`/records/${set}?limit=${limit}`);
    return r.records;
  },

  /** The call log, typed — the one record set anything here reasons about. */
  callLog(limit = 200): Promise<OpsCallLogRow[]> {
    return this.records<OpsCallLogRow>("call-log", limit);
  },

  /**
   * Truncate all four capture tables.
   *
   * `demo:reset` and every harness that used to run
   * `TRUNCATE stub_mail_outbox, …` calls this. It also resets the flaky probe's
   * attempt counter, which is derived from the call log rather than kept in
   * memory — so a retry test that reruns starts from a real first attempt.
   */
  reset(): Promise<{ ok: true; truncated: string[] }> {
    return admin("/reset", { method: "POST" });
  },

  /**
   * Clear ONE capture table. The Email box's "Clear test inbox" button rides
   * this with `"mail"`.
   *
   * ⚠ This is deliberately NOT `reset()`. Reset truncates all five tables plus
   * the flaky probe's attempt counter; a button labelled "clear inbox" must not
   * wipe chat, tickets, pages and the call log as a side effect.
   */
  clearRecords(set: OpsRecordSet): Promise<{ ok: true; cleared: number; set: OpsRecordSet }> {
    return admin(`/records/${set}`, { method: "DELETE" });
  },

  /**
   * The LLM provider configuration — read, write, discover, prove.
   *
   * ⚠ The parent is a PASS-THROUGH here and holds nothing. The provider key is
   * posted once, stored inside ops-api and never returned by any of these calls;
   * `keyFingerprint` is what comes back instead. That is deliberate and matches
   * the rule the parent has always followed for `workspace_secrets` — there is
   * no endpoint that returns a secret value and no `?reveal=` — because a
   * configuration page is exactly where that rule gets broken "so the operator
   * can check what they pasted".
   */
  llm: {
    get(): Promise<LlmProviderView> {
      return admin("/llm/provider");
    },
    save(body: LlmProviderUpdate): Promise<LlmProviderView> {
      return admin("/llm/provider", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    clear(): Promise<LlmProviderView> {
      return admin("/llm/provider", { method: "DELETE" });
    },
    /**
     * What the gateway advertises. Optionally against not-yet-saved credentials,
     * so the page can populate a model list the moment a key is pasted.
     *
     * ⚠ Listing models is NOT evidence the key works — it is the same false
     * green as an `llmConnected: true` derived from a model listing. `test()` is.
     */
    models(probe?: { baseUrl?: string; apiKey?: string }): Promise<{ models: string[]; caveat: string }> {
      return admin("/llm/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probe ?? {}),
      });
    },
    /** A real completion. The only thing that proves the configuration works. */
    test(probe?: { baseUrl?: string; apiKey?: string; model?: string }): Promise<LlmTestResult> {
      return admin("/llm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probe ?? {}),
      });
    },
  },

  /** Liveness, and which databases the service can actually reach. */
  async health(): Promise<{ ok: boolean; databases: { ops: boolean; hr: boolean } }> {
    const res = await fetch(`${config.opsAdminBase}/healthz`).catch(() => null);
    if (!res) return { ok: false, databases: { ops: false, hr: false } };
    return (await res.json()) as { ok: boolean; databases: { ops: boolean; hr: boolean } };
  },
};

/**
 * How many times a tool was called — the question every harness actually asks of
 * the call log ("did the automation send mail, or only say it did?").
 *
 * A helper rather than each caller filtering, because the filter has a trap in
 * it: a 401 is logged too, so counting rows by `toolName` alone counts calls
 * that never reached the handler. `succeededOnly` is the default for that
 * reason.
 */
export async function countToolCalls(
  toolName: string,
  { succeededOnly = true, limit = 500 } = {},
): Promise<number> {
  const rows = await opsClient.callLog(limit);
  return rows.filter(
    (r) => r.toolName === toolName && (!succeededOnly || (r.statusCode >= 200 && r.statusCode < 300)),
  ).length;
}
