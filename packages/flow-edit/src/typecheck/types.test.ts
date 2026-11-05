import { describe, it, expect } from "vitest";
import { T, assignable, convert, render, tyOfColumn, tyOfParam, type Ty } from "./types.js";

/**
 * Phase 1 task 1: "types + compatibility, exhaustively unit-tested (every pair,
 * both directions)". The scalar matrix below is the SPEC — every one of the 64
 * ordered pairs is written down, so a change to `assignable` that moves any
 * cell turns exactly that cell red.
 */
const SCALARS = ["Text", "Int", "Number", "Bool", "Date", "DateTime", "Month", "Address"] as const;
const mk = (s: (typeof SCALARS)[number]): Ty => ({ t: s }) as Ty;

// Row = FROM, column = TO.  ✓ assignable · c needs a named conversion · n narrowing · ✗ mismatch
//                 Text Int Number Bool Date DateTime Month Address
const MATRIX: Record<string, string> = {
  Text:     "✓    ✗   n      ✗    ✗    ✗        ✗     n",
  Int:      "c    ✓   ✓      ✗    ✗    ✗        ✗     ✗",
  Number:   "c    n   ✓      ✗    ✗    ✗        ✗     ✗",
  Bool:     "c    ✗   ✗      ✓    ✗    ✗        ✗     ✗",
  Date:     "c    ✗   ✗      ✗    ✓    c        c     ✗",
  DateTime: "c    ✗   ✗      ✗    c    ✓        c     ✗",
  Month:    "c    ✗   ✗      ✗    ✗    ✗        ✓     ✗",
  Address:  "✓    ✗   ✗      ✗    ✗    ✗        ✗     ✓",
};

describe("the scalar matrix — all 64 ordered pairs", () => {
  for (const from of SCALARS) {
    const cells = MATRIX[from]!.split(/\s+/);
    SCALARS.forEach((to, i) => {
      const want = cells[i];
      it(`${from} → ${to} is ${want}`, () => {
        const r = assignable(mk(from), mk(to));
        if (want === "✓") expect(r.ok).toBe(true);
        else {
          expect(r.ok).toBe(false);
          if (r.ok) return;
          if (want === "c") expect(r.conversion).toBeDefined();
          if (want === "n") expect(r.why).toBe("narrowing");
          if (want === "✗") { expect(r.why).toBe("mismatch"); expect(r.conversion).toBeUndefined(); }
        }
      });
    });
  }
});

describe("nullability is explicit", () => {
  it("T → Option<T> is fine; Option<T> → T is `nullable`", () => {
    expect(assignable(T.text(), T.option(T.text())).ok).toBe(true);
    const r = assignable(T.option(T.address()), T.address());
    expect(r).toMatchObject({ ok: false, why: "nullable" });
  });
  it("Option<T> → Option<U> follows T → U", () => {
    expect(assignable(T.option(T.int()), T.option(T.number())).ok).toBe(true);
    expect(assignable(T.option(T.bool()), T.option(T.int())).ok).toBe(false);
  });
  it("a nullable value of the WRONG type reports the type, not the null", () => {
    expect(assignable(T.option(T.bool()), T.int())).toMatchObject({ ok: false, why: "mismatch" });
  });
  it("option() does not nest", () => expect(T.option(T.option(T.int()))).toEqual(T.option(T.int())));
});

describe("Json is untyped until converted (FT0208, D-257)", () => {
  it("anything non-null flows into Json", () => {
    for (const ty of [T.text(), T.rows(T.record({ a: T.int() }))]) expect(assignable(ty, T.json()).ok).toBe(true);
  });
  it("⚠ a nullable value into Json is `nullable` — a null is JSON and still refused (Kestra 3VRhNsJO)", () => {
    expect(assignable(T.option(T.address()), T.json())).toMatchObject({ ok: false, why: "nullable" });
    expect(assignable(T.option(T.address()), T.option(T.json())).ok).toBe(true);
  });
  it("Json into a typed port is `json_untyped`", () => {
    for (const to of [T.text(), T.address(), T.month(), T.int()]) expect(assignable(T.json(), to)).toMatchObject({ ok: false, why: "json_untyped" });
  });
});

describe("Opaque — gradual typing, never silent", () => {
  it("assignable both ways, and says it was unchecked", () => {
    expect(assignable(T.opaque(), T.address())).toEqual({ ok: true, unchecked: ["Opaque"] });
    expect(assignable(T.int(), T.opaque())).toEqual({ ok: true, unchecked: ["Opaque"] });
  });
});

describe("Never has nothing to read", () => {
  it("Never into anything fails with `never`, even into Json", () => {
    expect(assignable(T.never(), T.json())).toMatchObject({ ok: false, why: "never" });
  });
});

describe("structures", () => {
  const row = T.record({ vendor_email: T.address(), amount: T.int(), note: T.option(T.text()) });
  it("a Record fits a Record needing a SUBSET of its fields", () => {
    expect(assignable(row, T.record({ amount: T.number() })).ok).toBe(true);
  });
  it("a missing field is named", () => {
    expect(assignable(row, T.record({ customer_email: T.address() }))).toMatchObject({ ok: false, why: "missing_field", detail: expect.stringContaining("customer_email") });
  });
  it("a required field that is nullable upstream is `nullable`, with the field named", () => {
    const r = assignable(row, T.record({ note: T.text() }));
    expect(r).toMatchObject({ ok: false, why: "nullable", detail: expect.stringContaining("`note`") });
  });
  it("an OPTIONAL target field may be absent", () => {
    expect(assignable(row, T.record({ cc: T.option(T.address()) })).ok).toBe(true);
  });
  it("Rows<R> → List<R>; List does not become Rows", () => {
    expect(assignable(T.rows(row), T.list(row)).ok).toBe(true);
    expect(assignable(T.list(row), T.rows(row)).ok).toBe(false);
  });
  it("an Envelope is not its payload (I-117)", () => {
    expect(assignable(T.envelope(T.rows(row)), T.rows(row)).ok).toBe(false);
    expect(assignable(T.envelope(T.rows(row)), T.envelope(T.list(row))).ok).toBe(true);
  });
});

describe("refinements on data are UNCHECKED, not passed silently", () => {
  it("Text → Text<SingleLine> is ok and says what went unchecked", () => {
    expect(assignable(T.text(), T.text([{ r: "SingleLine" }]))).toEqual({ ok: true, unchecked: ["SingleLine"] });
  });
  it("CONTROL: a value that already carries the refinement is simply ok", () => {
    expect(assignable(T.text([{ r: "SingleLine" }]), T.text([{ r: "SingleLine" }]))).toEqual({ ok: true });
  });
});

describe("convert — a Source's explicit transform", () => {
  it("DateTime→date, Int→number, anything scalar→text", () => {
    expect(convert(T.dateTime(), "date")).toEqual(T.date());
    expect(convert(T.int(), "number")).toEqual(T.number());
    expect(convert(T.bool(), "text")).toEqual(T.text());
  });
  it("keeps nullability", () => expect(convert(T.option(T.dateTime()), "date")).toEqual(T.option(T.date())));
  it("refuses what it cannot convert", () => {
    expect(convert(T.bool(), "date")).toBeNull();
    expect(convert(T.rows(T.record({})), "number")).toBeNull();
  });
  it("text accepts ANY value — jq `tostring` serialises a list or record to its JSON text", () => {
    // Was pinned `null` until phase 3 step 3: `whole` + `text` is how a text
    // port (llm_complete.input) takes an upstream's rows, and `tostring` does it.
    expect(convert(T.rows(T.record({})), "text")).toEqual(T.text());
    expect(convert(T.option(T.record({})), "text")).toEqual(T.option(T.text()));
  });
});

describe("tyOfColumn / tyOfParam — never guess", () => {
  it("maps common column types, and nullable wraps Option", () => {
    expect(tyOfColumn("character varying(255)")).toEqual(T.text());
    expect(tyOfColumn("integer", true)).toEqual(T.option(T.int()));
    expect(tyOfColumn("numeric(5,2)")).toEqual(T.number());
    expect(tyOfColumn("timestamp with time zone")).toEqual(T.dateTime());
    expect(tyOfColumn("date")).toEqual(T.date());
    expect(tyOfColumn("jsonb")).toEqual(T.json());
  });
  it("⚠ an unknown column type is Opaque, NOT Text", () => {
    expect(tyOfColumn("tsvector")).toEqual(T.opaque());
    expect(tyOfColumn(undefined)).toEqual(T.opaque());
  });
  it("I-301: a KNOWN value domain makes a closed set; an unknown one stays open Text", () => {
    const oneOf = (values: string[]) => T.text([{ r: "OneOf", values }]);
    expect(tyOfColumn("text", false, null, ["open", "shipped"])).toEqual(oneOf(["open", "shipped"]));
    expect(tyOfColumn("user-defined:line_status(open,shipped)")).toEqual(oneOf(["open", "shipped"]));
    expect(tyOfColumn("enum('low','it''s')")).toEqual(oneOf(["low", "it's"]));
    expect(tyOfColumn("text", true, null, ["a"])).toEqual(T.option(oneOf(["a"])));
    // CONTROL: no domain ⇒ plain Text; a user-defined type with no members stays Opaque (a domain or composite, never a guess).
    expect(tyOfColumn("text")).toEqual(T.text());
    expect(tyOfColumn("user-defined:money_domain")).toEqual(T.opaque());
    // A value outside the set is not assignable; a member is.
    expect(assignable(oneOf(["open"]), T.text()).ok).toBe(true);
  });
  it("format beats type for params", () => {
    expect(tyOfParam("string", "month")).toEqual(T.month());
    expect(tyOfParam("string", "email")).toEqual(T.address());
    expect(tyOfParam("integer")).toEqual(T.int());
    expect(tyOfParam("mystery")).toEqual(T.opaque());
  });
  it("⚠ `object` and `array` are shapes, not any-JSON (I-287): a text value fills neither", () => {
    const obj = tyOfParam("object"), arr = tyOfParam("array");
    expect(assignable(T.text(), obj).ok).toBe(false);
    expect(assignable(T.text(), arr).ok).toBe(false);
    expect(assignable(T.record({ name: T.text() }), obj).ok).toBe(true); // any record fits an object
    expect(assignable(T.list(T.int()), arr).ok).toBe(true); // any list fits an array
    expect(assignable(T.rows(T.record({ a: T.int() })), arr).ok).toBe(true);
    // CONTROL: `json` still accepts anything non-null — only the two shapes narrowed.
    expect(assignable(T.text(), tyOfParam("json")).ok).toBe(true);
  });
});

describe("render", () => {
  it("reads like the type", () => {
    expect(render(T.envelope(T.rows(T.record({ a: T.int(), b: T.option(T.text([{ r: "MaxLen", n: 250 }])) }))))).toBe(
      "Envelope<Rows<{a: Int, b: Option<Text<MaxLen(250)>>}>>",
    );
  });
});

describe("tyOfColumn — a DECLARED tag refines the type (compiled-builder I-278)", () => {
  it("an `email` tag on a text column makes an Address", () => {
    expect(tyOfColumn("text", false, "email")).toEqual(T.address());
    expect(tyOfColumn("character varying", true, "email")).toEqual(T.option(T.address()));
  });
  it("other tags change nothing yet, and a tag never makes a non-text column an address", () => {
    expect(tyOfColumn("text", false, "percent")).toEqual(T.text());
    expect(tyOfColumn("integer", false, "email")).toEqual(T.int());
    expect(tyOfColumn("text", false, "emailish")).toEqual(T.text());
  });
  it("no tag keeps today's behaviour exactly", () => {
    expect(tyOfColumn("text", false)).toEqual(T.text());
    expect(tyOfColumn("text", false, null)).toEqual(T.text());
  });
});

describe("Key — a row's declared identity (compiled-builder, dedupe keys)", () => {
  it("flows into Text and into Key, and nothing else becomes one", () => {
    expect(assignable(T.key(), T.key()).ok).toBe(true);
    expect(assignable(T.key(), T.text()).ok).toBe(true);
    for (const from of [T.text(), T.address(), T.int()]) expect(assignable(from, T.key())).toMatchObject({ ok: false, why: "narrowing" });
  });
  it("is declared by the schema owner's `key` tag on a text column, never inferred", () => {
    expect(tyOfColumn("text", false, "key")).toEqual(T.key());
    expect(tyOfColumn("text", true, "key")).toEqual(T.option(T.key()));
    expect(tyOfColumn("integer", false, "key")).toEqual(T.int());
    expect(tyOfColumn("text", false, null)).toEqual(T.text());
  });
  it("is never a literal — “same incident” is refused, so one key cannot silence every row", async () => {
    const { literalFits } = await import("../engine/ops.js");
    expect(literalFits("same incident", T.key(), {} as never)).toMatch(/row's identity/);
    expect(literalFits("INC-1021", T.option(T.key()), {} as never)).toMatch(/row's identity/);
  });
});
