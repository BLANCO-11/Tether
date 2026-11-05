/**
 * Everything the Test panel decides, as pure functions.
 * `specs/20260818-123807-tool-probe` · T12
 *
 * ── Why the page holds no rules ──────────────────────────────────────────────
 *
 * Same reason `tool-edit.ts` and `policy-copy.ts` exist: **the copy IS the
 * control**. A probe's whole value is the sentence a person reads, and a sentence
 * assembled inline in JSX cannot be asserted, so it drifts until it says something
 * false — "Working" over a `reachable` verdict being the specific lie this feature
 * has to avoid, because `reachable` means the tool's own call was never made.
 *
 * ⚠ **Nothing here derives a verdict.** `probeCopy` maps the server's `verdict`
 * to a tone and a title and passes the server's `message` and `remedy` through
 * untouched. A client that computed its own verdict would be a second opinion
 * about whether a tool works, and the two would disagree on the day it mattered.
 * `ui-honesty-check.sh` pins that the page renders probe state only from the
 * response.
 */
import type {
  DataType, ToolProbe, ToolProbeMark, ToolProbeMode, ToolProbeVerdict,
} from "@/lib/types";
import { hasStoredValue, type ToolAuthDraft } from "@/lib/tool-edit";

/**
 * Which mode a method gets by default.
 *
 * ⚠ **Mirrors `defaultModeFor` in `services/tool-probe.service.ts` and is not
 * imported from it** — the client shares no module with the server (see the note
 * on `PLATFORM_MANAGED_TOOLS` in `tools/page.tsx`). The server is the control: it
 * applies its own default when the client sends no `mode`, so a drift here changes
 * a button's LABEL and never what is actually sent.
 */
export function defaultModeFor(method: string | null | undefined): ToolProbeMode {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" ? "live" : "reachability";
}

/**
 * Platform-managed tool names — the client's mirror of the server's
 * `PLATFORM_TOOL_NAMES`.
 *
 * ⚠ Duplicated deliberately, exactly as `tools/page.tsx` already duplicates it.
 * The server refuses a live probe of these with a 409; the client hides the
 * control, because a button the API will always refuse reads as a broken page
 * rather than as a rule.
 */
const PLATFORM_MANAGED_TOOLS = ["foundry_email_send"];

/**
 * May a LIVE probe be offered for this tool?
 *
 * ⚠ A mutating method is not the reason to refuse — a live probe of a `POST` is
 * offered, because a person may genuinely want to test it and the confirmation is
 * how they say so (P2). What is refused is a platform-managed tool: a live probe of
 * `foundry_email_send` would deliver REAL mail, and it would fail anyway, since
 * that tool resolves its recipient from an `x-foundry-run` header a probe has no
 * run to supply. A green or red result there would be a statement about the probe.
 */
export function isLiveProbeOffered(name: string, _method: string | null | undefined): boolean {
  return !PLATFORM_MANAGED_TOOLS.includes(name);
}

export type ProbeTone = "ok" | "warn" | "danger";

export type ProbeCopy = {
  tone: ProbeTone;
  /** The verdict as a short human word, for a pill. */
  title: string;
  /** ⚠ The SERVER's sentence, passed through. Never assembled here. */
  detail: string;
  /** ⚠ The SERVER's remedy, or null. Never invented. */
  remedy: string | null;
};

/**
 * The tone each verdict is rendered in — contract §Verdicts.
 *
 * ⚠ `reachable` is `ok`, and that is the contract's choice rather than an
 * oversight: the host answered, which is what the mode asked. The caveat that the
 * tool's own call was NOT made lives in the server's `message`, which
 * `probeCopy` passes through verbatim, and in the panel's own un-sent-method line.
 */
const TONE: Record<ToolProbeVerdict, ProbeTone> = {
  ok: "ok",
  reachable: "ok",
  auth_rejected: "danger",
  forbidden: "danger",
  not_found: "danger",
  upstream_error: "warn",
  client_error: "warn",
  unreachable: "danger",
  egress_refused: "danger",
  timeout: "warn",
};

/**
 * The word on the pill.
 *
 * ⚠ **None of these is "Working".** `reachable` in particular must not read as a
 * verdict about the tool — it is a verdict about the HOST, and the difference is
 * the whole reason the reachability mode exists.
 */
const TITLE: Record<ToolProbeVerdict, string> = {
  ok: "Call succeeded",
  reachable: "Host reachable",
  auth_rejected: "Credential rejected",
  forbidden: "Credential required",
  not_found: "Path not found",
  upstream_error: "Endpoint failing",
  client_error: "Request rejected",
  unreachable: "Unreachable",
  egress_refused: "Refused by Foundry",
  timeout: "Timed out",
};

export function probeCopy(probe: ToolProbe): ProbeCopy {
  return {
    tone: TONE[probe.verdict],
    title: TITLE[probe.verdict],
    // ⚠ Passed through, not rewritten. The server names the host and the status
    // in one sentence; a client paraphrase would drop whichever half it thought
    // was obvious.
    detail: probe.message,
    remedy: probe.remedy,
  };
}

/**
 * A one-line description of what was actually sent, for the detail row.
 *
 * ⚠ Reads `probe.request.method` — what was SENT — and names `toolMethod`
 * separately when they differ. A panel that showed only the tool's method would
 * be describing a call that did not happen.
 */
export function requestSummary(probe: ToolProbe): string {
  const { method, toolMethod, fellBackToGet, authPresented } = probe.request;
  const parts = [method === toolMethod ? method : `${method} (the tool sends ${toolMethod})`];
  if (fellBackToGet) parts.push("HEAD was refused, retried with GET");
  parts.push(
    authPresented.placement
      ? `credential presented as ${authPresented.placement}`
      : "no credential presented",
  );
  if (probe.status !== null) parts.push(`${probe.durationMs} ms`);
  return parts.join(" · ");
}

export type PreflightFinding = { message: string };

/**
 * What is worth saying BEFORE dialling.
 *
 * ⚠ **This is not validation — the server validates.** It exists so a person is
 * not made to wait 10 seconds for a network error whose cause is already visible
 * in the form. Two cases only:
 *
 *  1. an endpoint that is not an http(s) URL — nothing can be dialled;
 *  2. a credential named but not stored — the server answers 424 and dials
 *     nothing, so saying it here saves a round trip and names the remedy.
 *
 * ⚠ **It deliberately does NOT re-emit `authFindings`' messages, and that is a
 * correction.** The first version did, and `tools/page.test.tsx` turned red with
 * *"found multiple elements"*: the form ALREADY renders each of those findings
 * beside the field it addresses, so the panel was printing the same sentence a
 * second time. Two copies of one refusal is noise, and noise is what stops the
 * copy being read.
 *
 * ⚠ The rules are still shared rather than re-derived — the panel's button is
 * disabled on the form's own `authFindings` result, exactly as the Save button is
 * (see `tools/page.tsx`). What is avoided is a second RENDER of them, not a second
 * evaluation. `hasStoredValue` is reused here for the same reason: two
 * implementations of "is this credential stored" would disagree, and the one
 * people saw would be whichever the panel happened to call.
 */
export function preflightFindings(
  draft: ToolAuthDraft & { url?: string | null },
  secrets: Array<{ name: string; hasValue: boolean }>,
): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const url = (draft.url ?? "").trim();

  if (!url) {
    out.push({ message: "Give the endpoint URL before testing." });
  } else if (!/^https?:\/\//i.test(url)) {
    out.push({ message: "The endpoint must start with http:// or https:// to be testable." });
  }

  /**
   * ⚠ Named credentials with nothing stored. This is the state `applyAuth`'s 424
   * exists to report, and the sentence names the place to fix it — a "credential
   * missing" with no destination is the message people ignore.
   */
  const named = [draft.secretEnvName, draft.clientIdSecretRef, draft.clientSecretSecretRef]
    .map((n) => (n ?? "").trim())
    .filter(Boolean);
  for (const name of named) {
    if (!hasStoredValue(secrets, name)) {
      out.push({
        message: `${name} has no stored value — store it under Credentials, then test.`,
      });
    }
  }

  return out;
}

// ── The live path (P2 · T16, T17) ─────────────────────────────────────────────
//
// A live probe of a mutating tool needs two things a reachability check does not:
// values to send, and the person's explicit consent to send them. Both are
// decided here for the same reason everything else in this file is — the sentence
// in the confirmation IS the control, and a sentence built inline in JSX cannot be
// asserted.

/** One declared parameter, as the form holds it. */
export type SampleParamSpec = { name: string; dataType: DataType; required?: boolean };

export type SampleParamFinding = {
  name: string;
  message: string;
  /**
   * ⚠ `true` ⇒ the probe must not run. A value that cannot be coerced to its
   * declared type would otherwise be DROPPED, and the endpoint would answer about
   * a call that omitted what the person typed — a red verdict caused by Foundry
   * silently discarding an input is the worst kind of false signal.
   */
  blocking: boolean;
};

/**
 * The typed values to send, from what was typed into the panel.
 *
 * ⚠ **Blank means omitted, not `""`.** T16: *"Empty is allowed — some endpoints
 * need nothing."* Sending `{"since": ""}` is not the same request as sending
 * `{}`, and a great many endpoints treat the first as a filter that matches
 * nothing. So a blank field contributes no key at all.
 *
 * ⚠ **The declared `dataType` is honoured.** `dialTool` puts a GET's params in the
 * query string (where everything is text anyway) and every other method's in a
 * JSON body (where `5` and `"5"` are different values, and the second is what a
 * schema-checking endpoint rejects). The form already holds the type; ignoring it
 * here would make the panel's result depend on a coincidence.
 *
 * ⚠ **A required parameter left blank is reported but does NOT block.** It is a
 * legitimate thing to do — the point may be to see what the endpoint says — and
 * the sentence says what will happen rather than refusing.
 */
export function sampleParamsToSend(
  specs: SampleParamSpec[],
  values: Record<string, string>,
): { params: Record<string, unknown>; findings: SampleParamFinding[] } {
  const params: Record<string, unknown> = {};
  const findings: SampleParamFinding[] = [];

  for (const spec of specs) {
    const name = spec.name.trim();
    if (!name) continue;
    const raw = values[name] ?? "";
    if (raw.trim() === "") {
      if (spec.required) {
        findings.push({
          name,
          message: `${name} is required and is empty — it will not be sent, and the endpoint will most likely reject the call.`,
          blocking: false,
        });
      }
      continue;
    }

    switch (spec.dataType) {
      case "string":
        // ⚠ As typed, not trimmed. A trailing space can be part of a real value,
        // and a panel that quietly edits the input is describing a different call.
        params[name] = raw;
        break;
      case "integer": {
        if (!/^-?\d+$/.test(raw.trim())) {
          findings.push({
            name,
            message: `${name} is declared as an integer, and “${raw.trim()}” is not one. Fix it or clear it — it will not be sent as text.`,
            blocking: true,
          });
        } else params[name] = Number(raw.trim());
        break;
      }
      case "float": {
        const n = Number(raw.trim());
        if (!Number.isFinite(n)) {
          findings.push({
            name,
            message: `${name} is declared as a number, and “${raw.trim()}” is not one. Fix it or clear it — it will not be sent as text.`,
            blocking: true,
          });
        } else params[name] = n;
        break;
      }
      case "boolean": {
        const t = raw.trim().toLowerCase();
        if (t !== "true" && t !== "false") {
          findings.push({
            name,
            message: `${name} is declared as a boolean — type true or false, or clear it.`,
            blocking: true,
          });
        } else params[name] = t === "true";
        break;
      }
      case "array": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (!Array.isArray(parsed)) {
          findings.push({
            name,
            message: `${name} is declared as an array — write it as JSON, e.g. ["a","b"], or clear it.`,
            blocking: true,
          });
        } else params[name] = parsed;
        break;
      }
    }
  }

  return { params, findings };
}

/**
 * The host, for the confirmation and nothing else.
 *
 * ⚠ Falls back to the raw string rather than to a word like "the endpoint": the
 * confirmation's job is to name what is about to be called, and a URL that will
 * not parse is exactly the case where a person needs to see what they typed.
 * (The panel's button is blocked on `preflightFindings` before this matters.)
 */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
}

/**
 * The confirmation, for a live probe of a tool whose default mode is
 * reachability — i.e. a mutating method (T17).
 *
 * ⚠ **Names the method, the host, and the consequence in that order**, and the
 * consequence is stated as a certainty about Foundry rather than a guess about the
 * endpoint: Foundry knows it is about to send a real `POST`; only the endpoint
 * knows whether that creates something. Saying "this will create a ticket" would
 * be Foundry asserting something it cannot know, and saying "this is safe" would
 * be worse.
 *
 * ⚠ **Parameter KEYS only, never values.** The same rule the server's
 * undeclared-params warning follows: a confirmation is read out loud, screenshotted
 * and pasted into tickets, and a sample value can be a customer's name. The person
 * typed the values and can see them in the form directly above.
 */
export function liveConfirmBody(args: {
  method: string;
  url: string;
  paramNames: string[];
}): string {
  const method = (args.method || "GET").toUpperCase();
  const sent =
    args.paramNames.length > 0
      ? ` It sends ${args.paramNames.length === 1 ? "the parameter" : "the parameters"} ${args.paramNames.join(", ")}.`
      : " It sends no parameters.";
  return (
    `This sends a real ${method} to ${hostOf(args.url)}.` +
    ` If this endpoint creates or changes data, it will.${sent}` +
    " Nothing is saved either way."
  );
}

// ── The tested marker, coming off the wire (P3 · T22) ────────────────────────

/**
 * Narrow a `lastProbe` from the wire, or answer `null`.
 *
 * ⚠ **An unrecognised verdict word is treated as NO RECORD, not passed through.**
 * `TITLE[verdict]` on a word this build has never heard of renders the literal
 * `undefined` in a pill — a newer server adding an eleventh verdict would put that
 * on the row of every tool it applies to. Rendering nothing is the honest fallback
 * and it is the same rule as an absent marker: this build has no statement to make
 * about that probe.
 *
 * ⚠ The verdict list is `Object.keys(TONE)` rather than a second literal array —
 * `TONE` is `Record<ToolProbeVerdict, …>`, so adding a verdict to the type forces
 * it into both places at once. A hand-kept copy here is the one that drifts, and
 * it would drift silently in the direction of hiding real results.
 */
export function probeMarkFromWire(raw: unknown): ToolProbeMark | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.at !== "string" || !m.at) return null;
  if (m.mode !== "live" && m.mode !== "reachability") return null;
  if (typeof m.verdict !== "string" || !(m.verdict in TONE)) return null;
  const status = typeof m.status === "number" ? m.status : null;
  return {
    at: m.at,
    verdict: m.verdict as ToolProbeVerdict,
    mode: m.mode,
    status,
  };
}

/**
 * How long ago, in the words a person uses.
 *
 * ⚠ **Computed on the CLIENT, from an ISO instant.** A server-rendered "4 min ago"
 * is wrong by however long the response sat in a queue or a cache, and it never
 * ages while the page is open.
 *
 * ⚠ `now` is a parameter so this is testable without freezing the clock, and so
 * the page passes one value to every row — twelve rows each calling `Date.now()`
 * can straddle a minute boundary and disagree with each other.
 */
export function agoWords(at: string, now: number): string | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const secs = Math.floor((now - then) / 1000);
  // ⚠ A clock skew that puts the mark in the future says "just now" rather than
  // "in -3 min". It is a real state (two containers, one clock behind).
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * The one line the row shows for a remembered probe (T22).
 *
 * ⚠ **It states that the tool's own call was not made whenever the mode was
 * `reachability`** — the same caveat the panel carries, for the same reason: this
 * line is read weeks later, out of context, and *"tested · reachable"* on its own
 * is the false green this entire feature exists to remove.
 *
 * ⚠ The verdict word is `TITLE`'s, so the row and the panel cannot disagree about
 * what a verdict is called.
 */
export function markLine(mark: ToolProbeMark, now: number): string {
  const age = agoWords(mark.at, now);
  const parts = ["tested", TITLE[mark.verdict].toLowerCase()];
  if (age) parts.push(age);
  if (mark.mode === "reachability") parts.push("endpoint not invoked");
  return parts.join(" · ");
}
