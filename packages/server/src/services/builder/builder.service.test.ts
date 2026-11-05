import { describe, expect, it } from "vitest";
import { unsaidWiringFor } from "./wiring.js";
import { SYNTHETIC as cat } from "@foundry/flow-edit";
import { conditionQuestions, correct, MAX_REPLANS, recheck, run, understand, unclearHoleId, withDrafts, type Answerer } from "./builder.service.js";
import type { Chooser } from "./build.js";
import { EDIT_NOT_ADDITIVE, goalSpecPrompt, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { describeState } from "./build.js";
import { planAware } from "./__fixtures__/plan-reply.js";

const ITEMS: BuilderCatalogue = { items: [
  { ref: "store.widgets", kind: "reader", about: "widgets as of a date" },
  { ref: "store.people", kind: "reader", about: "people" },
  { ref: "mail_send", kind: "tool", about: "send an email", params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "body", about: "" }, { name: "cc", about: "" }] },
] };
const GOAL = "email everyone in store people their weekly note";
const SPEC: GoalSpec = { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [], conditions: [], schedule: null, missing: null, unclear: [] };
const listed = (p: string) => [...p.matchAll(/^- ((?:o|g)\d+): (.*)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));

/** A chooser: the spec on the first call, then label-scripted moves; `ask_person` for a value nobody stated. */
function chooser(spec: GoalSpec, plan: RegExp[]): Chooser & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const f = planAware((async (p: string, schema: { name: string }, label: string) => {
    calls.push(label);
    if (schema.name === "goal_spec") return JSON.stringify(spec);
    if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] }); // slice 5e: the second call — nothing done to the rows
    if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p)); // phase Y: the third call — nothing connected
    const want = plan[i];
    if (!want) return JSON.stringify({ pick: "done", value: "" });
    const group = /^GROUPS OF OPTIONS/m.test(p);
    const inGroup = (l: string) => /^(add an action|add a reader|shape |fill |declare the result)/.test(l) && (want.source.includes("call ") ? /add an action/.test(l) : want.source.includes("from ") ? /^shape /.test(l) : want.source.includes("result") ? /declare the result/.test(l) : want.source.includes("←") ? /^fill /.test(l) : /add a reader/.test(l));
    // Among several groups of one kind (a `fill` group per port), the one naming the step.port the scripted move is about.
    const m = /^\^?(\w+)\\\.(\w+)/.exec(want.source);
    const stepOf = m ? `${m[1]}.${m[2]}` : undefined;
    const opts = listed(p);
    const hit = group ? (opts.find((o) => inGroup(o.label) && !!stepOf && o.label.includes(stepOf)) ?? opts.find((o) => inGroup(o.label))) : opts.find((o) => want.test(o.label));
    if (!hit) return JSON.stringify({ pick: "ask_person", value: "" });
    if (!group) i++;
    // A literal slot is filled with the person's answer when there is one — as a model reading the prompt would.
    const answered = /^- answer: (.*)$/m.exec(p)?.[1] ?? "Widget report";
    return JSON.stringify({ pick: hit.id, value: /a value/.test(hit.label) ? answered : "" });
  }) as unknown as Chooser & { calls: string[] });
  f.calls = calls;
  return f;
}
const PLAN = [/^read store\.people$/, /^from read_1: at most 1000 rows$/, /^call mail_send once per row of shape_1, to ← email$/, /^call_1\.body ← shape_1\.name$/, /^call_1\.subject ← a value/, /^the result is shape_1$/];

describe("the one builder (phase 4 tasks 1b, 2, 4)", () => {
  it("understands a goal as a checked spec and a readback, in ONE strict call", async () => {
    const c = chooser(SPEC, []);
    const u = await understand(GOAL, ITEMS, c);
    // P1-D13: the whole structure — readers, rows, conditions, wiring — is ONE plan call; no shape or wiring call follows.
    expect(c.calls).toEqual(["builder:plan"]);
    // E5.5: the spec never asks — what to ask is decided by code from what the built flow still needs.
    expect(u.outcome).toBe("build");
    expect(u.readback.join(" ")).not.toMatch(/I will ask you/);
  });

  it("a correction is re-planned up to MAX_REPLANS times; one more is a stated disagreement, not another call", async () => {
    const c = chooser(SPEC, []);
    let u: Awaited<ReturnType<typeof understand>> = await understand(GOAL, ITEMS, c);
    for (let i = 0; i < MAX_REPLANS; i++) {
      const next = await correct(u, `the subject is Widget report ${i}`, ITEMS, c);
      expect("unresolved" in next).toBe(false);
      u = next as typeof u;
    }
    expect(await correct(u, "no, still wrong", ITEMS, c)).toMatchObject({ unresolved: expect.stringMatching(/re-planned/) });
    expect(c.calls.filter((l) => l.startsWith("builder:plan"))).toEqual(["builder:plan", ...Array(MAX_REPLANS).fill("builder:plan:corrected")]);
  });

  it("a correction adds only the PERSON's words: the builder's own quote marks never make a word read as quoted (2026-10-01)", async () => {
    const items: BuilderCatalogue = { items: ITEMS.items.map((it) => (it.ref === "mail_send" ? { ...it, params: it.params!.map((p) => (p.name === "body" ? { ...p, message: true } : p)) } : it)) };
    // The re-understood spec reads the goal's "about it" as the email's words.
    const spec: GoalSpec = { ...SPEC, sinks: [{ ref: "mail_send", quote: "email everyone" }], values: [{ role: "text", from: "goal", quote: "about it", fills: "mail_send.body" }] };
    const goal = "email everyone in store people about it";
    // The stub's wiring leaves every action's message undrafted (null), as its schema requires for a message input.
    const withDrafts = (base: Chooser): Chooser => (async (p: string, schema: { name: string }, label: string) => {
      const r = await base(p, schema as never, label);
      if (schema.name !== "goal_wiring") return r;
      const w = JSON.parse(r as string) as { actions: Record<string, object> };
      // Only where the schema asks for drafts (a message input nothing fills), each null — as a model leaving the message to the data.
      const acts = (schema as unknown as { schema: { properties: { actions: { properties: Record<string, { properties: { drafts?: { properties: Record<string, unknown> } } }> } } } }).schema.properties.actions.properties;
      for (const k of Object.keys(w.actions)) { const d = acts[k]?.properties.drafts; if (d) w.actions[k] = { ...w.actions[k], drafts: Object.fromEntries(Object.keys(d.properties).map((n) => [n, null])) }; }
      return JSON.stringify(w);
    }) as unknown as Chooser;
    const c = withDrafts(chooser(spec, []));
    const u = await understand(goal, items, c);
    const u2 = await correct(u, "“about it” means the status of the ticket", items, c, ["the status of the ticket"]);
    expect("unresolved" in u2).toBe(false);
    const got = u2 as typeof u;
    expect(got.texts).toEqual([goal, "the status of the ticket"]);
    expect(got.checked.spec.values).toEqual([]);
    expect(got.checked.dropped).toContainEqual({ what: "text “about it”", why: "it describes the message rather than giving its words — the message is the data" });
    // CONTROL: had the framing been counted as the person's words, its quote marks would have made "about it" the message
    const framed = (await correct(u, "“about it” means the status of the ticket", items, withDrafts(chooser(spec, [])))) as typeof u;
    expect(framed.checked.spec.values).toHaveLength(1);
  });

  it("builds, asks the person only what nobody stated, fills it from the answer, and ends complete with no loop", async () => {
    const c = chooser(SPEC, PLAN);
    const u = await understand(GOAL, ITEMS, c);
    const asked: string[] = [];
    const answerer: Answerer = async (qs) => { asked.push(...qs.map((q) => q.holeId)); return qs.map(() => "Widget report"); };
    const r = await run(u, ITEMS, cat, c, answerer);
    // Asked once each: the subject up front, as the spec said; then the body of a per-row email, which nobody stated (D-322).
    expect(asked).toEqual(["h_call_1_subject", "h_call_1_body"]);
    expect(r.status).toBe("complete");
    expect(r.loopProblems).toEqual([]);
    // The recipient came from the DATA (the person named people, not an address); the subject is the person's answer, by code.
    const call = r.flow.steps.find((x) => x.id === "call_1") as unknown as { over?: unknown; inputs: Array<{ name: string; source: unknown; provenance?: unknown }> };
    expect(call.over).toBeDefined();
    expect(call.inputs.find((b) => b.name === "subject")).toMatchObject({ source: { from: "literal", value: "Widget report" }, provenance: { from: "person" } });
    expect(r.trace.moves.every((m) => m.chooser === "code")).toBe(true);
  });

  it("an answer that does not fit, or none, is a STATED incomplete — asked once, never again", async () => {
    const c = chooser(SPEC, PLAN);
    const u = await understand(GOAL, ITEMS, c);
    let rounds = 0;
    const asked: string[] = [];
    const r = await run(u, ITEMS, cat, c, async (qs) => { rounds++; asked.push(...qs.map((q) => q.holeId)); return qs.map(() => null); });
    // Both are the flow's own open ports, asked together in ONE round (E5.5: no separate spec round), each once and never again.
    expect(asked).toEqual(["h_call_1_subject", "h_call_1_body"]);
    expect(rounds).toBe(1);
    expect(r.status).toBe("incomplete");
    expect(r.flow.holes.map((h) => h.id).sort()).toEqual(["h_call_1_body", "h_call_1_subject"]);
    expect(r.loopProblems).toEqual([]);
  });

  it("a goal that only reads is COMPLETE with its data as the result — no action added, nothing asked (2026-09-27)", async () => {
    const goal = "everyone in store people";
    const c = chooser({ ...SPEC, sinks: [], values: [] }, []);
    const u = await understand(goal, ITEMS, c);
    const asked: unknown[] = [];
    const r = await run(u, ITEMS, cat, c, async (qs) => { asked.push(...qs); return qs.map(() => null); });
    expect(asked).toEqual([]);
    expect(r.status).toBe("complete");
    expect(r.flow.steps.some((s) => s.kind === "tool")).toBe(false);
  });

  describe("a meaning a written read ASSUMED is the person's to confirm (2026-10-01)", () => {
    const goal = "everyone in store people with their deductions";
    const spec: GoalSpec = { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [{ quote: "deductions", about: "data", assumed: "annual leave days taken" }] };
    const u = () => recheck({ goal, texts: [goal], spec }, ITEMS);
    it("asked as itself; “yes” settles it as it stands — no model call, nothing unmet", async () => {
      const asked: string[] = [];
      const never = (async () => { throw new Error("no model call"); }) as unknown as Chooser;
      const r = await run(u(), ITEMS, cat, never, async (qs) => { asked.push(...qs.map((q) => q.ask)); return qs.map(() => "yes"); });
      expect(asked).toEqual(["By “deductions” I took annual leave days taken. Is that what you mean? If not, say what you mean."]);
      expect(r.status).toBe("complete");
      expect(r.trace.unmet ?? []).toEqual([]);
    });
    it("several assumptions are ONE question; “yes” confirms them all, with no model call", async () => {
      const both: GoalSpec = { ...spec, unclear: [{ quote: "deductions", about: "data", assumed: "annual leave days taken" }, { quote: "everyone", about: "data", assumed: "every row of store people" }] };
      const asked: string[] = [];
      const never = (async () => { throw new Error("no model call"); }) as unknown as Chooser;
      const r = await run(recheck({ goal, texts: [goal], spec: both }, ITEMS), ITEMS, cat, never, async (qs) => { asked.push(...qs.map((q) => q.ask)); return qs.map(() => "yes"); });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^Please confirm how I read your request:\n• “deductions” — annual leave days taken[\s\S]*\n• “everyone” — every row of store people[\s\S]*\nReply “yes”/);
      expect(r.status).toBe("complete");
    });
    it("any other answer is what the words mean — the goal is re-understood with it", async () => {
      const c = chooser({ ...spec, unclear: [] }, []);
      await run(u(), ITEMS, cat, c, async (qs) => qs.map(() => "the days of loss-of-pay leave"));
      expect(c.calls[0]).toBe("builder:plan:corrected");
    });
    it("a conversation's round is acted on WHOLE: one answer of two re-reads nothing; both answers re-read once", async () => {
      const two: GoalSpec = { ...spec, unclear: [{ quote: "deductions", about: "data", assumed: "annual leave days taken" }, { quote: "everyone", about: "data" }] };
      const u2 = () => recheck({ goal, texts: [goal], spec: two }, ITEMS);
      const c1 = chooser({ ...two, unclear: [] }, []);
      const r1 = await run(u2(), ITEMS, cat, c1, async (qs) => qs.map((_, k) => (k === 0 ? "the loss-of-pay days" : null)), undefined, undefined, { wholeRound: true });
      expect(c1.calls).toEqual([]);
      expect(r1.understood).toBeUndefined();
      expect(r1.status).not.toBe("complete");
      const c2 = chooser({ ...two, unclear: [] }, []);
      await run(u2(), ITEMS, cat, c2, async (qs) => qs.map((_, k) => (k === 0 ? "the loss-of-pay days" : "all staff")), undefined, undefined, { wholeRound: true });
      expect(c2.calls.filter((l) => l === "builder:plan:corrected")).toHaveLength(1);
    });
    it("CONTROL: unanswered, it is never taken — the build says it was not confirmed", async () => {
      const r = await run(u(), ITEMS, cat, chooser(spec, []), async (qs) => qs.map(() => null));
      expect(r.status).not.toBe("complete");
      expect(r.trace.unmet).toContain("“deductions” was read as annual leave days taken, and that was not confirmed");
    });
  });

  it("D-325: a per-row send that skips rows with no address SAYS so in the readback, before anything is built", async () => {
    const goal = "email the widgets to their owners";
    // A send named like no shipped tool: `mail_send` is ALSO a shipped declaration (the ops-api mail service: `recipients`, `cc`),
    // which put this synthetic `to`-shaped tool's recipient on `cc` (P7-I10 — declarations are keyed by the tool's name).
    const send = { ...cat.refs.mail_send!, ref: "send_mail" };
    const cat2 = { ...cat, refs: { ...cat.refs, send_mail: send } };
    // The plan chooses the owners' address field from the fields the catalogue LISTS (P7-D1): the reader lists its own.
    const items2: BuilderCatalogue = { items: [...ITEMS.items.filter((i) => i.ref !== "mail_send").map((i) => (i.ref === "store.widgets" ? { ...i, fields: [{ name: "owner_email", ty: "Option<Address>" }] } : i)), { ...ITEMS.items.find((i) => i.ref === "mail_send")!, ref: "send_mail" }] };
    const spec: GoalSpec = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "send_mail", quote: "email" }], values: [{ role: "recipient", from: "goal", quote: "their owners", fills: "send_mail.to" }], conditions: [], schedule: null, missing: null, unclear: [] };
    const u = withDrafts(await understand(goal, items2, chooser(spec, [])), cat2);
    expect(u.readback).toContain("Skipped: rows of store.widgets with no owner_email get no message — the run lists them separately");
  });

  it("a spec the workspace cannot serve builds nothing and asks nothing", async () => {
    const c = chooser({ ...SPEC, sinks: [{ ref: "none_fit", quote: "email" }], missing: "a pager" }, PLAN);
    const u = await understand(GOAL, ITEMS, c);
    const r = await run(u, ITEMS, cat, c, async () => { throw new Error("must not ask"); });
    expect(r.status).toBe("cannot");
    // P2 (RC-3): a `none_fit` whose words a listed action holds is asked back ONCE (the candidates are named) — and the refusal
    // stands when it persists. A `cannot` plan is still asked nothing beyond that one bounded re-ask.
    expect(c.calls).toEqual(["builder:plan", "builder:plan:again"]);
  });
  it("…and a word it could not place as a VALUE is not asked either: it cannot change the refusal (D21, 2026-10-01)", async () => {
    const words = GOAL.split(/\s+/).find((w) => w.length > 3)!;
    const c = chooser({ ...SPEC, sinks: [{ ref: "none_fit", quote: "email" }], missing: "a pager", values: [{ role: "other", from: "goal", quote: words, fills: "none" }] }, PLAN);
    const u = await understand(GOAL, ITEMS, c);
    expect(u.checked.spec.unclear).toContainEqual({ quote: words, about: "value" });
    const r = await run(u, ITEMS, cat, c, async () => { throw new Error("must not ask"); });
    expect(r.status).toBe("cannot");
  });

  it("a spec a CLIENT sends back is re-read as sent: nothing is dropped or repaired, and the readback is code's", () => {
    const forged: GoalSpec = { ...SPEC, sinks: [{ ref: "mail_send", quote: "and page the on-call" }], values: [{ role: "subject", from: "goal", quote: "Quarterly" }] };
    const u = recheck({ goal: GOAL, texts: ["a different goal the client claims", "a correction"], spec: forged }, ITEMS);
    expect(u.texts[0]).toBe(GOAL);
    // Step 5 (builder-IR): `recheck` is a plain re-read — the stored spec is
    // returned as sent. Code may refuse or ask downstream; it never rewrites.
    expect(u.checked.spec).toEqual(forged);
    expect(u.checked.dropped).toEqual([]);
  });

  describe("an EDIT of a non-empty flow (task 3, D-321)", () => {
    async function built() {
      const c = chooser(SPEC, PLAN);
      const u = await understand(GOAL, ITEMS, c);
      const r = await run(u, ITEMS, cat, c, async (qs) => qs.map(() => "Widget report"));
      expect(r.status).toBe("complete");
      return r.flow;
    }

    it("the spec prompt carries the automation as it is and the additive rule; a new goal's does not", () => {
      const lines = ["- read_1: reads store.people"];
      const p = goalSpecPrompt("also text them", ITEMS, undefined, lines);
      expect(p).toContain("THE AUTOMATION AS IT IS\n- read_1: reads store.people");
      expect(p).toContain(EDIT_NOT_ADDITIVE);
      expect(p.indexOf("THE AUTOMATION AS IT IS")).toBeLessThan(p.indexOf("GOAL\n"));
      expect(goalSpecPrompt("also text them", ITEMS)).not.toContain("THE AUTOMATION AS IT IS");
    });

    it("adds a second action, keeps every step that was there, and completes only once the action is ADDED", async () => {
      const start = await built();
      const EDIT = "also email them a reminder with subject Widget report";
      const spec2: GoalSpec = { sources: [], sinks: [{ ref: "mail_send", quote: "also email them a reminder" }], values: [{ role: "subject", from: "goal", quote: "Widget report", fills: "mail_send.subject" }], conditions: [], schedule: null, missing: null, unclear: [] };
      const c = chooser(spec2, [/^call mail_send once per row of shape_1, to ← email$/, /^call_2\.body ← shape_1\.name$/, /^call_2\.subject ← a value/]);
      const u = await understand(EDIT, ITEMS, c, undefined, describeState(start, cat));
      expect(u.current).toBeDefined();
      const asked: string[] = [];
      const r = await run(u, ITEMS, cat, c, async (qs) => { asked.push(...qs.map((q) => q.holeId)); return qs.map(() => "Remember the note"); }, start);
      expect(asked).toEqual(["h_call_2_body"]); // the only thing the edit did not state
      expect(r.status).toBe("complete");
      expect(r.flow.steps.filter((x) => x.kind === "tool")).toHaveLength(2);
      for (const s of start.steps) expect(r.flow.steps.find((x) => x.id === s.id)).toBeDefined();
      expect(r.loopProblems).toEqual([]);
    });

    it("a change to what is there is a stated `cannot`: nothing is built, nothing asked", async () => {
      const start = await built();
      const c = chooser({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: EDIT_NOT_ADDITIVE, unclear: [] }, PLAN);
      const u = await understand("remove the email step", ITEMS, c, undefined, describeState(start, cat));
      expect(u.outcome).toBe("cannot");
      const r = await run(u, ITEMS, cat, c, async () => { throw new Error("must not ask"); }, start);
      expect(r.status).toBe("cannot");
      expect(r.flow).toBe(start);
    });

    it("an edit that adds nothing is `unchanged` — not a revision identical to the draft", async () => {
      const start = await built();
      const c = chooser({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [] }, []);
      const u = await understand("looks good", ITEMS, c, undefined, describeState(start, cat));
      const r = await run(u, ITEMS, cat, c, async () => []);
      expect(r.status).not.toBe("unchanged"); // on an EMPTY start the same answer is simply an unfinished build
      const e = await run(u, ITEMS, cat, c, async () => [], start);
      expect(e.status).toBe("unchanged");
    });
  });

});

describe("E5.5 — condition questions", () => {
  it("asks what counts for a condition the flow applies with no stated value, and nothing else", () => {
    const qs = conditionQuestions({ ...SPEC, conditions: [
      { quote: "for too long", by: "the_flow", field: "store.widgets.qty", test: "above", value: "" },
      { quote: "that are active", by: "the_flow", field: "store.widgets.active", test: "is_true", value: "" },
      { quote: "over 5", by: "the_flow", field: "store.widgets.qty", test: "above", value: "5" },
    ] });
    expect(qs).toEqual([{ holeId: "cond:0:threshold", about: "words:for too long", ask: "What counts as “for too long”? (`qty` above what?)", round: 1 }]);
  });
});

describe("E5.5 — words the model could not tie to anything are asked, then re-understood once", () => {
  const specs = (...xs: GoalSpec[]) => { let n = 0; const calls: string[] = []; const f = planAware((async (p: string, s: { name: string }, label: string) => { calls.push(label); return s.name === "goal_shape" ? JSON.stringify({ shapes: [] }) : s.name === "goal_wiring" ? JSON.stringify(unsaidWiringFor(p)) : JSON.stringify(xs[Math.min(n++, xs.length - 1)]); }) as unknown as Chooser & { calls: string[] }); f.calls = calls; return f; };
  const VAGUE: GoalSpec = { ...SPEC, sources: [], unclear: [{ quote: "everyone in store people", about: "data" }] };
  it("asks what the words mean BEFORE building, re-understands once with the answer, and builds the clarified goal", async () => {
    const c = specs(VAGUE, SPEC);
    const u = await understand(GOAL, ITEMS, c);
    expect(u.readback).toContain("Unclear: “everyone in store people” — I will ask you what you mean before building on it");
    const asked: string[] = [];
    const r = await run(u, ITEMS, cat, c, async (qs) => { asked.push(...qs.map((q) => q.ask)); return qs.map((q) => (q.holeId.startsWith("unclear:") ? "the people table" : null)); });
    expect(asked[0]).toBe("What do you mean by “everyone in store people”?");
    expect(c.calls).toEqual(["builder:plan", "builder:plan:corrected"]); // asked, then the plan made once more with the answer
    expect(r.understood?.corrected).toBe(true);
    expect(r.flow.steps.some((x) => "ref" in x && x.ref === "store.people")).toBe(true);
    expect(r.loopProblems).toEqual([]);
  });
  it("unanswered — or still unclear after the one correction — it is stated unmet, never built as a guess and never re-asked", async () => {
    const c = specs(VAGUE, VAGUE);
    const u = await understand(GOAL, ITEMS, c);
    const unanswered = await run(u, ITEMS, cat, c, async (qs) => qs.map(() => null));
    expect(unanswered.status).toBe("incomplete");
    expect(unanswered.trace.unmet).toContainEqual("“everyone in store people” is unclear — what it refers to was not settled");
    let asks = 0;
    const still = await run(u, ITEMS, cat, c, async (qs) => { asks += qs.filter((q) => q.holeId.startsWith("unclear:")).length; return qs.map(() => "hmm"); });
    expect(asks).toBe(1);
    expect(still.status).toBe("incomplete");
    expect((still.trace.unmet ?? []).join(" ")).toMatch(/is unclear/);
  });
  it("C3: an unclear question's id is its CONTENT — the same words keep the same id whatever the order", async () => {
    // Identity derives from the quote under the one normalisation — never from a list index that moves when the list is re-derived.
    expect(unclearHoleId("The  Regular Ones", "data")).toBe(unclearHoleId("the regular ones", "data"));
    expect(unclearHoleId("the regular ones", "data")).not.toBe(unclearHoleId("the usual report", "data"));
    expect(unclearHoleId("everyone", "data")).not.toBe(unclearHoleId("everyone", "action"));
    // Through run(): the id set offered for the same unclear words does not depend on their position in the spec's list.
    const TWO: GoalSpec = { ...SPEC, sources: [], unclear: [{ quote: "everyone in store people", about: "data" }, { quote: "their weekly note", about: "data" }] };
    const idsOf = async (g: GoalSpec) => {
      const c = specs(g, g);
      const u = await understand(GOAL, ITEMS, c);
      const seen: string[] = [];
      await run(u, ITEMS, cat, c, async (qs) => { seen.push(...qs.map((q) => q.holeId)); return qs.map(() => null); });
      return seen;
    };
    const a = await idsOf(TWO);
    const b = await idsOf({ ...TWO, unclear: [...TWO.unclear!].reverse() });
    // Only the unclear ids are under contract here — later rounds ask port questions whose ids are flow-derived, not positional.
    const unclearIds = (ids: string[]) => ids.filter((id) => id.startsWith("unclear:"));
    expect(unclearIds(a)).toHaveLength(2);
    expect(new Set(unclearIds(a))).toEqual(new Set(unclearIds(b)));
    expect([...unclearIds(a), ...unclearIds(b)].every((id) => !/^unclear:\d+:/.test(id))).toBe(true);
  });
});

/**
 * D-311 under the plan (P1-D13): ONE call sees the saved readers and the schema's tables together — the two-call tiering is gone.
 * A saved reader still wins where it carries what the plan tests: a table gives way to it by code (`withAlternatives`, plan.test.ts).
 */
describe("D-311 under the plan: saved readers and tables in one call", () => {
  const T_ITEMS: BuilderCatalogue = { items: [...ITEMS.items, { ref: "ds.table.t1", kind: "reader", about: "each row of the table `t1`" }] };
  const scripted = (...replies: GoalSpec[]) => {
    const seen: Array<{ label: string; offered: boolean }> = [];
    let n = 0;
    const f = planAware((async (p: string, s: { name: string }, label: string) => {
      if (s.name === "goal_shape") return JSON.stringify({ shapes: [] });
      if (s.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p)); // phase Y: the third call — nothing connected
      seen.push({ label, offered: p.includes("ds.table.t1") });
      return JSON.stringify(replies[Math.min(n++, replies.length - 1)]);
    }) as unknown as Chooser);
    return { f, seen };
  };
  it("a saved reader that fits is kept — one plan call, tables offered beside it", async () => {
    const c = scripted(SPEC);
    const u = await understand(GOAL, T_ITEMS, c.f);
    expect(c.seen).toEqual([{ label: "builder:plan", offered: true }]);
    expect(u.checked.spec.sources[0]!.ref).toBe("store.people");
  });
  it("no saved reader fits: the table is chosen in the SAME call — never a second one", async () => {
    const table = { ...SPEC, sources: [{ ref: "ds.table.t1", quote: "everyone in store people" }] };
    const c = scripted(table);
    const u = await understand(GOAL, T_ITEMS, c.f);
    expect(c.seen).toEqual([{ label: "builder:plan", offered: true }]);
    expect(u.checked.spec.sources[0]!.ref).toBe("ds.table.t1");
  });
});

describe("a read WRITTEN for the goal (2026-10-01): chosen, written, then understood again with it", async () => {
  const { isNewRead } = await import("./local-readers.js");
  const W_ITEMS: BuilderCatalogue = { items: [
    ...ITEMS.items.filter((i) => i.kind === "tool"),
    { ref: "ds.table.t1", kind: "reader", about: "each row of the table `t1`" },
    { ref: "ds.new_read", kind: "reader", about: "a NEW read of ds" },
  ] };
  const WRITTEN = { ref: "ds.query.people_report", kind: "reader" as const, about: "a read written for this automation — from t1", fields: [{ name: "name", ty: "Text" }] };
  const scripted = (...replies: GoalSpec[]) => {
    const seen: Array<{ label: string; offersNew: boolean; offersWritten: boolean }> = [];
    let n = 0;
    const f = planAware((async (p: string, s: { name: string }, label: string) => {
      if (s.name === "goal_shape") return JSON.stringify({ shapes: [] });
      if (s.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p));
      seen.push({ label, offersNew: p.includes("ds.new_read"), offersWritten: p.includes("ds.query.people_report") });
      return JSON.stringify(replies[Math.min(n++, replies.length - 1)]);
    }) as unknown as Chooser);
    return { f, seen };
  };
  const chose = { ...SPEC, sources: [{ ref: "ds.new_read", quote: "everyone in store people" }] };
  const usesWritten = { ...SPEC, sources: [{ ref: "ds.query.people_report", quote: "everyone in store people" }] };

  it("writes the read once, against code's CONTRACT — and never asks the model to understand the goal again (phase 1)", async () => {
    const c = scripted(chose, usesWritten);
    const needs: string[] = [];
    const u = await understand(GOAL, W_ITEMS, c.f, undefined, undefined, undefined, undefined, async (ds, need) => {
      needs.push(`${ds}: ${need}`);
      return { reader: { ref: "ds.query.people_report", datasource: "ds", name: "people_report", spec: {} as never }, item: WRITTEN, assumed: [], leftOut: [] };
    });
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatch(/^ds: .*“everyone in store people”/s);
    expect(needs[0]).toMatch(/THE READ'S CONTRACT/); // the interface is code's, stated to the proposer
    // ONE understanding call: the spec after the read is applied by code — never a second call re-mapping the goal onto it.
    expect(c.seen.map((x) => x.label)).toEqual(["builder:plan"]);
    expect(u.checked.spec.sources[0]!.ref).toBe("ds.query.people_report");
    expect(u.local?.map((l) => l.ref)).toEqual(["ds.query.people_report"]);
  });

  it("a TABLE chosen for sending to people the data names becomes a written read — with or without an address field (2026-10-02, H06)", async () => {
    const toThem = { role: "recipient" as const, from: "goal" as const, quote: "everyone in store people", fills: "mail_send.to" };
    const table = { ...SPEC, sources: [{ ref: "ds.table.t1", quote: "everyone in store people" }], values: [toThem] };
    const wrote: string[] = [];
    const w = async (ds: string) => { wrote.push(ds); return { reader: { ref: "ds.query.people_report", datasource: "ds", name: "people_report", spec: {} as never }, item: WRITTEN, assumed: [], leftOut: [] }; };
    const u = await understand(GOAL, W_ITEMS, scripted(table, { ...usesWritten, values: [toThem] }).f, undefined, undefined, undefined, undefined, w);
    expect(wrote).toEqual(["ds"]);
    expect(u.checked.spec.sources[0]!.ref).toBe("ds.query.people_report");
    // A table's types say a field is an address, never WHOSE — so an address field does not keep the table.
    wrote.length = 0;
    const withAddress = { items: W_ITEMS.items.map((i) => (i.ref === "ds.table.t1" ? { ...i, fields: [{ name: "mail", ty: "Option<Address>" }] } : i)) };
    expect((await understand(GOAL, withAddress, scripted(table, { ...usesWritten, values: [toThem] }).f, undefined, undefined, undefined, undefined, w)).checked.spec.sources[0]!.ref).toBe("ds.query.people_report");
    expect(wrote).toEqual(["ds"]);
    // CONTROL: a goal sending to nobody in the rows keeps the table.
    wrote.length = 0;
    expect((await understand(GOAL, W_ITEMS, scripted({ ...table, values: [] }).f, undefined, undefined, undefined, undefined, w)).checked.spec.sources[0]!.ref).toBe("ds.table.t1");
    expect(wrote).toEqual([]);
  });

  it("a read that cannot be written is STATED (nothing fits, with the reason) — never a guess, never asked again", async () => {
    const c = scripted(chose);
    const u = await understand(GOAL, W_ITEMS, c.f, undefined, undefined, undefined, undefined, async () => ({ refused: "ds cannot give this: no leave table" }));
    expect(c.seen.map((x) => x.label)).toEqual(["builder:plan"]);
    expect(u.checked.spec.sources.some((x) => isNewRead(x.ref))).toBe(false);
    expect(u.outcome).toBe("cannot");
    expect(u.readback.join(" ")).toMatch(/no leave table/);
  });

  const writes = (assumed: Array<{ words: string; as: string }>, leftOut: Array<{ words: string; why: string }>) => async () => ({
    reader: { ref: "ds.query.people_report", datasource: "ds", name: "people_report", spec: {} as never }, item: WRITTEN, assumed, leftOut,
  });

  it("what a written read LEFT OUT is STATED with its reason — never a question, and never counted as done (phase 1)", async () => {
    const goal = "email everyone in store people with their deductions";
    const u = await understand(goal, W_ITEMS, scripted(chose).f, undefined, undefined, undefined, undefined, writes([], [{ words: "deductions", why: "no column holds a deduction" }]));
    expect(u.checked.spec.sources[0]!.ref).toBe("ds.query.people_report");
    expect(u.checked.spec.unclear ?? []).toEqual([]);
    expect(u.readback.join("\n")).toMatch(/The read ds\.query\.people_report does not give “deductions”: no column holds a deduction/);
  });

  it("what a written read ASSUMED is asked to be confirmed — never taken silently", async () => {
    const goal = "email everyone in store people with their deductions";
    const u = await understand(goal, W_ITEMS, scripted(chose, usesWritten).f, undefined, undefined, undefined, undefined, writes([{ words: "deductions", as: "annual leave days taken" }], []));
    expect(u.outcome).toBe("asks");
    expect(u.checked.spec.unclear).toContainEqual({ quote: "deductions", about: "data", read: "ds.query.people_report", assumed: "annual leave days taken" });
    expect(u.readback.join("\n")).toMatch(/Assumed: “deductions” read as annual leave days taken/);
  });

  it("what a written read carries out is CODE's — the words it was written for, never the proposer's own claim (phase 1)", async () => {
    const goal = "email everyone in store people with their deductions, a deduction of 0 days is a clean month";
    const covering = async () => ({ ...(await writes([], [])()), covers: ["a deduction of 0 days is a clean month", "words nobody wrote"] });
    const u = await understand(goal, W_ITEMS, scripted(chose).f, undefined, undefined, undefined, undefined, covering);
    expect(u.checked.spec.covered).toEqual([{ quote: "everyone in store people", by: "ds.query.people_report" }]);
    // CONTROL: words it reports it could not give are not done by it.
    const left = await understand(goal, W_ITEMS, scripted(chose).f, undefined, undefined, undefined, undefined, writes([], [{ words: "everyone in store people", why: "no such rows" }]));
    expect(left.checked.spec.covered).toBeUndefined();
  });

  it("a CONFIRMED reading is the read's: its words are carried out by it, and stay so when the goal is re-understood", async () => {
    const goal = "email everyone in store people with their deductions";
    const u = await understand(goal, W_ITEMS, scripted(chose, usesWritten).f, undefined, undefined, undefined, undefined, writes([{ words: "deductions", as: "annual leave days taken" }], []));
    // As a conversation does: the turn's catalogue carries the reads written for this goal.
    const withRead: BuilderCatalogue = { items: [WRITTEN, ...W_ITEMS.items] };
    const r = await run(u, withRead, cat, chooser(SPEC, []), async (qs) => qs.map(() => "yes"));
    expect(r.understood?.checked.spec.covered).toContainEqual({ quote: "deductions", by: "ds.query.people_report", as: "annual leave days taken" });
    expect(r.understood?.checked.spec.unclear ?? []).toEqual([]);
    // CONTROL: an answer that is not a confirmation leaves nothing credited to the read. MEM3: the answered read leaves the
    // catalogue for that re-plan, so the plan routes through a new read and the writer revises it with the meaning.
    const no = await run(u, withRead, cat, chooser({ ...chose, unclear: [] }, []), async (qs) => qs.map(() => "the days of loss-of-pay leave"), undefined, writes([], []));
    expect(no.understood?.checked.spec.covered ?? []).not.toContainEqual(expect.objectContaining({ quote: "deductions" }));
  });

  it("one question per set of words — an assumption replaces the spec's plain unclear entry and a part left out of the same words", async () => {
    const goal = "email everyone in store people with their deductions";
    const plain = { ...chose, unclear: [{ quote: "with their deductions", about: "data" as const }] };
    const u = await understand(goal, W_ITEMS, scripted(plain).f, undefined, undefined, undefined, undefined,
      writes([{ words: "deductions", as: "annual leave days taken" }], [{ words: "deductions", why: "no column" }, { words: "email", why: "an action" }]));
    expect(u.checked.spec.unclear).toEqual([{ quote: "deductions", about: "data", read: "ds.query.people_report", assumed: "annual leave days taken" }]);
    expect(u.readback.join("\n")).not.toMatch(/does not give “email”/); // words an action owns are never the read's to ask about
  });

  it("a note is dropped only when its words sit INSIDE a settled quote — never because it contains one", async () => {
    const goal = "email everyone in store people with annual leave with deductions";
    const withValue = { ...usesWritten, values: [{ role: "other" as const, from: "goal" as const, quote: "annual leave", fills: "none" }] };
    const u = await understand(goal, W_ITEMS, scripted(chose, withValue).f, undefined, undefined, undefined, undefined,
      writes([{ words: "annual leave with deductions", as: "annual leave days taken" }], []));
    expect(u.checked.spec.unclear?.map((x) => x.quote)).toContain("annual leave with deductions");
  });


  it("CONTROL: words that are not the person's are STATED in the readback, never asked as theirs", async () => {
    const u = await understand(GOAL, W_ITEMS, scripted(chose, usesWritten).f, undefined, undefined, undefined, undefined, writes([{ words: "weekly payroll", as: "pay_period = week" }], []));
    expect(u.checked.spec.unclear ?? []).toEqual([]);
    expect(u.readback.join("\n")).toMatch(/takes “weekly payroll” as pay_period = week/);
  });

  it("a read refused ONLY for an address one action needs is written again without it — that recipient is then stated, never the whole read refused (2026-10-04)", async () => {
    const toThem = { role: "recipient" as const, from: "goal" as const, quote: "everyone in store people", fills: "mail_send.to" };
    const contracts: Array<{ address?: string }> = [];
    const w = async (_ds: string, _need: string, _t: string[], _x?: string[], _p?: unknown, contract?: { address?: string }) => {
      contracts.push({ ...(contract ?? {}) });
      if (contract?.address) return { refused: "ds cannot give this: no column holds the front desk's address" };
      return { reader: { ref: "ds.query.people_report", datasource: "ds", name: "people_report", spec: {} as never }, item: WRITTEN, assumed: [], leftOut: [] };
    };
    const u = await understand(GOAL, W_ITEMS, scripted({ ...chose, values: [toThem] }, { ...usesWritten, values: [toThem] }).f, undefined, undefined, undefined, undefined, w);
    expect(contracts.map((c) => c.address)).toEqual(["everyone in store people", undefined]);
    expect(u.checked.spec.sources[0]!.ref).toBe("ds.query.people_report");
    expect(u.checked.spec.missing ?? null).toBeNull();
    expect(u.checked.spec.values.find((v) => v.role === "recipient")).toMatchObject({ quote: "everyone in store people", field: "none" });
  });

  it("a per-group action to people the rows name: each group KEEPS the written read's address (2026-10-04)", async () => {
    const { carryAddresses } = await import("./builder.service.js");
    const grouped: GoalSpec = { ...chose, shapes: [{ over: "ds.query.people_report", stages: [{ op: "group", quote: "x", by: ["ds.query.people_report.team"], measures: [{ fn: "count", field: null }], rows: true }] }] };
    const out = carryAddresses(grouped, "ds.query.people_report", [{ name: "team", ty: "Text" }, { name: "lead_email", ty: "Option<Address>" }]);
    expect((out.shapes![0]!.stages[0] as { carry?: string[] }).carry).toEqual(["ds.query.people_report.lead_email"]);
    // CONTROL: no address field, or a group over another list — unchanged
    expect(carryAddresses(grouped, "ds.query.people_report", [{ name: "team", ty: "Text" }])).toBe(grouped);
    expect((carryAddresses(grouped, "ds.query.other", [{ name: "lead_email", ty: "Address" }]).shapes![0]!.stages[0] as { carry?: string[] }).carry).toBeUndefined();
  });

  it("CONTROL: a read refused for its DATA is still refused — the retry is for an address alone", async () => {
    const toThem = { role: "recipient" as const, from: "goal" as const, quote: "everyone in store people", fills: "mail_send.to" };
    let n = 0;
    const w = async () => { n++; return { refused: "ds cannot give this: no table holds loans" }; };
    const u = await understand(GOAL, W_ITEMS, scripted({ ...chose, values: [toThem] }).f, undefined, undefined, undefined, undefined, w as never);
    expect(n).toBe(2);
    expect(u.checked.spec.missing).toMatch(/no table holds loans/);
  });

  it("a re-understanding that chooses a new read again REVISES the one written — same ref, handed the prior, still one read", async () => {
    // MEM3 revise-in-place: strip the written read from the catalogue so the plan re-routes through new_read.
    // Under Intent IR (T13) that strip is skipped — pin keeps the settled source — so this property is flag-off only.
    const prev = process.env.BUILDER_INTENT_IR;
    process.env.BUILDER_INTENT_IR = "0";
    try {
      const priors: Array<string | undefined> = [];
      const write = async (_ds: string, _need: string, taken: string[], _t?: string[], prior?: { ref: string }) => {
        priors.push(prior?.ref);
        expect(taken).not.toContain("ds.query.people_report"); // the read being revised is not a name to avoid
        return { reader: { ref: "ds.query.people_report", datasource: "ds", name: "people_report", spec: { revision: priors.length } as never }, item: WRITTEN, assumed: [], leftOut: [] };
      };
      const u = await understand(GOAL, W_ITEMS, scripted(chose, usesWritten).f, undefined, undefined, undefined, undefined, write);
      const again = await correct(u, "“everyone” means each day they were present", W_ITEMS, scripted(chose, usesWritten).f, ["each day they were present"], write);
      expect("unresolved" in again).toBe(false);
      const u2 = again as Awaited<ReturnType<typeof understand>>;
      // CONTROL: the first write had nothing to revise; the second was handed the read the first wrote.
      expect(priors).toEqual([undefined, "ds.query.people_report"]);
      expect(u2.local?.map((l) => l.ref)).toEqual(["ds.query.people_report"]);
      expect(u2.local?.[0]!.spec).toEqual({ revision: 2 });
    } finally {
      if (prev === undefined) delete process.env.BUILDER_INTENT_IR;
      else process.env.BUILDER_INTENT_IR = prev;
    }
  });

  it("a written read's interpretations are ONE question keyed by their words; words already spoken to are never asked again", async () => {
    const goal = "email everyone in store people with their deductions and their overtime";
    const u = await understand(goal, W_ITEMS, scripted(chose, usesWritten).f, undefined, undefined, undefined, undefined,
      writes([{ words: "deductions", as: "annual leave days taken" }, { words: "overtime", as: "hours above 9.5" }], []));
    const asked: string[] = [];
    const answerer: Answerer = async (qs) => { asked.push(...qs.map((q) => q.holeId)); return qs.map(() => null); };
    await run(u, W_ITEMS, cat, chooser(SPEC, []), answerer);
    expect(asked.filter((h) => h.startsWith("assumed:"))).toEqual(["assumed:deductions|overtime:data"]);
    // The person confirmed those words in an earlier round: nothing about them is asked again.
    asked.length = 0;
    await run({ ...u, answered: ["assumed:deductions|overtime:data"] }, W_ITEMS, cat, chooser(SPEC, []), answerer);
    expect(asked.filter((h) => h.startsWith("assumed:"))).toEqual([]);
    // CONTROL: a NEW interpretation is still asked — the answered words settle only themselves.
    asked.length = 0;
    await run({ ...u, answered: ["assumed:deductions:data"] }, W_ITEMS, cat, chooser(SPEC, []), answerer);
    expect(asked.filter((h) => h.startsWith("assumed:"))).toEqual(["assumed:overtime:data"]);
  });

  it("CONTROL: a goal a table reader covers never writes a read", async () => {
    const c = scripted({ ...SPEC, sources: [{ ref: "ds.table.t1", quote: "everyone in store people" }] });
    let wrote = 0;
    const u = await understand(GOAL, W_ITEMS, c.f, undefined, undefined, undefined, undefined, async () => { wrote++; return { refused: "x" }; });
    expect(wrote).toBe(0);
    expect(u.local).toBeUndefined();
  });

});

describe("an input's declared values", () => {
  it("“One of: …” in an input's own description is its values; other prose is not", async () => {
    const { declaredValues } = await import("./builder.service.js");
    expect(declaredValues("One of: open, pending, waiting_for_reply, resolved, closed.")).toEqual(["open", "pending", "waiting_for_reply", "resolved", "closed"]);
    expect(declaredValues("Status value meaning closed. Use 'resolved'.")).toBeNull(); // CONTROL: an example, not the set
    expect(declaredValues("one of 'a' or 'b'")).toEqual(["a", "b"]);
  });
});
