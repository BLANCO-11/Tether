import { describe, expect, it } from "vitest";
import { askOnly, labelInputValue, scoreBuild, statedSlot, type Goal } from "./goalset-score.js";

const goal = (label: Partial<Goal["label"]>): Goal => ({
  id: "X01",
  workspace: "W",
  goal: "g",
  label: { outcome: "asks", stated: [], slots: {}, expect: {}, ...label },
});

const kinds = (g: Goal, o: Parameters<typeof scoreBuild>[1]) => scoreBuild(g, o).failures.map((f) => f.kind);

describe("goalset scoring — questions in both directions (D-309)", () => {
  const g = goal({
    stated: ["schedule: monday morning", "recipient: me (the requester)"],
    slots: { recipient: { accept: ["identity"] }, data: { accept: ["ask"], answer: "late invoices" }, period: { accept: ["input", "ask"] } },
    expect: { readers: ["ds.r"], sinks: ["mail_send"] },
  });
  const ok = { status: "ok", refs: ["ds.r", "mail_send"], run: "SUCCESS" };

  it("passes when the needed slot is asked and nothing else", () => {
    expect(scoreBuild(g, { ...ok, questions: [{ text: "which data?", slot: "data" }] }).pass).toBe(true);
  });
  it("a needed ask-only slot left unasked is a silent guess", () => {
    expect(kinds(g, { ...ok, questions: [] })).toEqual(["silent_guess"]);
  });
  it("asking a stated slot is redundant", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "when?", slot: "schedule" }] })).toEqual(["redundant_question"]);
  });
  it("asking for 'me' is redundant — it is stated and not askable (D-310)", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "who?", slot: "recipient" }] })).toEqual(["redundant_question"]);
  });
  it("asking a slot the data determines (not askable) is redundant", () => {
    const d = goal({ slots: { data: { accept: ["ask"] }, owner: { accept: ["data:owner_email"] } } });
    expect(kinds(d, { status: "ok", questions: [{ text: "d", slot: "data" }, { text: "whose address?", slot: "owner" }] })).toEqual(["redundant_question"]);
  });
  it("asking a slot that is askable (input|ask) is not penalised", () => {
    expect(scoreBuild(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "which month?", slot: "period" }] }).pass).toBe(true);
  });
  it("asking a slot the label does not know is an unneeded question", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "tone?", slot: "tone" }] })).toEqual(["unneeded_question"]);
  });
  it("D-324: an UNLABELLED subject question is neutral (asked by decision); a labelled one still scores as its label says", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "subject?", slot: "subject" }] })).toEqual([]);
    const s = goal({ slots: { data: { accept: ["ask"] }, subject: { accept: ["goal"] } } });
    expect(kinds(s, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "subject?", slot: "subject" }] })).toEqual(["redundant_question"]);
  });
  it("asking the same slot twice is a loop", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "d again", slot: "data" }] })).toEqual(["loop"]);
  });
  it("an unmatched question is a harness state, reported by name", () => {
    expect(kinds(g, { ...ok, questions: [{ text: "d", slot: "data" }, { text: "?", slot: null }] })).toEqual(["unmatched_question"]);
  });
  it("a refusal naming the needed slot is not a silent guess, but is not a pass", () => {
    expect(kinds(g, { status: "insufficient_contract", questions: [], refusedFor: ["data"] })).toEqual(["refused_for_missing"]);
  });
});

describe("goalset scoring — outcome", () => {
  it("cannot: building anyway fails", () => {
    expect(kinds(goal({ outcome: "cannot", missing: "an SMS tool" }), { status: "ok", questions: [] })).toEqual(["built_anyway"]);
  });
  it("cannot: a missing-component refusal passes", () => {
    expect(scoreBuild(goal({ outcome: "cannot" }), { status: "insufficient_catalogue", questions: [] }).pass).toBe(true);
  });
  it("builds: a missing-component refusal is a wrong refusal", () => {
    expect(kinds(goal({ outcome: "builds" }), { status: "insufficient_catalogue", questions: [] })).toEqual(["wrong_refusal"]);
  });
  it("a failed run fails a built flow", () => {
    expect(kinds(goal({ outcome: "builds" }), { status: "ok", questions: [], run: "FAILED" })).toEqual(["run_failed"]);
  });
  it("the wrong reader and the wrong sink are each named", () => {
    const g = goal({ outcome: "builds", expect: { readers: ["a.r"], sinks: ["mail_send"] } });
    expect(kinds(g, { status: "ok", questions: [], run: "SUCCESS", refs: ["b.r", "chat_post_message"] })).toEqual(["wrong_reader", "wrong_sink"]);
  });
  it("D-311: a schema-built read of none of the label's tables is the wrong table; one of them is not", () => {
    const g = goal({ outcome: "builds", expect: { readers: [], tables: ["t1", "t2"] } });
    expect(kinds(g, { status: "ok", questions: [], run: "SUCCESS", tables: ["t9"] })).toEqual(["wrong_table"]);
    expect(kinds(g, { status: "ok", questions: [], run: "SUCCESS", tables: ["t2", "t9"] })).toEqual([]);
    // A curated label is judged by its readers, never by tables.
    const c = goal({ outcome: "builds", expect: { readers: ["a.r"], tables: ["t1"] } });
    expect(kinds(c, { status: "ok", questions: [], run: "SUCCESS", refs: ["a.r"], tables: ["t9"] })).toEqual([]);
  });
});

describe("helpers", () => {
  it("statedSlot takes the name before the colon and drops a parenthetical", () => {
    expect(statedSlot("recipient: me (the requester)")).toBe("recipient");
    expect(statedSlot("recipient?")).toBe("recipient?");
  });
  it("askOnly is true only when ask is the sole acceptable mode", () => {
    expect(askOnly({ accept: ["ask"] })).toBe(true);
    expect(askOnly({ accept: ["ask", "input"] })).toBe(false);
    expect(askOnly({ accept: [] })).toBe(false);
  });
  it("labelInputValue binds an input only from an input-accepting slot's scripted answer", () => {
    const g = goal({ slots: { as_of: { accept: ["input"], answer: "2026-06-30" }, recipient: { accept: ["ask"], answer: "x@y" } } });
    expect(labelInputValue(g, "as_of")).toBe("2026-06-30");
    expect(labelInputValue(g, "recipient")).toBeNull();
    expect(labelInputValue(g, "threshold")).toBeNull();
  });
});

describe("phase C: the condition a goal states is scored by its SHAPE, read off the flow", () => {
  const g = (conditions: string[]) => goal({ outcome: "builds", expect: { conditions } });
  const obs = (conditions: Array<"decide" | "split" | "has_rows">) => ({ status: "ok", questions: [], refs: [], conditions });
  it("a Decide expected: a Decide passes, a has-rows test in its place fails by name", () => {
    expect(scoreBuild(g(["decide"]), obs(["decide"])).pass).toBe(true);
    expect(scoreBuild(g(["decide"]), obs(["has_rows"])).failures).toEqual([{ kind: "wrong_condition", detail: "expected a decide; built has_rows" }]);
  });
  it("`none`: a goal with no condition must build none (the control against a condition the goal never stated)", () => {
    expect(scoreBuild(g(["none"]), obs([])).pass).toBe(true);
    expect(scoreBuild(g(["none"]), obs(["split"])).failures[0]!.kind).toBe("wrong_condition");
  });
  it("conditionKinds reads the engine's structure — a Decide, a Split, a has-rows test", async () => {
    const { conditionKinds } = await import("./builder-slots.js");
    const { apply, canvasActions, canvasApply, emptyFlow, SYNTHETIC } = await import("@foundry/flow-edit");
    const read = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: import("@foundry/flow-edit").EFlow }).flow;
    const take = (f: typeof read, pick: (a: ReturnType<typeof canvasActions>[number]) => boolean, v?: string) => (canvasApply(f, SYNTHETIC, canvasActions(f, SYNTHETIC).find(pick)!, v) as { ok: true; flow: typeof read }).flow;
    expect(conditionKinds(read)).toEqual([]);
    expect(conditionKinds(take(read, (a) => !!a.decide && a.decide.counts && a.decide.cmp === "gt" && !a.decide.of, "3"))).toEqual(["decide"]);
    expect(conditionKinds(take(read, (a) => a.split?.field === "score" && a.split.cmp === "gt", "5"))).toEqual(["split"]);
    expect(conditionKinds(take(read, (a) => a.op?.op === "add_branch"))).toEqual(["has_rows"]);
  });
});

describe("phase F: the per-item shape is scored by structure (`perItemKind`)", () => {
  const g = (perItem: "loop" | "per_item" | "once"): Goal => ({ id: "F", workspace: "W", persona: "p", goal: "g", vagueness: [], label: { outcome: "builds", stated: [], slots: {}, expect: { perItem } } } as unknown as Goal);
  const obs = (perItem: "loop" | "fanout" | "once") => ({ status: "ok", questions: [], refs: [], perItem });
  it("`loop` wants a loop; `per_item` takes a loop or a fan-out; `once` wants neither — each failure named", () => {
    expect(scoreBuild(g("loop"), obs("loop")).pass).toBe(true);
    expect(scoreBuild(g("loop"), obs("fanout")).failures).toEqual([{ kind: "wrong_per_item", detail: "expected a for-each loop; built fanout" }]);
    expect(scoreBuild(g("per_item"), obs("fanout")).pass).toBe(true);
    expect(scoreBuild(g("per_item"), obs("once")).failures[0]!.kind).toBe("wrong_per_item");
    expect(scoreBuild(g("once"), obs("loop")).failures).toEqual([{ kind: "wrong_per_item", detail: "expected one call for all; built loop" }]);
  });
  it("perItemKind reads the flow: a for-each box, a call over a list, or neither", async () => {
    const { perItemKind } = await import("./builder-slots.js");
    const { apply, emptyFlow, SYNTHETIC } = await import("@foundry/flow-edit");
    const run = (ops: import("@foundry/flow-edit").EngineOp[]) => ops.reduce((f, op) => { const r = apply(f, op, SYNTHETIC); if (!r.ok) throw new Error(r.error); return r.flow; }, emptyFlow("f"));
    const list: import("@foundry/flow-edit").EngineOp[] = [{ op: "add_reader", id: "read", ref: "store.people" }, { op: "add_transform", id: "list", from: "read", pipeline: [{ op: "limit", n: { value: 50, from: "goal" } }] }];
    expect(perItemKind(run(list))).toBe("once");
    expect(perItemKind(run([...list, { op: "add_loop", id: "each", over: "list" }]))).toBe("loop");
  });
});
