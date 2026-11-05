import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMPORTS,
  assertConformance,
  buildFragmentPrompt,
  contractFieldSchema,
  enrichContractWithInputShapes,
  FragmentContractError,
  parseFragmentResponse,
  validateFragment,
  type StepContract,
} from "./step-contract.service.js";

/**
 * The `insufficient_contract` refusal and the contract it hangs off.
 * archive/kestra-migration/06-failure-triage.md §6.7 · 09 §13 assertions 18, 20, 32
 *
 * Assertion 32 is the one that matters: *"give a fragment a contract lacking a
 * needed field → assert it returns `insufficient_contract` and does not invent a
 * value."* Half of that is a property of the MODEL and cannot be unit-tested;
 * what IS testable here — and what actually failed in the measured run — is
 * whether the interface even permits the refusal. A generator with one output
 * channel cannot refuse no matter how good it is.
 */

const contract: StepContract = {
  stepId: "compute_variance",
  purpose: "compute attendance variance per employee",
  input: [
    { name: "attendance", type: "array", items: "object", description: "employee_id, days_present, days_expected" },
    { name: "threshold", type: "number" },
  ],
  output: [{ name: "rows", type: "array", items: "object" }],
};

describe("buildFragmentPrompt — what a fragment is and is NOT told", () => {
  const prompt = buildFragmentPrompt(contract);

  it("offers the refusal channel, not only 'produce code'", () => {
    // §6.7: "Any prompt that offers only 'produce code' is misconfigured — that
    // is the condition under which a model invents a value." This assertion is
    // the whole mitigation for the hardcoded-date failure.
    expect(prompt).toContain("insufficient_contract");
    expect(prompt).toMatch(/refusal is a correct and useful answer/i);
    expect(prompt).toMatch(/Do not invent a value/i);
  });

  it("names the exact importable set", () => {
    for (const mod of ALLOWED_IMPORTS) expect(prompt).toContain(mod);
    // Otherwise the model reaches for `requests` and the ImportError reads as a
    // code bug rather than a misconfiguration (04 §5.3.2).
    expect(prompt).not.toContain("requests");
  });

  it("contains the contract and nothing about the wider automation", () => {
    expect(prompt).toContain("attendance");
    expect(prompt).toContain("threshold");
    expect(prompt).toContain("rows");
    // Assertion 18 — no fragment's prompt may carry the automation goal, the
    // manifest, or a sibling step. Those are how a pure function starts
    // referencing things it cannot reach.
    for (const leak of ["mail_send", "manifest", "hr_demo", "SELECT", "workspace"]) {
      expect(prompt).not.toContain(leak);
    }
  });

  it("keeps TASK last, so sibling fragments share a byte-identical prefix", () => {
    // Same rule as the monolithic prompt, different payoff: at a few hundred
    // tokens the win is not caching, it is that two fragments in one flow differ
    // ONLY in their final block — which is what makes "three independent
    // generations" checkable by diffing.
    const other = buildFragmentPrompt({ ...contract, stepId: "format_report", purpose: "format a report" });
    const idx = prompt.indexOf("TASK");
    expect(idx).toBeGreaterThan(0);
    expect(prompt.slice(0, idx)).toBe(other.slice(0, other.indexOf("TASK")));
    expect(prompt.indexOf("RULES")).toBeLessThan(idx);
  });

  it("does not mention a sibling step even when one shares the flow", () => {
    // There is no parameter through which it could — checked so that adding one
    // "for context" has to break a test rather than pass review.
    expect(buildFragmentPrompt(contract)).not.toContain("format_report");
  });
});

describe("parseFragmentResponse — two channels, and only two", () => {
  it("reads a refusal, with the missing field named", () => {
    const r = parseFragmentResponse(
      JSON.stringify({
        status: "insufficient_contract",
        missing: ["period"],
        reason: "cannot compute a monthly window; no date field in declared input",
      }),
      "compute_variance",
    );
    expect(r.status).toBe("insufficient_contract");
    // The diagnosis names the FIX. Compare "step 3 failed", which names a step.
    if (r.status === "insufficient_contract") expect(r.missing).toEqual(["period"]);
  });

  it("reads code out of a markdown fence", () => {
    const r = parseFragmentResponse(
      'Sure!\n```json\n{"status":"ok","code":"def run(payload):\\n    return {}"}\n```\n',
      "s",
    );
    expect(r.status).toBe("ok");
  });

  it("refuses a bare code string rather than assuming it is ok", () => {
    // The failure that would silently delete the refusal channel: if a
    // status-less response were read as "ok", a model that DID refuse in prose
    // would have its refusal compiled into a flow as code.
    expect(() => parseFragmentResponse('{"code":"def run(payload): return {}"}', "s")).toThrow(
      FragmentContractError,
    );
  });

  it("refuses a refusal that names nothing missing", () => {
    // "I can't do it" with no `missing` cannot drive a redraft — it is a level-0
    // route with no instruction attached.
    expect(() =>
      parseFragmentResponse('{"status":"insufficient_contract","missing":[],"reason":"no"}', "s"),
    ).toThrow(FragmentContractError);
  });
});

describe("validateFragment — the cheap checks, before anything deploys", () => {
  const ok = "def run(payload):\n    return {'rows': payload['attendance']}\n";

  it("passes a pure fragment", () => {
    expect(validateFragment(ok, contract)).toEqual([]);
  });

  it("rejects a fragment with no run()", () => {
    expect(validateFragment("x = 1\n", contract)[0].message).toMatch(/def run\(payload\)/);
  });

  it.each([
    ["import requests", "requests"],
    ["from urllib.request import urlopen", "urllib"],
    ["import os, json", "os"],
    ["import socket", "socket"],
  ])("rejects `%s` and names the available set", (line, mod) => {
    const f = validateFragment(`${line}\n${ok}`, contract);
    expect(f.some((x) => x.message.includes(mod))).toBe(true);
    expect(f.some((x) => x.message.includes("pandas"))).toBe(true);
  });

  it("allows the declared set, including submodules", () => {
    expect(validateFragment(`import json\nimport pandas as pd\nfrom collections import defaultdict\n${ok}`, contract)).toEqual([]);
  });

  it.each([
    ["open('/etc/passwd')", /open\(\)/],
    ["x = input()", /input\(\)/],
    ["print(payload)", /print\(\)/],
    ["__import__('socket')", /__import__/],
  ])("rejects the I/O attempt %s", (snippet, match) => {
    const f = validateFragment(`def run(payload):\n    ${snippet}\n    return {}\n`, contract);
    expect(f.some((x) => match.test(x.message))).toBe(true);
  });

  it("does not trip on an attribute or a dict key that merely reads like I/O", () => {
    // `payload.open_cases` and `payload["input"]` are ordinary data. A checker
    // that flags them makes the generator fight the validator over correct code.
    const code = "def run(payload):\n    n = payload['input']['open_cases']\n    return {'rows': [n]}\n";
    expect(validateFragment(code, contract)).toEqual([]);
  });
});

describe("assertConformance — did the step return what it declared", () => {
  it("accepts the declared shape", () => {
    expect(assertConformance({ rows: [{ a: 1 }] }, contract).ok).toBe(true);
  });

  it("names the missing field", () => {
    expect(assertConformance({ other: 1 }, contract)).toMatchObject({ ok: false, missing: ["rows"] });
  });

  it("treats null as missing, not as a wrong type", () => {
    // `{"rows": null}` has not produced rows. Calling it a type error routes it
    // to "bad code" when the useful diagnosis is the absent-value one.
    expect(assertConformance({ rows: null }, contract)).toMatchObject({ missing: ["rows"], mistyped: [] });
  });

  it("distinguishes an array from an object", () => {
    // `typeof [] === "object"` in JS, so a naive check passes an array where an
    // object was declared and vice versa — and a downstream jq expression then
    // fails somewhere else entirely.
    const c: StepContract = { ...contract, output: [{ name: "rows", type: "object" }] };
    expect(assertConformance({ rows: [] }, c).mistyped).toEqual([
      { field: "rows", want: "object", got: "array" },
    ]);
  });

  it("ignores extra keys", () => {
    // The contract is a floor, not a ceiling — a fragment returning debug
    // fields alongside the declared ones is not a violation.
    expect(assertConformance({ rows: [], notes: "x" }, contract).ok).toBe(true);
  });

  it("fails a non-object return without pretending a field was present", () => {
    expect(assertConformance([1, 2, 3], contract)).toMatchObject({ ok: false, missing: ["rows"] });
  });

  it("accepts anything for an `any` field", () => {
    const c: StepContract = { ...contract, output: [{ name: "rows", type: "any" }] };
    expect(assertConformance({ rows: "a string" }, c).ok).toBe(true);
  });
});

/**
 * A type name written the way another language spells it.
 *
 * ── Why this is normalised rather than rejected ──────────────────────────────
 *
 * Measured against the live gateway: a real draft was rejected on attempt 1 with
 * `contract.input.2.type — Invalid enum value … received 'integer'`, and the
 * redraft cost ~30 s of decode re-emitting the entire flow. `integer` is not a
 * design mistake; it is `number` spelled the way Python and JSON Schema spell it.
 *
 * ⚠ The bound is the test that matters here: this maps a NAME to a name and must
 * never grow into guessing at STRUCTURE. See `TYPE_SYNONYMS`.
 */
describe("contract type synonyms", () => {
  const field = (type: string) =>
    contractFieldSchema.safeParse({ name: "n", type });

  it("accepts the ways other languages spell our six", () => {
    for (const [given, want] of [
      ["integer", "number"],
      ["int", "number"],
      ["float", "number"],
      ["bool", "boolean"],
      ["str", "string"],
      ["list", "array"],
      ["dict", "object"],
    ] as const) {
      const r = field(given);
      expect(r.success, `${given} should normalise`).toBe(true);
      if (r.success) expect(r.data.type).toBe(want);
    }
  });

  it("is case-insensitive, because a drafter writes `Integer` too", () => {
    const r = field("Integer");
    expect(r.success && r.data.type).toBe("number");
  });

  it("normalises `items` as well — an array of ints is an array of numbers", () => {
    const r = contractFieldSchema.safeParse({ name: "n", type: "array", items: "integer" });
    expect(r.success && r.data.items).toBe("number");
  });

  /**
   * ⚠ The bound. A synonym has one reading; a structural guess does not. If this
   * ever accepts a word that is not one of the six under another name, the
   * normalisation has become a place where the drafter's declared contract and
   * the in-container check can disagree.
   */
  it("still refuses a type that is not one of the six under any name", () => {
    for (const bad of ["timestamp", "date", "employee", "enum", "bytes", ""]) {
      expect(field(bad).success, `${bad} must not be accepted`).toBe(false);
    }
  });
});

/**
 * The explicit string shape — defect 4 (2026-09-15, thread 80b119b1).
 *
 * The fragment vocabulary (string|number|boolean|object|array|any) could not
 * declare "this string is a YYYY-MM-DD date", so month-from-DATE derivation
 * was prose-lottery: the same contract sometimes sliced, sometimes refused
 * demanding a period_format input. `format` is machine truth (date=YYYY-MM-DD,
 * month=YYYY-MM, datetime=ISO, text=plain default). Working precedent b59ee524
 * turn 3 applied when the date shape was in prose; this pins it end-to-end
 * through fragment validation without prose luck.
 */
describe("contract string shape (format)", () => {
  it("parses the four shapes and defaults to absent (text)", () => {
    for (const format of ["date", "month", "datetime", "text"] as const) {
      const r = contractFieldSchema.safeParse({ name: "as_of", type: "string", format });
      expect(r.success, `${format} should parse`).toBe(true);
      if (r.success) expect(r.data.format).toBe(format);
    }
    const absent = contractFieldSchema.safeParse({ name: "as_of", type: "string" });
    expect(absent.success && (absent.data.format ?? null)).toBeNull();
  });

  it("refuses a shape that is not one of the four", () => {
    for (const bad of ["YYYY-MM-DD", "timestamp", "email", ""]) {
      expect(
        contractFieldSchema.safeParse({ name: "as_of", type: "string", format: bad }).success,
        `${bad} must not be accepted`,
      ).toBe(false);
    }
  });

  it("renders date/month shapes in the prompt and keeps text byte-identical", () => {
    const base: StepContract = {
      stepId: "derive_month",
      purpose: "derive YYYY-MM month from a YYYY-MM-DD date",
      input: [{ name: "as_of", type: "string", format: "date" }],
      output: [{ name: "month", type: "string", format: "month" }],
    };
    const prompt = buildFragmentPrompt(base);
    // Machine shape, not prose luck: the fragment sees the ten-vs-seven truth.
    expect(prompt).toContain("as_of: string (date YYYY-MM-DD)");
    expect(prompt).toContain("month: string (month YYYY-MM)");
    expect(prompt).toContain("Do NOT refuse for a period_format-style input");
    // `text` and absent render identically — old contracts pay no bytes.
    const asText: StepContract = {
      ...base,
      input: [{ name: "as_of", type: "string", format: "text" }],
      output: [{ name: "month", type: "string" }],
    };
    const asAbsent: StepContract = {
      ...base,
      input: [{ name: "as_of", type: "string" }],
      output: [{ name: "month", type: "string" }],
    };
    expect(buildFragmentPrompt(asText)).toBe(buildFragmentPrompt(asAbsent));
  });

  it("DATE-declared input → shape-declared contract → slice validates without demanding period_format", () => {
    // The live shape: fetch.period (DATE YYYY-MM-DD) → derive_month.month
    // (YYYY-MM) with no derive step, filed applied. With the shape declared,
    // the fragment writes the slice and static validation passes — no
    // insufficient_contract for a period_format input, no prose needed.
    const contract: StepContract = {
      stepId: "derive_month",
      purpose: "derive YYYY-MM month from fetch period DATE",
      input: [{ name: "period", type: "string", format: "date", description: "YYYY-MM-DD from DATE input period" }],
      output: [{ name: "month", type: "string", format: "month" }],
    };
    const prompt = buildFragmentPrompt(contract);
    expect(prompt).toContain("period: string (date YYYY-MM-DD)");
    const code = `def run(payload):\n    return {"month": payload["period"][:7]}`;
    expect(validateFragment(code, contract)).toEqual([]);
  });
});

/**
 * Prompt-time shape stamping from declared flow inputs (2026-09-15).
 *
 * The sweep failure: a step reading a DATE input refused its fragment unless
 * the model happened to write `format: "date"` — prose-lottery. The flow
 * knows the shape, so the enrichment stamps it onto the prompt-time copy.
 */
describe("enrichContractWithInputShapes — the flow knows the shape", () => {
  const modelFor = (inputExpr: string) =>
    ({ steps: [{ id: "derive", kind: "code", inputExpr }] }) as never;
  const declared = [
    { id: "run_day", type: "DATE" },
    { id: "note", type: "STRING" },
  ];
  const base: StepContract = {
    stepId: "derive",
    purpose: "derive month",
    input: [{ name: "run_day", type: "string" }],
    output: [{ name: "month", type: "string", format: "month" }],
  };

  it("stamps date onto a bare {{ inputs.X }} read", () => {
    const out = enrichContractWithInputShapes(base, modelFor("{{ inputs.run_day }}"), declared);
    expect(out.input[0]).toMatchObject({ name: "run_day", format: "date" });
    expect(buildFragmentPrompt(out)).toContain("run_day: string (date YYYY-MM-DD)");
  });

  it("stamps by payload key for object inputExpr", () => {
    const withTwo: StepContract = {
      ...base,
      input: [
        { name: "day", type: "string" },
        { name: "note", type: "string" },
      ],
    };
    const out = enrichContractWithInputShapes(
      withTwo,
      modelFor('{"day": {{ inputs.run_day }}, "note": {{ inputs.note }}}'),
      declared,
    );
    expect(out.input[0]).toMatchObject({ format: "date" });
    expect(out.input[1]).not.toHaveProperty("format");
  });

  it("never overwrites an explicit format", () => {
    const explicit: StepContract = {
      ...base,
      input: [{ name: "run_day", type: "string", format: "text" }],
    };
    const out = enrichContractWithInputShapes(explicit, modelFor("{{ inputs.run_day }}"), declared);
    expect(out).toBe(explicit);
  });

  it("returns the contract untouched when nothing shaped is read", () => {
    expect(enrichContractWithInputShapes(base, modelFor("{{ inputs.note }}"), declared)).toBe(base);
    expect(enrichContractWithInputShapes(base, modelFor("{{ inputs.run_day }}"), [])).toBe(base);
  });

  it("leaves ambiguous multi-reads for the model", () => {
    const two: StepContract = {
      ...base,
      input: [
        { name: "a", type: "string" },
        { name: "b", type: "string" },
      ],
    };
    const out = enrichContractWithInputShapes(two, modelFor("{{ inputs.run_day }} + {{ inputs.note }}"), [
      ...declared,
      { id: "other", type: "DATETIME" },
    ]);
    expect(out).toBe(two);
  });
});
