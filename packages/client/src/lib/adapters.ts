// src/lib/adapters.ts — pure mappers between the Foundry Parent API shapes
// (FA*, see foundry-client.ts) and the UI's domain model (types.ts). The data
// seam (api.ts) uses these so page components stay unchanged.
import { fmtDuration, fmtWhen } from "@/lib/stats";
import type {
  Connection, ConnectorCategory, ConnectorManifest, AssetNode, Run, Status,
  Tool, ToolParam, DataType, Trigger, TriggerFire,
  FlowExecutionSummary, FlowExecutionDetail, StepRun, StepStatus, StepGraphShape,
  ExpectationStatus,
  FlowSummary,
} from "@/lib/types";
import type {
  FATool, FADatasource, FASchemaEntity, FATrigger, FATriggerFire,
  FAFlowExecutionSummary, FAFlowExecutionDetail, FAFlowStepRun, FAFlow,
} from "@/lib/foundry-client";
import {
  HTTP_METHODS, authFindings, needsAuthParamName, typeForMethod, type AuthStyle,
} from "@/lib/tool-edit";
// tool-probe P3 — the wire's `lastProbe` is NARROWED here, not trusted; see the
// note at the `lastProbe` field below.
import { probeMarkFromWire } from "@/lib/tool-probe";

// ============================ Tools ==========================================

/**
 * ⚠ `description` MUST survive this round trip, and for a long time it did not.
 *
 * A parameter's description is what tells the drafter that `recipients` takes
 * "one address or an array of up to 50" rather than just that it is an array.
 * Every seeded tool carries them. These two functions read and wrote only
 * `type`, so opening any tool in the edit modal and pressing Save — with no
 * edits at all — silently deleted every one of them.
 *
 * It was worse than losing prose. `refFingerprints()` hashes the WHOLE
 * `paramsSchema`, so stripping descriptions changes the tool's fingerprint, and
 * the staleness sweep then marks every flow using that tool `suspended` and
 * removes its Kestra schedule. Pressing Save on an unchanged tool disarmed
 * automations.
 *
 * Two shapes are read, because both are in the wild: a JSON-Schema
 * `{properties, required}` object, and the flat `{name: {type, required,
 * description}}` map that `demo/tool-catalogue.ts` and the manifest builder use.
 * Writing back preserves whichever keys were there.
 */
function jsonSchemaToParams(schema: unknown): ToolParam[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    properties?: Record<string, ParamDef>;
    required?: string[];
    [k: string]: unknown;
  };

  const asDataType = (t: string | undefined): DataType =>
    t === "integer" ? "integer"
    : t === "number" || t === "float" ? "float"
    : t === "boolean" ? "boolean"
    : t === "array" ? "array"
    : "string";

  if (s.properties && typeof s.properties === "object") {
    const required = new Set(s.required ?? []);
    return Object.entries(s.properties).map(([name, def]) => ({
      name,
      dataType: asDataType(def?.type),
      required: required.has(name) || def?.required === true,
      description: def?.description ?? "",
    }));
  }

  // Flat map — the shape the tool catalogue and the manifest builder use.
  return Object.entries(s)
    .filter(([, def]) => def && typeof def === "object")
    .map(([name, def]) => {
      const d = def as ParamDef;
      return {
        name,
        dataType: asDataType(d.type),
        required: d.required === true,
        description: d.description ?? "",
      };
    });
}

type ParamDef = { type?: string; required?: boolean; description?: string };

/**
 * Written in the FLAT shape, because that is what the manifest builder reads.
 *
 * `manifest-builder.service.ts` iterates `Object.entries(paramsSchema)` and
 * reads `type` / `required` / `description` off each value directly. A
 * JSON-Schema envelope would give it two entries — `type: "object"` and
 * `properties` — and the manifest would render two nonsense params. That is why
 * this is not the more familiar shape.
 *
 * ⚠ Exported since foundations Phase 1.2, and it must stay the ONE producer of
 * this shape. The tool form needs it to compare a draft against what is stored —
 * `paramsSchema` is inside `refFingerprints()`'s hash, so a re-serialisation
 * that differed from this one by a key order or an omitted blank would report a
 * suspension for a save that changes nothing.
 */
export function paramsToJsonSchema(params?: ToolParam[]): Record<string, unknown> | undefined {
  if (!params?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const type = p.dataType === "integer" ? "integer" : p.dataType === "float" ? "number" : p.dataType;
    out[p.name] = {
      type,
      required: p.required,
      ...(p.description?.trim() ? { description: p.description.trim() } : {}),
    };
  }
  return out;
}

export function toolFromFA(t: FATool): Tool {
  const method = (t.method ?? "GET").toUpperCase();
  // `typeForMethod` lives in `lib/tool-edit.ts` because the FORM needs the same
  // answer: the type is derived here on the way in, so a form offering it as a
  // free choice would let someone pick "changes data" beside a GET and watch it
  // come back as "read-only" on reload — the I-39 shape, a field that saves and
  // shows something else. One function, both directions.
  const type: Tool["type"] = t.kind === "real" ? typeForMethod(method) : "read-only";
  let app = "—";
  if (t.url) {
    try {
      app = new URL(t.url).host;
    } catch {
      /* keep default */
    }
  }
  // The `else if (t.kind === "dummy") app = "Mock"` branch is gone with dummy
  // tools. A tool with no URL is now impossible to create, so the "—" default
  // means an older row, not a mock.
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    description: t.description ?? "",
    app,
    type,
    // Phase 7 — the real ref count. `?? 0` covers an old server row that has
    // no count yet: absent and zero render the same honest "—" on the page.
    usedBy: t.usedBy ?? 0,
    status: t.isActive ? "ok" : "neutral",
    statusText: t.isActive ? "Ready" : "Off",
    endpoint: t.url ?? undefined,
    method,
    secretEnvName: t.secretEnvName,
    // ⚠ Both read, and until foundations Phase 1.2 neither was. The server has
    // returned them from `toPublic` since WS-B.4; the client dropped them on the
    // floor, so the edit form could not show a tool's existing credential
    // configuration and had nothing to compare a change against. That absence is
    // half of I-124: a form that cannot READ the auth cannot warn that changing
    // it moves the ref fingerprint.
    authStyle: t.authStyle ?? null,
    authParamName: t.authParamName ?? null,
    // Phase 7 — the oauth2_client_credentials fields, nullable on the wire.
    tokenUrl: t.tokenUrl ?? null,
    clientIdSecretRef: t.clientIdSecretRef ?? null,
    clientSecretSecretRef: t.clientSecretSecretRef ?? null,
    /**
     * tool-probe P3 — passed through, never defaulted to a shape.
     *
     * ⚠ `?? null` collapses "an older server that does not send the field" and
     * "this server has no marker" into the SAME value, which is correct: both mean
     * *there is no record of a probe*, and the page renders nothing for it. What
     * would be wrong is inventing `{verdict: "unknown"}` here — the page has no
     * way to tell an invented verdict from a measured one.
     *
     * ⚠ And a verdict WORD this build does not know is also `null`:
     * `probeMarkFromWire` refuses it rather than letting it reach `TITLE[…]` and
     * render the literal `undefined` on the row.
     */
    lastProbe: probeMarkFromWire(t.lastProbe),
    params: jsonSchemaToParams(t.paramsSchema),
  };
}

/** Map a UI create-tool input → an App A createTool/generateDummyTool body.
    A tool name must be a valid identifier for the manifest; we slugify. */
/**
 * A tool create/update body.
 *
 * This used to return `{ dummy, body }` and, when no `http(s)://` endpoint was
 * given, produced a DUMMY tool: `{ method: "GET", sample: {...} }` posted to
 * `/tools/dummy/generate`, which registered a tool whose response was a stored
 * template interpolated with request fields. It returned one fixed shape however it
 * was called, so a test call proved nothing about the parameters.
 *
 * That whole path is deleted server-side, so a tool now needs a real endpoint. The
 * URL is validated HERE as well as on the server, because the alternative is a 400
 * whose message the form does not show next to the field that caused it.
 */
/**
 * ⚠ **`method` is a REAL FIELD here now, and the inference it replaces was not a
 * cosmetic limitation** (foundations Phase 1.2, I-124).
 *
 * This used to emit `input.type === "changes data" ? "POST" : "GET"`, so
 * PUT, PATCH, DELETE, HEAD and OPTIONS were unreachable from the UI entirely —
 * and worse than unreachable, because the stored value decides behaviour twice:
 * `applyAuth` puts a `query`-style credential on the URL, and `invokeTool`
 * branches on GET/HEAD to decide whether a step's parameters become a query
 * string or a JSON body. An inferred method silently picks where the parameters
 * go.
 *
 * The fallback for a caller that supplies none is the OLD inference, kept on
 * purpose: `lib/tool-params.test.ts` and any other non-form caller must keep
 * working, and defaulting to GET instead would turn a "changes data" tool into a
 * read. It is a compatibility shim, not the mechanism — the form always sends a
 * method.
 *
 * The credential fields carry the same cross-field rules
 * `createToolSchema.superRefine` enforces, via the same `authFindings` the form
 * renders per field. Two implementations of "a bearer style needs a credential"
 * would eventually disagree, and the one that matters is whichever the server
 * runs — so this is a backstop that cannot drift from what the form said.
 */
export function toolInputToFA(input: {
  name: string;
  description?: string;
  type?: Tool["type"];
  endpoint?: string;
  method?: string;
  params?: ToolParam[];
  secretEnvName?: string | null;
  authStyle?: AuthStyle | null;
  authParamName?: string | null;
  tokenUrl?: string | null;
  clientIdSecretRef?: string | null;
  clientSecretSecretRef?: string | null;
}): { body: Record<string, unknown> } {
  const identifier =
    input.name.trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1") || "tool";
  const paramsSchema = paramsToJsonSchema(input.params);
  const endpoint = input.endpoint?.trim();
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    throw new Error(
      "a tool needs a full endpoint URL starting with http:// or https:// — that is the address Tether calls",
    );
  }

  const method = (input.method ?? (input.type === "changes data" ? "POST" : "GET")).toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `"${method}" is not an HTTP method Tether can call — one of ${HTTP_METHODS.join(", ")}`,
    );
  }

  const authStyle = input.authStyle ?? null;
  const secretEnvName = input.secretEnvName?.trim() || null;
  const authParamName = input.authParamName?.trim() || null;
  const tokenUrl = input.tokenUrl?.trim() || null;
  const clientIdSecretRef = input.clientIdSecretRef?.trim() || null;
  const clientSecretSecretRef = input.clientSecretSecretRef?.trim() || null;
  const findings = authFindings({
    authStyle, secretEnvName, authParamName, tokenUrl, clientIdSecretRef, clientSecretSecretRef,
  });
  if (findings.length > 0) throw new Error(findings.map((f) => f.message).join(" "));

  // The oauth2 style reads its credentials from the two refs and has no single
  // `secretEnvName`; every other style reads one credential and rejects the
  // trio. The form renders only the fields the chosen style uses, so this is
  // the same rule the payload must obey when a save SWITCHES styles — a
  // oauth2→bearer save clears the trio with explicit nulls (the "sent as null
  // rather than omitted" rule, below), and a bearer→oauth2 save drops the
  // single credential name the same way.
  const isOauth2 = authStyle === "oauth2_client_credentials";

  return {
    body: {
      name: identifier,
      description: input.description,
      url: endpoint,
      method,
      ...(paramsSchema ? { paramsSchema } : {}),
      // ⚠ Sent as `null` rather than omitted when cleared, and the difference is
      // the whole of "can auth be REMOVED from a tool". `updateToolSchema`
      // declares all three `.nullable()`; an omitted key leaves the stored value
      // in place, so a form that omitted them could add a credential and never
      // take one away. On CREATE the server reads `?? null` for each, so a null
      // is exactly what it would have written anyway.
      secretEnvName: isOauth2 ? null : secretEnvName,
      authStyle,
      // Only the two styles that use it, so switching bearer→header→bearer does
      // not leave a stale header name inside the ref fingerprint.
      authParamName: needsAuthParamName(authStyle) ? authParamName : null,
      // Only the oauth2 style uses the trio; other styles send null so a PATCH
      // that leaves oauth2 clears the stale values instead of letting them sit
      // inside the row (same rule as `authParamName` above).
      tokenUrl: isOauth2 ? tokenUrl : null,
      clientIdSecretRef: isOauth2 ? clientIdSecretRef : null,
      clientSecretSecretRef: isOauth2 ? clientSecretSecretRef : null,
    },
  };
}

// ========================= Datasources / Connections =========================

const TYPE_TO_CATEGORY: Record<string, ConnectorCategory> = {
  postgres: "StructuredData",
  postgresql: "StructuredData",
  mysql: "StructuredData",
  oracle: "StructuredData",
  sqlserver: "StructuredData",
  mongodb: "NoSQL",
  mongo: "NoSQL",
};

/**
 * ⚠ A NULL `testStatus` means "never tested", not "being tested".
 *
 * It used to map to `pending`, which the page rendered as **"Queued"** — and
 * the page then polled for a transition that can only ever be caused by a human
 * clicking Test. So a perfectly healthy datasource read as work-in-progress,
 * for ever, and the UI spun waiting on it. Every datasource registered by
 * `demo:seed` was in that state, because `datasourceService.update` sets
 * `test_status = null` whenever the connection string changes.
 *
 * `untested` is now its own state with its own neutral pill and no polling. The
 * distinction is the same one `demoStatus` makes with `-1` for a capture table
 * it could not read: "not answered" and "answered, nothing there" are different
 * facts, and collapsing them is how a UI ends up confidently wrong.
 */
function testStatusToConnStatus(s: string | null | undefined): Connection["status"] {
  if (s === "success" || s === "connected" || s === "ok") return "ready";
  if (s === "error" || s === "failed") return "error";
  if (s === "testing" || s === "pending" || s === "discovering") return "pending";
  return "untested";
}

/** Resource-list `status` vocabulary mapped back to connection health. */
function resourceStatusToConnStatus(s: string | null | undefined): Connection["status"] {
  if (s === "published") return "ready";
  if (s === "failed") return "error";
  if (s === "pending-review") return "pending";
  return "untested";
}

/**
 * The one `resource_status` value that hides a datasource from the model.
 *
 * ⚠ A MIRROR of the server's `DATASOURCE_PAUSED_STATUS`, and the server is the
 * authority — this only decides how a row is LABELLED and which button is
 * offered. The same posture as `connectors.ts`'s `REGISTRABLE` set: it goes
 * wrong loudly (a paused source rendered as running) rather than silently
 * granting anything.
 */
const DATASOURCE_PAUSED_STATUS = "paused";

type DatasourceRow = FADatasource & { status?: string | null };

export function connectionFromFA(d: DatasourceRow): Connection {
  // GET /datasources serves the Resource projection (status + testStatus);
  // single-create/update paths serve the bare datasource (testStatus only).
  // Prefer the raw testStatus when present — Resource.status cannot
  // round-trip it (draft covers both never-tested and not-applicable).
  const rawTestStatus = "testStatus" in d ? d.testStatus : undefined;
  let status: Connection["status"];
  if (rawTestStatus !== undefined && rawTestStatus !== null) {
    status = testStatusToConnStatus(rawTestStatus);
  } else if ("status" in d && typeof d.status === "string") {
    status = resourceStatusToConnStatus(d.status);
  } else {
    status = "untested";
  }
  return {
    id: d.id,
    name: d.name,
    connector_id: d.type,
    category: TYPE_TO_CATEGORY[d.type?.toLowerCase()] ?? "StructuredData",
    status,
    // ⚠ This value was spelled `"vault"` and meant nothing of the kind (D-117,
    // I-122). It is derived from `secretEnvName` — whether this data source
    // DECLARES a credential name, which the manifest renders as `<secretRef>` and
    // `/keys` audits. It never had any connection to the wizard's "fetch the
    // secret from a vault" mode, which reached no server route and is now refused.
    //
    // The two met anyway: `/keys` passed this field in as `CredentialForm`'s
    // `initialMode`, so a data source with a name declared reopened its sign-in
    // form in the mode that could only assemble a password-less DSN. One word
    // meaning two things is how that survived review, so the word changed.
    credential_source: d.secretEnvName ? "secret_ref" : "direct",
    /**
     * ⚠ **Read from the RAW status, never from `status` above.** That field is
     * a connection health word (`connected`/`error`/`untested`) and cannot
     * carry this — `resourceStatusToConnStatus` maps `"paused"` to one of its
     * own values, so deriving the pause from it would answer a different
     * question. Both spellings are read because the list route serves the
     * Resource projection (`status`) and create/update serve the bare row
     * (`resourceStatus`); a row that carries neither is not paused.
     */
    paused_from_model:
      d.status === DATASOURCE_PAUSED_STATUS ||
      (d as { resourceStatus?: unknown }).resourceStatus === DATASOURCE_PAUSED_STATUS,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    last_tested_at: d.lastTestedAt,
    secret_env_name: d.secretEnvName,
    column_tags: d.columnTags ?? {},
  };
}

/** Assemble a DB connection string from a connector's onboarding payload. */
export function assembleConnectionString(
  connectorId: string,
  payload: Record<string, unknown>,
  manifest?: ConnectorManifest,
): { type: string; connectionString: string } {
  // If the user (or a connector) supplied a full DSN, honour it.
  const raw = (payload.connection_string ?? payload.url ?? payload.dsn ?? payload.uri) as string | undefined;
  const id = connectorId.toLowerCase();
  const schemeMap: Record<string, string> = {
    postgres: "postgresql",
    postgresql: "postgresql",
    mysql: "mysql",
    mongodb: "mongodb",
    mongo: "mongodb",
  };
  const type = id.includes("mysql") ? "mysql" : id.includes("mongo") ? "mongodb" : id.includes("postgres") ? "postgres" : id;
  if (raw && /:\/\//.test(raw)) return { type, connectionString: raw };

  const scheme = schemeMap[id] ?? manifest?.trino?.connector_name ?? id;
  const host = String(payload.host ?? "localhost");
  const port = String(payload.port ?? (id.includes("mysql") ? 3306 : id.includes("mongo") ? 27017 : 5432));
  const database = String(payload.database ?? payload.db ?? "");
  const user = encodeURIComponent(String(payload.username ?? payload.user ?? ""));
  const pass = encodeURIComponent(String(payload.password ?? ""));
  const auth = user ? `${user}${pass ? `:${pass}` : ""}@` : "";
  const query = tlsParams(type, payload);
  return {
    type,
    connectionString: `${scheme}://${auth}${host}:${port}${database ? `/${database}` : ""}${query}`,
  };
}

/**
 * The TLS parameters — collected by the advanced form since it was written, and
 * carried by the DSN since 2026-09-17. I-132, and it made a whole class of
 * database impossible to onboard.
 *
 * ── ⚠ THIS IS WHAT "no pg_hba.conf entry … no encryption" WAS ────────────────
 *
 * Azure Postgres Flexible Server — and RDS, and most managed Postgres — refuses
 * an unencrypted connection. Registration therefore died in
 * `assertRegistrableTarget`, the first gate, which dials the database before
 * anything is stored, and it reported the server's own complaint about
 * `pg_hba.conf`. That reads as *their* database being misconfigured, while the
 * SSL mode the person had chosen sat one field above in `payload`, unread.
 *
 * Measured against the live Azure instance, identical credential, one parameter
 * apart: with `?sslmode=require` the target gate allows, the privilege probe
 * measures and `schemaIntrospectorService.test` answers `{ok:true}`; without it,
 * every one of them fails at connect.
 *
 * ⚠ **NO SINGLE VALUE WORKS FOR BOTH KINDS OF DATABASE, which is why the field
 * is load-bearing rather than a nicety.** Measured on `pg` 8.23: `prefer`,
 * `require` and `verify-ca` are all treated as aliases for `verify-full`, and
 * **none of them falls back to plaintext** — including with
 * `uselibpqcompat=true`, which is the documented way to ask for libpq's own
 * semantics. So a plain Postgres with no TLS is reachable only by choosing
 * `disable` explicitly, and that is what the dropdown is for. Do not "simplify"
 * this by hardcoding a default and deleting the field.
 *
 * `disable` is EMITTED rather than omitted. The two behave identically, but a
 * DSN that says what the person chose beats one that means it by absence.
 *
 * ⚠ **MySQL's `require_tls` is the same field under another name, and the
 * spelling is not `require_tls`.** mysql2 rejects that as an unknown connection
 * option — it warns today and states it will throw in a future version — so
 * passing it through verbatim would have been a second inert field wearing a
 * working one's clothes. The option it reads from a URI is `ssl`, carrying a
 * JSON profile. ⚠ Verified by PARSING (`?ssl={"rejectUnauthorized":true}`
 * yields `{rejectUnauthorized: true}` on mysql2's own connection config) and
 * **not** by a handshake: there is no MySQL in this stack to dial.
 */
function tlsParams(type: string, payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (type === "postgres") {
    const mode = typeof payload.sslmode === "string" ? payload.sslmode.trim() : "";
    if (mode) params.set("sslmode", mode);
  } else if (type === "mysql") {
    // Only `true` opts in. An absent or false value leaves the DSN alone rather
    // than asserting a profile the person did not ask for.
    if (payload.require_tls === true) params.set("ssl", JSON.stringify({ rejectUnauthorized: true }));
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

/** App A returns a flat SchemaEntity[]; wrap it under one synthetic db_schema root
    so the UI's recursive AssetTree renders unchanged. PK/FK ride in attributes. */
export function schemaEntitiesToAssetTree(entities: FASchemaEntity[], connId: string): AssetNode[] {
  const tables: AssetNode[] = entities.map((e) => ({
    asset_id: `${connId}_${e.name}`,
    asset_type: "table",
    name: e.name,
    attributes: { row_count: e.rowCountEstimate ?? undefined, entity_type: e.entityType, schema: e.schema ?? undefined },
    children: e.columns.map((c) => ({
      asset_id: `${connId}_${e.name}_${c.name}`,
      asset_type: "column",
      name: c.name,
      attributes: {
        type: c.type,
        nullable: c.nullable,
        primary_key: c.isPrimaryKey || undefined,
        foreign_key: c.foreignKeyReference || undefined,
        tag: c.tag || undefined,
      },
    })),
  }));
  return [{ asset_id: `${connId}_public`, asset_type: "db_schema", name: "public", children: tables }];
}

// ================================ Triggers ===================================

/**
 * ⚠ One icon per server type, and it used to be **lossy in both directions**
 * (`issues.md` I-94): `poll` rendered as a schedule and `manual` as a webhook,
 * so two kinds that behave differently were drawn identically to two that do
 * something else. `schedule` survives for rows predating the server's refusal
 * of a flow-bound schedule trigger.
 */
const A_TYPE_TO_ICON: Record<string, Trigger["icon"]> = {
  manual: "manual",
  webhook: "webhook",
  poll: "poll",
  api: "api",
  schedule: "schedule",
};

/** How a fire was started, in the words the card already uses elsewhere. */
const FIRED_BY_WORDS: Record<string, string> = {
  manual: "manually",
  schedule: "on a schedule",
  poll: "by a poll",
  webhook: "by a webhook",
  api: "by an API call",
};

/**
 * One fire audit row.
 *
 * ⚠ The payload is deliberately DROPPED here rather than carried through to the
 * UI type. It is redacted server-side, but it is still arbitrary third-party
 * JSON from an unauthenticated public webhook URL, and it is not what the screen
 * is for: the questions this trail answers are *did it fire* and *did anything
 * start*. Adding it later is a decision to make on purpose, not a field to
 * inherit by default.
 */
export function triggerFireFromFA(f: FATriggerFire): TriggerFire {
  return {
    id: f.id,
    how: FIRED_BY_WORDS[f.firedBy] ?? f.firedBy,
    when: f.firedAt ? fmtWhen(f.firedAt, Date.now()) : "",
    whenIso: f.firedAt ?? null,
    // ⚠ `?? null` and never a default id. A fire that started nothing is the row
    // worth reading, and coercing it to anything else erases the finding.
    startedRunId: f.flowExecutionId ?? null,
    startedRunStatus: f.flowExecutionStatus ?? null,
  };
}

export function triggerFromFA(t: FATrigger): Trigger {
  const icon = A_TYPE_TO_ICON[t.type] ?? "webhook";
  const approval = t.approvalState ?? null;
  // A flow-bound trigger being "enabled" is not the whole story: gate 2 decides
  // whether the flow may run unattended at all, and it can revoke or go stale
  // long after the trigger was switched on. So "Live" requires BOTH.
  const armed = !approval || approval.armedRevision != null;
  const live = t.enabled && armed;
  const rows: Trigger["rows"] = [];
  // WS-H0.3: name what this trigger actually starts. A trigger card that shows a
  // schedule but not the automation it fires is unreviewable.
  if (t.automationName) rows.push({ label: "Starts", value: t.automationName });
  if (approval) {
    rows.push({
      label: "Approved revision",
      value: approval.armedRevision != null ? `v${approval.armedRevision}` : "none — not approved",
    });
    if (approval.approval?.approverUserId) {
      rows.push({ label: "Approved by", value: approval.approval.approverUserId });
    }
    if (approval.draftAhead && approval.armedRevision != null) {
      // The §6.5 guarantee, said out loud on the card: the edit is NOT what runs.
      rows.push({ label: "Waiting", value: "a newer draft is not approved and will not run" });
    }
  }
  if (t.webhookPath) rows.push({ label: "Address", value: t.webhookPath, mono: true });
  if (t.lastFiredAt) rows.push({ label: "Last fired", value: fmtWhen(t.lastFiredAt, Date.now()) });
  // The automation's own cron, said where the trigger is read. It lives on the
  // MODEL and is deployed by approving a revision (D-18) — so it is worth
  // showing next to a trigger and would be wrong to store on one.
  if (t.scheduleCron) rows.push({ label: "Also runs", value: t.scheduleCron, mono: true });
  /**
   * ⚠ `config` is NOT rendered as rows any more (`issues.md` I-92).
   * `Object.entries(config)` reached `String({period: "2026-06"})` for the one
   * key that matters, so every trigger carrying inputs showed a row reading
   * `inputs → [object Object]`. `declaredInputs` is the replacement, and it says
   * more than the raw config could: which inputs exist, and who supplies each.
   */
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    flowId: t.flowId ?? null,
    name: t.name,
    kind: t.type,
    icon,
    quote: t.automationName
      ? `Starts “${t.automationName}” on ${t.type}.`
      : `Fires the bound automation on ${t.type}.`,
    state: live ? "Live" : "Draft",
    // `suspended` is a warning, not a neutral draft: something WAS running
    // unattended and has stopped, which is different from never having started.
    stateStatus: live ? "ok" : approval?.status === "suspended" ? "warn" : "neutral",
    rows,
    secondary: "Edit",
    automationName: t.automationName,
    enableReady: t.enableReady,
    enableBlockedReason: t.enableBlockedReason,
    approvalBlockedReason: t.approvalBlockedReason ?? null,
    approvalStatus: approval?.status ?? null,
    armedRevision: approval?.armedRevision ?? null,
    draftAhead: approval?.draftAhead ?? false,
    // ⚠ An absent list and an empty one collapse here, and they mean different
    // things — "this server does not report inputs" against "this automation
    // declares none". They are allowed to collapse only because the second
    // reading is the harmless one: both render no input section, and the
    // warning that WOULD be wrong to lose comes from the same server in the
    // same response, so it is absent in exactly the same case.
    declaredInputs: t.declaredInputs ?? [],
    inputsFromRevision: t.inputsFromRevision ?? null,
    scheduleCron: t.scheduleCron ?? null,
    inputsWarning: t.inputsWarning ?? null,
    draftedFromPlan: (t.config as { draftedFrom?: string } | null)?.draftedFrom === "plan",
  };
}

/**
 * A `flows` row + its approval state → the shape the Flows pages render.
 *
 * `schedule` is passed in rather than read off the row: the cron lives on
 * `flow_revisions.model_json` (D-18), which the list endpoint does not return.
 * Faking it here would put a cron on a card that might not match the revision
 * actually deployed.
 */
export function flowFromFA(f: FAFlow, schedule?: string | null): FlowSummary {
  const st = f.approvalState;
  // P5 B-06/B-07 — owner/resources when backend exposes them; honest-empty otherwise.
  const ownerSubject = f.ownerSubject ?? null;
  const ownerName = f.ownerName ?? null;
  const raw = f.resources ?? f.manifestRefs ?? null;
  const resources = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : null;
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    kestraFlowId: f.kestraFlowId,
    // ⚠ Copied, or every Pi flow opens in the compiled builder (which cannot read it: no DAG, no inputs, no
    // history) and /flows/:id never sends it to its own builder. This adapter copies field by field, so a field
    // the server added is dropped until it is written here — which is exactly what happened (2026-10-10).
    runtime: f.runtime === "foundry" ? "foundry" : f.runtime === "kestra" ? "kestra" : undefined,
    draftRevision: f.draftRevision,
    version: f.version ?? null,
    armedRevision: f.armedRevision,
    status: (st?.status ?? (f.status as FlowSummary["status"])) ?? "draft",
    // ⚠ The list endpoint sends `schedule` on the row itself; this adapter used to read ONLY the argument, so
    // every list view showed "Not scheduled" and the Scheduled tab counted 0.
    schedule: schedule ?? f.schedule ?? null,
    approvedBy: st?.approval?.approverUserId ?? null,
    approvedAt: st?.approval?.approvedAt ?? null,
    staleReason: st?.approval?.staleReason ?? null,
    blockedReason: st?.blockedReason ?? null,
    draftAhead: st?.draftAhead ?? f.armedRevision == null,
    updatedAt: f.updatedAt,
    ownerSubject,
    ownerName,
    mine: f.mine === true,
    // An older server sends no visibility; then approved meant published, which is what it reads as.
    visibility: f.visibility === "public" || f.visibility === "private" ? f.visibility : f.armedRevision != null ? "public" : "private",
    selfEnabled: st?.approval?.selfEnabled === true,
    reviewRequestedRevision: f.reviewRequestedRevision ?? null,
    othersMayEdit: f.othersMayEdit === true,
    projectId: f.projectId ?? null,
    projectName: f.projectName ?? null,
    resources,
  };
}

// ── The "Automations / Scripts" adapters WERE HERE ──────────────────────────
//
// `automationFromScript`, `automationDetailFromScript`, `executionFromFA`,
// `versionFromFA`, `runFromExecution`, `scriptStatus`, plus the
// `compileResultFromScript` / `buildVerdictFromTests` pair below them, all mapped
// the `scripts` table — deleted in Phase 4 (task 4.11) along with the endpoints
// they read and the pages they fed.
//
// They outlived their subject by one more step than the rest: `lib/api.ts` stopped
// importing them when the mock layer went, so they became exports with no caller,
// still typechecking, still describing a data model that no longer exists.
//
// `buildVerdictFromTests` is the one worth naming. It turned a script's own
// self-test results into a "Go-Live" verdict — and that verdict was never evidence
// of anything: `generation-audit.service.ts` marked `clean` the script that
// hardcoded `period="2023-10"` and emailed 0 of 11 people. What replaced it is a
// draft test run scored against an independent oracle, plus a human approving a
// specific revision. Neither is a self-report.

// ========================= Flow executions (Phase 2) =========================
// archive/kestra-migration/progress/phase-2.md 2.3 — "the primary seam".
//
// Two mappings, and the second is why re-pointing history and the dashboard is
// cheap: a flow execution collapses into the existing `Run` shape, whose
// `steps?: RunStep[]` field has always existed and until now carried exactly one
// synthetic entry ("Ran on the server"). Filling it with real steps makes those
// pages step-aware without either of them changing.

/** Engine vocabulary is already normalised server-side; this only re-types it. */
function toStepStatus(s: string | null | undefined): StepStatus {
  const known: StepStatus[] = [
    "created", "running", "paused", "success", "warning", "failed", "cancelled", "skipped",
  ];
  return known.includes(s as StepStatus) ? (s as StepStatus) : "running";
}

export function flowExecutionSummaryFromFA(e: FAFlowExecutionSummary): FlowExecutionSummary {
  return {
    id: e.id,
    workspaceId: e.workspaceId,
    // ⚠ `?? null` on both, and they are not interchangeable. `flowId` is
    // Foundry's uuid and `flowName` is the slug; they were ONE field until I-23,
    // and the reason that survived so long is that every consumer printed it.
    // Anything that filters or links must read `flowId`; anything a person reads
    // must use `flowName` — see `runLabel` below for the fallback chain.
    flowId: e.flowId ?? null,
    flowName: e.flowName ?? null,
    flowNameSnapshot: e.flowNameSnapshot ?? null,
    flowIdSnapshot: e.flowIdSnapshot ?? null,
    status: e.status,
    engineStatus: e.engineStatus ? toStepStatus(e.engineStatus) : null,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationMs: e.durationMs,
    inputs: e.inputs ?? {},
    replayOfId: e.replayOfId ?? null,
    replayFromStep: e.replayFromStep ?? null,
    autoTest: e.autoTest === true,
  };
}

/**
 * What to call a run on screen.
 *
 * ⚠ One function, because there were two label call sites and I-23's fix has to
 * change both the same way: `/runs/[id]`'s page title and history's automation
 * column. Both printed `flowId` when `flowId` was the slug; both would print a
 * uuid now if either had been missed, and a uuid as a page title is a worse
 * regression than the wrong id space was.
 *
 * `flowNameSnapshot` is preferred when present — it is the flow's `name` as it
 * was when THIS run began, frozen rather than looked up, so a later rename
 * never relabels history. A run from before that field existed carries `null`
 * and falls back to `flowName` (the slug) exactly as it always has.
 *
 * The fallback is deliberately not the uuid. Both name fields are absent only
 * if the server did not send them, and a 36-character hex string is not a
 * name — "this run has no name" is the honest thing to render, and the id is
 * on the page anyway for anyone who needs it.
 */
export function runLabel(e: { flowName: string | null; flowNameSnapshot?: string | null }): string {
  const snap = e.flowNameSnapshot?.trim();
  if (snap) return snap;
  const slug = e.flowName?.trim();
  // Unsaved Forge draft runs use the engine slug `pi-adhoc` — Activity and history must not show that string.
  if (slug === "pi-adhoc") return "Draft test";
  return slug || "Unnamed run";
}

/**
 * What to show (and copy) as a run's Workflow ID.
 *
 * Mirrors `runLabel`'s shape exactly, one identifier over: `flowIdSnapshot` is
 * the flow's `id` as it was when THIS run began, frozen at `begin`-time rather
 * than looked up — so deleting the workflow afterward cannot blank it, the
 * same guarantee `flowNameSnapshot` gives the name. A run from before that
 * field existed carries `null` and falls back to the live `flowId` pointer,
 * which is itself `null` once the flow has been deleted — there is no way to
 * reconstruct a pre-snapshot orphan's true id, so `null` (never a fabricated
 * value) is the honest answer for that case.
 */
export function runWorkflowId(e: { flowId?: string | null; flowIdSnapshot?: string | null }): string | null {
  return e.flowIdSnapshot ?? e.flowId ?? null;
}

export function stepRunFromFA(s: FAFlowStepRun): StepRun {
  return {
    stepId: s.stepId,
    status: toStepStatus(s.status),
    kind: s.kind,
    // ⚠ `?? null` and never `?? ""`. `null` means "not known" and the seam rule
    // reads it as such; an empty string would read as "a ref that is not
    // llm_complete", turning a missing annotation into a positive safety claim.
    ref: s.ref ?? null,
    // ⚠ `=== true`, not `?? false`. An older server that does not send the field
    // must leave every task un-labelled rather than have the canvas silently
    // decide none of them is the platform's.
    platform: (s as { platform?: boolean }).platform === true,
    // Narrowed against the two values the server can send, so an unknown string
    // reads as "not known" rather than being rendered as a claim about data.
    readFrom:
      (s as { readFrom?: string }).readFrom === "sandbox"
        ? "sandbox"
        : (s as { readFrom?: string }).readFrom === "production"
          ? "production"
          : null,
    attempt: s.attempt ?? 1,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMs: s.durationMs,
    request: s.request,
    responseCode: s.responseCode,
    output: s.output,
    // Copied when sent, absent when not — an engine run retains no task inputs, and "given nothing" is a different claim.
    ...(s.input !== undefined ? { input: s.input } : {}),
    ...(s.checks !== undefined ? { checks: s.checks } : {}),
    ...(s.outcome ? { outcome: s.outcome } : {}),
    ...(s.reason ? { reason: s.reason } : {}),
    error: s.error,
    logs: s.logs ?? [],
    kestraTaskrunId: s.kestraTaskrunId,
    auditVerdict: s.auditVerdict,
    oracleScore: s.oracleScore,
    ...(s.items ? { items: s.items.map((x) => ({ ...x, status: toStepStatus(x.status) })) } : {}),
    ...(s.perItem ? { perItem: s.perItem } : {}),
    ...(s.loop ? { loop: s.loop } : {}),
  };
}

export function flowExecutionDetailFromFA(e: FAFlowExecutionDetail): FlowExecutionDetail {
  const steps = (e.steps ?? []).map(stepRunFromFA);
  return {
    ...flowExecutionSummaryFromFA(e),
    engineStatus: toStepStatus(e.engineStatus),
    steps,
    // Fall back to the executed order when Kestra could not supply topology, so
    // the graph degrades to a chain instead of disappearing.
    graph: e.graph ?? (steps.length ? chainGraph(steps) : null),
    engineUnavailable: e.engineUnavailable,
    usedProductionData: e.usedProductionData === true,
    ...(e.dataHidden ? { dataHidden: true } : {}),
    // ⚠ An unrecognised status becomes `unevaluable`, never `passed`. A future
    // server state this build has not heard of is by definition one nobody here
    // can interpret, and the safe reading of "I do not know" is "nobody checked".
    expectations: (e.expectations ?? []).map((v) => ({
      expectationId: v.expectationId,
      stepId: v.stepId,
      status:
        v.status === "passed" || v.status === "failed"
          ? (v.status as ExpectationStatus)
          : "unevaluable",
      detail: v.detail,
      observed: v.observed,
    })),
    ...(e.sharedWithMe ? { sharedWithMe: true } : {}),
    ...(e.canShare ? { canShare: true } : {}),
  };
}

function chainGraph(steps: StepRun[]): StepGraphShape {
  return {
    nodes: steps.map((s) => ({ id: s.stepId, type: null })),
    edges: steps.slice(1).map((s, i) => ({ source: steps[i].stepId, target: s.stepId })),
  };
}

/**
 * A flow execution as a History row.
 *
 * `outcome` follows the ENGINE, not Foundry's `status`. Foundry's row is set by
 * the flow's own `complete` task, so a failed run never updates it and stays
 * `running` for ever (ISSUES.md I-10) — reading it here would show a failed run
 * as still going. The engine's state is the one that is always right.
 *
 * `text` names the first failing STEP. That single sentence is most of Phase 2's
 * exit criterion in the list view: "stopped at `notify` — HTTP 400" tells you
 * where to look before you have opened anything.
 */
export function runFromFlowExecution(
  e: FlowExecutionDetail | FlowExecutionSummary,
  automationName: string,
): Run {
  const detail = "steps" in e ? (e as FlowExecutionDetail) : null;
  const engine = e.engineStatus ?? "running";
  const done = engine === "success" || engine === "warning";
  // Still in flight. Told apart from "stopped" because a live run has neither
  // succeeded nor failed, and calling it a failure is how the dashboard came to
  // count work-in-progress as an incident (see `Run.outcome`).
  const live = engine === "running" || engine === "created" || engine === "paused";
  const failedStep = detail?.steps.find((s) => s.status === "failed" || s.status === "warning");
  const runningStep = detail?.steps.find((s) => s.status === "running" || s.status === "paused");
  // Steps Kestra had to run more than once. A run that succeeded only because a
  // step was re-attempted is NOT the same as one that succeeded first time, and
  // reporting both as "N steps completed" is the same class of false green as
  // the audit that marked a script `clean` while it emailed 0 of 11. The engine
  // records it (`warningOnRetry`, so the execution settles WARNING); this is
  // where it becomes a sentence.
  const retried = detail?.steps.filter((s) => s.attempt > 1) ?? [];
  // For each (phase F): a loop that kept going past failed items ends WARNING — "succeeded with failures", never "stopped".
  const withFailedItems = detail?.steps.find((s) => s.items && (s.perItem?.failed ?? 0) > 0);

  return {
    id: e.id,
    when: e.startedAt ? fmtWhen(e.startedAt, Date.now()) : "just now",
    automation: automationName,
    flowId: e.flowId ?? null,
    flowIdSnapshot: e.flowIdSnapshot ?? null,
    autoTest: e.autoTest === true,
    outcome: done ? "done" : live ? "running" : "stopped",
    text: done
      ? detail
        ? `${detail.steps.length} step${detail.steps.length === 1 ? "" : "s"} completed` +
          (retried.length
            ? ` — "${retried[0].stepId}" succeeded on attempt ${retried[0].attempt}` +
              (retried.length > 1 ? ` (${retried.length} steps were re-attempted)` : "")
            : "") +
          (withFailedItems ? ` — ${withFailedItems.perItem!.failed} of ${withFailedItems.perItem!.ran} items failed in "${withFailedItems.stepId}"` : "")
        : "ran and completed"
      : live
        ? runningStep
          ? `running "${runningStep.stepId}"${engine === "paused" ? " — waiting" : ""}`
          : engine === "created"
            ? "queued"
            : "running"
        : failedStep
          ? `stopped at "${failedStep.stepId}"` +
            (failedStep.responseCode ? ` — HTTP ${failedStep.responseCode}` : "")
          : `run ${engine}`,
    timeTaken: e.durationMs != null ? fmtDuration(e.durationMs) : "—",
    // "Fix & retry" on a run that is still working is an invitation to double-run
    // it, so a live run only ever offers Details.
    action: done || live ? "Details" : "Fix & retry",
    kind: "flow",
    startedAt: e.startedAt ?? undefined,
    durationMs: e.durationMs ?? undefined,
    error: failedStep?.error ?? undefined,
    workspaceId: e.workspaceId,
    steps: detail?.steps.map((s) => ({
      title: s.stepId,
      outcome:
        s.status === "success" || s.status === "warning"
          ? ("done" as const)
          : s.status === "running" || s.status === "paused"
            ? ("running" as const)
            : s.status === "skipped" || s.status === "created"
              ? ("skipped" as const)
              : ("stopped" as const),
      note: s.error ?? summariseOutput(s),
      durationLabel:
        s.durationMs != null ? fmtDuration(s.durationMs) : s.status === "created" ? "—" : "skipped",
    })),
  };
}

/**
 * One line describing what a step produced.
 *
 * Reads the step-API envelope (`results[] / succeeded / failed`) when there is
 * one, because "10 of 11 succeeded" is the sentence that matters — the measured
 * failure this migration exists to fix reported success while doing 0 of 11.
 */
function summariseOutput(s: StepRun): string | undefined {
  const body = s.output?.body;
  if (typeof body !== "string") {
    const value = s.output?.value;
    return typeof value === "string" ? `${value.slice(0, 120)}${value.length > 120 ? "…" : ""}` : undefined;
  }
  if (body === "[redacted]") return "output withheld (contains a credential)";
  try {
    const parsed = JSON.parse(body) as {
      results?: unknown[];
      succeeded?: number;
      failed?: number;
      warnings?: string[];
    };
    if (typeof parsed.succeeded === "number") {
      const total = parsed.results?.length ?? parsed.succeeded + (parsed.failed ?? 0);
      const warn = parsed.warnings?.length ? ` · ${parsed.warnings.join("; ")}` : "";
      return `${parsed.succeeded} of ${total} succeeded${warn}`;
    }
  } catch {
    /* not the step envelope */
  }
  return `${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`;
}
