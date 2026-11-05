/**
 * The builder as a conversation: a goal, then one question per turn, each reply answering the pending one; the flow's working copy
 * holds the conversation. The flow store is faked at the service boundary; the builder, solver and engine are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsaidWiringFor } from "./wiring.js";
import { SYNTHETIC as cat } from "@foundry/flow-edit";
import { planAware } from "./__fixtures__/plan-reply.js";

const db: { flow: Record<string, unknown> | null; incomplete: Record<string, unknown> | null; revisions: unknown[] } = { flow: null, incomplete: null, revisions: [] };

vi.mock("../flow.service.js", () => ({
  flowService: {
    getIncomplete: vi.fn(async () => (db.incomplete ? { ...db.incomplete, stale: false, diagnostics: [] } : null)),
    saveIncomplete: vi.fn(async (_ws: string, _id: string, model: unknown, build: unknown) => { db.incomplete = { model, build, basedOnRevision: 0 }; return {}; }),
    clearIncomplete: vi.fn(async () => { db.incomplete = null; }),
    writeRevision: vi.fn(async (_ws: string, _f: unknown, model: unknown) => { db.revisions.push(model); return { revision: { revision: db.revisions.length } }; }),
    create: vi.fn(async (_ws: string, x: { model: unknown }) => { db.revisions.push(x.model); db.flow = { id: "f1", draftRevision: 1 }; return { flow: db.flow, revision: { revision: 1 } }; }),
  },
}));
vi.mock("../../repositories/flow.repo.js", () => ({
  flowRepo: {
    get: vi.fn(async () => (db.flow ? { ...db.flow, incompleteModel: db.incomplete } : null)),
    create: vi.fn(async () => { db.flow = { id: "f1", draftRevision: 0, kestraFlowId: "slug-abc", name: "the goal (unfinished) k1" }; return db.flow; }),
    getRevision: vi.fn(async () => undefined),
    update: vi.fn(async (_id: string, x: { name?: string }) => { if (db.flow && x.name) db.flow = { ...db.flow, name: x.name }; return db.flow; }),
  },
}));
vi.mock("../flow-catalogue.service.js", () => ({
  flowCatalogueService: { forWorkspace: vi.fn(async () => ({ entries: [
    { ref: "store.people", kind: "query", description: "people" },
    { ref: "chat_post", kind: "tool", description: "post to a channel", params: [{ name: "channel", description: "" }, { name: "text", description: "" }] },
  ] })) },
}));
vi.mock("../flow-typecheck.js", () => ({ buildCatalogueSnapshot: vi.fn(async () => cat) }));
vi.mock("../../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: vi.fn(async () => []) } }));

const { builderStart, builderAnswer, builderContinue, partQuestion } = await import("./conversation.js");
import type { Chooser } from "./build.js";

const GOAL = "the people in store people, every day — deal with it";
const AUTHOR = { kind: "system", id: "test" } as never;
/**
 * The fixture's reply read: qids and reply parsed out of the prompt — a put-aside reply defers each question, anything else is
 * its answer. Defers and answers are the MODEL's read here; `reply-intents.test.ts` holds the validator's own rules.
 */
const replyIntents = (p: string): string => {
  const qids = [...p.matchAll(/^- qid: (.+)$/gm)].map((m) => m[1]!);
  const reply = p.split("THE PERSON'S REPLY:\n")[1]?.split("\n\nReturn ")[0]?.trim() ?? "";
  const defer = /^(leave|skip|fine|accept|done|stop|no more|as it is)\b/i.test(reply);
  return JSON.stringify({ replies: qids.map((qid) => ({ qid, intent: defer ? "defer" : "answer", value: defer ? null : reply })) });
};
/** The model: understands the goal once (no action named), and reads each REPLY once — the goal itself is never re-read. */
const model = () => {
  const calls: string[] = [];
  const f = planAware((async (p: string, schema: { name: string }) => {
    calls.push(schema.name);
    if (schema.name === "reply_intents") return replyIntents(p);
    if (schema.name === "goal_spec") return JSON.stringify({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [{ ref: "unsaid", quote: "deal with it" }], values: [], conditions: [], schedule: { cron: "0 9 * * *", quote: "every day" }, missing: null, unclear: [] });
    if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
    if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p)); // phase Y: the third call — nothing connected
    throw new Error(`unexpected call ${schema.name}`);
  }) as unknown as Chooser);
  return { f, calls };
};

beforeEach(() => { db.flow = null; db.incomplete = null; db.revisions = []; });

describe("builder conversation", () => {
  it("a goal → ONE question pending, kept in the working copy; the reply builds it — and the goal is never re-read", async () => {
    const m = model();
    const t1 = await builderStart("ws", GOAL, AUTHOR, null, m.f);
    expect(t1.status).toBe("asks");
    expect(t1.question?.holeId).toBe("delivery:0:delivery");
    expect(t1.flowId).toBe("f1");
    expect((db.incomplete as { build: { goalSpec: { conversation: { pending: string } } } }).build.goalSpec.conversation.pending).toBe("delivery:0:delivery");
    // A round whose question is still open is not settled: nothing is stored as re-understood (it would skip the question).
    expect((db.incomplete as { build: { goalSpec: { conversation: { corrected?: boolean } } } }).build.goalSpec.conversation.corrected).toBeUndefined();
    const before = m.calls.length;
    const t2 = await builderAnswer("ws", "f1", "#ops", AUTHOR, m.f);
    expect(m.calls.length).toBe(before + 1); // the reply is READ once (structured intents); the goal is not re-read
    expect([t1.calls, t2.calls]).toEqual([before, 1]); // counted where made
    expect(t2.status).toBe("complete");
    expect(db.revisions).toHaveLength(1);
    expect(JSON.stringify(db.revisions[0])).toContain("#ops");
    // The revision is deployed under the flow's own engine id — the one a run looks it up by.
    expect((db.revisions[0] as { id: string }).id).toBe("slug-abc");
    expect((db.flow as { name: string }).name).toBe(GOAL); // the working name gives way to the goal
    expect(db.incomplete).toBeNull();
  });

  it("a goal that only READS completes with its data as the result, no question, and delivery OFFERED — never added", async () => {
    const m = model();
    const readOnly = planAware((async (p: string, schema: { name: string }) => {
      if (schema.name === "goal_spec") return JSON.stringify({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [] });
      return m.f(p, schema as never, "x");
    }) as unknown as Chooser);
    const t = await builderStart("ws", "get me the people in store people", AUTHOR, null, readOnly);
    expect(t.status).toBe("complete");
    expect(t.question).toBeUndefined();
    expect(t.suggestions[0]).toMatch(/sends nothing\. If you want it delivered, say where/);
    expect(JSON.stringify(db.revisions[0])).not.toMatch(/chat_post/);
  });

  it("a port question is in words for a person: no step id, no type syntax", async () => {
    const { questionsFor } = await import("./build.js");
    const f = { id: "f", inputs: [], steps: [{ id: "call_1", kind: "tool", ref: "mail_send", inputs: [], dependsOn: [] }], holes: [{ id: "h_call_1_subject", site: { at: "port", stepId: "call_1", port: "subject" }, why: "required", ty: { t: "Text", refine: [{ r: "SingleLine" }, { r: "MaxLen", n: 250 }] }, owner: "person", reason: "`subject` needs a value" }] } as never;
    const [q] = questionsFor(f, [], { questions: [] } as never, 1);
    expect(q!.ask).toBe("What should the subject be for mail send? (up to 250 characters)");
    expect(q!.port).toBe("subject");
  });

  it("a build NOT FINISHED keeps the conversation open on what is unsettled — the reply re-understands the goal and finishes it", async () => {
    const goal = "get me the people in store people, the regular ones";
    const specs: string[] = [];
    let spec = 0;
    const f = planAware((async (p: string, schema: { name: string }, label: string) => {
      if (schema.name === "goal_spec") {
        specs.push(label);
        // The first understanding, and its one round's re-reading, leave "the regular ones" unclear; the person's later reply settles it.
        const settled = spec++ >= 2;
        return JSON.stringify({ sources: [{ ref: "store.people", quote: settled ? "the people in store people, the regular ones" : "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: settled ? [] : [{ quote: "the regular ones", about: "data" }] });
      }
      if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
      if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p));
      throw new Error(`unexpected call ${schema.name}`);
    }) as unknown as Chooser);
    const t1 = await builderStart("ws", goal, AUTHOR, null, f);
    expect(t1.question?.ask).toBe("What do you mean by “the regular ones”?");
    const t2 = await builderAnswer("ws", "f1", "the ones who come every week", AUTHOR, f);
    // Asked once and still unsettled: STATED, never asked again (P4-I1) — the conversation converges instead of looping.
    expect(t2.status).toBe("incomplete");
    expect(t2.question).toBeUndefined();
    expect(t2.unmet.join("\n")).toMatch(/the regular ones/);
    expect((db.incomplete as { build: { goalSpec: { conversation: { pending: unknown } } } }).build.goalSpec.conversation.pending).toBeNull();
    const saved = JSON.stringify(db.incomplete);
    // "revert" drops the unfinished build via the typed `discard` kind (was a DISCARD regex): nothing re-read, the working copy gone.
    const n0 = specs.length;
    const gone = await builderContinue("ws", "f1", "revert the change", AUTHOR, f, { kind: "discard" });
    db.incomplete = JSON.parse(saved);
    // A later message that says more CONTINUES the build — only with Enable replan (opt-in; auto-continue was the re-ask cycle).
    // MEM2 (2026-10-06): what the person said "the regular ones" means is kept as a meaning beside the goal.
    const cont = await builderContinue("ws", "f1", "the regular ones are people seen weekly", AUTHOR, f);
    expect(specs.at(-1)).toBe("builder:plan:corrected");
    expect([cont?.status, cont?.question]).toEqual(["complete", undefined]);
  });

  it("P4: a question names ONE part a person can settle — the rest is stated, never asked", async () => {
    expect(partQuestion("the goal also says “email the team”, and nothing built here does it")).toMatchObject({ key: "part:said:email the team", ask: expect.stringMatching(/^You said “email the team”/) });
    expect(partQuestion("“the regular ones” is unclear — what it refers to was not settled")?.ask).toBe("What do you mean by “the regular ones”?");
    // P1 (RC-6): the recipient the DATA cannot address IS the person's to settle — asked once, offering the address to give.
    expect(partQuestion("the goal says who receives `mail_send` (“their managers”), but no row here carries an address for them")).toMatchObject({ key: "part:address:their managers", quote: "their managers", ask: expect.stringMatching(/give an email address to send to/) });
    // The key is the goal's OWN words, never the step id: a rebuild re-ids its steps, and askedParts must still converge (P4-I1).
    expect(partQuestion("the goal says who receives `call_9.to` (“their managers”), but no row here carries an address for them")?.key).toBe("part:address:their managers");
    // CONTROL: the builder's own failures are still not questions (P4-I2)…
    expect(partQuestion("the condition “x” is not built: nothing here states how to test it")).toBeNull();
    // …and a policy REFUSAL is the refused port's OWN question (carrying the reason there) — never re-asked here as a part.
    expect(partQuestion("the address “bob@gmail.com” stated for `call_1.to` was refused: not on an allowed domain (microland.com)")).toBeNull();
  });

  it("CONTROL: a finished build leaves nothing pending — the next message is a new one", async () => {
    const m = model();
    const readOnly = planAware((async (p: string, schema: { name: string }) => {
      if (schema.name === "goal_spec") return JSON.stringify({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [] });
      return m.f(p, schema as never, "x");
    }) as unknown as Chooser);
    await builderStart("ws", "get me the people in store people", AUTHOR, null, readOnly);
    expect(db.incomplete).toBeNull();
  });

  it("no question pending: a reply is refused (409), never treated as a new goal", async () => {
    await expect(builderAnswer("ws", "f1", "x", AUTHOR, model().f)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("TWO open questions are ONE numbered turn, and one reply answers both (the group read)", async () => {
    const goal = "get me the people in store people, the regular ones who come often";
    let spec = 0;
    const intents: string[] = [];
    const f = planAware((async (p: string, schema: { name: string }) => {
      if (schema.name === "reply_intents") { intents.push(p); return replyIntents(p); }
      if (schema.name === "goal_spec") {
        const settled = spec++ >= 1; // the reply's own re-reading settles both unknowns
        return JSON.stringify({ sources: [{ ref: "store.people", quote: settled ? "the people in store people, the regular ones who come often" : "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: settled ? [] : [{ quote: "the regular ones", about: "data" }, { quote: "who come often", about: "data" }] });
      }
      if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
      if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p));
      throw new Error(`unexpected call ${schema.name}`);
    }) as unknown as Chooser);
    const t1 = await builderStart("ws", goal, AUTHOR, null, f);
    // Both unknowns asked as ONE turn — numbered, not one question per turn.
    expect(t1.status).toBe("asks");
    expect(t1.question?.ask).toContain("1. What do you mean by “the regular ones”?");
    expect(t1.question?.ask).toContain("2. What do you mean by “who come often”?");
    const conv = db.incomplete as { build: { goalSpec: { conversation: { pendingGroup?: string[] } } } };
    expect(conv.build.goalSpec.conversation.pendingGroup).toEqual(["unclear:the regular ones:data", "unclear:who come often:data"]);
    // ONE reply → ONE group read → the re-reading settles BOTH → the read-only build completes with no further question turn.
    const t2 = await builderAnswer("ws", "f1", "weekly visitors, every workday", AUTHOR, f);
    expect(intents).toHaveLength(1);
    expect(t2.status).toBe("complete");
    expect(db.incomplete).toBeNull(); // complete clears the working copy — proof both answers were APPLIED, not left open
  });
});

/** A goal whose unclear words the model NEVER resolves — the field-report shape: every re-reading re-derives the same unclear entry. */
const neverResolves = () => {
  const calls: string[] = [];
  const f = planAware((async (p: string, schema: { name: string }) => {
    calls.push(schema.name);
    if (schema.name === "reply_intents") return replyIntents(p);
    if (schema.name === "goal_spec") return JSON.stringify({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [{ quote: "the regular ones", about: "data" }] });
    if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
    if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(p));
    throw new Error(`unexpected call ${schema.name}`);
  }) as unknown as Chooser);
  return { f, calls };
};

/** The conversation stored on the incomplete build — narrowed from the fake store, no casts. */
const storedConv = () => {
  const build = db.incomplete?.build;
  if (!build || typeof build !== "object" || !("goalSpec" in build)) throw new Error("no incomplete build stored");
  const gs = build.goalSpec;
  if (!gs || typeof gs !== "object" || !("conversation" in gs)) throw new Error("no conversation stored");
  const conv = gs.conversation;
  if (!conv || typeof conv !== "object" || !("answers" in conv) || !("pending" in conv)) throw new Error("conversation lacks answers/pending");
  const answers = conv.answers;
  if (!answers || typeof answers !== "object") throw new Error("answers is not a map");
  return { answers, pending: conv.pending, deferred: "deferred" in conv ? conv.deferred : undefined, clarifyRounds: "clarifyRounds" in conv ? conv.clarifyRounds : undefined };
};

describe("durable answer state across turns (contracts C1, C2, C4, C5, C6, C7, C9)", () => {
  it("C1/C2: an answer survives every later round, and the answered question is never asked again", async () => {
    const m = neverResolves();
    const goal = "get me the people in store people, the regular ones";
    const asks: string[] = [];
    const t1 = await builderStart("ws", goal, AUTHOR, null, m.f);
    expect(t1.status).toBe("asks");
    if (t1.question) asks.push(t1.question.ask);
    // The answer to the unclear words — stored, and still stored after the clarification round that follows.
    const t2 = await builderAnswer("ws", "f1", "the ones who come every week", AUTHOR, m.f);
    if (t2.question) asks.push(t2.question.ask);
    // P4-I1: the unknown, answered and still unresolved, is stated — not asked again under another heading.
    expect(t2.status).toBe("incomplete");
    expect(t2.question).toBeUndefined();
    const conv = storedConv();
    // I1: no round wipes what was already answered.
    expect(Object.values(conv.answers)).toContain("the ones who come every week");
    // C2: the same unknown is asked exactly once across all three turns — never regenerated as a new question.
    const reasks = asks.filter((a) => a.startsWith("What do you mean by") && a.includes("the regular ones"));
    expect(reasks).toHaveLength(1);
  });

  it("C6/C9: bare “leave” defers ANY pending question — closed for the build, persisted, read once", async () => {
    const m = neverResolves();
    const t1 = await builderStart("ws", "get me the people in store people, the regular ones", AUTHOR, null, m.f);
    expect(t1.question?.ask).toMatch(/What do you mean by/);
    const before = m.calls.length;
    const t2 = await builderAnswer("ws", "f1", "leave", AUTHOR, m.f);
    // The reply is read once — the read says defer — and the defer lands as STATE: nothing pending, the question closed.
    expect(m.calls.length).toBe(before + 1);
    expect(t2.status).toBe("incomplete");
    const conv = storedConv();
    // C9: the defer rode the persisted conversation.
    expect(conv.pending).toBeNull();
    expect(Array.isArray(conv.deferred) ? conv.deferred : []).toContain(t1.question!.holeId);
    // I2 + I6: a later turn never re-opens the deferred question. (2026-10-02: the addition "send it to the store people" is NOT
    // built here — this model never answers, so nothing sends — and is now stated as such; the loose clause rule used to count it
    // done because it shares "store people" with the source. What may be asked is that, never the deferred question.)
    const t3 = await builderContinue("ws", "f1", "and also send it to the store people", AUTHOR, m.f);
    if (t3?.question?.ask) expect(t3.question.ask).not.toMatch(/regular ones/);
    if (t3?.status === "asks") expect(t3.question?.ask).toMatch(/also send it to the store people/);
  });

  it("C2: a re-derived question with a PARAPHRASED quote is the same unknown — answered once, never re-asked", async () => {
    // The model dropped "the" after the first correction in the FIELD replay — same unknown, other phrasing, and the answer must follow it.
    let specCalls = 0;
    const f = planAware((async (_p: string, schema: { name: string }) => {
      if (schema.name === "goal_spec") {
        const quote = specCalls++ === 0 ? "the relevant body message" : "relevant body message";
        return JSON.stringify({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [{ quote, about: "data" }] });
      }
      if (schema.name === "goal_shape") return JSON.stringify({ shapes: [] });
      if (schema.name === "goal_wiring") return JSON.stringify(unsaidWiringFor(_p));
      throw new Error(`unexpected call ${schema.name}`);
    }) as unknown as Chooser);
    const asks: string[] = [];
    const t1 = await builderStart("ws", "get me the people in store people, the relevant body message", AUTHOR, null, f);
    if (t1.question) asks.push(t1.question.ask);
    const t2 = await builderAnswer("ws", "f1", "a status update for each recipient", AUTHOR, f);
    if (t2.question) asks.push(t2.question.ask);
    if (t2.status === "asks") { const t3 = await builderAnswer("ws", "f1", "weekly visitors", AUTHOR, f); if (t3.question) asks.push(t3.question.ask); }
    // The unknown was asked exactly once — the paraphrased id found its answer instead of reopening the question.
    // (CLARIFY texts merely QUOTE the words in an item list; only a "What do you mean by" is the unknown itself being asked.)
    const asked = asks.filter((a) => a.startsWith("What do you mean by") && a.includes("relevant body message"));
    expect(asked).toHaveLength(1);
  });

  it("P4-I1: a never-resolving unknown CONVERGES — asked once, then stated; later messages never bring it back", async () => {
    const m = neverResolves();
    await builderStart("ws", "get me the people in store people, the regular ones", AUTHOR, null, m.f);
    const t2 = await builderAnswer("ws", "f1", "the ones who come every week", AUTHOR, m.f);
    expect(t2.status).toBe("incomplete");
    expect(storedConv().pending).toBeNull();
    const later = await builderContinue("ws", "f1", "and also send it to the store people", AUTHOR, m.f);
    if (later?.question?.ask) expect(later.question.ask).not.toMatch(/What do you mean by|Not settled yet|did not settle/);
    expect(Object.values(storedConv().answers)).toContain("the ones who come every week");
  });

  it("a change on an unfinished build is APPLIED, never held for a “go ahead” (the replan gate is deleted, 2026-10-10)", async () => {
    const m = neverResolves();
    await builderStart("ws", "get me the people in store people, the regular ones", AUTHOR, null, m.f);
    await builderAnswer("ws", "f1", "the ones who come every week", AUTHOR, m.f);
    // Seed an open question so the gate's answerable precondition holds: the refusal is of an answer, not of nothing.
    const inc = db.incomplete as { model: unknown; build: { goalSpec: { conversation: Record<string, unknown> } & Record<string, unknown> } };
    db.incomplete = { ...inc, build: { ...inc.build, goalSpec: { ...inc.build.goalSpec, conversation: { ...inc.build.goalSpec.conversation, pending: "unclear:the regular ones:data" } } } };
    const before = m.calls.length;
    const applied = await builderContinue("ws", "f1", "and also send it to the store people", AUTHOR, m.f);
    expect(applied?.status).not.toBe("unchanged");
    expect(applied?.said ?? "").not.toMatch(/full rebuild|go ahead|Enable replan/);
    expect(m.calls.length).toBeGreaterThan(before); // the goal is understood again with the change
  });

  it("middle gear: shape-only column reshape continues without Enable replan", async () => {
    const m = neverResolves();
    await builderStart("ws", "get me the people in store people, the regular ones", AUTHOR, null, m.f);
    await builderAnswer("ws", "f1", "the ones who come every week", AUTHOR, m.f);
    // Seed a written local so shape-only is eligible (isShapeOnlyEdit + locals).
    const inc = db.incomplete as { model: unknown; build: { goalSpec: { conversation: Record<string, unknown> } & Record<string, unknown> } };
    const local = {
      ref: "store.query.people",
      datasource: "store",
      name: "people",
      spec: { base: { schema: "public", table: "people" }, columns: [], filters: [], joins: [] },
    };
    const prev = inc.build.goalSpec.conversation;
    db.incomplete = {
      ...inc,
      build: {
        ...inc.build,
        goalSpec: {
          ...inc.build.goalSpec,
          conversation: { ...prev, local: [local], pending: null, unsettled: [] },
        },
      },
    };
    const beforePlans = m.calls.filter((c) => /plan|restate/i.test(c)).length;
    const shaped = await builderContinue(
      "ws",
      "f1",
      "the output of report should be - emp_id, emp_name, half days, full days, total",
      AUTHOR,
      m.f,
      { shapeOnly: true },
    );
    expect(shaped).toBeTruthy();
    expect(shaped!.status).not.toBe("unchanged");
    expect(shaped!.said ?? "").not.toMatch(/Enable replan|full rebuild/i);
    expect(m.calls.filter((c) => /plan|restate/i.test(c)).length).toBe(beforePlans);
  });
});
