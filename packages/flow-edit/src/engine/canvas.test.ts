/**
 * The canvas adapter (phase 7, D-328): the manual builder offers exactly the engine's legal moves.
 * - every action it lists applies (one definition of legality);
 * - it reaches every option the LLM builder is offered (`optionsOf`) — the same op, or a slot that makes it;
 * - a random walk through the CANVAS never reaches a state with a checker error (P1, through the canvas), with a negative
 *   control: switching a precondition off must let the walk reach one;
 * - every engine op kind is taken by some walk (every legal move reachable from the UI).
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderDiagnostic } from "../typecheck/diagnostic.js";
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import { actionsAt, canvasActions, canvasApply, canvasWalk, CANVAS_WEIGHT as WEIGHT, holesOnNode, unreadableFor, type CanvasAction } from "./canvas.js";
import { checkState, emptyFlow, errorsOf, holesOf, type EFlow, type EStep } from "./model.js";
import { apply, DISABLED_PRECONDITIONS, type EngineOp } from "./ops.js";
import { optionsOf, runTimeChoices } from "./options.js";
import { decideTest, flowShape, splitSide } from "./shape.js";
import { SYNTHETIC, syntheticCatalogue } from "./synthetic.js";
import { complete, rng, sampleLiteral, walk } from "./walk.js";

function run(seeds: number, cats: (i: number) => CatalogueSnapshot, taken?: Set<string>) {
  const failures: string[] = [];
  let states = 0;
  for (let i = 0; i < seeds; i++) {
    const cat = cats(i);
    let steps;
    try { steps = canvasWalk(emptyFlow("canvas"), cat, 1 + (i % 30), 5000 + i, taken); } catch (e) { failures.push((e as Error).message); continue; }
    for (const [k, st] of steps.entries()) {
      states++;
      const errs = errorsOf(checkState(st.flow, cat));
      if (errs.length) { failures.push(`seed ${5000 + i} step ${k} after “${st.a}”:\n${errs.map(renderDiagnostic).join("\n")}`); break; }
    }
  }
  return { failures, states };
}

afterEach(() => DISABLED_PRECONDITIONS.clear());

describe("canvas adapter: the manual builder offers exactly the legal moves", () => {
  const states = (): Array<{ f: EFlow; cat: CatalogueSnapshot }> => {
    const out: Array<{ f: EFlow; cat: CatalogueSnapshot }> = [];
    for (let seed = 1; seed <= 40; seed++) {
      const cat = seed % 2 ? SYNTHETIC : syntheticCatalogue(seed);
      const steps = walk(emptyFlow("t"), cat, 1 + (seed % 14), seed);
      out.push({ f: emptyFlow("t"), cat }, ...steps.map((s) => ({ f: s.flow, cat })), ...complete(steps.at(-1)?.flow ?? emptyFlow("t"), cat, seed).map((s) => ({ f: s.flow, cat })));
    }
    return out;
  };

  it("every action it lists with an op applies — one definition of legality", () => {
    let checked = 0;
    for (const { f, cat } of states()) {
      const acts = canvasActions(f, cat);
      expect(new Set(acts.map((a) => a.id)).size).toBe(acts.length);
      for (const a of acts) {
        expect([a.op, a.ops, a.slot].filter(Boolean).length, a.label).toBe(1);
        if (a.op) { const r = apply(f, a.op, cat); expect(r.ok, `${a.label}: ${r.ok ? "" : r.error}`).toBe(true); checked++; }
        if (a.ops) { const r = canvasApply(f, cat, a); expect(r.ok, `${a.label}: ${r.ok ? "" : r.error}`).toBe(true); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(1500); // CONTROL: many actions judged
  });

  it("reaches every option the LLM builder is offered — the same op, or a slot that makes it", () => {
    let matched = 0;
    for (const { f, cat } of states()) {
      const acts = canvasActions(f, cat);
      const ops = new Set(acts.filter((a) => a.op).map((a) => JSON.stringify(a.op)));
      const slotMakes = (op: EngineOp, value: string) => acts.some((a) => a.slot && JSON.stringify(a.slot.make(value)) === JSON.stringify(op));
      for (const o of optionsOf(f, cat, { inputRoles: ["period"], cron: "0 9 * * 1" })) {
        if (o.op) {
          const reached = ops.has(JSON.stringify(o.op))
            || (o.op.op === "declare_input" && slotMakes(o.op, "period"))
            || (o.op.op === "set_schedule" && o.op.cron !== null && slotMakes(o.op, o.op.cron))
            || (o.op.op === "add_gate" && slotMakes(o.op, o.op.summary));
          expect(reached, `not reachable from the canvas: ${o.label} ${JSON.stringify(o.op)}`).toBe(true);
        } else {
          const v = sampleLiteral(o.literal!.ty, cat, rng(1));
          expect(slotMakes(o.literal!.make(v, "person"), v), `no slot for: ${o.label}`).toBe(true);
        }
        matched++;
      }
    }
    expect(matched).toBeGreaterThan(1500);
  });

  it("a merge is reachable from the canvas: a condition, an otherwise, the same shape in both arms, then one value", () => {
    // A random canvas walk rarely builds two same-typed arms, so the one op kind it does not reach by chance is reached here,
    // taking ONLY actions the canvas lists at each step.
    const cat = SYNTHETIC;
    let f = emptyFlow("t");
    const take = (where: Parameters<typeof actionsAt>[2], match: (a: CanvasAction) => boolean) => {
      const a = actionsAt(f, cat, where).find(match);
      expect(a, `no action at ${JSON.stringify(where)}`).toBeTruthy();
      const r = canvasApply(f, cat, a!);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      f = (r as { flow: EFlow }).flow;
      return a!.op as EngineOp & { id?: string };
    };
    const read = take({ at: "palette" }, (a) => a.op?.op === "add_reader" && a.op.ref === "store.people").id!;
    const when = take({ at: "step", stepId: read }, (a) => a.op?.op === "add_branch" && a.op.when[0]!.test === "any").id!;
    const other = take({ at: "step", stepId: when }, (a) => a.op?.op === "add_otherwise" && !a.op.when).id!;
    const same = (under: string) => (a: CanvasAction) => a.op?.op === "add_transform" && a.op.from === read && a.op.pipeline[0]!.op === "count" && a.op.under === under;
    take({ at: "palette", under: when }, same(when));
    take({ at: "palette", under: other }, same(other));
    const merged = take({ at: "palette" }, (a) => a.op?.op === "add_merge").id!;
    take({ at: "step", stepId: merged }, (a) => a.op?.op === "set_output");
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    expect(f.holes).toEqual([]); // complete: savable as a revision
  });

  it("a loop is built and changed from the canvas alone: a bounded list, for each, steps inside, its output, its settings", () => {
    // Phase F, F4: a random walk rarely closes a loop and then changes it, so those op kinds are reached here — ONLY actions the
    // canvas lists at each step, a typed value where a slot asks for one.
    const cat = SYNTHETIC;
    let f = emptyFlow("t");
    const take = (where: Parameters<typeof actionsAt>[2], match: (a: CanvasAction) => boolean, value?: string) => {
      const a = actionsAt(f, cat, where).find(match);
      expect(a, `no action at ${JSON.stringify(where)}: ${actionsAt(f, cat, where).map((x) => x.label).join(" | ")}`).toBeTruthy();
      const r = canvasApply(f, cat, a!, value);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      f = (r as { flow: EFlow }).flow;
      return a!;
    };
    const idOf = (a: CanvasAction) => (a.op as { id: string }).id;
    const read = idOf(take({ at: "palette" }, (a) => a.op?.op === "add_reader" && a.op.ref === "store.people"));
    const list = idOf(take({ at: "palette" }, (a) => a.op?.op === "add_transform" && a.op.from === read && a.op.pipeline[0]!.op === "sort"));
    // Unbounded lists cannot be looped over: no for-each is offered until the list has a limit.
    expect(actionsAt(f, cat, { at: "palette" }).some((a) => a.kind === "loop")).toBe(false);
    take({ at: "stages", stepId: list }, (a) => a.slot?.kind === "append_stage" && /first|limit|at most/i.test(a.label), "10");
    const each = idOf(take({ at: "palette" }, (a) => a.kind === "loop" && a.op?.op === "add_loop" && a.op.over === list));
    expect(f.holes.some((h) => h.site.at !== "output" && h.site.stepId === each)).toBe(true); // an empty box is a hole
    // Inside: a call once per item, its text from the item.
    const call = idOf(take({ at: "palette", under: each }, (a) => a.op?.op === "add_call" && a.op.ref === "notify_me" && a.op.under === each));
    take({ at: "port", stepId: call, port: "text" }, (a) => a.op?.op === "bind" && (a.op.source as { stepId?: string }).stepId === each && a.group === "the item — this run of the loop");
    // Its output: one row per item, each with the call's result.
    const rows = idOf(take({ at: "step", stepId: each }, (a) => a.op?.op === "close_loop" && a.op.result === call));
    // A second step inside, then each row's result changed to it.
    const tag = idOf(take({ at: "palette", under: each }, (a) => a.op?.op === "add_transform" && a.op.from === each && a.op.under === each));
    take({ at: "step", stepId: rows }, (a) => a.op?.op === "set_loop_result" && a.op.result === tag);
    // Its settings: a typed number of items at once (a wrong one refused by name), and stop-on-failure.
    const atOnce = actionsAt(f, cat, { at: "step", stepId: each }).find((a) => a.slot?.kind === "set_loop")!;
    expect(canvasApply(f, cat, atOnce, "21")).toMatchObject({ ok: false });
    expect(canvasApply(f, cat, atOnce, "three")).toMatchObject({ ok: false, error: expect.stringMatching(/not a whole number/) });
    take({ at: "step", stepId: each }, (a) => a.slot?.kind === "set_loop", "3");
    take({ at: "step", stepId: each }, (a) => a.op?.op === "set_loop" && a.op.onError === "stop");
    take({ at: "step", stepId: rows }, (a) => a.op?.op === "set_output");
    expect(f.steps.find((s) => s.id === each)).toMatchObject({ kind: "for_each", concurrency: 3, onError: "stop" });
    expect(f.steps.find((s) => s.id === rows)).toMatchObject({ kind: "collect", loop: each, result: tag });
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    expect(f.holes).toEqual([]); // complete: savable as a revision
    // The shape carries the box: the loop's members and output, and each inside step names its loop.
    const sh = flowShape(f, cat);
    expect(sh[each]!.loop).toMatchObject({ over: list, concurrency: 3, onError: "stop", members: [call, tag], collect: rows, result: tag });
    expect([sh[call]!.inLoop, sh[tag]!.inLoop, sh[rows]!.inLoop, sh[list]!.inLoop]).toEqual([each, each, undefined, undefined]);
    // Outside the loop, a step cannot read inside it — the picker says why.
    const after = idOf(take({ at: "palette" }, (a) => a.op?.op === "add_call" && a.op.ref === "notify_me" && !a.op.under));
    expect(unreadableFor(f, cat, after, "text").find((u) => u.stepId === call)?.why).toMatch(/inside the loop .*once per item/);
  });

  it("a random walk through the canvas never reaches an ill-typed state (P1 through the canvas)", () => {
    const taken = new Set<string>();
    const a = run(500, () => SYNTHETIC, taken), b = run(500, (i) => syntheticCatalogue(300 + i), taken);
    expect([...a.failures, ...b.failures].slice(0, 3)).toEqual([]);
    expect(a.states + b.states).toBeGreaterThan(5000);
    // Every legal move is reachable from the UI: each engine op kind was taken by some canvas walk.
    // `add_merge` is not required (I-317: rarely reachable); nor are a loop's close and its later changes (phase F: a walk of at
    // most 30 moves rarely bounds a list, loops it, fills it and closes it) — each is reached by its own directed test above.
    const RARE = new Set(["add_merge", "close_loop", "set_loop", "set_loop_result"]);
    expect([...taken].filter((k) => !RARE.has(k)).sort()).toEqual(Object.keys(WEIGHT).filter((k) => !RARE.has(k)).sort());
  }, 180_000);

  it("NEGATIVE CONTROL: with the type-fit precondition switched off, the canvas walk reaches an ill-typed state", () => {
    DISABLED_PRECONDITIONS.add("fits");
    const r = run(300, () => SYNTHETIC);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 120_000);

  it("a dropped call with unset required inputs is a node with holes: valid, incomplete, savable as such", () => {
    const cat = SYNTHETIC;
    const drop = actionsAt(emptyFlow("t"), cat, { at: "palette" }).find((a) => a.op?.op === "add_call" && a.op.ref === "mail_send")!;
    const r = canvasApply(emptyFlow("t"), cat, drop);
    expect(r.ok).toBe(true);
    const f = (r as { flow: EFlow }).flow, id = (drop.op as { id: string }).id;
    const holes = holesOnNode(f, id);
    expect(holes.map((h) => (h.site as { port: string }).port).sort()).toEqual(["body", "subject", "to"]);
    const ds = checkState(f, cat);
    expect(errorsOf(ds)).toEqual([]);
    expect(holesOf(ds).length).toBeGreaterThan(0);
    // The port picker for `to` offers only what fits a list of addresses: here, a value typed, nothing from a step.
    const picks = actionsAt(f, cat, { at: "port", stepId: id, port: "to" });
    expect(picks.length).toBeGreaterThan(0);
    const typedTo = picks.find((a) => a.slot)!;
    expect(canvasApply(f, cat, typedTo, "not an address").ok).toBe(false);
    expect(canvasApply(f, cat, typedTo, "ops@acme-corp.com").ok).toBe(true);
  });

  it("a slot with no value is not taken", () => {
    const f = emptyFlow("t");
    const s = canvasActions(f, SYNTHETIC).find((a) => a.slot)!;
    expect(canvasApply(f, SYNTHETIC, s).ok).toBe(false);
  });
});

describe("a month or a date as of the run (2026-09-29)", () => {
  const withReader = () => (apply(emptyFlow("t"), { op: "add_reader", id: "r", ref: "store.widgets" }, SYNTHETIC) as { flow: EFlow }).flow;
  it("a date port is offered the day it runs and the day before — one action each, declaring the computed input and binding it", () => {
    const f = withReader();
    const acts = actionsAt(f, SYNTHETIC, { at: "port", stepId: "r", port: "as_of" }).filter((a) => a.ops);
    expect(acts.map((a) => a.label)).toEqual(["the day it runs (worked out when it runs)", "the day before it runs (worked out when it runs)", "the first day of the month it runs (worked out when it runs)", "the first day of the month before it runs (worked out when it runs)"]);
    const r = canvasApply(f, SYNTHETIC, acts[0]!);
    expect(r.ok).toBe(true);
    const g = (r as { flow: EFlow }).flow;
    expect(g.inputs).toContainEqual(expect.objectContaining({ id: "run_day", computed: "currentDate" }));
    expect(g.holes.some((h) => h.site.at === "port" && h.site.port === "as_of")).toBe(false);
    expect(errorsOf(checkState(g, SYNTHETIC))).toEqual([]);
  });
  it("once that input exists it is offered as the input itself, never declared a second time", () => {
    const f = withReader();
    const first = actionsAt(f, SYNTHETIC, { at: "port", stepId: "r", port: "as_of" }).find((a) => a.ops)!;
    const g = (canvasApply(f, SYNTHETIC, first) as { flow: EFlow }).flow;
    const g2 = (apply(g, { op: "unbind", stepId: "r", port: "as_of", owner: "person" }, SYNTHETIC) as { flow: EFlow }).flow;
    const again = actionsAt(g2, SYNTHETIC, { at: "port", stepId: "r", port: "as_of" });
    expect(again.filter((a) => a.ops).map((a) => a.label)).toEqual(["the day before it runs (worked out when it runs)", "the first day of the month it runs (worked out when it runs)", "the first day of the month before it runs (worked out when it runs)"]);
    expect(again.some((a) => a.op?.op === "bind" && (a.op.source as { inputId?: string }).inputId === "run_day")).toBe(true);
  });
  it("CONTROL: a text port is offered none", () => {
    expect(runTimeChoices(emptyFlow("t"), "x", "text", { t: "Text" })).toEqual([]);
  });
});

describe("a condition on ONE value is one gesture on the canvas (phase C, D-371)", () => {
  const start = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
  const find = (f: EFlow, label: string) => canvasActions(f, SYNTHETIC).find((a) => a.label === label);
  it("'only when the count of read_1 is more than …' with 3 → a test ahead of a has-rows condition, drawn as one condition", () => {
    const a = find(start, "only when the count of read_1 is more than …")!;
    expect(a.decide).toEqual({ subject: "read_1", field: "n", counts: true, cmp: "gt", words: "the count of read_1", cmpWords: "is more than" });
    expect(a.label).toBe(`only when ${a.decide!.words} ${a.decide!.cmpWords} …`); // the label and the carried words are one wording
    const r = canvasApply(start, SYNTHETIC, a, "3");
    expect(r.ok).toBe(true);
    const g = (r as { ok: true; flow: EFlow }).flow;
    expect(errorsOf(checkState(g, SYNTHETIC))).toEqual([]);
    const cond = g.steps.find((s) => s.kind === "branch")!;
    expect(flowShape(g, SYNTHETIC)[cond.id]!.paths![0]!.conditions[0]!.test).toMatchObject({ subject: "read_1", before: [{ op: "count", as: "n" }] });
    // And its else-if, the same gesture: the test is placed AHEAD of the chain, so it has run when the chain decides.
    const e = find(g, "otherwise, when the count of read_1 is at least …")!;
    const r2 = canvasApply(g, SYNTHETIC, e, "1");
    expect(r2.ok).toBe(true);
    const h = (r2 as { ok: true; flow: EFlow }).flow;
    expect(errorsOf(checkState(h, SYNTHETIC))).toEqual([]);
    const ids = h.steps.map((s) => s.id);
    const elifTest = h.steps.find((s) => s.kind === "branch" && s.elseOf)!;
    const testId = (elifTest as { conditions: Array<{ left: { stepId: string } }> }).conditions[0]!.left.stepId;
    expect(ids.indexOf(testId)).toBeLessThan(ids.indexOf(cond.id));
    // An else-if depends on nothing and reads its test only through its condition: still recognised as a Decide, and editable.
    const paths = flowShape(h, SYNTHETIC)[cond.id]!.paths!;
    expect(paths[1]!.conditions[0]!.test).toMatchObject({ subject: "read_1", where: { cmp: "ge" } });
    expect(canvasActions(h, SYNTHETIC).some((a) => a.retest && a.where.at === "step" && a.where.stepId === elifTest.id)).toBe(true);
  });
  it("a value that is not a number is refused by name, and nothing is added", () => {
    const r = canvasApply(start, SYNTHETIC, find(start, "only when the count of read_1 is more than …")!, "lots");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not a number/);
  });
});

describe("removing a condition on one value removes its test with it (phase C)", () => {
  it("one action; nothing is left behind; CONTROL: a plain has-rows condition removes alone", () => {
    const start = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
    const add = canvasActions(start, SYNTHETIC).find((a) => a.label === "only when the count of read_1 is more than …")!;
    const g = (canvasApply(start, SYNTHETIC, add, "3") as { ok: true; flow: EFlow }).flow;
    const cond = g.steps.find((s) => s.kind === "branch")!.id;
    const rm = canvasActions(g, SYNTHETIC).find((a) => a.label === "remove this step" && a.where.at === "step" && a.where.stepId === cond)!;
    const h = (canvasApply(g, SYNTHETIC, rm) as { ok: true; flow: EFlow }).flow;
    expect(h.steps.map((s) => s.id)).toEqual(["read_1"]);
    const plain = (apply(start, { op: "add_branch", id: "when_1", when: [{ stepId: "read_1", test: "any" }] }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
    const rm2 = canvasActions(plain, SYNTHETIC).find((a) => a.label === "remove this step" && a.where.at === "step" && a.where.stepId === "when_1")!;
    expect(rm2.op).toEqual({ op: "remove_step", stepId: "when_1" });
  });
});

describe("a Split — rows divided by one test, each exit its own path (phase C, D-373)", () => {
  const start = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
  const label = "split the rows of read_1 where score is more than … from the rest";
  it("one gesture: two filters — the rest's test GENERATED as `not` of the first — and a has-rows condition on each, independent", () => {
    const a = canvasActions(start, SYNTHETIC).find((x) => x.label === label)!;
    expect(a.split).toEqual({ subject: "read_1", field: "score", cmp: "gt", words: "the rows of read_1 where score", cmpWords: "is more than" });
    expect(a.label).toBe(`split ${a.split!.words} ${a.split!.cmpWords} … from the rest`);
    const g = (canvasApply(start, SYNTHETIC, a, "50") as { ok: true; flow: EFlow }).flow;
    expect(errorsOf(checkState(g, SYNTHETIC))).toEqual([]);
    const byId = (id: string) => g.steps.find((s) => s.id === id) as Extract<EStep, { kind: "transform" }>;
    const where = (byId("matched_1").pipeline[0] as { where: unknown }).where;
    expect((byId("rest_1").pipeline[0] as { where: unknown }).where).toEqual({ not: where });
    const heads = g.steps.filter((s) => s.kind === "branch");
    expect(heads.map((b) => b.kind === "branch" && b.elseOf)).toEqual([undefined, undefined]); // two chains, not IF/ELSE: both may run
    const shape = flowShape(g, SYNTHETIC);
    expect(shape.matched_1!.split).toMatchObject({ side: "matched", pair: "rest_1", subject: "read_1", branchId: "when_1" });
    expect(shape.rest_1!.split).toMatchObject({ side: "rest", pair: "matched_1", subject: "read_1", branchId: "when_2" });
    // Each exit is empty until a step is dropped in — a hole on each, said by the engine, not a silent no-op.
    expect(g.holes.filter((h) => h.site.at === "arm").map((h) => (h.site as { stepId: string }).stepId).sort()).toEqual(["when_1", "when_2"]);
    // An exit's step reads its own rows: a count of the matched rows, dropped into the matched exit, is listed and checks clean.
    const drop = canvasActions(g, SYNTHETIC).find((x) => x.where.at === "palette" && x.where.under === "when_1" && x.op?.op === "add_transform" && (x.op as { from: string }).from === "matched_1");
    expect(drop).toBeDefined();
    const h = (canvasApply(g, SYNTHETIC, drop!) as { ok: true; flow: EFlow }).flow;
    expect(errorsOf(checkState(h, SYNTHETIC))).toEqual([]);
  });
  it("CONTROL: edit one filter and the pair is two ordinary filters again — recognised from structure, never a stored flag", () => {
    const g = (canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((x) => x.label === label)!, "50") as { ok: true; flow: EFlow }).flow;
    const edited = { ...g, steps: g.steps.map((s) => s.id === "rest_1" && s.kind === "transform" ? { ...s, pipeline: [...s.pipeline, { op: "limit" as const, n: { value: 5, from: "person" as const } }] } : s) };
    expect(flowShape(edited, SYNTHETIC).matched_1!.split).toBeUndefined();
  });
  it("a value that is not a number is refused, and nothing is added", () => {
    const r = canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((x) => x.label === label)!, "lots");
    expect(r.ok).toBe(false);
  });
});

describe("a condition's comparison is changed in place — its paths and what runs on them kept (phase C, 2026-09-30)", () => {
  const start = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
  const ok = (r: ReturnType<typeof canvasApply>) => { expect(r).toMatchObject({ ok: true }); return (r as { ok: true; flow: EFlow }).flow; };
  const on = (f: EFlow, at: string) => canvasActions(f, SYNTHETIC).filter((a) => a.retest && a.where.at === "step" && a.where.stepId === at);
  const decided = ok(canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((a) => a.label === "only when the count of read_1 is more than …")!, "3"));
  const cond = decided.steps.find((s) => s.kind === "branch")!.id;
  // Something runs on the path, so the edit has a reader to keep.
  const drop = canvasActions(decided, SYNTHETIC).find((x) => x.where.at === "palette" && x.where.under === cond && x.op?.op === "add_transform")!;
  const withArm = ok(canvasApply(decided, SYNTHETIC, drop));

  it("a Decide: offered on the condition, starting from what it compares now; the new value replaces the old, nothing else moves", () => {
    const acts = on(withArm, cond);
    expect(acts.map((a) => a.retest!.cmp)).toContain("ge");
    expect(acts[0]!.retest).toMatchObject({ words: "the count of read_1", current: { cmp: "gt", value: "3" } });
    const g = ok(canvasApply(withArm, SYNTHETIC, acts.find((a) => a.retest!.cmp === "ge")!, "10"));
    expect(errorsOf(checkState(g, SYNTHETIC))).toEqual([]);
    expect(g.steps.map((s) => s.id)).toEqual(withArm.steps.map((s) => s.id)); // same steps — the path and its step kept
    const test = flowShape(g, SYNTHETIC)[cond]!.paths![0]!.conditions[0]!.test!;
    expect(test.where).toMatchObject({ cmp: "ge", right: { lit: { value: 10, from: "person" } } });
  });
  it("refused by name: a value that is not a number, and the test it already is", () => {
    const acts = on(withArm, cond);
    expect(canvasApply(withArm, SYNTHETIC, acts.find((a) => a.retest!.cmp === "ge")!, "lots")).toMatchObject({ ok: false, error: expect.stringMatching(/not a number/) });
    expect(canvasApply(withArm, SYNTHETIC, acts.find((a) => a.retest!.cmp === "gt")!, "3")).toMatchObject({ ok: false, error: "that is already the test" });
  });
  it("a Split: changed from its matching side, the rest REGENERATED as not of the new test — still one split", () => {
    const label = "split the rows of read_1 where score is more than … from the rest";
    const g = ok(canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((x) => x.label === label)!, "50"));
    expect(on(g, "when_2")).toEqual([]); // the rest follows its matching side; it is not changed on its own
    const h = ok(canvasApply(g, SYNTHETIC, on(g, "when_1").find((a) => a.retest!.cmp === "lt")!, "20"));
    expect(errorsOf(checkState(h, SYNTHETIC))).toEqual([]);
    const shape = flowShape(h, SYNTHETIC);
    expect(shape.matched_1!.split).toMatchObject({ side: "matched", pair: "rest_1" });
    const where = (h.steps.find((s) => s.id === "matched_1") as Extract<EStep, { kind: "transform" }>).pipeline[0] as { where: unknown };
    expect(JSON.stringify(where.where)).toContain('"lt"');
    expect((h.steps.find((s) => s.id === "rest_1") as Extract<EStep, { kind: "transform" }>).pipeline[0]).toMatchObject({ where: { not: where.where } });
  });
  it("CONTROL: the op refuses a transform that does not end in a test", () => {
    const t = ok(canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((x) => x.op?.op === "add_transform")!));
    const id = t.steps.find((s) => s.kind === "transform")!.id;
    expect(apply(t, { op: "retest", stepId: id, where: { notNull: "name" } }, SYNTHETIC)).toMatchObject({ ok: false });
  });
});

describe("a condition tests the ROWS of a list — it holds when some row passes (2026-09-30: `if read1.name == \"blanco\"`)", () => {
  const start = (apply(emptyFlow("f"), { op: "add_reader", id: "read_1", ref: "store.people" }, SYNTHETIC) as { ok: true; flow: EFlow }).flow;
  const ok = (r: ReturnType<typeof canvasApply>) => { expect(r).toMatchObject({ ok: true }); return (r as { ok: true; flow: EFlow }).flow; };
  const pick = (f: EFlow, label: string) => { const a = canvasActions(f, SYNTHETIC).find((x) => x.label === label); expect(a, label).toBeDefined(); return a!; };
  const g = ok(canvasApply(start, SYNTHETIC, pick(start, "only when read_1 has a row whose name is …"), "blanco"));
  const cond = g.steps.find((s) => s.kind === "branch")!.id;
  const testId = (g.steps.find((s) => s.id === cond) as Extract<EStep, { kind: "branch" }>).conditions![0]!.left.stepId;

  it("placed as a lone filter and the has-rows condition on it — nothing new reaches the compiler — and read back as ONE test", () => {
    expect(errorsOf(checkState(g, SYNTHETIC))).toEqual([]);
    expect((g.steps.find((s) => s.id === testId) as Extract<EStep, { kind: "transform" }>).pipeline).toEqual([{ op: "filter", where: { cmp: "eq", left: { field: "name" }, right: { lit: { value: "blanco", from: "person" } } } }]);
    expect(decideTest(g, testId)).toMatchObject({ subject: "read_1", before: [], anyRow: true });
    expect(flowShape(g, SYNTHETIC)[testId]!.testFor).toBe(cond);
  });
  it("an ELSE IF on another field of the same rows, and each link changed in place from its own row", () => {
    const h = ok(canvasApply(g, SYNTHETIC, pick(g, "otherwise, when read_1 has a row whose email is …"), "id1@acme.example"));
    expect(errorsOf(checkState(h, SYNTHETIC))).toEqual([]);
    const paths = flowShape(h, SYNTHETIC)[cond]!.paths!;
    expect(paths.map((p) => p.label)).toEqual(["IF", "ELIF"]);
    expect(paths[1]!.conditions[0]!.test).toMatchObject({ anyRow: true, where: { cmp: "eq", left: { field: "email" } } });
    const elif = paths[1]!.branchId;
    const acts = canvasActions(h, SYNTHETIC).filter((a) => a.retest && a.where.at === "step" && a.where.stepId === elif);
    expect(acts[0]!.retest).toMatchObject({ words: "read_1 has a row whose email", current: { cmp: "eq", value: "id1@acme.example" } });
    const k = ok(canvasApply(h, SYNTHETIC, acts.find((a) => a.retest!.cmp === "ne")!, "id1@acme.example"));
    expect(flowShape(k, SYNTHETIC)[cond]!.paths![1]!.conditions[0]!.test).toMatchObject({ anyRow: true, where: { cmp: "ne" } });
  });
  it("a field that may be empty states its null rule: a row with no team does not pass", () => {
    const h = ok(canvasApply(start, SYNTHETIC, pick(start, "only when read_1 has a row whose team is …"), "ops"));
    const t = h.steps.find((s) => s.kind === "transform") as Extract<EStep, { kind: "transform" }>;
    expect(t.pipeline[0]).toMatchObject({ op: "filter", where: { and: [{ notNull: "team" }, { cmp: "eq" }] } });
  });
  it("CONTROL: a filter whose rows a step reads is data, not a test; a Split's side is a Split, not a row test", () => {
    const run = (ops: EngineOp[]) => ops.reduce<EFlow>((f, o) => { const r = apply(f, o, SYNTHETIC); if (!r.ok) throw new Error(`${o.op}: ${r.error}`); return r.flow; }, start);
    const read = run([
      { op: "add_transform", id: "rows_1", from: "read_1", pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "name" }, right: { lit: { value: "blanco", from: "person" } } } }] },
      { op: "add_branch", id: "when_1", when: [{ stepId: "rows_1", test: "any" }] },
    ]);
    expect(decideTest(read, "rows_1")).toMatchObject({ anyRow: true }); // only the condition reads it: a row test
    const used = run([
      { op: "add_transform", id: "rows_1", from: "read_1", pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "name" }, right: { lit: { value: "blanco", from: "person" } } } }] },
      { op: "add_branch", id: "when_1", when: [{ stepId: "rows_1", test: "any" }] },
      { op: "add_transform", id: "names_1", from: "rows_1", pipeline: [{ op: "count", as: "n" }], under: "when_1" },
    ]);
    expect(decideTest(used, "rows_1")).toBeNull();
    const sp = ok(canvasApply(start, SYNTHETIC, pick(start, "split the rows of read_1 where name is … from the rest"), "blanco"));
    expect(decideTest(sp, "matched_1")).toBeNull();
    expect(splitSide(sp, "matched_1")).toMatchObject({ side: "matched" });
  });
});

describe("a transform's filter is changed in place, on the transform (2026-09-30: a filter could not be changed once placed)", () => {
  const run = (ops: EngineOp[]) => ops.reduce<EFlow>((f, o) => { const r = apply(f, o, SYNTHETIC); if (!r.ok) throw new Error(`${o.op}: ${r.error}`); return r.flow; }, emptyFlow("f"));
  const blanco = { cmp: "eq" as const, left: { field: "name" }, right: { lit: { value: "blanco", from: "goal" as const } } };
  const f = run([
    { op: "add_reader", id: "read_1", ref: "store.people" },
    { op: "add_transform", id: "where_1", from: "read_1", pipeline: [{ op: "filter", where: blanco }, { op: "filter", where: { cmp: "eq", left: { field: "email" }, right: { lit: { value: "a@acme-corp.com", from: "goal" } } } }] },
    { op: "add_branch", id: "when_1", when: [{ stepId: "where_1", test: "any" }] },
    { op: "add_transform", id: "count_1", from: "where_1", pipeline: [{ op: "count", as: "n" }], under: "when_1" },
  ]);
  const on = (g: EFlow) => canvasActions(g, SYNTHETIC).filter((a) => a.retest && a.where.at === "step" && a.where.stepId === "where_1");
  it("each filter stage is offered with what it compares now; a change moves only that stage", () => {
    const acts = on(f);
    expect(new Set(acts.map((a) => a.retest!.stage))).toEqual(new Set([0, 1]));
    expect(acts.find((a) => a.retest!.stage === 0)!.retest).toMatchObject({ field: "name", current: { cmp: "eq", value: "blanco" } });
    const g = canvasApply(f, SYNTHETIC, acts.find((a) => a.retest!.stage === 0 && a.retest!.cmp === "ne")!, "Contoso");
    expect(g).toMatchObject({ ok: true });
    const flow = (g as { ok: true; flow: EFlow }).flow;
    expect(errorsOf(checkState(flow, SYNTHETIC))).toEqual([]);
    const t = flow.steps.find((s) => s.id === "where_1") as Extract<EStep, { kind: "transform" }>;
    expect(t.pipeline[0]).toMatchObject({ op: "filter", where: { cmp: "ne", right: { lit: { value: "Contoso", from: "person" } } } });
    expect(t.pipeline[1]).toEqual((f.steps.find((s) => s.id === "where_1") as Extract<EStep, { kind: "transform" }>).pipeline[1]);
  });
  it("CONTROL: a Split's side is not offered on the transform — its rest must follow it, so it is changed from its condition", () => {
    const start = run([{ op: "add_reader", id: "read_1", ref: "store.people" }]);
    const sp = canvasApply(start, SYNTHETIC, canvasActions(start, SYNTHETIC).find((x) => x.label === "split the rows of read_1 where name is … from the rest")!, "blanco") as { ok: true; flow: EFlow };
    expect(canvasActions(sp.flow, SYNTHETIC).filter((a) => a.retest?.stage !== undefined)).toEqual([]);
  });
});

describe("the input picker says where each source comes from, and why a step cannot be read (phase C)", () => {
  const run = (ops: EngineOp[]) => ops.reduce<EFlow>((f, o) => { const r = apply(f, o, SYNTHETIC); if (!r.ok) throw new Error(`${o.op}: ${r.error}`); return r.flow; }, emptyFlow("f"));
  const f = run([
    { op: "add_reader", id: "read_1", ref: "store.people" },
    { op: "add_branch", id: "when_1", when: [{ stepId: "read_1", test: "any" }] },
    { op: "add_call", id: "call_1", ref: "chat_post", under: "when_1" },
    { op: "add_call", id: "call_2", ref: "chat_post" },
  ]);
  it("a step on a path reads what ran before the condition — grouped as always there", () => {
    const text = actionsAt(f, SYNTHETIC, { at: "port", stepId: "call_1", port: "text" }).filter((a) => a.op?.op === "bind");
    expect(text.length).toBeGreaterThan(0);
    for (const a of text) expect(a.group).toBe((a.op as { source: { from: string } }).source.from === "input" ? "the run's inputs" : "before the condition — always there");
  });
  it("after the condition, a path's step is listed as unreadable with the reason — read a merge — never silently absent", () => {
    const why = unreadableFor(f, SYNTHETIC, "call_2", "text");
    expect(why).toContainEqual({ stepId: "call_1", why: "runs only on the IF path of when_1 — after the condition, read a merge of the paths" });
    expect(why).toContainEqual({ stepId: "when_1", why: "a condition decides which path runs; it gives no data" });
    // CONTROL: what IS offered is not also listed as unreadable, and a step never lists itself.
    const offered = actionsAt(f, SYNTHETIC, { at: "port", stepId: "call_2", port: "text" }).flatMap((a) => { const s = (a.op as { source?: { stepId?: string } } | undefined)?.source; return s?.stepId ? [s.stepId] : []; });
    for (const u of why) expect(offered).not.toContain(u.stepId);
    expect(why.map((u) => u.stepId)).not.toContain("call_2");
  });
  it("on a path, a step later in the flow runs after it", () => {
    expect(unreadableFor(f, SYNTHETIC, "call_1", "text")).toContainEqual({ stepId: "call_2", why: "runs after this step" });
  });
});

describe("removing the only step of an otherwise (builder-behaviour P7, E03)", () => {
  const build = (ops: EngineOp[]) => ops.reduce((f, op) => { const r = apply(f, op, SYNTHETIC); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("t"));
  const BASE: EngineOp[] = [
    { op: "add_reader", id: "read", ref: "store.people" },
    { op: "add_transform", id: "some", from: "read", pipeline: [{ op: "filter", where: { notNull: "team" } }] },
    { op: "add_branch", id: "when_1", when: [{ stepId: "some", test: "any" }] },
    { op: "add_call", id: "mail", ref: "notify_me", under: "when_1" },
    { op: "add_otherwise", id: "otherwise_1", of: "when_1" },
    { op: "add_call", id: "post", ref: "chat_post", under: "otherwise_1" },
  ];
  it("takes the otherwise with it — no arm left guarding nothing", () => {
    const f = build(BASE);
    const a = canvasActions(f, SYNTHETIC).find((x) => x.label === "remove this step" && x.where.at === "step" && (x.where as { stepId: string }).stepId === "post")!;
    expect(a.ops?.map((o) => (o as { stepId: string }).stepId)).toEqual(["post", "otherwise_1"]);
    const r = canvasApply(f, SYNTHETIC, a);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.flow.steps.some((s) => s.id === "otherwise_1")).toBe(false); expect(r.flow.holes.some((h) => h.site.at === "arm")).toBe(false); }
  });
  it("CONTROL: an otherwise with another step left keeps its otherwise", () => {
    const f = build([...BASE, { op: "add_call", id: "post2", ref: "notify_me", under: "otherwise_1" }]);
    const a = canvasActions(f, SYNTHETIC).find((x) => x.label === "remove this step" && (x.where as { stepId?: string }).stepId === "post")!;
    expect(a.op).toEqual({ op: "remove_step", stepId: "post" });
  });
});
