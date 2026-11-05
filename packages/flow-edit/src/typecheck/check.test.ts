import { describe, it, expect } from "vitest";
import { checkFlow } from "./check.js";
import { renderDiagnostic, type DiagnosticCode } from "./diagnostic.js";
import { TypeOf as T } from "./index.js";
import type { CatalogueSnapshot, CheckModel, CheckStep } from "./signature.js";

/**
 * Phase 1 task 7: every rule has one FIRING fixture and one CONTROL that must
 * not fire (I-38 — a rule that cannot fail is worse than none; I-62 — a rule
 * that cries wolf gets widened until it permits the defect).
 *
 * Every fixture is a one-change mutation of `CLEAN`, which is itself asserted
 * to produce NO diagnostics — so a firing test proves the change, not noise.
 */

const ROW = T.record({ vendor_email: T.address(), vendor: T.text(), amount: T.int(), due: T.dateTime(), note: T.option(T.text()) });
const CAT: CatalogueSnapshot = {
  refs: {
    "fin.invoices_past_due": { kind: "operation", params: [{ name: "as_of", ty: T.date(), required: true }], payload: T.rows(ROW) },
    "fin.raw_json": { kind: "query", params: [], payload: T.rows(T.json()) },
    foundry_email_send: {
      kind: "tool",
      params: [
        { name: "to", ty: T.address(), required: true },
        { name: "subject", ty: T.text([{ r: "SingleLine" }, { r: "MaxLen", n: 250 }]), required: true },
        { name: "body", ty: T.text(), required: true },
      ],
      payload: T.opaque(),
    },
    chat_post_message: {
      kind: "tool",
      params: [
        { name: "channel", ty: T.text([{ r: "OneOf", values: ["#finance", "#hr-ops"] }]), required: true },
        { name: "text", ty: T.text(), required: true },
        { name: "count", ty: T.int(), required: false },
        { name: "author", ty: T.text(), required: false },
      ],
      payload: T.opaque(),
    },
    llm_complete: { kind: "tool", params: [{ name: "input", ty: T.text(), required: true }], payload: T.record({ text: T.text() }), modelText: true },
  },
};

const read: CheckStep = { id: "read", kind: "datasource", ref: "fin.invoices_past_due", inputs: [{ name: "as_of", source: { from: "input", inputId: "as_of" } }] };
const send: CheckStep = {
  id: "send",
  kind: "tool",
  ref: "foundry_email_send",
  dependsOn: ["read"],
  over: { stepId: "read", field: "" },
  inputs: [
    { name: "to", source: { from: "step", stepId: "read", field: "vendor_email" } },
    { name: "subject", source: { from: "literal", value: "Invoices past due" } },
    { name: "body", source: { from: "step", stepId: "read", field: "vendor" } },
  ],
};
const CLEAN: CheckModel = { id: "chase", inputs: [{ id: "as_of", type: "DATE" }], steps: [read, send] };

type Mut = (m: CheckModel) => CheckModel;
const clone = (m: CheckModel): CheckModel => JSON.parse(JSON.stringify(m));
const step = (m: CheckModel, id: string) => m.steps.find((s) => s.id === id)!;
const bind = (m: CheckModel, stepId: string, port: string) => step(m, stepId).inputs!.find((b) => b.name === port)!;
const codes = (m: CheckModel) => checkFlow(m, CAT).map((d) => d.code);

function rule(code: DiagnosticCode, fires: Mut, control: Mut, span?: { stepId?: string; port?: string }) {
  describe(code, () => {
    it("fires", () => {
      const ds = checkFlow(fires(clone(CLEAN)), CAT).filter((d) => d.code === code);
      expect(ds.length, `expected ${code}`).toBeGreaterThan(0);
      if (span) expect(ds[0]!.span).toMatchObject(span);
    });
    it("CONTROL: does not fire", () => {
      expect(codes(control(clone(CLEAN)))).not.toContain(code);
    });
  });
}

describe("the clean flow is clean", () => {
  // Its fan-out is over a reader directly — the LEGACY shape — so the only finding is FT0510's warning (compiled-builder 2e).
  it("produces no diagnostics but the legacy-fan-out warning", () => expect(checkFlow(CLEAN, CAT).map((d) => d.code)).toEqual(["FT0510"]));
});

// ── Shape ──
rule("FT0102", (m) => { step(m, "send").over = { stepId: "reed", field: "" }; return m; }, (m) => m, { stepId: "send" });
rule("FT0105", (m) => { step(m, "read").ref = "fin.invoices_pastdue"; return m; }, (m) => m, { stepId: "read" });

// ── Binding ──
rule("FT0201", (m) => { step(m, "send").inputs = step(m, "send").inputs!.filter((b) => b.name !== "to"); return m; }, (m) => m, { stepId: "send", port: "to" });
rule("FT0202", (m) => { bind(m, "send", "body").source = { from: "step", stepId: "read", field: "amount" }; return m; },
  (m) => { bind(m, "send", "body").source = { from: "step", stepId: "read", field: "amount", transform: "text" }; return m; }, { port: "body" });
rule("FT0203", (m) => { bind(m, "send", "body").source = { from: "step", stepId: "read", field: "note" }; return m; }, (m) => m, { port: "body" });
rule("FT0205", (m) => { m.inputs!.push({ id: "unused", type: "STRING" }); return m; }, (m) => m);
rule("FT0207", (m) => {
  m.steps.push({ id: "summary", kind: "tool", ref: "llm_complete", inputs: [{ name: "input", source: { from: "literal", value: "hi" } }] });
  step(m, "send").over = { stepId: "summary", field: "" };
  bind(m, "send", "to").source = { from: "literal", value: "a@b.example" };
  bind(m, "send", "body").source = { from: "step", stepId: "summary", field: "text" };
  m.output = { stepId: "summary" };
  return m;
}, (m) => m);
rule("FT0208", (m) => {
  m.steps.push({ id: "raw", kind: "datasource", ref: "fin.raw_json", inputs: [] });
  bind(m, "send", "body").source = { from: "step", stepId: "raw", field: "anything" };
  return m;
}, (m) => {
  m.steps.push({ id: "raw", kind: "datasource", ref: "fin.raw_json", inputs: [] });
  bind(m, "send", "body").source = { from: "step", stepId: "raw", field: "anything", transform: "text" };
  return m;
});
rule("FT0209", (m) => { step(m, "send").inputs!.push({ name: "recipient", source: { from: "literal", value: "x" } }); return m; }, (m) => m, { port: "recipient" });

// ── Fields ──
rule("FT0301", (m) => { bind(m, "send", "to").source = { from: "step", stepId: "read", field: "customer_email" }; return m; }, (m) => m, { stepId: "send", port: "to" });
// A drafted `{from, program, fields}` reshape: a read of a field it does not
// declare is FT0302 (the declaration's claim), never FT0301 (a schema's).
const withShape = (field: string): Mut => (m) => {
  m.steps.push({ id: "shape", kind: "transform", dependsOn: ["read"], fields: ["who", "email"] });
  m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["shape"], inputs: [
    { name: "channel", source: { from: "literal", value: "#finance" } },
    { name: "text", source: { from: "step", stepId: "shape", field } },
  ] });
  return m;
};
rule("FT0302", withShape("emial"), withShape("who"), { stepId: "post", port: "text" });
describe("a declared reshape's list-or-object shape follows its program", () => {
  const fanOver = (expr: string): Mut => (m) => {
    m.steps.push({ id: "shape", kind: "transform", dependsOn: ["read"], fields: ["who"], expr });
    m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["shape"], over: { stepId: "shape", field: "" }, inputs: [
      { name: "channel", source: { from: "literal", value: "#finance" } },
      { name: "text", source: { from: "step", stepId: "shape", field: "who" } },
    ] });
    return m;
  };
  it("a program returning a list may be fanned out over (no FT0207)", () => {
    expect(codes(fanOver("{{ json(outputs.read.body).results[0].data | jq('[.[] | {who: .vendor}]') | first }}")(clone(CLEAN)))).not.toContain("FT0207");
  });
  it("a program that pipes into map() is a list too (build:measure R01 r7)", () => {
    expect(codes(fanOver("{{ json(outputs.read.body).results[0].data | jq('(.rows | map({who: .vendor}))') | first }}")(clone(CLEAN)))).not.toContain("FT0207");
  });
  it("r11 R11: one object via the lowering's if/else — a text read of it is not List (no FT0202)", () => {
    const m = clone(CLEAN);
    m.steps.push({ id: "shape", kind: "transform", dependsOn: ["read"], fields: ["text"], expr: "{{ json(outputs.read.body).results[0].data | jq('(map(.vendor) as $v | {text: ($v | join(\",\"))}) | if type == \"string\" then {text: .} else . end') | first }}" });
    m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["shape"], inputs: [
      { name: "channel", source: { from: "literal", value: "#finance" } },
      { name: "text", source: { from: "step", stepId: "shape", field: "text" } },
    ] });
    expect(codes(m)).not.toContain("FT0202");
  });
  it("CONTROL: an undecidable program is not judged for fan-out either (no FT0207)", () => {
    expect(codes(fanOver("{{ json(outputs.read.body).results[0].data | jq('.[0]') | first }}")(clone(CLEAN)))).not.toContain("FT0207");
  });
  it("CONTROL: a program returning one object may not", () => {
    expect(codes(fanOver("{{ json(outputs.read.body).results[0].data | jq('{who: .[0].vendor}') | first }}")(clone(CLEAN)))).toContain("FT0207");
  });
});
describe("a whole output bound as text", () => {
  const wholeInto = (transform?: "text"): Mut => (m) => {
    m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["read"], inputs: [
      { name: "channel", source: { from: "literal", value: "#finance" } },
      { name: "text", source: { from: "whole", stepId: "read", ...(transform ? { transform } : {}) } },
    ] });
    return m;
  };
  it("is Text for a text port — no mismatch, no raw-rows finding", () => {
    const cs = codes(wholeInto("text")(clone(CLEAN)));
    expect(cs).not.toContain("FT0202");
    expect(cs).not.toContain("FT0501");
  });
  it("CONTROL: the raw rows into the same port are refused", () => {
    const cs = codes(wholeInto()(clone(CLEAN)));
    expect(cs.some((c) => c === "FT0202" || c === "FT0501")).toBe(true);
  });
});
describe("a literal carrying {{ inputs.x }} placeholders", () => {
  const subj = (v: string): Mut => (m) => { bind(m, "send", "subject").source = { from: "literal", value: v }; return m; };
  it("is a checked read of the input, not an unchecked template", () => {
    const cs = codes(subj("Past due as of {{ inputs.as_of }}")(clone(CLEAN)));
    expect(cs).not.toContain("FT0602");
    expect(cs).not.toContain("FT0205"); // the input IS read
  });
  it("CONTROL: any other template is still FT0602", () => {
    expect(codes(subj("{{ outputs.read.body }}")(clone(CLEAN)))).toContain("FT0602");
  });
});
describe("a list port that accepts ONE element in its place (liftsScalar)", () => {
  const withTo = (liftsScalar: boolean): CatalogueSnapshot => ({
    ...CAT,
    refs: {
      ...CAT.refs,
      foundry_email_send: {
        ...CAT.refs.foundry_email_send!,
        params: CAT.refs.foundry_email_send!.params.map((p) => (p.name === "to" ? { ...p, ty: T.list(T.address()), ...(liftsScalar ? { liftsScalar } : {}) } : p)),
      },
    },
  });
  // FT0510 (the legacy fan-out warning, 2e) is about the fan-out, not this port; filtered so the test stays about lifting.
  const on = (cat: CatalogueSnapshot, m: CheckModel) => checkFlow(m, cat).map((d) => d.code).filter((c) => c !== "FT0510");
  it("takes one address — a per-row field or a literal — where the list is", () => {
    expect(on(withTo(true), clone(CLEAN))).toEqual([]);
    const lit = clone(CLEAN);
    bind(lit, "send", "to").source = { from: "literal", value: "ops@acme.example" };
    expect(on(withTo(true), lit)).toEqual([]);
  });
  it("still checks the literal as an address", () => {
    const lit = clone(CLEAN);
    bind(lit, "send", "to").source = { from: "literal", value: "not an address" };
    expect(on(withTo(true), lit)).toContain("FT0401");
  });
  it("CONTROL: the same list port WITHOUT the flag refuses one address", () => {
    expect(on(withTo(false), clone(CLEAN))).toContain("FT0202");
  });
});
describe("FT0302 names the declaration", () => {
  it("suggests the declared field and says it is a declaration", () => {
    const d = checkFlow(withShape("emial")(clone(CLEAN)), CAT).find((x) => x.code === "FT0302")!;
    expect(d.help).toBe("did you mean `email`?");
    expect(d.note).toBe("`shape` declares: who, email");
    expect(checkFlow(withShape("emial")(clone(CLEAN)), CAT).map((x) => x.code)).not.toContain("FT0301");
  });
});
describe("typed guard and evidence reads are bindings (phase 3 step 4)", () => {
  const guard = (field: string): Mut => (m) => {
    m.steps.push({ id: "any_big", kind: "branch", dependsOn: ["read"], test: { left: { from: "step", stepId: "read", field }, operator: "field_gt", right: "100" } });
    return m;
  };
  it("a branch test naming a field the upstream lacks is FT0301, at the test", () => {
    const d = checkFlow(guard("amout")(clone(CLEAN)), CAT).find((x) => x.code === "FT0301")!;
    expect(d.span).toMatchObject({ stepId: "any_big", port: "test" });
    expect(d.help).toBe("did you mean `amount`?");
  });
  it("CONTROL: a real field is not", () => {
    expect(codes(guard("amount")(clone(CLEAN)))).not.toContain("FT0301");
  });
  const gate = (ctx: unknown): Mut => (m) => {
    m.steps.push({ id: "shape", kind: "transform", dependsOn: ["read"], fields: ["who", "email"] });
    m.steps.push({ id: "ok_to_send", kind: "approval", dependsOn: ["shape"], summary: "Send?", context: ctx });
    return m;
  };
  it("an approval shown raw query rows (timestamps) is FT0501 — I-42, as for a call", () => {
    expect(codes(gate({ from: "whole", stepId: "read" })(clone(CLEAN)))).toContain("FT0501");
  });
  it("CONTROL: shown a reshape's rows, it is clean of FT0501", () => {
    expect(codes(gate({ from: "whole", stepId: "shape" })(clone(CLEAN)))).not.toContain("FT0501");
  });
  it("an approval context naming no step does not crash the checker (lowering refuses it by name)", () => {
    expect(codes(gate({ from: "whole", stepId: "nope" })(clone(CLEAN)))).not.toContain("FT0501");
  });
});
rule("FT0304", (m) => {
  m.steps.push({ id: "mail2", kind: "tool", ref: "chat_post_message", dependsOn: ["send"], inputs: [
    { name: "channel", source: { from: "literal", value: "#finance" } },
    { name: "text", source: { from: "step", stepId: "send", field: "status" } },
  ] });
  return m;
}, (m) => m);

// ── Literals ──
rule("FT0401", (m) => { bind(m, "send", "to").source = { from: "literal", value: "not an address" }; return m; },
  (m) => { bind(m, "send", "to").source = { from: "literal", value: "ap@vendor.example" }; return m; }, { port: "to" });
rule("FT0402", (m) => { bind(m, "send", "subject").source = { from: "literal", value: "Invoices\npast due" }; return m; }, (m) => m, { port: "subject" });

// ── Data-flow policy ──
rule("FT0501", (m) => { bind(m, "send", "body").source = { from: "whole", stepId: "read" }; return m; }, (m) => m, { port: "body" });
rule("FT0502", (m) => {
  m.steps.push({ id: "summary", kind: "tool", ref: "llm_complete", inputs: [{ name: "input", source: { from: "literal", value: "hi" } }] });
  m.steps.push({ id: "decide", kind: "branch", dependsOn: ["summary"] });
  return m;
}, (m) => {
  // Posting the text is DELIVERY, not consumption.
  m.steps.push({ id: "summary", kind: "tool", ref: "llm_complete", inputs: [{ name: "input", source: { from: "literal", value: "hi" } }] });
  m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["summary"], inputs: [
    { name: "channel", source: { from: "literal", value: "#finance" } },
    { name: "text", source: { from: "step", stepId: "summary", field: "text" } },
  ] });
  return m;
});

describe("FT0502 follows the DECLARATION, never the name (I-292)", () => {
  const consume = (ref: string) => { const m = clone(CLEAN); m.steps.push({ id: "summary", kind: "tool", ref, inputs: [{ name: "input", source: { from: "literal", value: "hi" } }] }, { id: "decide", kind: "branch", dependsOn: ["summary"] }); return m; };
  const writer = { kind: "tool" as const, params: [{ name: "input", ty: T.text(), required: true }], payload: T.record({ text: T.text() }) };
  it("a tool declared as model text is protected whatever it is called; an undeclared one is not", () => {
    const cat = { ...CAT, refs: { ...CAT.refs, ghostwriter: { ...writer, modelText: true }, llm_complete: writer } };
    expect(checkFlow(consume("ghostwriter"), cat).some((d) => d.code === "FT0502")).toBe(true);
    expect(checkFlow(consume("llm_complete"), cat).some((d) => d.code === "FT0502")).toBe(false);
  });
});

describe("FT0503", () => {
  const ALLOW = { ...CAT, mailAllowedDomains: ["vendor.example"] };
  it("fires on data-sourced recipients when an allowlist is set", () => {
    expect(checkFlow(CLEAN, ALLOW).map((d) => d.code)).toContain("FT0503");
  });
  it("fires on a literal outside the allowed domains", () => {
    const m = clone(CLEAN);
    bind(m, "send", "to").source = { from: "literal", value: "ap@elsewhere.example" };
    expect(checkFlow(m, ALLOW).find((d) => d.code === "FT0503")!.message).toContain("elsewhere.example");
  });
  it("CONTROL: an allowed literal, or no allowlist at all, does not fire", () => {
    const m = clone(CLEAN);
    bind(m, "send", "to").source = { from: "literal", value: "ap@vendor.example" };
    expect(checkFlow(m, ALLOW).map((d) => d.code)).not.toContain("FT0503");
    expect(codes(CLEAN)).not.toContain("FT0503");
  });
});

// ── Expressions ──
rule("FT0602", (m) => { bind(m, "send", "subject").source = { from: "literal", value: "{{ outputs.read.body | first }} chase" }; return m; }, (m) => m, { port: "subject" });

// ── Compiler limits ──
rule("FT0702", (m) => {
  m.steps.push({ id: "t", kind: "transform", outputColumns: [{ name: "x", type: "string" }] });
  m.steps.push({ id: "j", kind: "merge", sources: ["read", "t"] });
  m.output = { stepId: "j" };
  return m;
}, (m) => {
  m.steps.push({ id: "j", kind: "merge", sources: ["read"] });
  m.output = { stepId: "j" };
  return m;
});

describe("behaviour a rule list does not show", () => {
  it("⚠ `source: null` with the key in `paramsExpr` is unchecked (FT0602), not unbound (FT0201)", () => {
    const m = clone(CLEAN);
    bind(m, "send", "body").source = null;
    step(m, "send").paramsExpr = '[{"body": {{ json(outputs.read.body) | jq(\'tostring | @json\') | first }}}]';
    const ds = checkFlow(m, CAT).filter((d) => d.span.port === "body");
    expect(ds.map((d) => d.code)).toEqual(["FT0602"]);
    // CONTROL: without the key in the blob it IS unbound.
    step(m, "send").paramsExpr = '[{"other": 1}]';
    expect(checkFlow(m, CAT).filter((d) => d.span.port === "body").map((d) => d.code)).toEqual(["FT0201"]);
  });

  it("a scalar into a Text port is a WARNING (lossless render, D-262); a Date into an Int is an error", () => {
    const m = clone(CLEAN);
    bind(m, "send", "body").source = { from: "input", inputId: "as_of" };
    expect(checkFlow(m, CAT).find((d) => d.code === "FT0202")!.severity).toBe("warning");
  });

  it("⚠ a nullable field bound to an OPTIONAL port is still FT0203 — optional means absent, not null", () => {
    const m = clone(CLEAN);
    m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["read"], over: { stepId: "read", field: "" }, inputs: [
      { name: "channel", source: { from: "literal", value: "#finance" } },
      { name: "text", source: { from: "literal", value: "hi" } },
      { name: "author", source: { from: "step", stepId: "read", field: "note" } },
    ] });
    expect(codes(m)).toContain("FT0203");
  });

  const countFrom = (fanOut: boolean): CheckModel => {
    const m = clone(CLEAN);
    m.steps.push({ id: "post", kind: "tool", ref: "chat_post_message", dependsOn: ["read"], ...(fanOut ? { over: { stepId: "read", field: "" } } : {}), inputs: [
      { name: "channel", source: { from: "literal", value: "#finance" } },
      { name: "text", source: { from: "literal", value: "hi" } },
      { name: "count", source: { from: "step", stepId: "read", field: "amount" } },
    ] });
    return m;
  };
  it("⚠ one field of MANY rows, with no fan-out, is a LIST — an Int port refuses it (O2)", () => {
    const d = checkFlow(countFrom(false), CAT).find((x) => x.span.port === "count");
    expect(d?.code).toBe("FT0202");
    expect(d?.message).toMatch(/every row's `amount` of `read`/);
  });
  it("CONTROL: fanned out over those rows it is one value per call, and fits", () => {
    expect(checkFlow(countFrom(true), CAT).filter((x) => x.span.port === "count")).toEqual([]);
  });

  it("a narrowing (Text → Address) is reported as a WARNING, not an error", () => {
    const m = clone(CLEAN);
    bind(m, "send", "to").source = { from: "step", stepId: "read", field: "vendor" };
    const d = checkFlow(m, CAT).find((d) => d.code === "FT0202")!;
    expect(d.severity).toBe("warning");
  });

  it("FT0301 suggests the real field and lists what the upstream returns", () => {
    const m = clone(CLEAN);
    bind(m, "send", "to").source = { from: "step", stepId: "read", field: "vendor_emial" };
    const d = checkFlow(m, CAT).find((d) => d.code === "FT0301")!;
    expect(d.help).toBe("did you mean `vendor_email`?");
    expect(d.note).toContain("vendor_email, vendor, amount, due, note");
  });

  it("a whole-template step is reported once as unsafe, and its ports are not guessed at", () => {
    const m = clone(CLEAN);
    const s = step(m, "send");
    s.inputs = [];
    s.paramsExpr = "{{ outputs.read.value | jq('[.[] | {to: .vendor_email}]') | first }}";
    const ds = checkFlow(m, CAT).filter((d) => d.span.stepId === "send" && d.code !== "FT0510");
    expect(ds.map((d) => d.code)).toEqual(["FT0602"]);
  });

  it("renders rustc-style", () => {
    const m = clone(CLEAN);
    bind(m, "send", "to").source = { from: "step", stepId: "read", field: "vendor_emial" };
    const text = renderDiagnostic(checkFlow(m, CAT)[0]!);
    expect(text).toMatch(/^error\[FT0301\]: /);
    expect(text).toContain("--> step `send`, input `to`, field `vendor_emial`");
    expect(text).toContain("= help: did you mean `vendor_email`?");
  });

  it("every diagnostic carries an owner, so a retry can be routed (D-248)", () => {
    const m = clone(CLEAN);
    step(m, "read").ref = "nope";
    bind(m, "send", "subject").source = { from: "literal", value: "a\nb" };
    for (const d of checkFlow(m, CAT)) expect(["skeleton", "wiring", "person"]).toContain(d.owner);
  });
});

describe("⚠ rules the server already has are NOT re-implemented here (D-261)", () => {
  it("an undeclared input, a dead step, a duplicate id and a cycle produce nothing from checkFlow", () => {
    const m = clone(CLEAN);
    m.inputs = [];
    m.steps.push({ id: "dead", kind: "transform", expr: "x" }, { ...read });
    step(m, "read").dependsOn = ["send"];
    const got = new Set(codes(m));
    for (const c of ["FT0101", "FT0103", "FT0104", "FT0204"]) expect(got.has(c as DiagnosticCode)).toBe(false);
  });
});

describe("FT0206 — the blob and the bindings disagree (I-204)", () => {
  const withBlob = (blob: string) => { const m = clone(CLEAN); step(m, "read").paramsExpr = blob; return m; };
  const ft0206 = (m: CheckModel, cat: CatalogueSnapshot = CAT) => checkFlow(m, cat).filter((d) => d.code === "FT0206");

  it("fires when the blob passes something the bindings do not — and it is an ERROR", () => {
    const ds = ft0206(withBlob('[{"as_of": "2026-06-30"}]'));
    expect(ds).toHaveLength(1);
    expect(ds[0]!.severity).toBe("error");
    expect(ds[0]!.span).toEqual({ stepId: "read" });
    expect(ds[0]!.message).toContain("paramsExpr");
  });
  it("CONTROL: a blob that says what the bindings render — spacing aside — is clean", () => {
    expect(checkFlow(withBlob('[{"as_of":"{{ inputs.as_of }}"}]'), CAT).filter((d) => d.code !== "FT0510")).toEqual([]);
  });
  it("CONTROL: bindings only (no blob) is clean", () => {
    expect(ft0206(CLEAN)).toEqual([]);
  });
  it("CONTROL: a blank blob beside bindings is ABSENT, not a second representation", () => {
    for (const blank of ["", "   ", "[{}]", "[{  }]", "{}"]) expect(ft0206(withBlob(blank))).toEqual([]);
  });
  it("CONTROL: a blob with NO bindings is the legacy unsafe block — FT0602, never FT0206", () => {
    const m = withBlob('[{"as_of": "2026-06-30"}]');
    step(m, "read").inputs = [];
    const got = codes(m);
    expect(got).toContain("FT0602");
    expect(got).not.toContain("FT0206");
  });
  it("CONTROL: a `source: null` binding declares itself partial — never FT0206", () => {
    const m = withBlob('[{"as_of": "2026-06-30"}]');
    bind(m, "read", "as_of").source = null;
    expect(codes(m)).not.toContain("FT0206");
  });

  it("uses the INJECTED compiler render, handed the step WITHOUT its blob", () => {
    const seen: Array<string | undefined> = [];
    const cat = (text: string | null): CatalogueSnapshot => ({ ...CAT, renderInputs: (s) => { seen.push(s.paramsExpr); return s.id === "send" ? text : null; } });
    const m = clone(CLEAN);
    step(m, "send").paramsExpr = "{{ outputs.read.body | jq('[.[] | {to: .vendor_email}]') | first }}";
    expect(ft0206(m, cat("{{ outputs.read.body | jq('[.[] | {to: .vendor_email, subject: \"x\"}]') | first }}"))).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === undefined)).toBe(true);
    // CONTROL: the same program (whitespace aside) agrees; an unrenderable feed decides nothing.
    expect(ft0206(m, cat("{{ outputs.read.body | jq('[.[] | {to: .vendor_email}]')   | first }}"))).toEqual([]);
    expect(ft0206(m, cat(null))).toEqual([]);
  });
  it("CONTROL: with no renderer injected a fan-out's step reads are not guessed at", () => {
    const m = clone(CLEAN);
    step(m, "send").paramsExpr = "{{ outputs.read.body | jq('[.[] | {to: .x}]') | first }}";
    expect(ft0206(m)).toEqual([]);
  });

  it("a code step's `inputExpr` is compared the same way", () => {
    const m = clone(CLEAN);
    m.steps.push({ id: "calc", kind: "code", dependsOn: ["read"], inputs: [{ name: "month", source: { from: "input", inputId: "as_of" } }], inputExpr: '{"month": "2026-06"}' });
    const cat = (text: string): CatalogueSnapshot => ({ ...CAT, renderInputs: (s) => (s.kind === "code" ? text : null) });
    const ds = ft0206(m, cat('{"month": "{{ inputs.as_of }}"}'));
    expect(ds.map((d) => d.span.stepId)).toEqual(["calc"]);
    expect(ds[0]!.message).toContain("inputExpr");
    expect(ft0206(m, cat('{"month":"2026-06"}'))).toEqual([]);
  });
});

// Phase 7 (showcase seed): `{{ inputs.m }}-01` over a MONTH input is a Date — the
// construction FT0403 already calls safe for days 01–28.
describe("a day of a month", () => {
  const withAsOf = (value: string, input: { id: string; type: string; format?: string }): CheckModel => {
    const m = clone(CLEAN);
    m.inputs = [input as never];
    bind(m, "read", "as_of").source = { from: "literal", value };
    return m;
  };
  it("{{ inputs.period }}-01 over a Month input is assignable to a Date", () => {
    expect(codes(withAsOf("{{ inputs.period }}-01", { id: "period", type: "STRING", format: "month" }))).not.toContain("FT0202");
  });
  it("CONTROL: over plain Text the checker cannot know it is a month, and still refuses", () => {
    expect(codes(withAsOf("{{ inputs.period }}-01", { id: "period", type: "STRING" }))).toContain("FT0202");
  });
  it("CONTROL: a day a month may not have (29–31) is not typed a Date", () => {
    expect(codes(withAsOf("{{ inputs.period }}-31", { id: "period", type: "STRING", format: "month" }))).toContain("FT0202");
  });
});

// ── Build-time policy (compiled-builder 2e) ──
describe("FT0507 — a literal recipient the deployment refuses is an error; a reserved one is the draft-only warning", () => {
  const ALLOW = { ...CAT, mailAllowedDomains: ["vendor.example"] };
  it("fires on a real domain outside the allowlist", () => {
    const m = clone(CLEAN); bind(m, "send", "to").source = { from: "literal", value: "ap@acme.com" };
    expect(checkFlow(m, ALLOW).map((d) => d.code)).toContain("FT0507");
  });
  it("CONTROL: a reserved .example address is FT0503 (a draft run captures it), not an error", () => {
    const m = clone(CLEAN); bind(m, "send", "to").source = { from: "literal", value: "ap@elsewhere.example" };
    const codes = checkFlow(m, ALLOW).map((d) => d.code);
    expect(codes).toContain("FT0503");
    expect(codes).not.toContain("FT0507");
  });
});

describe("FT0508 — an unattended send with no recipient", () => {
  const OPT = { ...CAT, refs: { ...CAT.refs, foundry_email_send: { ...CAT.refs.foundry_email_send!, params: CAT.refs.foundry_email_send!.params.map((p) => (p.name === "to" ? { ...p, required: false, fallsBackToRequester: true } : p)) } } };
  const unset = (m: CheckModel) => { step(m, "send").inputs = step(m, "send").inputs!.filter((b) => b.name !== "to"); return m; };
  it("fires when the flow is scheduled and the optional recipient is unset", () => {
    const m = unset(clone(CLEAN)); (m as { schedule?: unknown }).schedule = { cron: "0 9 * * 1" };
    expect(checkFlow(m, OPT).map((d) => d.code)).toContain("FT0508");
  });
  it("CONTROL: not scheduled (a person starts it, so the requester exists), or the recipient is set", () => {
    expect(checkFlow(unset(clone(CLEAN)), OPT).map((d) => d.code)).not.toContain("FT0508");
    const m = clone(CLEAN); (m as { schedule?: unknown }).schedule = { cron: "0 9 * * 1" };
    expect(checkFlow(m, OPT).map((d) => d.code)).not.toContain("FT0508");
  });
  it("⚠ CONTROL (I-287): an optional address port the receiver does NOT fill with the requester never fires", () => {
    const NOFALL = { ...OPT, refs: { ...OPT.refs, foundry_email_send: { ...OPT.refs.foundry_email_send!, params: OPT.refs.foundry_email_send!.params.map((p) => ({ ...p, fallsBackToRequester: false })) } } };
    const m = unset(clone(CLEAN)); (m as { schedule?: unknown }).schedule = { cron: "0 9 * * 1" };
    expect(checkFlow(m, NOFALL).map((d) => d.code)).not.toContain("FT0508");
  });
});

describe("FT0509 — a fan-out over a pipeline must be proven at most 1000", () => {
  const over = (limit: number | null): CheckModel => {
    const m = clone(CLEAN);
    const pipeline = [{ op: "project", fields: [{ name: "vendor_email", from: "vendor_email" }, { name: "vendor", from: "vendor" }] }, ...(limit === null ? [] : [{ op: "limit", n: { value: limit, from: "test" } }])];
    m.steps.splice(1, 0, { id: "rows", kind: "transform", from: "read", pipeline, dependsOn: ["read"] } as never);
    const s = step(m, "send");
    s.over = { stepId: "rows", field: "" }; s.dependsOn = ["rows"];
    for (const b of s.inputs!) if (b.source?.from === "step") (b.source as { stepId: string }).stepId = "rows";
    return m;
  };
  it("fires with no limit", () => expect(checkFlow(over(null), CAT).map((d) => d.code)).toContain("FT0509"));
  it("fires with a limit over 1000", () => expect(checkFlow(over(5000), CAT).map((d) => d.code)).toContain("FT0509"));
  it("CONTROL: limit 1000 proves the bound", () => {
    const codes = checkFlow(over(1000), CAT).map((d) => d.code);
    expect(codes).not.toContain("FT0509");
    expect(codes).not.toContain("FT0510");
  });
});
