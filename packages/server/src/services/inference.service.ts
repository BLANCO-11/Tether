import { config } from "../config/index.js";
import { usageContext } from "./usage-context.js";
import { usageService } from "./usage.service.js";
import { gatewayHeaders } from "./llm-gateway-headers.js";

/**
 * One prompt in, one text answer out.
 * archive/kestra-migration/04-generation-model.md §5.3
 *
 * ── Why this seam exists at all ──────────────────────────────────────────────
 *
 * Everything Foundry generates now goes through exactly two calls with very
 * different shapes: ONE draft call that sees the automation's goal and the
 * manifest, and N fragment calls that see a step contract and nothing else.
 * The whole value of the second shape is what it CANNOT see, and "cannot" has
 * to survive contact with the transport — not just with the prompt builder.
 *
 * Hence an interface rather than a direct runtime call at each call site:
 *
 *  1. **Statelessness is enforced here, once.** `complete()` has no `sessionId`
 *     parameter, so no caller can reuse a session even by accident (D-23). It is
 *     now free rather than defended — a completion carries no history at all —
 *     but the parameter must not come back: a session carries its history, so
 *     fragment B's context would contain fragment A's code and the isolation
 *     `buildFragmentPrompt` exists to guarantee would be defeated *downstream of
 *     the prompt*, where no prompt test would ever see it.
 *  2. **Call COUNT becomes observable.** Assertion 18 is *"three `code` steps
 *     produce three separate inference calls"* and assertion 19 is *"regenerate
 *     B and A and C stay byte-identical"*. Both are statements about calls, not
 *     about output, so both are checkable only if something countable sits
 *     between the generator and the model. A recording client in a test counts
 *     them and diffs the prompts.
 *  3. An agent runtime is not a completion API — and the second
 *     implementation this note anticipated is now the ONLY one. See
 *     `GatewayInference`, and 1.8's note below on why the fallback is gone.
 */
export interface InferenceClient {
  /**
   * @param label      Human-readable, for logs and for a test's transcript. Never
   *                   sent to the model — it would be a channel for exactly the
   *                   cross-step context the fragment prompt excludes.
   * @param maxTokens  The OUTPUT budget, and the two callers need different ones.
   *                   A fragment is one Python function; a draft is a whole flow,
   *                   and a flow at the 64-step cap is several times longer. One
   *                   shared ceiling meant a large draft ran to the limit and was
   *                   discarded whole — ~118 s of decode for nothing. See
   *                   `DRAFT_MAX_TOKENS`.
   */
  complete(
    prompt: string,
    opts: {
      label: string;
      timeoutMs?: number;
      maxTokens?: number;
      /**
       * Per-call model override (per-flow chat config, Phase 5). Absent means
       * today's resolved default — `generation-provider.service.ts` untouched —
       * so every existing caller behaves byte-identically.
       */
      model?: string;
      /**
       * Stable instruction block (S7): tools, boundaries, refusal channel —
       * sent once as a `system` message, never repeated inside the prompt.
       * Absent means today's single-user-message body, byte-identical.
       */
      system?: string;
      /** OpenCode Go's x-opencode-session: a stable conversation id (chat id, run id). Absent = a fresh uuid per call. Ignored by other gateways. */
      sessionId?: string;
      /**
       * Strict structured output (compiled-builder D-307): sent as `response_format: {type: "json_schema", strict: true}`, so
       * the gateway decodes only replies the schema admits (E0.1: 6/6 features enforced). The caller still validates the reply
       * against the same schema (`strict-schema.ts`); a mismatch is a gateway defect, never a retry.
       */
      schema?: { name: string; schema: Record<string, unknown> };
    },
  ): Promise<string>;
}

/**
 * The output ceiling for ONE FRAGMENT — a Python function body.
 * Measured: real fragments land at a few hundred tokens.
 */
export const FRAGMENT_MAX_TOKENS = 4096;

/**
 * The output ceiling for a WHOLE DRAFT, and the number is derived rather than
 * picked. Measured on `google/gemma-4-26B-A4B-it`: a 9-to-12-step flow costs
 * 900–1,200 completion tokens, so ~100 per step; `FLOW_CAPS.steps` is 64.
 *
 * ⚠ It is a real trade and worth stating. Truncation is a TOTAL loss — the
 * answer is discarded, nothing is salvaged, and `draftFlow` does not re-ask,
 * because an inference failure is infrastructure rather than a bad draft. A
 * runaway model, on the other hand, now decodes for longer before failing. The
 * measured frequencies decide it: one truncation in six observed drafts, and the
 * six normal ones never came within 3× of the old ceiling — so the ceiling was
 * only ever reached by an answer that was still going somewhere.
 */
export const DRAFT_MAX_TOKENS = 8192;

/**
 * A generation call made while serving a person's request is building cost (P-OBS), recorded against them, their
 * workspace and the flow in the path — with the gateway's own `x-litellm-response-cost`. Outside a request (a harness,
 * a background job) there is nobody to attribute it to, and it is not recorded.
 */
function recordGenerationUsage(json: unknown, res: Response, model: string, durationMs: number): void {
  const ctx = usageContext.getStore();
  if (!ctx) return;
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } }).usage;
  const cost = Number(res.headers?.get?.("x-litellm-response-cost"));
  usageService.record({
    workspaceId: ctx.workspaceId,
    purpose: "building",
    kind: "llm",
    source: "generation",
    actor: ctx.actor,
    subject: ctx.subject,
    flowId: ctx.flowId,
    model,
    tokensIn: u?.prompt_tokens,
    tokensOut: u?.completion_tokens,
    tokensCached: u?.prompt_tokens_details?.cached_tokens,
    tokensCacheWrite: u?.prompt_tokens_details?.cache_write_tokens,
    costUsd: Number.isFinite(cost) ? cost : null,
    durationMs,
  });
}

export class InferenceError extends Error {
  constructor(
    message: string,
    public readonly label: string,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * ⚠ **A SECOND IMPLEMENTATION WAS HERE — one that generated through an AGENT
 * RUNTIME — and it must not come back in any form** (Phase 1 task 1.8, D-116).
 * It ran one agent run per generation call and was the fallback whenever
 * `LLM_BASE_URL`/`LLM_API_KEY` were not both set. That runtime has since been
 * removed from the product entirely; this note is about the SHAPE, which any
 * future agent runtime would bring back with it.
 *
 * **It was I-24: the transport destroyed the refusal channel.** Every run there
 * attached a mandatory script-generation skill, whose protocol adds turns *after*
 * the model answers, so `finalMessage` was the tail of a conversation rather
 * than the answer. Measured over 5 rounds against a deliberately insufficient
 * contract: the model refused **5 of 5** and invented nothing, and Foundry saw
 * **0 refusals and 5 unparseable responses**. `skills: []` cannot remove a
 * mandatory skill, so there was no way to configure around it from this side.
 *
 * ⚠ **And it failed ASYMMETRICALLY, which is what made it dangerous rather than
 * merely wrong.** A satisfiable contract answers on turn one and its JSON
 * survives — the control passed 5 of 5. So the transport worked whenever the
 * answer was *yes* and mangled it whenever the answer was *no*, i.e. it broke
 * exactly the one case the refusal channel exists for. Downstream,
 * `generateFragment` read an unparseable body as a static finding and RETRIED,
 * which is the *"re-asking is how a correct refusal becomes an invented
 * `period="2023-10"` on attempt 2"* that §6.7 forbids — the rule was never
 * reached, because a refusal never presented as one.
 *
 * ⚠ **The fallback used to be guarded by a `console.warn` at boot, and a warning
 * is not a control.** Unsetting either variable silently reinstated all of the
 * above. `LLM_BASE_URL` and `LLM_API_KEY` are now `required()` in
 * `config/index.ts`, so a deployment that cannot generate correctly **cannot
 * boot** — which is what makes `CLAUDE.md`'s D-35 sentence true in code rather
 * than in this deployment's configuration. It is enforced in `config` and not at
 * the server entry point on purpose: every `kestra:*` harness imports these
 * services directly and never runs `index.ts`, so an entry-point check would
 * leave the harnesses calling a gateway with an empty base URL.
 *
 * ⚠ **The runtime was kept at the time, for `agent` STEPS — and is now gone too,
 * with that step kind.** What must survive is the seam: generation is one prompt
 * and one answer, and that is this file. If an agent runtime ever returns, it
 * returns as a step kind and NEVER as an implementation of this interface.
 */

/**
 * A plain OpenAI-compatible completion — one request, one answer.
 *
 * ── Why this exists, and it is a measurement rather than a preference ────────
 *
 * The deleted implementation's own note said it: *"an agent runtime is not a
 * completion API. If a plain completion endpoint ever appears, it lands as a
 * second implementation of this interface and no generation code changes."*
 * One appeared (the gateway the `llm_complete` tool uses), and then
 * `kestra:refusal` showed that the substitution is not an optimisation — the
 * agent runtime was **destroying the refusal channel**.
 *
 * What was measured, 5 rounds against a deliberately insufficient contract:
 *
 *   * the model refused **every time**, and invented nothing — 0 fabricated
 *     dates, periods or thresholds. The mechanism works at the model.
 *   * Foundry saw **none of those refusals**. Every one arrived as
 *     `generator returned no JSON object`.
 *
 * The cause was in that runtime's contract, not in the prompt. Every run there
 * always attached a mandatory script-generation skill, whose protocol
 * runs further turns after the model answers — write the script, smoke-test it,
 * emit `artifacts/RESULT.json`. `finalMessage` is therefore the LAST thing the
 * agent said, not its answer to the prompt. The refusals were still visible in
 * that text, describing themselves in the past tense: *"my previous response
 * indicated that the contract was insufficient"*, *"I identified that the input
 * payload was insufficient to satisfy the contract"*. The JSON the fragment
 * prompt asked for was two turns upstream and gone.
 *
 * ⚠ And it fails ASYMMETRICALLY, which is what makes it dangerous rather than
 * merely wrong. A satisfiable contract produces code on the first turn and its
 * JSON survives as `finalMessage` — the control passed 5 of 5. So the transport
 * works whenever the answer is yes and mangles it whenever the answer is no.
 * Downstream, `generateFragment` treats an unparseable body as a static finding
 * and RETRIES — which is precisely the "re-asking is how a correct refusal
 * becomes an invented value on attempt 2" that §6.7 exists to forbid. The rule
 * was never reached, because a refusal never presented as one.
 *
 * ── What this does NOT change ────────────────────────────────────────────────
 *
 * `complete()` still has no `sessionId` and still must not gain one (D-23) —
 * here it is free rather than enforced, since a completion carries no history at
 * all. Runtime inference (`llm_complete`, ops-api) and generation inference
 * (this) share a provider and nothing else: different credentials, different
 * processes, no shared abstraction. A shared one would put a fragment's contract
 * and a tenant's runtime prompt behind a single interface whose whole value is
 * what it cannot see.
 */
/**
 * ⚠ **THE SECOND SENDER OF `temperature: 0`, AND IT HAD TO BE FIXED SEPARATELY.**
 *
 * ⚠ 2026-11-04: the separation described below (D-35, `generation_llm`) is REVERSED — one model connection for the
 * deployment (`resolveModelConnection`). ops-api is gone too. Kept as the record of why this predicate exists here.
 *
 * `packages/ops-api`'s provider carries the same predicate with the same
 * reasoning. That is not a duplication to tidy away: **runtime inference
 * (`llm_complete`) and generation inference (this) share a provider and nothing
 * else** — different credentials, different processes, no shared abstraction
 * (D-35). Merging them to share four lines would put a fragment's contract and
 * a tenant's runtime prompt behind one interface whose whole value is what it
 * cannot see.
 *
 * ⚠ **What that costs is exactly what happened here**: ops-api was fixed first,
 * `llm_complete` started working, and drafting stayed broken — because the
 * generation model is its own row (`generation_llm`, D-115) and this is its own
 * client. Both were pointing at `gpt-5.6-luna`, which refuses the value:
 *
 *     400 Unsupported value: 'temperature' does not support 0 with this model.
 *
 * On this side the blast radius is larger than one step kind: `draftFlow`,
 * `authorFlow`, every chat turn, fragment generation and sandbox fixtures all
 * come through here, so selecting that model on /ai-provider stopped anything
 * from being authored at all.
 *
 * The retry is keyed on the provider **naming** `temperature`, never on the
 * status alone, and fires **once** — a blanket "400, send less, try again"
 * re-sends every malformed prompt and reports the second failure, which carries
 * less. The first attempt is byte-identical to what this client has always
 * sent, so every generation measurement in this repo was taken against a body
 * this code still produces.
 *
 * ⚠ **If a THIRD sender ever appears, it needs its own copy and its own test.**
 * There is deliberately no shared module to import.
 */
function rejectsTemperature(status: number, body: string): boolean {
  return status === 400 && /temperature/i.test(body);
}

/**
 * The temperature every generation call asks for.
 *
 * ⚠ **1 SINCE 2026-09-17, AND IT WAS 0 FOR THE WHOLE LIFE OF THIS FILE BEFORE
 * THAT.** Asked for directly. The reason it is a named constant rather than a
 * literal in the body is that its value is load-bearing in two directions and
 * neither is obvious at the call site.
 *
 * What it buys: `gpt-5.6-luna` — what `/ai-provider` resolves on this
 * deployment — refuses `temperature: 0` and says *"Only the default (1) value
 * is supported"*. So every single generation call was a 400 followed by a
 * retry, and a chat turn spends `MAX_TURN_ATTEMPTS` of those. At 1 the first
 * attempt is accepted and the retry below stops firing for that model.
 *
 * ⚠ **What it COSTS, stated rather than discovered later: every generation
 * measurement in this repo was taken at 0.** `draft:measure`, `outline:measure`,
 * `chat:measure`, `kestra:refusal` and `propose:measure` all sampled a
 * near-deterministic decoder; at 1 the same prompt can produce a different
 * draft, so run-to-run variance goes up and those numbers are not comparable
 * across the change. They were already stale for other reasons — this is one
 * more, and the sharpest, because it affects every path at once.
 *
 * ⚠ **The retry below is NOT removed.** It is keyed on a provider naming
 * `temperature`, not on the value, so it still catches a model that refuses the
 * parameter outright. A model that rejects 1 specifically is not a shape anyone
 * has seen, and deleting a control because the case that motivated it went away
 * is how the next instance arrives unreported (I-38).
 */
const GENERATION_TEMPERATURE = 1;

export class GatewayInference implements InferenceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly providerId?: string,
  ) {}

  /**
   * Has this model already told us it will not take the temperature we send?
   *
   * ⚠ **Measured 2026-09-06: the retry below fired on 67 of 67 calls** against
   * `gpt-5.6-luna`, so every single inference on this deployment was two round
   * trips — and a chat turn gets `MAX_TURN_ATTEMPTS` of them, so half the
   * budget was spent before the model had a real try at the answer.
   *
   * ⚠ **This does not change what any model RECEIVES**, which is what the
   * docblock above cares about: a model that accepts the value never sets this
   * and its body is byte-identical for ever, and a model that rejects it was
   * already being sent the second body. Only the number of asks changes.
   *
   * ⚠ The 67-of-67 measurement above was taken while `GENERATION_TEMPERATURE`
   * was 0, which is the condition it describes and no longer the one that
   * holds — `gpt-5.6-luna` accepts 1. Kept as the record of why the retry
   * exists; do not read it as current behaviour.
   *
   * Per instance, so a restart re-pays once — deliberately not cached anywhere
   * durable, because a gateway that starts accepting it should be believed.
   */
  private temperatureRejected = false;

  async complete(
    prompt: string,
    opts: { label: string; timeoutMs?: number; maxTokens?: number; model?: string; system?: string; sessionId?: string; schema?: { name: string; schema: Record<string, unknown> } },
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Once per call, so the temperature retry below keeps the same session.
    const extra = gatewayHeaders({ providerId: this.providerId, baseUrl: this.baseUrl }, opts.sessionId);
    const send = (withTemperature: boolean) =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...extra },
        body: JSON.stringify({
          // Per-call override wins; absent is this instance's resolved default.
          model: opts.model ?? this.model,
          // S7: a stable instruction block rides as `system`; the prompt stays
          // the data-only user message. Absent: today's single user body.
          // (The old ban was for fragment isolation; generation prompts carry
          // their instructions inline today, so a system split adds no channel.)
          messages: opts.system ? [{ role: "system", content: opts.system }, { role: "user", content: prompt }] : [{ role: "user", content: prompt }],
          ...(withTemperature ? { temperature: GENERATION_TEMPERATURE } : {}),
          ...(opts.schema ? { response_format: { type: "json_schema", json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema } } } : {}),
          max_tokens: opts.maxTokens ?? FRAGMENT_MAX_TOKENS,
          stream: false,
        }),
      });
    let res: Response;
    let text: string;
    const started = Date.now();
    try {
      res = await send(!this.temperatureRejected);
      text = await res.text();
      if (!this.temperatureRejected && rejectsTemperature(res.status, text)) {
        this.temperatureRejected = true;
        // Logged once per process, not once per call — 67 identical warnings
        // is how a real signal becomes something people scroll past.
        console.warn(
          `[inference] ${this.model} rejected temperature: ${GENERATION_TEMPERATURE} — retrying without it, ` +
            `and omitting it for the rest of this process (${opts.label}). ${text.slice(0, 200)}`,
        );
        res = await send(false);
        text = await res.text();
      }
    } catch (e) {
      const why = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
      throw new InferenceError(`gateway request failed: ${why}`, opts.label);
    } finally {
      clearTimeout(timer);
    }
    // One line per call — how long it took, and (behind a LiteLLM gateway) how much of that was the upstream model — so "why was
    // this build slow" is answered by the log, not by timing the gateway by hand (2026-09-29: 10–45 s per call, all upstream). The
    // prompt and the answer are never logged.
    const upstream = res.headers?.get?.("x-litellm-response-duration-ms");
    console.log(`[inference] ${opts.label} model=${opts.model ?? this.model} status=${res.status} ${Date.now() - started}ms` +
      (upstream ? ` upstream=${Math.round(Number(upstream))}ms` : "") + ` completion_tokens=${(() => { try { return JSON.parse(text).usage?.completion_tokens ?? "?"; } catch { return "?"; } })()}`);

    if (!res.ok) {
      throw new InferenceError(`gateway returned ${res.status}: ${text.slice(0, 300)}`, opts.label);
    }
    let json: {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    };
    try {
      json = JSON.parse(text);
    } catch {
      throw new InferenceError("gateway returned a non-JSON body", opts.label);
    }
    recordGenerationUsage(json, res, opts.model ?? this.model, Date.now() - started);
    const choice = json.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      /**
       * ⚠ **On a REASONING model an empty answer usually means the budget went
       * on thinking**, and the bare message sent people looking at the gateway.
       * Measured 2026-09-06: `gpt-5.6-luna` returns `reasoning_tokens` in
       * `usage`, drawn from the SAME `max_tokens` as the answer — so a hard turn
       * can spend the whole budget reasoning and return `content: ""` with
       * `finish_reason: "length"`. The numbers are named here because the fix is
       * a bigger budget and nothing in the old message pointed at one.
       */
      const usage = (json as { usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }).usage;
      const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
      throw new InferenceError(
        `gateway returned no message content (finish_reason=${choice?.finish_reason ?? "?"}` +
          `, completion_tokens=${usage?.completion_tokens ?? "?"}` +
          (reasoning === undefined ? "" : `, of which reasoning=${reasoning}`) +
          `, max_tokens=${opts.maxTokens ?? FRAGMENT_MAX_TOKENS})` +
          (reasoning ? " — a reasoning model spends this budget on thinking too" : ""),
        opts.label,
      );
    }
    // ⚠ Truncation must be loud. An answer cut off mid-JSON parses as "no JSON
    // object" and would be retried as though the model had misbehaved.
    //
    // It must also say WHOSE limit and how big, because the two callers have
    // different budgets and the reader's next question is always "then raise
    // it". The old message said "the fragment is incomplete" on a DRAFT
    // failure — measured, in a real 157.7 s job — which sent the reader to the
    // wrong half of the generator.
    if (choice?.finish_reason === "length") {
      const cap = opts.maxTokens ?? FRAGMENT_MAX_TOKENS;
      throw new InferenceError(
        `the model reached its ${cap}-token output limit mid-answer, so the reply is ` +
          `incomplete and cannot be used. Nothing is salvageable from a truncated answer.`,
        opts.label,
      );
    }
    return content;
  }
}

/**
 * The generation seam. **The gateway, and only the gateway** (1.8).
 *
 * There is no transport choice here any more and no branch to read: the
 * credentials are `required()` config, so a process that reaches this line has
 * them. See the note above for what the other branch did and
 * why a `console.warn` was the wrong guard for it.
 *
 * ── ⚠ THE MODEL IS RESOLVED PER CALL, AND IT USED TO BE RESOLVED AT IMPORT ──
 *
 * `export const inference = resolveInference()` bound the model once at module
 * load, so changing it meant restarting the container. That is the state F2
 * exists to leave: a settings page over a boot-time binding is a page that
 * reports a change it did not make.
 *
 * ⚠ **The gateway and key now come from the one model connection** (2026-11-04),
 * with `config.inference` as the fallback. The `LLM_*` environment is still read
 * in `config/index.ts` and nowhere else (`kestra:check` asserts it).
 */

/**
 * ⚠ Imported lazily, inside the call.
 *
 * `generation-provider.service.ts` imports the database, and this module is
 * imported by everything that generates — including harnesses that construct a
 * recording client and never touch a real gateway. A top-level import would make
 * every one of them open a connection to resolve a model they are not going to
 * use.
 */
async function currentConnection() {
  const { resolveGenerationProvider } = await import("./generation-provider.service.js");
  return await resolveGenerationProvider();
}

class ResolvingInference implements InferenceClient {
  async complete(
    prompt: string,
    opts: { label: string; timeoutMs?: number; maxTokens?: number; model?: string; system?: string; sessionId?: string; schema?: { name: string; schema: Record<string, unknown> } },
  ): Promise<string> {
    // `config.inference` may be empty (env is optional); an empty base URL
    // throws below rather than arriving as a request to `/chat/completions`. A per-call model override wins over the default.
    const p = await currentConnection();
    const baseUrl = p.baseUrl || config.inference.baseUrl;
    if (!baseUrl) throw new Error("No AI model configured — set one on the AI models page");
    return new GatewayInference(baseUrl, p.apiKey || config.inference.apiKey, opts.model ?? p.model, p.baseUrl ? p.providerId : config.inference.provider).complete(prompt, opts);
  }
}

export const inference: InferenceClient = new ResolvingInference();
