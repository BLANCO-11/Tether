/**
 * "Test this tool" — one bounded, reported call to a registered or drafted tool.
 * `specs/20260818-123807-tool-probe` · plan Decisions 2–7 · contract §Response
 *
 * ── What this service is FOR, stated as the thing it refuses to do ───────────
 *
 * Onboarding a tool is a form with a URL, a method, an auth style, a parameter
 * name and a secret NAME, and until it is used in a flow nothing checks that any
 * of it is right. The failure that produces is not a red error — it is a green
 * run: WS-B.4 exists because a wrong auth style was *"a 401 the audit called
 * clean"*. So this endpoint's job is to turn "I think this is configured" into a
 * measured sentence, and its hardest constraint is that the sentence must be
 * **true about a run**, not about the probe.
 *
 * Three consequences shape everything below:
 *
 * 1. ⚠ **It does not own a `fetch`.** It calls `dialTool`, the same dial
 *    `invokeTool` uses, on the same egress profile, with the credential resolved
 *    by the same `resolveToolAuth`. A probe that assembles auth its own way
 *    returns green for a tool that 401s in a run, which is the entire bug class
 *    the button exists to remove. Pinned by `tool-invoke-single-dial.test.ts`.
 * 2. ⚠ **An upstream "no" is a SUCCESSFUL probe** (plan Decision 5). A 401 from
 *    the endpoint is HTTP **200** from this route with `verdict:
 *    "auth_rejected"`. Merging "the API said no" into "Foundry could not ask"
 *    recreates precisely the ambiguity `applyAuth`'s 424 exists to remove.
 * 3. ⚠ **Nothing that leaves here can carry a credential** (plan Decision 6).
 *    `urlShown` is built after a `query`-style value is replaced, response
 *    headers are never echoed, and a JSON body goes through `redactJsonString`.
 *
 * ── What it never does ───────────────────────────────────────────────────────
 *
 * No database write of any kind — no row, no column, no migration (FR-010,
 * signed off 2026-08-18). `sampleParams` is not persisted and is not logged. The
 * only trace a probe leaves is the in-process marker in P3.
 */
import { z } from "zod";
import { redactJsonString } from "@foundry/redact";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { createToolSchema } from "./tool.service.js";
import { isPlatformToolName } from "./platform-tool-names.js";
import { dialTool, resolveToolAuth, type ResolvedToolAuth } from "./tool-invoke.js";
import { StepError } from "./step-error.js";
/**
 * The tested marker (P3 · T20) — in its OWN module, and that module's header says
 * why: this service imports `createToolSchema` from `tool.service.ts`, so holding
 * the marker here would make `tool.service.ts`'s read of it a cycle, and the
 * cycle ships as a 500 on every draft probe.
 */
import { setMark } from "./tool-probe-mark.js";

/**
 * ⚠ 10 seconds, and the reason is the caller rather than the endpoint. A person
 * is watching a button. Execution passes NO timeout — Kestra owns a task's
 * deadline — so this number changes nothing about how a flow behaves.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** Contract §Response — a JSON body is redacted then capped; a non-JSON one is only capped. */
const JSON_PREVIEW_MAX = 2048;
const RAW_PREVIEW_MAX = 512;

/** 20 probes per minute per workspace. A dialer behind an API key is still a dialer. */
const RATE_LIMIT_PER_MIN = 20;
const RATE_WINDOW_MS = 60_000;

export type ToolProbeMode = "live" | "reachability";

export type ToolProbeVerdict =
  | "ok"
  | "reachable"
  | "auth_rejected"
  | "forbidden"
  | "not_found"
  | "upstream_error"
  | "client_error"
  | "unreachable"
  | "egress_refused"
  | "timeout";

export interface ToolProbe {
  mode: ToolProbeMode;
  verdict: ToolProbeVerdict;
  /** ⚠ `false` ⇒ the tool's own operation did NOT run. The client must say so. */
  invoked: boolean;
  request: {
    /** What was actually sent — may differ from `toolMethod`. */
    method: string;
    /** What the tool would send in a run. */
    toolMethod: string;
    urlShown: string;
    fellBackToGet: boolean;
    authPresented: { style: string | null; placement: string | null };
  };
  status: number | null;
  statusText: string | null;
  contentType: string | null;
  durationMs: number;
  body: { preview: string; redacted: boolean; truncated: boolean } | null;
  message: string;
  remedy: string | null;
}

/**
 * The draft a form can probe before saving (plan Decision 3).
 *
 * ⚠ **There is no field for a credential VALUE, and adding one is out of
 * contract.** A probe presents what `workspace_secrets` already holds under the
 * named key, or it refuses with the same 424 execution would. A "paste your key
 * to test it" field would be a second, unstored, un-audited credential path into
 * this product, and the tested configuration would not be the one a run uses.
 */
const draftSchema = createToolSchema;

export const probeInputSchema = z
  .object({
    toolId: z.string().uuid().optional(),
    draft: z.unknown().optional(),
    mode: z.enum(["live", "reachability"]).optional(),
    /** ⚠ Live mode only, never persisted, never logged. */
    sampleParams: z.record(z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    const has = (v: unknown) => v !== undefined && v !== null;
    if (has(val.toolId) === has(val.draft)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of toolId or draft is required",
        path: ["toolId"],
      });
    }
  });

export type ToolProbeInput = z.infer<typeof probeInputSchema>;

/**
 * Which mode a method gets by DEFAULT (plan Decision 2).
 *
 * ⚠ The default for a mutating method is `reachability`, and it is a default
 * rather than a prohibition: a `POST` tool can still be probed live, but only
 * because a caller asked for it in as many words. A button that fires a real
 * `POST` because someone clicked "Test" is a button that creates a ticket, sends
 * a message, or charges a card — and "Test" is the least alarming word in the
 * product.
 */
export function defaultModeFor(method: string | null | undefined): ToolProbeMode {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" ? "live" : "reachability";
}

// ── rate limiting ────────────────────────────────────────────────────────────

/**
 * In-process, per workspace. Deliberately not Redis and not a table.
 *
 * ⚠ It is a bound on a dialer, not a security control, and it is honest about
 * that: a multi-container deployment gets N× the limit, which is stated here so
 * nobody reads this as a quota. What it actually prevents is one impatient person
 * (or one loop in a form) turning this endpoint into a scanner — and for that,
 * per-process is enough.
 */
const probeCounts = new Map<string, { windowStartedAt: number; count: number }>();

/** Test seam — the map lives for the life of the process. */
export function resetProbeRateLimit(): void {
  probeCounts.clear();
}

function checkRateLimit(workspaceId: string): void {
  const now = Date.now();
  const entry = probeCounts.get(workspaceId);
  if (!entry || now - entry.windowStartedAt >= RATE_WINDOW_MS) {
    probeCounts.set(workspaceId, { windowStartedAt: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((entry.windowStartedAt + RATE_WINDOW_MS - now) / 1000),
    );
    throw new StepError(`probe rate limit reached for this workspace`, 429, {
      error: "probe_rate_limited",
      retryAfterSec,
    });
  }
}

// ── reporting ────────────────────────────────────────────────────────────────

/**
 * The URL as it may be SHOWN.
 *
 * ⚠ Built from a `URL` this function re-derives, never from the one `dialTool`
 * signed — that one has the credential in it for `query` style. The value is
 * replaced with `[redacted]` rather than dropped, because a person debugging
 * `?api_key=` needs to see that the parameter was sent at all.
 */
function urlShownFor(
  rawUrl: string,
  auth: ResolvedToolAuth,
  params: Record<string, unknown>,
  methodSent: string,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  /**
   * ⚠ **Only the methods that actually carry parameters in the query string.**
   * `dialTool` puts a `GET`/`HEAD`'s params in the URL and every other method's in
   * a JSON body, and this line has to agree with it: a `POST` whose `urlShown`
   * read `…/incidents?title=probe` would be describing a request that was never
   * sent, on the one field the panel prints as *the* record of what went out.
   *
   * ⚠ Latent until the panel could supply sample params at all (tool-probe P2 ·
   * T16) — before that, `params` was `{}` on every path that reached here.
   */
  const carriesQuery = methodSent === "GET" || methodSent === "HEAD";
  for (const [k, v] of Object.entries(carriesQuery ? params : {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  if (auth.style === "query" && auth.paramName) {
    url.searchParams.set(auth.paramName, "[redacted]");
  }
  return decodeURIComponent(url.toString()).replace(/%5Bredacted%5D/gi, "[redacted]");
}

/**
 * A body preview that cannot carry a secret.
 *
 * ⚠ **JSON-ness is decided by PARSING, not by the `content-type` header.**
 * Endpoints mislabel payloads, and a redaction pass skipped because a header said
 * `text/plain` is a leak rather than a formatting problem. When the parse fails,
 * `redacted: false` is reported honestly: key-name redaction has nothing to work
 * on, so the caller is told the preview is raw and it is capped harder (512 vs
 * 2048).
 */
function previewOf(text: string): { preview: string; redacted: boolean; truncated: boolean } | null {
  if (!text) return null;
  let isJson = true;
  try {
    JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    const redactedText = redactJsonString(text);
    return {
      preview: redactedText.slice(0, JSON_PREVIEW_MAX),
      redacted: true,
      truncated: redactedText.length > JSON_PREVIEW_MAX,
    };
  }
  return {
    preview: text.slice(0, RAW_PREVIEW_MAX),
    redacted: false,
    truncated: text.length > RAW_PREVIEW_MAX,
  };
}

/** The status→verdict map. The ONLY place a code becomes a word (contract §Verdicts). */
function verdictForStatus(
  status: number,
  mode: ToolProbeMode,
  authDeclared: boolean,
): ToolProbeVerdict {
  /**
   * ⚠ Reachability answers `reachable` for ANY status the host produced,
   * including a 500. That reads wrong for one second and is right: the question
   * this mode asks is *"is there a host, does it know this path, does the network
   * allow us"*, and a 500 answers all three. Reporting a 500 as a failure here
   * would tell someone their configuration is broken when the endpoint is.
   */
  if (mode === "reachability") return "reachable";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "auth_rejected";
  // A 403 splits on whether we presented anything: with a credential it is a
  // rejection of OUR credential; with none it is an endpoint that needs one.
  if (status === 403) return authDeclared ? "auth_rejected" : "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "upstream_error";
  return "client_error";
}

interface Sentence {
  message: string;
  remedy: string | null;
}

/**
 * One sentence naming the host and the status, plus a remedy ONLY when there is a
 * specific next action.
 *
 * ⚠ **`remedy` is null far more often than not, deliberately.** "Try again" and
 * "check your configuration" are the two things a person reads as noise, and once
 * a field is noise it stops being read on the occasions it says something real.
 */
function sentenceFor(args: {
  verdict: ToolProbeVerdict;
  mode: ToolProbeMode;
  host: string;
  status: number | null;
  statusText: string | null;
  methodSent: string;
  toolMethod: string;
  auth: ResolvedToolAuth;
  detail?: string;
}): Sentence {
  const { verdict, mode, host, status, statusText, methodSent, toolMethod, auth } = args;
  const answered = `it answered ${status}${statusText ? ` ${statusText}` : ""} to ${methodSent}`;
  const placement = auth.placement ?? "no credential";

  switch (verdict) {
    case "ok":
      return {
        message: `Reached ${host} — ${answered}. The call your flow makes is the call that was just made.`,
        remedy: null,
      };
    case "reachable":
      return {
        /**
         * ⚠ The un-sent method is named in the message itself, not left to the
         * client. This is the verdict most likely to be misread as "the tool
         * works", and the sentence has to carry the caveat wherever it is
         * rendered, quoted, or pasted into a ticket.
         */
        message:
          `Reached ${host} — ${answered}. The host knows this path; your ${toolMethod} was NOT sent, ` +
          `so this does not prove the call succeeds.`,
        remedy: null,
      };
    case "auth_rejected": {
      /**
       * ⚠ **Two different sentences, because a 401 with NO credential declared is
       * a different fact from a rejected one** — and the first version had one
       * sentence for both, which produced *"The credential presented as no
       * credential was rejected."* at the wire. Measured on 2026-08-20 against a
       * draft with `authStyle: null` pointed at an endpoint that requires a key.
       *
       * ⚠ The tests did not catch it: every `auth_rejected` case had a credential,
       * and the no-credential case was only covered on 403 (`forbidden`). A 401
       * with nothing presented is an ordinary combination and now has its own case.
       */
      const presented = auth.style !== null && auth.style !== "none";
      return {
        message: presented
          ? `Reached ${host} — ${answered}. The credential presented as ${placement} was rejected.`
          : `Reached ${host} — ${answered}. This tool presents no credential, and the endpoint requires one.`,
        remedy: presented
          ? `Check the auth style (${auth.style}), the ${
              auth.paramName ? `name (${auth.paramName})` : "header name"
            }, and the stored value — the endpoint received a credential and refused it.`
          : `Declare the auth style this endpoint expects and store its value under Credentials, then test again.`,
      };
    }
    case "forbidden":
      return {
        message: `Reached ${host} — ${answered}. This tool presents no credential.`,
        remedy: `The endpoint refused an unauthenticated request. Declare the auth style it expects and store the value under Credentials.`,
      };
    case "not_found":
      return {
        message: `Reached ${host} — ${answered}. The host is there; this PATH is not.`,
        // ⚠ The host resolved, so the remedy is about the path and says so. A
        // "check the URL" that does not distinguish the two halves is the advice
        // that sends someone to look at DNS for an hour.
        remedy: `The hostname resolved and answered, so the problem is the path, not the host or the network.`,
      };
    case "upstream_error":
      return {
        message: `Reached ${host} — ${answered}. The endpoint is reachable and failing.`,
        // Deliberately no remedy: there is no action on this side.
        remedy: null,
      };
    case "client_error":
      return {
        message: `Reached ${host} — ${answered}. The request was rejected as malformed or incomplete.`,
        remedy: `The parameters sent are the ones shown above. Check the tool's registered parameters against what the endpoint expects.`,
      };
    case "timeout":
      return {
        message: `${host} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.`,
        remedy: null,
      };
    case "egress_refused":
      return {
        /**
         * ⚠ Quoted VERBATIM from `guardedFetch`. The classification names the
         * resolved address and the reason ("which is rfc1918"), and paraphrasing
         * it would leave a person unable to match the message to the egress
         * policy that produced it.
         */
        message: `Foundry refused to dial ${host}: ${args.detail ?? "egress policy"}.`,
        remedy: `This is Foundry's egress policy, not the endpoint. A run would refuse the same host for the same reason.`,
      };
    case "unreachable":
      return {
        message: `Could not reach ${host}: ${args.detail ?? "connection failed"}.`,
        remedy: `The host did not answer at all — check the hostname, DNS, and whether the endpoint is reachable from this network.`,
      };
    default: {
      // Exhaustiveness: a new verdict with no sentence is a compile error, not a
      // blank message in the UI.
      const never: never = verdict;
      throw new Error(`unhandled verdict ${String(never)}`);
    }
  }
}

// ── the probe ────────────────────────────────────────────────────────────────

export const toolProbeService = {
  async probe(workspaceId: string, input: ToolProbeInput): Promise<ToolProbe> {
    // 1 — the subject. A saved tool, or a draft validated by the SAME rules the
    // create route uses: a draft that could not be created must not be probeable,
    // or the button would green-light a configuration the form will then refuse.
    let tool: Tool;
    if (input.toolId) {
      const found = await toolRepo.get(workspaceId, input.toolId);
      if (!found) throw new StepError("tool not found in this workspace", 404, { error: "not_found" });
      tool = found;
    } else {
      const parsed = draftSchema.safeParse(input.draft);
      if (!parsed.success) {
        throw new StepError("this draft could not be created, so it cannot be probed", 400, {
          error: "invalid_draft",
          findings: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      /**
       * ⚠ A synthetic row, never inserted. It carries the ids the dial needs and
       * nothing else — `id: ""` is deliberate: the OAuth2 token cache is keyed
       * `(workspaceId, tool.id)`, so a draft cannot poison or read a saved tool's
       * cached token.
       */
      const d = parsed.data;
      tool = {
        id: "",
        workspaceId,
        name: d.name,
        url: d.url ?? null,
        method: d.method ?? "GET",
        description: d.description ?? null,
        paramsSchema: d.paramsSchema ?? null,
        secretEnvName: d.secretEnvName ?? null,
        authStyle: d.authStyle ?? null,
        authParamName: d.authParamName ?? null,
        tokenUrl: d.tokenUrl ?? null,
        clientIdSecretRef: d.clientIdSecretRef ?? null,
        clientSecretSecretRef: d.clientSecretSecretRef ?? null,
        isActive: true,
      } as Tool;
    }

    // 2 — the bound, before anything is resolved or dialled.
    checkRateLimit(workspaceId);

    const toolMethod = (tool.method ?? "GET").toUpperCase();
    const mode: ToolProbeMode = input.mode ?? defaultModeFor(toolMethod);

    /**
     * 3 — platform-managed tools get reachability only (plan Decision 7).
     *
     * ⚠ Two independent reasons, and the second matters more: a live probe of
     * `foundry_email_send` would deliver a REAL email; and it would fail anyway,
     * because that tool points at Foundry's own `/api/mail/send`, which resolves
     * its recipient from the `x-foundry-run` header a probe has no run to supply.
     * A green or red result there would be a statement about the probe, not about
     * the tool.
     */
    if (mode === "live" && isPlatformToolName(tool.name)) {
      throw new StepError(
        `"${tool.name}" is managed by Foundry and cannot be invoked from a test`,
        409,
        { error: "platform_managed_live_probe", name: tool.name },
      );
    }

    // 4 — the credential, resolved exactly as execution resolves it. A 409
    // collision or a 424 missing value propagates as the SAME StepError a run
    // would raise, which is the point: two surfaces, one meaning per number.
    const auth = await resolveToolAuth(workspaceId, tool);

    /**
     * 5 — mode → what is actually sent.
     *
     * ⚠ Reachability sends `HEAD` with NO parameters. It cannot send the tool's
     * own method; that is the invariant the mode exists for, and `invoked` is
     * `false` on this path unconditionally.
     */
    const live = mode === "live";
    const params: Record<string, unknown> = live ? (input.sampleParams ?? {}) : {};
    let methodSent = live ? toolMethod : "HEAD";
    let fellBackToGet = false;

    const host = (() => {
      try {
        return new URL(tool.url ?? "").host;
      } catch {
        return tool.url ?? "the endpoint";
      }
    })();

    const report = (
      verdict: ToolProbeVerdict,
      status: number | null,
      statusText: string | null,
      contentType: string | null,
      durationMs: number,
      body: ToolProbe["body"],
      detail?: string,
    ): ToolProbe => {
      const { message, remedy } = sentenceFor({
        verdict,
        mode,
        host,
        status,
        statusText,
        methodSent,
        toolMethod,
        auth,
        detail,
      });
      /**
       * ⚠ **The marker is written HERE, in the one place a `ToolProbe` is
       * constructed** (P3 · T20) — not at each `return` site. There are five of
       * them (ok, the 405 retry, timeout, egress refusal, network failure), and a
       * marker written at four of them would remember only the outcomes somebody
       * thought of, which reads as "never tested" for exactly the failures worth
       * remembering.
       *
       * ⚠ Saved tools only: a draft's synthesised row carries `id: ""`.
       */
      setMark(workspaceId, tool.id, {
        at: new Date().toISOString(),
        verdict,
        mode,
        status,
      });
      return {
        mode,
        verdict,
        // ⚠ Never true outside live mode, regardless of what happened.
        invoked: live && status !== null,
        request: {
          method: methodSent,
          toolMethod,
          urlShown: urlShownFor(tool.url ?? "", auth, params, methodSent),
          fellBackToGet,
          authPresented: { style: auth.style, placement: auth.placement },
        },
        status,
        statusText,
        contentType,
        durationMs,
        body,
        message,
        remedy,
      };
    };

    try {
      let res = await dialTool({
        tool,
        auth,
        method: methodSent,
        params,
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      /**
       * ⚠ **The 405 fallback happens ONCE, and only in reachability mode.** Many
       * endpoints answer `405` to `HEAD` while serving `GET` on the same path, so
       * a bare HEAD probe would report "unreachable-ish" for a healthy host. One
       * retry with `GET` — never with the tool's own method, which would be the
       * mutating call this mode exists to avoid.
       */
      if (!live && res.status === 405) {
        fellBackToGet = true;
        methodSent = "GET";
        res = await dialTool({
          tool,
          auth,
          method: "GET",
          params: {},
          timeoutMs: PROBE_TIMEOUT_MS,
        });
      }

      const authDeclared = auth.style !== null && auth.style !== "none";
      return report(
        verdictForStatus(res.status, mode, authDeclared),
        res.status,
        res.statusText,
        res.contentType,
        res.durationMs,
        previewOf(res.text),
      );
    } catch (e) {
      // ⚠ A StepError is Foundry refusing to ask — a 409/424/500 the caller must
      // see as a non-200. It is NOT a verdict, and swallowing it into one would
      // report a misconfiguration as an endpoint problem.
      if (e instanceof StepError) throw e;

      const err = e as Error & { name?: string };
      const text = err.message ?? String(e);
      if (text.startsWith("egress_rejected:")) {
        return report("egress_refused", null, null, null, 0, null, text);
      }
      // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; undici
      // also surfaces aborts as `AbortError`.
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return report("timeout", null, null, null, PROBE_TIMEOUT_MS, null, text);
      }
      return report("unreachable", null, null, null, 0, null, text);
    }
  },
};
