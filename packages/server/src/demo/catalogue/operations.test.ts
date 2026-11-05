/**
 * The seeded readers — 2026-09-08.
 *
 * ⚠ **The load-bearing assertion is the ADDRESS one**, and it is the fix for a
 * measured defect rather than a style rule. `orders_demo.past_due_orders`
 * projected `customer_id` and never joined `customers`, so a drafted flow wrote
 * `{to: [.customer_email]}`, got null eight times and failed at the last hop
 * (Kestra `3VRhNsJO8222ebwGOQClFH`). 14 of this deployment's 29 transform steps
 * had the same defect and most ran GREEN. A reader whose rows cannot be acted on
 * invites exactly that guess, so every reader a notification could follow must
 * project one.
 *
 * ⚠ These are shape assertions over the SPECS. The specs are also compiled for
 * real by `pnpm catalogue:seed`, against the introspected schema — 23 of 23 on
 * 2026-09-09 — which is the check that catches a column that does not exist.
 * This file catches the ones a successful compile would not notice.
 */
import { describe, expect, it } from "vitest";
import { CATALOGUE_OPERATIONS } from "./operations.js";
import { dbOperationBodySchema, FILTER_OPS } from "../../services/db-operation.service.js";

const all = Object.entries(CATALOGUE_OPERATIONS).flatMap(([ds, seeds]) =>
  seeds.map((s) => ({ ds, ...s })),
);

describe("the seeded readers", () => {
  it("covers all six domains with more than one reader each", () => {
    // The whole point: one reader per domain is what made every flow the same
    // shape and `needs_component` unreachable.
    expect(Object.keys(CATALOGUE_OPERATIONS).sort()).toEqual([
      "finance_demo",
      "hiring_demo",
      "hr_demo",
      "itops_demo",
      "orders_demo",
      "support_demo",
    ]);
    for (const [ds, seeds] of Object.entries(CATALOGUE_OPERATIONS)) {
      expect(seeds.length, `${ds} needs more than one reader`).toBeGreaterThan(1);
    }
  });

  it("every spec parses under the SAME schema a route applies", () => {
    // Not a cast: the spec's arrays carry `.default([])`, which only applies on
    // parse, so a seed that only worked when cast would not work from the UI.
    for (const s of all) {
      expect(() =>
        dbOperationBodySchema.parse({
          name: s.name,
          description: s.description,
          spec: s.spec,
          paramDescriptions: s.params,
        }),
        `${s.ds}.${s.name}`,
      ).not.toThrow();
    }
  });

  it("projects a contact ADDRESS wherever a notification could follow", () => {
    // An aggregate summary is the one exemption and it still carries one here;
    // the rule is asserted over every reader precisely so a new one cannot be
    // added without a decision.
    for (const s of all) {
      const aliases = s.spec.columns.map((c) => c.alias);
      expect(
        aliases.some((a) => /email$/.test(a)),
        `${s.ds}.${s.name} projects no address — a flow notifying from it would guess a column`,
      ).toBe(true);
    }
  });

  it("gives every parameter a HUMAN sentence, never the derived one", () => {
    // I-126: the derived description is `"lt filter on public.invoices.due_date"`,
    // which says nothing about whether a date is `2026-06` or `2026-06-30` —
    // the choice that produced `"{{ inputs.period }}-31"` on a real flow.
    // ⚠ ALL params, not just top-level filters: lateral lookups, aggregate
    // summaries and computed columns bind params too (`terms_key`, `as_of`),
    // and an under-described one fails the same way at the same UI.
    const paramsIn = (node: unknown, into: Set<string>): void => {
      if (Array.isArray(node)) {
        for (const v of node) paramsIn(v, into);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "param" && typeof v === "string") into.add(v);
          else paramsIn(v, into);
        }
      }
    };
    for (const s of all) {
      const params = new Set<string>();
      paramsIn(s.spec, params);
      expect([...params].sort(), `${s.ds}.${s.name}`).toEqual(Object.keys(s.params).sort());
      for (const [name, prose] of Object.entries(s.params)) {
        expect(prose, `${s.ds}.${s.name}.${name}`).not.toMatch(
          new RegExp(`^(${FILTER_OPS.join("|")}) filter on `),
        );
        expect(prose.length, `${s.ds}.${s.name}.${name} is too short to say anything`).toBeGreaterThan(15);
      }
    }
  });

  it("declares as DATA every constant its prose states, and a default only for a declared parameter (D-323)", () => {
    // A value in prose alone ("Use 'prod'") cannot be bound by the builder, so every build asked the person for a constant
    // they cannot know. Prose and data must say the same thing, or one of them is wrong.
    for (const s of all) {
      for (const [name, prose] of Object.entries(s.params)) {
        const stated = /Use '([^']+)'\.|normally (default_\w+)\.|Always pass JSON (true|false)/i.exec(prose);
        const value = stated?.[1] ?? stated?.[2] ?? stated?.[3];
        expect(s.defaults?.[name], `${s.ds}.${s.name}.${name}: prose states ${value ?? "no value"}`).toBe(value);
      }
      for (const name of Object.keys(s.defaults ?? {})) expect(s.params, `${s.ds}.${s.name}: default for undeclared ${name}`).toHaveProperty(name);
    }
  });

  it("declares as DATA the month its prose states, so \"monthly\" is refused before a run (flow d3c79698)", () => {
    for (const s of all) {
      for (const [name, prose] of Object.entries(s.params)) {
        const month = /\bYYYY-MM\b(?!-)/.test(prose);
        expect(s.formats?.[name], `${s.ds}.${s.name}.${name}: prose ${month ? "states" : "does not state"} a month`).toBe(month ? "month" : undefined);
      }
      expect(() => dbOperationBodySchema.parse({ name: s.name, spec: s.spec, paramDescriptions: s.params, ...(s.formats ? { paramFormats: s.formats } : {}) }), `${s.ds}.${s.name}`).not.toThrow();
    }
  });

  it("uses no filter operator the compiler does not have", () => {
    // ⚠ There is no `is_null`. "Orders with no shipment" and "tickets with no
    // first response" are expressed as a `left` join that RETURNS the null, for
    // the flow's transform to select on — stated in the module header so the
    // next reader does not go looking for the operator.
    for (const s of all) {
      for (const f of s.spec.filters ?? []) {
        expect(FILTER_OPS as readonly string[], `${s.ds}.${s.name}`).toContain(f.op);
      }
    }
  });

  it("gives every alias a unique name within its reader", () => {
    // Two columns sharing an alias silently overwrite each other in the result
    // row, which reads as a query returning the wrong value.
    for (const s of all) {
      const aliases = s.spec.columns.map((c) => c.alias);
      expect(new Set(aliases).size, `${s.ds}.${s.name} has a duplicate alias`).toBe(aliases.length);
    }
  });

  it("names none of the four single readers it supersedes", () => {
    // A new reader reusing an old name would be refused by `create` (409, not
    // an upsert) and the seed would report a failure nobody caused.
    const superseded = new Set(["past_due_orders", "support_tickets", "expiring_offers", "overdue_invoices"]);
    for (const s of all) expect(superseded.has(s.name), s.name).toBe(false);
  });
});
