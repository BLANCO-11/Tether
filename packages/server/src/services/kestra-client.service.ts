import { config } from "../config/index.js";

/**
 * Kestra REST client — the ONLY module that talks HTTP to Kestra.
 * archive/kestra-migration/07-refactor-inventory.md §7.2
 *
 * One interface per external
 * runtime, so the dependency stays swappable and there is exactly one place that
 * knows the dialect.
 *
 * ── R4: NEVER TRUST A CLIENT-SUPPLIED NAMESPACE ──────────────────────────────
 *
 * This is the single highest-severity risk in the migration. Kestra's list
 * endpoints will happily return another tenant's executions if a namespace
 * parameter is passed through from a request — textbook IDOR.
 *
 * The defence is structural rather than a review rule: **no public method on
 * this class takes a namespace string.** Every one takes a `NamespaceRef`, which
 * can only be produced by `namespaceFor()` from an authenticated workspace. A
 * caller holding a raw string from a request body has nothing it can pass.
 */

/**
 * An authorised namespace. The private brand cannot be forged from outside this
 * module, so a `string` from a request body will not type-check into any call
 * site — the IDOR is a compile error rather than a code-review finding.
 */
export interface NamespaceRef {
  readonly value: string;
  readonly __brand: unique symbol;
}

/** Environment a namespace addresses. Draft is for test runs; live serves approved revisions. */
export type NamespaceEnv = "live" | "draft";

/**
 * Derive the Kestra namespace for a workspace.
 *
 * `<prefix>.<tenant>.<workspace>` (+ `.draft`). The tenant segment is MANDATORY
 * (§5.0): two clients will both have a workspace called "HR", and a namespace
 * collision across tenants is a cross-tenant data leak.
 *
 * Slugs must be IMMUTABLE — a renamed workspace keeps its namespace. Callers
 * pass the stored slug, never a display name.
 */
export function namespaceFor(
  tenantSlug: string,
  workspaceSlug: string,
  env: NamespaceEnv = "live",
): NamespaceRef {
  const seg = (s: string) => {
    const v = s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!v) throw new KestraError(`namespace segment is empty after slugification: "${s}"`, 400, null);
    return v;
  };
  const tenant = seg(tenantSlug);
  // `<prefix>.system` is Foundry's own operational namespace. A tenant slugging
  // to "system" would deploy tenant flows INTO it, and `resolveWorkspaceFromNamespace`
  // reads the last two segments — so `foundry.system.hr` would resolve while
  // sitting inside the operational tree. Reserved rather than reasoned about.
  if (tenant === SYSTEM_SEGMENT) {
    throw new KestraError(`"${SYSTEM_SEGMENT}" is a reserved tenant slug`, 400, null);
  }
  const parts = [config.kestra.namespacePrefix, tenant, seg(workspaceSlug)];
  if (env === "draft") parts.push("draft");
  return { value: parts.join(".") } as NamespaceRef;
}

const SYSTEM_SEGMENT = "system";

/**
 * Foundry's own operational namespace — the retention job and anything else that
 * is infrastructure rather than a tenant's automation.
 *
 * It has NO tenant segment, which is load-bearing rather than cosmetic:
 * `resolveWorkspaceFromNamespace` needs three segments, so a flow here cannot
 * resolve to a workspace and `POST /api/executions/begin` refuses it. A system
 * flow runs on the same instance as tenant flows and still cannot obtain an
 * execution token (R2 — it needs no tenant credential, so it must not be able
 * to get one).
 */
export function systemNamespace(): NamespaceRef {
  return { value: `${config.kestra.namespacePrefix}.${SYSTEM_SEGMENT}` } as NamespaceRef;
}

export class KestraError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "KestraError";
  }
}

export interface KestraExecution {
  id: string;
  namespace: string;
  flowId: string;
  state: { current: string; histories?: Array<{ state: string; date: string }> };
  taskRunList?: KestraTaskRun[];
  inputs?: Record<string, unknown>;
  labels?: Array<{ key: string; value: string }>;
}

export interface KestraTaskRun {
  id: string;
  taskId: string;
  executionId: string;
  state: { current: string; histories?: Array<{ state: string; date: string }> };

  /**
   * One entry per attempt — **the only place the engine reports a retry.**
   *
   * ⚠ There is no `attempt` scalar. This type declared one for a long time and
   * `flow-visibility.service.ts` read `tr.attempt ?? 1`, so the UI's "attempt N"
   * badge could never fire: the fallback was the only branch that ever ran.
   * Nobody noticed because nothing emitted a `retry:` block until Stage 4, and
   * the first run that did produced `attempt: undefined` beside an `attempts`
   * array of length 2 with states `FAILED → SUCCESS` (measured, v1.3.29).
   *
   * Read the LENGTH for "how many tries", and the step's own final state for
   * whether it got there — `[FAILED, SUCCESS]` is a recovery, `[FAILED, FAILED]`
   * is an exhausted retry.
   */
  attempts?: Array<{ state?: { current?: string } }>;
  outputs?: Record<string, unknown>;
}

/** One class a plugin supplies — a task, trigger, condition, task runner or storage. */
export interface KestraPluginClass {
  cls: string;
  title?: string;
  description?: string;
  deprecated?: boolean;
}

/**
 * One registered plugin, as `GET /api/v1/plugins` describes it.
 *
 * ⚠ Every list is optional here **because the shape is the engine's, not ours**.
 * `core` carries `charts`, `dataFilters` and `storages` that
 * `plugin-script-python` omits entirely, and a required field would make this
 * client throw on a plugin nobody has installed yet. Read defensively.
 */
/**
 * `GET /api/v1/plugins/:cls`. Only `schema.properties` is read — see
 * `pluginSchema` for why the `markdown` sibling is deliberately not in this type.
 *
 * ⚠ `$group` is Kestra's own classification of a property, and `"connection"` is
 * how it marks the ones that authenticate. That is what makes the credentials
 * view a READ of the engine rather than a table somebody typed out — a
 * hand-maintained list of "what Slack needs" is a second authority that goes
 * stale silently on the next plugin bump.
 */
export interface KestraPluginSchema {
  schema?: {
    properties?: {
      properties?: Record<
        string,
        {
          type?: string;
          title?: string;
          description?: string;
          $group?: string;
          $required?: boolean;
          default?: unknown;
        }
      >;
      required?: string[];
    };
  };
}

export interface KestraPlugin {
  name?: string;
  group?: string;
  title?: string;
  description?: string;
  /** Absent for `core`, which ships with the engine and has no version of its own. */
  version?: string;
  categories?: string[];
  manifest?: Record<string, string>;
  tasks?: KestraPluginClass[];
  triggers?: KestraPluginClass[];
  conditions?: KestraPluginClass[];
  taskRunners?: KestraPluginClass[];
  storages?: KestraPluginClass[];
  charts?: KestraPluginClass[];
  dataFilters?: KestraPluginClass[];
  dataFiltersKPI?: KestraPluginClass[];
  logExporters?: KestraPluginClass[];
  secrets?: KestraPluginClass[];
  apps?: KestraPluginClass[];
  appBlocks?: KestraPluginClass[];
  aliases?: string[];
}

export class KestraClient {
  constructor(
    private readonly baseUrl: string = config.kestra.baseUrl,
    private readonly auth: string = config.kestra.auth,
  ) {}

  /**
   * Per-request ceiling.
   *
   * undici's default headers timeout is FIVE MINUTES, so a stalled Kestra does
   * not surface as an error — it surfaces as the caller appearing to hang, and
   * then a bare `fetch failed` long after the useful context is gone (I-06).
   * Every call here is a control-plane operation that should take milliseconds;
   * if one takes 30s something is wrong and saying so quickly is the point.
   */
  private static readonly TIMEOUT_MS = 30_000;

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.auth) headers["authorization"] = this.auth;
    if (body !== undefined) headers["content-type"] = contentType;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(KestraClient.TIMEOUT_MS),
        body:
          body === undefined
            ? undefined
            : contentType === "application/json"
              ? JSON.stringify(body)
              : String(body),
      });
    } catch (e) {
      // undici collapses every transport failure into a bare "fetch failed"
      // whose only useful detail is on `.cause`. Unwrapping it here is the
      // difference between "Kestra is unreachable" and a diagnosis — DNS,
      // refused connection, and a socket the server hung up on all look
      // identical otherwise.
      const cause = (e as Error & { cause?: Error & { code?: string } }).cause;
      if ((e as Error).name === "TimeoutError") {
        throw new KestraError(
          `Kestra ${method} ${path} → no response within ${KestraClient.TIMEOUT_MS}ms`,
          0,
          { url: `${this.baseUrl}${path}`, code: "TIMEOUT" },
        );
      }
      throw new KestraError(
        `Kestra ${method} ${path} → transport failure: ${cause?.message ?? (e as Error).message}` +
          (cause?.code ? ` (${cause.code})` : ""),
        0,
        { url: `${this.baseUrl}${path}`, code: cause?.code },
      );
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text — Kestra returns YAML on some flow endpoints */
    }
    if (!res.ok) {
      throw new KestraError(`Kestra ${method} ${path} → ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  /** Reachable, and is our credential accepted? Distinguishes the two. */
  async health(): Promise<{
    reachable: boolean;
    authenticated: boolean;
    version?: string;
    edition?: string;
    detail?: string;
    baseUrl: string;
  }> {
    const target = { baseUrl: this.baseUrl };
    let version: string | undefined;
    let edition: string | undefined;
    try {
      // /api/v1/configs is public even when basic auth is on, so it separates
      // "Kestra is down" from "our credential is wrong" — two very different
      // pages of the runbook.
      const cfg = await this.request<{ version?: string; edition?: string }>(
        "GET",
        "/api/v1/configs",
      );
      version = cfg?.version;
      edition = cfg?.edition;
    } catch (e) {
      return { reachable: false, authenticated: false, detail: (e as Error).message, ...target };
    }
    try {
      await this.request("GET", "/api/v1/main/flows/search?size=1");
      return { reachable: true, authenticated: true, version, edition, ...target };
    } catch (e) {
      return {
        reachable: true,
        authenticated: false,
        version,
        edition,
        detail: (e as Error).message,
        ...target,
      };
    }
  }

  // ── Flows ──────────────────────────────────────────────────────────────────

  /**
   * Machine gate before deploy. Kestra parses the YAML and reports what it
   * dislikes, which is cheaper and far more specific than discovering it when an
   * execution fails at 3 a.m.
   */
  validateFlow(yaml: string) {
    return this.request<Array<{ constraints?: string; outdated?: boolean; deprecationPaths?: string[] }>>(
      "POST",
      "/api/v1/main/flows/validate",
      yaml,
      "application/x-yaml",
    );
  }

  /**
   * Create or update a flow. Kestra versions flows natively and is the system of
   * record for the deployed YAML (R6) — Foundry keeps the MODEL, not the YAML.
   */
  async deployFlow(ns: NamespaceRef, flowId: string, yaml: string) {
    // ⚠ Existence is checked with a GET FIRST. The obvious shape — PUT, then
    // fall back to POST on 404 — does not work: PUT to a flow that does not
    // exist NEVER RESPONDS. It does not 404, it hangs until the client gives up,
    // and Kestra logs nothing because its access log is written on completion.
    // With undici's 5-minute default that surfaces as a bare `fetch failed` five
    // minutes later, pointing at the wrong thing. See progress/ISSUES.md I-06.
    //
    // So: one extra GET on the create path, and no hang.
    let exists = true;
    try {
      await this.getFlow(ns, flowId);
    } catch (e) {
      if (e instanceof KestraError && e.status === 404) exists = false;
      else throw e;
    }

    return exists
      ? this.request<{ id: string; namespace: string; revision: number }>(
          "PUT",
          `/api/v1/main/flows/${encodeURIComponent(ns.value)}/${encodeURIComponent(flowId)}`,
          yaml,
          "application/x-yaml",
        )
      : this.request<{ id: string; namespace: string; revision: number }>(
          "POST",
          "/api/v1/main/flows",
          yaml,
          "application/x-yaml",
        );
  }

  getFlow(ns: NamespaceRef, flowId: string) {
    return this.request<{
      id: string;
      namespace: string;
      revision: number;
      tasks: unknown[];
      /** `[]` when none. This is how "the Schedule trigger was REMOVED" is checked. */
      triggers?: Array<{ id: string; type: string; cron?: string; disabled?: boolean }>;
      labels?: Record<string, string> | Array<{ key: string; value: string }>;
    }>(
      "GET",
      `/api/v1/main/flows/${encodeURIComponent(ns.value)}/${encodeURIComponent(flowId)}`,
    );
  }

  /**
   * The deployed YAML, verbatim.
   *
   * Kestra is the system of record for it (R6), so this is how Foundry checks
   * that what is live is byte-for-byte what it compiled — `compiled_yaml_hash`
   * is only evidence if it can be compared against the thing itself.
   */
  async getFlowSource(ns: NamespaceRef, flowId: string): Promise<string> {
    const res = await this.request<{ source?: string }>(
      "GET",
      `/api/v1/main/flows/${encodeURIComponent(ns.value)}/${encodeURIComponent(flowId)}?source=true`,
    );
    if (typeof res?.source !== "string") {
      throw new KestraError(`Kestra returned no source for ${ns.value}/${flowId}`, 0, res);
    }
    return res.source;
  }

  /**
   * Every plugin the engine has registered, with the classes each one supplies.
   *
   * ⚠ **NOT tenant-scoped, and there is no tenant-scoped form.** `/api/v1/main/…`
   * is a 404 here: plugins are a property of the engine's *build*, not of a
   * tenant, so every workspace on this deployment sees exactly the same list.
   * That is why the Foundry route in front of it is `/api/engine/plugins` rather
   * than sitting under `/workspaces/:ws` — see D-111.
   *
   * ⚠ **Never proxy `/api/v1/plugins/icons`.** It is a sibling endpoint that
   * returns every plugin's icon as base64 in one body — **2.4 MB / 353 entries**
   * measured on this eight-plugin instance, and it grows with the plugin count.
   * The list endpoint is ~45 KB. `listPluginIcons` below reads it SERVER-SIDE
   * and hands the browser one icon per plugin — **27.6 KB for all eight**,
   * measured through `/api/engine/plugins`. That is not a proxy, and the
   * distinction is the whole point: 27.6 KB is a page's worth of logos, 2.4 MB
   * is the engine's entire icon set travelling to a browser that needs eight.
   */
  listPlugins() {
    return this.request<KestraPlugin[]>("GET", "/api/v1/plugins");
  }

  /**
   * Every registered class's icon, as base64 SVG, keyed by class name.
   *
   * ── ⚠ THIS RESPONSE MUST NEVER REACH A BROWSER WHOLE ────────────────────────
   *
   * **2.4 MB across 353 entries**, measured against this engine on 2026-08-09.
   * `enginePluginService` reduces it to ONE icon per plugin — 8 icons, **27.6 KB
   * total**, also measured — before anything is serialised to a client. The
   * sibling docblock on `listPlugins` forbids proxying this endpoint and that
   * prohibition still stands; reading it here to build a small derived answer is
   * the permitted shape.
   *
   * ⚠ **The path has no `/main/` segment.** `/api/v1/main/plugins/icons` is a
   * **404** on this engine while `/api/v1/plugins/icons` is a 200 — verified at
   * the wire, both. Plugins are a property of the engine's build rather than of
   * a tenant, which is the same reason `listPlugins` is unprefixed.
   *
   * ⚠ **An entry's `icon` may be an empty string.** Slack has one such class, so
   * "pick the first icon under this plugin" silently yields a blank logo. The
   * caller picks the most COMMON non-empty icon instead.
   */
  listPluginIcons() {
    return this.request<Record<string, { name?: string; icon?: string } | null>>(
      "GET",
      "/api/v1/plugins/icons",
    );
  }

  /**
   * One class's declared schema — its properties, which are required, and which
   * `$group` each belongs to.
   *
   * ⚠ **The response also carries a `markdown` field of several kilobytes**,
   * including base64 SVG icons and every usage example. `enginePluginService`
   * reads `schema.properties` and NOTHING else; nothing here should hand the
   * markdown to a browser, both because of its size and because those examples
   * are Kestra's own YAML — a client that renders them is being shown flow
   * definitions written against an engine it must never address (R5).
   */
  pluginSchema(cls: string) {
    return this.request<KestraPluginSchema>("GET", `/api/v1/plugins/${encodeURIComponent(cls)}`);
  }

  deleteFlow(ns: NamespaceRef, flowId: string) {
    return this.request<void>(
      "DELETE",
      `/api/v1/main/flows/${encodeURIComponent(ns.value)}/${encodeURIComponent(flowId)}`,
    );
  }

  /**
   * Every flow the engine holds, across all namespaces.
   *
   * ⚠ Deliberately NOT exposed on any tenant-facing path. It crosses namespaces
   * by definition, and R5 says a client is never given a Kestra address at all —
   * this exists for operator tooling (`slate:clear`) that already holds the
   * engine credential. Callers must filter by namespace themselves; there is no
   * workspace scoping to inherit here.
   *
   * `total` is returned alongside so a caller can detect that it asked for a
   * page smaller than the answer, rather than acting on a silent truncation
   * (the shape of I-12).
   */
  searchFlows(opts: { size?: number; page?: number } = {}) {
    const qs = new URLSearchParams({
      size: String(opts.size ?? 100),
      page: String(opts.page ?? 1),
    });
    return this.request<{ results: Array<{ id: string; namespace: string }>; total: number }>(
      "GET",
      `/api/v1/main/flows/search?${qs}`,
    );
  }

  /**
   * Delete one execution and its stored outputs.
   *
   * Terminal states only, in practice: Kestra refuses a `PAUSED` execution,
   * which is correct — purging one destroys a live human approval (the same
   * constraint the retention flow is written around). Callers should let the
   * refusal surface rather than killing the run to make the delete succeed.
   */
  deleteExecution(executionId: string) {
    return this.request<void>(
      "DELETE",
      `/api/v1/main/executions/${encodeURIComponent(executionId)}`,
    );
  }

  // ── Executions ─────────────────────────────────────────────────────────────

  /**
   * Start an execution. Inputs go as multipart form fields, which is what
   * Kestra's trigger endpoint expects.
   *
   * ⚠ R2: NEVER pass a tenant credential here. Kestra persists execution inputs
   * in its database, so a DSN or API key passed as an input is a tenant
   * credential at rest in Kestra. The only thing that legitimately travels this
   * way is the short-lived execution token (R3), which grants nothing on its own.
   */
  async startExecution(
    ns: NamespaceRef,
    flowId: string,
    inputs: Record<string, string> = {},
    labels: Record<string, string> = {},
  ): Promise<KestraExecution> {
    const form = new FormData();
    for (const [k, v] of Object.entries(inputs)) form.append(k, v);

    const qs = new URLSearchParams();
    // Labels carry workspace + revision so `kestra-ui` stays filterable during
    // internal debugging without Foundry having to cross-reference every id.
    for (const [k, v] of Object.entries(labels)) qs.append("labels", `${k}:${v}`);

    const headers: Record<string, string> = {};
    if (this.auth) headers["authorization"] = this.auth;

    const url =
      `${this.baseUrl}/api/v1/main/executions/${encodeURIComponent(ns.value)}/` +
      `${encodeURIComponent(flowId)}${qs.toString() ? `?${qs}` : ""}`;

    // Not via request(): FormData must set its own multipart boundary, so the
    // content-type header has to be left alone.
    const res = await fetch(url, { method: "POST", headers, body: form });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text */
    }
    if (!res.ok) {
      throw new KestraError(`Kestra POST executions → ${res.status}`, res.status, parsed);
    }
    return parsed as KestraExecution;
  }

  getExecution(executionId: string) {
    return this.request<KestraExecution>(
      "GET",
      `/api/v1/main/executions/${encodeURIComponent(executionId)}`,
    );
  }

  /**
   * Executions for a namespace.
   *
   * The namespace is a `NamespaceRef`, so it cannot have come from a request
   * body — this is the R4 IDOR that the branded type exists to prevent.
   */
  /**
   * Executions in a namespace, **newest first**.
   *
   * The sort is not decoration. Kestra's search defaults to OLDEST first, so
   * asking for `size: 50` on an instance with 60 executions returns the 50
   * oldest — and every caller that joins the result to a page of recent rows
   * silently matches nothing. It worked on a fresh instance and broke once
   * enough executions had accumulated, which is the worst way for it to break.
   * See ISSUES.md I-12.
   *
   * The field is `state.startDate`, not `startDate`: the latter is rejected with
   * `Invalid sort field`, and a 422 here would be swallowed by the caller's
   * degrade-gracefully catch.
   */
  listExecutions(ns: NamespaceRef, opts: { size?: number; page?: number; flowId?: string } = {}) {
    const qs = new URLSearchParams({
      namespace: ns.value,
      size: String(opts.size ?? 25),
      page: String(opts.page ?? 1),
      sort: "state.startDate:desc",
    });
    if (opts.flowId) qs.set("flowId", opts.flowId);
    return this.request<{ results: KestraExecution[]; total: number }>(
      "GET",
      `/api/v1/main/executions/search?${qs}`,
    );
  }

  /**
   * Per-taskrun logs for an execution — the "what did the engine say" half of
   * Phase 2's exit criterion.
   *
   * `minLevel` is DEBUG because Kestra logs `http.Request` outcomes at DEBUG; at
   * INFO a step-detail panel shows a failed HTTP step with no request line.
   */
  getExecutionLogs(executionId: string, minLevel = "DEBUG") {
    return this.request<
      Array<{ taskId?: string; taskRunId?: string; timestamp: string; level: string; message: string }>
    >(
      "GET",
      `/api/v1/main/logs/${encodeURIComponent(executionId)}?minLevel=${encodeURIComponent(minLevel)}`,
    );
  }

  /**
   * The flow's topology — real `nodes`/`edges`/`clusters`, not something inferred
   * from task order. This is why `StepGraph` is a renderer and not a layout
   * engine, and why a parallel or conditional flow will draw correctly without
   * the UI learning anything new.
   *
   * Takes plain strings rather than a `NamespaceRef`: it is called with a
   * namespace that came back FROM Kestra on an execution Foundry already
   * authorised by workspace, so there is no client-supplied value to brand.
   */
  getFlowGraph(namespace: string, flowId: string) {
    return this.request<{
      nodes: Array<{ uid?: string; id?: string; type?: string; task?: { id?: string; type?: string } }>;
      edges: Array<{ source: string; target: string }>;
      clusters?: unknown[];
    }>(
      "GET",
      `/api/v1/main/flows/${encodeURIComponent(namespace)}/${encodeURIComponent(flowId)}/graph`,
    );
  }

  /**
   * Resume a paused execution — how a paused step un-pauses when its
   * run reaches a terminal state (§6.2, M2).
   *
   * **Multipart, not JSON, and `onResume` inputs are form FIELDS.** Kestra
   * models resume inputs exactly like execution inputs, so this mirrors
   * `startExecution` rather than `request()`. Posting JSON here is accepted with
   * a 2xx and the inputs are silently dropped, which surfaces later as an agent
   * step whose downstream reads `null` — a failure with no error attached to it.
   *
   * `taskRunId` targets ONE paused task. An execution can hold more than one
   * paused `Pause` (two agent steps in parallel), and an untargeted resume
   * un-pauses whichever Kestra picks — so the caller passes the taskrun it is
   * actually answering for.
   */
  async resumeExecution(
    executionId: string,
    onResume: Record<string, string> = {},
    taskRunId?: string,
  ): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(onResume)) form.append(k, v);

    const headers: Record<string, string> = {};
    if (this.auth) headers["authorization"] = this.auth;

    const qs = taskRunId ? `?taskRunId=${encodeURIComponent(taskRunId)}` : "";
    const url = `${this.baseUrl}/api/v1/main/executions/${encodeURIComponent(executionId)}/resume${qs}`;

    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* leave as text */
      }
      throw new KestraError(`Kestra POST executions/resume → ${res.status}`, res.status, parsed);
    }
  }

  /** Replay from a task, with upstream outputs rehydrated — the capability we could not build well ourselves. */
  replayExecution(executionId: string, taskRunId?: string) {
    const qs = taskRunId ? `?taskRunId=${encodeURIComponent(taskRunId)}` : "";
    return this.request<KestraExecution>(
      "POST",
      `/api/v1/main/executions/${encodeURIComponent(executionId)}/replay${qs}`,
    );
  }

  killExecution(executionId: string) {
    return this.request<void>(
      "DELETE",
      `/api/v1/main/executions/${encodeURIComponent(executionId)}/kill`,
    );
  }
}

export const kestra = new KestraClient();
