/**
 * ops-api's configuration — and, as much as anything, the list of what it is
 * NOT given.
 *
 * There is no `CREDENTIAL_ENC_KEY` here, no `PARENT_API_KEY`, no
 * `TETHER_API_KEY`, no Kestra callback secret and no connection string for
 * `foundry_parent`. That absence is the whole reason this process exists: the
 * tool layer used to run inside the parent, so a bug in a mail handler was a bug
 * in the process holding all of the above. Adding any of them back would undo
 * Stage 5 silently — nothing would break, the boundary would just be gone.
 *
 * The two databases it does reach:
 *
 *  * `OPS_DATABASE_URL` — its own, read-write. Four tables, all synthetic.
 *  * `HR_DATABASE_URL`  — `hr_demo`, and it should be the **read-only** role.
 *    This service serves an HR directory API; it never writes employee data,
 *    and the credential it holds should make that structural rather than
 *    conventional.
 */
import { createHmac } from "node:crypto";

/**
 * The `ops_ro` password, derived from the ops root key.
 *
 * ⚠ Must stay byte-identical to `opsHrRoPassword` in
 * `packages/server/src/services/ops-client.service.ts` — the parent CREATEs the
 * role with this value (`ensureOpsHrRole`) and this process connects with it.
 * The failure mode if they drift is a clean, loud one: every request 500s with
 * `password authentication failed for user "ops_ro"`, naming the role.
 *
 * Derived from `OPS_API_KEY` rather than `CREDENTIAL_ENC_KEY` because this
 * process must never hold the latter — it is the key that decrypts every stored
 * credential in `foundry_parent`.
 */
function opsHrRoPassword(): string {
  return createHmac("sha256", process.env.OPS_API_KEY ?? "ops-dev-key")
    .update("ops-api:hr-ro:v1")
    .digest("hex")
    .slice(0, 32);
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    // Fail at boot with the variable's name. A service that starts and then 500s
    // on every request is strictly worse than one that refuses to start.
    throw new Error(`${name} is required`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4004),

  /** ops-api's own database. Never `foundry_parent` — see `ops-db-init`. */
  databaseUrl: required(
    "OPS_DATABASE_URL",
    "postgres://ops:ops-db-2026@localhost:5433/foundry_ops",
  ),

  /**
   * `hr_demo`, read-only. The directory endpoints' only source of data.
   *
   * Assembled from parts rather than taken as one DSN, because the password is
   * DERIVED (see `opsHrRoPassword` below) and there is nowhere sensible to put a
   * pre-computed HMAC in a compose file. `HR_DATABASE_URL` still overrides the
   * whole thing for a deployment that manages the credential itself.
   */
  hrDatabaseUrl:
    process.env.HR_DATABASE_URL ??
    `postgres://${process.env.OPS_HR_RO_ROLE ?? "ops_ro"}:${opsHrRoPassword()}` +
      `@${process.env.HR_DB_HOST ?? "localhost"}:${process.env.HR_DB_PORT ?? "5433"}` +
      `/${process.env.HR_DB_NAME ?? "hr_demo"}`,

  /**
   * The key every route requires.
   *
   * ⚠ One shared key, exactly like `PARENT_API_KEY` — this is not per-tenant
   * authentication and must never be described as such. What it buys is that the
   * service is not open to anything that can reach port 4004, which is what the
   * old `/stub-api/*` was.
   */
  apiKey: required("OPS_API_KEY", "ops-dev-key"),

  /**
   * Public base URL, used only to render the self-describing index. Tools are
   * registered against this, so it must be reachable from the parent's network.
   */
  publicBase: process.env.OPS_PUBLIC_BASE ?? `http://localhost:${process.env.PORT ?? 4004}`,

  /** Rows kept in `api_call_log` before the oldest are trimmed. */
  logRetention: Number(process.env.OPS_LOG_RETENTION ?? 2000),

  /**
   * The LLM tool — the one thing in this process that talks to the internet.
   *
   * ⚠ READ THIS BEFORE ADDING ANYTHING ELSE OUTBOUND. Every other endpoint here
   * computes an answer from `hr_demo` or writes to a capture table; the worst
   * case of a bug in one is wrong synthetic data. This one holds a **billable
   * credential** and makes a **request to a host outside the stack**, which is a
   * genuine change to what a compromise of ops-api is worth. It was taken
   * deliberately (the alternatives — the control plane, or a seventh service —
   * are worse) and it is bounded rather than trusted:
   *
   *  * the provider host is set by an OPERATOR and never by a caller. A flow
   *    passes `instruction` and `input`; there is no URL parameter, so no caller
   *    can turn this into a general-purpose outbound proxy.
   *  * the model must be on the allowlist. A caller-supplied model string is a
   *    caller-supplied bill.
   *  * input size, output size and calls-per-minute are all capped, because M1
   *    puts one taskrun in front of an array of any length: 500 rows is 500
   *    completions with nothing between them and the invoice.
   *  * the call log records SIZES, never the prompt or the completion. Every
   *    other tool's body is logged (redacted, truncated) and the Outbox page
   *    renders it. An LLM prompt is built from upstream step output and carries
   *    whatever the datasource returned.
   *
   * The values below are FALLBACKS. The live configuration is a row in
   * `llm_provider`, set through the operator surface — see `llm/provider.ts`.
   */
  llm: {
    /** Fallback base URL, OpenAI-compatible (`…/v1`). */
    baseUrl: process.env.LLM_BASE_URL ?? "",
    /** Fallback provider key. Never rendered, never returned by any route. */
    apiKey: process.env.LLM_API_KEY ?? "",
    /** Fallback default and allowlist seed. */
    fastModel: process.env.LLM_FAST_MODEL ?? "",
    reasoningModel: process.env.LLM_REASONING_MODEL ?? "",
    maxInstructionChars: Number(process.env.OPS_LLM_MAX_INSTRUCTION_CHARS ?? 4_000),
    maxInputChars: Number(process.env.OPS_LLM_MAX_INPUT_CHARS ?? 32_000),
    /**
     * The TRANSPORT bound for this one route, and it exists so that
     * `maxInputChars` above is the refusal a caller actually reads.
     *
     * ── Found while implementing step-payload-bounds, 2026-08-19 ─────────────
     *
     * That feature's whole thesis is that a coarse transport cap must never fire
     * where a specific per-parameter cap has something useful to say. It raised
     * Foundry's step-callback cap to 5 MB so that an oversize `llm_complete`
     * input would reach here and get the 422 that names both numbers.
     *
     * It did not, because **ops-api's own `express.json` is 1 MB**, and this
     * service's last-resort handler answered body-parser's 413 as
     * `500 {"code":"internal"}`. So for every input between 1 MB and 5 MB the
     * ladder was broken one hop further along, and worse than before: a 500
     * tells a caller the fault is ours.
     *
     * Default 5,242,880 — deliberately EQUAL to `STEP_CALLBACK_MAX_BYTES`, so
     * anything Foundry is willing to forward, this route is willing to read and
     * then refuse on its own terms. ⚠ Keep the two in step: if Foundry's cap
     * rises above this one, the gap reopens silently and the only symptom is a
     * 413 where a 422 belonged.
     *
     * ⚠ Scoped to `/llm/*` by its own parser mount, NOT a raise of the global
     * 1 MB. The other fourteen tools take small structured bodies and there is no
     * reason to widen them — the same two-limit shape Foundry's `app.ts` uses,
     * and for the same reason.
     */
    maxBodyBytes: Number(process.env.OPS_LLM_MAX_BODY_BYTES ?? 5_242_880),
    /**
     * Default and ceiling for `max_tokens`.
     *
     * A document-sized answer is in scope (a multi-section markdown report is
     * still prose a human reads), so the default cannot be small — but a cap
     * that truncates must FAIL rather than return a half-written document with
     * a 200, the same way the 1 MB fragment-output cap is a named failure
     * (D-20). See the `output_truncated` branch in the handler.
     */
    defaultMaxTokens: Number(process.env.OPS_LLM_DEFAULT_MAX_TOKENS ?? 1_024),
    maxMaxTokens: Number(process.env.OPS_LLM_MAX_OUTPUT_TOKENS ?? 4_096),
    /** Rolling 60-second budget, counted from `api_call_log`. */
    maxCallsPerMinute: Number(process.env.OPS_LLM_MAX_CALLS_PER_MIN ?? 60),
    timeoutMs: Number(process.env.OPS_LLM_TIMEOUT_MS ?? 120_000),
  },
} as const;
