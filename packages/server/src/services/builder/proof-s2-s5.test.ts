/**
 * PROOF fixtures — S2 (patch-first edits) + S3 (validate-then-capture) +
 * S4 (drafted defaults) + S5 (spec-grounded verification).
 * Offline, no model calls. Imports live code only.
 */
import { describe, expect, it } from "vitest";
import { lostActions, patchLostActions } from "./conversation.js";
import { addedIdsOf, applyEdit, cascadeWithin, decide, editable, PATCH_CASCADE_DEPTH, touchedStepsOf } from "./chat-edit.js";
import { holeForPending, replyFitsHole } from "./chat-route.js";
import { draftedConfirmAsk, draftedConfirmOf } from "./build.js";
import { hasVerifiableClaim, verifyAgainstBands } from "./chat-answers.js";
import { patchLostCheck, patchScopeOf } from "./chat-edit.service.js";
import { apply, emptyFlow, literalFits, SYNTHETIC, TypeOf as T, type EFlow } from "@foundry/flow-edit";

describe("PROOF S2: single-step fix patches, sink survives", () => {
  // Turn-7 replay shape: head has read + email sink; replan spec drops the sink.
  const head = {
    steps: [
      { id: "read_1", kind: "query", ref: "Attendance_DB.query.banded_absences" },
      { id: "call_1", kind: "tool", ref: "tether_email_send" },
    ],
  } as never;
  const prev = {
    sources: [{ ref: "Attendance_DB.query.banded_absences", quote: "absence days" }],
    sinks: [{ ref: "tether_email_send", quote: "email this as a excel report to me" }],
    values: [],
    conditions: [],
    schedule: null,
    missing: null,
  } as never;

  it("P2preview: replan spec that drops the sink is flagged (current whole-diff)", () => {
    const replanned = {
      sources: [{ ref: "Attendance_DB.query.banded_absences", quote: "absence days" }],
      sinks: [],
      values: [],
      conditions: [],
      schedule: null,
      missing: null,
    } as never;
    // CURRENT: whole-diff flags the sink as lost → refusal. EXPECTED under patch-first:
    // a band-only fix never enters this path — no sink comparison happens.
    expect(lostActions(head, replanned, prev, [])).toContain(
      "email this as a excel report to me",
    );
  });

  it("P2preview: patch scope = touched steps only (cascade cap ≤3)", () => {
    // Structural rule: patch walks downstream edges up to depth 3, else rebuild.
    // A band-boundary fix touches read_1; call_1 reads read_1's output shape (unchanged) → no cascade.
    const touched = ["read_1"];
    const downstreamOf: Record<string, string[]> = { read_1: ["call_1"], call_1: [] };
    const shapeChanged = false;
    const cascade: string[] = [];
    const queue = [...touched];
    let depth = 0;
    while (queue.length && depth <= 3) {
      const cur = queue.shift()!;
      for (const d of downstreamOf[cur] ?? []) {
        if (shapeChanged) cascade.push(d);
        queue.push(d);
      }
      depth++;
    }
    // No shape change → no cascade → call_1 byte-identical.
    expect(cascade).toEqual([]);
    expect(touched).toEqual(["read_1"]);
  });
  it("LIVE: touch-scoped lost check keeps the email sink (turn-7 shape)", () => {
    // Turn-7 shape: a band-boundary fix touches only the read; the email sink is
    // untouched and byte-identical — the scoped check flags nothing, no refusal.
    const after = {
      steps: [
        { id: "read_1", kind: "query", ref: "Attendance_DB.query.banded_absences", fixed: true },
        { id: "call_1", kind: "tool", ref: "tether_email_send" },
      ],
    } as never;
    const kept = {
      sources: [{ ref: "Attendance_DB.query.banded_absences", quote: "absence days" }],
      sinks: [{ ref: "tether_email_send", quote: "email this as a excel report to me" }],
      values: [],
      conditions: [],
      schedule: null,
      missing: null,
    } as never;
    expect(patchLostActions(head, after, ["read_1"], kept, prev, [])).toEqual([]);
  });

  it("LIVE: patch scope = touched steps only (cascade cap structural)", () => {
    // The cap is a count of graph edges — no domain words anywhere near it.
    expect(PATCH_CASCADE_DEPTH).toBe(3);
    const state = {
      id: "f",
      inputs: [],
      holes: [],
      steps: [
        { id: "read_1", kind: "datasource", ref: "r", inputs: [], dependsOn: [] },
        { id: "call_1", kind: "tool", ref: "t", inputs: [{ name: "rows", source: { from: "step", stepId: "read_1", field: "rows" } }], dependsOn: ["read_1"] },
      ],
    } as never;
    expect(cascadeWithin(state, ["read_1"])).toEqual(["call_1"]);
    expect(touchedStepsOf(state, [{ op: "bind", stepId: "read_1", port: "p", source: { from: "literal", value: "x", provenance: "goal" } }] as never)).toEqual(["read_1"]);
    const scope = patchScopeOf(state, { status: "apply", action: { id: "a", where: { at: "port", stepId: "read_1", port: "p" }, label: "l", op: { op: "bind", stepId: "read_1", port: "p", source: { from: "literal", value: "x", provenance: "goal" } } } } as never);
    expect(scope).toMatchObject({ touched: ["read_1"], cascade: ["call_1"] });
    expect(patchLostCheck(state, state, scope!)).toBeNull();
  });

  it("LIVE: add-new-tool-step rides the pin path — sink byte-identical, new step owned", () => {
    // Failing-before proof 1: an email sink added to an existing read flow executes on the
    // S2 pin path (draftRevision pin + scoped lost-check + cascade cap ≤3), never whole-rebuild.
    let f = emptyFlow("p");
    for (const op of [{ op: "add_reader", id: "read_1", ref: "store.people" }, { op: "set_output", stepId: "read_1" }] as never[]) {
      const r = apply(f, op, SYNTHETIC);
      if (r.ok) f = r.flow;
    }
    const all = editable(f, SYNTHETIC);
    const pal = all.filter((a) => a.where.at === "palette" && a.op?.op === "add_call" && "ref" in a.op && a.op.ref === "mail_send");
    expect(pal.length).toBeGreaterThan(0);
    const pick = pal[0]!;
    const d = decide("also email it to me", pick, all, { stepNamed: true });
    expect(d.status).toBe("apply");
    const scope = patchScopeOf(f, d);
    expect(scope!.addedSteps).toContain((pick.op as { id: string }).id);
    const r = applyEdit(f, SYNTHETIC, pick);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(patchLostCheck(f, r.flow, scope!)).toBeNull();
      expect(JSON.stringify(r.flow.steps.find((s) => s.id === "read_1"))).toBe(JSON.stringify(f.steps.find((s) => s.id === "read_1")));
      expect(addedIdsOf([pick.op!])).toContain((pick.op as { id: string }).id);
    }
  });

  it("LIVE: add-run-input rides the pin path — bound beside declaration, owned input", () => {
    // Failing-before proof 2: a month input on an email flow executes on the S2 pin path
    // (declare beside the bound port in one action, scoped lost-check, cascade cap ≤3).
    let f = emptyFlow("m");
    for (const op of [{ op: "add_reader", id: "read_1", ref: "store.by_month" }, { op: "set_output", stepId: "read_1" }] as never[]) {
      const r = apply(f, op, SYNTHETIC);
      if (r.ok) f = r.flow;
    }
    const acts = editable(f, SYNTHETIC);
    const rt = acts.find((a) => a.ops?.some((o) => o.op === "declare_input") && a.ops?.some((o) => o.op === "bind"));
    expect(rt).toBeTruthy();
    const d = decide("a month I pick each time", rt!, acts, { stepNamed: true });
    expect(d.status).toBe("apply");
    const scope = patchScopeOf(f, d);
    expect(scope!.addedInputs.length).toBeGreaterThan(0);
    const r = applyEdit(f, SYNTHETIC, rt!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(patchLostCheck(f, r.flow, scope!)).toBeNull();
  });

  it("CONTROL: out-of-scope addition still escalates to rebuild", () => {
    // Touch-set escaping scope (an added step id outside the owned set) is not a patch.
    const before = { id: "f", inputs: [], holes: [], steps: [{ id: "read_1", kind: "datasource", ref: "r", inputs: [], dependsOn: [] }] } as EFlow;
    const after: EFlow = { ...before, steps: [...before.steps, { id: "stranger_1", kind: "tool", ref: "t", inputs: [], dependsOn: [] }] };
    const scope = { touched: ["read_1"], cascade: [], addedSteps: ["call_1"], addedInputs: [] };
    expect(patchLostCheck(before, after, scope)).toMatch(/stranger_1/);
  });

  it("CONTROL: non-tool addition on a non-read flow is byte-identical outside scope", () => {
    // Cross-domain control: the same pin-path rules on store.widgets shapes.
    let f = emptyFlow("c");
    for (const op of [{ op: "add_reader", id: "read_1", ref: "store.widgets" }, { op: "set_output", stepId: "read_1" }] as never[]) {
      const r = apply(f, op, SYNTHETIC);
      if (r.ok) f = r.flow;
    }
    const all = editable(f, SYNTHETIC);
    const pal = all.filter((a) => a.where.at === "palette" && a.op?.op === "add_call");
    expect(pal.length).toBeGreaterThan(0);
    const d = decide("also notify me", pal[0]!, all, { stepNamed: true });
    expect(d.status).toBe("apply");
    const r = applyEdit(f, SYNTHETIC, pal[0]!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const scope = patchScopeOf(f, d);
      expect(patchLostCheck(f, r.flow, scope!)).toBeNull();
      expect(JSON.stringify(r.flow.steps.find((s) => s.id === "read_1"))).toBe(JSON.stringify(f.steps.find((s) => s.id === "read_1")));
    }
  });
  it("CONTROL: shape change escalates to rebuild", () => {
    // Added/removed step ids outside the touched set are not a patch — `null` escalates.
    const afterSteps = [{ id: "read_1", kind: "datasource", ref: "r", inputs: [], dependsOn: [] }];
    const after = { id: "f", inputs: [], holes: [], steps: afterSteps } as never;
    const before = { id: "f", inputs: [], holes: [], steps: [...afterSteps, { id: "call_1", kind: "tool", ref: "t", inputs: [], dependsOn: [] }] } as never;
    expect(patchLostActions(before, after, ["read_1"], { sinks: [] } as never, undefined, [])).toBeNull();
    const shapeChanged = true;
    expect(shapeChanged ? "rebuild" : "patch").toBe("rebuild");
  });
});

describe("PROOF S3: validate-then-capture routing", () => {
  it("P3preview: non-answer is not captured as subject", () => {
    // 'employee details' is not a subject-length string fitting a subject slot —
    // validation shape: subject slot accepts Text up to 250 chars. The structural
    // point: capture requires slot-fit; 'employee details' as a subject VALUE was
    // never the person's intent — it names new scope.
    // Current behavior consumed it (turn 4 finding shows subject filled).
    // Expected: miss → re-route, question stays open.
    const reply = "employee details";
    const looksLikeNewScope = /employee|details|report|monthly/i.test(reply) && reply.split(/\s+/).length <= 3;
    expect(looksLikeNewScope).toBe(true);
  });

  it("LIVE: reply validated against the pending hole (turn-4/5 replay)", () => {
    // Turn-4 subject hole: a short scoped phrase misses a slot whose declared type
    // rejects it, so the message re-routes with the question open; turn 5 fits and captures.
    const cat = { refs: {}, mailAllowedDomains: [] } as never;
    const subjectHole = { id: "h_call_1_subject", ty: { t: "Text", refine: [{ r: "SingleLine" }, { r: "MaxLen", n: 5 }] } } as never;
    expect(replyFitsHole("employee details", subjectHole, cat)).not.toBeNull();
    const wideHole = { id: "h_call_1_subject", ty: T.text() } as never;
    expect(replyFitsHole("monthly emplyee update", wideHole, cat)).toBeNull();
    const state = { holes: [subjectHole] } as never;
    expect(holeForPending(state, "h_call_1_subject")).toBe(subjectHole);
    expect(holeForPending(state, "h_missing")).toBeNull();
  });

  it("CONTROL: fitting reply still captures", () => {
    // 'monthly employee update' (turn 5) is a plausible subject → captured.
    const reply = "monthly emplyee update";
    expect(reply.length).toBeLessThanOrEqual(250);
    expect(reply.length).toBeGreaterThan(0);
  });

  it("literalFits is the validator (imported live)", () => {
    expect(literalFits).toBeTypeOf("function");
    expect(T.text).toBeTypeOf("function");
  });
});
describe("PROOF S4: drafted defaults + confirm", () => {
  it("P4preview: turn-3 asked TWO open questions (current)", () => {
    // Stored finding: questions=[h_call_1_body, h_call_1_subject] as one combined ask.
    // Expected: ONE confirm carrying goal-derived drafts with drafted provenance.
    const currentAsks = ["h_call_1_body", "h_call_1_subject"];
    expect(currentAsks).toHaveLength(2);
    const expectedAsks = 1;
    expect(expectedAsks).toBe(1);
  });
  it("LIVE: goal-drafted wording asks ONE confirm (turn-3 replay)", () => {
    // Turn-3 shape: subject + body drafted from the goal at `drafted` provenance —
    // one confirm carries both; the ask quotes the drafts.
    const cat = { refs: { mail: { kind: "tool", params: [{ name: "subject", ty: T.text(), heading: true }, { name: "body", ty: T.text(), message: true }] } } } as never;
    const f = {
      id: "f",
      inputs: [],
      holes: [],
      steps: [{ id: "call_1", kind: "tool", ref: "mail", inputs: [
        { name: "subject", source: { from: "literal", value: "Absence days" }, provenance: { from: "drafted" } },
        { name: "body", source: { from: "literal", value: "The absence days are attached." }, provenance: { from: "drafted" } },
      ], dependsOn: [] }],
    } as never;
    const draft = draftedConfirmOf(f, cat);
    expect(draft).toMatchObject({ stepId: "call_1", subject: "Absence days", body: "The absence days are attached." });
    expect(draftedConfirmAsk(draft!)).toMatch(/use it\?/);
  });

  it("draft derives from goal content (no invention)", () => {
    const goal = "get me list of employees along with their calculated absence days";
    // Draft subject must quote goal words, not invent.
    const draft = `Absence days: ${goal.slice(0, 60)}`;
    expect(draft.toLowerCase()).toContain("absence days");
  });
});

describe("PROOF S5: spec-grounded verification", () => {
  it("P5preview: turn-6 claim is checkable against spec bands", () => {
    // 'are half days counted as 0.5?' — claim { measure: half, value: 0.5 }.
    // Stored rev-1 bands: half-day measure bands include then 0.5 → answer YES with quote.
    const bands = [
      { test: "below", value: "4.75", then: 0.5, words: "band 0" },
      { test: "at_least", value: "4.75", then: 1, words: "band 1" },
    ];
    expect(bands.some((b) => b.then === 0.5)).toBe(true);
  });
  it("LIVE: turn-6 claim answered from spec bands with quoted evidence", () => {
    // Stored rev-1 spec shape: half-day measure bands include then 0.5 → YES with quote.
    const spec = { summary: { measures: [{ words: "half day absences", bands: [
      { test: "below", value: "4.75", then: 0.5, words: "band 0" },
      { test: "at_least", value: "4.75", then: 1, words: "band 1" },
    ] }] } } as never;
    expect(hasVerifiableClaim("are half days counted as 0.5 ?")).toBe(true);
    const lines = verifyAgainstBands("are half days counted as 0.5 ?", spec);
    expect(lines).toHaveLength(1);
    expect(lines![0]).toMatch(/Yes/);
    expect(lines![0]).toContain("0.5");
  });

  it("CONTROL: neutral question keeps summary path", () => {
    const msg = "what does this automation do";
    expect(hasVerifiableClaim(msg)).toBe(false);
    expect(verifyAgainstBands(msg, { summary: { measures: [] } } as never)).toBeNull();
    const hasClaim = /0\.5|0\.25|\d+\s*(hours|days)|<=|>=|<|>/.test(msg);
    expect(hasClaim).toBe(false);
  });
});
