/**
 * E2E — the UI's own journey, over HTTP, recorded step by step.
 *
 *   pnpm --filter @foundry/server e2e:ui
 *   pnpm --filter @foundry/server e2e:ui --period=2026-05
 *   pnpm --filter @foundry/server e2e:ui --keep      # leave the flow behind to poke at
 *
 * Writes `archive/kestra-migration/progress/e2e-ui-journey.md`: every call the client
 * makes to author, dry-run and then production-run a flow, with **intended
 * behaviour beside real behaviour** and a verdict on each.
 *
 * ── Why this is not another kestra:phaseN script ─────────────────────────────
 *
 * The phase harnesses import services and call them directly. That is right for
 * proving engine properties and wrong for this question, because it silently
 * grants itself access no browser has: it can reach Kestra, it can call a repo, it
 * can pass an argument no route would accept.
 *
 * So this file has ONE self-imposed restriction, and the restriction is the
 * method: **the journey may only use the HTTP surface `packages/client` uses.**
 * Same base URL, same `x-api-key` the Next proxy injects, same verbs and bodies
 * as `lib/foundry-client.ts`. Every step names the `foundryApi.*` method it
 * stands for, and a step with no such method is recorded as a **GAP** rather than
 * quietly performed — a gap in the client surface is a finding, not an obstacle
 * to route around.
 *
 * **There are now no exceptions.** Seeding named queries used to be one, marked
 * SETUP and recorded as a GAP — it was the first thing this exercise found, and
 * the only way to do it was `datasourceQueryRepo.upsertByName` in-process, which
 * is exactly the self-granted access the restriction above exists to prevent.
 * Stage 2 added `POST/PATCH …/datasources/:dsId/queries`, so the journey authors
 * them over HTTP like everything else, and that step is a MATCH. Closing a GAP by
 * building the route is the intended outcome; closing one by relaxing the rule
 * would have made the report agree with itself.
 *
 * ── What "dry run" and "prod run" mean here ──────────────────────────────────
 *
 * Not two modes of one operation. They are different namespaces with different
 * gates, which is the whole design:
 *
 *   DRY   `POST …/flows/:id/test-run` → the DRAFT namespace. Exempt from the
 *         approval gate on purpose: a draft run is how gate 1 ("has this ever
 *         succeeded?") gets satisfied in the first place. No trigger is deployed,
 *         so nothing can fire it on a timer.
 *   PROD  approve a REVISION → the live namespace, then fire a flow-bound
 *         `manual` trigger. `assertMayRunLive` re-checks approval and fingerprint,
 *         and inputs come from `triggers.config.inputs` — never from a caller.
 *
 * ── Honesty rules this file follows ──────────────────────────────────────────
 *
 *  * `intended` is quoted from a doc, a rule (R1–R9) or a decision (D-nn), not
 *    from what the code happens to do. Writing intent from the implementation
 *    makes every verdict MATCH by construction.
 *  * A MISMATCH is recorded and the run CONTINUES. This is a report, not a gate;
 *    stopping at the first one hides everything after it.
 *  * Exit code is 0 for a clean journey, 1 if any step was a hard FAIL (an
 *    unreachable API, a 5xx, a run that did not settle). MISMATCH and GAP do not
 *    fail the run — they are the output.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { SignJWT } from "jose";
import path from "node:path";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { HR_GENERATED_QUERIES } from "../demo/hr-generated.js";
const HR_SCREENING_QUERIES = HR_GENERATED_QUERIES.filter((q) => ["policy_thresholds", "attendance_below_threshold", "attendance_excluded"].includes(q.name));
import { HR_SCREENING_MODEL } from "./hr-screening.model.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { opsClient } from "../services/ops-client.service.js";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PERIOD = arg("period") ?? "2026-06";
const KEEP = process.argv.includes("--keep");
const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const WEB_BASE = (process.env.E2E_WEB_URL ?? "http://localhost:4002").replace(/\/$/, "");
const API_KEY = process.env.PARENT_API_KEY ?? "dev-parent-key";
const AUTHOR = "author@acme-hr.example";
const APPROVER = "approver@acme-hr.example";
/**
 * Signed in, and granted nothing anywhere — the subject of the §1.1 refusal.
 *
 * ⚠ It has to be a THIRD identity. The first version used APPROVER, which is
 * correct exactly once: the next run finds the workspace already claimed by
 * them, so the step that should be refused returns 201 and the journey reports
 * a MISMATCH against its own leftover state. Same shape as I-33.
 */
const STRANGER = "stranger@acme-hr.example";
/**
 * A SUPER ADMIN, and it is the one identity this journey cannot invent.
 *
 * ⚠ Assigning a member is `requireSuperAdmin` now, and that allowlist is
 * `SUPER_ADMIN_EMAILS` in the **API server's** environment — a different process
 * from this script. So the journey has to present an identity the server was
 * already configured with, which means taking the FIRST entry of the same
 * variable rather than minting a name of its own. Minting one would 403 every
 * time and the report would blame the product.
 *
 * ⚠ It is minted with `sub` = that string, so an entry that is an email matches
 * on email and an entry that is a subject matches on subject — either way the
 * server recognises it, which is exactly the subject-or-email fix this depends on.
 *
 * Empty when the deployment has no super admin. The membership step then records
 * a **NOTE** naming the variable rather than a MISMATCH: nothing is wrong with
 * the product, the deployment is unconfigured, and a harness that reported a
 * failure for that would be reporting its own environment.
 */
const SUPER = (process.env.SUPER_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0] ?? "";
/**
 * ⚠ **THE JOURNEY'S DEFAULT IDENTITY, AND RBAC IS WHY IT MOVED** (T101 / risk R-2).
 *
 * Every step used to run as `AUTHOR`, which worked because **106 of the 142
 * workspace-scoped routes carried no authorisation check at all**. They all carry one
 * now, and this deployment has almost no members — so an ordinary identity is refused
 * across most of the journey and the report would blame the product for a deployment
 * that is simply not configured.
 *
 * ⚠ **The change is BROADER than the membership step**, exactly as the task predicted:
 * the journey authors flows, registers datasources, writes secrets and reads runs, and
 * those are six different permissions. Granting the harness a role per step would be a
 * test of the harness; presenting the allowlist holder is the same thing an operator
 * would do on a fresh deployment.
 *
 * ⚠ **Steps that pass an identity EXPLICITLY are untouched** — the refusal checks still
 * run as `AUTHOR`, `APPROVER`, `UNROLED` and `STRANGER`, which is the half of the journey
 * that is actually about roles.
 *
 * ⚠ With the variable unset this falls back to `AUTHOR` and the journey records a
 * **NOTE naming the variable**, never a MISMATCH. A harness reporting its own
 * environment as a product defect is worse than no assertion.
 */
const DEFAULT_IDENTITY = SUPER || AUTHOR;

const FLOW_NAME = "E2E UI journey — attendance screening";
/** Its own flow id, so a run of this script never collides with kestra:phase3's. */
const FLOW_KESTRA_ID = "e2e-ui-journey";
const REPORT = path.resolve(
  process.cwd(),
  "../../archive/kestra-migration/progress/e2e-ui-journey.md",
);

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ── the recorder ─────────────────────────────────────────────────────────────

/**
 * MATCH    real behaviour is what the design says
 * MISMATCH real behaviour contradicts a stated invariant — recorded, not fixed here
 * GAP      the UI has no way to do this; the journey used a raw route instead
 * NOTE      behaviour that reads as a bug and is not, with the reason
 * FAIL     the journey could not continue as intended
 */
type Verdict = "MATCH" | "MISMATCH" | "GAP" | "NOTE" | "FAIL";

interface Step {
  n: number;
  phase: string;
  /** The `foundryApi.*` method a browser would call, or null when there is none. */
  uiCall: string | null;
  verb: string;
  /** Workspace-relative where possible, so the table stays readable. */
  path: string;
  status: number | string;
  ms: number;
  intended: string;
  real: string;
  verdict: Verdict;
}

const steps: Step[] = [];
let phase = "";
let hardFails = 0;

function setPhase(p: string) {
  phase = p;
  console.log(`\n${"─".repeat(76)}\n${p}\n`);
}

function record(s: Omit<Step, "n" | "phase">) {
  const step: Step = { n: steps.length + 1, phase, ...s };
  steps.push(step);
  if (s.verdict === "FAIL") hardFails++;
  const tag =
    s.verdict === "MATCH"
      ? c.ok("MATCH   ")
      : s.verdict === "MISMATCH"
        ? c.bad("MISMATCH")
        : s.verdict === "FAIL"
          ? c.bad("FAIL    ")
          : s.verdict === "GAP"
            ? c.warn("GAP     ")
            : c.warn("NOTE    ");
  console.log(
    `  ${tag} ${String(step.n).padStart(2)}. ${s.verb.padEnd(6)} ${s.path}  ${c.dim(
      `${s.status} ${s.ms}ms`,
    )}`,
  );
  console.log(`             ${c.dim(s.real)}`);
}

interface CallResult<T = any> {
  status: number;
  body: T;
  ms: number;
  text: string;
}

/**
 * One HTTP call on the client surface.
 *
 * `x-api-key` and nothing else, because that is exactly what
 * `app/api/foundry/[...path]/route.ts` forwards — it injects the key server-side
 * and passes verb, path, query, body and content-type through verbatim. Calling
 * :4000 directly with the key is therefore the same request the browser causes;
 * step 0 checks the proxy hop itself separately.
 */
/**
 * Sign an identity the way the sign-in flow does — Stage 9.1.
 *
 * The browser never builds this: `src/auth.ts` mints it at sign-in and the Next
 * proxy forwards it. The harness mints its own because it has no session, and
 * that is the honest shape of the claim — the API verifies the token against
 * `RUNTIME_JWT_SECRET`, so **holding `PARENT_API_KEY` is no longer enough to
 * name a person**, but anything holding the signing secret can. Two secrets, not
 * authentication of a browser. Do not describe it as the latter.
 */
async function identityFor(email: string): Promise<string> {
  const secret = process.env.RUNTIME_JWT_SECRET ?? process.env.AUTH_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "RUNTIME_JWT_SECRET is not set, so this journey cannot present an identity and every " +
        "approval would 401. Source scripts/kestra-env.sh, or set it to the value the sign-in " +
        "flow signs with.",
    );
  }
  return new SignJWT({ sub: email, email, name: email.split("@")[0] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

/** Cached per email — minting is cheap, but a fresh token per call reads as churn. */
const identities = new Map<string, Promise<string>>();
function identity(email: string): Promise<string> {
  if (!identities.has(email)) identities.set(email, identityFor(email));
  return identities.get(email)!;
}

async function http<T = any>(
  verb: string,
  apiPath: string,
  body?: unknown,
  /**
   * Who the browser is signed in as. Defaults to the author, because that is
   * who is driving for most of the journey; the approval steps pass APPROVER
   * explicitly, which is what makes the self-approval refusal a real test rather
   * than a comparison of two strings the harness chose.
   */
  as: string | null = DEFAULT_IDENTITY,
): Promise<CallResult<T>> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api${apiPath}`, {
    method: verb,
    headers: {
      "x-api-key": API_KEY,
      ...(as ? { "x-foundry-identity": await identity(as) } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T, ms: Date.now() - t0, text };
}

/** Shorten a value for the report table without hiding whether it was empty. */
function digest(v: unknown, max = 120): string {
  if (v === undefined) return "(no body)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── setup, and it is not part of the journey ─────────────────────────────────

async function setup() {
  /**
   * ⚠ **RBAC changed what this journey needs, and it says so up front** (T101 / R-2).
   */
  record({
    uiCall: "(the journey's own identity)",
    verb: "—",
    path: "—",
    status: 0,
    ms: 0,
    intended:
      "Every workspace-scoped route carries an authorisation guard now. The journey has to " +
      "present somebody the server will accept, or it reports its own configuration as a " +
      "product defect.",
    real: SUPER
      ? `Running as the first entry of SUPER_ADMIN_EMAILS. Steps that check a REFUSAL still ` +
        `pass an ordinary identity explicitly, which is the half of this journey that is ` +
        `actually about roles.`
      : `SUPER_ADMIN_EMAILS is unset in THIS process, so the journey runs as ${AUTHOR} and ` +
        `most workspace-scoped steps will be refused. That is a deployment that is not ` +
        `configured, not a broken product — which is why this is a NOTE.`,
    verdict: SUPER ? "MATCH" : "NOTE",
  });

  setPhase("SETUP — outside the journey, and it is here because the UI cannot do it at all");

  const all = await workspaceRepo.list();
  const ws = all.find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed` first');

  const ds = (await datasourceRepo.listByWorkspace(ws.id)).find((d) => d.name === "hr_demo");
  if (!ds) throw new Error('datasource "hr_demo" not found in workspace HR');

  /**
   * Named queries, over HTTP — this used to be the journey's first GAP.
   *
   * Until Stage 2 there was no route at all, so the only way a named query could
   * exist was for a harness to call `datasourceQueryRepo.upsertByName` in-process,
   * which is precisely what this file is not allowed to do: a script that can
   * reach a repo grants itself access no browser has. It is now authored the way
   * the UI authors it, and the interesting part is that the shape rules apply — a
   * seeded query that could not be created through the product would be
   * demonstrating something the product cannot do.
   *
   * POST is a 409 on an existing name rather than an upsert (a silent overwrite
   * would replace SQL an armed flow was approved against), so a re-run PATCHes.
   */
  let created = 0;
  let patched = 0;
  let queryStatus = 0;
  for (const q of HR_SCREENING_QUERIES) {
    const body = {
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    };
    const post = await http("POST", `/workspaces/${ws.id}/datasources/${ds.id}/queries`, body);
    queryStatus = post.status;
    if (post.status === 201) {
      created++;
    } else if (post.status === 409) {
      const patch = await http(
        "PATCH",
        `/workspaces/${ws.id}/datasources/${ds.id}/queries/${q.name}`,
        { sqlText: q.sqlText, paramOrder: q.paramOrder, paramsSchema: q.paramsSchema, description: q.description },
      );
      queryStatus = patch.status;
      if (patch.status === 200) patched++;
    }
  }
  record({
    uiCall: "foundryApi.createNamedQuery / updateNamedQuery",
    verb: "POST/PATCH",
    path: `/workspaces/:ws/datasources/:dsId/queries × ${HR_SCREENING_QUERIES.length}`,
    status: queryStatus,
    ms: 0,
    intended:
      "A `datasource` step names a QUERY by ref, and named queries are half of the callable " +
      "catalogue a flow is built from (04 §5.1). Authoring one is therefore an authoring action, " +
      "and it must be reachable over the same HTTP surface the client uses.",
    real:
      `${created} created, ${patched} updated. This was a GAP until Stage 2 — there was no route ` +
      "under `/queries` at all and the only way to create one was for a harness to call the repo " +
      "in-process. A PATCH reports `willSuspendFlows`: a query's SQL is inside its ref " +
      "fingerprint (D-17), so editing it unarms every flow approved against the old shape.",
    verdict: queryStatus === 201 || queryStatus === 200 ? "MATCH" : "FAIL",
  });

  // Setup, outside the journey: clear the capture tables so "11 messages sent"
  // means this run sent them. Not an HTTP-surface call because it is not part of
  // the journey — the client has no reset and deliberately must not gain one
  // (truncating the audit trail of every automation run from a button is the
  // same mistake `POST /api/demo/reset` was deleted for).
  await opsClient.reset();
  return { ws, ds };
}

// ── phase 0 — what a browser actually loads ─────────────────────────────────

async function phase0(): Promise<string> {
  setPhase("PHASE 0 — the calls every page makes before anything is authored");

  // The proxy hop. Checked separately because it is the only part of the client
  // surface that is NOT :4000, and because its failure mode is invisible from
  // :4000: a 502 envelope that looks like an application error.
  const t0 = Date.now();
  let proxyReal: string;
  let proxyVerdict: Verdict;
  let proxyStatus: number | string;
  try {
    const res = await fetch(`${WEB_BASE}/api/foundry/health`, { redirect: "manual" });
    proxyStatus = res.status;
    if (res.status === 307 || res.status === 302) {
      proxyReal =
        `redirected to ${res.headers.get("location")} — middleware.ts matches /api/foundry/* and ` +
        "sends an unauthenticated caller to /login. Fail-closed, as intended, but it answers an " +
        "API request with an HTML redirect rather than a 401, so a fetch() sees opaque HTML.";
      proxyVerdict = "NOTE";
    } else if (res.ok) {
      proxyReal = "reachable and unauthenticated — the middleware matcher is NOT covering it";
      proxyVerdict = "MISMATCH";
    } else {
      proxyReal = `status ${res.status}`;
      proxyVerdict = "NOTE";
    }
  } catch (e) {
    proxyStatus = "unreachable";
    proxyReal = `web not running at ${WEB_BASE} (${(e as Error).message}) — the rest of this journey targets :4000 directly, which is what the proxy forwards to`;
    proxyVerdict = "NOTE";
  }
  record({
    uiCall: "(the browser's own hop)",
    verb: "GET",
    path: `${WEB_BASE}/api/foundry/health`,
    status: proxyStatus,
    ms: Date.now() - t0,
    intended:
      "The browser never holds PARENT_API_KEY: `app/api/foundry/[...path]/route.ts` injects it " +
      "server-side, and `middleware.ts` requires a session on everything except /api/auth. Fail closed.",
    real: proxyReal,
    verdict: proxyVerdict,
  });

  const health = await http("GET", "/health");
  record({
    uiCall: "foundryApi.parentHealth",
    verb: "GET",
    path: "/api/health",
    status: health.status,
    ms: health.ms,
    intended: "Unauthenticated liveness + a real DB probe.",
    real: digest(health.body),
    verdict: health.status === 200 && health.body?.db === true ? "MATCH" : "FAIL",
  });

  const wss = await http("GET", "/workspaces");
  const hr = (wss.body?.workspaces ?? wss.body ?? []).find?.((w: any) => w.name === "HR");
  record({
    uiCall: "foundryApi.listWorkspaces",
    verb: "GET",
    path: "/api/workspaces",
    status: wss.status,
    ms: wss.ms,
    intended:
      "How the UI resolves its bound workspace. Without FOUNDRY_WORKSPACE it takes the OLDEST — " +
      "never the newest, because that made creating a workspace silently repoint the whole UI.",
    real: `${(wss.body?.workspaces ?? []).length} workspace(s); HR ${hr ? "resolved" : "NOT FOUND"}`,
    verdict: hr ? "MATCH" : "FAIL",
  });
  if (!hr) throw new Error("workspace HR is not visible over HTTP");
  const wsId: string = hr.id;

  const tools = await http("GET", `/workspaces/${wsId}/tools`);
  const toolList = tools.body?.tools ?? [];
  record({
    uiCall: "foundryApi.listTools",
    verb: "GET",
    path: "/workspaces/:ws/tools",
    status: tools.status,
    ms: tools.ms,
    intended:
      "The callable catalogue's other half. 14 real HR tools, `kind:\"real\"`, and NO secret values " +
      "anywhere in the payload — a tool references a secret by its env-var NAME only.",
    real: `${toolList.length} tools; ${
      /"(secretValue|value_enc|sandbox_value|password)"/.test(tools.text)
        ? "A SECRET-SHAPED FIELD IS PRESENT"
        : "no secret-shaped field in the payload"
    }`,
    verdict:
      toolList.length > 0 &&
      !/"(secretValue|value_enc|sandbox_value|password)"/.test(tools.text)
        ? "MATCH"
        : "MISMATCH",
  });

  const dss = await http("GET", `/workspaces/${wsId}/datasources`);
  const dsList = dss.body?.datasources ?? [];
  const hrDs = dsList.find((d: any) => d.name === "hr_demo");
  record({
    uiCall: "foundryApi.listDatasources",
    verb: "GET",
    path: "/workspaces/:ws/datasources",
    status: dss.status,
    ms: dss.ms,
    intended:
      "Datasources carry an ENCRYPTED credential and the API must never return it — there is " +
      "deliberately no endpoint that returns a secret value and no `?reveal=`.",
    real: `${dsList.length} datasource(s); ${
      /postgres:\/\/[^"]*:[^"@]+@/.test(dss.text) ? "A DSN WITH A PASSWORD IS PRESENT" : "no DSN in the payload"
    }`,
    verdict: hrDs && !/postgres:\/\/[^"]*:[^"@]+@/.test(dss.text) ? "MATCH" : "MISMATCH",
  });

  if (hrDs) {
    const schema = await http("GET", `/workspaces/${wsId}/datasources/${hrDs.id}/schema`);
    const entities = schema.body?.schema?.entities ?? schema.body?.entities ?? [];
    record({
      uiCall: "foundryApi.getSchema",
      verb: "GET",
      path: "/workspaces/:ws/datasources/:ds/schema",
      status: schema.status,
      ms: schema.ms,
      intended:
        "Introspection runs AS `foundry_ro`, so the manifest is exactly the surface a generated " +
        "step can see. Views carry `kind=\"view\"` and no row estimate.",
      real: `${Array.isArray(entities) ? entities.length : "?"} entities`,
      verdict: schema.status === 200 ? "MATCH" : "NOTE",
    });

    // Stage 4. The question a person has before pressing "Run a test now": does
    // a draft run of a flow reading this datasource touch the tenant's data?
    const sbx = await http("GET", `/workspaces/${wsId}/datasources/${hrDs.id}/sandbox`);
    const state = sbx.body?.sandbox;
    record({
      uiCall: "foundryApi.getDatasourceSandbox",
      verb: "GET",
      path: "/workspaces/:ws/datasources/:ds/sandbox",
      status: sbx.status,
      ms: sbx.ms,
      intended:
        "READ only — provisioning generates rows with a model, drops a database and creates a " +
        "role, which is the destructive-HTTP-reseed shape Stage 1 deleted. And when there is NO " +
        "sandbox it must SAY so: a draft run then reads production, and silence there reads as " +
        "'fine' for every datasource nobody has provisioned one for.",
      real: state
        ? state.hasSandbox
          ? `sandbox present (fixture v${state.fixtureVersion}, written by ${state.generatedBy})`
          : `no sandbox — exposure stated: ${state.exposure ? "yes" : "NO, and it must be"}`
        : "no sandbox object in the response",
      verdict:
        sbx.status === 200 && state && (state.hasSandbox || !!state.exposure) ? "MATCH" : "MISMATCH",
    });
  }

  const flows = await http("GET", `/workspaces/${wsId}/flows`);
  record({
    uiCall: "foundryApi.listFlows",
    verb: "GET",
    path: "/workspaces/:ws/flows",
    status: flows.status,
    ms: flows.ms,
    intended: "The /flows page. Each row carries status and armedRevision.",
    real: `${(flows.body?.flows ?? []).length} existing flow(s)`,
    verdict: flows.status === 200 ? "MATCH" : "FAIL",
  });

  return wsId;
}

// ── phase 1 — authoring ─────────────────────────────────────────────────────

/**
 * Remove a leftover flow from a previous run — **over HTTP**, on the client surface.
 *
 * The first version did this with `flowService.remove()` in-process and died with
 * `ECONNREFUSED 127.0.0.1:8080`: deleting a flow undeploys it from Kestra, and a
 * host-run script has no route to an engine that publishes no ports (that is what
 * `scripts/kestra-env.sh` exists for). Doing it through `DELETE …/flows/:id`
 * instead is better on both counts — the SERVER holds the Kestra route, and the
 * call is `foundryApi.deleteFlow`, so this stops being an exception to the
 * client-surface-only rule and becomes part of the journey.
 *
 * An armed flow is revoked first, because a delete that silently undeployed an
 * armed schedule would be the wrong shape of convenience.
 */
async function cleanupStale(wsId: string) {
  const flows = await http("GET", `/workspaces/${wsId}/flows`);
  const stale = (flows.body?.flows ?? []).find((f: any) => f.kestraFlowId === FLOW_KESTRA_ID || String(f.name ?? "").endsWith(`[${FLOW_KESTRA_ID}]`));
  if (!stale) return;
  if (stale.armedRevision != null) {
    await http("POST", `/workspaces/${wsId}/flows/${stale.id}/approvals/revoke`, {
      reason: "e2e:ui cleanup of a previous run",
    });
  }
  const del = await http("DELETE", `/workspaces/${wsId}/flows/${stale.id}`);
  console.log(
    c.dim(
      `  cleanup: removed a leftover flow from a previous run (${del.status}${
        stale.armedRevision != null ? ", revoked first" : ""
      })`,
    ),
  );
}

/**
 * Type a sentence, get a flow — through CHAT, the one goal surface since the compiled-builder cutover (phase 8): a thread
 * (`foundryApi.createChatThread`), then the goal as a turn (`foundryApi.sendChatTurn`), which the builder answers.
 *
 * It does **not** grade the builder's answer — `builder-measure` does that against labels. Every builder outcome (a question, a
 * built flow, "not fully built", "cannot") is a MATCH for the transport, and WHICH one arrived is recorded as a NOTE. A question or
 * a stated refusal is a success of the design, never a failure (D-38).
 */
async function generationJourney(wsId: string) {
  const goal =
    "Each month, find the employees whose attendance is below their department's policy for the " +
    "given period, and email each of them a reminder.";
  const thread = await http("POST", `/workspaces/${wsId}/flow-chat/threads`, { name: `E2E UI journey — goal ${PERIOD}` });
  const threadId: string | undefined = thread.body?.thread?.id;
  record({
    uiCall: "foundryApi.createChatThread",
    verb: "POST",
    path: "/workspaces/:ws/flow-chat/threads",
    status: thread.status,
    ms: thread.ms,
    intended: "A conversation with no flow yet — the builder creates one when the goal is understood.",
    real: `${thread.status} thread=${threadId}`,
    verdict: thread.status === 201 && threadId ? "MATCH" : "FAIL",
  });
  if (!threadId) return;
  const turn = await http("POST", `/workspaces/${wsId}/flow-chat/threads/${threadId}/turns`, { message: goal });
  const status: string | undefined = turn.body?.turn?.status;
  record({
    uiCall: "foundryApi.sendChatTurn",
    verb: "POST",
    path: "/workspaces/:ws/flow-chat/threads/:id/turns",
    status: turn.status,
    ms: turn.ms,
    intended:
      "The builder answers synchronously: a question (`needs_input`), a built flow (`applied`), or a stated gap " +
      "(`insufficient_catalogue`) — each a terminal turn status, none a failure.",
    real: `${turn.status} turn=${status} flow=${turn.body?.flowId ?? "none"}`,
    verdict: turn.status === 200 && status && status !== "running" && status !== "failed" ? "MATCH" : "FAIL",
  });
  record({
    uiCall: null,
    verb: "—",
    path: "(what the builder actually did)",
    status: status ?? "unknown",
    ms: 0,
    intended: "Any builder outcome; which one is a NOTE — graded by builder-measure, not here.",
    real: digest(turn.body?.turn?.findingsJson ?? null, 200),
    verdict: "NOTE",
  });
  // Flows the builder made are not this journey's subject. Delete on the way out; a failure to delete is not a finding.
  if (turn.body?.flowId) await http("DELETE", `/workspaces/${wsId}/flows/${turn.body.flowId}`).catch(() => null);
}

async function phase1Author(wsId: string) {
  setPhase("PHASE 1 — authoring a flow, which is where the client surface runs out");
  await cleanupStale(wsId);

  await generationJourney(wsId);

  // No `createdBy`: since Stage 9.1 authorship comes from the verified identity,
  // and sending one alongside a signed-in caller is a 400 by design.
  const created = await createViaCanvas(
    wsId,
    { ...HR_SCREENING_MODEL, id: FLOW_KESTRA_ID },
    FLOW_NAME,
    "Created by e2e:ui to exercise the authoring → dry run → prod run path.",
  );
  record({
    uiCall: "foundryApi.createCanvasFlow + saveFlowRevision",
    verb: "POST",
    path: "/workspaces/:ws/flows/canvas + /flows/:id/revisions",
    status: created.status,
    ms: created.ms,
    intended:
      "Phase 3's constructor: writes revision 1 into insert-only `flow_revisions` + `flow_steps`. " +
      "Every model passes `writeRevision`, where the D-22 expression allowlist lives — five roots, " +
      "seven functions, everything else rejected BY NAME.",
    real:
      `revision ${created.body?.revision?.revision} written — an empty flow from the manual builder's create, then the model ` +
      "saved through `writeRevision` (the D-22 allowlist, the caps, the type gate, the compile). Zero inference calls.",
    verdict: created.status === 201 || created.status === 200 ? "MATCH" : "FAIL",
  });
  if (!created.body?.flow?.id) throw new Error(`flow create failed: ${created.text}`);
  const flowId: string = created.body.flow.id;

  const got = await http("GET", `/workspaces/${wsId}/flows/${flowId}`);
  record({
    uiCall: "foundryApi.getFlow",
    verb: "GET",
    path: "/workspaces/:ws/flows/:id",
    status: got.status,
    ms: got.ms,
    intended: "A brand-new flow is `draft` with `armedRevision: null` — nothing can fire it.",
    real: `status=${got.body?.flow?.status} armedRevision=${JSON.stringify(got.body?.flow?.armedRevision)}`,
    verdict:
      got.body?.flow?.status === "draft" && got.body?.flow?.armedRevision == null ? "MATCH" : "MISMATCH",
  });

  const appr = await http("GET", `/workspaces/${wsId}/flows/${flowId}/approvals`);
  record({
    uiCall: "foundryApi.getFlowApprovals",
    verb: "GET",
    path: "/…/flows/:id/approvals",
    status: appr.status,
    ms: appr.ms,
    intended: "What ApprovalPanel renders: current state + history. Nothing approved yet.",
    real: `armedRevision=${JSON.stringify(appr.body?.state?.armedRevision)} history=${
      (appr.body?.approvals ?? []).length
    }`,
    verdict: appr.body?.state?.armedRevision == null ? "MATCH" : "MISMATCH",
  });

  const diff = await http("GET", `/workspaces/${wsId}/flows/${flowId}/approvals/diff`);
  record({
    uiCall: "foundryApi.getFlowDiff",
    verb: "GET",
    path: "/…/approvals/diff",
    status: diff.status,
    ms: diff.ms,
    intended:
      "What the approver is signing off, split into STRUCTURE changes (human re-approval) and " +
      "FRAGMENT changes (automated re-test). With nothing armed, `from` is null.",
    real: digest(diff.body, 160),
    verdict: diff.status === 200 ? "MATCH" : "MISMATCH",
  });

  return flowId;
}

// ── phase 2 — the dry run ───────────────────────────────────────────────────

/**
 * Wait for the run to become ADDRESSABLE by a client, and measure how long it took.
 *
 * This is not a convenience helper — the wait is the finding. `flow_executions` is
 * written by the flow's own `begin` task, so between the 202 and Kestra actually
 * scheduling that task there is a window in which the run exists in the engine and
 * has no Foundry id at all. A client cannot address it in either system: Kestra's
 * id is not meant to be usable (R5), and Foundry's row is not there yet.
 *
 * The first version of this harness gave the poll 20 seconds and recorded two hard
 * FAILs on a stack whose engine had just restarted — while both runs in fact
 * succeeded ~40s later. A short poll here does not report a slow engine, it
 * reports a broken product, so the budget is generous and the OBSERVED delay is
 * recorded as its own step.
 */
async function waitForRow(
  wsId: string,
  seen: Set<string>,
  budgetMs = 120_000,
): Promise<{
  execId: string | null;
  waitedMs: number;
  polls: number;
  observedFlowId: string | null;
  observedFlowName: string | null;
}> {
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < budgetMs) {
    polls++;
    const list = await http("GET", `/workspaces/${wsId}/flow-executions?limit=20`);
    // ⚠ Still matched by "an id that was not there before", NOT by `flowId`, and
    // that stays true even though I-23 is fixed. Two different reasons now: this
    // harness deletes and recreates its flow under the same name every run, and
    // matching on the thing being ASSERTED below would make step 20 a tautology.
    const mine = (list.body?.executions ?? []).find((e: any) => !seen.has(String(e.id)));
    if (mine) {
      return {
        execId: mine.id,
        waitedMs: Date.now() - t0,
        polls,
        observedFlowId: mine.flowId ?? null,
        observedFlowName: mine.flowName ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    execId: null,
    waitedMs: Date.now() - t0,
    polls,
    observedFlowId: null,
    observedFlowName: null,
  };
}

/** Every execution id currently visible — the baseline a new run is spotted against. */
async function snapshotExecutions(wsId: string): Promise<Set<string>> {
  const r = await http("GET", `/workspaces/${wsId}/flow-executions?limit=200`);
  return new Set<string>((r.body?.executions ?? []).map((e: any) => String(e.id)));
}

async function settle(wsId: string, execId: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await http("GET", `/workspaces/${wsId}/flow-executions/${execId}`);
    last = r.body;
    const s = r.body?.engineStatus;
    if (s && !["running", "created", "queued", "paused", "restarted", "pending"].includes(s)) {
      return { view: r.body, waitedMs: Date.now() - t0, text: r.text };
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { view: last, waitedMs: Date.now() - t0, text: "", timedOut: true } as any;
}

async function phase2DryRun(wsId: string, flowId: string) {
  setPhase(`PHASE 2 — DRY RUN: the draft namespace, exempt from the approval gate (period ${PERIOD})`);

  const baseline = await snapshotExecutions(wsId);
  const run = await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, {
    inputs: { period: PERIOD },
  });
  const leaks: string[] = [];
  if (run.body?.kestraExecutionId) leaks.push("kestraExecutionId");
  if (run.body?.namespace) leaks.push("namespace");
  record({
    uiCall: "foundryApi.testRunFlow",
    verb: "POST",
    path: "/…/flows/:id/test-run",
    status: run.status,
    ms: run.ms,
    intended:
      "202, and it deploys to the DRAFT namespace and executes there. Draft is exempt from gate 2 " +
      "because a draft run is how gate 1 gets satisfied. R5: 'clients are never given a Kestra id' — " +
      "`ExecutionView.id`'s own docblock says 'the client never sees a Kestra execution id'.",
    real:
      run.status === 202
        ? leaks.length
          ? `202, but the body carries ${leaks.join(" + ")} — Kestra addressing handed to a client, ` +
            "contradicting the invariant quoted above. Not currently exploitable (Kestra publishes no " +
            "port and its only network is internal), and the UI ignores both fields — it just shows " +
            "'Test run started'. Recorded, not silently fixed: kestra:phase3 reads " +
            "`testRun.kestraExecutionId`, so this is a deliberate decision, not an oversight."
          : "202, no engine identifiers in the body"
        : `unexpected ${run.status}: ${digest(run.body)}`,
    verdict: run.status !== 202 ? "FAIL" : leaks.length ? "MISMATCH" : "MATCH",
  });

  // The UI's actual next move. It was handed a Kestra id it must not use, so the
  // only way to find the run it just started is to poll the list.
  const { execId, waitedMs, polls, observedFlowId, observedFlowName } = await waitForRow(
    wsId,
    baseline,
  );
  record({
    uiCall: "foundryApi.listFlowExecutions (polled)",
    verb: "GET",
    path: "/…/flow-executions?limit=20",
    status: execId ? 200 : "timeout",
    ms: waitedMs,
    intended:
      "R6 — one system of record. The run becomes addressable when `begin` writes " +
      "`flow_executions`, and rows must come back newest-first: `/executions/search` returns the " +
      "OLDEST page by default (I-12), correct until the instance holds more than one page of " +
      "executions and then silently wrong.",
    real: execId
      ? `addressable after ${(waitedMs / 1000).toFixed(1)}s (${polls} polls). Until then the run ` +
        "existed in the engine and had NO Foundry id, and the Kestra id the 202 returned is the one " +
        "thing a client must not use — so for that window the run a user just started is " +
        "unaddressable in both systems. `begin` is a task in the flow, so this delay is the engine's " +
        "scheduling latency and is much longer on a cold engine (measured >40s just after a restart)."
      : `never appeared in ${(waitedMs / 1000).toFixed(0)}s`,
    verdict: execId ? (waitedMs > 5_000 ? "MISMATCH" : "MATCH") : "FAIL",
  });
  if (!execId) return null;

  // I-23, and it is COMPUTED now rather than asserted in prose.
  //
  // ⚠ The previous version hardcoded `verdict: "MISMATCH"` and a paragraph of
  // findings. That was right while nobody had fixed it and wrong the moment
  // somebody did — a constant cannot notice a regression, and the printed
  // evidence had already drifted into nonsense: it said "the KESTRA flow id X
  // rather than the uuid X", the same string twice, because this flow's slug
  // happens to be derived from its uuid. Two ways to be misled by one line.
  //
  // Two things are checked, because fixing one alone would have been worse than
  // fixing neither: `flowId` must be the uuid a client can filter on, AND the
  // slug must still be reachable, or the UI silently loses the label it renders
  // (`runs/[id]` page title, `adapters.ts` automation name).
  const idIsUuid = observedFlowId === flowId;
  const slugKept = !!observedFlowName;
  record({
    uiCall: "foundryApi.listFlowExecutions",
    verb: "—",
    path: "the meaning of `flowId` in the executions list",
    status: "n/a",
    ms: 0,
    intended:
      "`flowId` should mean what it means on every other route — Foundry's flow uuid, the thing " +
      "`/flows/:flowId` takes and `FAFlow.id` carries. `ExecutionView` declares it `flowId` " +
      "and its sibling `replayOfId` IS a Foundry id. The engine's slug is still worth serving, " +
      "as its OWN field, because it is what the UI renders as a label.",
    real: idIsUuid
      ? `flowId=${JSON.stringify(observedFlowId)} is the Foundry uuid, and the engine slug is ` +
        `served separately as flowName=${JSON.stringify(observedFlowName)}. ` +
        "Was a MISMATCH until GAPS §3.2 was closed: both `list()` and `get()` set " +
        "`flowId: r.kestraFlowId`, so a client filtering the runs list by the uuid it held got " +
        "ZERO rows, and a deleted-then-recreated flow reused the slug — making executions of two " +
        "different Foundry flows indistinguishable, which is the case this harness actually hit. " +
        "`executionBase()` is now one function both routes project through, so the two cannot " +
        "disagree about what `flowId` means. ⚠ It is nullable: flowless Phase-1 history exists."
      : `flowId=${JSON.stringify(observedFlowId)}, expected the Foundry uuid ${flowId}` +
        (slugKept ? "" : " — and `flowName` is absent, so the UI has lost its label too"),
    verdict: idIsUuid && slugKept ? "MATCH" : "MISMATCH",
  });

  const watch = await http("POST", `/workspaces/${wsId}/flow-executions/${execId}/watch`);
  record({
    uiCall: "foundryApi.watchFlowExecution",
    verb: "POST",
    path: "/…/flow-executions/:id/watch",
    status: watch.status,
    ms: watch.ms,
    intended:
      "D-15 — the progress socket is authorised by a single-use 60s ticket bound to one " +
      "(workspace, execution), minted on an API-key-authenticated route. The browser never holds " +
      "PARENT_API_KEY and a WebSocket cannot use the Next proxy. The deleted `/ws/generation` took " +
      "`?scriptId=` and was authorised by nothing; this must never be that shape again.",
    real: `ticket issued: ${digest(watch.body, 90)}`,
    verdict: watch.status === 200 && !!watch.body ? "MATCH" : "MISMATCH",
  });

  const settled = await settle(wsId, execId);
  const { view, text, timedOut } = settled;
  const settleMs = settled.waitedMs;
  record({
    uiCall: "foundryApi.getFlowExecution (polled)",
    verb: "GET",
    path: "/…/flow-executions/:id",
    status: timedOut ? "timeout" : 200,
    ms: settleMs,
    intended:
      "D-13 — read `engineStatus`, never `flow_executions.status`. They legitimately disagree: " +
      "Foundry's row is written by the flow's own `complete` task, so a FAILED run stays `running` " +
      "for ever (I-10). A UI reading the row shows a failed run as still going; a poller never stops.",
    real: timedOut
      ? `did not settle in ${Math.round(settleMs / 1000)}s`
      : `engineStatus=${view?.engineStatus} · flow_executions.status=${view?.status} · ` +
        `${(view?.steps ?? []).length} steps · graph ${view?.graph ? "present" : "null"}. ` +
        "⚠ The two fields use DIFFERENT vocabularies for the same outcome — the engine says " +
        `"${view?.engineStatus}" and Foundry's row says "${view?.status}". A client comparison written ` +
        "against the wrong spelling is silently never true, which is how a settled run gets polled " +
        "for ever. This harness made exactly that mistake first.",
    verdict: timedOut ? "FAIL" : view?.engineStatus === "success" ? "MATCH" : "MISMATCH",
  });

  // Redaction, asserted on the raw response text rather than on parsed fields —
  // a token that appears under an unexpected key still crosses the wire.
  const raw = text || JSON.stringify(view ?? {});
  const tokenish = /(execution_token|executionToken|"token"\s*:\s*"[A-Za-z0-9_-]{16,})/.test(raw);
  const kestraId = typeof view?.id === "string" && /^[0-9a-zA-Z]{16,}$/.test(view.id) && !view.id.includes("-");
  record({
    uiCall: "foundryApi.getFlowExecution",
    verb: "—",
    path: "redaction of the step view",
    status: "n/a",
    ms: 0,
    intended:
      "D-07 — redaction is SERVER-SIDE and stays there. `begin`'s response body carries the " +
      "execution token and Kestra persists task outputs, so redacting in the browser would be " +
      "theatre: the token would already have crossed the wire. Never add a path that fetches a raw " +
      "execution.",
    real: `${tokenish ? "A TOKEN-SHAPED VALUE IS PRESENT" : "no token-shaped value"}; execution addressed by ${
      kestraId ? "what looks like a Kestra id" : "a Foundry uuid"
    }`,
    verdict: !tokenish && !kestraId ? "MATCH" : "MISMATCH",
  });

  // Correctness against the oracle — the only thing that can say the run was RIGHT.
  // Both halves over HTTP, which is the harness's one rule and was a small
  // deviation before Stage 5: this used to read `stub_mail_outbox` with SQL and
  // call `expectedScreening()` in-process, neither of which a browser can do.
  // The client's own `demoOracle` and `demoMail` now have routes behind them, so
  // the journey uses them — and the oracle sits under `/test-oracle` rather than
  // `/demo` so what it is is legible from the URL.
  const oracleRes = await http<{ flagged: { email: string | null }[] }>(
    "GET",
    `/test-oracle/screening?period=${PERIOD}`,
  );
  const mailRes = await http<{ total: number }>("GET", "/ops/outbox/mail");
  const flagged = oracleRes.body?.flagged ?? [];
  const want = flagged.filter((f) => f.email).length;
  const sent = mailRes.body?.total ?? -1;
  record({
    uiCall: "foundryApi.demoOracle + demoMail",
    verb: "GET",
    path: "/api/test-oracle/screening · /api/ops/outbox/mail",
    status: `${oracleRes.status}/${mailRes.status}`,
    ms: oracleRes.ms + mailRes.ms,
    intended:
      `The oracle is the right answer computed from the dataset DEFINITION, not from any script. At ` +
      `${PERIOD} it flags ${flagged.length} employees, ${want} of them mailable. A green run is ` +
      "not a correct run — only this comparison says correct. The outbox is read from ops-api " +
      "through the parent's proxy, so what is counted is what the TOOL LAYER accepted, not what " +
      "the flow reported about itself.",
    real: `the outbox holds ${sent} message(s), oracle wants ${want}`,
    verdict: sent === want ? "MATCH" : "MISMATCH",
  });

  return execId;
}

// ── phase 3 — approval, then the production run ─────────────────────────────

/**
 * The journey's people are assigned to the workspace BEFORE anything is done as them
 * (phase 7, found by the regression net).
 *
 * This block lived inside `phase3ProdRun`, after `phase1Author` — which authors as
 * `AUTHOR`. Once feature-level RBAC closed every workspace (2026-09-13), that meant the
 * journey authored as somebody who was not yet a member, got `403 not_a_member` at
 * step 14 and aborted, so none of the later phases ran. Assignment is setup: it runs
 * right after `phase0` resolves the workspace, and every step after it acts as a
 * person who is really there.
 */
async function assignJourneyMembers(wsId: string) {
  setPhase("SETUP — the journey's people are assigned before they act");
  /**
   * ⚠ **This step used to CLAIM the workspace and it cannot any more.**
   * `POST …/members/claim` is deleted: the first signed-in caller became the
   * admin of any unclaimed workspace, which made "who decides who works here"
   * mean "whoever asked first". Assignment by a super admin replaced it, so the
   * journey now presents a configured super admin and assigns — which is the
   * real path a browser takes.
   */
  const assigned = SUPER
    ? await http(
        "POST",
        `/workspaces/${wsId}/members`,
        // ⚠ `approver`, not `author`, and the subject is the EMAIL because
        // `identityFor` mints `sub: email`. Granting the author only `author`
        // would make the self-approval step below refuse for the ROLE and stop
        // testing the self-approval refusal at all — two controls, and the
        // journey has to be able to tell which one fired.
        { subject: AUTHOR, email: AUTHOR, role: "approver" },
        SUPER,
      )
    : { status: 0, body: null, ms: 0 };
  /**
   * ⚠ **AND THE APPROVER, which was missing and stopped the journey dead.**
   *
   * Only the author was ever assigned, yet every step from here on presents
   * `APPROVER` — so the approval that arms the flow was refused *"you are not a
   * member of this workspace"*, and steps 28, 30, 51 and 52 never reached the
   * assertions they exist to make. It cascaded: with no armed revision, the
   * trigger fire was refused for having no approved revision and the live-run
   * watcher timed out after 120s. Four MISMATCHes and two FAILs, one cause.
   *
   * The membership check runs BEFORE schema validation, which is why the
   * `.strict()` step could only ever see a 403 where it asserts a 400.
   *
   * ⚠ It does NOT weaken the refusal below. `refusedAssign` presents `APPROVER`
   * and must still be 403 — being a member of a workspace is not being a super
   * admin, and that step's own comment already says the refusal covers "a
   * signed-in member of it". Assigning the approver is what makes that sentence
   * true rather than vacuous.
   */
  const assignedApprover = SUPER
    ? await http(
        "POST",
        `/workspaces/${wsId}/members`,
        { subject: APPROVER, email: APPROVER, role: "approver" },
        SUPER,
      )
    : { status: 0, body: null, ms: 0 };
  /**
   * The negative half, and it is free: the same call as a signed-in person who
   * is not a super admin must be refused. Without it the step above proves only
   * that a grant can succeed, not that the gate exists.
   */
  const refusedAssign = await http(
    "POST",
    `/workspaces/${wsId}/members`,
    { subject: STRANGER, email: STRANGER, role: "author" },
    APPROVER,
  );
  record({
    uiCall: "foundryApi.grantMember  (was: claimWorkspace + grantMember)",
    verb: "POST",
    path: "/…/members",
    status: `${assigned.status}/${refusedAssign.status}`,
    ms: assigned.ms + refusedAssign.ms,
    intended:
      "A super admin assigns somebody to a workspace; anyone else is refused, including a " +
      "signed-in member of it. ⚠ `POST …/members/claim` is DELETED — it let the first signed-in " +
      "caller make themselves the admin of any unclaimed workspace. The replacement is an env " +
      "allowlist on the API server, which is the one authority here that cannot be granted from " +
      "inside the product. A repeat assignment is a 201 that updates the row, not a 409: it is an " +
      "upsert keyed on the subject, so the journey is re-runnable.",
    real: SUPER
      ? `assign author ${assigned.status} + approver ${assignedApprover.status}, ` +
        `non-super-admin refused with ${refusedAssign.status}`
      : `SKIPPED — SUPER_ADMIN_EMAILS is unset on this deployment; refusal still checked (${refusedAssign.status})`,
    // ⚠ NOTE, not MISMATCH, when unconfigured. The harness must not report its
    // own environment as a product defect — and the refusal half is still a real
    // assertion, because a 403 for everyone is exactly what an empty allowlist
    // means.
    verdict: !SUPER
      ? refusedAssign.status === 403
        ? "NOTE"
        : "MISMATCH"
      : assigned.status === 201 && assignedApprover.status === 201 && refusedAssign.status === 403
        ? "MATCH"
        : "MISMATCH",
  });
}

async function phase3ProdRun(wsId: string, flowId: string) {
  setPhase("PHASE 3 — PROD RUN: approve a REVISION, then fire the live namespace");

  // ── GAPS §1.1 — approving now needs a ROLE, not just an identity ──────────
  //
  // A workspace with no members refuses every approval, deliberately: a role
  // check that passes when unconfigured passes everywhere it was never set up.
  // So the journey does what a person does — claim the workspace, then grant the
  // approver. That this is now a required step IS the change; a journey that
  // skipped it would be testing the deployment's leftover state.
  const unroled = await http(
    "POST",
    `/workspaces/${wsId}/flows/${flowId}/approvals`,
    { revision: 1, approverKind: "client_admin" },
    STRANGER,
  );
  record({
    uiCall: "foundryApi.approveFlowRevision",
    verb: "POST",
    path: "/…/approvals  (signed in, but holding no role here)",
    status: unroled.status,
    ms: unroled.ms,
    intended:
      "REFUSED. Until §1.1 this was a 409 or a 201 depending only on the name — every signed-in " +
      "person could approve in every workspace. The refusal must also say what to do next, or it " +
      "is a dead end.",
    real: `${unroled.status} ${digest(unroled.body, 110)}`,
    verdict:
      unroled.status === 403 &&
      /super admin|not a member|approver|SUPER_ADMIN_EMAILS/.test(JSON.stringify(unroled.body))
        ? "MATCH"
        : "MISMATCH",
  });


  // Signed in AS the author, which since Stage 9.1 is the whole of the claim —
  // the harness no longer chooses a name in the body, it presents a token.
  const selfAppr = await http(
    "POST",
    `/workspaces/${wsId}/flows/${flowId}/approvals`,
    { revision: 1, approverKind: "client_admin" },
    AUTHOR,
  );
  record({
    uiCall: "foundryApi.approveFlowRevision",
    verb: "POST",
    path: "/…/approvals  (author approving their own work)",
    status: selfAppr.status,
    ms: selfAppr.ms,
    intended:
      "Refused against the RECORDED AUTHOR. The author was granted `approver` two steps up, so " +
      "the ROLE check passes and this 409 is the SECOND control firing — which is the point: " +
      "§1.1 stops a stranger approving, and the self-approval refusal stops the author. Still " +
      "not separation of duties: anything holding RUNTIME_JWT_SECRET mints an identity, and " +
      "`created_by` is verified only when the revision came from a browser (I-13, I-32).",
    real: `${selfAppr.status} ${digest(selfAppr.body, 110)}`,
    verdict: selfAppr.status === 409 ? "MATCH" : "MISMATCH",
  });

  // ⚠ The body still carries no approver, and the server must refuse one that
  // does. Proving the refusal is worth a step of its own — a field that is
  // accepted and ignored reads, to the next person, as a field that works.
  const bodyApprover = await http(
    "POST",
    `/workspaces/${wsId}/flows/${flowId}/approvals`,
    { revision: 1, approverUserId: "someone-else@acme-hr.example" },
    APPROVER,
  );
  record({
    uiCall: null,
    verb: "POST",
    path: "/…/approvals  (a body that names its own approver)",
    status: bodyApprover.status,
    ms: bodyApprover.ms,
    intended:
      "400. `approveSchema` is `.strict()`, so naming an approver in the body is refused by name " +
      "rather than silently overridden — Stage 9.1's rule that the browser does not get to choose " +
      "who approved.",
    real: `${bodyApprover.status} ${digest(bodyApprover.body, 130)}`,
    verdict: bodyApprover.status === 400 ? "MATCH" : "MISMATCH",
  });

  // And with no identity at all: the API key alone can no longer approve.
  const noIdentity = await http(
    "POST",
    `/workspaces/${wsId}/flows/${flowId}/approvals`,
    { revision: 1 },
    null,
  );
  record({
    uiCall: null,
    verb: "POST",
    path: "/…/approvals  (API key only, no identity)",
    status: noIdentity.status,
    ms: noIdentity.ms,
    intended:
      "401. This is the measurable half of Stage 9.1: PARENT_API_KEY authorises the request and " +
      "cannot say who is making it, so a route that records a person refuses. Before Stage 9 this " +
      "call approved a revision and recorded whatever name it liked.",
    real: `${noIdentity.status} ${digest(noIdentity.body, 130)}`,
    verdict: noIdentity.status === 401 ? "MATCH" : "MISMATCH",
  });

  const approve = await http(
    "POST",
    `/workspaces/${wsId}/flows/${flowId}/approvals`,
    { revision: 1, approverKind: "client_admin", note: "e2e:ui" },
    APPROVER,
  );
  record({
    uiCall: "foundryApi.approveFlowRevision",
    verb: "POST",
    path: "/…/approvals",
    status: approve.status,
    ms: approve.ms,
    intended:
      "Approval binds to a REVISION, never to the flow: approving the flow would let an edit " +
      "repoint an armed schedule at different behaviour — approve-once as a blank cheque. " +
      "`flow-approval.service.ts` is the ONLY module that writes the live namespace.",
    real: `${approve.status} ${digest(approve.body, 150)}`,
    verdict: approve.status === 201 ? "MATCH" : "FAIL",
  });

  const armed = await http("GET", `/workspaces/${wsId}/flows/${flowId}`);
  record({
    uiCall: "foundryApi.getFlow",
    verb: "GET",
    path: "/…/flows/:id  (after approval)",
    status: armed.status,
    ms: armed.ms,
    intended:
      "The gate is STRUCTURAL, not a check: a Kestra Schedule trigger is part of the flow " +
      "definition, so approval DEPLOYS it and revoking REMOVES it — never `disabled: true`, which is " +
      "one accidental redeploy away from firing. This model carries `schedule: {cron: '0 6 * * 1'}` on " +
      "the MODEL (D-18 — never in a `triggers` row), so approving revision 1 is what arms that cron: " +
      "`armed` rather than `approved` is the expected status here, and it means a Schedule trigger now " +
      "exists in the live namespace.",
    real: `status=${armed.body?.flow?.status} armedRevision=${JSON.stringify(armed.body?.flow?.armedRevision)}`,
    verdict:
      armed.body?.flow?.armedRevision === 1 &&
      ["approved", "armed"].includes(armed.body?.flow?.status)
        ? "MATCH"
        : "MISMATCH",
  });

  const schedTrig = await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers`, {
    name: "e2e-cron",
    type: "schedule",
    config: { cron: "0 3 * * *" },
  });
  record({
    uiCall: "foundryApi.createTrigger",
    verb: "POST",
    path: "/…/triggers  (type=schedule)",
    status: schedTrig.status,
    ms: schedTrig.ms,
    intended:
      "D-18 — Foundry REFUSES to create a `schedule` trigger for a flow. A cron lives on the flow " +
      "MODEL and is armed by approving a revision; a Foundry schedule row would be a second way to " +
      "fire it on a timer that no approval covers.",
    real: `${schedTrig.status} ${digest(schedTrig.body, 110)}`,
    verdict: schedTrig.status >= 400 && schedTrig.status < 500 ? "MATCH" : "MISMATCH",
  });

  const trig = await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers`, {
    name: "e2e-manual",
    type: "manual",
    // Inputs live on the TRIGGER, not on the fire call — see the fire step below.
    config: { inputs: { period: PERIOD } },
  });
  record({
    uiCall: "foundryApi.createTrigger",
    verb: "POST",
    path: "/…/triggers  (type=manual, `enabled` omitted)",
    status: trig.status,
    ms: trig.ms,
    intended:
      "`createTriggerSchema.enabled` defaults to FALSE. It used to default to true, so a client " +
      "omitting the field armed the trigger — a standing grant to run unattended, granted by silence.",
    real: `${trig.status} enabled=${JSON.stringify(trig.body?.trigger?.enabled)}`,
    verdict: trig.status === 201 && trig.body?.trigger?.enabled === false ? "MATCH" : "MISMATCH",
  });
  const tid: string | undefined = trig.body?.trigger?.id;
  if (!tid) return { prodExec: null, trigId: undefined };

  const seen = await snapshotExecutions(wsId);

  const fire = await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fire`);
  record({
    uiCall: "foundryApi.fireTrigger",
    verb: "POST",
    path: "/…/triggers/:tid/fire",
    status: fire.status,
    ms: fire.ms,
    intended:
      "Starts the APPROVED LIVE revision or nothing: `assertMayRunLive` re-checks approval and " +
      "fingerprint on the live namespace as a second layer. Inputs come from " +
      "`triggers.config.inputs`, NEVER from the request — a webhook body is attacker-controlled on a " +
      "public URL and flow inputs are interpolated into step params. The fire row is written FIRST, " +
      "so a fire that started nothing still leaves a trace.",
    real: `${fire.status} ${digest(fire.body, 140)}`,
    verdict: fire.status === 202 ? "MATCH" : "MISMATCH",
  });

  record({
    uiCall: "foundryApi.fireTrigger",
    verb: "—",
    path: "'Fire now' works on a DISABLED trigger",
    status: "n/a",
    ms: 0,
    intended:
      "Reads as a missing check and is not. `enabled` governs UNATTENDED firing — the schedule/poll " +
      "path. 'Fire now' is a deliberate manual act by someone already holding the API key, and it " +
      "still passes gate 2. The readiness gate exists so the SEQUENCE is generate → run once → arm.",
    real: `fired with enabled=false and the approval gate still applied (status ${fire.status})`,
    verdict: "NOTE",
  });

  const { execId: prodExec, waitedMs: prodWait } = await waitForRow(wsId, seen);
  record({
    uiCall: "foundryApi.listFlowExecutions (polled)",
    verb: "GET",
    path: "/…/flow-executions  (the live run)",
    status: prodExec ? 200 : "timeout",
    ms: prodWait,
    intended:
      "The live run appears as a NEW row, distinguishable from the draft run's — both ran the same " +
      "flow, so the rows differ by execution, not by flow.",
    real: prodExec
      ? `new row after ${(prodWait / 1000).toFixed(1)}s, distinct from the draft run's`
      : `never appeared in ${(prodWait / 1000).toFixed(0)}s`,
    verdict: prodExec ? "MATCH" : "FAIL",
  });
  if (!prodExec) return { prodExec: null, trigId: tid as string };

  const prodSettled = await settle(wsId, prodExec);
  const { view, timedOut } = prodSettled;
  const settleMs = prodSettled.waitedMs;
  record({
    uiCall: "foundryApi.getFlowExecution (polled)",
    verb: "GET",
    path: "/…/flow-executions/:id  (the live run)",
    status: timedOut ? "timeout" : 200,
    ms: settleMs,
    intended: "The live namespace runs the approved revision and produces the same answer.",
    real: timedOut
      ? `did not settle in ${Math.round(settleMs / 1000)}s`
      : `engineStatus=${view?.engineStatus} · ${(view?.steps ?? []).length} steps`,
    verdict: timedOut ? "FAIL" : view?.engineStatus === "success" ? "MATCH" : "MISMATCH",
  });

  const fires = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fires`);
  /**
   * ⚠ A GAP means *the client has no method for this*, so closing one has to be
   * decided by looking at the client — not by editing the verdict here.
   *
   * The previous version hardcoded `verdict: "GAP"`. Relabelling that to MATCH
   * because somebody says the method now exists would make the report agree with
   * itself, which is the one thing this harness's rule exists to prevent. Both
   * layers are checked, because either alone is a method a page cannot call:
   * `foundry-client.ts` is the transport, `lib/api.ts` is what a component
   * imports. The paths are relative to this file, so a rename fails loudly
   * rather than silently reporting the gap as still open.
   */
  const clientHas = (rel: string, needle: string) => {
    try {
      return readFileSync(new URL(rel, import.meta.url), "utf8").includes(needle);
    } catch {
      return false;
    }
  };
  // Relative to THIS file (`packages/server/src/kestra/`), so: kestra → src →
  // server → packages, then across into `client`. Getting this wrong is silent
  // in one direction only — the `catch` returns false, so a bad path reports the
  // gap as still OPEN rather than falsely closing it. It did exactly that on the
  // first run, which is the behaviour worth keeping.
  const CLIENT = "../../../client/src/lib/";
  const wired =
    clientHas(`${CLIENT}foundry-client.ts`, "listTriggerFires") &&
    clientHas(`${CLIENT}api.ts`, "listTriggerFires");
  record({
    uiCall: wired ? "foundryApi.listTriggerFires" : "(no UI method)",
    verb: "GET",
    path: "/…/triggers/:tid/fires",
    status: fires.status,
    ms: fires.ms,
    intended:
      "The fire audit trail — exactly what someone debugging a silent automation needs. A fire that " +
      "started nothing still writes a row.",
    real: wired
      ? `${(fires.body?.fires ?? []).length} fire row(s), and the client can read them: ` +
        "`foundryApi.listTriggerFires` → `lib/api.ts` `listTriggerFires`, rendered by " +
        "`components/automation/TriggerFires.tsx` on the triggers page. Was the last remaining GAP " +
        "in this journey (GAPS §3.3) — the trail existed and was API-only, so the one thing a person " +
        "needs when an automation goes quiet was the one thing the product could not show them. " +
        "(An earlier run also turned up an exact duplicate registration of GET '/:tid/fires' in " +
        "`routes/triggers.ts`; Express only ever reached the first, so it was dead weight rather " +
        "than a defect, and it has been removed.)"
      : `${(fires.body?.fires ?? []).length} fire row(s). No client method exposes this, so the ` +
        "audit trail is API-only.",
    verdict: wired ? "MATCH" : "GAP",
  });

  return { prodExec, trigId: tid };
}

// ── phase 4 — the post-run surface (Phase 6) ────────────────────────────────

async function phase4PostRun(
  wsId: string,
  flowId: string,
  execId: string,
  trigId: string | undefined,
) {
  setPhase("PHASE 4 — what the UI offers AFTER a run: replay, export, template, revoke");

  const plan = await http("GET", `/workspaces/${wsId}/flow-executions/${execId}/replay`);
  const modes = (plan.body?.steps ?? []).length;
  record({
    uiCall: "foundryApi.getReplayPlan",
    verb: "GET",
    path: "/…/flow-executions/:id/replay",
    status: plan.status,
    ms: plan.ms,
    intended:
      "A GET, rendered BEFORE anything is offered, with a per-step REASON when a step cannot be " +
      "replayed. A disabled button with no explanation is how a working feature gets reported as broken.",
    real: `${plan.status}; whole-run replay ${plan.body?.canReplayFull ? "offered" : "refused"}; ${modes} step(s) described`,
    verdict: plan.status === 200 ? "MATCH" : "MISMATCH",
  });

  const partial = await http("POST", `/workspaces/${wsId}/flow-executions/${execId}/replay`, {
    fromStepId: "notify",
  });
  record({
    uiCall: "foundryApi.replayFlowExecution(fromStepId)",
    verb: "POST",
    path: "/…/replay  {fromStepId:'notify'}",
    status: partial.status,
    ms: partial.ms,
    intended:
      "A SUCCEEDED run can never be partially replayed: `complete` burns the execution credential. " +
      "The refusal must say THAT rather than 'expired', because 'expired' reads as a defect. " +
      "D-26 — a partial replay does not execute `begin`, so approval, the credential mint and the " +
      "row creation are re-applied by `flow-replay.service.ts` itself, and refused where it cannot.",
    real: `${partial.status} ${digest(partial.body, 160)}`,
    verdict: partial.status >= 400 ? "MATCH" : "MISMATCH",
  });

  const full = await http("POST", `/workspaces/${wsId}/flow-executions/${execId}/replay`, {});
  record({
    uiCall: "foundryApi.replayFlowExecution()",
    verb: "POST",
    path: "/…/replay  (whole run)",
    status: full.status,
    ms: full.ms,
    intended:
      "`full` is the safe default because it re-runs `begin` — the approval gate, a fresh execution " +
      "token and the M3 budget all re-apply on their normal paths rather than being reproduced by " +
      "replay code. Lineage is stamped so two `succeeded` rows are not read as two working runs.",
    real: `${full.status} ${digest(full.body, 160)}`,
    verdict: full.status === 202 ? "MATCH" : "MISMATCH",
  });

  const exp = await http("GET", `/workspaces/${wsId}/flows/${flowId}/export`);
  const bundleText = exp.text;
  record({
    uiCall: "foundryApi.exportFlow",
    verb: "GET",
    path: "/…/flows/:id/export",
    status: exp.status,
    ms: exp.ms,
    intended:
      "D-24 — the CONTRACT travels, the code does not, and no engine YAML travels at all (R8: the " +
      "compiler is the sole emitter). Secret NAMES only. No approvals, no history, no armed revision: " +
      "an imported flow starts unapproved and has never run.",
    real: `${exp.status}; ${bundleText.length}B; ${
      /def run\(/.test(bundleText) ? "CONTAINS a fragment body" : "no fragment body"
    }; ${/io\.kestra|tasks:/.test(bundleText) ? "CONTAINS engine YAML" : "no engine YAML"}; ${
      /"(approval|armedRevision|flowExecutions)"/.test(bundleText) ? "carries approval/history" : "no approval/history"
    }`,
    verdict:
      exp.status === 200 &&
      !/def run\(/.test(bundleText) &&
      !/io\.kestra|tasks:/.test(bundleText)
        ? "MATCH"
        : "MISMATCH",
  });

  const tpl1 = await http("POST", `/workspaces/${wsId}/flow-templates`, {
    flowId,
    name: "e2e-ui-template",
  });
  const tpl2 = await http("POST", `/workspaces/${wsId}/flow-templates`, {
    flowId,
    name: "e2e-ui-template",
  });
  record({
    uiCall: "foundryApi.saveFlowTemplate ×2",
    verb: "POST",
    path: "/…/flow-templates  (same name twice)",
    status: `${tpl1.status} then ${tpl2.status}`,
    ms: tpl1.ms + tpl2.ms,
    intended:
      "D-27 — a template is a SNAPSHOT, so a second save under an existing name is a 409, never an " +
      "upsert. An upsert would make 'create from template' mean 'whatever that automation happens to " +
      "be right now'.",
    real: `first ${tpl1.status}, second ${tpl2.status} ${digest(tpl2.body, 80)}`,
    verdict: tpl1.status === 201 && tpl2.status === 409 ? "MATCH" : "MISMATCH",
  });

  const cand = await http("GET", `/workspaces/${wsId}/fragment-candidates`);
  record({
    uiCall: "foundryApi.listFragmentCandidates",
    verb: "GET",
    path: "/…/fragment-candidates",
    status: cand.status,
    ms: cand.ms,
    intended:
      "A SURFACING HEURISTIC, never a detector — and the `caveat` is served WITH the payload, " +
      "because presenting a shape coincidence as a finding is the failure mode here.",
    real: `${cand.status}; ${(cand.body?.candidates ?? []).length} candidate(s); caveat ${
      cand.body?.caveat ? "present" : "ABSENT"
    } (this flow has no code steps, so an empty list is the right answer)`,
    verdict: cand.status === 200 && !!cand.body?.caveat ? "MATCH" : "MISMATCH",
  });

  const revoke = await http("POST", `/workspaces/${wsId}/flows/${flowId}/approvals/revoke`, {
    reason: "e2e:ui teardown",
  });
  record({
    uiCall: "foundryApi.revokeFlowApproval",
    verb: "POST",
    path: "/…/approvals/revoke",
    status: revoke.status,
    ms: revoke.ms,
    intended:
      "The Schedule trigger is REMOVED from Kestra, not flagged. Approvals are closed by timestamp " +
      "and never deleted — the history is insert-only.",
    real: `${revoke.status} ${digest(revoke.body, 120)}`,
    verdict: revoke.status === 200 ? "MATCH" : "MISMATCH",
  });

  // Assert the PROPERTY, not a field. The first version of this step checked
  // `armedRevision == null` after revoke and called the result a MISMATCH — but
  // `armedRevision` persisting is deliberate (it is what the staleness sweep
  // selects on, `armed_revision IS NOT NULL`, never on `status` — I-14), and the
  // control that actually stops the flow firing is the CLOSED APPROVAL. So fire
  // it again and require a refusal: that is the thing a reader cares about, and
  // it cannot pass for the wrong reason.
  const refire = trigId
    ? await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers/${trigId}/fire`)
    : null;
  const after = await http("GET", `/workspaces/${wsId}/flows/${flowId}`);
  record({
    uiCall: "foundryApi.fireTrigger  (after revoke)",
    verb: "POST",
    path: "/…/triggers/:tid/fire",
    status: refire ? refire.status : "skipped",
    ms: refire?.ms ?? 0,
    intended:
      "Revoking must actually stop it firing. `assertMayRunLive` refuses when `currentApproval` is " +
      "null — and revoke closes approvals by timestamp rather than deleting them, so the audit trail " +
      "survives the revocation.",
    real: refire
      ? `${refire.status} ${digest(refire.body, 110)} — and the flow now reads status=` +
        `${after.body?.flow?.status}, armedRevision=${JSON.stringify(after.body?.flow?.armedRevision)}. ` +
        "`armedRevision` deliberately STAYS set: the staleness sweep selects on " +
        "`armed_revision IS NOT NULL` and never on `status`, so clearing it here would quietly drop " +
        "the flow out of the sweep (I-14)."
      : "no trigger to re-fire",
    verdict: refire ? (refire.status === 403 ? "MATCH" : "MISMATCH") : "NOTE",
  });

  if (!KEEP) {
    const tplId = tpl1.body?.id ?? tpl1.body?.template?.id;
    if (tplId) await http("DELETE", `/workspaces/${wsId}/flow-templates/${tplId}`);
    const del = await http("DELETE", `/workspaces/${wsId}/flows/${flowId}`);
    record({
      uiCall: "foundryApi.deleteFlow",
      verb: "DELETE",
      path: "/…/flows/:id",
      status: del.status,
      ms: del.ms,
      intended: "204, and the flow's history stays — `flow_executions.flow_id` is nullable.",
      real: `${del.status}`,
      verdict: del.status === 204 ? "MATCH" : "NOTE",
    });
  }
}

// ── the report ───────────────────────────────────────────────────────────────

function writeReport() {
  const count = (v: Verdict) => steps.filter((s) => s.verdict === v).length;
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

  const lines: string[] = [];
  lines.push("# E2E — the UI's journey, real behaviour beside intended behaviour");
  lines.push("");
  lines.push(
    "> **Generated.** `pnpm --filter @foundry/server e2e:ui` overwrites this file. Do not hand-edit " +
      "it — record durable conclusions in `ISSUES.md` / `DECISIONS.md` instead.",
  );
  lines.push("");
  lines.push(
    `Period \`${PERIOD}\` · API \`${BASE}\` · web \`${WEB_BASE}\` · ${steps.length} recorded steps`,
  );
  lines.push("");
  lines.push("| verdict | n | meaning |");
  lines.push("| :--- | ---: | :--- |");
  lines.push(`| ✅ MATCH | ${count("MATCH")} | real behaviour is what the design says |`);
  lines.push(
    `| ⚠ MISMATCH | ${count("MISMATCH")} | real behaviour contradicts a stated invariant |`,
  );
  lines.push(
    `| 🕳 GAP | ${count("GAP")} | the UI has no way to do this; the journey used a raw route |`,
  );
  lines.push(`| 📝 NOTE | ${count("NOTE")} | reads as a bug, is not, with the reason |`);
  lines.push(`| ❌ FAIL | ${count("FAIL")} | the journey could not continue as intended |`);
  lines.push("");
  lines.push(
    "**What this exercise can and cannot say.** It drives the same HTTP surface " +
      "`packages/client` drives, so it can say *the client's calls behave as documented*. It is not a " +
      "browser: it does not render a component, does not run the middleware session check with a real " +
      "session, and does not open the progress WebSocket — it only proves the ticket that authorises " +
      "one is minted. And a green journey is **not a correct automation**: the one step that can say " +
      "correct is the oracle comparison, which is why it is in here.",
  );
  lines.push("");

  const phases = [...new Set(steps.map((s) => s.phase))];
  for (const p of phases) {
    lines.push(`## ${p}`);
    lines.push("");
    lines.push("| # | verdict | UI call | request | status | intended | real |");
    lines.push("| ---: | :--- | :--- | :--- | ---: | :--- | :--- |");
    for (const s of steps.filter((x) => x.phase === p)) {
      const icon =
        s.verdict === "MATCH"
          ? "✅"
          : s.verdict === "MISMATCH"
            ? "⚠"
            : s.verdict === "GAP"
              ? "🕳"
              : s.verdict === "FAIL"
                ? "❌"
                : "📝";
      lines.push(
        `| ${s.n} | ${icon} ${s.verdict} | ${
          s.uiCall ? `\`${esc(s.uiCall)}\`` : "**none**"
        } | \`${esc(s.verb)} ${esc(s.path)}\` | ${s.status} | ${esc(s.intended)} | ${esc(s.real)} |`,
      );
    }
    lines.push("");
  }

  const notable = steps.filter((s) => s.verdict === "MISMATCH" || s.verdict === "GAP");
  if (notable.length) {
    lines.push("## What to do about it");
    lines.push("");
    lines.push(
      "Ordered by how much a reader would be misled by the current state, not by how hard the fix is.",
    );
    lines.push("");
    for (const s of notable) {
      lines.push(`### ${s.verdict} — step ${s.n}: \`${s.verb} ${s.path}\``);
      lines.push("");
      lines.push(`**Intended.** ${s.intended}`);
      lines.push("");
      lines.push(`**Real.** ${s.real}`);
      lines.push("");
    }
  }

  writeFileSync(REPORT, lines.join("\n"));
  return REPORT;
}

// ── main ─────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — the two capabilities the journey did not cover
// ═══════════════════════════════════════════════════════════════════════════
//
// Gate 3 (HITL) and runtime retry landed in Stages 3 and 4, and neither had a
// UI-path journey. Both are asserted against the ENGINE by `kestra:hitl` and
// `kestra:retry`, which import services directly — right for engine properties
// and silent about the only question this file asks: can a person do it from a
// browser, using the methods `packages/client` actually exposes?
//
// The same restriction applies. Every step below names a `foundryApi.*` method,
// and a step with no such method is a GAP.

/** Its own ids, so a run never collides with the main journey's flow. */
const HITL_KESTRA_ID = "e2e-ui-hitl";
const RETRY_KESTRA_ID = "e2e-ui-retry";
const BRANCH_KESTRA_ID = "e2e-ui-branch";
const EXPECT_KESTRA_ID = "e2e-ui-expect";

/**
 * Create a flow the way the CLIENT can since the compiled-builder cutover (phase 8): `POST …/flows/canvas` makes an empty flow
 * (the manual builder's create — `foundryApi.createCanvasFlow`), and `POST …/flows/:id/revisions` saves its model through
 * `writeRevision` (`foundryApi.saveFlowRevision`, the save the editor calls). The deleted `authored` generation route was the
 * previous way in; the funnel every revision passes is unchanged.
 *
 * ⚠ The engine id is now the flow's own (`f-<uuid>`), not the journey's fixed slug, so a flow is found again by the KEY in its
 * name (`… [<key>]`) — `dropIfPresent` reads that.
 */
async function createViaCanvas(
  wsId: string,
  model: unknown,
  name: string,
  _description: string,
  /**
   * ⚠ **WHO AUTHORS IT IS PART OF THE TEST, NOT PLUMBING** (RBAC T101). Gate 2 refuses somebody approving a revision they are
   * recorded as writing, against `flow_revisions.created_by` — the identity that saved it. Named here so the scenario survives a
   * future change to the default identity.
   */
  as: string = AUTHOR,
): Promise<CallResult<any>> {
  const t0 = Date.now();
  const key = (model as { id?: string }).id ?? "flow";
  const made = await http("POST", `/workspaces/${wsId}/flows/canvas`, { name: `${name} [${key}]` }, as);
  if (made.status !== 201) return made;
  const flowId: string = made.body.flowId;
  const got = await http("GET", `/workspaces/${wsId}/flows/${flowId}`, undefined, as);
  const engineId: string | undefined = got.body?.flow?.kestraFlowId;
  const saved = await http("POST", `/workspaces/${wsId}/flows/${flowId}/revisions`, { model: { ...(model as object), id: engineId } }, as);
  return { ...saved, status: saved.status === 200 || saved.status === 201 ? 201 : saved.status, ms: Date.now() - t0 };
}

async function dropIfPresent(wsId: string, key: string) {
  const flows = await http("GET", `/workspaces/${wsId}/flows`);
  const stale = (flows.body?.flows ?? []).find((f: any) => f.kestraFlowId === key || String(f.name ?? "").endsWith(`[${key}]`));
  if (!stale) return;
  if (stale.armedRevision != null) {
    await http("POST", `/workspaces/${wsId}/flows/${stale.id}/approvals/revoke`, {
      reason: "e2e:ui cleanup",
    });
  }
  await http("DELETE", `/workspaces/${wsId}/flows/${stale.id}`);
}

/** Poll the execution view until it reports a PAUSED run, or give up. */
async function waitForPause(wsId: string, execId: string, budgetMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const r = await http("GET", `/workspaces/${wsId}/flow-executions/${execId}`);
    if (r.body?.engineStatus === "paused") return { view: r.body, waitedMs: Date.now() - t0 };
    if (r.body?.engineStatus && !["running", "created", "queued", "restarted"].includes(r.body.engineStatus)) {
      return { view: r.body, waitedMs: Date.now() - t0, settledEarly: true } as any;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { view: null, waitedMs: Date.now() - t0, timedOut: true } as any;
}

/**
 * How many mails THIS journey's gated flow has sent, matched by subject.
 *
 * ⚠ Not a total. The first version counted every row in the outbox and produced
 * a MISMATCH on its first run: phase 4 fires a `full` replay and does NOT wait
 * for it, so ten of the reference flow's emails landed while the HITL run was
 * paused. The assertion was right that mail appeared and wrong about whose it
 * was — and "nothing was sent" is exactly the claim that must not be satisfied
 * or refuted by someone else's traffic.
 */
const HITL_SUBJECT = "E2E HITL gate";

async function gatedMailCount(): Promise<number> {
  const r = await http("GET", `/ops/outbox/mail`);
  return (r.body?.messages ?? []).filter((m: any) => m.subject === HITL_SUBJECT).length;
}

async function phase5Hitl(wsId: string) {
  setPhase("PHASE 5a — HITL: a run that stops, sends nothing, and waits for a person");
  await dropIfPresent(wsId, HITL_KESTRA_ID);

  // The model. `gate` sits BETWEEN the screen and the send, which is the entire
  // mechanism: tasks run in emission order, so `notify` cannot execute until the
  // Pause resolves. A gate after the send would satisfy every other assertion.
  const model = {
    id: HITL_KESTRA_ID,
    inputs: [{ id: "period", type: "STRING", defaults: PERIOD }],
    steps: [
      // (No `fetch_policy` here: nothing in this journey reads it, and a canvas
      // flow's final stage refuses a data step nothing reads — phase 7.)
      {
        id: "screen",
        kind: "datasource",
        ref: "hr_demo.attendance_below_threshold",
        paramsExpr: `[{ "period": "{{ inputs.period }}" }]`,
      },
      {
        id: "notify",
        kind: "tool",
        ref: "mail_send",
        paramsExpr:
          "{{ json(outputs.screen.body).results[0].data " +
          `| jq('[.[] | select(.work_email != null) | {sender: "people@acme-hr.example", ` +
          `recipients: [.work_email], subject: "${HITL_SUBJECT}", body: "Please review your attendance."}]') ` +
          "| first }}",
        dependsOn: ["screen"],
        timeoutSeconds: 120,
      },
    ],
  };

  const created = await createViaCanvas(
    wsId,
    model,
    "E2E UI journey — HITL",
    "A run that pauses for a human before it sends anything.",
  );
  record({
    uiCall: "foundryApi.createCanvasFlow + saveFlowRevision",
    verb: "POST",
    path: "/workspaces/:ws/flows/canvas + revisions  (base model, ungated: screen → notify)",
    status: created.status,
    ms: created.ms,
    intended:
      "Creating a flow from a hand-authored model — the canvas's path since Stage 5. The gate " +
      "itself is added below, through the method a browser uses.",
    real: `${created.status} ${created.status === 201 ? "created on the canvas and saved" : digest(created.body, 160)}`,
    verdict: created.status === 201 ? "MATCH" : "FAIL",
  });
  const flowId = created.body?.flow?.id;
  if (!flowId) return;

  // ── Stage 7 closed this: gate 3 is now declarable from a browser ───────────
  //
  // `FlowReview`'s per-step "Require approval before this step" splices an
  // `approval` step in immediately BEFORE its target, gives it the target's
  // dependencies, and repoints the target at the gate. Placement is the whole
  // mechanism — Kestra runs tasks in emission order — so this reproduces that
  // edit exactly rather than authoring the gated model up front.
  const at = model.steps.findIndex((s) => s.id === "notify");
  const target = model.steps[at] as { dependsOn?: string[] };
  const gated = {
    ...model,
    steps: [
      ...model.steps.slice(0, at),
      {
        id: "notify_gate",
        kind: "approval",
        // A literal, so `@json` is not needed — see ApprovalStep.summaryExpr for
        // the computed form, which is I-11 in its most literal shape.
        summaryExpr: '"Send attendance warnings for this period?"',
        contextExpr: "{{ json(outputs.screen.body).results[0].data | jq('{employees: .}') | first }}",
        dependsOn: target.dependsOn ?? [],
        awaitSeconds: 600,
      },
      { ...model.steps[at], dependsOn: ["notify_gate"] },
      ...model.steps.slice(at + 1),
    ],
  };
  const gateAdded = await http("POST", `/workspaces/${wsId}/flows/${flowId}/revisions`, {
    model: gated,
  });
  record({
    uiCall: "foundryApi.saveFlowRevision",
    verb: "POST",
    path: "/…/flows/:id/revisions  (splicing in an `approval` step)",
    status: gateAdded.status,
    ms: gateAdded.ms,
    intended:
      "Stage 3 added the `approval` kind and until Stage 7 nothing but curl could declare one. " +
      "`FlowReview` inserts the gate BEFORE its target and repoints the target at it — a gate " +
      "emitted after the send would satisfy every assertion about a pause and stop no email at all.",
    real:
      `${gateAdded.status} → revision ${gateAdded.body?.revision?.revision}, ` +
      "`notify` now depends on `notify_gate`. Everything below runs the gated revision.",
    verdict: gateAdded.status === 201 ? "MATCH" : "FAIL",
  });
  if (gateAdded.status !== 201) return;

  const mailBefore = await gatedMailCount();
  const baseline = await snapshotExecutions(wsId);
  const run = await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, {
    inputs: { period: PERIOD },
  });
  const { execId } = await waitForRow(wsId, baseline);
  if (!execId) {
    record({
      uiCall: "foundryApi.testRunFlow",
      verb: "POST",
      path: "/…/test-run  (HITL flow)",
      status: run.status,
      ms: run.ms,
      intended: "202, and the run becomes addressable when `begin` writes `flow_executions`.",
      real: "the run never appeared in the executions list",
      verdict: "FAIL",
    });
    return;
  }

  const paused = await waitForPause(wsId, execId);
  record({
    uiCall: "foundryApi.getFlowExecution (polled)",
    verb: "GET",
    path: "/…/flow-executions/:id",
    status: paused.view ? 200 : "timeout",
    ms: paused.waitedMs,
    intended:
      "The run STOPS at the gate and reports `paused`. The wait is a `core.flow.Pause` in Kestra's " +
      "DATABASE, not a socket — so it survives an API-server restart, which is the point of gate 3 " +
      "being a step rather than a check.",
    real: paused.view
      ? `engineStatus=${paused.view.engineStatus} after ${(paused.waitedMs / 1000).toFixed(1)}s`
      : `never paused in ${(paused.waitedMs / 1000).toFixed(0)}s`,
    verdict: paused.view?.engineStatus === "paused" ? "MATCH" : "FAIL",
  });
  if (paused.view?.engineStatus !== "paused") return;

  // ⚠ THE ASSERTION THE WHOLE GATE EXISTS FOR. A paused run that had already
  // sent is a gate that decorates rather than gates, and every other assertion
  // here would still pass.
  const mailDuring = await gatedMailCount();
  record({
    uiCall: "foundryApi.demoMail",
    verb: "GET",
    path: "/ops/outbox/mail  (while the run is paused)",
    status: 200,
    ms: 0,
    intended:
      "NOTHING has been sent. The gate is placed before the send and Kestra runs tasks in emission " +
      "order, so `notify` cannot have executed. A gate that pauses AFTER the send would satisfy " +
      "every other check on this page.",
    real: `${mailDuring} message(s) from this flow, ${mailBefore} before the run started`,
    verdict: mailDuring === mailBefore ? "MATCH" : "MISMATCH",
  });

  const pending = await http("GET", `/workspaces/${wsId}/step-approvals`);
  const mine = (pending.body?.approvals ?? []).find((a: any) => a.flowExecutionId === execId);
  record({
    uiCall: "foundryApi.listPendingApprovals",
    verb: "GET",
    path: "/workspaces/:ws/step-approvals",
    status: pending.status,
    ms: pending.ms,
    intended:
      "The inbox a person opens. An approval is named by ITS OWN id, never by a Kestra taskrun (R5) " +
      "— the task to resume is stored server-side and resolved there. It must carry the question and " +
      "the evidence, because 'approve sending 10 emails' is unanswerable without knowing to whom.",
    real: mine
      ? `${pending.body.approvals.length} pending; this one asks "${String(mine.summary).slice(0, 60)}" ` +
        `and carries ${mine.context ? "context" : "NO context"}`
      : `${pending.status}; this execution's decision is not in the list`,
    verdict: mine ? "MATCH" : "MISMATCH",
  });
  if (!mine) return;

  const decided = await http(
    "POST",
    `/workspaces/${wsId}/step-approvals/${mine.id}/decide`,
    { decision: "approved", note: "e2e:ui" },
    APPROVER,
  );
  record({
    uiCall: "foundryApi.decideApproval",
    verb: "POST",
    path: "/…/step-approvals/:id/decide  {approved}",
    status: decided.status,
    ms: decided.ms,
    intended:
      "The resume is posted MULTIPART, server-side — Kestra accepts JSON with a 2xx and silently " +
      "drops the inputs (D-21). ⚠ The approver is SELF-ASSERTED: one shared PARENT_API_KEY, no user " +
      "model (I-13). This is not separation of duties and must never be described as such.",
    real: `${decided.status} ${digest(decided.body, 120)}`,
    verdict: decided.status === 200 ? "MATCH" : "MISMATCH",
  });

  const again = await http(
    "POST",
    `/workspaces/${wsId}/step-approvals/${mine.id}/decide`,
    { decision: "rejected" },
    APPROVER,
  );
  record({
    uiCall: "foundryApi.decideApproval  (twice)",
    verb: "POST",
    path: "/…/decide  (a second decision on the same approval)",
    status: again.status,
    ms: again.ms,
    intended:
      "409. There is no undo: the first decision already resumed or killed the execution, so a " +
      "second one would either do nothing or contradict a run that has moved on. A UI that lets a " +
      "person 'change their mind' after the send is worse than one that does not offer it.",
    real: `${again.status} ${digest(again.body, 120)}`,
    verdict: again.status === 409 ? "MATCH" : "MISMATCH",
  });

  const done = await settle(wsId, execId);
  const mailAfter = await gatedMailCount();
  // ⚠ "the send happened" is period-dependent, and hardcoding "more than zero"
  // makes this step fail at 2026-05 for being correct: the dataset flags nobody
  // that month, so the right number of emails is none. I-09 is the same trap one
  // layer down — a flow that works in a bad month and breaks in a good one.
  const oracleExpects = expectedScreening(PERIOD).flagged.filter((e) => e.email).length;
  record({
    uiCall: "foundryApi.getFlowExecution",
    verb: "GET",
    path: "/…/flow-executions/:id  (after approval)",
    status: 200,
    ms: done.waitedMs,
    intended:
      "The run resumes and the send happens — the gate delays the work, it does not replace it. " +
      "⚠ Read `engineStatus`, never `flow_executions.status` (D-13): the row is written by the " +
      "flow's own `complete` task, so a failed run stays `running` for ever.",
    real:
      `engineStatus=${done.view?.engineStatus}; this flow's sends ${mailBefore} → ${mailAfter} ` +
      `(${mailAfter - mailBefore} after the decision; the oracle expects ${oracleExpects} for ${PERIOD}` +
      `${oracleExpects === 0 ? ", the empty case" : ""})`,
    verdict:
      done.view?.engineStatus === "success" && mailAfter - mailBefore === oracleExpects
        ? "MATCH"
        : "MISMATCH",
  });

  // ── the rejection path ────────────────────────────────────────────────────
  //
  // Run it again and say no. This is the half that is easy to leave untested,
  // and it is the half where "nothing happened" is the required outcome — which
  // is indistinguishable from a broken run unless the run's own state is checked.
  const mailBeforeReject = await gatedMailCount();
  const base2 = await snapshotExecutions(wsId);
  await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, { inputs: { period: PERIOD } });
  const { execId: exec2 } = await waitForRow(wsId, base2);
  if (!exec2) return;
  const paused2 = await waitForPause(wsId, exec2);
  if (paused2.view?.engineStatus !== "paused") {
    record({
      uiCall: "foundryApi.getFlowExecution (polled)",
      verb: "GET",
      path: "/…/flow-executions/:id  (second run, for the rejection path)",
      status: "n/a",
      ms: paused2.waitedMs,
      intended: "The second run pauses at the same gate.",
      real: `engineStatus=${paused2.view?.engineStatus ?? "unknown"}`,
      verdict: "FAIL",
    });
    return;
  }
  const pending2 = await http("GET", `/workspaces/${wsId}/step-approvals`);
  const mine2 = (pending2.body?.approvals ?? []).find((a: any) => a.flowExecutionId === exec2);
  if (!mine2) return;
  const rejected = await http(
    "POST",
    `/workspaces/${wsId}/step-approvals/${mine2.id}/decide`,
    { decision: "rejected", note: "e2e:ui — the rejection path" },
    APPROVER,
  );
  const after2 = await settle(wsId, exec2);
  const mailAfterReject = await gatedMailCount();
  record({
    uiCall: "foundryApi.decideApproval  {rejected}",
    verb: "POST",
    path: "/…/decide  {rejected}",
    status: rejected.status,
    ms: rejected.ms + after2.waitedMs,
    intended:
      "Rejecting KILLS the run; it does not resume it with a 'no'. Resuming would run the send task, " +
      "which is the one thing the gate exists to prevent — a rejected batch that goes out anyway is " +
      "worse than no gate at all. The run must end in a terminal non-success state and the outbox " +
      "must not move.",
    real:
      `${rejected.status}; engineStatus=${after2.view?.engineStatus}; ` +
      `this flow's sends ${mailBeforeReject} → ${mailAfterReject}`,
    verdict:
      rejected.status === 200 &&
      mailAfterReject === mailBeforeReject &&
      ["killed", "cancelled", "failed"].includes(String(after2.view?.engineStatus))
        ? "MATCH"
        : "MISMATCH",
  });

  if (!KEEP) await dropIfPresent(wsId, HITL_KESTRA_ID);
}

async function phase5Retry(wsId: string) {
  setPhase("PHASE 5b — runtime retry: a transient failure the UI can see recovering");
  await dropIfPresent(wsId, RETRY_KESTRA_ID);

  // `flaky_probe` is registered by `showcase:seed`, not by `demo:seed` — it is a
  // fixture whose job is to fail, deliberately kept out of the 15-tool catalogue
  // the regression net counts. Its absence is a SETUP problem, not a finding.
  const tools = await http("GET", `/workspaces/${wsId}/tools`);
  const probe = (tools.body?.tools ?? []).find((t: any) => t.name === "flaky_probe");
  if (!probe) {
    record({
      uiCall: "foundryApi.listTools",
      verb: "GET",
      path: "/workspaces/:ws/tools",
      status: tools.status,
      ms: tools.ms,
      intended: "`flaky_probe` is registered by `showcase:seed` and is what the retry journey drives.",
      real: "not registered — run `pnpm --filter @foundry/server showcase:seed` first",
      verdict: "NOTE",
    });
    return;
  }

  const model = {
    id: RETRY_KESTRA_ID,
    steps: [
      {
        id: "probe",
        kind: "tool",
        ref: "flaky_probe",
        // The execution id as the key, so each run starts from a real first
        // attempt. A fixed key would fail once ever and every run after the
        // first would sail through — the least useful possible demo.
        paramsExpr: '[{ "key": "{{ execution.id }}", "failures": 1 }]',
        // NO retry here on purpose — it is turned on below, through the method
        // the browser uses. See the two records that follow.
        timeoutSeconds: 30,
      },
    ],
  };
  const created = await createViaCanvas(
    wsId,
    model,
    "E2E UI journey — retry",
    "A step whose backend 503s once and succeeds on the second call.",
  );
  record({
    uiCall: "foundryApi.createCanvasFlow + saveFlowRevision",
    verb: "POST",
    path: "/workspaces/:ws/flows/canvas + revisions  (base model, no retry)",
    status: created.status,
    ms: created.ms,
    intended:
      "Creating a flow from a hand-authored model — the canvas's path since Stage 5. Retry is " +
      "turned on below, through the method the browser uses.",
    real: `${created.status} ${created.status === 201 ? "created on the canvas and saved" : digest(created.body, 160)}`,
    verdict: created.status === 201 ? "MATCH" : "FAIL",
  });
  const flowId = created.body?.flow?.id;
  if (!flowId) return;

  // ── Stage 7 closed this: retry is now declarable from a browser ────────────
  //
  // `FlowReview` offers "Retry this step if it fails" per step, on the three
  // kinds the server accepts, and it lands as an edited model through
  // `foundryApi.saveFlowRevision`. That is exactly the call below — same route,
  // same body shape, and the retry the rest of this phase then observes is the
  // one a person could have added by clicking.
  const withRetry = {
    ...model,
    steps: model.steps.map((s) => ({
      ...s,
      retry: { maxAttempts: 3, backoff: "exponential", intervalSeconds: 5 },
    })),
  };
  const retried = await http("POST", `/workspaces/${wsId}/flows/${flowId}/revisions`, {
    model: withRetry,
  });
  record({
    uiCall: "foundryApi.saveFlowRevision",
    verb: "POST",
    path: "/…/flows/:id/revisions  (turning on `retry` for a step)",
    status: retried.status,
    ms: retried.ms,
    intended:
      "Stage 4 added `retry` to `tool`/`datasource`/`code` steps and until Stage 7 nothing but curl " +
      "could declare one — `FlowReview`'s per-step control writes it through this method. An edit " +
      "is a NEW revision, never in place, so an armed flow keeps firing the approved one (§6.5).",
    real:
      `${retried.status} → revision ${retried.body?.revision?.revision}. The retry the rest of this ` +
      "phase observes is the one that control produces.",
    verdict: retried.status === 201 ? "MATCH" : "FAIL",
  });

  const baseline = await snapshotExecutions(wsId);
  await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, { inputs: {} });
  const { execId } = await waitForRow(wsId, baseline);
  if (!execId) return;
  const done = await settle(wsId, execId);

  record({
    uiCall: "foundryApi.getFlowExecution",
    verb: "GET",
    path: "/…/flow-executions/:id  (after a recovered run)",
    status: 200,
    ms: done.waitedMs,
    intended:
      "WARNING, not SUCCESS. A run that needed a second attempt DID recover, and recording that as a " +
      "plain success would hide the one signal distinguishing 'worked' from 'worked on the third go'. " +
      "⚠ `Run.outcome` has three values and `lib/stats.ts` divides by SETTLED runs (D-14) — a warning " +
      "must not be counted as an incident either.",
    real: `engineStatus=${done.view?.engineStatus}`,
    verdict: done.view?.engineStatus === "warning" ? "MATCH" : "MISMATCH",
  });

  // The badge the UI renders. It reads `attempt` off the step view, and the
  // whole reason this step is here is that the field existed and could never
  // fire — Stage 4 found it never exceeded 1 because nothing populated it.
  const steps5 = done.view?.steps ?? [];
  const probeStep = steps5.find((s: any) => s.stepId === "probe" || s.id === "probe");
  record({
    uiCall: "foundryApi.getFlowExecution → StepStrip attempt badge",
    verb: "GET",
    path: "the `attempt` field the UI renders",
    status: 200,
    ms: 0,
    intended:
      "The step view carries the attempt count, so a person can see WHY a run is a warning without " +
      "opening the engine — which they cannot do at all (R5, and `kestra-ui` is for internal " +
      "engineers only).",
    real: probeStep
      ? `probe: status=${probeStep.status}, attempt=${probeStep.attempt ?? "absent"}`
      : "no `probe` step in the redacted step view",
    verdict: probeStep && Number(probeStep.attempt) >= 2 ? "MATCH" : "MISMATCH",
  });

  // The second witness. Kestra reporting "attempt 2" while the service saw one
  // request would mean the retry never left the engine — and the call log is a
  // client-reachable surface, so this stays inside the journey's rule.
  const calls = await http("GET", `/ops/outbox/calls`);
  const probeCalls = (calls.body?.calls ?? []).filter((r: any) => r.toolName === "flaky_probe");
  record({
    uiCall: "foundryApi.demoCalls",
    verb: "GET",
    path: "/ops/outbox/calls",
    status: calls.status,
    ms: calls.ms,
    intended:
      "The ENDPOINT saw two requests. Two independent witnesses, because Kestra saying 'attempt 2' " +
      "while the service saw one call would mean the retry never left the engine — and that is " +
      "exactly the shape of a retry demo that passes while demonstrating nothing.",
    real: `${probeCalls.length} call(s) to flaky_probe in the log`,
    verdict: probeCalls.length >= 2 ? "MATCH" : "MISMATCH",
  });

  if (!KEEP) await dropIfPresent(wsId, RETRY_KESTRA_ID);
}

/**
 * PHASE 5d — GAPS §2.3: a flow says what it should produce, and gate 1 checks it.
 *
 * Everything here goes through methods `packages/client` calls: the claim is
 * declared with `foundryApi.saveFlowRevision` — the exact call `FlowReview`'s
 * expectation editor makes — read back with `foundryApi.getFlowExecution`, and
 * the consequence is observed on `foundryApi.listTriggers`, which is what the
 * Triggers page renders as a blocked switch.
 *
 * ⚠ **Both arms.** A claim that is wrong must block the trigger AND a claim that
 * is right must release it, in the same phase against the same flow. One arm
 * alone is satisfied by a gate that is simply broken.
 */
async function phase5Expectations(wsId: string) {
  setPhase("PHASE 5d — what the flow says it will produce, and gate 1 checking it");
  await dropIfPresent(wsId, EXPECT_KESTRA_ID);

  const model: any = {
    id: EXPECT_KESTRA_ID,
    inputs: [{ id: "period", type: "STRING", defaults: PERIOD }],
    steps: [
      {
        id: "screen",
        kind: "datasource",
        ref: "hr_demo.attendance_below_threshold",
        paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
      },
    ],
  };
  const created = await createViaCanvas(
    wsId,
    model,
    "E2E UI journey — expectations",
    "One query, and a claim about how many rows it should return.",
  );
  record({
    uiCall: "foundryApi.createCanvasFlow + saveFlowRevision",
    verb: "POST",
    path: "/workspaces/:ws/flows/canvas + revisions  (no claims yet)",
    status: created.status,
    ms: created.ms,
    intended: "The base flow. Claims are added below through the method the browser uses.",
    real: `${created.status} ${created.status === 201 ? "created" : digest(created.body, 160)}`,
    verdict: created.status === 201 ? "MATCH" : "FAIL",
  });
  const flowId = created.body?.flow?.id;
  if (!flowId) return;

  // ── A claim that is WRONG ─────────────────────────────────────────────────
  // `/test-oracle/screening`, and the path is named that way on purpose (D-…):
  // it is a TEST surface, not part of the product.
  const oracle = await http("GET", `/test-oracle/screening?period=${PERIOD}`);
  const trueCount = (oracle.body?.flagged ?? []).length;
  const wrong = { ...model, expectations: [
    { id: "row_count", stepId: "screen", assert: { type: "rowCount", op: "eq", value: trueCount + 7 } },
  ] };
  const declaredWrong = await http("POST", `/workspaces/${wsId}/flows/${flowId}/revisions`, {
    model: wrong,
  });
  record({
    uiCall: "foundryApi.saveFlowRevision",
    verb: "POST",
    path: "/…/flows/:id/revisions  (declaring an expectation)",
    status: declaredWrong.status,
    ms: declaredWrong.ms,
    intended:
      "GAPS §2.3. A claim about the flow's own output, declared the way `FlowReview`'s expectation " +
      "editor declares one — as a NEW REVISION, because a claim is part of what an approver approves " +
      "and editing one in place would repoint an armed flow's gate without a new approval.",
    real: `${declaredWrong.status} → revision ${declaredWrong.body?.revision?.revision}, claiming ${trueCount + 7} rows (the oracle says ${trueCount})`,
    verdict: declaredWrong.status === 201 ? "MATCH" : "FAIL",
  });
  if (declaredWrong.status !== 201) return;

  const base1 = await snapshotExecutions(wsId);
  await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, { inputs: { period: PERIOD } });
  const r1 = await waitForRow(wsId, base1);
  if (!r1.execId) return;
  const done1 = await settle(wsId, r1.execId);
  const v1 = (done1.view?.expectations ?? []).find((v: any) => v.expectationId === "row_count");
  record({
    uiCall: "foundryApi.getFlowExecution",
    verb: "GET",
    path: "/…/flow-executions/:id  (the verdicts the run page renders)",
    status: 200,
    ms: done1.waitedMs,
    intended:
      "The run SUCCEEDS and the claim FAILS — two different facts, reported separately. A wrong " +
      "answer is not a broken flow, and collapsing them would send someone to look at the engine.",
    real: `engineStatus=${done1.view?.engineStatus}, row_count=${v1?.status ?? "absent"} — ${v1?.detail ?? ""}`,
    verdict: done1.view?.engineStatus === "success" && v1?.status === "failed" ? "MATCH" : "MISMATCH",
  });

  // ── The consequence, on the surface a person actually looks at ────────────
  // Flow-scoped, which is the only constructor there is (`createForFlow`) — and
  // it is what `foundryApi.listTriggers` fans out over to build the Triggers page.
  const trig = await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers`, {
    name: "expectations gate",
    type: "manual",
    config: { inputs: { period: PERIOD } },
  });
  const blockedList = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers`);
  const blocked = (blockedList.body?.triggers ?? []).find((t: any) => t.id === trig.body?.trigger?.id);
  record({
    uiCall: "foundryApi.listTriggers",
    verb: "GET",
    path: "/…/flows/:id/triggers  (gate 1, with a failing claim)",
    status: blockedList.status,
    ms: blockedList.ms,
    intended:
      "Gate 1 used to mean only 'it completed once' — which the measured disaster passed, having " +
      "emailed 0 of 11 and exited 0. It now also requires the flow's own claims to have held, and " +
      "the blocked switch NAMES the claim so the Triggers page is not a dead control.",
    real: `enableReady=${blocked?.enableReady} — ${String(blocked?.enableBlockedReason ?? "").slice(0, 120)}`,
    verdict:
      blocked?.enableReady === false && String(blocked?.enableBlockedReason).includes("row_count")
        ? "MATCH"
        : "MISMATCH",
  });

  // ── The other arm: correct the claim, run again, the gate releases ────────
  const right = { ...model, expectations: [
    { id: "row_count", stepId: "screen", assert: { type: "rowCount", op: "eq", value: trueCount } },
  ] };
  await http("POST", `/workspaces/${wsId}/flows/${flowId}/revisions`, { model: right });
  const base2 = await snapshotExecutions(wsId);
  await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, { inputs: { period: PERIOD } });
  const r2 = await waitForRow(wsId, base2);
  if (!r2.execId) return;
  const done2 = await settle(wsId, r2.execId);
  const v2 = (done2.view?.expectations ?? []).find((v: any) => v.expectationId === "row_count");
  const freeList = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers`);
  const free = (freeList.body?.triggers ?? []).find((t: any) => t.id === trig.body?.trigger?.id);
  record({
    uiCall: "foundryApi.listTriggers",
    verb: "GET",
    path: "/…/flows/:id/triggers  (gate 1, after the claim holds)",
    status: freeList.status,
    ms: freeList.ms,
    intended:
      "⚠ The arm that makes the one above discriminating. A gate that only ever refuses is " +
      "indistinguishable from a gate that is broken, and this product has been bitten by a control " +
      "that could not fail five times (I-38) — the mirror of it is a control that cannot pass.",
    real: `row_count=${v2?.status}, enableReady=${free?.enableReady}`,
    verdict: v2?.status === "passed" && free?.enableReady === true ? "MATCH" : "MISMATCH",
  });

  if (!KEEP) await dropIfPresent(wsId, EXPECT_KESTRA_ID);
}

/**
 * PHASE 5c — Stage 8: which tenant the agent runs in, and where its questions go.
 *
 * ── What this phase can and cannot show ──────────────────────────────────────
 *
 * It cannot make a model choose to ask a question. That needs a live run whose
 * model chooses to call `ask_questions`, which is not deterministic and is not
 * something a journey should coax out of a model — so the question path is
 * recorded as a NOTE naming its unit tests, rather than as a step that passes
 * because nothing happened.
 *
 * What it CAN show is everything a browser sees around it: the workspace's
 * effective tenant, the audit reporting an unconfigured one as a gap rather than
 * as clean, and the inbox carrying `kind` so a question and a checkpoint are
 * distinguishable before either exists.
 */
/**
 * PHASE 5e — an if / elif / else chain, and WHICH ARM ACTUALLY RAN.
 *
 * ⚠ **A CHAIN THAT COMPILES, DEPLOYS AND GOES GREEN PROVES NOTHING ABOUT
 * ROUTING.** Every arm running would also be green — so would none of them,
 * on a flow whose only steps are inside arms. The single assertion with teeth
 * is that the arm which SHOULD have run did, and the others did not. Without
 * it this is a test that cannot fail (I-38).
 *
 * It runs the same flow twice with different inputs, because one run can only
 * ever show one arm and "the `if` arm fires" is equally true of a chain whose
 * `else` is unreachable.
 */
async function phase5Branch(wsId: string) {
  setPhase("PHASE 5e — an if/elif/else chain: which arm actually ran");
  await dropIfPresent(wsId, BRANCH_KESTRA_ID);

  // ⚠ Driven by an INPUT, not by a datasource, so the journey does not depend
  // on a seeded dataset and the two runs differ in exactly one value.
  const rows = "json('[' ~ inputs.n ~ ']')";
  const model = {
    id: BRANCH_KESTRA_ID,
    inputs: [{ id: "n", type: "INT", required: true }],
    steps: [
      { id: "big", kind: "branch", conditionExpr: `{{ ${rows} | jq('any(.[]; . > 5)') | first }}` },
      { id: "hi", kind: "transform", expr: '{{ json(\'{"arm":"hi"}\') }}', dependsOn: ["big"] },
      {
        id: "mid",
        kind: "branch",
        conditionExpr: `{{ ${rows} | jq('any(.[]; . > 2)') | first }}`,
        elseOf: "big",
      },
      { id: "middle", kind: "transform", expr: '{{ json(\'{"arm":"middle"}\') }}', dependsOn: ["mid"] },
      // ⚠ The terminal arm carries NO condition. That is what makes it the
      // catch-all, and it is the shape `conditionExpr`'s optionality exists for.
      { id: "rest", kind: "branch", elseOf: "mid" },
      { id: "low", kind: "transform", expr: '{{ json(\'{"arm":"low"}\') }}', dependsOn: ["rest"] },
    ],
  };

  const created = await createViaCanvas(
    wsId,
    model,
    "E2E UI journey — if/elif/else",
    "One decision with three outcomes, driven by a single input.",
  );
  record({
    uiCall: "foundryApi.createCanvasFlow + saveFlowRevision",
    verb: "POST",
    path: "/workspaces/:ws/flows/canvas + revisions  (an if/elif/else chain)",
    status: created.status,
    ms: created.ms,
    intended:
      "A chain is three `branch` steps linked by `elseOf`, posted as a hand-authored model through " +
      "the same route the canvas uses. `elseOf` is one field on the BRANCH naming another branch — " +
      "not the per-step arm marker D-123 refused, which is why `armOf` is unchanged.",
    real: `${created.status} ${created.status === 201 ? "created on the canvas and saved" : digest(created.body, 200)}`,
    verdict: created.status === 201 ? "MATCH" : "FAIL",
  });
  const flowId = created.body?.flow?.id;
  if (!flowId) return;

  /** Run it once and report which arm's step reached a successful state. */
  const runWith = async (n: number) => {
    const baseline = await snapshotExecutions(wsId);
    // ⚠ The response is KEPT. The first version discarded it and reported
    // "no execution row appeared", which is true of a 400, a 409 and a 500
    // alike — a FAIL that names nothing is a FAIL somebody has to re-derive.
    const kick = await http("POST", `/workspaces/${wsId}/flows/${flowId}/test-run`, {
      // ⚠ STRING, not number — `testRunSchema` is `z.record(z.string())`, which
      // is the wire shape Kestra takes; the flow's own input is declared `INT`
      // and the engine coerces. Sending the number is a 400 that names the path.
      inputs: { n: String(n) },
    });
    const { execId } = await waitForRow(wsId, baseline);
    if (!execId) return { failed: `${kick.status} ${digest(kick.body, 220)}` };
    const done = await settle(wsId, execId);
    const byId = new Map<string, string>(
      (done.view?.steps ?? []).map((st: any) => [st.stepId ?? st.id, String(st.status ?? "")]),
    );
    const ran = (id: string) => /success|succeeded/i.test(byId.get(id) ?? "");
    return { engineStatus: done.view?.engineStatus, ran, seen: [...byId.keys()] };
  };

  for (const [n, expected, others] of [
    [9, "hi", ["middle", "low"]],
    [1, "low", ["hi", "middle"]],
  ] as Array<[number, string, string[]]>) {
    const r = await runWith(n);
    if (!r || "failed" in r) {
      record({
        uiCall: "foundryApi.testRunFlow",
        verb: "POST",
        path: `/…/flows/:id/test-run  (n=${n})`,
        status: 0,
        ms: 0,
        intended: "The run becomes addressable and settles.",
        real: r?.failed ?? "no execution row appeared",
        verdict: "FAIL",
      });
      continue;
    }
    const took = r.ran(expected);
    const leaked = others.filter((o) => r.ran(o));
    record({
      uiCall: "foundryApi.getFlowExecution",
      verb: "GET",
      path: `/…/flow-executions/:id  (n=${n} — WHICH ARM RAN)`,
      status: 200,
      ms: 0,
      intended:
        `With n=${n} the "${expected}" arm should run and ${others.join(" / ")} should not. ` +
        "A green run proves nothing here: every arm running is also green, and so is none of them.",
      real:
        `engineStatus=${r.engineStatus}; ${expected} ran=${took}; ` +
        (leaked.length ? `⚠ ALSO ran: ${leaked.join(", ")}` : "no other arm ran") +
        `; steps seen: ${r.seen.join(", ") || "none"}`,
      verdict: took && leaked.length === 0 ? "MATCH" : "MISMATCH",
    });
  }
}

async function phase5ApprovalInbox(wsId: string) {
  setPhase("PHASE 5c — where a decision that waits on a person arrives");

  const inbox = await http("GET", `/workspaces/${wsId}/step-approvals`);
  const kinds = new Set((inbox.body?.approvals ?? []).map((a: any) => a.kind));
  record({
    uiCall: "foundryApi.listPendingApprovals",
    verb: "GET",
    path: "/workspaces/:ws/step-approvals",
    status: inbox.status,
    ms: inbox.ms,
    intended:
      "The inbox for what waits on a person. ⚠ It carried a SECOND kind — a runtime agent's own " +
      "question, answered by posting to that runtime rather than by resuming Kestra — which went " +
      "with the runtime. `kind` stays a column so a second such thing needs no migration.",
    real:
      inbox.status === 200
        ? `${(inbox.body?.approvals ?? []).length} pending; kinds seen: ${[...kinds].join(", ") || "none"}`
        : `HTTP ${inbox.status}`,
    verdict: inbox.status === 200 ? "MATCH" : "MISMATCH",
  });

}


// ── phase 3b — the DEPLOYED path, fired by an API call (T12 / BD-009) ────────

/**
 * ⚠ **THE ONE PATH IN THIS PRODUCT NOBODY HAD EVER FIRED.**
 *
 * A 2026-09-02 measurement found it: `trigger_fires` held **0**
 * rows and the only two triggers on the deployment were `manual` and disabled.
 * So "deploy it and call it like any no-code tool would" was a code path that
 * read well and had never once been executed end to end. A capability with no
 * measured fire is a claim, not a result — and this block is what turns it into
 * one, or into a defect report.
 *
 * It runs LAST, after phase 3 has approved a revision, because the whole point
 * of the `api` receiver is that it starts the APPROVED LIVE revision or nothing.
 *
 * Its controls, without which the block would mean nothing:
 *  - a **disabled** trigger's URL answers 404, even with the right credential;
 *  - **no** Bearer and a **wrong** Bearer both 401, with the SAME body;
 *  - a **mistyped** input is refused BEFORE any row is written — checked by
 *    counting fire rows across the refusal, not by reading the status code;
 *  - the 202 carries a `fireId` and **no engine addressing** (R5).
 */
async function phase3bApiTrigger(wsId: string, flowId: string) {
  setPhase("PHASE 3b — the deployed path: fire an APPROVED flow with an authenticated API call");

  const NAME = `e2e-api-${Date.now().toString(36)}`;
  const created = await http("POST", `/workspaces/${wsId}/flows/${flowId}/triggers`, {
    name: NAME,
    type: "api",
    config: {},
  });
  const trig = created.body?.trigger ?? null;
  const tid = trig?.id as string | undefined;
  const webhookPath = trig?.webhookPath as string | undefined;
  const token = webhookPath?.split("/")[3];
  record({
    uiCall: "foundryApi.createTrigger",
    verb: "POST",
    path: "/…/triggers  (type=api)",
    status: created.status,
    ms: created.ms,
    intended:
      "Creates the programmatic receiver, DISABLED — `createTriggerSchema.enabled` defaults to false " +
      "since a client omitting the field used to arm it. The row carries a generated token and the " +
      "view renders it as `webhookPath`, which is the whole address a caller needs.",
    real:
      created.status === 201 && webhookPath
        ? `201, enabled=${trig.enabled}, webhookPath ends "${webhookPath.slice(-4)}"`
        : `${created.status} ${digest(created.body, 120)}`,
    verdict:
      created.status === 201 && trig?.enabled === false && webhookPath?.endsWith("/api")
        ? "MATCH"
        : "MISMATCH",
  });
  if (!tid || !token) {
    record({
      uiCall: null,
      verb: "—",
      path: "phase 3b",
      status: "n/a",
      ms: 0,
      intended: "An api trigger to fire.",
      real: "The trigger was not created, so the deployed path could not be exercised at all.",
      verdict: "FAIL",
    });
    return;
  }

  /** The public receiver: no API key, no identity — a third party with a URL. */
  const receiver = async (bearer: string | null, body: unknown) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/triggers/${token}/api`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, ms: Date.now() - t0, text };
  };

  // ── Control 1: a disabled trigger's URL addresses nothing ──────────────────
  const whileDisabled = await receiver(token, { inputs: { period: PERIOD } });
  record({
    uiCall: null,
    verb: "POST",
    path: "/api/triggers/:token/api  (trigger still DISABLED)",
    status: whileDisabled.status,
    ms: whileDisabled.ms,
    intended:
      "404. A disabled trigger is not a 403 and not a 401 — the URL addresses nothing, and saying " +
      "'exists but off' to an anonymous caller would confirm the token is real.",
    real: `${whileDisabled.status} ${digest(whileDisabled.body, 80)}`,
    verdict: whileDisabled.status === 404 ? "MATCH" : "MISMATCH",
  });

  const enabled = await http("PATCH", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}`, {
    enabled: true,
  });
  record({
    uiCall: "foundryApi.updateTrigger",
    verb: "PATCH",
    path: "/…/triggers/:tid  (arm it)",
    status: enabled.status,
    ms: enabled.ms,
    intended:
      "Gate 1 — a trigger may be enabled only once its flow has a successful run. Phases 2 and 3 " +
      "produced two, so this is the gate being SATISFIED rather than absent.",
    real: `${enabled.status}, enabled=${enabled.body?.trigger?.enabled}`,
    verdict: enabled.status === 200 && enabled.body?.trigger?.enabled === true ? "MATCH" : "MISMATCH",
  });

  // ── Control 2: both ways of failing authentication answer identically ──────
  const noCred = await receiver(null, { inputs: { period: PERIOD } });
  const badCred = await receiver("not-the-credential", { inputs: { period: PERIOD } });
  record({
    uiCall: null,
    verb: "POST",
    path: "/api/triggers/:token/api  (no Bearer, then a wrong one)",
    status: `${noCred.status}/${badCred.status}`,
    ms: noCred.ms + badCred.ms,
    intended:
      "401 for both, with the SAME body. A response that distinguishes 'no credential' from 'wrong " +
      "credential' tells an attacker which half to work on; the route's own docblock states this and " +
      "it is checked here rather than believed.",
    real:
      `no credential → ${noCred.status} ${digest(noCred.body, 40)}; ` +
      `wrong credential → ${badCred.status} ${digest(badCred.body, 40)}; ` +
      `bodies ${noCred.text === badCred.text ? "identical" : "DIFFER"}`,
    verdict:
      noCred.status === 401 && badCred.status === 401 && noCred.text === badCred.text
        ? "MATCH"
        : "MISMATCH",
  });

  // ── Control 3: a bad input is refused BEFORE anything is written ───────────
  const firesBefore = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fires`);
  const nBefore = (firesBefore.body?.fires ?? []).length;
  const mistyped = await receiver(token, { inputs: { period: { nested: true } } });
  const undeclared = await receiver(token, { inputs: { not_a_real_input: "x" } });
  const firesAfter = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fires`);
  const nAfter = (firesAfter.body?.fires ?? []).length;
  record({
    uiCall: null,
    verb: "POST",
    path: "/api/triggers/:token/api  (a mistyped input, then an undeclared one)",
    status: `${mistyped.status}/${undeclared.status}`,
    ms: mistyped.ms + undeclared.ms,
    intended:
      "422 both times, and — the part worth measuring — NO `trigger_fires` row for either. 'Validated " +
      "before anything is written' is a claim about ordering, so it is checked by counting rows across " +
      "the refusal rather than by reading the status code, which would be true either way.",
    real:
      `mistyped → ${mistyped.status}; undeclared → ${undeclared.status}; ` +
      `fire rows ${nBefore} → ${nAfter}`,
    verdict:
      mistyped.status === 422 && undeclared.status === 422 && nAfter === nBefore
        ? "MATCH"
        : "MISMATCH",
  });

  // ── The fire itself ────────────────────────────────────────────────────────
  const seen = await snapshotExecutions(wsId);
  const fired = await receiver(token, { inputs: { period: PERIOD } });
  const fireId = fired.body?.fireId as string | undefined;
  const leaked = ["kestraExecutionId", "namespace", "executionId"].filter(
    (k) => fired.body && k in fired.body,
  );
  record({
    uiCall: null,
    verb: "POST",
    path: "/api/triggers/:token/api  (authenticated, typed inputs)",
    status: fired.status,
    ms: fired.ms,
    intended:
      "202 with a `fireId` — Foundry's `trigger_fires` row — and NO engine addressing (R5). A " +
      "`flow_executions` id cannot be returned here either: the row does not exist yet, because the " +
      "flow's own `begin` task creates it.",
    real:
      fired.status === 202
        ? `202, fireId=${fireId ? "present" : "MISSING"}${leaked.length ? `, LEAKED: ${leaked.join(", ")}` : ", no engine id"}`
        : `${fired.status} ${digest(fired.body, 140)}`,
    verdict: fired.status === 202 && fireId && leaked.length === 0 ? "MATCH" : "MISMATCH",
  });

  /**
   * ⚠ **THE FINDING, AND IT IS THE REASON THIS BLOCK WAS WORTH WRITING.**
   *
   * The Bearer credential an `api` trigger checks is resolved through the
   * credential seam as `trigger.webhookToken` — which is the SAME STRING as the
   * token in the URL. `trigger.service.ts` says so in its own words: *"api is
   * webhook with a credential on top … so there is exactly one stored secret per
   * row."*
   *
   * The check itself is real code and correctly refuses a wrong value in
   * constant time. What it is not is a second factor: anyone holding the URL
   * already holds the credential, and the client renders that URL as
   * `webhookPath`. So the honest sentence is **"the api receiver requires the
   * token to be presented twice"**, not "it is credential-authenticated" — and
   * the plan's own § 9.2 uses the second phrasing.
   *
   * Recorded as a MISMATCH against the intent rather than a FAIL: nothing is
   * broken, and no route is weaker than it was. What is wrong is the CLAIM.
   */
  const sameSecret = fired.status === 202;
  record({
    uiCall: null,
    verb: "—",
    path: "the api receiver's credential vs the token in its URL",
    status: "n/a",
    ms: 0,
    intended:
      "An `api` trigger is described as adding a credential on top of a webhook — two things a " +
      "caller must hold, so that leaking the URL is not the same as leaking the ability to fire it.",
    real: sameSecret
      ? "The Bearer value that succeeded is BYTE-IDENTICAL to the token in the URL — the credential " +
        "seam resolves an api trigger's ref to its own `webhookToken`. The constant-time check is " +
        "real and refuses a wrong value, but it is the same secret presented twice, and the client " +
        "renders that secret as `webhookPath`. Say 'the token must be presented twice', never " +
        "'credential-authenticated' — and treat the URL as the credential when deciding who may see it."
      : "Not established — the authenticated fire did not succeed, so nothing can be said here.",
    verdict: sameSecret ? "MISMATCH" : "NOTE",
  });

  if (!fireId) return;

  // ── fireId → flowExecutionId → a terminal engineStatus ─────────────────────
  let linked: any = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !linked?.flowExecutionId) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await http("GET", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fires`);
    linked = (list.body?.fires ?? []).find((f: any) => f.id === fireId) ?? null;
  }
  record({
    uiCall: "foundryApi.listTriggerFires",
    verb: "GET",
    path: "/…/triggers/:tid/fires  (fireId → flowExecutionId)",
    status: linked ? 200 : "timeout",
    ms: Date.now() - t0,
    intended:
      "The pointer a caller follows. `begin` stamps the fire id onto the Kestra execution as a label " +
      "and reads it back, which is what links a `trigger_fires` row to a `flow_executions` row without " +
      "ever handing out an engine id.",
    real: linked?.flowExecutionId
      ? `fire ${fireId} → execution ${linked.flowExecutionId}`
      : `no flowExecutionId within 60s (fire row ${linked ? "found" : "not found"})`,
    verdict: linked?.flowExecutionId ? "MATCH" : "MISMATCH",
  });

  const execId = linked?.flowExecutionId as string | undefined;
  if (!execId) {
    void seen;
    return;
  }
  const done = await settle(wsId, execId);
  record({
    uiCall: "foundryApi.getFlowExecution",
    verb: "GET",
    path: "/…/flow-executions/:id  (the API-fired run, to a terminal state)",
    status: done.timedOut ? "timeout" : 200,
    ms: done.waitedMs,
    intended:
      "A run started by an authenticated API call is an ordinary run: same redacted step view, same " +
      "`engineStatus`. ⚠ Read `engineStatus`, NEVER `flow_executions.status` (D-13) — Foundry's row " +
      "is written by the flow's own `complete` task, so a failed run stays `running` for ever.",
    real: done.timedOut
      ? `did not settle in ${Math.round(done.waitedMs / 1000)}s`
      : `engineStatus=${done.view?.engineStatus}, foundry status=${done.view?.status}, ` +
        `${(done.view?.steps ?? []).length} step(s)`,
    verdict: !done.timedOut && done.view?.engineStatus === "success" ? "MATCH" : "MISMATCH",
  });

  // Leave nothing armed. An enabled receiver on a shared deployment is a URL
  // that keeps working after the harness has gone.
  await http("PATCH", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}`, { enabled: false });
  if (!KEEP) await http("DELETE", `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}`);
}

async function main() {
  console.log(`\nE2E — the UI's journey over HTTP\n${"═".repeat(76)}`);
  console.log(`api      ${c.dim(BASE)}`);
  console.log(`web      ${c.dim(WEB_BASE)}`);
  console.log(`period   ${c.dim(PERIOD)}`);
  console.log(
    c.dim(
      "\nThe journey may only use the HTTP surface packages/client uses. A step the client has no\n" +
        "method for is recorded as a GAP rather than routed around — see the header comment.",
    ),
  );

  await setup();
  const wsId = await phase0();
  await assignJourneyMembers(wsId);
  const flowId = await phase1Author(wsId);
  const dryExec = await phase2DryRun(wsId, flowId);
  const prod = await phase3ProdRun(wsId, flowId);
  // ⚠ BEFORE phase 4, which revokes the approval and then DELETES the flow. The
  // api receiver starts the APPROVED live revision or nothing, so there is
  // exactly one window in this journey where it can be exercised at all.
  if (prod?.prodExec) await phase3bApiTrigger(wsId, flowId);
  const subject = prod?.prodExec ?? dryExec;
  if (subject) await phase4PostRun(wsId, flowId, subject, prod?.trigId);

  await phase5Hitl(wsId);
  await phase5Retry(wsId);
  await phase5Expectations(wsId);
  await phase5Branch(wsId);
  await phase5ApprovalInbox(wsId);

  const file = writeReport();
  const n = (v: Verdict) => steps.filter((s) => s.verdict === v).length;
  console.log(`\n${"═".repeat(76)}`);
  console.log(
    `${c.ok(`${n("MATCH")} match`)} · ${c.bad(`${n("MISMATCH")} mismatch`)} · ${c.warn(
      `${n("GAP")} gap`,
    )} · ${c.warn(`${n("NOTE")} note`)} · ${c.bad(`${n("FAIL")} fail`)}`,
  );
  console.log(`report   ${path.relative(process.cwd(), file)}`);
  if (hardFails) {
    console.log(c.bad(`\n${hardFails} hard failure(s) — the journey could not complete as intended.`));
    process.exit(1);
  }
  console.log(
    c.dim("\nMISMATCH and GAP do not fail this run. They are the output: read the report."),
  );
  process.exit(0);
}



main().catch((e) => {
  console.error(c.bad(`\ne2e:ui aborted: ${(e as Error).message}`));
  if (steps.length) {
    try {
      console.error(`partial report written to ${writeReport()}`);
    } catch {
      /* the abort matters more than the report */
    }
  }
  process.exit(1);
});

