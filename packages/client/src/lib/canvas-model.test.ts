// src/lib/canvas-model.test.ts — the canvas's data seam.
//
// What is worth testing here is NOT that dagre lays nodes out (it does) or that
// React Flow renders (the smoke test covers that). It is the two properties a
// wrong answer would be invisible for:
//
//   1. **The model-seam rule.** It is a privacy marker. A false negative — a node
//      that sends data to a model and is not badged — looks exactly like a
//      correct render, on every screen, for ever.
//   2. **Both adapters agree.** The whole argument for one `CanvasNode` model is
//      that `/runs/[id]` and `/flows/[id]` cannot draw one flow two ways. That is
//      only true while both adapters classify the same step the same.
import { describe, expect, it } from "vitest";
import {
  canvasFromExecution,
  canvasFromModel,
  canvasFromRawModel,
  connectedTo,
  seamOf,
  LLM_TOOL_REF,
  ARM_LABEL,
} from "@/lib/canvas-model";
import type { FlowStepReview, StepRun } from "@/lib/types";

const run = (over: Partial<StepRun>): StepRun => ({
  stepId: "s",
  status: "success",
  kind: "tool",
  ref: null,
  platform: false,
  readFrom: null,
  attempt: 1,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  request: null,
  responseCode: null,
  output: null,
  error: null,
  logs: [],
  kestraTaskrunId: null,
  auditVerdict: null,
  oracleScore: null,
  ...over,
});

const model = (over: Partial<FlowStepReview>): FlowStepReview => ({
  stepId: "s",
  kind: "tool",
  ordinal: 0,
  ref: null,
  dependsOn: [],
  generated: false,
  contract: null,
  codeLines: null,
  retry: null,
  awaitSeconds: null,
  paramsExpr: null,
  ...over,
});

describe("the model seam", () => {
  it(`marks a tool step calling ${LLM_TOOL_REF} and no other tool`, () => {
    expect(seamOf("tool", LLM_TOOL_REF)).toBe("llm");
    expect(seamOf("tool", "mail_send")).toBe(null);
  });

  it("does NOT mark a code step — a fragment has no network and no credentials", () => {
    // D-19. `code` is the kind that sounds like AI and is not: the body was
    // written by a model once, at generation, and then frozen into an immutable
    // revision. At runtime it is bytes in a container with `networkMode: none`.
    // Badging it would make the marker mean "a model was involved at some
    // point", which is true of nearly every step and therefore says nothing.
    expect(seamOf("code", null)).toBe(null);
  });

  it("fails CLOSED: a tool whose ref is unknown is 'unknown', never safe", () => {
    // ⚠ The single most important assertion in this file. `null` reaches here
    // whenever the server could not join the revision — pre-`flows` history, a
    // deleted flow, a read that threw. Answering `false` would render a clean
    // card over a step that may well be posting rows to a provider.
    expect(seamOf("tool", null)).toBe("unknown");
    expect(seamOf("tool", undefined)).toBe("unknown");
  });

  it("kinds that reference nothing are settled, not unknown", () => {
    // A `transform` has no ref to be missing, so `null` there is an answer and
    // not an absence. Returning "unknown" for these would flood a five-step
    // flow with question marks and train people to ignore them.
    for (const k of ["datasource", "transform", "approval"] as const) {
      expect(seamOf(k, null)).toBe(null);
    }
  });
});

describe("the two adapters agree", () => {
  // One flow, described from an execution and from a revision. The fields that
  // legitimately differ are status and timing; classification must not.
  const steps: Array<{ id: string; kind: FlowStepReview["kind"]; ref: string | null }> = [
    { id: "fetch", kind: "datasource", ref: "invoices_overdue" },
    { id: "summarise", kind: "tool", ref: LLM_TOOL_REF },
    { id: "send", kind: "tool", ref: "mail_send" },
    { id: "ask", kind: "tool", ref: "llm_complete" },
  ];

  const fromRun = canvasFromExecution(
    { nodes: steps.map((s) => ({ id: s.id, type: null })), edges: [] },
    steps.map((s) => run({ stepId: s.id, kind: s.kind, ref: s.ref })),
  );
  const fromModel = canvasFromModel(
    steps.map((s, i) => model({ stepId: s.id, kind: s.kind, ref: s.ref, ordinal: i })),
  );

  it("classifies every step identically", () => {
    expect(fromRun.nodes.map((n) => [n.id, n.kind, n.seam])).toEqual(
      fromModel.nodes.map((n) => [n.id, n.kind, n.seam]),
    );
  });

  it("finds the same seams", () => {
    expect(fromRun.hasSeam).toBe(true);
    expect(fromModel.hasSeam).toBe(true);
    expect(fromRun.nodes.filter((n) => n.seam === "llm").map((n) => n.id)).toEqual([
      "summarise",
      "ask",
    ]);
  });

  it("only the run view carries status", () => {
    // Deliberate: tinting a never-run draft grey would make a good flow look
    // like a stalled execution.
    expect(fromRun.nodes.every((n) => n.status !== null)).toBe(true);
    expect(fromModel.nodes.every((n) => n.status === null)).toBe(true);
  });
});

describe("topology", () => {
  it("builds edges from dependsOn, in dependency direction", () => {
    const g = canvasFromModel([
      model({ stepId: "b", ordinal: 1, dependsOn: ["a"] }),
      model({ stepId: "a", ordinal: 0 }),
    ]);
    expect(g.edges).toEqual([{ source: "a", target: "b" }]);
    // Sorted by depth, so the picture and a screen reader both read a → b.
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("drops a dangling dependsOn rather than drawing an edge to nowhere", () => {
    const g = canvasFromModel([model({ stepId: "a", dependsOn: ["ghost"] })]);
    expect(g.edges).toEqual([]);
    expect(g.nodes).toHaveLength(1);
  });

  it("keeps a step that ran but is not in the engine graph", () => {
    // A step the UI cannot place is still a step that happened — the same rule
    // `orderedStepIds` applies to the strip.
    const g = canvasFromExecution({ nodes: [{ id: "a", type: null }], edges: [] }, [
      run({ stepId: "a" }),
      run({ stepId: "surprise", kind: null }),
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "surprise"]);
  });

  it("shows a declared-but-never-reached step as not started", () => {
    const g = canvasFromExecution({ nodes: [{ id: "a", type: null }, { id: "b", type: null }], edges: [] }, [
      run({ stepId: "a" }),
    ]);
    expect(g.nodes.find((n) => n.id === "b")?.status).toBe("created");
  });

  it("highlights both directions from a node, and nothing off the path", () => {
    // Diamond: a → b → d, a → c → d. From b, `c` is neither upstream nor
    // downstream and must stay dim; an implementation walking only one
    // direction, or walking undirected, gets this wrong in opposite ways.
    const edges = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
    ];
    expect([...connectedTo("b", edges)].sort()).toEqual(["a", "b", "d"]);
  });
});

describe("a raw drafter model", () => {
  // Its input has never been through `writeRevision`, so this is the one adapter
  // that must survive rubbish. It renders the refusal panel — the screen where a
  // crash would replace the most useful diagnosis this system produces.
  it("survives every shape of nonsense", () => {
    for (const junk of [null, undefined, {}, { steps: "nope" }, { steps: [null, 3, "x"] }]) {
      expect(() => canvasFromRawModel(junk)).not.toThrow();
      expect(canvasFromRawModel(junk).nodes).toEqual([]);
    }
  });

  it("keeps a step with an unrecognised kind rather than dropping it", () => {
    // Dropping it would silently shrink the picture, and a flow that looks
    // smaller than it is, is the exact misreading the canvas exists to prevent.
    const g = canvasFromRawModel({ steps: [{ id: "x", kind: "teleport" }] });
    expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([["x", null]]);
  });

  it("flags the steps that refused", () => {
    const g = canvasFromRawModel(
      { steps: [{ id: "a" }, { id: "b" }] },
      new Map([["b", "needs a value"]]),
    );
    expect(g.nodes.find((n) => n.id === "b")?.flag).toBe("needs a value");
    expect(g.nodes.find((n) => n.id === "a")?.flag).toBe(null);
  });
});

/**
 * The facts a node carries for the details panel. They exist because a card is
 * 232px wide and the things a reviewer actually decides on — what a generated
 * fragment was asked to do, how long a gate may hold the run, which database a
 * draft run read — do not fit on it.
 */
describe("the facts a click reveals", () => {
  it("carries the contract's purpose, which is what a reviewer reads a code step for", () => {
    const [n] = canvasFromModel([
      model({ stepId: "rank", kind: "code", generated: true, codeLines: 12, contract: { purpose: "rank rows by variance" } }),
    ]).nodes;
    expect(n!.facts).toContainEqual({ label: "purpose", value: "rank rows by variance" });
    expect(n!.facts).toContainEqual({ label: "generated code", value: "12 lines" });
  });

  it("says how long a gate may hold the run, and that it holds a slot throughout", () => {
    const [n] = canvasFromModel([model({ stepId: "gate", kind: "approval", awaitSeconds: 86_400 })]).nodes;
    expect(n!.facts!.find((f) => f.label === "waits")!.value).toContain("1440 minutes");
    expect(n!.facts!.find((f) => f.label === "waits")!.value).toContain("concurrency slot");
  });

  /**
   * ⚠ Stage 4's claim, on the node someone clicked. A draft run against a
   * datasource with no sandbox reads PRODUCTION, and that has to be stated
   * rather than implied by the absence of a sandbox badge.
   */
  it("says which data a step read, naming production as production", () => {
    const [prod] = canvasFromExecution(null, [run({ stepId: "q", kind: "datasource", readFrom: "production" })]).nodes;
    expect(prod!.facts).toContainEqual({ label: "read from", value: "PRODUCTION data" });
    const [sbx] = canvasFromExecution(null, [run({ stepId: "q", kind: "datasource", readFrom: "sandbox" })]).nodes;
    expect(sbx!.facts).toContainEqual({ label: "read from", value: "the development sandbox" });
  });

  it("says a retry actually fired, rather than only that one was configured", () => {
    const [n] = canvasFromExecution(null, [run({ stepId: "t", attempt: 3 })]).nodes;
    expect(n!.facts!.find((f) => f.label === "attempts")!.value).toContain("3");
  });
});

/**
 * ⚠ **THREE STEPS, ONE CARD** — `CX-010` (canvas programme, closed; record removed 2026-09-11).
 *
 * `if`, `elif` and `else` are three `branch` steps in the model: that is what
 * the compiler emits and what `armOf` reads. They are one DECISION, and drawing
 * three cards for one decision is the same mistake as drawing none. Dify draws
 * one node with labelled ports; this is that, generalised to a chain.
 */
describe("an if/elif/else chain collapses to one node with one handle per arm", () => {
  const chain = {
    id: "f",
    steps: [
      { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" },
      { kind: "branch", id: "big", conditionExpr: "{{ a }}", dependsOn: ["read"] },
      { kind: "tool", id: "email", ref: "mail", paramsExpr: "[{}]", dependsOn: ["big"] },
      { kind: "branch", id: "small", conditionExpr: "{{ b }}", elseOf: "big" },
      { kind: "tool", id: "log", ref: "logger", paramsExpr: "[{}]", dependsOn: ["small"] },
      { kind: "branch", id: "rest", elseOf: "small" },
      { kind: "tool", id: "skip", ref: "noop", paramsExpr: "[{}]", dependsOn: ["rest"] },
    ],
  };

  it("draws ONE branch node, carrying every arm in order", () => {
    const g = canvasFromRawModel(chain);
    const branches = g.nodes.filter((n) => n.kind === "branch");
    expect(branches).toHaveLength(1);
    expect(branches[0]!.id).toBe("big");
    expect(branches[0]!.arms?.map((a) => a.label)).toEqual(["if", "else if", "otherwise"]);
    expect(branches[0]!.arms?.map((a) => a.id)).toEqual(["big", "small", "rest"]);
  });

  /**
   * ⚠ **THE HALF THAT MAKES THE PICTURE TRUE.** Collapsing the nodes without
   * re-sourcing the edges would leave `log` and `skip` hanging off nodes that
   * are no longer drawn — three steps would vanish from the canvas and take
   * their downstream work with them.
   */
  it("re-sources each arm's edge to the head, naming the arm", () => {
    const g = canvasFromRawModel(chain);
    const by = (t: string) => g.edges.find((e) => e.target === t);
    expect(by("email")).toMatchObject({ source: "big", sourceHandle: "big" });
    expect(by("log")).toMatchObject({ source: "big", sourceHandle: "small" });
    expect(by("skip")).toMatchObject({ source: "big", sourceHandle: "rest" });
    // ⚠ And an ordinary edge gains NO handle — React Flow falls back to the
    // single unnamed source, so adding one everywhere would be a change to
    // every other node's routing.
    expect(by("big")).toMatchObject({ source: "read" });
    expect(by("big")).not.toHaveProperty("sourceHandle");
  });

  /**
   * ⚠ **A LONE BRANCH IS NOT GIVEN ARMS.** One arm is not a fork, and drawing a
   * single "if" port on every guard in the product would claim a chain that is
   * not there. This is also the control for the test above: without it, code
   * that attached arms to every branch would pass.
   */
  it("leaves a branch with no continuation exactly as it was", () => {
    const lone = {
      id: "f",
      steps: [
        { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" },
        { kind: "branch", id: "only", conditionExpr: "{{ a }}", dependsOn: ["read"] },
        { kind: "tool", id: "email", ref: "mail", paramsExpr: "[{}]", dependsOn: ["only"] },
      ],
    };
    const g = canvasFromRawModel(lone);
    expect(g.nodes.filter((n) => n.kind === "branch")).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === "only")?.arms).toBeUndefined();
    expect(g.edges.find((e) => e.target === "email")).not.toHaveProperty("sourceHandle");
  });
  /**
   * ⚠ **ONE WORD ON THE WIRE, NOT TWO.** The arm handles used to carry the
   * arm's own name (`if` / `else if` / `otherwise`) beside the dot while the
   * edge carried nothing — so a reader following one wire out of a five-arm
   * chain had to count handles. The wire now says which outcome it carries
   * (`case 1` … `else`), and the handle says nothing.
   */
  describe("an arm's outcome word on the wire", () => {
    const arms = [
      { id: "big", label: "if" },
      { id: "small", label: "else if" },
      { id: "rest", label: "otherwise" },
    ];
    it("numbers every non-terminal arm as case N", () => {
      expect(ARM_LABEL(arms, "big")).toBe("case 1");
      expect(ARM_LABEL(arms, "small")).toBe("case 2");
    });
    it("calls the terminal catch-all else", () => {
      expect(ARM_LABEL(arms, "rest")).toBe("else");
    });
    it("numbers a chain with no catch-all without inventing an else", () => {
      const open = [
        { id: "big", label: "if" },
        { id: "small", label: "else if" },
      ];
      expect(ARM_LABEL(open, "big")).toBe("case 1");
      expect(ARM_LABEL(open, "small")).toBe("case 2");
    });
    it("labels nothing that is not an arm", () => {
      expect(ARM_LABEL(arms, "email")).toBeNull();
    });
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⚠ THE MERGE REGRESSION — reported from USE, and every test here was green
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The `merge` kind shipped with the compiler, the schema, the validator, the
   * prompts and the inspector, and the whole client test suite passed — because
   * every fixture in this file was written by the same hand as the code, and
   * none of them contained a merge. On real data four seeded flows drew their
   * join and its entire tail as an ISLAND: no incoming edge, floating beside
   * the flow, which reads as a broken automation rather than a converged one.
   *
   * ⚠ The cause is that a merge is the ONE kind whose topology is not in
   * `dependsOn`. `FlowStepReview` had no `sources` field, so the data never
   * reached the browser at all — `elseOf`'s defect, one kind later, in the same
   * projection, with the same "zero backend change" fix.
   *
   * ⚠ **The topology below is COPIED FROM THE DATABASE**, not invented: it is
   * `Monthly attendance check` as `flow_steps` actually stores it, else-arm
   * with no `dependsOn` and merge with no `dependsOn` included. A fixture
   * shaped the way the author expects is what let this ship.
   */
  describe("a merge, exactly as the database stores one", () => {
    const REAL = [
      { id: "flagged", kind: "datasource" },
      { id: "some_flagged", kind: "branch", dependsOn: ["flagged"], conditionExpr: "{{ 1 }}" },
      { id: "warn_shape", kind: "transform", dependsOn: ["some_flagged"] },
      { id: "warn", kind: "tool", dependsOn: ["warn_shape"] },
      { id: "none_flagged", kind: "branch", elseOf: "some_flagged" },
      { id: "allclear", kind: "tool", dependsOn: ["none_flagged"] },
      { id: "outcome", kind: "merge", sources: ["warn", "allclear"] },
      { id: "record", kind: "tool", dependsOn: ["outcome"] },
    ];
    const asReview = REAL.map((s, i) => ({
      stepId: s.id,
      kind: s.kind,
      ordinal: i,
      ref: null,
      dependsOn: (s as { dependsOn?: string[] }).dependsOn ?? [],
      generated: false,
      contract: null,
      codeLines: null,
      retry: null,
      awaitSeconds: null,
      paramsExpr: null,
      elseOf: (s as { elseOf?: string }).elseOf ?? null,
      conditionExpr: (s as { conditionExpr?: string }).conditionExpr ?? null,
      sources: (s as { sources?: string[] }).sources ?? null,
    }));

    /** The control: the flow really does have a merge and a tail after it. */
    it("the fixture is the shape being claimed", () => {
      expect(REAL.filter((s) => s.kind === "merge")).toHaveLength(1);
      expect(REAL.find((s) => s.id === "outcome")).not.toHaveProperty("dependsOn");
    });

    it("⚠ NOTHING is an island — every step but the root has a way in", () => {
      for (const g of [canvasFromModel(asReview as never), canvasFromRawModel({ steps: REAL })]) {
        const reachable = new Set(g.edges.map((e) => e.target));
        const orphans = g.nodes.map((n) => n.id).filter((id) => id !== "flagged" && !reachable.has(id));
        expect(orphans, "a step with no incoming edge draws as an island").toEqual([]);
      }
    });

    it("both arms feed the merge, so the join is visibly a join", () => {
      const g = canvasFromModel(asReview as never);
      const into = g.edges.filter((e) => e.target === "outcome").map((e) => e.sourceHandle ?? e.source);
      // The else arm collapses onto its head, so one edge arrives by handle.
      expect(into.sort()).toEqual(["allclear", "warn"]);
    });

    /**
     * ⚠ **The half a connected picture could still get wrong.** Drawing the
     * source edges is not enough: if the arm closure followed them, the merge
     * and its tail would be marked as running only inside one arm — the exact
     * grouping the engine does not honour, and the reason `armOf` stops at a
     * merge in the compiler.
     */
    it("the merge and its tail belong to NO arm — they run either way", () => {
      const g = canvasFromModel(asReview as never);
      expect(g.nodes.find((n) => n.id === "outcome")?.arm ?? null).toBeNull();
      expect(g.nodes.find((n) => n.id === "record")?.arm ?? null).toBeNull();
      // The control: arm membership is working at all on this graph.
      expect(g.nodes.find((n) => n.id === "warn")?.arm?.armId).toBe("some_flagged");
    });

    /**
     * ⚠ **THE TEST ABOVE CANNOT FAIL, AND THIS ONE IS WHY IT IS NOT ENOUGH.**
     *
     * A stored merge carries no `dependsOn` — `validateModel` refuses one that
     * depends on an arm member — so the closure never reaches it and the
     * assertion above holds with the exemption REMOVED. Written and left alone
     * it would be I-38 exactly: a control that passes over a case that cannot
     * arise, guarding a line nothing tests.
     *
     * The case that CAN arise is the builder's, where `canvasFromRawModel`
     * draws a person's edit BEFORE the server sees it. Wiring a merge onto an
     * arm member is a save the server will refuse — and until they press save,
     * the canvas is what tells them what they have built. Marking the merge and
     * its tail as conditional there would draw a grouping that is wrong in the
     * model AND wrong in the engine.
     */
    it("⚠ even a merge wired INTO an arm — the refused edit — draws as unconditional", () => {
      const edited = REAL.map((s) =>
        s.id === "outcome" ? { ...s, dependsOn: ["warn"] } : s,
      );
      const g = canvasFromRawModel({ steps: edited });
      // The control: this graph does assign arms, and `warn` really is in one.
      expect(g.nodes.find((n) => n.id === "warn")?.arm?.armId).toBe("some_flagged");
      expect(g.nodes.find((n) => n.id === "outcome")?.arm ?? null).toBeNull();
      expect(g.nodes.find((n) => n.id === "record")?.arm ?? null).toBeNull();
    });

    it("both adapters draw it identically", () => {
      const a = canvasFromModel(asReview as never);
      const b = canvasFromRawModel({ steps: REAL });
      expect(a.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).sort()).toEqual(
        b.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).sort(),
      );
    });
  });

  /**
   * ⚠ **BOTH ADAPTERS, OR THE PICTURES DISAGREE.** `canvasFromModel` feeds chat
   * mode and the builder whenever review steps exist; `canvasFromRawModel` feeds
   * the builder's local edits. A collapse in one of them is two pictures of one
   * flow — one showing a fork, the other three unrelated always-run guards —
   * which is exactly what this file exists to prevent.
   *
   * ⚠ It works at all only because `elseOf` and `conditionExpr` were added to
   * the review projection; they had ridden in `configJson` all along and the
   * projection dropped them, which is T8's shape a second time.
   */
  it("⚠ the review adapter collapses the chain identically", () => {
    const review = chain.steps.map((s, i) => ({
      stepId: s.id,
      kind: s.kind,
      ordinal: i,
      ref: (s as { ref?: string }).ref ?? null,
      dependsOn: (s as { dependsOn?: string[] }).dependsOn ?? [],
      generated: false,
      contract: null,
      codeLines: null,
      retry: null,
      awaitSeconds: null,
      paramsExpr: (s as { paramsExpr?: string }).paramsExpr ?? null,
      elseOf: (s as { elseOf?: string }).elseOf ?? null,
      conditionExpr: (s as { conditionExpr?: string }).conditionExpr ?? null,
    }));
    const a = canvasFromModel(review as never);
    const b = canvasFromRawModel(chain);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.nodes.find((n) => n.id === "big")?.arms).toEqual(
      b.nodes.find((n) => n.id === "big")?.arms,
    );
    expect(a.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).sort()).toEqual(
      b.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).sort(),
    );
  });

  /**
   * ⚠ **A CLOSED `elseOf` LOOP DRAWS NO CHAIN, and the reason it cannot hang is
   * structural rather than defensive.** The walk starts only at a branch with
   * NO `elseOf`, and each step has at most one `elseOf` — so a step already in a
   * chain cannot also be some later step's continuation. A cycle therefore has
   * no head, is never entered, and contributes nothing.
   *
   * ⚠ **`branchArms`'s `seen` set is consequently UNREACHABLE defence**, and
   * this test was written believing otherwise: perturbing the guard away leaves
   * it green, so it would have passed over a removed control. Saying so is the
   * point — the same shape as the secret scanner's `grep -a`, which is also
   * kept and also documented as unreachable. The server's compiler is where a
   * cycle is actually REFUSED, with a message naming the step.
   */
  it("⚠ a closed elseOf loop yields no chain — it is never entered", () => {
    const looped = {
      id: "f",
      steps: [
        { kind: "branch", id: "x", conditionExpr: "{{ a }}", elseOf: "y" },
        { kind: "branch", id: "y", conditionExpr: "{{ b }}", elseOf: "x" },
      ],
    };
    const g = canvasFromRawModel(looped);
    // Both survive as ordinary nodes; neither claims arms it does not have.
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["x", "y"]);
    expect(g.nodes.every((n) => n.arms === undefined)).toBe(true);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ARM MEMBERSHIP — Stage 3.4
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ The property under test is that the picture agrees with the ENGINE. The
 * compiler decides what runs inside an arm with `armOf` — transitive closure
 * over `dependsOn` — so a canvas that grouped by ordinal position would draw a
 * flow that does not exist. Both adapters are checked, because two pictures of
 * one flow is the disagreement `canvas-model.ts` exists to prevent.
 */
describe("which arm a step runs inside", () => {
  const chain = [
    { id: "read", kind: "datasource", ref: "q", dependsOn: [] },
    { id: "big", kind: "branch", conditionExpr: "{{ a }}", dependsOn: ["read"] },
    { id: "shout", kind: "tool", ref: "t", dependsOn: ["big"] },
    { id: "shout2", kind: "transform", dependsOn: ["shout"] },
    { id: "rest", kind: "branch", elseOf: "big", dependsOn: [] },
    { id: "quiet", kind: "tool", ref: "t", dependsOn: ["rest"] },
  ];

  it("marks a step with the arm it hangs off, transitively", () => {
    const g = canvasFromRawModel({ id: "f", steps: chain });
    const by = new Map(g.nodes.map((n) => [n.id, n]));
    expect(by.get("shout")?.arm?.label).toBeTruthy();
    // ⚠ Transitive: `shout2` depends on `shout`, not on the branch.
    expect(by.get("shout2")?.arm?.armId).toBe("big");
    expect(by.get("quiet")?.arm?.armId).toBe("rest");
    // A step before the fork runs regardless.
    expect(by.get("read")?.arm).toBeUndefined();
  });

  it("⚠ leaves a step reachable from BOTH arms unmarked rather than guessing", () => {
    const g = canvasFromRawModel({
      id: "f",
      steps: [...chain, { id: "both", kind: "transform", dependsOn: ["shout", "quiet"] }],
    });
    const both = g.nodes.find((n) => n.id === "both");
    expect(both).toBeTruthy();
    expect(both?.arm).toBeUndefined();
  });

  it("⚠ says nothing at all when there is no chain (a lone guard is not an arm chip)", () => {
    const g = canvasFromRawModel({
      id: "f",
      steps: [
        { id: "read", kind: "datasource", ref: "q", dependsOn: [] },
        { id: "gate", kind: "branch", conditionExpr: "{{ a }}", dependsOn: ["read"] },
        { id: "send", kind: "tool", ref: "t", dependsOn: ["gate"] },
      ],
    });
    expect(g.nodes.every((n) => n.arm === undefined)).toBe(true);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CODE OUTPUT FIELD HANDLES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A `code` step's contract declares its outputs as a record; each key is a
 * field a downstream step can read, so the node carries one view anchor per
 * key (id = label = field name). Every other kind is opaque. The anchors are
 * anchors only — edges stay plain (no `sourceHandle` anywhere in this file's
 * assertions, and none is produced).
 */
describe("code output field handles", () => {
  it("a code node carries one handle per contract output field", () => {
    const g = canvasFromModel([
      model({
        stepId: "calc",
        kind: "code",
        generated: true,
        contract: { output: { rows: {}, total: {} } },
      }),
    ]);
    expect(g.nodes[0]?.outputHandles).toEqual([
      { id: "rows", label: "rows" },
      { id: "total", label: "total" },
    ]);
  });

  it("non-code kinds carry none, whatever the contract claims", () => {
    // A tool's outputs are not named fields — per-field ports would claim
    // structure that is not there.
    const g = canvasFromModel([
      model({
        stepId: "t",
        kind: "tool",
        ref: "mail_send",
        contract: { output: { rows: {}, total: {} } },
      }),
    ]);
    expect(g.nodes[0]?.outputHandles ?? []).toEqual([]);
  });

  it("a code node with no contract output carries none", () => {
    // A draft without a contract is still drawn (see `canvasFromModel`'s
    // defensive rule) — but with the single opaque handle, not field ports.
    for (const contract of [null, {}] as const) {
      const g = canvasFromModel([model({ stepId: "c", kind: "code", generated: true, contract })]);
      expect(g.nodes[0]?.outputHandles ?? []).toEqual([]);
    }
  });

  it("the execution view anchors a code step's actual output fields", () => {
    const g = canvasFromExecution(
      { nodes: [{ id: "c", type: null }], edges: [] },
      [run({ stepId: "c", kind: "code", output: { ranked: [] } })],
    );
    expect(g.nodes[0]?.outputHandles).toEqual([{ id: "ranked", label: "ranked" }]);
  });

  it("the raw view carries none — a refused draft names no output fields", () => {
    const g = canvasFromRawModel({
      id: "f",
      steps: [{ id: "c", kind: "code", dependsOn: [] }],
    });
    expect(g.nodes[0]?.outputHandles ?? []).toEqual([]);
  });
});
