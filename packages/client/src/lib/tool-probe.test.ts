/**
 * The Test panel's copy and rules, asserted away from React.
 * `specs/20260818-123807-tool-probe` · T12
 *
 * ⚠ **The copy IS the control**, same idiom as `policy-copy.test.ts`. The single
 * most damaging thing this panel could do is render a `reachable` verdict as
 * "Working": the host answered a `HEAD`, the tool's own call was never made, and a
 * person who reads "Working" ships a flow on the strength of it. So the words are
 * asserted, and the absence of that word is asserted too.
 */
import { describe, expect, it } from "vitest";
import {
  defaultModeFor,
  hostOf,
  isLiveProbeOffered,
  liveConfirmBody,
  agoWords,
  markLine,
  probeCopy,
  probeMarkFromWire,
  preflightFindings,
  requestSummary,
  sampleParamsToSend,
} from "@/lib/tool-probe";
import type { ToolProbe, ToolProbeMark, ToolProbeVerdict } from "@/lib/types";

const base: ToolProbe = {
  mode: "live",
  verdict: "ok",
  invoked: true,
  request: {
    method: "GET",
    toolMethod: "GET",
    urlShown: "https://api.example.com/v1/employees",
    fellBackToGet: false,
    authPresented: { style: "header", placement: "header:x-api-key" },
  },
  status: 200,
  statusText: "OK",
  contentType: "application/json",
  durationMs: 142,
  body: { preview: '{"ok":true}', redacted: true, truncated: false },
  message: "Reached api.example.com — it answered 200 OK to GET.",
  remedy: null,
};

const withVerdict = (verdict: ToolProbeVerdict, over: Partial<ToolProbe> = {}): ToolProbe => ({
  ...base,
  verdict,
  ...over,
});

const ALL_VERDICTS: ToolProbeVerdict[] = [
  "ok",
  "reachable",
  "auth_rejected",
  "forbidden",
  "not_found",
  "upstream_error",
  "client_error",
  "unreachable",
  "egress_refused",
  "timeout",
];

describe("defaultModeFor — a Test button must not fire a mutating call", () => {
  it("reads GET and HEAD as live, everything else as reachability", () => {
    expect(defaultModeFor("GET")).toBe("live");
    expect(defaultModeFor("get")).toBe("live");
    expect(defaultModeFor("HEAD")).toBe("live");
    expect(defaultModeFor("POST")).toBe("reachability");
    expect(defaultModeFor("PUT")).toBe("reachability");
    expect(defaultModeFor("PATCH")).toBe("reachability");
    expect(defaultModeFor("DELETE")).toBe("reachability");
  });

  it("treats a missing method as GET, exactly as execution does", () => {
    expect(defaultModeFor(null)).toBe("live");
    expect(defaultModeFor(undefined)).toBe("live");
  });

  /**
   * ⚠ Mirrors the server's own default. The server applies its own when the
   * client sends no `mode`, so a drift here changes a LABEL and never what is
   * sent — but a drift is still a lie on a button, so it is pinned.
   */
  it("matches the server's rule, which is the one that is enforced", () => {
    // Same table, spelled out, so a change on either side has to be deliberate.
    expect(["GET", "HEAD"].every((m) => defaultModeFor(m) === "live")).toBe(true);
    expect(
      ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].every(
        (m) => defaultModeFor(m) === "reachability",
      ),
    ).toBe(true);
  });
});

describe("isLiveProbeOffered", () => {
  it("hides a live probe for a platform-managed tool", () => {
    // A button the API will always refuse (409) reads as a broken page, not a rule.
    expect(isLiveProbeOffered("foundry_email_send", "POST")).toBe(false);
  });

  it("offers one for an ordinary mutating tool — the confirmation is how consent is given", () => {
    expect(isLiveProbeOffered("ticket_create", "POST")).toBe(true);
  });

  /**
   * ⚠ `mail_send` is the SIMULATED ops-api tool that writes a row to
   * `mail_outbox`; only `foundry_email_send` delivers real mail. Refusing both
   * would remove a harmless test for no reason, and the distinction is one the
   * server's list already makes.
   */
  it("offers one for `mail_send`, which is the simulated tool", () => {
    expect(isLiveProbeOffered("mail_send", "POST")).toBe(true);
  });
});

describe("probeCopy — the words on the pill", () => {
  it("gives every verdict a tone and a title, with no gaps", () => {
    // A missing entry renders `undefined` in the UI, which is worse than a wrong
    // word: it reads as a broken page over a probe that actually ran.
    for (const v of ALL_VERDICTS) {
      const copy = probeCopy(withVerdict(v));
      expect(copy.tone, v).toMatch(/^(ok|warn|danger)$/);
      expect(copy.title.length, v).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠ **THE ASSERTION THIS FILE EXISTS FOR.** `reachable` means the HOST
   * answered; the tool's own call was never made. "Working" over that verdict is
   * the false green this whole feature is built to avoid, and it is asserted as an
   * absence because absences do not fail any other way.
   */
  it("never says “Working” — for any verdict", () => {
    for (const v of ALL_VERDICTS) {
      expect(probeCopy(withVerdict(v)).title.toLowerCase(), v).not.toContain("working");
    }
  });

  it("`reachable` is titled about the HOST, not about the tool", () => {
    const copy = probeCopy(withVerdict("reachable"));
    expect(copy.title).toBe("Host reachable");
    expect(copy.tone).toBe("ok");
  });

  it("a rejected credential is danger; a failing endpoint is only a warning", () => {
    // The distinction is actionable: one is your configuration, the other is not.
    expect(probeCopy(withVerdict("auth_rejected")).tone).toBe("danger");
    expect(probeCopy(withVerdict("forbidden")).tone).toBe("danger");
    expect(probeCopy(withVerdict("upstream_error")).tone).toBe("warn");
    expect(probeCopy(withVerdict("timeout")).tone).toBe("warn");
  });

  /**
   * ⚠ The sentence and the remedy are the SERVER's, passed through byte for byte.
   * A client paraphrase drops whichever half it judges obvious, and the server is
   * the only side that knows the host, the status and what was actually sent.
   */
  it("passes the server's message and remedy through untouched", () => {
    const probe = withVerdict("auth_rejected", {
      message: "Reached api.example.com — it answered 401 Unauthorized to GET.",
      remedy: "Check the auth style (header), the name (X-API-Key), and the stored value.",
    });
    const copy = probeCopy(probe);
    expect(copy.detail).toBe(probe.message);
    expect(copy.remedy).toBe(probe.remedy);
  });

  it("a null remedy stays null — it is not padded with advice", () => {
    // "Try again" is the field's failure mode: once it is noise it stops being
    // read on the occasions it says something real.
    expect(probeCopy(withVerdict("upstream_error", { remedy: null })).remedy).toBeNull();
  });
});

describe("requestSummary — what was actually sent", () => {
  it("names the sent method AND the tool's method when they differ", () => {
    const s = requestSummary(
      withVerdict("reachable", {
        request: { ...base.request, method: "HEAD", toolMethod: "POST" },
      }),
    );
    expect(s).toContain("HEAD");
    expect(s).toContain("the tool sends POST");
  });

  it("says so when the HEAD fell back to GET", () => {
    const s = requestSummary(
      withVerdict("reachable", {
        request: { ...base.request, method: "GET", toolMethod: "POST", fellBackToGet: true },
      }),
    );
    expect(s).toContain("retried with GET");
  });

  it("names the credential PLACEMENT and never a value", () => {
    const s = requestSummary(base);
    expect(s).toContain("header:x-api-key");
  });

  it("says plainly when no credential was presented", () => {
    const s = requestSummary(
      withVerdict("forbidden", {
        request: { ...base.request, authPresented: { style: null, placement: null } },
      }),
    );
    expect(s).toContain("no credential presented");
  });

  it("omits the duration when no answer arrived at all", () => {
    // A "0 ms" on a DNS failure is a measurement of nothing.
    const s = requestSummary(withVerdict("unreachable", { status: null, durationMs: 0 }));
    expect(s).not.toContain("ms");
  });
});

describe("preflightFindings — what is worth saying before dialling", () => {
  const secrets = [
    { name: "STORED_KEY", hasValue: true },
    { name: "EMPTY_KEY", hasValue: false },
  ];

  it("says nothing when the draft is dialable", () => {
    expect(
      preflightFindings({ url: "https://api.example.com/v1", authStyle: "none" }, secrets),
    ).toEqual([]);
  });

  it("asks for an endpoint when there is none", () => {
    expect(preflightFindings({ url: "" }, secrets)[0]!.message).toMatch(/endpoint URL/);
  });

  it("refuses a non-http endpoint — there is nothing to dial", () => {
    const found = preflightFindings({ url: "api.example.com/v1" }, secrets);
    expect(found[0]!.message).toMatch(/http:\/\/ or https:\/\//);
  });

  /**
   * ⚠ This is the 424 the server would answer, said one round trip earlier — and
   * it names WHERE to fix it. A "credential missing" with no destination is the
   * message people scroll past.
   */
  it("names a credential that has no stored value, and where to store it", () => {
    const found = preflightFindings(
      { url: "https://api.example.com", authStyle: "bearer", secretEnvName: "EMPTY_KEY" },
      secrets,
    );
    expect(found.map((f) => f.message).join(" ")).toContain("EMPTY_KEY has no stored value");
    expect(found.map((f) => f.message).join(" ")).toMatch(/Credentials/);
  });

  it("is silent about a credential that IS stored", () => {
    expect(
      preflightFindings(
        { url: "https://api.example.com", authStyle: "bearer", secretEnvName: "STORED_KEY" },
        secrets,
      ),
    ).toEqual([]);
  });

  /**
   * ⚠ **This assertion was INVERTED on 2026-08-20, and the inversion is the
   * finding.** It used to require that preflight re-report the form's auth gaps.
   * `tools/page.test.tsx` then failed with *"found multiple elements"* — the form
   * already renders each of those findings beside the field it addresses, so the
   * panel was printing the same sentence twice in one modal.
   *
   * The rules are still shared: the Test button is disabled on the form's own
   * `authFindings` result, exactly as Save is. What must not happen is a second
   * RENDER of a refusal the person is already looking at.
   */
  it("does NOT re-report a field-level auth gap — the form already shows it", () => {
    // `header` style with no param name is `authFindings`' refusal, rendered
    // beside the auth-param field by the form itself.
    const found = preflightFindings(
      { url: "https://api.example.com", authStyle: "header", secretEnvName: "STORED_KEY" },
      secrets,
    );
    expect(found).toEqual([]);
  });

  it("checks both OAuth2 secret refs, not just the first", () => {
    const found = preflightFindings(
      {
        url: "https://api.example.com",
        authStyle: "oauth2_client_credentials",
        tokenUrl: "https://api.example.com/oauth/token",
        clientIdSecretRef: "STORED_KEY",
        clientSecretSecretRef: "EMPTY_KEY",
      },
      secrets,
    );
    const all = found.map((f) => f.message).join(" ");
    expect(all).toContain("EMPTY_KEY has no stored value");
    expect(all).not.toContain("STORED_KEY has no stored value");
  });
});

/**
 * `sampleParamsToSend` — P2 · T16.
 *
 * ⚠ Two properties carry the honesty here, and both are asserted:
 *
 *  1. a blank field sends NO KEY (not `""`), because `{"since":""}` and `{}` are
 *     different requests to most endpoints;
 *  2. a value that cannot be its declared type BLOCKS rather than being dropped —
 *     a probe that silently discards an input and then reports the endpoint's
 *     complaint is a false signal manufactured by Foundry.
 */
describe("sampleParamsToSend", () => {
  it("sends nothing at all when every field is blank", () => {
    const { params, findings } = sampleParamsToSend(
      [
        { name: "since", dataType: "string" },
        { name: "limit", dataType: "integer" },
      ],
      { since: "", limit: "   " },
    );
    expect(params).toEqual({});
    expect(findings).toEqual([]);
  });

  it("omits a blank key rather than sending an empty string", () => {
    const { params } = sampleParamsToSend(
      [
        { name: "since", dataType: "string" },
        { name: "state", dataType: "string" },
      ],
      { since: "", state: "open" },
    );
    // ⚠ `toEqual` on the whole object, not `params.since === undefined`: the
    // assertion is that the KEY is absent, and `{since: undefined}` serialises
    // to `{}` in JSON but is a different object to read in a test.
    expect(params).toEqual({ state: "open" });
    expect(Object.keys(params)).toEqual(["state"]);
  });

  it("coerces each declared type, so a JSON body carries 5 and not \"5\"", () => {
    const { params, findings } = sampleParamsToSend(
      [
        { name: "title", dataType: "string" },
        { name: "limit", dataType: "integer" },
        { name: "score", dataType: "float" },
        { name: "urgent", dataType: "boolean" },
        { name: "tags", dataType: "array" },
      ],
      { title: "probe", limit: "5", score: "1.5", urgent: "true", tags: '["a","b"]' },
    );
    expect(params).toEqual({
      title: "probe",
      limit: 5,
      score: 1.5,
      urgent: true,
      tags: ["a", "b"],
    });
    expect(findings).toEqual([]);
  });

  it("keeps a string exactly as typed, trailing space included", () => {
    const { params } = sampleParamsToSend([{ name: "q", dataType: "string" }], { q: "a b " });
    expect(params.q).toBe("a b ");
  });

  it.each([
    ["integer", "abc", "is declared as an integer"],
    ["integer", "1.5", "is declared as an integer"],
    ["float", "abc", "is declared as a number"],
    ["boolean", "yes", "is declared as a boolean"],
    ["array", "a,b", "is declared as an array"],
    ["array", '{"a":1}', "is declared as an array"],
  ] as const)("refuses %s value “%s” rather than dropping it", (dataType, raw, says) => {
    const { params, findings } = sampleParamsToSend([{ name: "f", dataType }], { f: raw });
    expect(params).toEqual({});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.blocking).toBe(true);
    expect(findings[0]!.message).toContain(says);
  });

  it("accepts a negative integer and a JSON array of objects", () => {
    const { params, findings } = sampleParamsToSend(
      [
        { name: "offset", dataType: "integer" },
        { name: "rows", dataType: "array" },
      ],
      { offset: "-3", rows: '[{"a":1}]' },
    );
    expect(params).toEqual({ offset: -3, rows: [{ a: 1 }] });
    expect(findings).toEqual([]);
  });

  it("accepts BOOLEAN in any case, because a form is typed by a person", () => {
    const { params } = sampleParamsToSend([{ name: "b", dataType: "boolean" }], { b: "False" });
    expect(params).toEqual({ b: false });
  });

  /**
   * ⚠ Reported, NOT blocking. Pressing the button to see what the endpoint says
   * about a missing required field is a legitimate thing to want.
   */
  it("reports a required parameter left blank without blocking the probe", () => {
    const { params, findings } = sampleParamsToSend(
      [{ name: "ticket_id", dataType: "string", required: true }],
      { ticket_id: "" },
    );
    expect(params).toEqual({});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.blocking).toBe(false);
    expect(findings[0]!.message).toContain("is required and is empty");
  });

  it("says nothing about an OPTIONAL parameter left blank", () => {
    const { findings } = sampleParamsToSend(
      [{ name: "since", dataType: "string", required: false }],
      { since: "" },
    );
    expect(findings).toEqual([]);
  });

  it("ignores an unnamed parameter row and a stale value whose row was renamed", () => {
    const { params } = sampleParamsToSend(
      [
        { name: "", dataType: "string" },
        { name: "state", dataType: "string" },
      ],
      { "": "junk", oldName: "stale", state: "open" },
    );
    expect(params).toEqual({ state: "open" });
  });
});

describe("hostOf", () => {
  it("names the host", () => {
    expect(hostOf("https://api.example.com/incidents?x=1")).toBe("api.example.com");
    // ⚠ A port is part of the host — a confirmation that named `api.example.com`
    // for a call going to `:8443` would name the wrong thing.
    //
    // ⚠ And NOT `:8080`: `ui-honesty-check.sh` forbids Kestra's address anywhere
    // under `packages/client`, and it caught this line twice while the fixture was
    // being written. The pin is right — a client file that spells out an internal
    // host is how one reaches a rendered string — so the fixture moved, not the pin.
    expect(hostOf("https://api.example.com:8443/mail/send")).toBe("api.example.com:8443");
  });

  /** ⚠ Shows what was typed. "the endpoint" would hide the actual problem. */
  it("falls back to the raw string when the URL will not parse", () => {
    expect(hostOf(" api.example.com ")).toBe("api.example.com");
  });
});

/**
 * `liveConfirmBody` — P2 · T17.
 *
 * ⚠ The two things this sentence must never do: promise the call is safe, and
 * print a sample VALUE. Both are asserted.
 */
describe("liveConfirmBody", () => {
  it("names the method, the host and the consequence", () => {
    const body = liveConfirmBody({
      method: "post",
      url: "https://api.example.com/incidents",
      paramNames: [],
    });
    expect(body).toContain("This sends a real POST to api.example.com.");
    expect(body).toContain("If this endpoint creates or changes data, it will.");
    expect(body).toContain("It sends no parameters.");
    expect(body).toContain("Nothing is saved either way.");
  });

  it("names the parameter KEYS and never a value", () => {
    const body = liveConfirmBody({
      method: "POST",
      url: "https://api.example.com/incidents",
      paramNames: ["title", "assignee"],
    });
    expect(body).toContain("It sends the parameters title, assignee.");
    expect(body).not.toContain("probe");
  });

  it("says “the parameter”, singular, for one", () => {
    expect(
      liveConfirmBody({ method: "PUT", url: "https://h/x", paramNames: ["id"] }),
    ).toContain("It sends the parameter id.");
  });

  /**
   * ⚠ The confirmation states a fact about FOUNDRY (it is sending a real POST),
   * never a prediction about the endpoint. "will create", "safe", "harmless" are
   * all claims Foundry cannot make about somebody else's API.
   */
  it("promises nothing about what the endpoint will do", () => {
    const body = liveConfirmBody({ method: "DELETE", url: "https://h/x", paramNames: ["id"] });
    expect(body).not.toMatch(/safe|harmless|test data|will create|no effect/i);
  });
});

/**
 * ── The tested marker ───────────────────────────────────────────────────────
 * `specs/20260818-123807-tool-probe` · P3 · T22, T23
 */
const MARK = (over: Partial<ToolProbeMark> = {}): ToolProbeMark => ({
  at: "2026-08-24T09:00:00.000Z",
  verdict: "ok",
  mode: "live",
  status: 200,
  ...over,
});

describe("probeMarkFromWire", () => {
  it("passes a well-formed marker through", () => {
    expect(probeMarkFromWire(MARK())).toEqual(MARK());
  });

  it("answers null for an absent marker, however it is absent", () => {
    for (const raw of [null, undefined, "", 0, {}, []]) {
      expect(probeMarkFromWire(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  /**
   * ⚠ **THE ONE THAT MATTERS.** A newer server adding an eleventh verdict would
   * otherwise reach `TITLE[verdict]` and render the literal `undefined` in a pill
   * on every affected row. No statement is the honest fallback.
   */
  it("refuses a verdict word this build does not know", () => {
    expect(probeMarkFromWire(MARK({ verdict: "probably_fine" as ToolProbeVerdict }))).toBeNull();
  });

  it("refuses a mode it does not know, and a missing timestamp", () => {
    expect(probeMarkFromWire({ ...MARK(), mode: "yolo" })).toBeNull();
    expect(probeMarkFromWire({ ...MARK(), at: "" })).toBeNull();
  });

  it("normalises a missing status to null rather than dropping the marker", () => {
    // A timeout has no status. The marker is still a fact about a real attempt.
    const m = probeMarkFromWire({ ...MARK({ verdict: "timeout" }), status: undefined });
    expect(m).toEqual(MARK({ verdict: "timeout", status: null }));
  });

  /**
   * ⚠ The verdict list is `Object.keys(TONE)`, not a second literal — so this
   * loop is the guard that every verdict the panel can render is also a verdict a
   * marker can carry. A hand-kept copy would drift in the direction of silently
   * hiding real results.
   */
  it("accepts every verdict the panel knows how to render", () => {
    const all: ToolProbeVerdict[] = [
      "ok", "reachable", "auth_rejected", "forbidden", "not_found",
      "upstream_error", "client_error", "unreachable", "egress_refused", "timeout",
    ];
    for (const verdict of all) {
      expect(probeMarkFromWire(MARK({ verdict })), verdict).not.toBeNull();
    }
  });
});

describe("agoWords", () => {
  const at = "2026-08-24T09:00:00.000Z";
  const t = (iso: string) => Date.parse(iso);

  it.each([
    ["2026-08-24T09:00:30.000Z", "just now"],
    ["2026-08-24T09:04:00.000Z", "4 min ago"],
    ["2026-08-24T10:00:00.000Z", "1 hour ago"],
    ["2026-08-24T14:00:00.000Z", "5 hours ago"],
    ["2026-08-25T10:00:00.000Z", "1 day ago"],
    ["2026-08-28T09:00:00.000Z", "4 days ago"],
  ])("reads %s as “%s”", (now, expected) => {
    expect(agoWords(at, t(now))).toBe(expected);
  });

  /** ⚠ A real state: two containers, one clock behind. Not "in -3 min". */
  it("says “just now” rather than a negative age when the clock is skewed", () => {
    expect(agoWords(at, t("2026-08-24T08:57:00.000Z"))).toBe("just now");
  });

  it("answers null for an unparseable instant instead of “NaN min ago”", () => {
    expect(agoWords("whenever", t(at))).toBeNull();
  });
});

describe("markLine", () => {
  const now = Date.parse("2026-08-24T09:04:00.000Z");

  it("reads as one plain line: what, how it went, how long ago", () => {
    expect(markLine(MARK(), now)).toBe("tested · call succeeded · 4 min ago");
  });

  /**
   * ⚠ **THE ASSERTION THIS LINE EXISTS FOR.** A reachability marker is read weeks
   * later with no context, and *"tested · host reachable"* on its own is the false
   * green the whole feature removes. The caveat is part of the line, not a tooltip.
   */
  it("says the endpoint was not invoked for a reachability marker", () => {
    const line = markLine(MARK({ mode: "reachability", verdict: "reachable" }), now);
    expect(line).toBe("tested · host reachable · 4 min ago · endpoint not invoked");
  });

  it("does not add that clause to a live marker — the call WAS made", () => {
    expect(markLine(MARK(), now)).not.toContain("not invoked");
  });

  it("uses the same verdict words as the panel, so the two cannot disagree", () => {
    expect(markLine(MARK({ verdict: "not_found" }), now)).toContain("path not found");
    expect(markLine(MARK({ verdict: "auth_rejected" }), now)).toContain("credential rejected");
  });

  /** ⚠ Never the word this feature exists to avoid, on any verdict. */
  it("never says “working”", () => {
    const all: ToolProbeVerdict[] = [
      "ok", "reachable", "auth_rejected", "forbidden", "not_found",
      "upstream_error", "client_error", "unreachable", "egress_refused", "timeout",
    ];
    for (const verdict of all) {
      for (const mode of ["live", "reachability"] as const) {
        expect(markLine(MARK({ verdict, mode }), now), `${verdict}/${mode}`).not.toMatch(
          /working|healthy|all good/i,
        );
      }
    }
  });

  it("drops the age rather than the line when the instant will not parse", () => {
    const line = markLine(MARK({ at: "whenever" }), now);
    expect(line).toBe("tested · call succeeded");
  });
});
