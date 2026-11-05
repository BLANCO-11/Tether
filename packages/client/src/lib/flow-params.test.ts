import { describe, expect, it } from "vitest";
import type { AuthoredStep } from "@foundry/flow-edit";
import { buildFanOutParams, buildSingleParams, type ItemPredicate, type Mapping, type OutputShapes } from "./flow-expr";
import { parseParams } from "@/lib/flow-params";

/**
 * ⚠ **THIS IS A ROUND-TRIP SUITE, NOT A STRING SUITE, AND THAT IS DELIBERATE.**
 *
 * The obvious test writes the expected `paramsExpr` out by hand and checks the
 * parser against it. That version passes for ever after `flow-expr.ts` changes
 * what it emits — it pins MY reading of the format rather than the format —
 * which is precisely the drift that makes a read-back dangerous: a parser that
 * silently stops recognising the builder's output does not fail, it reports
 * *"nothing is bound"* about a wired step.
 *
 * So every case below builds with the real builder and requires the parse to
 * come back equal. The one place a literal appears is the NEGATIVE half, where
 * the input is by definition not something the builder would produce.
 */

const SHAPES: OutputShapes = {
  trigger: { template: null, describes: null, caution: null },
  datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  query: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  calculate: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  code: { template: "outputs.<id>.vars.result", describes: null, caution: null },
  agent: { template: "outputs.<id>.vars.answer", describes: null, caution: null },
  assistant: { template: "outputs.<id>.vars.answer", describes: null, caution: null },
  approval: { template: null, describes: null, caution: null },
  branch: { template: null, describes: null, caution: null },
  action: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  notify: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  report: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  end: { template: null, describes: null, caution: null },
} as unknown as OutputShapes;

const rowsStep = { kind: "datasource", id: "overdue", ref: "invoices_overdue" } as unknown as AuthoredStep;
const otherStep = { kind: "datasource", id: "overdue_alt", ref: "x" } as unknown as AuthoredStep;
const STEPS = [rowsStep, otherStep];

const roundTrip = (mappings: Mapping[]) => {
  const expr = buildFanOutParams(SHAPES, rowsStep, mappings);
  expect(expr, "the builder produced nothing to parse").toBeTruthy();
  return parseParams(SHAPES, STEPS, expr);
};

describe("parseParams — the fan-out form round-trips", () => {
  it("recovers a field off the rows, and which step the rows came from", () => {
    const got = roundTrip([{ param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } }]);
    expect(got).toEqual({
      overStepId: "overdue",
      mappings: [{ param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } }],
      predicate: null,
      filterUnreadable: false,
      skipped: [],
    });
  });

  it("recovers a flow input across the `~` splice — I-11's shape", () => {
    // The value leaves the quoted jq program and comes back. A regex over the
    // jq text sees two empty strings here, which is why the parser reassembles.
    const got = roundTrip([{ param: "period", source: { from: "input", inputId: "period" } }]);
    expect(got?.mappings).toEqual([{ param: "period", source: { from: "input", inputId: "period" } }]);
  });

  it("recovers a literal, quotes and all", () => {
    const got = roundTrip([{ param: "subject", source: { from: "literal", value: 'He said "hi"' } }]);
    expect(got?.mappings).toEqual([{ param: "subject", source: { from: "literal", value: 'He said "hi"' } }]);
  });

  it("recovers ALL of a mixed set, in order — the binding-loss case", () => {
    // The defect this parser exists for: `push` rebuilds the whole expression
    // from the in-memory map, so a map missing four of five bindings deletes
    // them the moment anybody edits the fifth.
    const mixed: Mapping[] = [
      { param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } },
      { param: "period", source: { from: "input", inputId: "period" } },
      { param: "subject", source: { from: "literal", value: "Overdue invoices" } },
      { param: "amount", source: { from: "step", stepId: "overdue", field: "amount_cents" } },
      { param: "tenant", source: { from: "input", inputId: "tenant" } },
    ];
    expect(roundTrip(mixed)?.mappings).toEqual(mixed);
  });

  it("reads a transformed field as the field, and drops the transform", () => {
    // ⚠ Stated in the module and asserted here: `(.x | tostring)` cannot be
    // attributed to an INTENT. The field is recovered; `transform` is not.
    const got = roundTrip([
      { param: "due", source: { from: "step", stepId: "overdue", field: "due_date", transform: "date" } },
    ]);
    expect(got?.mappings).toEqual([
      { param: "due", source: { from: "step", stepId: "overdue", field: "due_date" } },
    ]);
  });

  it("picks the step by its ROWS expression, never by an id substring", () => {
    // `overdue` is a prefix of `overdue_alt`. A scan for the id would match the
    // wrong step and attribute every field to it.
    const expr = buildFanOutParams(SHAPES, otherStep, [
      { param: "x", source: { from: "step", stepId: "overdue_alt", field: "f" } },
    ]);
    expect(parseParams(SHAPES, STEPS, expr)?.overStepId).toBe("overdue_alt");
  });

  it("recovers the per-item predicate — the filter survives the round trip", () => {
    // The predicate is no longer read past: recovering it is what lets the
    // panel show the filter AND rebuild without silently dropping it.
    const expr = buildFanOutParams(
      SHAPES,
      rowsStep,
      [{ param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } }],
      { test: "field_gt", field: "amount_cents", value: "10000" },
    );
    expect(parseParams(SHAPES, STEPS, expr)).toEqual({
      overStepId: "overdue",
      mappings: [{ param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } }],
      predicate: { test: "field_gt", field: "amount_cents", value: "10000" },
      filterUnreadable: false,
      skipped: [],
    });
  });

  const PREDICATE_CASES: ItemPredicate[] = [
    { test: "field_eq", field: "status", value: "open" },
    { test: "field_ne", field: "status", value: "void" },
    { test: "field_contains", field: "email", value: "acme" },
    { test: "field_starts", field: "email", value: "ops@" },
    { test: "field_ends", field: "email", value: ".example" },
    { test: "field_empty", field: "notes" },
    { test: "field_present", field: "email" },
    { test: "field_gt", field: "amount_cents", value: "10000" },
    { test: "field_gte", field: "amount_cents", value: "10000" },
    { test: "field_lt", field: "amount_cents", value: "10000" },
    { test: "field_lte", field: "amount_cents", value: "10000" },
    { test: "field_eq", value: "cash" },
    { test: "field_gt", value: "3" },
    { test: "field_contains", field: "note", value: 'a)b"c' },
  ];
  it.each(PREDICATE_CASES.map((p) => [p]))("round-trips the predicate %j", (predicate) => {
    const mappings: Mapping[] = [
      { param: "to_email", source: { from: "step", stepId: "overdue", field: "work_email" } },
    ];
    const expr = buildFanOutParams(SHAPES, rowsStep, mappings, predicate);
    expect(expr, "the builder produced nothing to parse").toBeTruthy();
    expect(parseParams(SHAPES, STEPS, expr)).toEqual({
      overStepId: "overdue",
      mappings,
      predicate,
      filterUnreadable: false,
      skipped: [],
    });
  });

  it("a hand-written `select(…)` keeps its mappings but reports the filter unreadable", () => {
    // Not a shape the builder emits, so no writer may re-emit without it —
    // but the per-field mappings ARE still readable, and stay so.
    const expr =
      '{{ json(outputs.overdue.body).results[0].data | jq(\'[.[] | select(.amount_cents > 10000) | {"to_email": .email}]\') | first }}';
    expect(parseParams(SHAPES, STEPS, expr)).toEqual({
      overStepId: "overdue",
      mappings: [{ param: "to_email", source: { from: "step", stepId: "overdue", field: "email" } }],
      predicate: null,
      filterUnreadable: true,
      skipped: [],
    });
  });

  it("names the pairs it skips — a rebuild would drop them, so writers must refuse", () => {
    // `custom(.x)` is fed by something this reader will not name. The honest
    // mapping survives beside it; the skipped name is what stops a rebuild.
    const expr =
      '{{ json(outputs.overdue.body).results[0].data | jq(\'[.[] | {"to_email": .email, "tag": custom(.x)}]\') | first }}';
    expect(parseParams(SHAPES, STEPS, expr)).toEqual({
      overStepId: "overdue",
      mappings: [{ param: "to_email", source: { from: "step", stepId: "overdue", field: "email" } }],
      predicate: null,
      filterUnreadable: false,
      skipped: ["tag"],
    });
  });

  it("recovers the bare element as the item itself", () => {
    const list = { kind: "transform", id: "names", expr: "{{ [...] }}" } as unknown as AuthoredStep;
    const expr = buildFanOutParams(SHAPES, list, [{ param: "name", source: { from: "self" } }]);
    expect(parseParams(SHAPES, [...STEPS, list], expr)).toEqual({
      overStepId: "names",
      mappings: [{ param: "name", source: { from: "self" } }],
      predicate: null,
      filterUnreadable: false,
      skipped: [],
    });
  });
});

describe("parseParams — the single-call form round-trips", () => {
  it("recovers a flow input and a literal, and reports no fan-out", () => {
    const mappings: Mapping[] = [
      { param: "period", source: { from: "input", inputId: "period" } },
      { param: "to", source: { from: "literal", value: "ops@acme-hr.example" } },
    ];
    const got = parseParams(SHAPES, STEPS, buildSingleParams(mappings));
    expect(got).toEqual({ overStepId: null, mappings, predicate: null, filterUnreadable: false, skipped: [] });
  });

  it("round-trips a single call over ONE upstream's output (E3.1 — it used to emit `\"\"`)", () => {
    // `buildSingleParams` wrote `""` for a step field with no row context, so a
    // single call reading a step posted empty text. It now builds the object in
    // jq over that step's output, and the reader recovers the field. A
    // whole-output read (`.`) has no name in the panel's narrow `Source`, so it
    // is reported SKIPPED — never guessed into a per-row `self`.
    const mappings = [
      { param: "x", source: { from: "step", stepId: "overdue", field: "f", transform: "text" } },
      { param: "all", source: { from: "whole", stepId: "overdue" } },
      { param: "period", source: { from: "input", inputId: "period" } },
    ] as unknown as Mapping[];
    const expr = buildSingleParams(mappings, { shapes: SHAPES, steps: STEPS })!;
    const got = parseParams(SHAPES, STEPS, expr);
    expect(got?.overStepId).toBeNull();
    // `transform` is deliberately not recovered (see the module header).
    expect(got?.mappings).toEqual([
      { param: "x", source: { from: "step", stepId: "overdue", field: "f" } },
      { param: "period", source: { from: "input", inputId: "period" } },
    ]);
    expect(got?.skipped).toEqual(["all"]);
  });
});

describe("parseParams — it fails CLOSED", () => {
  // ⚠ The whole safety property. `null` means "not written by the builder, and
  // I will not guess" — which callers must render as UNKNOWN, never as unbound.
  it.each([
    ["a hand-written expression", "{{ json(outputs.q.body) | jq('[.[] | {a: .b}]') }}"],
    ["a fan-out over a step this flow does not have", "{{ json(outputs.ghost.body).results[0].data | jq('[.[] | {\"a\": .b}]') | first }}"],
    ["an unterminated jq program", "{{ json(outputs.overdue.body).results[0].data | jq('[.[] | {\"a\": .b}]) | first }}"],
    ["prose", "whatever the person typed"],
    ["empty", "   "],
    ["nothing at all", null],
  ])("returns null for %s", (_label, expr) => {
    expect(parseParams(SHAPES, STEPS, expr)).toBeNull();
  });

  it("the CONTROL: the same shapes and steps DO parse a real expression", () => {
    // Without this, "returns null" above is satisfied by a parser that returns
    // null for everything — I-38, and the reason this file cannot only assert
    // refusals.
    const expr = buildFanOutParams(SHAPES, rowsStep, [
      { param: "a", source: { from: "step", stepId: "overdue", field: "b" } },
    ]);
    expect(parseParams(SHAPES, STEPS, expr)).not.toBeNull();
  });
});
