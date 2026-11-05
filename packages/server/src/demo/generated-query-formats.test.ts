/**
 * The generated readers' prose and data say the same thing about a value's shape (2026-09-29, flow d3c79698): a parameter whose
 * description states YYYY-MM or YYYY-MM-DD DECLARES `format` month / date, and the declaration passes the query descriptor the
 * registration route applies. Without it, "monthly" type-checked into `period` and failed at run time.
 */
import { describe, expect, it } from "vitest";
import { HR_GENERATED_QUERIES } from "./hr-generated.js";
import { FINANCE_GENERATED_QUERIES } from "./finance/finance-generated.js";
import { LEGAL_GENERATED_QUERIES } from "./legal/legal-generated.js";
import { queryParamDescriptor } from "../services/param-descriptor.js";

const all = [...HR_GENERATED_QUERIES, ...FINANCE_GENERATED_QUERIES, ...LEGAL_GENERATED_QUERIES];

describe("generated readers declare the format their prose states", () => {
  it("YYYY-MM ⇒ month, YYYY-MM-DD ⇒ date, nothing else", () => {
    let declared = 0;
    for (const q of all) for (const [name, p] of Object.entries(q.paramsSchema)) {
      const want = /\bYYYY-MM-DD\b/.test(p.description) ? "date" : /\bYYYY-MM\b(?!-)/.test(p.description) ? "month" : undefined;
      expect(p.format, `${q.name}.${name}`).toBe(want);
      if (p.format) declared++;
      expect(() => queryParamDescriptor.parse(p), `${q.name}.${name}`).not.toThrow();
    }
    expect(declared).toBe(12); // CONTROL: the twelve found on the deployment
  });
  it("CONTROL: the query descriptor refuses a format that is not a shape it knows", () => {
    expect(() => queryParamDescriptor.parse({ type: "string", format: "monthly" })).toThrow();
  });
});
