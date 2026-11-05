/**
 * **The one place in this server that dials a registered tool.**
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * Every block in here was inline in `invokeTool` (tool-probe plan Decision 1),
 * and it all had exactly one caller — a flow execution. The "Test this tool"
 * button is the second caller, and the tempting version of that button is three
 * lines of `fetch` in the probe service. That version is the entire bug class the
 * button exists to remove: **a probe that presents a credential even slightly
 * differently from execution returns green for a tool that 401s in a run**, which
 * is precisely the confusion WS-B.4's declared auth style and the 424 were added
 * to end. So the dial is extracted, shared, and pinned by a grep test
 * (`tool-invoke-single-dial.test.ts`): one `guardedFetch(` for tool calls under
 * `packages/server/src`, and it is the one below.
 *
 * ⚠ **NOTHING IN HERE CHANGED BEHAVIOUR WHEN IT MOVED.** The controls are the
 * pre-existing suites, not the new ones: `step-execution.test.ts`,
 * `mail-end-to-end.test.ts`, `egress-parity.test.ts` and `tool-auth-schema.test.ts`
 * pass **unedited** across the extraction. A test that needs editing to
 * accommodate this move is evidence the move changed semantics — fix the code.
 *
 * ── What is NOT here ─────────────────────────────────────────────────────────
 *
 * Batching, per-item results, the partial-failure warning, the all-failed 502 and
 * the response-size warnings stay in `step-execution.service.ts`. Those are step
 * semantics; this module knows about one call.
 */
import { z } from "zod";
import { guardedFetch, PERMISSIVE } from "@foundry/shared";
import type { Tool } from "../repositories/tool.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { shadowedSecretCollisions } from "./workspace-secret.service.js";
import { decrypt } from "../utils/encryptor.js";
import { StepError } from "./step-error.js";
import { assertNotConnectionCredential } from "./plugin-credentials.js";

/**
 * Everything needed to sign one call, resolved once per batch or per probe.
 *
 * ⚠ `value` is the secret itself. It exists only inside this process and only
 * for the life of the call — it must never be returned by an API, logged, or put
 * in a warning. `placement` is the reportable half: it says WHERE the credential
 * lands without saying what it is, which is what a person testing a tool actually
 * needs to see ("presented as `header:x-api-key`").
 */
export interface ResolvedToolAuth {
  /**
   * The style actually presented. ⚠ `oauth2_client_credentials` becomes
   * `"bearer"` here, exactly as it does at execution — the exchanged token is
   * presented as a bearer and never reaches `applyAuth`'s switch as its own
   * style.
   */
  style: string | null;
  paramName: string | null;
  /** ⚠ The secret. Never leaves this process. */
  value: string | undefined;
  /** Where it lands, for reporting: `header:x-api-key` · `query:api_key` · `authorization` · null. */
  placement: string | null;
}

/**
 * Apply a tool's declared auth style.
 *
 * WS-B.4 exists because `<secretRef env="K"/>` said a key existed but not where
 * it went, so the agent guessed between four styles and a wrong guess was a 401
 * the audit called `clean`. Here the guess is gone entirely: the style is
 * declared data and this is the only code that reads it.
 */
export function applyAuth(
  url: URL,
  headers: Record<string, string>,
  style: string | null,
  paramName: string | null,
  value: string | undefined,
): void {
  if (!style || style === "none") return;
  if (!value) {
    // Reached only when a tool declares a secret that has no stored value. The
    // 424 distinguishes "you have not configured this" from the 401 the upstream
    // API would return, which is the exact confusion `secrets/audit` exists for.
    throw new StepError(
      `tool declares auth style "${style}" but its secret has no value in this workspace`,
      424,
    );
  }
  switch (style) {
    case "bearer":
      headers["authorization"] = `Bearer ${value}`;
      break;
    case "header":
      if (!paramName) throw new StepError('auth style "header" requires authParamName', 500);
      headers[paramName.toLowerCase()] = value;
      break;
    case "query":
      if (!paramName) throw new StepError('auth style "query" requires authParamName', 500);
      url.searchParams.set(paramName, value);
      break;
    case "basic":
      // The stored value is "user:pass" — encoding it here means the raw pair
      // never has to be assembled anywhere else.
      headers["authorization"] = `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
      break;
    default:
      throw new StepError(`unknown auth style "${style}"`, 500);
  }
}
// ── OAuth2 client credentials ────────────────────────────────────────────────

/**
 * Cap on a cached client-credentials token's lifetime. The plan pins a SHORT
 * TTL: a bearer token IS a credential, and 300s bounds the damage window if
 * one leaks out of this process while staying far above a batch's needs. A
 * provider's `expires_in` is never trusted past this cap.
 */
const OAUTH2_TOKEN_MAX_TTL_MS = 300_000;
/** Safety margin subtracted from the provider's `expires_in`. */
const OAUTH2_TOKEN_SAFETY_MS = 30_000;
/** RFC 6749 allows omitting `expires_in`; a provider that does is treated as 1h. */
const OAUTH2_DEFAULT_EXPIRES_IN_SEC = 3600;

interface OAuth2TokenCacheEntry {
  token: string;
  expiresAt: number;
}

/**
 * In-process token cache, keyed by `(workspaceId, toolId)`. Per-TOOL (not
 * per-workspace) so two OAuth2 tools in one workspace keep their own tokens —
 * they are different clients, and the exchange is authenticated by each tool's
 * own pair of secrets. Keyed per-workspace so one tool id in two workspaces
 * cannot share a token minted with the other's client credentials.
 *
 * The map is deliberately unbounded in entry count: entries are tiny, live at
 * most 300s, and the only writers are tool steps, which are the same rate
 * that makes `results` batching a thing. A size cap here would be a second,
 * more surprising failure mode for zero measured benefit.
 */
const oauth2TokenCache = new Map<string, OAuth2TokenCacheEntry>();

/**
 * Resolve a bearer token for an `oauth2_client_credentials` tool — the
 * client-credentials exchange, RFC 6749 §4.4.
 *
 * ── The credential path ─────────────────────────────────────────────────────
 *
 * `clientIdSecretRef` / `clientSecretSecretRef` are env-var NAMES into
 * `workspace_secrets`, the same store `secretEnvName` reads — a client id and
 * client secret are credentials like any other, so they live where the others
 * do and are NEVER returned by any API. A ref that names nothing stored (or a
 * tool whose config lacks the refs) is the same misconfiguration `applyAuth`
 * reports as a 424: "you have not configured this", distinct from the 401 the
 * provider would answer.
 *
 * ── Systemic, so resolved BEFORE the batch ──────────────────────────────────
 *
 * Every item in the batch would present the same token, so the exchange is
 * done once per batch (like `secretValue`), and a failed exchange throws —
 * retrying would burn three fragment regenerations on a credential problem
 * that will not be fixed by a retry, matching `applyAuth`'s throw path below.
 *
 * ── The cache ───────────────────────────────────────────────────────────────
 *
 * TTL = `min(expires_in − 30s safety, 300s cap)`, so a provider's short
 * expiry is honoured (minus the safety margin so a token is never used within
 * its final seconds) and a long one is clamped. A provider that answers
 * `expires_in` below the safety margin gets a negative TTL — the entry is
 * already expired and every call re-exchanges, which is the safe failure mode
 * (never use a token we suspect is dying) rather than a bug to clamp away.
 * Values live only in this process: no DB column, no log line, no Kestra env.
 */
async function resolveOAuth2Bearer(workspaceId: string, tool: Tool): Promise<string> {
  const key = `${workspaceId}:${tool.id}`;
  const cached = oauth2TokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  if (!tool.tokenUrl || tool.clientIdSecretRef == null || tool.clientSecretSecretRef == null) {
    // Unreachable through the API (create/update superRefine requires the trio
    // with the style), reachable from a row written before the rule or by a
    // direct DB write. Same 424 as a missing stored value: from the caller's
    // point of view the OAuth2 client credential is simply not configured in
    // this workspace.
    throw new StepError(
      `tool "${tool.name}" declares oauth2_client_credentials but is missing ` +
        "tokenUrl/clientIdSecretRef/clientSecretSecretRef — no OAuth2 client credential " +
        "configured in this workspace",
      424,
      { missing: ["tokenUrl", "clientIdSecretRef", "clientSecretSecretRef"] },
    );
  }

  const [clientIdRow, clientSecretRow] = await Promise.all([
    workspaceSecretRepo.getByName(workspaceId, tool.clientIdSecretRef),
    workspaceSecretRepo.getByName(workspaceId, tool.clientSecretSecretRef),
  ]);
  const missing = [
    clientIdRow ? null : tool.clientIdSecretRef,
    clientSecretRow ? null : tool.clientSecretSecretRef,
  ].filter((n): n is string => n !== null);
  if (missing.length > 0) {
    throw new StepError(
      `tool "${tool.name}" cannot get an OAuth2 token: client credential secret(s) ` +
        `${missing.join(", ")} have no value in this workspace`,
      424,
      { missing },
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: decrypt(clientIdRow!.valueEnc),
    client_secret: decrypt(clientSecretRow!.valueEnc),
  });

  let res: Response;
  try {
    res = await fetch(tool.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (e) {
    throw new StepError(
      `tool "${tool.name}" OAuth2 token exchange failed: ${(e as Error).message}`,
      502,
    );
  }

  // RFC 6749 §5.1 — schema-parsed because the response is external input; the
  // known fields are read explicitly and everything else is ignored.
  const tokenResponseSchema = z
    .object({
      access_token: z.string().optional(),
      expires_in: z.number().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .passthrough();
  let parsed: z.infer<typeof tokenResponseSchema>;
  try {
    parsed = tokenResponseSchema.parse(await res.json());
  } catch {
    parsed = {};
  }
  if (!res.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    // detail carries only the RFC 6749 error fields, never the request body —
    // a broken provider echo could otherwise leak the client secret into logs.
    const detail: Record<string, unknown> = { status: res.status };
    if (typeof parsed.error === "string") detail.error = parsed.error.slice(0, 200);
    if (typeof parsed.error_description === "string") {
      detail.errorDescription = parsed.error_description.slice(0, 500);
    }
    throw new StepError(
      `tool "${tool.name}" OAuth2 token exchange failed (HTTP ${res.status})`,
      502,
      detail,
    );
  }

  const expiresInSec =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in
      : OAUTH2_DEFAULT_EXPIRES_IN_SEC;
  const ttlMs = Math.min(expiresInSec * 1000 - OAUTH2_TOKEN_SAFETY_MS, OAUTH2_TOKEN_MAX_TTL_MS);
  oauth2TokenCache.set(key, { token: parsed.access_token, expiresAt: Date.now() + ttlMs });
  return parsed.access_token;
}

/**
 * Test seam — the cache lives for the life of the process, so a suite that
 * exercises the exchange must be able to start from a cold cache.
 */
export function resetOAuth2TokenCache(): void {
  oauth2TokenCache.clear();
}

/**
 * Describe where a credential will land, without saying what it is.
 *
 * ⚠ Derived from the same two fields `applyAuth` switches on, in the same
 * module, deliberately. A second function elsewhere that "knows" bearer means
 * the `authorization` header is a copy that goes stale the day a style is added
 * — and the way it goes stale is that a probe reports the wrong placement, which
 * is worse than reporting none.
 */
function placementFor(style: string | null, paramName: string | null): string | null {
  if (!style || style === "none") return null;
  switch (style) {
    case "bearer":
    case "basic":
      return "authorization";
    case "header":
      return paramName ? `header:${paramName.toLowerCase()}` : "header";
    case "query":
      return paramName ? `query:${paramName}` : "query";
    default:
      return style;
  }
}

/**
 * Resolve a tool's credential ONCE — collision refusal, decrypt, OAuth2 exchange.
 *
 * ⚠ **Once per batch, not once per item.** Every item of a batch presents the
 * same credential, so resolving per item would multiply the collision query and
 * the token exchange by the batch size. It also fixes the failure semantics: a
 * credential problem is systemic — every item would fail identically — so it
 * throws here, before any call goes out, rather than producing N identical
 * per-item failures that look like a flaky endpoint.
 */
export async function resolveToolAuth(workspaceId: string, tool: Tool): Promise<ResolvedToolAuth> {
  /**
   * ⚠ A connected service's credential is for its own `plugin://` actions only (plugins 8.1). A hand-made tool naming
   * one would send that account's token — the workspace's, or a person's own — to whatever address the tool has.
   * Refused before anything is decrypted; the same rule refuses it when the tool is saved (tool.service.ts).
   */
  try {
    await assertNotConnectionCredential(workspaceId, [tool.secretEnvName, tool.clientIdSecretRef, tool.clientSecretSecretRef], "cannot be used by a hand-made tool");
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 403) throw e;
    throw new StepError(`tool "${tool.name}" cannot run: ${(e as Error).message}`, 403);
  }
  let secretValue: string | undefined;
  if (tool.secretEnvName) {
    /**
     * ⚠ WS-B.1's refusal, and until 2026-08-10 it had NO CALL SITE (I-120).
     *
     * `CLAUDE.md` and two docblocks in `workspace-secret.service.ts` state that
     * *"a name collision fails the execution (409) rather than last-write-wins —
     * a shadowed credential must present as a wrong key, not as a silent
     * misconfiguration."* That was implemented in `resolveForExecution`, whose
     * only production caller is the AUDIT: the executor that consumed it was
     * deleted in Kestra Phase 4, and a `code` fragment gets no environment at
     * all. So the sentence described a control that did not run, and the value
     * was resolved inline with no cross-declaration comparison — exactly the
     * silent shadowing those comments say must never happen.
     *
     * ⚠ Checked BEFORE the value is decrypted and used, not after. A refusal
     * that fires after the call has gone out is a log line, not a control.
     *
     * ⚠ `shadowedSecretCollisions` is scoped to this ONE name and filters before
     * decrypting, so it does not read the workspace's other credentials.
     */
    const collisions = await shadowedSecretCollisions(workspaceId, tool.secretEnvName);
    if (collisions.length > 0) {
      throw new StepError(
        `tool "${tool.name}" cannot run: ${collisions.join("; ")}`,
        409,
        {
          envName: tool.secretEnvName,
          collisions,
          // Named because the fix is a rename, and the person reading this has to
          // know which of the two owners to change.
          remedy:
            `Two things in this workspace declare "${tool.secretEnvName}" with different values, ` +
            `so one would silently shadow the other. Rename one of them ` +
            `(GET /api/workspaces/:ws/secrets/:id/impact says what a rename breaks), ` +
            `or give them the same value if they are meant to be the same credential.`,
        },
      );
    }
    const stored = await workspaceSecretRepo.getByName(workspaceId, tool.secretEnvName);
    if (stored) secretValue = decrypt(stored.valueEnc);
  }

  /**
   * OAuth2 client credentials: exchange (or reuse the cached) bearer token ONCE.
   * A failed exchange throws here, before any item is attempted, because it is
   * systemic in exactly the way the missing-value branch in `applyAuth` is.
   */
  let oauth2Bearer: string | undefined;
  if (tool.authStyle === "oauth2_client_credentials") {
    oauth2Bearer = await resolveOAuth2Bearer(workspaceId, tool);
  }

  const style = oauth2Bearer !== undefined ? "bearer" : tool.authStyle;
  return {
    style,
    paramName: tool.authParamName,
    value: oauth2Bearer !== undefined ? oauth2Bearer : secretValue,
    placement: placementFor(style, tool.authParamName),
  };
}

/**
 * Fill a registered URL's path parameters from the call's params (phase 7, R03).
 *
 * A tool can be registered with a path template — `…/hr/employees/{id}/manager`
 * — and its `id` parameter is the path segment. `invokeTool` never substituted
 * it: the value went to the query string (`?id=2`), `new URL()` percent-encoded
 * the braces, and the service answered "id must be an integer, got \"{id}\"" on
 * every call. So every tool with a path parameter was uncallable from any flow.
 *
 * Each `{name}` is replaced by its value, URL-encoded (a value cannot add a path
 * segment or a query), and that name is removed from what goes to the query or
 * body. A placeholder with no value is refused BEFORE anything is sent — a
 * request to `…/employees/{id}` is never correct. Only scalars fill a path.
 */
export function fillPathParams(
  toolName: string,
  urlTemplate: string,
  params: Record<string, unknown>,
): { url: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...params };
  const url = urlTemplate.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === "") {
      throw new StepError(`tool "${toolName}": its URL needs \`${name}\` and the call gave none`, 400);
    }
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new StepError(`tool "${toolName}": \`${name}\` fills a URL path segment and must be a single value, not ${Array.isArray(v) ? "a list" : "an object"}`, 400);
    }
    delete rest[name];
    return encodeURIComponent(String(v));
  });
  return { url, rest };
}

/**
 * ONE HTTP call to a registered tool: auth applied, egress-guarded, measured.
 *
 * ⚠ **The `timeoutMs` default is NO TIMEOUT, and that is deliberate.** Execution
 * passes nothing, so a flow's tool call behaves exactly as it did before this
 * module existed — Kestra owns a task's timeout, and adding one here would change
 * every existing flow's failure mode as a side effect of a refactor. The probe
 * passes one, because a person waiting on a button needs an answer.
 *
 * ⚠ **Returns the raw `text` AND its UTF-8 byte length** (tool-probe plan
 * Decision 9). Both callers need the size — `invokeTool` for
 * `StepItemResult.bytes` and the probe for `body.bytes` — and it is computed
 * **once, here**, because two callers each measuring the same string is how they
 * come to disagree about it. The text is returned unparsed: what a caller does
 * with it is the caller's semantics.
 */
export async function dialTool(args: {
  tool: Tool;
  auth: ResolvedToolAuth;
  method: string;
  params: Record<string, unknown>;
  runId?: string;
  timeoutMs?: number;
}): Promise<{
  status: number;
  statusText: string;
  contentType: string | null;
  text: string;
  bytes: number;
  durationMs: number;
}> {
  const { tool, auth, method, runId, timeoutMs } = args;
  if (!tool.url) throw new StepError(`tool "${tool.name}" has no URL`, 500);

  // A path parameter (`/employees/{id}/manager`) is filled from the call's own
  // params before the URL is built — see `fillPathParams`.
  const filled = fillPathParams(tool.name, tool.url, args.params);
  const params = filled.rest;
  const url = new URL(filled.url);
  const headers: Record<string, string> = { accept: "application/json" };
  if (runId) headers["x-foundry-run"] = runId;

  applyAuth(url, headers, auth.style, auth.paramName, auth.value);

  /**
   * The GET-params-vs-JSON-body rule, unchanged.
   *
   * ⚠ `undefined`/`null` values are SKIPPED on the query-string side. A screening
   * run whose optional filter is absent must not send `?period=undefined`, which
   * an endpoint reads as a literal string and answers unhelpfully.
   */
  let body: string | undefined;
  if (method === "GET" || method === "HEAD") {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(params);
  }

  const startedAt = Date.now();
  /**
   * FR-008 (research.md Decision 2) — `tool.url` is operator-registered and
   * re-checked immediately before dialing. The profile is PERMISSIVE, **NOT
   * STRICT** (D-32, 2026-08-13): this deployment's registered tools and demo
   * services live on private docker addresses — `host.docker.internal` resolves
   * to 172.17.0.1 (RFC 1918) — and STRICT egress-rejected every tool call in a
   * flow with `egress_rejected: rfc1918`, so no tested workflow could run against
   * the stack's real data. PERMISSIVE is the profile the port's own docblock names
   * for this deployment ("demo databases live there … refusing them would break
   * the stack"); it still denies link-local (the cloud metadata SSRF vector),
   * unspecified/broadcast and multicast. The LLM baseUrl check in `ops-proxy.ts`
   * keeps STRICT — that host is external. Datasource connections are NOT touched:
   * those rely on `datasource-target.service.ts`'s own, separate, already-tested
   * check (Decision 2's explicit scope boundary).
   *
   * ⚠ **THE PROBE USES THE SAME PROFILE AS EXECUTION, deliberately.** A probe on
   * STRICT would refuse the private-address tools this deployment is built on and
   * report them as broken; a probe on a laxer profile would green-light a host a
   * run will refuse. Either way the button lies about the thing it exists to
   * answer.
   */
  const res = await guardedFetch(
    url,
    {
      method,
      headers,
      body,
      // ⚠ Only when asked. See the docblock — execution passes nothing.
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    },
    PERMISSIVE,
  );
  const text = await res.text();

  return {
    status: res.status,
    statusText: res.statusText,
    /**
     * ⚠ **Optional-chained deliberately, and this is the one line in this module
     * that is not a straight move.** A real `Response` always has `headers`, so
     * this guard is not defending against the network — it is defending the
     * EXTRACTION's own control. `step-execution.test.ts`,
     * `mail-end-to-end.test.ts` and `egress-parity.test.ts` fake a response as
     * `{ ok, status, text } as unknown as Response`, which predates this module
     * and is the evidence that moving the dial changed no behaviour. Reading a
     * field the old code never read would have failed 25 of those assertions, and
     * "the tests pass once I edit the tests" is not the claim the gate is making.
     *
     * ⚠ `contentType` is REPORTED, never TRUSTED: the probe decides whether a
     * body is JSON by parsing it, because endpoints mislabel payloads and a
     * redaction pass that skips a JSON body because a header said `text/plain` is
     * a leak, not a formatting bug.
     */
    contentType: res.headers?.get("content-type") ?? null,
    text,
    // ⚠ On the raw text and before any parse — the parsed size is a different
    // number, and the one that matters is what crossed the wire.
    bytes: Buffer.byteLength(text, "utf8"),
    durationMs: Date.now() - startedAt,
  };
}
