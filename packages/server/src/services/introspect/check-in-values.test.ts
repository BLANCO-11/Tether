/** compiled-builder I-301 (A): a single-column CHECK (col IN (…)) is a declared domain; any other constraint is not. */
import { describe, expect, it } from "vitest";
import { checkInValues } from "./postgres.introspector.js";

describe("checkInValues", () => {
  it("reads Postgres's normal form of IN, for text and for varchar (casts around the column and the array)", () => {
    expect(checkInValues("CHECK ((status = ANY (ARRAY['open'::text, 'shipped'::text, 'cancelled'::text])))", "status")).toEqual(["open", "shipped", "cancelled"]);
    expect(checkInValues("CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'it''s'::character varying])::text[])))", "status")).toEqual(["open", "it's"]);
  });
  it("anything that is not a value list is NOT a domain — a misread would refuse values the column accepts", () => {
    expect(checkInValues("CHECK ((amount > 0))", "amount")).toBeNull();
    expect(checkInValues("CHECK (((status = 'a'::text) OR (other = 'b'::text)))", "status")).toBeNull();
    expect(checkInValues("CHECK ((lower(status) = ANY (ARRAY['a'::text])))", "status")).toBeNull();
    expect(checkInValues("CHECK ((kind = ANY (ARRAY['a'::text])))", "status")).toBeNull(); // another column
  });
});
