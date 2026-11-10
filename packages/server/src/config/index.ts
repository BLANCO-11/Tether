import crypto from "node:crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load the repo-root .env (packages/server/../../.env) then a local override.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config(); // local .env in cwd, if any (does not override already-set vars)

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/**
 * An operator-set service address, checked at load rather than at first use.
 *
 * A base URL accepted as a bare string fails at the first request instead — as an
 * opaque `fetch failed` from inside a client class, minutes or hours after boot,
 * naming neither the variable nor the value. `new URL()` is the check; the
 * protocol test is what rejects the two mistakes that still parse (`localhost:6800`
 * parses with protocol `localhost:`, and a bare path does not parse at all). The trailing slash is trimmed exactly as before.
 */
function absoluteHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${name} must be an absolute URL including the scheme, e.g. http://127.0.0.1:6800 — got "${value}"`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be http:// or https:// — got "${parsed.protocol}" in "${value}"`);
  }
  return value.replace(/\/$/, "");
}

/**
 * Password for the demo read-only role (WS-A.3).
 *
 * DERIVED, not random, when DEMO_DB_RO_PASSWORD is unset. The plan asks for a
 * password generated at provision time, but `demo:reset` reseeds without going
 * through provisioning, so a fresh random password each seed would leave the DSN
 * already encrypted into `datasources.connection_string_enc` pointing at a
 * credential the server just rotated away — every generated script would then
 * fail to authenticate for a reason nothing reports. Deriving it from
 * CREDENTIAL_ENC_KEY keeps it out of source and out of logs while staying stable
 * across reseeds; set DEMO_DB_RO_PASSWORD to rotate deliberately (provision and
 * reset both re-register the DSN, so rotation is a one-command change).
 */
function derivedRoPassword(): string {
  return crypto
    .createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
    .update("hr_demo:read-only-role:v1")
    .digest("hex")
    .slice(0, 32);
}

/**
 * At module scope, not inside `config`, so `isSuperAdmin` and
 * `superAdminConfigured` can read it without `config` referencing itself during
 * type inference. Mutable by tests (`superAdminEmails` is the same Set object),
 * which is what `workspace-member.test.ts` already relies on.
 */
const SUPER_ADMIN_ALLOWLIST = new Set(
  (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// `PLUGINS_POC` no longer does anything: connectors are on exactly when the connector is configured (see `plugins` below).
if (process.env.PLUGINS_POC !== undefined) {
  console.warn("PLUGINS_POC is no longer read: connectors are on when PLUGINS_CONNECTOR_URL and PLUGINS_CONNECTOR_SECRET are set. Remove it from the environment.");
}

/**
 * One fallback model (2026-11-04). The deployment has one model connection, one enabled-model list and one default
 * model, saved on the AI models page. `LLM_MODEL` is the fallback for all of them (workflows, the builder, Forge) and is
 * used only when no model connection is saved there. `LLM_REASONING_MODEL` then `LLM_FAST_MODEL` are still read, in that
 * order, so existing .env files keep working. `||`, not `??`: an empty `LLM_MODEL=` line falls through to them.
 */
const fallbackModel = process.env.LLM_MODEL || process.env.LLM_REASONING_MODEL || process.env.LLM_FAST_MODEL || "";

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  wsPort: Number(process.env.WS_PORT ?? 4001),
  parentApiKey: process.env.PARENT_API_KEY ?? "dev-parent-key",
  /**
   * Identities granted access to EVERY workspace at the highest role
   * ("super admin") — a comma-separated list of identity **subjects or
   * emails**. Server-side env only, never a client-settable claim.
   *
   * ⚠ **THIS IS LOAD-BEARING, NOT OPTIONAL, AND IT USED TO BE.** Until the
   * super-admin-assignment feature there was a self-service bootstrap —
   * `POST …/members/claim`, the first signed-in caller became a workspace's
   * admin. That is deleted, so **assigning a member is now the only way a
   * workspace gets its first one, and only a super admin may assign.** On an
   * empty allowlist every memberless workspace is unmanageable over HTTP. That
   * state is surfaced rather than left to be discovered: `superAdminConfigured`
   * below, `GET /api/me`, and both refusals in `requireSuperAdmin` name this
   * variable.
   *
   * ⚠ **Matching is subject OR email, and the "or" is a bug fix.** It was
   * `superAdminEmails.has(subject)` — subject only, from a variable named
   * `…_EMAILS`. A `FoundryIdentity.subject` is the token's `sub`: for an Entra
   * sign-in that is the **OID**, a GUID, so a deployment that listed emails
   * (i.e. did what the name says) granted nothing, silently, with a correct
   * value in a correct variable. The local credentials account is the reason it
   * ever appeared to work — its subject is the literal `local-admin` and its
   * email is a real address, so listing either matched.
   *
   * It is an ACCESS grant only. Every accountability gate downstream — the
   * self-approval refusal, the run-requester refusal, provenance escalation —
   * still applies, so a super admin approving a flow they authored is refused
   * exactly like anybody else. ⚠ Never describe it as separation of duties
   * (I-13): anything holding `RUNTIME_JWT_SECRET` mints any identity.
   */
  superAdminEmails: SUPER_ADMIN_ALLOWLIST,
  get superAdminConfigured(): boolean {
    return SUPER_ADMIN_ALLOWLIST.size > 0;
  },
  /**
   * Is this identity a super admin? **The one predicate** — see D-1.
   *
   * There are three call sites (`workspaceMemberService.check`,
   * `requireSuperAdmin`, `requirePlatformPermission`) and three copies of a
   * membership test on an env allowlist would drift in the direction where the
   * untested copy stops matching — which is precisely how the subject-only bug
   * above survived. Email compares case-insensitively because an address is not
   * case-sensitive in the half anybody types; a subject compares exactly
   * because it is an opaque identifier and folding it would be inventing a
   * match rule for somebody else's namespace.
   */
  isSuperAdmin(identity: { subject?: string | null; email?: string | null } | null | undefined): boolean {
    if (!identity) return false;
    const allow = SUPER_ADMIN_ALLOWLIST;
    if (allow.size === 0) return false;
    if (identity.subject && allow.has(identity.subject)) return true;
    const email = identity.email?.trim().toLowerCase();
    if (!email) return false;
    for (const entry of allow) if (entry.toLowerCase() === email) return true;
    return false;
  },
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://foundry:foundry@localhost:5433/foundry_parent",
  ),
  // ⚠ No `redisUrl`. There was one, defaulted, and read by nothing — see the
  // removal note in infra/docker-compose.yml (archive/GAPS.md 6.4). A config key with a
  // working default is the cheapest way to make a dead dependency look live:
  // it type-checks, it autocompletes, and the first person to `config.redisUrl`
  // their way into a queue gets a connection error at run time rather than a
  // compile error at the moment they made the assumption.
  /**
   * Kestra — the flow engine (archive/kestra-migration/). Unmodified, single
   * instance, sitting BEHIND Foundry: Foundry calls it the way it calls
   * Postgres. Clients never reach it and `kestra-ui` is never exposed (R5).
   */
  kestra: {
    /**
     * ⚠ **Checked at load, where the message can name the variable.** It was a
     * bare string with the trailing slash trimmed, so a typo — a bare host, a
     * value that picked up a comment, an accidental `${VAR}` Compose resolved to
     * empty — booted cleanly and failed later inside `KestraClient` as an opaque
     * fetch error, on the first call of the first run.
     *
     * ⚠ This validator's previous subject was the agent runtime's address, and
     * it moved here rather than being deleted with it. The two mistakes it
     * catches (`localhost:8080` parses with protocol `localhost:`; a bare path
     * does not parse at all) are properties of operator-set addresses, not of
     * that runtime — and Kestra is the one this process cannot work without.
     *
     * ⚠ Deliberately NOT an egress check. Kestra legitimately lives on loopback
     * here, so STRICT would refuse the correct value; `@foundry/shared`'s egress
     * profiles are for TENANT-supplied addresses and this is not one.
     */
    baseUrl: absoluteHttpUrl(
      "KESTRA_BASE_URL",
      process.env.KESTRA_BASE_URL?.trim() || "http://127.0.0.1:8080",
    ),
    /**
     * Foundry's credential FOR Kestra, as a full `Authorization` header value
     * (e.g. `Basic base64(user:pass)`). Empty means unauthenticated, which is
     * only acceptable while Kestra is bound to localhost.
     *
     * This is the Foundry → Kestra direction. The opposite direction (Kestra →
     * Foundry, on every step callback) uses a short-lived execution-scoped token
     * instead, so that tenancy is resolved FROM the token and Kestra never
     * receives, stores or asserts a tenantId (R3).
     */
    auth: process.env.KESTRA_AUTH ?? "",
    /**
     * Root namespace segment, prepended to every tenant namespace. The tenant
     * prefix inside a namespace is MANDATORY (§5.0): two clients will both have
     * a workspace called `HR`, and a namespace collision across tenants is a
     * cross-tenant data leak.
     */
    // ⚠ BLANK means the default, not "": `.env.example` shipped `KESTRA_NAMESPACE_PREFIX=` empty, and with `??` an
    // env copied from it made the prefix "" — then no namespace parsed as live, so every LIVE run was taken for a
    // draft (mail captured instead of sent, reads from the sandbox). Found by mail.test.ts (2026-10-13).
    namespacePrefix: process.env.KESTRA_NAMESPACE_PREFIX?.trim() || "foundry",
    /**
     * The ONE secret Kestra holds (R2). Presented on `POST /api/executions/begin`
     * — the flow's first task — which is the only step callback that cannot
     * carry an execution token, because `begin` is what mints it.
     *
     * It is a bootstrap credential, not an authorisation: it proves the caller
     * is our Kestra and nothing more. Everything after `begin` uses the
     * execution-scoped token, so tenancy is still resolved from the token (R3)
     * and this secret names no tenant.
     */
    callbackSecret: process.env.KESTRA_CALLBACK_SECRET ?? "",
    /**
     * How Kestra reaches Foundry — compiled into every flow as the `foundry`
     * variable, and the ONLY host any emitted task contacts (R8).
     *
     * A compose service name, not `baseUrl` reversed: Kestra's network is
     * `internal: true`, so this is resolved from inside that network while
     * `KESTRA_BASE_URL` is how the server resolves Kestra. The two are not
     * inverses of each other and conflating them produces a flow whose every
     * task fails DNS.
     */
    foundryUrl: (process.env.KESTRA_FOUNDRY_URL ?? "http://server:4000").replace(/\/$/, ""),
    /** Kestra secret key holding `callbackSecret`, read by each flow's `begin`. */
    callbackSecretKey: process.env.KESTRA_CALLBACK_SECRET_KEY ?? "FOUNDRY_CALLBACK",
    /**
     * How long the engine keeps a terminal execution — and therefore **the
     * replay window** (O4, phase 6.1).
     *
     * Kestra OSS has no `kestra.retention.*` setting, so retention is a scheduled
     * flow (`kestra/deploy-system-flows.ts`) that purges on this number. It is
     * read here as well as there, from the same variable, because replay's
     * "no longer available" message quotes it: two independent defaults would
     * eventually tell a user 30 days while the purge ran at 7.
     */
    retentionDays: Number(process.env.KESTRA_RETENTION_DAYS?.trim() || 30),
    /**
     * **O2 — the ONE base image every `code` step fragment runs in.**
     * infra/fragment-base/Dockerfile · 04 §5.3.2
     *
     * One image, not one per flow: per-flow images mean per-flow dependency
     * resolution, and `requirements.txt` generation is deleted rather than
     * replaced (07 §7.0.1). Under R9 a fragment is a pure function, so stdlib +
     * pandas covers it.
     *
     * The tag names the python AND pandas versions because **every existing
     * fragment was generated against this import set** — a bump is a deliberate
     * versioned change, and re-tagging in place would invalidate fragments
     * nobody re-tested. `step-contract.service.ts` renders this exact set into
     * each fragment prompt, and rejects an import outside it.
     */
    fragmentImage:
      process.env.KESTRA_FRAGMENT_IMAGE?.trim() || "foundry/fragment-base:py3.12-pandas2.2.3",
    /**
     * **V1, and it is MEASURED — the answer is yes, at the task level.**
     * 09 §12 V1 · phase-4.md 4.12
     *
     * `networkMode: none` on the Docker task runner gives the fragment
     * container no interfaces at all: `server:4000` → `gaierror`,
     * `1.1.1.1:53` → `OSError`, `169.254.169.254:80` → `OSError`. The positive
     * control (`bridge`) connects, so the assertion discriminates instead of
     * passing for an unrelated reason.
     *
     * This is what turns R9 from "should not reach the network" into "cannot".
     * It is a config key only so `kestra:phase4` can flip it to run that
     * positive control — **nothing in the product should ever set it.**
     */
    fragmentNetworkMode: process.env.KESTRA_FRAGMENT_NETWORK_MODE ?? "none",
  },
  /**
   * M3/M4 fallbacks used when a workspace has no `tenant_budgets` row.
   *
   * Deliberately FINITE, not unlimited. An absent row meaning "no limit" would
   * make the budget opt-in, and an opt-in runaway guard protects nobody — the
   * workspace that starves the instance is precisely the one nobody configured.
   * See DECISIONS.md D-04.
   */
  budgetDefaults: {
    maxConcurrentExecutions: Number(process.env.BUDGET_DEFAULT_MAX_CONCURRENT?.trim() || 5),
    // null = not metered yet. Distinct from 0, which would refuse everything.
    maxTokensPerDay: process.env.BUDGET_DEFAULT_MAX_TOKENS_PER_DAY
      ? Number(process.env.BUDGET_DEFAULT_MAX_TOKENS_PER_DAY)
      : null,
  },
  credentialEncKey: process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64),

  /**
   * Hosts a datasource may be registered against — archive/GAPS.md §1.3.
   *
   * `db.example.com` matches that host exactly; `.example.com` matches anything
   * under it. Comma-separated.
   *
   * ⚠ **`null` when unset, and never `[]`.** Unset means *this deployment has
   * not expressed an opinion*, which `datasourceTargetService` reports in the
   * verdict rather than passing silently; `[]` would mean *nothing may be
   * registered*, which is a different and much stronger statement nobody made by
   * leaving a variable out of a file.
   *
   * ⚠ **It is the weaker half of §1.3 and must never be described as the
   * control.** Unset it cannot fail, and set it is walked past by spelling the
   * same database a different way — `postgres`, `127.0.0.1`, the container IP, a
   * pgbouncer. What actually refuses the control plane is the identity and
   * signature checks in `datasource-target.service.ts`, which have no address in
   * them at all.
   */
  datasourceHostAllowlist: (() => {
    const raw = process.env.DATASOURCE_HOST_ALLOWLIST;
    if (raw === undefined) return null;
    const entries = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return entries.length > 0 ? entries : null;
  })() as string[] | null,

  /**
   * Requests per minute per IP on the two PUBLIC trigger receivers
   * (`POST /api/triggers/:token/webhook` and `…/api`).
   *
   * These are the only routes in the app that answer an anonymous caller and do
   * work — a database lookup by token, and on a hit, a flow execution. There was
   * no bound of any kind on that: an unlimited loop against the receiver path
   * drives unlimited lookups, and with a valid token, unlimited fires.
   *
   * ⚠ It is a REQUEST bound, not a fire bound, and the distinction matters
   * because the fire path already has one. Concurrent executions per workspace
   * are bounded by the M3 tenant budget (`tenant-budget.service.ts`), which is
   * the ceiling on what a valid token can actually cause; this bounds the
   * unauthenticated *lookups* in front of it. Deliberately NOT a second ceiling
   * on executions — see the FR-006 note in `@foundry/shared`'s rate-limit
   * module for why one resource with two disagreeing limits is worse than one.
   *
   * ⚠ `/api/health` is deliberately NOT throttled. It is the liveness probe, it
   * is polled at a fixed cadence by the orchestrator, and a limiter there turns
   * a busy moment into a restart loop.
   *
   * 60/min is generous for a scheduled third-party integration and still bounds
   * a loop to something a log can be read against. Tunable because the right
   * number is a property of the deployment's callers, not of this code.
   */
  publicReceiverRatePerMinute: Number(process.env.PUBLIC_RECEIVER_RATE_PER_MINUTE ?? 60),
  /**
   * The origin third parties reach this deployment's API at — used ONLY to
   * print a complete example URL on the flow's integration page.
   *
   * ⚠ **Optional, and null when unset rather than guessed.** The browser's
   * origin is the WEB app and the receivers live on the API, so a URL assembled
   * from `window.location` looks right and does not work. An incomplete example
   * a person finishes is better than a complete one that 404s. Trailing slash
   * stripped so the path can be appended without producing a double slash.
   */
  publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL
    ? process.env.PUBLIC_API_BASE_URL.replace(/\/+$/, "")
    : null,

  /**
   * How many due poll triggers one scheduler tick may dial.
   *
   * The poll loop is sequential with an 8s timeout per dial, and the
   * approval-staleness sweep runs after it in the SAME tick — so unbounded poll
   * triggers starve the sweep, which is one of the four silent-failure signals
   * exactly because its silence looks like success (D-66). Bounding the work in
   * front of a watchdog is the point; outbound volume is the lesser half.
   *
   * ⚠ Skipped triggers are not dropped — `lastPollAt` is stamped only for the
   * ones actually polled, so anything skipped stays due and is taken next tick.
   * The scheduler logs the shortfall rather than passing over it silently.
   *
   * 25 × 8s worst case is ~200s, which is the number to reduce if a deployment's
   * tick needs to stay inside a tighter bound.
   */
  pollTriggersPerTick: Number(process.env.POLL_TRIGGERS_PER_TICK ?? 25),

  /**
   * `ops-api` — the operational tool layer, on :4004.
   *
   * The fourteen HR/mail/chat/ticketing endpoints used to be `/stub-api/*` inside
   * THIS process, so `stubPublicBase` pointed back at :4000. Stage 5 moved them
   * to their own service with its own database and no access to `foundry_parent`.
   *
   * `host.docker.internal` rather than a service name, for the same reason the
   * old value did: this URL is stored on a `tools` row, and the same row has to
   * resolve from the parent container, from a host-run harness, and from anywhere
   * else a registration is read. A compose service name resolves in exactly one
   * of those. Override with `OPS_API_BASE` where the gateway name differs.
   */
  opsApiBase: process.env.OPS_API_BASE ?? "http://host.docker.internal:4004",

  /**
   * Where THIS process reaches ops-api's operator surface (`/admin/*`).
   *
   * Deliberately a second knob rather than reusing `opsApiBase`, because the two
   * answer different questions and the answers differ:
   *
   *  * `opsApiBase` is STORED on a `tools` row. It must resolve for whoever
   *    later reads that row and calls the endpoint — in practice the parent
   *    container, via the host gateway.
   *  * this is used immediately, by the process evaluating it. That is the
   *    parent container in production and a HOST process for every `demo:*` and
   *    `kestra:*` harness — and `host.docker.internal` does not resolve on a
   *    Linux host, so sharing one value breaks every harness with
   *    `fetch failed`.
   *
   * Default is host-facing because the harnesses are the ones with no way to
   * configure themselves; compose overrides it with the service name, which is
   * both correct and one hop shorter than going out through the gateway.
   */
  opsAdminBase: process.env.OPS_ADMIN_BASE ?? "http://localhost:4004",

  /**
   * ops-api's ROOT key.
   *
   * Two distinct things are derived from it and they must not be confused. The
   * five per-service tool credentials are `opsServiceKey(root, service)` — those
   * are seeded into `workspace_secrets` and are what a flow step presents. This
   * value is the root itself, held only by this process, and it authorises the
   * operator surface (`/admin/records`, `/admin/reset`). A tool step able to
   * truncate the call log would make the audit trail of its own calls worthless.
   */
  opsApiKey: process.env.OPS_API_KEY ?? "ops-dev-key",

  /**
   * The Foundry-owned runner for Pi-built workflows (plans/pi-runtime-2026-10-09, option A).
   *
   * `secret` authorises THIS process to start a run on the runner; it is never handed to a step. Empty means
   * "not configured" and every start is refused with a message naming the variable — not a default, for the
   * same reason `inference` has none (a placeholder that type-checks looks configured).
   * `callbackBase` is how the runner reaches THIS server's step API — on `runner-net`, not via the host.
   */
  /**
   * Connectors (Activepieces pieces, run by `packages/connector`). ON exactly when the connector is configured — its
   * address and its secret — because the server cannot reach it without both. There used to be a separate switch
   * (`PLUGINS_POC=1`); two switches that must agree only add a way to disagree. To turn connectors off, leave the
   * address unset (or do not start the `plugins` profile).
   */
  plugins: {
    enabled: !!(process.env.PLUGINS_CONNECTOR_URL ?? "").trim() && !!(process.env.PLUGINS_CONNECTOR_SECRET ?? "").trim(),
    url: (process.env.PLUGINS_CONNECTOR_URL ?? "").replace(/\/+$/, ""),
    secret: process.env.PLUGINS_CONNECTOR_SECRET ?? "",
    /** The marketplace: Activepieces' public catalogue of pieces (read by the server, cached six hours). */
    catalogueUrl: process.env.PLUGINS_CATALOGUE_URL ?? "https://cloud.activepieces.com/api/v1/pieces",
    /**
     * Where a person's browser reaches Foundry — the OAuth return address is `<publicUrl>/api/oauth/callback`, and a
     * provider sends people back only to an address registered with it. Defaults to the sign-in URL (`AUTH_URL`).
     */
    publicUrl: (process.env.PLUGINS_PUBLIC_URL ?? process.env.AUTH_URL ?? "http://localhost:4002").replace(/\/+$/, ""),
    /**
     * Foundry's own Microsoft Entra sign-in app (decision 3): one registration serves every Microsoft 365 connector, so
     * there is no second client id or secret to enter. Empty ⇒ not offered.
     */
    signInApp: {
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
    },
  },

  flowRunner: {
    url: (process.env.FLOW_RUNNER_URL ?? "http://flow-runner:4006").replace(/\/+$/, ""),
    secret: process.env.FLOW_RUNNER_SECRET ?? "",
    callbackBase: (process.env.FLOW_RUNNER_CALLBACK_BASE ?? "http://server:4000").replace(/\/+$/, ""),
  },

  /**
   * A read of an uploaded SQLite file runs in a worker thread (services/sqlite-read-worker.ts) and is stopped after
   * this long. node:sqlite cannot be interrupted, so the worker is terminated; the step fails with a plain sentence.
   */
  sqliteReadTimeoutMs: Number(process.env.SQLITE_READ_TIMEOUT_MS ?? 2 * 60_000),

  /**
   * Forge — the builder agent's live processes (pi-builder/forge-pool.ts). One per open chat; it exits after
   * `idleMs` without a turn, or `leaveGraceMs` after the last tab closes. A turn longer than `turnTimeoutMs` is
   * killed. `maxLive` / `maxLivePerWorkspace` bound how many run at once — measured at ~220 MB per idle process,
   * so 8 is ~1.8 GB at most on a host shared with Postgres and Kestra.
   */
  forge: {
    maxLive: Number(process.env.FORGE_MAX_LIVE ?? 8),
    maxLivePerWorkspace: Number(process.env.FORGE_MAX_LIVE_PER_WORKSPACE ?? 4),
    idleMs: Number(process.env.FORGE_IDLE_MS ?? 5 * 60_000),
    leaveGraceMs: Number(process.env.FORGE_LEAVE_GRACE_MS ?? 30_000),
    turnTimeoutMs: Number(process.env.FORGE_TURN_TIMEOUT_MS ?? 10 * 60_000),
    /** A conversation nobody has had open this long leaves server memory; it reloads from the database. */
    forgetAfterMs: Number(process.env.FORGE_FORGET_AFTER_MS ?? 30 * 60_000),
    /**
     * Where Forge runs: `forge:4100`, the forge container (each conversation as its own user, no secrets, no route but
     * the AI gateway). Unset: as children of this server, for development and tests only.
     */
    host: process.env.FORGE_HOST?.trim() || null,
    hostSecret: process.env.FORGE_HOST_SECRET ?? "",
    /** Where Forge's tools (ask-data, open-file) call back: this server, as the forge container reaches it. */
    toolUrl: process.env.FORGE_TOOL_URL?.trim() || null,
    /**
     * The hosts the forge-egress proxy lets Forge reach (comma-separated host:port). Empty means the host of
     * LLM_BASE_URL. Read here only to warn when a saved gateway is outside it.
     */
    egressAllow: process.env.FORGE_EGRESS_ALLOW?.trim() || "",
    /**
     * How big one conversation's folder may get (its files, Forge's work, its session). The forge host refuses a
     * message past it (FORGE_MAX_FOLDER_BYTES there too, same default); the server warns before and refuses first.
     */
    maxFolderBytes: Number(process.env.FORGE_MAX_FOLDER_BYTES?.trim() || 300 * 1024 * 1024),
  },

  /**
   * The GENERATION seam's model — one prompt in, one answer out.
   *
   * ⚠ Read this before assuming it is the same thing as the `llm_complete`
   * tool. Two consumers share a gateway and share nothing else:
   *
   *   * RUNTIME inference is `POST /llm/complete` in ops-api. A flow step calls
   *     it, an operator configures it on the AI provider page, and its
   *     credential lives in that process. It never appears here.
   *   * GENERATION inference is this: `InferenceClient.complete()`, used by
   *     `flow-generation.service.ts` for one draft call and N fragment calls.
   *     It is control-plane machinery with no tenant surface at all.
   *
   * Keeping them apart is D-23's reasoning one level up. A single "the LLM
   * config" would put a fragment's contract and a tenant's runtime prompt behind
   * one interface whose entire value is what it cannot see.
   *
   * ── Why the parent needs its own, when Stage 6a said it should not ──────────
   *
   * It did not, until `kestra:refusal` measured what generating THROUGH THE AGENT
   * RUNTIME did to a refusal. Every run there attached a mandatory `script-gen`
   * skill whose protocol adds turns AFTER the model answers, so `finalMessage`
   * was the tail of a conversation rather than the answer — and the model's
   * correct `insufficient_contract` JSON never survived to Foundry. Measured: 5
   * refusals produced, 0 seen. That runtime is gone; the seam it forced is not,
   * and must not be merged back into anything. See `GatewayInference`.
   *
   * ── LLM_BASE_URL / LLM_API_KEY are OPTIONAL ──────────────────────────────────
   *
   * The `runtime_model_provider` DB row (AI models page) is the primary source; these env values are only a
   * fallback and may be empty, in which case a call with no saved row errors at call time.
   */
  /**
   * The RUNTIME model — what `llm_complete` calls inside a workflow. Since 2026-11-04 one model connection serves
   * workflows, the builder and Forge: the `runtime_model_provider` row, set on the AI models page. Its limits for
   * `llm_complete` are these, below. LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are the fallback until a row is saved.
   */
  runtimeModel: {
    fallbackModels: fallbackModel ? [fallbackModel] : [],
    maxInstructionChars: Number(process.env.LLM_COMPLETE_MAX_INSTRUCTION_CHARS ?? process.env.OPS_LLM_MAX_INSTRUCTION_CHARS ?? 4_000),
    maxInputChars: Number(process.env.LLM_COMPLETE_MAX_INPUT_CHARS ?? process.env.OPS_LLM_MAX_INPUT_CHARS ?? 32_000),
    defaultMaxTokens: Number(process.env.LLM_COMPLETE_DEFAULT_MAX_TOKENS ?? process.env.OPS_LLM_DEFAULT_MAX_TOKENS ?? 1_024),
    maxMaxTokens: Number(process.env.LLM_COMPLETE_MAX_OUTPUT_TOKENS ?? process.env.OPS_LLM_MAX_OUTPUT_TOKENS ?? 4_096),
    /** Rolling 60-second budget across the deployment, counted from `usage_events`. */
    maxCallsPerMinute: Number(process.env.LLM_COMPLETE_MAX_CALLS_PER_MIN ?? process.env.OPS_LLM_MAX_CALLS_PER_MIN ?? 60),
    timeoutMs: Number(process.env.LLM_COMPLETE_TIMEOUT_MS ?? process.env.OPS_LLM_TIMEOUT_MS ?? 120_000),
  },
  inference: {
    // Optional: the runtime_model_provider row (AI models page) is primary; env is only a fallback and may be empty.
    // An empty LLM_BASE_URL takes the OpenCode preset's address when LLM_PROVIDER names one (llm-provider-presets.ts).
    baseUrl: ((process.env.LLM_BASE_URL ?? "").trim() ||
      ({ opencode_go: "https://opencode.ai/inference/go/openai/v1", opencode_zen: "https://opencode.ai/inference/openai/v1" } as Record<string, string>)[
        (process.env.LLM_PROVIDER ?? "").trim().toLowerCase()
      ] ||
      "").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY ?? "",
    /** The fallback model (LLM_MODEL, then the older LLM_REASONING_MODEL / LLM_FAST_MODEL). */
    model: fallbackModel,
    /** LLM_PROVIDER: which gateway the env fallback is — `opencode_go` | `opencode_zen` | `custom` (default). Decides the extra headers and the models-list URL. */
    provider: ((): "opencode_go" | "opencode_zen" | "custom" => {
      const v = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
      return v === "opencode_go" || v === "opencode_zen" ? v : "custom";
    })(),
  },
  /**
   * Strategy B Intent IR path (2026-10-07). Default ON after ship gate —
   * pin by IR node id, dry-run preview hooks, grounded assistant, and
   * banded-read code-emit (CASE WHEN from `band_count`). Opt out with
   * `BUILDER_INTENT_IR=0`. Additive skeleton→bind plan stages stay off
   * unless `BUILDER_PLAN_STAGES=1`.
   */
  builder: {
    intentIr: (() => {
      const v = (process.env.BUILDER_INTENT_IR ?? "").trim().toLowerCase();
      return !(v === "0" || v === "false" || v === "off");
    })(),
    planStages: process.env.BUILDER_PLAN_STAGES === "1" || process.env.BUILDER_PLAN_STAGES === "true",
    /** @deprecated Phase 7 — same as `intentIr`; kept for log/compat only. */
    bandEmit: (() => {
      const v = (process.env.BUILDER_INTENT_IR ?? "").trim().toLowerCase();
      return !(v === "0" || v === "false" || v === "off");
    })(),
  },
  /**
   * The secret the SIGN-IN flow signs a user identity with, and this server
   * verifies (Stage 9.1).
   *
   * ⚠ **A second secret, deliberately not `PARENT_API_KEY`.** The API key
   * authorises a *request*; this one attests a *person*. Collapsing them would
   * mean anyone holding the key could name any approver, which is the exact
   * property I-13 records and Stage 9 exists to end. The client mints the token
   * in `src/auth.ts` at sign-in (`RUNTIME_JWT_SECRET ?? AUTH_SECRET`, HS256, 8h)
   * and it travels in `x-foundry-identity`.
   *
   * Empty means this server cannot verify anybody, and the routes that record a
   * person **fail closed** saying so. Failing open would leave an approval
   * recording a name nothing checked — the state Stage 9 is leaving.
   */
  identity: {
    secret: process.env.RUNTIME_JWT_SECRET ?? process.env.AUTH_SECRET ?? "",
  },
  // HR demo (plans/hr-demo-stub-services-plan.md). Everything here is synthetic;
  // see src/demo/hr-dataset.ts for the data-provenance note.
  demo: {
    // `enabled` (DEMO_MODE) was here, gating POST /api/demo/provision and /reset.
    // Both routes are deleted: they dropped and reseeded `hr_demo`, and the flag had
    // to be ON for the demo to exist at all — so it was necessarily true on exactly
    // the deployments where the danger was real. Reseeding is `pnpm demo:seed` /
    // `demo:reset` now, and running a command in the repo is the opt-in the env var
    // was standing in for.
    dbName: process.env.DEMO_DB_NAME ?? "hr_demo",
    // WS-E.1 — the swap-rehearsal dataset. Same domain, deliberately different
    // shape (named schema, views, fractional rates, ~10x rows), so any accidental
    // dependence on hr_demo's names/units/scale shows up as a failure here.
    altDbName: process.env.DEMO_ALT_DB_NAME ?? "hr_demo_alt",
    // How a generated script — running in a SIBLING container — reaches the demo
    // DB. Not localhost, and not the compose service name. See plan §12: on Linux
    // hosts without the host-gateway alias, set DEMO_DB_HOST=172.17.0.1.
    dbHostForScripts: process.env.DEMO_DB_HOST ?? "host.docker.internal",
    dbPortForScripts: process.env.DEMO_DB_PORT ?? "5433",
    // Env-var NAME the connection string is injected under (never the value).
    dbSecretEnvName: process.env.DEMO_DB_SECRET_ENV ?? "HR_DB_URL",
    // WS-A: the least-privilege role whose credential is the ONLY one ever
    // encrypted into `datasources` and handed to generated scripts. The owner
    // credential (config.databaseUrl) stays parent-side for DDL and seeding.
    roRole: process.env.DEMO_DB_RO_ROLE ?? "foundry_ro",
    roPassword: process.env.DEMO_DB_RO_PASSWORD ?? derivedRoPassword(),
    // Runaway-query protection applied to the read-only role (WS-A.2).
    roStatementTimeout: process.env.DEMO_DB_RO_STATEMENT_TIMEOUT ?? "30s",
    roIdleTxTimeout: process.env.DEMO_DB_RO_IDLE_TX_TIMEOUT ?? "60s",
    roConnectionLimit: Number(process.env.DEMO_DB_RO_CONNECTION_LIMIT ?? 10),
  },
  /**
   * The development sandbox (Programme 3 Stage 4).
   *
   * ⚠ There is deliberately **no `enabled` flag here**. Whether a draft run reads
   * fixtures is decided by whether a sandbox has been provisioned for that
   * datasource, and by the execution's NAMESPACE — never by a setting, because a
   * setting is a thing somebody turns off for one run and forgets. See D-52.
   *
   * The host split is D-44's, for D-44's reason: `dbHost`/`dbPort` are baked into
   * a DSN that is STORED and later dialled by the server container, while
   * provisioning is a host process using `config.databaseUrl`. A value that is
   * stored must resolve for its future reader; a value used now must resolve for
   * the current process.
   */
  sandbox: {
    /** Every sandbox database name starts with this, and `dropDatabase` refuses anything that does not. */
    dbPrefix: process.env.SANDBOX_DB_PREFIX ?? "foundry_sbx_",
    dbHost: process.env.SANDBOX_DB_HOST ?? process.env.DEMO_DB_HOST ?? "host.docker.internal",
    dbPort: process.env.SANDBOX_DB_PORT ?? process.env.DEMO_DB_PORT ?? "5433",
    /** Prefix for the per-sandbox read-only role. One role per sandbox, never a shared one. */
    roRolePrefix: process.env.SANDBOX_RO_ROLE_PREFIX ?? "sbx_ro_",
    roStatementTimeout: process.env.SANDBOX_RO_STATEMENT_TIMEOUT ?? "30s",
    roIdleTxTimeout: process.env.SANDBOX_RO_IDLE_TX_TIMEOUT ?? "60s",
    roConnectionLimit: Number(process.env.SANDBOX_RO_CONNECTION_LIMIT ?? 10),
  },

  /**
   * The step-callback transport bound — step-payload-bounds, plan Decision 1.
   *
   * ── Why a SECOND body limit and not a bigger first one ──────────────────────
   *
   * Execution `05aca859-…` failed because a tool returned 7.19 MiB and the next
   * step posted all of it to `/api/steps/tool`, where the process-wide 2 MB
   * `express.json` cap answered *"request entity too large"* — four words, two
   * hops upstream of the endpoint that would have said *"input is 7,539,026
   * characters; the limit is 32,000. Summarise or filter upstream."*
   *
   * So the defect was never "the limit is too low". It was that a COARSE limit
   * fired where a SPECIFIC one had something useful to say. This cap exists only
   * to stop a runaway body being allocated at all, and it is set deliberately far
   * above every per-parameter cap in the product so that the parameter's own
   * refusal is always the one a person reads:
   *
   *   `llm_complete`'s `input`      32,000 chars   (ops-api, 422)
   *   `tether_email_send`'s `body` 262,144 B      (`mail.maxBodyBytes`, below)
   *   a step callback's whole body  5,242,880 B    (here)
   *   every other route             2 MB           (`app.ts`, unchanged)
   *
   * ⚠ **THE REPORTED 8,401,233 B BODY IS STILL REFUSED AT THIS CAP, AND THAT IS
   * CORRECT.** It was bound to a parameter with a 32,000-character ceiling, so no
   * value here makes sending it right. What P1 buys that run is a refusal naming
   * the size, the limit, the execution and a remedy instead of four words; what
   * makes it *succeed* is a `transform`/`code` step reducing the payload first
   * (plan Decision 9). **Do not raise this until a replay gets through** — that
   * inverts the whole design.
   *
   * ⚠ Do not "simplify" this to one global number. A single value cannot be both
   * above every parameter cap (so the specific errors win) and tight enough for
   * the rest of the API surface, where 2 MB is already generous — the two-limit
   * shape IS the fix. `config/step-callback-cap.test.ts` pins the ladder.
   */
  steps: {
    callbackMaxBytes: Number(process.env.STEP_CALLBACK_MAX_BYTES ?? 5_242_880),
    /** A file a step saves (`POST /api/steps/files`) — the largest report one email can carry. */
    fileMaxBytes: Number(process.env.STEP_FILE_MAX_BYTES ?? 50 * 1024 * 1024),
  },

  tools: {
    /**
     * SOFT. A tool response over this adds ONE warning to the step and the step
     * still succeeds — plan Decision 6.
     *
     * ⚠ It must never become a refusal. A large read followed by a reducing
     * `transform` is a correct flow, and refusing it breaks automations that work
     * today; had a hard cap existed on 2026-08-18 the BTO run would have failed
     * at `fetch` with a Foundry refusal instead of at `report`, which is not an
     * improvement. The anomaly worth one sentence is that a one-month request was
     * answered with the entire employee master — the warning says that, and
     * nothing truncates.
     */
    responseWarnBytes: Number(process.env.TOOL_RESPONSE_WARN_BYTES ?? 1_048_576),
  },

  /**
   * REAL email delivery via plain SMTP (nodemailer).
   *
   * ⚠ **This is the only capability in Foundry that leaves the building.** Every
   * other tool in the catalogue talks to `packages/ops-api`, a simulation. A
   * mistake there costs a row in `api_call_log`; a mistake here is a message in
   * somebody's inbox and there is no unsend. That is why the recipient decision
   * lives in `services/mail-recipients.ts` as pure, exhaustively-tested policy
   * rather than anywhere near this block.
   *
   * Variables: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` =
   * implicit TLS; defaults to true on port 465, else STARTTLS when offered),
   * `SMTP_USER` / `SMTP_PASS` (optional, for an unauthenticated relay), and
   * `MAIL_FROM` (e.g. `Tether <me@example.com>`). Only host and from are required.
   *
   * ⚠ `pass` is read from `.env` and from exactly one module
   * (`services/mail.service.ts`, enforced by `mail-secret-single-reader.test.ts`).
   *
   * ⚠ **Do not confuse these with `MAIL_API_KEY`**, which is the *simulated* mail
   * service's workspace secret.
   */
  mail: (() => {
    const host = (process.env.SMTP_HOST ?? "").trim();
    const parsedPort = Number(process.env.SMTP_PORT ?? 587);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
    const secureEnv = (process.env.SMTP_SECURE ?? "").trim().toLowerCase();
    const secure = secureEnv === "" ? port === 465 : secureEnv === "true";
    const user = process.env.SMTP_USER ?? "";
    const pass = process.env.SMTP_PASS ?? "";
    const from = (process.env.MAIL_FROM ?? "").trim();

    /**
     * Every absent variable, so FR-008 can name them all in ONE refusal. Naming
     * the first missing one sends an operator round the loop once per variable.
     */
    const missing: string[] = [];
    if (!host) missing.push("SMTP_HOST");
    if (!from) missing.push("MAIL_FROM");

    return {
      host,
      port,
      secure,
      user,
      pass,
      from,
      /**
       * Domains an explicitly-named recipient may be on. **Empty means the person
       * who started the run and nobody else** — there is no wildcard value, because
       * the absence of configuration is not consent to email the world.
       */
      allowedDomains: (process.env.MAIL_ALLOWED_RECIPIENT_DOMAINS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      /**
       * ⚠ **Absent means ON**, and only the literal string `false` disables.
       * Inverted from the original off-by-default draft on purpose: the operator
       * configured the SMTP variables and was never told to add this one, so
       * defaulting it off would refuse every send citing a variable that is not in
       * their `.env`. A kill switch has to be switched to kill.
       */
      enabled: process.env.MAIL_ENABLED !== "false",
      maxBodyBytes: Number(process.env.MAIL_MAX_BODY_BYTES ?? 262_144),
      maxRecipients: Number(process.env.MAIL_MAX_RECIPIENTS ?? 10),
      /**
       * Attachments on `tether_email_send` (`services/mail-attachments.ts`).
       *
       * ⚠ The total is bounded by the ROUTE's own `express.json({ limit: "2mb" })`
       * (`app.ts`), which carries the body and the attachments in one request —
       * so 1.5 MB leaves the body room. Base64 grows it ~4/3 on the way to Graph,
       * whose `sendMail` request tops out at 4 MB; 1.5 MB → 2 MB there, plus a
       * rendered report of at most `MAX_RENDERED_BYTES`, is checked again at the
       * route. Raising this past ~1.9 MB means raising the route limit too.
       */
      // 50 MB across one email's files (2026-10-12). Past ~3 MB they go up through Graph's upload session
      // (`mail.service.ts`); the tenant's own send limit can still refuse, and that refusal is named.
      maxAttachmentBytes: Number(process.env.MAIL_MAX_ATTACHMENT_BYTES ?? 50 * 1024 * 1024),
      maxAttachments: Number(process.env.MAIL_MAX_ATTACHMENTS ?? 5),
      /**
       * Where the registered tool's `url` points, i.e. this server as reached by
       * the step executor. The tool row stores an absolute URL, so this must
       * resolve for the *executor's* network, not for a browser.
       */
      selfBase: process.env.MAIL_SELF_BASE ?? "http://localhost:4000",
      /** True only when SMTP could actually be called. Never a promise that it will succeed. */
      configured: missing.length === 0,
      missing,
    };
  })(),
  /**
   * The cost report (`routes/reports.ts`). An EMAILED report goes to people who may hold no access to the workspaces
   * it covers, so the recipient domain is checked here and not left to the sender. Exact match on the part after the
   * `@` (a subdomain is not listed unless named); the default is the company's own domain.
   */
  reports: {
    emailDomains: (process.env.REPORT_EMAIL_DOMAINS ?? "microland.com")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
} as const;

/**
 * A sandbox role's password, DERIVED rather than random.
 *
 * Same reasoning as `derivedRoPassword` above and the same trap: re-materialising
 * a sandbox from its frozen fixture must not invalidate the DSN already encrypted
 * into `datasources.sandbox_dsn_enc`, or every draft run starts failing to
 * authenticate for a reason nothing reports.
 */
export function sandboxRoPassword(datasourceId: string): string {
  return crypto
    .createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
    .update(`sandbox:${datasourceId}:read-only-role:v1`)
    .digest("hex")
    .slice(0, 32);
}

export type AppConfig = typeof config;
