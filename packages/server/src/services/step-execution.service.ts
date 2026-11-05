/**
 * Step handlers — what Foundry does when Kestra calls back.
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.1
 *
 * ── Why these live in Foundry at all (R2, the credential test) ───────────────
 *
 * R2 says maximise Kestra: a step runs in Kestra **iff it needs no tenant
 * credential**. `tool` needs an API key from `workspace_secrets`; `datasource`
 * needs the `foundry_ro` DSN. Kestra OSS secrets are env-var based with no
 * tenant scoping, so those two cannot run there. `transform` and `code` need
 * nothing and therefore do not appear in this file at all.
 *
 * ── M1: every step is ARRAY-SHAPED, from day one ─────────────────────────────
 *
 *   POST /api/steps/tool  { ref, params: [ {...}, {...} ] } → { results: [...] }
 *
 * Each Kestra `ForEach` item is a taskrun, which is a database row. A
 * 10,000-item fan-out means 10,000 taskruns and an unusable step graph.
 * Batching keeps the graph readable — and retrofitting it later means rewriting
 * every flow that exists.
 *
 * ── Partial failure is a WARNING, not a crash ────────────────────────────────
 *
 * The oracle includes one employee with a NULL email and one on a bouncing
 * domain. The worked example (§14 T5) is explicit that the unmailable one must
 * surface "as a `send` warning, not a crash". So a per-item failure yields a
 * per-item result and the step still succeeds; the step fails only when nothing
 * could have worked — unknown ref, missing credential, every item failed.
 */
import { z } from "zod";
import { coerceDeclaredNumbers, coerceNumberColumns, coerceSqlParams, numberColumns } from "./query-row-numbers.js";
import pg from "pg";
import mysql from "mysql2/promise";
import { config } from "../config/index.js";
import { guardedFetch, STRICT } from "@foundry/shared";
import { contractFieldSchema } from "./step-contract.service.js";
import { DRAFT_MAX_TOKENS } from "./inference.service.js";
import { resolveGenerationProvider } from "./generation-provider.service.js";
import { StepError } from "./step-error.js";
import { requiresReadOnlyTransaction } from "./datasource-access-policy.js";
import { dialTool, resolveToolAuth } from "./tool-invoke.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { datasourceQueryRepo, type Datasource } from "../repositories/datasource-query.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { specParamOrder } from "./db-operation.service.js";
import { checkSqlShape } from "./datasource-query.service.js";
import { decrypt } from "../utils/encryptor.js";
import type { ReadFrom } from "./sandbox.service.js";
import { driverFor } from "./mock-engine/registry.js";
import { isSqliteType, sqliteFileService } from "./sqlite-file.service.js";
import { toSqlite, bindValues, type SqliteStatement } from "./sqlite-dialect.js";
import { asFlags, flagColumnsOf, flagResults } from "./introspect/sqlite-flags.js";
import { readSqliteInWorker, SqliteReadTimeoutError, type SqliteReadResult } from "./sqlite-read-worker.js";
import {
  UnsupportedMockEngineError,
  MockEngineWriteRejectedError,
  MockEngineTimeoutError,
  type MockTable,
} from "./mock-engine/types.js";
import { readMockFile, type MockFileTable } from "./mock-file-store.js";
import type { ExecutionEnv } from "./execution-env.service.js";
import { invokePluginTool, isPluginTool } from "./plugin-connector.service.js";
import { actingSubjectForRun, connectionForRun } from "./run-as.service.js";
import { isPersonalTool, mayRunThrough, personalTools } from "./personal-actions.js";

/**
 * ⚠ **`StepError` MOVED to `step-error.ts`** (tool-probe T01) and is re-exported
 * here so every existing importer keeps working — `routes/steps.ts`,
 * `agent-run.service.ts`, `step-execution.test.ts`, `mail-end-to-end.test.ts`.
 * It had to move because `tool-invoke.ts` throws it and this module imports
 * `tool-invoke.ts`: leaving the class here would make that a cycle.
 */
export { StepError } from "./step-error.js";

/** One item's outcome. Positionally aligned with the request's `params[]`. */
export interface StepItemResult {
  ok: boolean;
  /** Present when ok. */
  data?: unknown;
  /** Present when !ok. Never contains a credential — see redaction in tool.service. */
  error?: string;
  /** HTTP status for tool steps; absent for datasource steps. */
  status?: number;
  /**
   * UTF-8 bytes of the response body AS RECEIVED, on every `tool` item.
   *
   * ⚠ Measured on the raw text, before `JSON.parse` — the parsed size is a
   * different number and the one that matters is what crossed the wire and what
   * Kestra will store. Execution `05aca859` is the reason it exists: 7,539,026
   * bytes arrived, every item reported `ok`, and there was no figure anywhere in
   * the product between "the call succeeded" and "the next step's callback was
   * refused". Absent on `datasource` items, whose rows never had a body.
   */
  bytes?: number;
}
export interface StepBatchResult {
  results: StepItemResult[];
  succeeded: number;
  failed: number;
  /** Human-readable notes that are not failures, e.g. a skipped NULL recipient. */
  warnings: string[];
  /**
   * Which database a `datasource` step actually read (Stage 4, D-52). Absent on
   * `tool` steps, which have no such choice.
   *
   * ⚠ Reported on EVERY batch, including the ordinary `production` case. A field
   * that appears only when something is unusual is a field nobody builds a
   * habit of reading — and the reading that matters here is the boring one: a
   * test run that says `production` is a test run that just sent tenant rows
   * downstream, possibly to a model.
   */
  readFrom?: ReadFrom;
  /**
   * True only on the explicit production opt-in path (draft + admin `useProductionData`).
   * Absent/undefined everywhere else — a draft batch reading production without
   * this flag is a bug, not a fallback.
   */
  usedProductionData?: boolean;
}

export const stepBatchSchema = z.object({
  /**
   * `<tool-name>` for tool steps; `<datasource-name>.<query-name>` for
   * datasource steps; `<datasource-name>.<operation-name>` for query steps
   * (DB operations). All three resolve server-side, per workspace.
   */
  ref: z.string().min(1).max(512),
  /**
   * Frozen step SQL (mock-data plan): the human-approved statement, carried
   * verbatim from the compiled flow. When present the executor runs exactly
   * this text (through `checkSqlShape`) instead of the stored ref text.
   * Absent means legacy: the stored named-query/operation text.
   */
  sql: z.string().min(1).max(64000).optional(),
  /**
   * Explicit datasource address. When absent the executor falls back to the
   * `<datasource>.` prefix of `ref`.
   */
  datasourceRef: z.string().min(1).max(128).optional(),
  /**
   * The binding for a step-local `sql` with no stored reader behind it.
   *
   * ⚠ **Accepted from the compiled flow, and it does NOT weaken the shape
   * gate.** `checkSqlShape(sql, order, paramsSchema)` still runs here on every
   * execution — these only supply the `order`/`paramsSchema` a stored row would
   * have supplied, so the SAME check sees a complete picture instead of an
   * empty one. Without them a step-local statement carrying `$1` is refused
   * with `placeholder_mismatch`; with them it is checked exactly as a saved
   * query's is. A statement that writes is still refused either way.
   */
  sqlParamOrder: z.array(z.string().min(1).max(64)).max(32).optional(),
  sqlParamsSchema: z.record(z.unknown()).optional(),
  /**
   * One entry per invocation. An empty object is valid — a query with no
   * parameters still needs exactly one entry to produce exactly one result.
   *
   * An empty ARRAY is also valid, and deliberately so. A screening run in a month
   * where nobody fell below the bar produces zero emails, and that is a correct
   * outcome, not an error. `.min(1)` here rejected it with a 400 and failed the
   * whole execution — a flow that works in a bad month and breaks in a good one.
   * Found by running the same three flows at a second period; see I-09.
   */
  params: z.array(z.record(z.unknown())).max(1000),
  /**
   * Caller-supplied values beyond the endpoint schema (a tool step's
   * `extraInputs`; the compiler emits the array inline). Merged into every
   * params object below; last wins.
   */
  extraParams: z
    .array(z.object({ name: z.string(), value: z.unknown(), description: z.string().optional() }))
    .max(32)
    .optional(),
  /** Kestra correlation, for the flow_step_runs pointer. */
  stepId: z.string().max(255).optional(),
  taskrunId: z.string().max(255).optional(),
});
export type StepBatchInput = z.infer<typeof stepBatchSchema>;
 /**
  * Merge a step's `extraParams` (named caller-supplied values) into EVERY
  * params object — they are per-step constants, not per-item data; last wins
  * on collision. A non-object params item cannot take named values: that is a
  * shape conflict, refused rather than guessed through.
  */
 export function mergeExtraParams(
   params: Record<string, unknown>[],
   list: Array<{ name: string; value?: unknown }> | undefined,
 ): Record<string, unknown>[] {
   if (list === undefined || list.length === 0) return params;
   const extra: Record<string, unknown> = {};
   for (const p of list) {
     if (typeof p !== "object" || p === null || typeof p.name !== "string") {
       throw new StepError("every extraParams entry needs a string name", 400);
     }
     extra[p.name] = p.value ?? "";
   }
   return params.map((item) => {
     if (typeof item !== "object" || item === null || Array.isArray(item)) {
       throw new StepError(
         "this step declares extra inputs but its params are not objects — remove the extras or reshape the params",
         400,
       );
     }
     return { ...item, ...extra };
   });
 }

// ── tool steps ───────────────────────────────────────────────────────────────

/**
 * ⚠ **SIX BLOCKS MOVED OUT to `tool-invoke.ts`** (tool-probe T02/T03): `applyAuth`,
 * the OAuth2 token cache and its exchange, `resetOAuth2TokenCache`, the
 * shadowed-secret collision refusal, the decrypt, the GET-params-vs-JSON-body
 * rule and the `guardedFetch` call.
 *
 * They moved because the "Test this tool" button is a second caller, and the
 * alternative — a `fetch` in the probe service — is the bug class that button
 * exists to remove: a probe presenting a credential differently from execution
 * returns green for a tool that 401s in a run. `tool-invoke-single-dial.test.ts`
 * pins that there is exactly one tool dial in this server.
 *
 * ⚠ **What stayed here is STEP semantics**, and none of it changed: `EMPTY_BATCH`,
 * per-item results, the partial-failure warning, the all-failed 502, the
 * `x-foundry-run` correlation header, and `step-payload-bounds`' response-size
 * measurement and its two warnings.
 *
 * ⚠ `resetOAuth2TokenCache` is RE-EXPORTED below, not re-implemented — the cache
 * has one home. `step-execution.test.ts` imports it from here and must not have
 * to change.
 */
export { resetOAuth2TokenCache } from "./tool-invoke.js";

/** The all-failed message, with the first failing call's reason (cut to 500 chars) when it has one. */
function allFailedMessage(toolName: string, failed: number, results: StepItemResult[]): string {
  const base = `tool "${toolName}": all ${failed} call(s) failed`;
  const reason = results.find((r) => !r.ok && r.error)?.error;
  return reason ? `${base} — ${reason.slice(0, 500)}` : base;
}


/**
 * How many entries the biggest array in a payload has, or `null` when there is
 * no array in it at all.
 *
 * ⚠ **Mechanical, and `null` means the clause is OMITTED** — never guessed, never
 * an estimate of "rows" (contract §3a). The temptation is to say something like
 * *"about 4,700 rows"* for a payload with no array in it, and a figure an
 * operator cannot reproduce from the response is worse than no figure: the
 * warning's whole job is to be checkable against what the endpoint returned.
 *
 * One level deep on purpose. An array payload is its own length; an object
 * payload is the longest of its array-valued properties, which is the
 * `{count, data:[…]}` shape every paged endpoint in this deployment returns.
 * Recursing would find a bigger number somewhere in a nested structure and lose
 * the property that a person can point at the field it came from.
 */
function largestArrayEntries(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    let longest: number | null = null;
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && (longest === null || value.length > longest)) {
        longest = value.length;
      }
    }
    return longest;
  }
  return null;
}
/**
 * ── The two remarks a tool step makes about ITS OWN payload ─────────────────
 *
 * ⚠ **Extracted so that BOTH exits can say them** — the normal return, and the
 * all-failed `502`. It used to sit inline below the `throw`, which meant the one
 * run that most needed the second sentence was the one run that never got it: a
 * batch where every call failed threw first, and *"declares no parameters, so
 * `period` was sent … and the endpoint is free to ignore it"* — the sentence that
 * would have ended execution `05aca859`'s investigation in five seconds — was
 * built after the throw and thrown away with the rest of the function.
 *
 * ⚠ **One function, two call sites, so the two exits cannot drift.** The
 * alternative was moving the block above the `throw`, which would have made the
 * failing path and the succeeding path two separate pieces of prose about the same
 * payload — and the failing one would be the copy nobody reads until it is wrong.
 *
 * ⚠ Neither remark fails the step and neither truncates anything (plan Decision
 * 6). A tool that answers a lot is not a tool that answered wrongly, and the only
 * honest place to decide 7 MB is too much is the step that has to pass it on —
 * which has its own limit and its own message. Refusing here would break every
 * flow whose fragment legitimately reads a large payload, and Kestra hands a
 * fragment its input as a file with no ceiling at all.
 *
 * ⚠ **One warning per condition per STEP, never per item.** A 200-item batch
 * against an undeclared-params tool would otherwise produce 200 identical
 * sentences, and the warnings array becomes the oversize payload it is
 * complaining about (contract §3).
 */
function payloadRemarks(args: {
  toolName: string;
  paramsSchema: unknown;
  method: string;
  results: StepItemResult[];
  sentParams: Array<Record<string, unknown>>;
}): string[] {
  const { toolName, paramsSchema, method, results, sentParams } = args;
  const out: string[] = [];

  /**
   * §3a — the size remark, about the LARGEST single response in the batch.
   *
   * ⚠ Measured on failures too, and deliberately: a 500 that answers with a
   * megabyte of HTML is exactly the payload that breaks the next step, and it is
   * the all-failed path this function was extracted to reach.
   */
  const largest = results.reduce<{ bytes: number; data: unknown } | null>(
    (worst, r) =>
      (r.bytes ?? 0) > (worst?.bytes ?? 0) ? { bytes: r.bytes ?? 0, data: r.data } : worst,
    null,
  );
  if (largest && largest.bytes > config.tools.responseWarnBytes) {
    const entries = largestArrayEntries(largest.data);
    out.push(
      `${toolName} returned ${largest.bytes.toLocaleString("en-US")} bytes` +
        (entries === null
          ? ""
          : `; its largest array has ${entries.toLocaleString("en-US")} entries`) +
        `. Kestra stores this in the execution record, and any step that passes it on whole ` +
        `will exceed its own limit.`,
    );
  }

  /**
   * §3b — ⚠ **The sentence that would have ended execution `05aca859`'s
   * investigation in five seconds.** `BTO_tool.params_schema` was NULL, so the
   * drafter invented a `period` parameter, the step sent it, and the endpoint
   * silently ignored it and returned all 4,722 rows of all time. Every layer
   * behaved correctly and nothing anywhere said that the filter had no effect.
   *
   * ⚠ **Parameter NAMES only, never values.** A value can be tenant data, and
   * this string is written into a step's warnings, which are stored and rendered.
   */
  const declaresNothing =
    paramsSchema === null ||
    paramsSchema === undefined ||
    (typeof paramsSchema === "object" && Object.keys(paramsSchema as object).length === 0);
  if (declaresNothing) {
    const sentKeys = [...new Set(sentParams.flatMap((p) => Object.keys(p)))];
    if (sentKeys.length > 0) {
      out.push(
        `${toolName} declares no parameters, so ${sentKeys.map((k) => `\`${k}\``).join(", ")} ` +
          `${sentKeys.length === 1 ? "was" : "were"} sent ` +
          `${method === "GET" || method === "HEAD" ? "as a query parameter" : "in the JSON body"} ` +
          `and the endpoint is free to ignore ${sentKeys.length === 1 ? "it" : "them"}. Register ` +
          `the parameters it accepts so a flow can narrow the read.`,
      );
    }
  }

  return out;
}

/**
 * An empty batch is a valid no-op.
 *
 * Returned BEFORE the tool/query is resolved and before any credential is
 * decrypted: with nothing to call there is nothing to authorise, and doing the
 * lookup anyway would make "zero work" fail for reasons unrelated to the work.
 */
const EMPTY_BATCH: StepBatchResult = { results: [], succeeded: 0, failed: 0, warnings: [] };

/**
 * Plugins POC — a tool backed by an Activepieces piece (`plugin-connector.service.ts`). Same result envelope and the
 * same all-failed rule as an HTTP tool; a call a test run captured says so in `warnings`, so "the run went green" is
 * never read as "the email/ticket/upload happened".
 */
async function invokePlugin(
  workspaceId: string,
  tool: Awaited<ReturnType<typeof toolRepo.listByWorkspace>>[number],
  params: Array<Record<string, unknown>>,
  runId?: string,
  /** For a personal action: the person the run acts for. Its call goes only through their own connection. */
  personalFor?: string | null,
): Promise<StepBatchResult> {
  // Whose account: the connection the run's workflow was approved to act as, re-checked now (plugins 8.6).
  let use: Awaited<ReturnType<typeof connectionForRun>> = {};
  if (runId) {
    try {
      use = await connectionForRun(workspaceId, runId, tool);
    } catch (e) {
      throw new StepError(`tool "${tool.name}": ${(e as Error).message}`, (e as { statusCode?: number }).statusCode ?? 409);
    }
  }
  // ⚠ A personal action never runs through anything but its person's own connection — not the workspace's, whatever
  // the run-as choice for the service says.
  if (isPersonalTool(tool)) {
    const secret = use.secretName ?? tool.secretEnvName ?? "";
    const ok = await mayRunThrough(workspaceId, tool, secret, personalFor ?? null);
    if (ok !== true) throw new StepError(`tool "${tool.name}": not called — ${ok}. Choose the person's own connection for this service on the workflow's page.`, 403);
    use = { secretName: secret, actingSubject: personalFor ?? null };
  }
  const { results } = await invokePluginTool(workspaceId, tool, params, runId, use.secretName ? { secretName: use.secretName, actingSubject: use.actingSubject } : {});
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0 && failed === results.length) {
    throw new StepError(allFailedMessage(tool.name, failed, results), 502, { results });
  }
  const warnings: string[] = [];
  if (failed > 0) warnings.push(`${failed} of ${results.length} call(s) to "${tool.name}" failed`);
  const captured = results.filter((r) => r.captured).length;
  if (captured > 0) warnings.push(`${captured} call(s) to "${tool.name}" were recorded, not performed (a test run does not change anything outside Foundry)`);
  return {
    results: results.map(({ captured: _c, ...r }) => r),
    succeeded: results.length - failed,
    failed,
    warnings,
  };
}

async function invokeTool(
  workspaceId: string,
  input: StepBatchInput,
  /**
   * Which execution is making the call — platform-coherence Phase 7.2, I-110.
   *
   * ⚠ Sent as `x-foundry-run` so ops-api's `api_call_log` can say WHICH run
   * made a call. That log is the only evidence in this product that an
   * automation actually did something — the answer to "the run went green, but
   * did it do anything?" — and putting it on a run page needed the calls of
   * that run, exactly. Correlating by timestamp was the alternative and is the
   * wrong kind of wrong: on an instance where harnesses run concurrently it
   * attributes another run's emails to the one on screen, plausibly.
   *
   * ⚠ It is a FOUNDRY execution id, which is already the identifier a client
   * addresses a run by (R5) — not a Kestra one, which is the id R5 exists to
   * keep out of a client's hands. It travels to whatever endpoint the tool
   * names; that endpoint is registered by the tenant whose run it is.
   */
  runId?: string,
 ): Promise<StepBatchResult> {
  const params = mergeExtraParams(input.params, input.extraParams);
  if (params.length === 0) return EMPTY_BATCH;
  const tools = await toolRepo.listByWorkspace(workspaceId);
  const tool = tools.find((t) => t.name === input.ref);
  // Not on for the workspace: an action the run's person switched on for THEMSELVES (plans/personal-actions-2026-10-29)
  // — the workflow's owner on a live run, the tester on a test. Built fresh, so an action switched off is refused now.
  if ((!tool || tool.isActive === false) && runId) {
    const { subject } = await actingSubjectForRun(workspaceId, runId);
    const own = (await personalTools(workspaceId, subject)).find((t) => t.name === input.ref);
    if (own) return invokePlugin(workspaceId, own, params, runId, subject);
  }
  if (!tool) {
    // Names the alternatives. A bare "unknown tool" wastes a redraft cycle when
    // this reaches the LLM through the validator (§6.4).
    throw new StepError(
      `unknown tool "${input.ref}" in this workspace`,
      404,
      { available: tools.filter((t) => t.isActive !== false).map((t) => t.name).sort() },
    );
  }
  if (tool.isActive === false) throw new StepError(`tool "${tool.name}" is not active`, 409);
  if (isPluginTool(tool)) return invokePlugin(workspaceId, tool, params, runId);
  if (!tool.url) throw new StepError(`tool "${tool.name}" has no URL`, 500);

  /**
   * Resolve the credential ONCE for the batch, not per item — the collision
   * refusal, the decrypt and the OAuth2 exchange all live in `resolveToolAuth`
   * now (tool-probe T02).
   *
   * ⚠ It **throws** rather than producing per-item failures, and that is the
   * pre-existing semantics preserved: a credential problem is systemic, every
   * item would fail identically, and failing the step routes it to the USER
   * (§6.9) instead of burning three fragment regenerations on it.
   */
  const auth = await resolveToolAuth(workspaceId, tool);

  const method = (tool.method ?? "GET").toUpperCase();
  const results: StepItemResult[] = [];
  const warnings: string[] = [];

  for (const item of params) {
    try {
      /**
       * ⚠ **No `timeoutMs`.** Execution passes nothing, so a flow's tool call
       * behaves exactly as it did before `dialTool` existed — Kestra owns a
       * task's timeout. The probe is the caller that passes one.
       */
      const res = await dialTool({
        tool,
        auth,
        method,
        params: coerceDeclaredNumbers(item, tool.paramsSchema as Record<string, unknown> | null),
        runId,
      });
      let parsed: unknown = res.text;
      try {
        parsed = res.text ? JSON.parse(res.text) : null;
      } catch {
        /* leave as text */
      }
      const ok = res.status >= 200 && res.status < 300;
      if (ok) {
        results.push({ ok: true, data: parsed, status: res.status, bytes: res.bytes });
      } else {
        // ⚠ `bytes` on the failure branch too. An endpoint that answers 500 with
        // a megabyte of HTML is a thing that happens, and it is the same fact
        // about the same call.
        results.push({
          ok: false,
          error: `HTTP ${res.status}`,
          status: res.status,
          data: parsed,
          bytes: res.bytes,
        });
      }
    } catch (e) {
      /**
       * ⚠ A `StepError` from `dialTool` is SYSTEMIC and must not be caught into a
       * per-item failure. `applyAuth`'s 424 (a declared credential with no stored
       * value) fires identically for every item, and swallowing it here would turn
       * one honest "you have not configured this" into N network-looking failures
       * and then an all-failed 502 — a misconfiguration reported as a broken
       * endpoint. This rethrow is what preserves the pre-extraction behaviour,
       * where `applyAuth` was called OUTSIDE the per-item try.
       */
      if (e instanceof StepError) throw e;
      results.push({ ok: false, error: (e as Error).message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const remarks = payloadRemarks({
    toolName: tool.name,
    paramsSchema: tool.paramsSchema,
    method,
    results,
    sentParams: params,
  });
  if (failed > 0 && failed === results.length) {
    /**
     * Every item failed. Not a partial-failure warning — something is wrong with
     * the tool, not with individual inputs.
     *
     * ⚠ **`warnings` is ADDED to the detail; `results` is untouched.** The
     * alternative asked for was moving the remarks block above this throw, which
     * changes what the succeeding path does as well. This carries the remarks on
     * the one exit that was silently dropping them — chiefly *"declares no
     * parameters"*, which is the likeliest explanation of a batch where every
     * call failed — while leaving the field a caller reads to decide what is safe
     * to retry exactly as it was. `steps.ts` and `step-execution.test.ts` pin that
     * shape; a new key beside it is additive, a changed `results` is not.
     */
    throw new StepError(
      allFailedMessage(tool.name, failed, results),
      502,
      { results, ...(remarks.length > 0 ? { warnings: remarks } : {}) },
    );
  }
  if (failed > 0) {
    warnings.push(`${failed} of ${results.length} call(s) to "${tool.name}" failed`);
  }

  // ⚠ The SAME strings the 502 above carries — one implementation, so the two
  // exits cannot come to describe the same payload differently.
  warnings.push(...remarks);

  return { results, succeeded: results.length - failed, failed, warnings };
}

// ── datasource steps ─────────────────────────────────────────────────────────

/** SQL-bindable scalar. */
type SqlValue = string | number | boolean | Date | null;

/**
 * Coerce a step param to something a driver can bind.
 *
 * Objects and arrays are JSON-stringified rather than passed through: `pg`
 * would accept them (and silently produce a `json` literal), `mysql2` would
 * reject them at the type level, and the two behaving differently for the same
 * flow is precisely the shape-assumption bug the `hr_demo_alt` rehearsal exists
 * to catch. One explicit rule, both drivers.
 */
function toSqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  return JSON.stringify(v);
}

/**
 * Execute one parameterized SQL batch against a datasource — the shared read
 * path for `datasource` and `query` steps.
 *
 * ── The two decisions, and where they are NOT made ───────────────────────────
 *
 * `env` comes from `envForExecution()`, which reads the execution row's Kestra
 * namespace. It is not in `stepBatchSchema`, so the flow cannot send it; it is
 * not a header, so the engine cannot set it; and there is no argument that
 * overrides it. `routes/steps.ts` is the only caller.
 *
 * `useProdOverride` comes from the execution ROW (`flow_executions
 * .use_prod_override`, written by `begin` from the test run's explicit opt-in).
 * `routes/steps.ts` reads it off the row — never off the request body — so a
 * flow cannot opt itself into production. Live runs ignore it unconditionally.
 *
 * ── A draft run reads mock, never production, unless opted in ────────────────
 *
 * A draft run with no override reads the READY mock fixture through the
 * datasource type's mock engine (`readFrom: "mock"`). A missing,
 * still-building or failed mock is a hard refusal with reason — the D-52
 * warn-and-read-prod fallback it replaces is deleted, not kept beside it. A
 * fallback that reads production is the exposure, and keeping it around "for
 * compatibility" would keep the exposure for every caller that never opts in.
 */
export interface SqlRunOptions {
  /** The workspace, for server-side ref resolution and fixture reads. */
  workspaceId: string;
  /**
   * Per-run production opt-in, row-carried from `begin`. Honoured on draft
   * runs only; live runs ignore it (asserted by test).
   */
  useProdOverride?: boolean;
}

async function runSqlBatch(
  input: StepBatchInput,
  env: ExecutionEnv,
  noun: "query" | "operation",
  datasource: Datasource,
  sql: string,
  order: string[],
  opts: SqlRunOptions,
  paramsSchema: Record<string, unknown> = {},
): Promise<StepBatchResult> {
  const dsName = input.datasourceRef ?? input.ref.slice(0, input.ref.indexOf("."));

  // ── The shape gate, on BOTH paths ──────────────────────────────────────────
  //
  // Stored text passed this at save time; frozen text passed it at build. It
  // runs again here because neither of those facts travels with the request —
  // the executor sees a string, and a string that writes is refused before it
  // executes, wherever it came from. `checkSqlShape` itself is unchanged.
  // A param declared as a number is sent as one, on every path below (phase 7, L1).
  // A declared array reaches `= ANY($n)` as a Postgres array (phase 7, R03).
  input = { ...input, params: input.params.map((p) => coerceSqlParams(p, paramsSchema)) };
  const shapeProblems = checkSqlShape(sql, order, paramsSchema);
  if (shapeProblems.length > 0) {
    throw new StepError(
      `${noun} "${input.ref}" is refused: the statement failed the read-only shape check: ` +
        shapeProblems.map((p) => p.message).join("; "),
      400,
    );
  }

  // ── Live reads production. Always. The override is not consulted ───────────
  if (env === "live") {
    return runProdBatch(input, noun, datasource, sql, order, dsName, false);
  }

  // ── Draft with an explicit, admin-gated opt-in reads production ────────────
  //
  // The audit event for this is recorded where the person is known (the
  // test-run / try-step request), not here — a step callback carries an
  // execution token, not an identity. What travels with the RESULT is the
  // flag: `usedProductionData: true` beside `readFrom: "production"`.
  if (opts.useProdOverride === true) {
    return runProdBatch(input, noun, datasource, sql, order, dsName, true);
  }

  // ── Draft without opt-in reads the mock, or refuses ────────────────────────
  return runMockBatch(input, noun, datasource, sql, order, dsName, opts.workspaceId);
}

/**
 * The production read — live runs, and draft runs with an explicit opt-in.
 *
 * The DSN is decrypted here and nowhere else in the request path. It is never
 * returned, never logged, and never reaches Kestra (R2). The mock path never
 * reaches this function, so a mock read cannot decrypt the credential —
 * asserted by test, not by inspection.
 */
async function runProdBatch(
  input: StepBatchInput,
  noun: "query" | "operation",
  datasource: Datasource,
  sql: string,
  order: string[],
  dsName: string,
  usedProductionData: boolean,
): Promise<StepBatchResult> {
  if (!datasource.connectionStringEnc) {
    throw new StepError(
      `datasource "${dsName}" has no linked production credential, so this run cannot read production. ` +
        `Attach a credential to the datasource first.`,
      409,
    );
  }
  // ── Stage 4: which database ────────────────────────────────────────────────
  //
  // The DSN is decrypted here and nowhere else in the request path. It is never
  // returned, never logged, and never reaches Kestra (R2).
  const results: StepItemResult[] = [];
  const warnings: string[] = [];
  const readFrom: ReadFrom = "production";
  const dsn = decrypt(datasource.connectionStringEnc);

  if (usedProductionData) {
    // ⚠ Loud, and the wording is the point: someone reading a test run needs
    // to know that rows just left the tenant's database — and that if a later
    // step is an `agent` or an `llm_complete`, they left the building.
    warnings.push(
      `"${dsName}" was read from PRODUCTION on this draft run by explicit opt-in. ` +
        `A green result here ran against live tenant rows, not mock data.`,
    );
  }
  /**
   * ── ⚠ THE ACCESS POLICY, AND THIS IS WHERE IT IS ENFORCED ─────────────────
   *
   * `datasources.access_policy` says what this datasource may do. On a `read`
   * datasource every statement runs inside `BEGIN READ ONLY`, and **Postgres
   * refuses the write itself** — `cannot execute INSERT in a read-only
   * transaction` — regardless of what the role is granted, up to and including
   * a superuser.
   *
   * ⚠ **That is the whole reason registration stopped refusing a write-capable
   * credential** (2026-09-17). The old gate asked the credential to be narrow,
   * which a tenant whose only login is an administrator cannot arrange; this
   * stops the statement instead, so the same admin credential is safe on a
   * `read` datasource. **Remove this and `access_policy` becomes a label** — a
   * screen saying read-only with nothing making it true, which is the
   * `faFallback` shape applied to a security boundary.
   *
   * ⚠ It is read from the STORED ROW, never from anything in the request —
   * the same rule as `readFrom`/`envForExecution` (D-52). There is no field on
   * `stepBatchSchema` that could reach it, so a caller cannot ask for a wider
   * policy than the one recorded.
   *
   * ⚠ And it fails CLOSED: `requiresReadOnlyTransaction` treats any
   * unrecognised or null value as `read`, so a row written by a newer build, a
   * migration or a hand edit gets the narrowest policy rather than the widest.
   */
  const readOnlyTx = requiresReadOnlyTransaction(
    (datasource as { accessPolicy?: unknown }).accessPolicy,
  );

  if (datasource.type === "postgres") {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      // ⚠ One transaction around the whole batch, opened BEFORE the first
      // statement. Per-statement would leave the first one unprotected on any
      // path that returns early, and a batch is one step's work — a partial
      // batch that wrote half its rows is the state the gate exists to prevent.
      if (readOnlyTx) await client.query("BEGIN READ ONLY");
      // Both kinds are PARAMETERISED, never interpolated: `order` maps a
      // declared name to a positional placeholder, so a step param cannot
      // become SQL no matter what it contains.
      for (const params of input.params) {
        const values = order.map((name) => toSqlValue(params[name]));
        try {
          const r = await client.query(sql, values);
          results.push({ ok: true, data: coerceNumberColumns(r.rows, numberColumns(r.fields, "pg")) });
        } catch (e) {
          results.push({ ok: false, error: (e as Error).message });
          // ⚠ A failed statement poisons a Postgres transaction: every later
          // query answers "current transaction is aborted". Without this the
          // first bad row would turn the rest of the batch into one repeated
          // error that says nothing about the rows themselves — and that
          // symptom would only appear once the read-only transaction existed,
          // i.e. it would look like the policy breaking the step.
          if (readOnlyTx) await client.query("ROLLBACK").catch(() => {});
          if (readOnlyTx) await client.query("BEGIN READ ONLY").catch(() => {});
        }
      }
      // ⚠ COMMIT on a read-only transaction writes nothing; it closes it. The
      // rollback is in `finally` via `end()` for any path that throws.
      if (readOnlyTx) await client.query("COMMIT").catch(() => {});
    } finally {
      await client.end().catch(() => {});
    }
  } else if (datasource.type === "mysql") {
    const conn = await mysql.createConnection(dsn);
    try {
      // ⚠ MySQL's spelling is different and the effect is the same: a
      // `START TRANSACTION READ ONLY` refuses INSERT/UPDATE/DELETE/DDL at the
      // server. Spelled out here rather than shared with the Postgres branch —
      // the two drivers, their error shapes and their transaction semantics
      // differ, and one "run this in read-only mode" helper over both would be
      // a single name for two things that fail differently.
      if (readOnlyTx) await conn.query("START TRANSACTION READ ONLY");
      for (const params of input.params) {
        const values = order.map((name) => toSqlValue(params[name]));
        try {
          const [rows, fields] = await conn.execute(sql, values);
          results.push({
            ok: true,
            data: Array.isArray(rows)
              ? coerceNumberColumns(rows as Record<string, unknown>[], numberColumns(fields as never, "mysql"))
              : rows,
          });
        } catch (e) {
          results.push({ ok: false, error: (e as Error).message });
          // MySQL does not poison a transaction the way Postgres does, so a
          // failed statement needs no restart — but a read-only transaction
          // left open would hold a snapshot for the rest of the batch.
        }
      }
      if (readOnlyTx) await conn.query("COMMIT").catch(() => {});
    } finally {
      await conn.end().catch(() => {});
    }
  } else if (isSqliteType(datasource.type)) {
    /**
     * ⚠ A SQLite datasource is an uploaded FILE, opened `readOnly` whatever
     * `access_policy` says — the engine refuses a write itself (`attempt to
     * write a readonly database`), which is this branch's `BEGIN READ ONLY`.
     * `datasource.service.ts` only lets a sqlite row be `read` in the first
     * place, because a write to a snapshot copy would vanish silently.
     *
     * The statement is translated once, before the batch; a Postgres spelling
     * with no faithful SQLite form is a refusal naming it (`sqlite-dialect.ts`),
     * never a best-effort rewrite that could return a wrong answer green.
     */
    let stmt: SqliteStatement;
    try {
      stmt = toSqlite(sql);
    } catch (e) {
      throw new StepError(`${noun} "${input.ref}" cannot run on SQLite: ${(e as Error).message}`, 400);
    }
    // ⚠ In a worker thread, never here: node:sqlite is synchronous, and a large read on the main thread froze the
    // whole server until it finished (`sqlite-read-worker.ts`).
    let read: SqliteReadResult;
    try {
      read = await readSqliteInWorker({
        path: await sqliteFileService.pathFor(dsn),
        sql: stmt.sql,
        bindings: input.params.map((params) => bindValues(stmt, order.map((name) => toSqlValue(params[name])))),
        timeoutMs: config.sqliteReadTimeoutMs,
      });
    } catch (e) {
      if (e instanceof SqliteReadTimeoutError) throw new StepError(`${noun} "${input.ref}": ${e.message}`, 504);
      throw new StepError(`${noun} "${input.ref}" cannot run on SQLite: ${(e as Error).message}`, 400);
    }
    // A column the schema declares true/false comes back 1/0 from SQLite — returned as the true/false its type says it is.
    const flagged = flagResults(read.origins, flagColumnsOf(read.schema));
    for (const r of read.results) {
      results.push(r.ok ? { ok: true, data: r.rows.map((row) => asFlags(row, flagged)) } : { ok: false, error: r.error });
    }
  } else {
    throw new StepError(`datasource type "${datasource.type}" is not supported by step execution`, 501);
  }

  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0 && failed === results.length) {
    const first = results[0]?.error ?? "";
    // A privilege refusal is the expected shape of a script trying to write
    // through a read-only DSN. Say so, or it reads as a broken connection —
    // the same explanation execution.service.ts appends to stderr.
    const hint = /permission denied|InsufficientPrivilege|read-?only/i.test(first)
      ? " (the datasource credential is read-only by design; a write cannot succeed here)"
      : "";
    throw new StepError(
      `${noun} "${input.ref}" (read from ${readFrom}): all ${failed} execution(s) failed${hint}`,
      502,
      { results, readFrom, ...(usedProductionData ? { usedProductionData: true as const } : {}) },
    );
  }
  if (failed > 0) warnings.push(`${failed} of ${results.length} execution(s) of "${input.ref}" failed`);

  return {
    results,
    succeeded: results.length - failed,
    failed,
    warnings,
    readFrom,
    ...(usedProductionData ? { usedProductionData: true as const } : {}),
  };
}

/**
 * The mock read — draft runs without opt-in.
 *
 * Loads the datasource's READY fixture (`datasource_fixtures.rows_json`,
 * authoritative; the JSON file is a derived cache and is never read here)
 * into the datasource type's mock engine and runs the step SQL through it.
 * The production DSN is never decrypted on this path.
 *
 * Anything else is a hard refusal with reason, never a production read:
 * no fixture row, a still-building row, a failed row, an unknown engine
 * type, or a statement the engine itself refuses.
 */
async function runMockBatch(
  input: StepBatchInput,
  noun: "query" | "operation",
  datasource: Datasource,
  sql: string,
  order: string[],
  dsName: string,
  workspaceId: string,
): Promise<StepBatchResult> {
  const fixture = await datasourceFixtureRepo.latest(datasource.id);
  if (!fixture) {
    throw new StepError(
      `"${dsName}" has no mock data — this draft run is refused rather than reading production. ` +
        `Re-onboard the datasource (or rebuild its mock) and run again.`,
      409,
    );
  }
  if (fixture.mockStatus === "building") {
    throw new StepError(
      `"${dsName}" mock data is still building — this draft run is refused rather than reading production. ` +
        `Wait for the build, then run again.`,
      409,
    );
  }
  if (fixture.mockStatus !== "ready") {
    // "failed" — the only other status the CHECK allows. Named explicitly so
    // a future status cannot fall through silently.
    throw new StepError(
      `"${dsName}" mock build failed${fixture.mockError ? `: ${fixture.mockError}` : ""} — this draft run ` +
        `is refused rather than reading production. Rebuild the mock and run again.`,
      409,
    );
  }

  let driver;
  try {
    driver = driverFor(datasource.type);
  } catch (e) {
    if (e instanceof UnsupportedMockEngineError) {
      throw new StepError(e.message, 501);
    }
    throw e;
  }

  /**
   * ⚠ **THE SHAPE IS READ, NOT GUESSED — 2026-09-18.**
   *
   * This used to build the engine's tables from `rows_json` alone and type every
   * column from its JSON VALUES. `rows_json` is JSONB, so a timestamp arrives as
   * a string, and every timestamp, date, uuid and varchar column in the mock was
   * created `TEXT`. Measured on one live fixture: **266 of 667 columns mistyped**,
   * of which 114 were date/time. The reported symptom was
   * `operator does not exist: text >= timestamp without time zone` — a flow that
   * ran against production and died against its own mock.
   *
   * ⚠ **Only the loud half was ever visible.** A date comparison errors; a
   * `sort_by` over text-shaped timestamps silently orders lexicographically and
   * the run settles SUCCESS. The engine's own `inferColumnType` had a `Date`
   * branch that could never fire, because nothing survives JSONB as a `Date`.
   *
   * The declared types already existed in two places this path ignored — the
   * fixture's `ddl_sql` and the mock file, which `mock-file-store` writes from
   * `c.sqlType`. The file is the one that is keyed by fingerprint, so it is the
   * one that can prove it describes THIS fixture; `readMockFile` refuses a
   * missing, corrupt, misfiled or stale file rather than serving one.
   *
   * ⚠ **A missing shape REFUSES, and does not fall back to guessing.** That is
   * the same rule as the three `mockStatus` refusals above: a draft run that
   * cannot be given the right answer is refused rather than given a wrong one,
   * and it never reads production instead. The cost is that a fixture built
   * before this needs one rebuild, which is the button on the datasource page.
   */
  let declared: MockFileTable[];
  try {
    const file = await readMockFile(
      workspaceId,
      datasource.id,
      fixture.version,
      fixture.schemaFingerprint,
    );
    declared = file.tables;
  } catch (e) {
    throw new StepError(
      `"${dsName}" mock data does not declare its column types (${(e as Error).message}) — this draft run ` +
        `is refused rather than guessing them from the stored rows, and rather than reading production. ` +
        `Rebuild the mock and run again.`,
      409,
    );
  }

  const tables = mockTablesFromFixture(
    dsName,
    declared,
    (fixture.rowsJson as Record<string, Array<Record<string, unknown>>>) ?? {},
  );
  let handle = await driver.prepare(workspaceId, datasource.id, fixture.schemaFingerprint, tables);
  try {
    const results: StepItemResult[] = [];
    for (const params of input.params) {
      const values = order.map((name) => toSqlValue(params[name]));
      try {
        const r = await driver.query(handle, sql, values as unknown[]);
        results.push({ ok: true, data: r.rows });
      } catch (e) {
        if (e instanceof MockEngineWriteRejectedError) {
          throw new StepError(`${noun} "${input.ref}" is refused: ${e.message}`, 400, {
            readFrom: "mock" as const,
          });
        }
        if (e instanceof MockEngineTimeoutError) {
          // A timed-out handle is dead (SliceE) — later uses throw
          // already-destroyed. Re-prepare once and retry the row; a second
          // timeout is recorded like any other item failure.
          await driver.destroy(handle).catch(() => {});
          handle = await driver.prepare(workspaceId, datasource.id, fixture.schemaFingerprint, tables);
          try {
            const r = await driver.query(handle, sql, values as unknown[]);
            results.push({ ok: true, data: r.rows });
          } catch (e2) {
            if (e2 instanceof MockEngineWriteRejectedError) {
              throw new StepError(`${noun} "${input.ref}" is refused: ${e2.message}`, 400, {
                readFrom: "mock" as const,
              });
            }
            results.push({ ok: false, error: (e2 as Error).message });
          }
          continue;
        }
        results.push({ ok: false, error: (e as Error).message });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0 && failed === results.length) {
      const first = results[0]?.error ?? "";
      throw new StepError(
        `${noun} "${input.ref}" (read from mock): all ${failed} execution(s) failed: ${first}`,
        502,
        { results, readFrom: "mock" as const },
      );
    }
    const warnings: string[] = [
      `"${dsName}" was read from MOCK data (fixture v${fixture.version}), not from the tenant's database. ` +
        `A green result here means the flow executes and agrees with the fixture; it does not mean it is ` +
        `correct against production.`,
    ];
    if (failed > 0) warnings.push(`${failed} of ${results.length} execution(s) of "${input.ref}" failed`);
    return { results, succeeded: results.length - failed, failed, warnings, readFrom: "mock" };
  } finally {
    // Teardown on success AND failure — a leaked engine per step is how a
    // long draft session eats the process (staging/promote/drop pattern).
    await driver.destroy(handle).catch(() => {});
  }
}

/**
 * The DECLARED shape plus the stored rows, as engine tables.
 *
 * ⚠ **Two sources, and each is authoritative for a different half.** The mock
 * FILE declares the structure — which tables exist, which columns they have and
 * what type each column is — because it is the only artefact that records
 * `sqlType`, and `readMockFile` has already proven it is the projection of this
 * exact fixtures version by fingerprint. `datasource_fixtures.rows_json` remains
 * authoritative for the ROWS, which is what `mock-file-store`'s own docblock
 * says; nothing here reads the file's copy of them.
 *
 * ⚠ **A declared table with no rows is still CREATED.** It used to be absent
 * entirely, so a correct query touching an empty table died with
 * `relation "x" does not exist` — a structural error for what is really an empty
 * result. Creating it empty answers zero rows, which is the truth.
 *
 * The engine takes bare table names, so the key's schema qualifier is dropped —
 * `public.users` and a frozen `FROM users` meet on `users`. Two keys collapsing
 * onto one bare name is a refusal, not a last-wins: silently answering from the
 * wrong schema's rows as the other's is the failure this path exists to prevent.
 *
 * ⚠ **Every disagreement between the two halves is a refusal**, because they are
 * written by one function (`fileTablesFor`) from one `SandboxShape` and verified
 * to share a fingerprint. A row set with no declared table, or a row key with no
 * declared column, means one of them is not what it claims to be — and the shape
 * of that failure is precisely the bug above: a column the engine does not know
 * the type of.
 */
export function mockTablesFromFixture(
  dsName: string,
  declared: MockFileTable[],
  rowsJson: Record<string, Array<Record<string, unknown>>>,
): MockTable[] {
  const tables: MockTable[] = [];
  const seen = new Map<string, string>();
  const used = new Set<string>();

  for (const t of declared) {
    const key = t.name;
    const bare = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
    const clash = seen.get(bare);
    if (clash !== undefined) {
      throw new StepError(
        `mock fixture for "${dsName}" names "${clash}" and "${key}", which both load as table "${bare}" — ` +
          `this draft run is refused rather than answering from one schema's rows as the other's.`,
        409,
      );
    }
    seen.set(bare, key);
    used.add(key);

    const columns = t.columns.map((c) => ({ name: c.name, type: c.type }));
    const known = new Set(columns.map((c) => c.name));
    const rows = rowsJson[key] ?? [];
    for (const row of rows) {
      for (const name of Object.keys(row)) {
        if (known.has(name)) continue;
        throw new StepError(
          `mock fixture for "${dsName}" has rows for "${key}" carrying a column "${name}" that its declared ` +
            `shape does not name — this draft run is refused rather than loading a column whose type is ` +
            `unknown. Rebuild the mock and run again.`,
          409,
        );
      }
    }
    tables.push({ name: bare, columns, rows });
  }

  for (const key of Object.keys(rowsJson ?? {})) {
    if (used.has(key)) continue;
    throw new StepError(
      `mock fixture for "${dsName}" has rows for "${key}", which its declared shape does not name — this ` +
        `draft run is refused rather than loading a table whose column types are unknown. Rebuild the mock ` +
        `and run again.`,
      409,
    );
  }
  return tables;
}

/**
 * Run a named query — mock on a draft run, production on a live one.
 *
 * The stage-4 decision (which database, `readFrom`) lives in `runSqlBatch`,
 * shared with `runOperation` — a query step and an operation step are the same
 * read through different doors, and two copies of driver code is where a
 * mysql/postgres asymmetry would live a second time (see `toSqlValue`).
 *
 * Frozen SQL (`input.sql`, carried from the compiled flow) replaces the stored
 * text but NOT the stored address: the datasource still resolves server-side
 * per workspace, and the stored row — when the ref still names one — still
 * supplies the parameter order and descriptors the shape check binds against.
 */
async function runNamedQuery(
  workspaceId: string,
  input: StepBatchInput,
  env: ExecutionEnv = "live",
  opts?: SqlRunOptions,
): Promise<StepBatchResult> {
  // No `readFrom` here, and that is the accurate answer rather than a gap: zero
  // invocations means no database was opened, so naming one would be a claim
  // about a connection that was never made.
  if (input.params.length === 0) return EMPTY_BATCH;
  const dot = input.ref.indexOf(".");
  if (dot <= 0 || dot === input.ref.length - 1) {
    throw new StepError(
      `datasource ref must be "<datasource>.<query>", got "${input.ref}"`,
      400,
    );
  }
  const dsName = input.datasourceRef ?? input.ref.slice(0, dot);
  const qName = input.ref.slice(dot + 1);

  const stored = await datasourceQueryRepo.resolveRef(workspaceId, input.ref.slice(0, dot), qName);
  const frozenSql = input.sql;
  let datasource: Datasource | undefined;
  if (input.datasourceRef) {
    // Explicit address wins; the stored row (when the ref still names one)
    // only supplies order and descriptors below.
    datasource = (await datasourceRepo.getByName(workspaceId, dsName)) ?? stored?.datasource;
  } else {
    datasource = stored?.datasource;
  }
  if (!datasource) {
    if (frozenSql != null) {
      throw new StepError(`unknown datasource "${dsName}"`, 404);
    }
    const available = (await datasourceQueryRepo.listByWorkspace(workspaceId))
      .map((r) => `${r.datasource.name}.${r.query.name}`)
      .sort();
    throw new StepError(`unknown datasource query "${input.ref}"`, 404, { available });
  }
  if (!stored && frozenSql == null) {
    const available = (await datasourceQueryRepo.listByWorkspace(workspaceId))
      .map((r) => `${r.datasource.name}.${r.query.name}`)
      .sort();
    throw new StepError(`unknown datasource query "${input.ref}"`, 404, { available });
  }
  const sql = frozenSql ?? stored!.query.sqlText;
  // @see `runOperation` — the stored row is authoritative when there is one;
  // a step-local statement with no stored row declares its own binding, and
  // absent that `checkSqlShape` refuses any `$n` rather than binding nothing.
  const order = stored?.query.paramOrder ?? input.sqlParamOrder ?? [];
  const paramsSchema =
    (stored?.query.paramsSchema as Record<string, unknown> | null) ??
    input.sqlParamsSchema ??
    {};

  return runSqlBatch(
    input,
    env,
    "query",
    datasource,
    sql,
    order,
    { workspaceId, useProdOverride: opts?.useProdOverride },
    paramsSchema,
  );
}

// ── operation steps ──────────────────────────────────────────────────────────

/**
 * Run a DB operation — mock on a draft run, production on a live one.
 *
 * An operation is a saved, read-only component: its `compiled_sql` was COMPILED
 * server-side from the visual spec at save time — identifiers resolved against
 * the introspected schema, never raw-interpolated, and `checkSqlShape` refused
 * anything that was not a single read-only SELECT — so execution is the same
 * parameterized read as a named query. The differences from `runNamedQuery` are
 * only where the SQL came from and how params map to positions:
 *
 *   * the ref grammar is identical (`<datasource>.<operation>`), resolved
 *     through the same tenancy boundary;
 *   * positional order is the spec's encounter order (`specParamOrder`:
 *     laterals, then filters, then having), never the stored `params_schema`
 *     keys — Postgres jsonb reorders object keys, so reading the map back
 *     would silently renumber `$1..$n`.
 */
async function runOperation(
  workspaceId: string,
  input: StepBatchInput,
  env: ExecutionEnv = "live",
  opts?: SqlRunOptions,
): Promise<StepBatchResult> {
  if (input.params.length === 0) return EMPTY_BATCH;
  const found = await dbOperationRepo.getByRef(workspaceId, input.ref);
  const frozenSql = input.sql;
  if (!found && frozenSql == null) {
    const available = (await dbOperationRepo.listByWorkspace(workspaceId))
      .map((r) => `${r.datasource.name}.${r.operation.name}`)
      .sort();
    throw new StepError(`unknown operation "${input.ref}"`, 404, { available });
  }
  let datasource: Datasource | undefined = found?.datasource;
  if (input.datasourceRef) {
    datasource = (await datasourceRepo.getByName(workspaceId, input.datasourceRef)) ?? datasource;
  }
  if (!datasource) {
    throw new StepError(`unknown datasource "${input.datasourceRef ?? input.ref}"`, 404);
  }
  // Frozen SQL replaces the compiled text but not the spec encounter order —
  // see `runNamedQuery` for why the stored row still supplies the binding.
  // A stored row's spec is authoritative when there is one — frozen text
  // replaces the SQL, never the binding (see `runNamedQuery`). With NO stored
  // row the step is the only thing that can say how its placeholders bind, so
  // its own declaration is used; absent, the empty defaults stand and
  // `checkSqlShape` refuses any `$n` rather than binding it to nothing.
  const order = found ? specParamOrder(found.operation.specJson) : (input.sqlParamOrder ?? []);
  const paramsSchema =
    (found?.operation.paramsSchema as Record<string, unknown> | null) ??
    input.sqlParamsSchema ??
    {};
  const sql = frozenSql ?? found!.operation.compiledSql;

  return runSqlBatch(
    input,
    env,
    "operation",
    datasource,
    sql,
    order,
    { workspaceId, useProdOverride: opts?.useProdOverride },
    paramsSchema,
  );
}

// ── llm steps (Stage 4.1) ────────────────────────────────────────────────────

/**
 * ⚠ **The THIRD sender, with its own copy and its own test** — `inference.service.ts`
 * says exactly this must happen rather than sharing a module: generation
 * inference (fragments/drafts) and runtime inference (a tenant's step) share a
 * provider and nothing else (D-35). This sender carries a STEP's model and
 * sampling params — values the generation sender must never see — so it dials
 * the gateway itself, in this file, where the step's tenancy already lives.
 */
const llmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  text: z.string().min(1).max(32000),
});

export const llmStepBodySchema = z.object({
  ref: z.string().max(64).optional(),
  stepId: z.string().max(255).optional(),
  taskrunId: z.string().max(255).optional(),
  params: z.object({
    model: z.string().min(1).max(128),
    temperature: z.number().min(0).max(1),
    topP: z.number().min(0).max(1),
    frequencyPenalty: z.number(),
    presencePenalty: z.number(),
    messages: z.array(llmMessageSchema).min(1).max(32),
    outputFields: z.array(contractFieldSchema).max(32).optional(),
    contextStepId: z.string().max(63).nullable().optional(),
  }),
});

export type LlmStepBody = z.infer<typeof llmStepBodySchema>;

/** What `POST /api/steps/llm` answers — the envelope the registry's ports read. */
export interface LlmEnvelope {
  text: string;
  reasoning_content: string | null;
  /** The model that actually answered — the requested one, or the deployment fallback (§2.2). */
  model: string;
  [field: string]: unknown;
}

/**
 * ⚠ Verbatim the `inference.service.ts:218-219` rule, own copy by that file's
 * decree (no shared module): the retry fires only when the provider NAMES
 * `temperature` in a 400, never on the status alone.
 */
function rejectsTemperature(status: number, body: string): boolean {
  return status === 400 && /temperature/i.test(body);
}

/** Process-lifetime temperature memory — see the note at its use in `invokeLlm`. */
let llmTemperatureRejected = false;

/** Test seam — resets the process-lifetime temperature memory between cases. */
export function resetLlmTemperatureMemory(): void {
  llmTemperatureRejected = false;
}

async function invokeLlm(
  workspaceId: string,
  body: LlmStepBody,
  runId?: string,
): Promise<LlmEnvelope> {
  void workspaceId;
  const p = body.params;
  const fields = p.outputFields ?? [];
  const prompt = [
    ...p.messages.map((m) => `${m.role.toUpperCase()}: ${m.text}`),
    ...(fields.length
      ? [
          `Answer with a single JSON object with exactly these keys: ` +
            `${fields.map((f) => `"${f.name}"`).join(", ")}. ` +
            `Put the full prose answer in "text". No markdown fences, no commentary.`,
        ]
      : []),
  ].join("\n\n");
  // The step's own sampling params travel as authored — no silent
  // renormalisation: they are structure (hashed), so what runs must be what
  // was approved. No `response_format`: not every gateway honours it, and a
  // refusal there would fail steps whose prompt already constrains the shape.
  //
  // ⚠ Two adaptations ride on that authored body, each firing ONCE per failure
  // kind and never speculatively. `temperature` is stripped only when the
  // provider names it in a 400 (the verbatim `inference.service.ts` rule, own
  // copy and own test by that file's decree); an unserved model falls back to
  // the deployment's resolved model, and the substitution is stated in `text`.
  const send = (withTemperature: boolean, model: string) =>
    fetch(`${config.inference.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.inference.apiKey}`,
        ...(runId ? { "x-foundry-run": runId } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        ...(withTemperature ? { temperature: p.temperature } : {}),
        top_p: p.topP,
        frequency_penalty: p.frequencyPenalty,
        presence_penalty: p.presencePenalty,
        max_tokens: DRAFT_MAX_TOKENS,
        stream: false,
      }),
    });
  const who = `llm step "${body.stepId ?? "llm"}"`;
  let res: Response;
  let text: string;
  // ⚠ The model that actually answered — the requested one unless the 404
  // fallback below replaces it. The step RECORD keeps the requested model (the
  // route stores the request body); only this envelope names the substitute.
  let servedModel = p.model;
  // ⚠ Process-lifetime, like `temperatureRejected` in `inference.service.ts`:
  // a model that rejects `temperature` rejects it on every call, so one retry
  // pays for the knowledge and the rest of the process sends the second body
  // first. A model that accepts it never sets this and is byte-identical.
  try {
    res = await send(!llmTemperatureRejected, p.model);
    text = await res.text();
    if (!llmTemperatureRejected && rejectsTemperature(res.status, text)) {
      llmTemperatureRejected = true;
      console.warn(
        `[llm-step] ${p.model} rejected temperature ${p.temperature} — retrying without it, ` +
          `and omitting it for the rest of this process (${who}). ${text.slice(0, 200)}`,
      );
      res = await send(false, p.model);
      text = await res.text();
    }
    // ⚠ 404 means the deployment does not serve the requested model. Retry
    // once with the deployment's own resolved model — tenancy and config both
    // come from that row (`routes/steps.ts`), never the request body. A second
    // failure throws the ORIGINAL 404, so the reason a person sees names the
    // model that was asked for, not the fallback's failure.
    if (!res.ok && res.status === 404) {
      let fallback: string | null = null;
      try {
        fallback = (await resolveGenerationProvider()).model;
      } catch {
        fallback = null;
      }
      if (fallback && fallback !== p.model) {
        let fb = await send(!llmTemperatureRejected, fallback);
        let fbText = await fb.text();
        if (!llmTemperatureRejected && rejectsTemperature(fb.status, fbText)) {
          llmTemperatureRejected = true;
          console.warn(
            `[llm-step] ${fallback} rejected temperature ${p.temperature} — retrying without it, ` +
              `and omitting it for the rest of this process (${who}). ${fbText.slice(0, 200)}`,
          );
          fb = await send(false, fallback);
          fbText = await fb.text();
        }
        if (fb.ok) {
          res = fb;
          text = fbText;
          servedModel = fallback;
        }
      }
    }
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(`${who}: gateway request failed: ${(e as Error).message}`, 502);
  }
  if (!res.ok) {
    throw new StepError(`${who}: gateway returned HTTP ${res.status}`, 502, { status: res.status });
  }
  let data: { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new StepError(`llm step "${body.stepId ?? "llm"}": gateway returned a non-JSON body`, 502);
  }
  const message = data.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) {
    throw new StepError(`llm step "${body.stepId ?? "llm"}": gateway returned no message content`, 502);
  }
  const reasoning =
    typeof message?.reasoning_content === "string" && message.reasoning_content
      ? message.reasoning_content
      : null;
  // Structured output is BEST-EFFORT, never a refusal: the model was asked for
  // JSON with the declared keys, and when it complies the fields ride beside
  // `text`; when it answers prose, the prose IS the answer and downstream
  // reads `.text`. Refusing prose here would turn a working step into a
  // contract negotiation with a model.
  let parsed: Record<string, unknown> | null = null;
  if (fields.length) {
    try {
      const v: unknown = JSON.parse(content);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  // ⚠ The substitution is stated, never silent: the builder's last-run surface
  // renders this text, so the person debugging sees which model answered and
  // which one the deployment does not serve. One computed sentence, appended —
  // the answer itself is untouched and `model` names the serving model.
  const substitutionNote =
    servedModel !== p.model ? `\n\nanswered by ${servedModel} — the deployment does not serve ${p.model}` : "";
  if (!parsed)
    return { text: content + substitutionNote, reasoning_content: reasoning, model: servedModel };
  const out: LlmEnvelope = {
    text:
      (typeof parsed["text"] === "string" ? (parsed["text"] as string) : content) + substitutionNote,
    reasoning_content:
      typeof parsed["reasoning_content"] === "string" ? (parsed["reasoning_content"] as string) : reasoning,
    model: servedModel,
  };
  for (const f of fields) {
    if (
      f.name !== "text" &&
      f.name !== "reasoning_content" &&
      f.name !== "model" &&
      parsed[f.name] !== undefined
    ) {
      out[f.name] = parsed[f.name];
    }
  }
  return out;
}

// ── http steps (Stage 4.2) ───────────────────────────────────────────────────

const httpHeaderSchema = z.object({ name: z.string().min(1).max(128), value: z.string().max(8000) });

export const httpStepBodySchema = z.object({
  stepId: z.string().max(255).optional(),
  taskrunId: z.string().max(255).optional(),
  params: z.object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().min(1).max(8000),
    headers: z.array(httpHeaderSchema).max(64),
    queryParams: z.array(httpHeaderSchema).max(64),
    body: z.object({
      kind: z.enum(["none", "json", "form", "binary", "raw"]),
      content: z.string().max(8000),
      contentType: z.string().max(256).optional(),
      fileVar: z.string().max(128).optional(),
    }),
    auth: z.object({
      kind: z.enum(["none", "api-key", "basic", "bearer", "custom"]),
      headerName: z.string().max(128).optional(),
      secretRef: z.string().max(128).optional(),
    }),
    timeouts: z
      .object({
        connectMs: z.number().int().min(1).optional(),
        readMs: z.number().int().min(1).optional(),
        writeMs: z.number().int().min(1).optional(),
      })
      .nullable()
      .optional(),
    sslVerify: z.boolean(),
  }),
});

export type HttpStepBody = z.infer<typeof httpStepBodySchema>;

/** What `POST /api/steps/http` answers — the envelope the registry's ports read. */
export interface HttpEnvelope {
  body: unknown;
  status_code: number;
  headers: Record<string, string>;
  size: number;
}

async function invokeHttp(
  workspaceId: string,
  body: HttpStepBody,
  runId?: string,
): Promise<HttpEnvelope> {
  void workspaceId;
  const p = body.params;
  const who = `http step "${body.stepId ?? "http"}"`;
  // TLS verification off is a deployment posture, not a per-request flag:
  // Node's fetch cannot scope it to one dial, so accepting it here would
  // silently dial verified anyway (a lie) or flip it globally (a hazard).
  // Refused loudly instead.
  if (p.sslVerify === false) {
    throw new StepError(
      `${who}: sslVerify:false is not supported by the step runtime — terminate TLS at a trusted endpoint`,
      400,
    );
  }
  if (p.body.kind === "binary") {
    // Wave 1 declares no `files` output and wires no file plumbing end to end.
    throw new StepError(`${who}: binary bodies are not supported in wave 1`, 400);
  }
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    throw new StepError(`${who} has a malformed url`, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StepError(`${who} url must be http(s)`, 400);
  }
  for (const q of p.queryParams) url.searchParams.append(q.name, q.value);
  const headers: Record<string, string> = {};
  for (const h of p.headers) headers[h.name] = h.value;
  // The credential: `secretRef` names an environment variable whose VALUE is
  // read here, server-side, and never logged — only the NAME travels in the
  // compiled YAML and in any error below.
  if (p.auth.kind !== "none") {
    const ref = p.auth.secretRef?.trim() ?? "";
    if (!ref) throw new StepError(`${who} declares ${p.auth.kind} auth but names no secretRef`, 400);
    const secret = process.env[ref];
    if (!secret) {
      throw new StepError(
        `${who} names secret "${ref}", which is not set in this server's environment`,
        424,
      );
    }
    // The env value holds the ready-to-send credential: a bearer token, a
    // base64 `user:pass` pair, or an API key. `custom` names its own header;
    // `api-key` defaults to `X-API-Key` when none is named.
    if (p.auth.kind === "custom" && !p.auth.headerName?.trim()) {
      throw new StepError(`${who} declares custom auth but names no headerName`, 400);
    }
    const headerName =
      p.auth.kind === "bearer" || p.auth.kind === "basic"
        ? "Authorization"
        : p.auth.headerName?.trim() || "X-API-Key";
    headers[headerName] =
      p.auth.kind === "bearer" ? `Bearer ${secret}` : p.auth.kind === "basic" ? `Basic ${secret}` : secret;
  }
  let reqBody: string | undefined;
  if (p.body.kind !== "none" && p.method !== "GET" && p.method !== "HEAD") {
    reqBody = p.body.content;
    const lower = Object.keys(headers).map((k) => k.toLowerCase());
    if (!lower.includes("content-type")) {
      headers["Content-Type"] =
        p.body.contentType?.trim() ||
        (p.body.kind === "json"
          ? "application/json"
          : p.body.kind === "form"
            ? "application/x-www-form-urlencoded"
            : "text/plain");
    }
  }
  if (runId) headers["x-foundry-run"] = runId;
  // STRICT fails closed on unresolvable hosts: at dial time a resolver failure
  // is indistinguishable from one being made to fail. `guardedFetch`
  // re-classifies immediately before dialing (it narrows, not closes, the
  // rebinding window — see its own docblock).
  let res: Response;
  try {
    res = await guardedFetch(url, {
      method: p.method,
      headers,
      ...(reqBody !== undefined ? { body: reqBody } : {}),
      signal: AbortSignal.timeout(p.timeouts?.readMs ?? p.timeouts?.writeMs ?? 30_000),
    }, STRICT);
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(`${who}: dial failed: ${(e as Error).message}`, 502);
  }
  const raw = await res.text();
  const size = Buffer.byteLength(raw, "utf8");
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });
  // A non-2xx status throws rather than riding the envelope: Kestra retries a
  // failed task (both kinds are RETRYABLE), and a 503 answered as data would
  // never be retried. The status and size travel in the detail; the body does
  // not — it is tenant data of unbounded size.
  if (!res.ok) {
    throw new StepError(`${who}: ${p.method} ${url.hostname} answered HTTP ${res.status}`, res.status, {
      status_code: res.status,
      size,
    });
  }
  return { body: parsed, status_code: res.status, headers: resHeaders, size };
}
export const stepExecutionService = {
  tool: invokeTool,
  datasource: runNamedQuery,
  operation: runOperation,
  llm: invokeLlm,
  http: invokeHttp,
};
