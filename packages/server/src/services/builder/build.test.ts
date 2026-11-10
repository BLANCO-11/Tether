import { describe, expect, it } from "vitest";
import { apply, checkState, emptyFlow, errorsOf, SYNTHETIC as cat, SYNTHETIC, type CatalogueSnapshot, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { answer, construct, editProblems, EXITS, noLoopProblems, ONE_STEP_LIMIT, questionsFor, type Chooser } from "./build.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { buildPreview, withBuildProgress } from "./progress.js";

const ITEMS: BuilderCatalogue = { items: [
  { ref: "store.widgets", kind: "reader", about: "widgets as of a date" },
  { ref: "store.people", kind: "reader", about: "people" },
  { ref: "mail_send", kind: "tool", about: "send an email" },
  { ref: "llm_complete", kind: "tool", about: "summarise text" },
] };
const GOAL = "email ops@acme-corp.com the widget codes as of 2026-06-30 with subject Widget report";
const SPEC: GoalSpec = { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [], conditions: [], schedule: null, missing: null };
const checked = checkSpec(SPEC, [GOAL], ITEMS);

/** Options as the prompt lists them: `- oN: label`. */
const listed = (p: string) => [...p.matchAll(/^- ((?:o|g)\d+): (.*)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));
/** A chooser that walks a script of label patterns (with values), and says `done` when it runs out. */
/** For a GROUP prompt, the group a label belongs to — named by the option's own verb, as a reader of the list would. */
const groupFor = (label: RegExp) => (/call /.test(label.source) ? /^add an action/ : /from /.test(label.source) ? /^shape /: /result/.test(label.source) ? /^declare the result/ : /←/.test(label.source) ? /^fill / : /^add a reader/);
function scripted(script: Array<[RegExp, string?]>, log: string[] = []): Chooser {
  let i = 0;
  return async (prompt, schema) => {
    const enumv = ((schema.schema as unknown as { properties: { pick: { enum: string[] } } }).properties.pick.enum);
    for (const e of EXITS) expect(enumv).toContain(e); // D-307: every choice schema carries the exits
    log.push(prompt);
    const step = script[i];
    if (!step) return JSON.stringify({ pick: "done", value: "" });
    const isGroups = /^GROUPS OF OPTIONS/m.test(prompt);
    const hit = listed(prompt).find((o) => (isGroups ? groupFor(step[0]).test(o.label) : step[0].test(o.label)));
    if (!hit) return JSON.stringify({ pick: "none_fit", value: "" });
    if (hit.id.startsWith("o")) i++;
    return JSON.stringify({ pick: hit.id, value: step[1] ?? "" });
  };
}
const PLAN: Array<[RegExp, string?]> = [
  [/^read store\.widgets$/],
  [/^read_1\.as_of ← a value/, "2026-06-30"],
  [/^from read_1: at most 1000 rows$/],
  [/^call mail_send once per row of shape_1, to ← owner_email$/],
  [/^call_1\.subject ← a value/, "Widget report"],
  [/^call_1\.body ← shape_1\.code$/],
  [/^the result is shape_1$/],
];

describe("constrained construction (phase 4 task 2)", () => {
  it("a chooser that only picks listed options builds a valid, complete flow — every move recorded with its alternatives", async () => {
    // owner_email is nullable; the script above would need a filter first — use a non-null field plan instead
    const plan: Array<[RegExp, string?]> = [
      [/^read store\.people$/],
      [/^from read_1: at most 1000 rows$/],
      [/^call mail_send once per row of shape_1, to ← email$/],
      [/^call_1\.subject ← a value/, "Widget report"],
      [/^call_1\.body ← shape_1\.name$/],
      [/^the result is shape_1$/],
    ];
    const people = checkSpec({ ...SPEC, sources: [{ ref: "store.people", quote: "the widget codes" }] }, [GOAL], ITEMS);
    const r = await construct(people, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted(plan));
    expect(r.trace.moves.map((m) => m.label)).toHaveLength(6);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.flow.holes).toEqual([]);
    expect(r.trace.stop).toBe("complete");
    expect(r.trace.moves.every((m) => m.chooser === "model" && m.alternatives > 1)).toBe(true);
    expect(r.trace.moves.find((m) => m.value === "Widget report")?.provenance).toBe("goal");
    expect(noLoopProblems(r.trace)).toEqual([]);
  });

  it("a value that is not the person's words is never used: the slot becomes a question (the constants rule)", async () => {
    const r = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/], [/^read_1\.as_of ← a value/, "2026-07-31"]]));
    expect(r.trace.refused[0]!.why).toMatch(/not the person's words/);
    expect(r.flow.steps.find((s) => s.id === "read_1")).toMatchObject({ inputs: [] });
    const qs = questionsFor(r.flow, r.asked, r.trace, 1);
    expect(qs.map((q) => q.holeId)).toEqual(["h_read_1_as_of"]);
    // CONTROL: the stated value IS used
    const ok = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/], [/^read_1\.as_of ← a value/, "2026-06-30"]]));
    expect(ok.trace.refused.filter((x) => x.label !== "done")).toEqual([]);
  });

  it("`done` with decisions still open is refused ONCE — the next prompt names them; a second `done` stops", async () => {
    const log: string[] = [];
    const r = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/]], log));
    expect(r.trace.refused.filter((x) => x.label === "done")).toHaveLength(1);
    expect(r.trace.stop).toBe("done");
    // The prompt after the refusal is a different prompt (it names what is open) — never a re-ask of the same one.
    expect(log.at(-1)).toMatch(/NOT DONE YET — still open/);
    // The confirmed action counts as open too: the goal's `mail_send` was never added.
    expect(log.at(-1)).toMatch(/the goal's action `mail_send` is not added yet/);
    expect(log.at(-2)).not.toMatch(/NOT DONE YET/);
    expect(noLoopProblems(r.trace)).toEqual([]);
  });

  it("an answer that fits fills its hole; one that does not is a STATED incomplete, never asked again", () => {
    const f = [{ op: "add_reader", id: "r", ref: "store.widgets" } as EngineOp].reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    const trace = { calls: [], moves: [], questions: [] as ReturnType<typeof questionsFor>, refused: [], stop: "done" as const };
    const [q] = questionsFor(f, ["h_r_as_of"], trace, 1);
    trace.questions.push(q!);
    const bad = answer(f, q!, "end of June", cat);
    expect(q!.filled).toBe(false);
    expect(bad.holes.some((h) => h.id === "h_r_as_of")).toBe(true);
    expect(questionsFor(bad, ["h_r_as_of"], trace, 2)).toEqual([]); // rule 1/3: not asked again
    const q2: ReturnType<typeof questionsFor>[number] = { holeId: "h_r_as_of", ask: "", round: 1 };
    const good = answer(f, q2, "2026-06-30", cat);
    expect(q2.filled).toBe(true);
    expect(good.holes.some((h) => h.id === "h_r_as_of")).toBe(false);
  });


  it("an answer is judged by the port's type as the catalogue declares it NOW (the engine's bind), not the type its question was opened with", () => {
    const f = [{ op: "add_reader", id: "r", ref: "store.widgets" } as EngineOp].reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    // The question was opened while the port was plain text (a reader that had not yet declared its format).
    const stale = { ...f, holes: f.holes.map((h) => (h.id === "h_r_as_of" ? { ...h, ty: { t: "Text" as const } } : h)) };
    const q: ReturnType<typeof questionsFor>[number] = { holeId: "h_r_as_of", ask: "", round: 1 };
    expect(answer(stale, q, "monthly", cat).holes.some((h) => h.id === "h_r_as_of")).toBe(true);
    expect(q.filled).toBe(false);
    const q2: ReturnType<typeof questionsFor>[number] = { holeId: "h_r_as_of", ask: "", round: 1 };
    answer(stale, q2, "2026-06-30", cat);
    expect(q2.filled).toBe(true); // CONTROL: a value of the declared type still fills it
  });

  it("a date question offers the day it runs; picking it declares the computed input and binds it — never a fixed date", () => {
    const f = [{ op: "add_reader", id: "r", ref: "store.widgets" } as EngineOp].reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    const trace = { calls: [], moves: [], questions: [] as ReturnType<typeof questionsFor>, refused: [], stop: "done" as const };
    const [q] = questionsFor(f, ["h_r_as_of"], trace, 1, cat);
    expect(q!.options?.slice(0, 2)).toEqual(["the day it runs (worked out when it runs)", "the day before it runs (worked out when it runs)"]);
    const g = answer(f, q!, "the day it runs (worked out when it runs)", cat);
    expect(q!.filled).toBe(true);
    expect(g.inputs).toContainEqual(expect.objectContaining({ id: "run_day", computed: "currentDate" }));
    expect(g.holes.some((h) => h.id === "h_r_as_of")).toBe(false);
    // CONTROL: without the catalogue nothing is offered, and a typed date still works as before.
    expect(questionsFor(f, ["h_r_as_of"], { ...trace, questions: [] }, 1)[0]!.options).toBeUndefined();
  });

  it("on a SCHEDULED flow a date is worked out when it runs: only the run-time choices answer, and a typed date is refused", () => {
    const ops = [{ op: "set_schedule", cron: "0 9 * * 1" }, { op: "add_reader", id: "r", ref: "store.widgets" }] as EngineOp[];
    const f = ops.reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    const trace = { calls: [], moves: [], questions: [] as ReturnType<typeof questionsFor>, refused: [], stop: "done" as const };
    const [q] = questionsFor(f, ["h_r_as_of"], trace, 1, cat);
    expect(q!.onlyOptions).toBe(true);
    expect(q!.options).toEqual(["the day it runs (worked out when it runs)", "the day before it runs (worked out when it runs)", "the first day of the month it runs (worked out when it runs)", "the first day of the month before it runs (worked out when it runs)"]);
    // A fixed date on a weekly schedule would be the same date every Monday — refused, and the hole stays open.
    expect(answer(f, q!, "2026-06-30", cat).holes.some((h) => h.id === "h_r_as_of")).toBe(true);
    expect(q!.filled).toBe(false);
    // The option's WORDS pick it — without its note, in any case — as a person types them (2026-10-02, O03).
    const said = { ...q! };
    const g = answer(f, said, "The day it runs", cat);
    expect(said.filled).toBe(true);
    expect(g.inputs).toContainEqual(expect.objectContaining({ computed: "currentDate" }));
    // CONTROL: the same question on an unscheduled flow still takes a typed date.
    const loose = (apply(emptyFlow("t"), ops[1]!, cat) as { flow: EFlow }).flow;
    const [lq] = questionsFor(loose, ["h_r_as_of"], { ...trace, questions: [] }, 1, cat);
    expect(lq!.onlyOptions).toBeUndefined();
    expect(answer(loose, lq!, "2026-06-30", cat).holes.some((h) => h.id === "h_r_as_of")).toBe(false);
  });

  it("many options → a group first, then an option in it; no enum above the limit", async () => {
    const sizes: number[] = [];
    const chooser: Chooser = async (p, schema) => { const e = (schema.schema as unknown as { properties: { pick: { enum: string[] } } }).properties.pick.enum; sizes.push(e.length); return JSON.stringify({ pick: "done", value: "" }); };
    // a state with many options: two readers and several transforms
    let f = emptyFlow("t");
    for (const op of [{ op: "add_reader", id: "a", ref: "store.widgets" }, { op: "bind", stepId: "a", port: "as_of", source: { from: "literal", value: "2026-06-30", provenance: "goal" } }, { op: "add_reader", id: "b", ref: "store.people" }, { op: "add_transform", id: "t", from: "b", pipeline: [{ op: "limit", n: { value: 1000, from: "catalogue" } }] }] as EngineOp[]) f = (apply(f, op, cat) as { flow: EFlow }).flow;
    await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, chooser, f);
    expect(sizes[0]! - EXITS.length).toBeLessThanOrEqual(ONE_STEP_LIMIT);
  });

  it("while a build works, what it has placed so far is readable as a preview — and gone when it finishes (2026-09-29)", async () => {
    const seen: number[] = [];
    let calls = 0;
    const chooser: Chooser = async (p) => {
      calls++;
      seen.push(buildPreview("turn-1")?.state.steps.length ?? 0); // what the canvas would draw at this model call
      return JSON.stringify(calls === 1 ? { pick: listed(p).find((o) => o.label === "read store.widgets")!.id, value: "" } : { pick: "ask_person", value: "" });
    };
    await withBuildProgress("turn-1", () => construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, chooser));
    expect(seen[0]).toBe(0); // nothing placed before the first choice
    expect(seen[1]).toBe(1); // the reader is on the canvas while the model decides the next move
    expect(buildPreview("turn-1")).toBeNull(); // the finished turn's flow replaces it
    // CONTROL: outside a turn nothing is recorded, so a harness or the canvas never leaves a preview behind.
    await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, chooser);
    expect(buildPreview("turn-1")).toBeNull();
  });

  it("the no-loop rules fire on a trace that breaks them (CONTROL)", () => {
    expect(noLoopProblems({ calls: [{ label: "a", promptHash: "x", ms: 1 }, { label: "b", promptHash: "x", ms: 1 }], moves: [], questions: [{ holeId: "h", ask: "", round: 1 }, { holeId: "h", ask: "", round: 2 }], refused: [], stop: "done" }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/asked twice/), expect.stringMatching(/unchanged prompt/)]));
  });

  it("`none_fit` stops the build and says so; `ask_person` hands the next chooser hole to the person", async () => {
    const r = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, async () => JSON.stringify({ pick: "none_fit", value: "" }));
    expect(r.trace.stop).toBe("none_fit");
    let calls = 0;
    const a = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, async (p) => { calls++; return JSON.stringify(calls === 1 ? { pick: listed(p).find((o) => o.label === "read store.widgets")!.id, value: "" } : { pick: "ask_person", value: "" }); });
    expect(a.asked).toContain("h_read_1_as_of");
    expect(noLoopProblems(a.trace)).toEqual([]);
  });

  it("D-321: an edit that removes a step, or rebinds a set input, is caught — adding a step is not", () => {
    const ops = [{ op: "add_reader", id: "a", ref: "store.widgets" }, { op: "bind", stepId: "a", port: "as_of", source: { from: "literal", value: "2026-06-30", provenance: "goal" } }] as EngineOp[];
    const start = ops.reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    const added = (apply(start, { op: "add_reader", id: "b", ref: "store.people" } as EngineOp, cat) as { flow: EFlow }).flow;
    expect(editProblems(start, added)).toEqual([]);
    const rebound = [{ op: "unbind", stepId: "a", port: "as_of" }, { op: "bind", stepId: "a", port: "as_of", source: { from: "literal", value: "2026-05-31", provenance: "goal" } }].reduce((g, op) => (apply(g, op as EngineOp, cat) as { flow: EFlow }).flow, start);
    expect(editProblems(start, rebound)).toEqual(["a.as_of was rebound"]);
    const removed = (apply(start, { op: "remove_step", stepId: "a" } as EngineOp, cat) as { flow: EFlow }).flow;
    expect(editProblems(start, removed)).toEqual(["step a was removed"]);
  });

  it("only what the person CONFIRMED is offered: no unconfirmed reader, no second copy of a confirmed action", async () => {
    const log: string[] = [];
    await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/], [/^read_1\.as_of ← a value/, "2026-06-30"], [/^from read_1: at most 1000 rows$/], [/^call mail_send once per row of shape_1, body ← code$/]], log));
    const offered = (p: string) => listed(p).map((o) => o.label);
    expect(offered(log[0]!)).toContain("read store.widgets");
    expect(offered(log[0]!).some((l) => /^read store\.people/.test(l))).toBe(false);
    // After the one confirmed mail_send is placed, no further mail_send is on offer (D03 added it twenty times).
    const placed = log.map((p) => offered(p).includes("call mail_send once per row of shape_1, body ← code")).lastIndexOf(true);
    expect(placed).toBeGreaterThan(0);
    const after = log.slice(placed + 1).flatMap(offered);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((l) => /^call mail_send/.test(l))).toBe(false);
  });

  it("a structural decision with ONE legal option, once all else is settled, is taken by code — recorded as such", async () => {
    const readOnly = checkSpec({ ...SPEC, sinks: [] }, [GOAL], ITEMS);
    const r = await construct(readOnly, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/], [/^read_1\.as_of ← a value/, "2026-06-30"]]));
    expect(r.trace.moves.at(-1)).toMatchObject({ label: "the result is read_1", chooser: "code", alternatives: 1 });
    expect(r.trace.stop).toBe("complete");
    expect(r.flow.holes).toEqual([]);
    // Never earlier: while a value is still open, the result is not forced.
    expect(r.trace.moves.filter((m) => m.chooser === "code")).toHaveLength(1);
  });

  it("a later round counts ADDED against the build's own start, not the round's — no second copy, no false 'not read yet'", async () => {
    const r1 = await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([[/^read store\.widgets$/]]));
    expect(r1.trace.base).toEqual([]);
    const log: string[] = [];
    await construct(checked, ITEMS, cat, { goal: [GOAL], answers: [] }, scripted([], log), r1.flow, { trace: r1.trace, asked: r1.asked, seen: new Set() }); // a fresh set: round 1 ended on this very prompt
    const offered = log.flatMap((p) => listed(p).map((o) => o.label));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain("read store.widgets");
    expect(log.join("\n")).not.toMatch(/the goal reads `store\.widgets` and nothing reads it yet/);
  });
});

describe("answer — me on a scheduled address port", () => {
  const mailCat: CatalogueSnapshot = {
    ...SYNTHETIC,
    refs: {
      ...SYNTHETIC.refs,
      tether_email_send: {
        kind: "tool",
        params: [
          { name: "to", ty: { t: "List", of: { t: "Address" } }, required: false, liftsScalar: true, fallsBackToRequester: true },
          { name: "subject", ty: { t: "Text" }, required: true, heading: true },
          { name: "body", ty: { t: "Text" }, required: true, message: true },
        ],
        payload: { t: "Opaque" },
      },
    },
  };
  const run = (ops: EngineOp[]) => ops.reduce<EFlow>((f, o) => {
    const r = apply(f, o, mailCat);
    if (!r.ok) throw new Error(`${o.op}: ${r.error}`);
    return r.flow;
  }, emptyFlow("f"));

  it("binds the requester address when the person answers me", () => {
    let f = run([
      { op: "add_call", id: "call_1", ref: "tether_email_send" },
      { op: "set_schedule", cron: "0 9 * * 1" },
    ]);
    // schedule makes scheduled_recipient on fallsBackToRequester to
    expect(f.holes.some((h) => h.why === "scheduled_recipient")).toBe(true);
    const q = questionsFor(f, f.holes.map((h) => h.id), { questions: [] } as never, 1, mailCat).find((x) => x.port === "to")!;
    expect(q).toBeTruthy();
    const who = "me@acme-corp.com";
    f = answer(f, q, "me", mailCat, who);
    expect(q.filled).toBe(true);
    expect(f.holes.some((h) => h.site.at === "port" && h.site.port === "to")).toBe(false);
    const step = f.steps.find((s) => s.id === "call_1") as { inputs?: Array<{ name: string; source?: { value?: string } }> };
    expect(step.inputs?.find((i) => i.name === "to")?.source).toMatchObject({ from: "literal", value: who });
  });

  it("CONTROL: me without a requester address does not pretend to fill", () => {
    const f0 = run([
      { op: "add_call", id: "call_1", ref: "tether_email_send" },
      { op: "set_schedule", cron: "0 9 * * 1" },
    ]);
    const q = questionsFor(f0, f0.holes.map((h) => h.id), { questions: [] } as never, 1, mailCat).find((x) => x.port === "to")!;
    const f = answer(f0, q, "me", mailCat);
    expect(q.filled).toBe(false);
    expect(f.holes.some((h) => h.site.at === "port" && h.site.port === "to")).toBe(true);
  });
});

