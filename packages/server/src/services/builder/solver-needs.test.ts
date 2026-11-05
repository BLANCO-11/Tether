/**
 * A value stated for an OPTIONAL port is built, and a port that NEEDS another gets it (2026-10-01).
 *
 * The report: "create a csv report … and send that report to me over email". The goal was read correctly — the email, with its
 * file format "csv" — and then nothing bound it: holes exist only for REQUIRED ports, and the solver fills holes, so a stated value
 * for an optional port was read back to the person and silently not built. And a format alone builds no file: the route refuses
 * a format without rows, at run time.
 *
 * Neutral catalogue (`file_mail`), so this is the declared `needs` flag at work — never the real email tool's name.
 */
import { describe, expect, it } from "vitest";
import { checkState, errorsOf, SYNTHETIC, emptyFlow, TypeOf as T, type CatalogueSnapshot, type EFlow, type PortSig, type Ty } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";

const port = (name: string, ty: Ty, required: boolean, extra: Partial<PortSig> = {}): PortSig => ({ name, ty, required, ...extra });
const FILE_FORMAT = T.text([{ r: "OneOf", values: ["csv", "xlsx"] }]);
const cat: CatalogueSnapshot = {
  ...SYNTHETIC,
  refs: {
    ...SYNTHETIC.refs,
    file_mail: {
      kind: "tool",
      params: [
        { ...port("to", T.list(T.address()), false), liftsScalar: true, fallsBackToRequester: true },
        port("subject", T.text([{ r: "SingleLine" }]), true, { heading: true }),
        port("body", T.text(), true, { message: true }),
        port("file_rows", T.text(), false, { fromStep: true }),
        port("file_name", T.text([{ r: "SingleLine" }]), false, { needs: "file_rows" }),
        port("file_format", FILE_FORMAT, false, { needs: "file_rows" }),
      ],
      payload: T.record({ status: T.text() }),
    },
  },
};
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };

const GOAL = "Email me the widgets as of today as a csv file with subject Widgets.";
const spec = (extra: GoalSpec["values"] = [], sources: GoalSpec["sources"] = [{ ref: "store.widgets", quote: "the widgets as of today" }]): GoalSpec => ({
  sources,
  sinks: [{ ref: "file_mail", quote: "Email me the widgets" }],
  values: [
    { role: "date", from: "flow_input", quote: "today", fills: "store.widgets.as_of" },
    { role: "recipient", from: "requester", quote: "me", fills: "file_mail.to" },
    { role: "subject", from: "goal", quote: "Widgets", fills: "file_mail.subject" },
    ...extra,
  ],
  conditions: [],
  schedule: null,
  missing: null,
});
const build = (s: GoalSpec, goal = GOAL) => solve(emptyFlow("t"), { spec: checkSpec(s, [goal], ITEMS), cat, answers: new Map(), base: [] });
type S = EFlow["steps"][number];
const mailOf = (f: EFlow) => f.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "file_mail")!;
const src = (f: EFlow, port: string) => mailOf(f).inputs.find((b) => b.name === port)?.source;

describe("a stated value on an optional port, and what it needs", () => {
  it("“as a csv” binds the format AND the rows it needs, from the one reader — and checks clean", () => {
    const r = build(spec([{ role: "other", from: "goal", quote: "csv", fills: "file_mail.file_format" }]));
    const readId = r.flow.steps.find((s) => s.kind === "datasource")!.id;
    expect(src(r.flow, "file_format")).toMatchObject({ from: "literal", value: "csv" });
    expect(src(r.flow, "file_rows")).toEqual({ from: "whole", stepId: readId, transform: "text" }); // the engine stores a `text` move so
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
  });

  it("CONTROL: with no file stated, neither optional port is touched — every email built before is unchanged", () => {
    const r = build(spec());
    expect(src(r.flow, "file_format")).toBeUndefined();
    expect(src(r.flow, "file_rows")).toBeUndefined();
    // …and the rows go in the message, as they always did
    expect(src(r.flow, "body")).toMatchObject({ from: "whole", transform: "text" });
  });

  it("a stated file carries the rows, and the message does NOT also carry them (2026-10-04: a 379 KB body, refused by the mail route)", () => {
    const r = build(spec([{ role: "other", from: "goal", quote: "csv", fills: "file_mail.file_format" }]));
    expect(src(r.flow, "file_rows")).toMatchObject({ from: "whole", transform: "text" });
    expect(src(r.flow, "body")).toBeUndefined();
    // the message is still owed — its own words, asked (a hole), never the rows
    expect(r.flow.holes.some((h) => "port" in h.site && h.site.port === "body")).toBe(true);
  });

  it("a need nothing answers is a stated gap, never a guess between two readers", () => {
    const goal = "Email me the widgets as of today and the people as a csv file with subject Widgets.";
    const r = build(spec([{ role: "other", from: "goal", quote: "csv", fills: "file_mail.file_format" }], [
      { ref: "store.widgets", quote: "the widgets as of today" },
      { ref: "store.people", quote: "the people" },
    ]), goal);
    expect(src(r.flow, "file_format")).toMatchObject({ value: "csv" });
    expect(src(r.flow, "file_rows")).toBeUndefined();
    expect(r.gaps.some((g) => g.includes("file_rows"))).toBe(true);
  });

  it("rows + format without a stated name drafts file_name from the subject (2026-10-07 attach_name gap)", () => {
    const r = build(spec([{ role: "other", from: "goal", quote: "csv", fills: "file_mail.file_format" }]));
    expect(src(r.flow, "file_rows")).toMatchObject({ from: "whole", transform: "text" });
    expect(src(r.flow, "file_format")).toMatchObject({ value: "csv" });
    expect(src(r.flow, "file_name")).toMatchObject({ from: "literal", value: "Widgets" });
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
  });

  it("CONTROL: with no file stated, file_name is not drafted either", () => {
    const r = build(spec());
    expect(src(r.flow, "file_name")).toBeUndefined();
  });
});

describe("a value the goal quotes is the words inside the quotation marks", () => {
  it("binds “Widgets” — never the marks with it", async () => {
    const { unquote } = await import("./solver.js");
    expect(unquote('"Low leave balances"')).toBe("Low leave balances");
    expect(unquote("“Low leave balances”")).toBe("Low leave balances");
    expect(unquote("'x'")).toBe("x");
    // CONTROL: unmatched or inner marks are part of the words.
    expect(unquote('say "hi" now')).toBe('say "hi" now');
    expect(unquote('"open')).toBe('"open');
    expect(unquote('""')).toBe('""');
  });

  it("through the solver: a quoted subject is bound without its marks", () => {
    const goal = 'Email me the widgets as of today as a csv file with subject "Widgets".';
    const s = spec([{ role: "other", from: "goal", quote: "csv", fills: "file_mail.file_format" }]);
    s.values = s.values.map((v) => (v.role === "subject" ? { ...v, quote: '"Widgets"' } : v));
    const r = build(s, goal);
    expect(src(r.flow, "subject")).toMatchObject({ from: "literal", value: "Widgets" });
  });
});
