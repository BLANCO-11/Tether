/**
 * `answerIncomplete` — the HTTP half of D-294: a person answers an unfinished build's questions later. The flow store is
 * faked at the service boundary (getIncomplete / saveIncomplete / writeRevision / clearIncomplete); the engine, the
 * construction loop and the no-loop rules are the real ones, over the synthetic catalogue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsaidWiringFor } from "./wiring.js";
import { checkState, SYNTHETIC as cat, type EFlow } from "@foundry/flow-edit";
import { planAware } from "./__fixtures__/plan-reply.js";

const store: { view: Record<string, unknown> | null; saved: unknown[]; written: unknown[]; cleared: number } = { view: null, saved: [], written: [], cleared: 0 };

vi.mock("../flow.service.js", () => ({
  flowService: {
    getIncomplete: vi.fn(async () => store.view),
    saveIncomplete: vi.fn(async (_ws: string, _id: string, state: EFlow, build: unknown) => { store.saved.push({ state, build }); return {}; }),
    writeRevision: vi.fn(async (_ws: string, _flow: unknown, model: unknown, _a: unknown, _c: unknown, _d: unknown, opts: unknown) => { store.written.push({ model, opts }); return { revision: { revision: 7 } }; }),
    clearIncomplete: vi.fn(async () => { store.cleared++; }),
  },
}));
vi.mock("../../repositories/flow.repo.js", () => ({ flowRepo: { get: vi.fn(async () => ({ id: "f1", draftRevision: 3 })), getRevision: vi.fn(async () => undefined) } }));
vi.mock("../flow-catalogue.service.js", () => ({
  flowCatalogueService: { forWorkspace: vi.fn(async () => ({ entries: [{ ref: "store.people", kind: "query", description: "people" }, { ref: "mail_send", kind: "tool", description: "send an email" }] })) },
}));
vi.mock("../flow-typecheck.js", () => ({ buildCatalogueSnapshot: vi.fn(async () => cat) }));
// D-311: the builder also offers the workspace's tables as readers; this workspace has no datasource.
vi.mock("../../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: vi.fn(async () => []) } }));

const { answerIncomplete, run, understand } = await import("./builder.service.js");
const { noLoopProblems } = await import("./build.js");
import type { Chooser, BuildTrace } from "./build.js";
import type { BuilderCatalogue, GoalSpec } from "./goal-spec.js";

const ITEMS: BuilderCatalogue = { items: [{ ref: "store.people", kind: "reader", about: "people" }, { ref: "mail_send", kind: "tool", about: "send an email", params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "body", about: "" }, { name: "cc", about: "" }] }] };
const GOAL = "email everyone in store people their weekly note";
const SPEC: GoalSpec = { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [], conditions: [], schedule: null, missing: null, unclear: [] };
const listed = (p: string) => [...p.matchAll(/^- ((?:o|g)\d+): (.*)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));
const PLAN = [/^read store\.people$/, /^from read_1: at most 1000 rows$/, /^call mail_send once per row of shape_1, to ← email$/, /^call_1\.body ← shape_1\.name$/, /^call_1\.subject ← a value/, /^the result is shape_1$/];
const GROUP_OF: Array<[RegExp, RegExp]> = [[/call /, /add an action/], [/from /, /^shape /], [/result/, /declare the result/], [/←/, /^fill /]];

/** Label-scripted chooser (as in builder.service.test.ts); an empty plan answers `done`. Records every label it was called with. */
function chooser(plan: RegExp[]): Chooser & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const f = planAware((async (p: string, schema: { name: string }, label: string) => {
    calls.push(label);
    if (schema.name === "goal_spec") return JSON.stringify(SPEC);
    if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
    if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p)); // phase Y: the third call — nothing connected
    const want = plan[i];
    if (!want) return JSON.stringify({ pick: "done", value: "" });
    const group = /^GROUPS OF OPTIONS/m.test(p);
    const groupRe = GROUP_OF.find(([k]) => k.test(want.source))?.[1] ?? /add a reader/;
    const hit = listed(p).find((o) => (group ? groupRe.test(o.label) : want.test(o.label)));
    if (!hit) return JSON.stringify({ pick: "ask_person", value: "" });
    if (!group) i++;
    return JSON.stringify({ pick: hit.id, value: /a value/.test(hit.label) ? "Widget report" : "" });
  }) as unknown as Chooser & { calls: string[] });
  f.calls = calls;
  return f;
}

/** The unfinished build the person comes back to: every question left unanswered (a stated incomplete). */
async function unfinished() {
  const c = chooser(PLAN);
  const u = await understand(GOAL, ITEMS, c);
  const r = await run(u, ITEMS, cat, c, async (qs) => qs.map(() => null));
  expect(r.status).toBe("incomplete");
  const build = { goalSpec: { goal: u.goal, texts: u.texts, spec: u.checked.spec, dropped: u.checked.dropped, readback: u.readback }, trace: JSON.parse(JSON.stringify(r.trace)) as BuildTrace };
  const model = JSON.parse(JSON.stringify(r.flow)) as EFlow;
  return { model, build, view: { model, build, basedOnRevision: 3, savedAt: "x", stale: false, diagnostics: checkState(model, cat) } };
}
const AUTHOR = { kind: "system", id: "test" } as never;

beforeEach(() => { store.view = null; store.saved = []; store.written = []; store.cleared = 0; });

describe("answerIncomplete (phase 4, D-294's HTTP half)", () => {
  it("answers that fill the last holes make the flow a REVISION from the builder, and drop the working copy", async () => {
    const { view } = await unfinished();
    store.view = view;
    const c = chooser([]);
    // The subject was the spec's own question (it maps to `mail_send.subject`); the body of a per-row email is a port only the
    // person can say (D-322). Both answered now; the solver places the spec answer, `answer` the port's.
    const out = await answerIncomplete("ws", "f1", { "h_call_1_subject": "Widget report", h_call_1_body: "Your weekly note" }, AUTHOR, c);
    expect(out).toEqual({ status: "complete", revision: 7, open: [] });
    expect(store.written).toHaveLength(1);
    const { opts, model } = store.written[0] as { opts: { origin: string; build: { trace: BuildTrace } }; model: EFlow };
    expect(opts.origin).toBe("builder");
    expect(model.holes).toEqual([]);
    // The person's words are what filled it — never a guess.
    expect(model.steps.find((s) => s.id === "call_1")).toMatchObject({ inputs: expect.arrayContaining([{ name: "subject", source: { from: "literal", value: "Widget report" }, provenance: { from: "person" } }]) });
    expect(noLoopProblems(opts.build.trace)).toEqual([]);
    expect(store.cleared).toBe(1);
    expect(store.saved).toHaveLength(0);
  });

  it("answering only some questions stays a working copy: the answered one is closed, the rest stay open, nothing re-asked", async () => {
    const { view } = await unfinished();
    store.view = view;
    const out = await answerIncomplete("ws", "f1", { "h_call_1_subject": "Widget report" }, AUTHOR, chooser([]));
    expect(out.status).toBe("incomplete");
    expect(out.open).toEqual(["h_call_1_body"]);
    expect(store.written).toHaveLength(0);
    const { build } = store.saved[0] as { build: { trace: BuildTrace } };
    expect(build.trace.questions.find((q) => q.holeId === "h_call_1_subject")?.answer).toBe("Widget report");
    expect(noLoopProblems(build.trace)).toEqual([]);
  });

  it("a question already answered is refused (409) — an answer is given once", async () => {
    const { view, build } = await unfinished();
    build.trace.questions.find((q) => q.holeId === "h_call_1_subject")!.answer = "earlier";
    store.view = view;
    await expect(answerIncomplete("ws", "f1", { "h_call_1_subject": "again" }, AUTHOR, chooser([]))).rejects.toMatchObject({ statusCode: 409 });
    expect(store.saved).toHaveLength(0);
  });

  it("a question never asked is refused (400), and nothing is written", async () => {
    store.view = (await unfinished()).view;
    await expect(answerIncomplete("ws", "f1", { h_made_up: "x" }, AUTHOR, chooser([]))).rejects.toMatchObject({ statusCode: 400 });
    expect(store.saved.length + store.written.length).toBe(0);
  });

  it("a flow with no unfinished build is a 404", async () => {
    await expect(answerIncomplete("ws", "f1", {}, AUTHOR, chooser([]))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a working copy a newer revision has overtaken is refused (409) — answering would overwrite that draft", async () => {
    const { view } = await unfinished();
    store.view = { ...view, stale: true };
    const c = chooser([]);
    await expect(answerIncomplete("ws", "f1", { h_call_1_subject: "Widget report" }, AUTHOR, c)).rejects.toMatchObject({ statusCode: 409 });
    expect(c.calls).toEqual([]);
    expect(store.written).toHaveLength(0);
  });

  it("a working copy the catalogue no longer admits is refused (409) before any model call", async () => {
    const { view } = await unfinished();
    store.view = { ...view, diagnostics: [{ code: "FT0101", severity: "error", message: "ref store.people is gone" }] };
    const c = chooser([]);
    await expect(answerIncomplete("ws", "f1", { h_call_1_subject: "Widget report" }, AUTHOR, c)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/store\.people is gone/) });
    expect(c.calls).toEqual([]);
  });
});
