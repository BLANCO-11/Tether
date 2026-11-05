import { describe, expect, it } from "vitest";
import { END, START, piCanvasModel } from "./pi-canvas";
import type { PiWorkflow } from "./pi-builder";

const wf: PiWorkflow = {
  inputs: { week: { type: "date" } },
  steps: [
    { id: "review", description: "Adds up hours", params: { week: "$input.week", limit: 40 }, outputs: ["short", "senior"] },
    { id: "gate", approval: { title: "Send the emails?", review: "review.short" } },
    {
      id: "each",
      foreach: "review.short",
      as: "person",
      steps: [
        {
          id: "decide",
          branch: [
            { if: { value: "$person.lop", op: "gt", to: 0 }, steps: [{ id: "notify", inputs: { who: "$person" }, outputs: ["sent"] }] },
            { else: true, steps: [] },
          ],
        },
      ],
    },
    { id: "summary", inputs: { short: "review.short", handled: "each.succeeded" }, outputs: ["text"] },
  ],
};

describe("piCanvasModel", () => {
  const m = piCanvasModel(wf);
  const link = (from: string, to: string) => m.links.find((l) => `${l.from.node}|${l.from.port}` === from && `${l.to.node}|${l.to.port}` === to);

  it("draws a link for every binding, from the output read to the input reading it", () => {
    expect(link(`${START}|out:week`, "review|in:week")?.kind).toBe("data");
    expect(link("review|out:short", "gate|in:review")?.kind).toBe("data");
    expect(link("review|out:short", "summary|in:short")?.kind).toBe("data");
    // A loop's counts leave from its frame, labelled with what is read.
    expect(link("each|frame:out", "summary|in:handled")).toMatchObject({ kind: "data", label: "succeeded" });
    expect(link("review|out:short", "each|frame:in")?.kind).toBe("data");
  });

  it("keeps literal params as settings, never as links", () => {
    const review = m.nodes.find((n) => n.id === "review")!;
    expect(review.sets).toEqual([{ name: "limit", value: "40" }]);
    expect(review.ins.map((p) => p.name)).toEqual(["week"]);
  });

  it("draws a choice's paths from their own exits, and an empty path as going nowhere", () => {
    const decide = m.nodes.find((n) => n.id === "decide")!;
    expect(decide.paths).toEqual([
      { label: "If", when: "lop > 0", to: "notify" },
      { label: "Otherwise", when: "", to: null },
    ]);
    expect(link("decide|path:0", "notify|in")?.kind).toBe("path");
  });

  it("adds a 'then' link only where no data already arrives", () => {
    // The approval is reached by data; the step after the loop by data — neither gets a duplicate order line.
    expect(m.links.filter((l) => l.to.node === "gate" && l.kind === "order")).toHaveLength(0);
    expect(m.links.filter((l) => l.to.node === "summary" && l.kind === "order")).toHaveLength(0);
    // The loop's first step is entered from the frame's edge.
    expect(link("each|frame:in", "decide|in")).toMatchObject({ kind: "order", label: "each person" });
  });

  it("frames a loop around its steps and puts each node in a column, Start first and End last", () => {
    expect(m.frames).toEqual([{ id: "each", label: "For each person in review.short", members: ["decide", "notify"], frames: [], depth: 0 }]);
    expect(m.columns[0]).toEqual([START]);
    expect(m.columns[m.columns.length - 1]).toEqual([END]);
    const col = (id: string) => m.columns.findIndex((c) => c.includes(id));
    expect(col("notify")).toBe(col("decide") + 1);
    expect(col("summary")).toBe(col("notify") + 1);
    expect(m.opens[col("decide")]).toBe(1);
    expect(m.closes[col("notify")]).toBe(1);
  });

  it("End reads the last step's outputs", () => {
    expect(link("summary|out:text", `${END}|in:text`)?.kind).toBe("data");
  });
});
