/**
 * The flow type language — phased-typed-build phase 1, task 1 (D-238, D-240).
 *
 * Rust-like on purpose: **no implicit coercion, nullability is explicit, and a
 * value whose shape nothing declares is `Opaque` rather than a guess.** Every
 * judgement here is pure data in, pure data out; the rules in `check.ts` decide
 * what severity a failed judgement carries.
 *
 * ⚠ `Opaque` is the gradual-typing escape hatch (a legacy `paramsExpr`, a tool
 * with no declared output). It is assignable both ways and the result SAYS it
 * was unchecked, so a rule can report it — the `unsafe` block, never silence.
 */

export type Refinement =
  | { r: "SingleLine" }
  | { r: "NonEmpty" }
  | { r: "MaxLen"; n: number }
  | { r: "OneOf"; values: string[] };

export type Scalar = "Text" | "Int" | "Number" | "Bool" | "Date" | "DateTime" | "Month" | "Address" | "Key";
/**
 * builder-behaviour P7 (R23): a length of time a number counts in — declared by the schema owner (`unit=minutes`) or exact from the
 * column's own computation (a difference in minutes). `business_minutes` counts working time only: never converted to or from
 * calendar time. Seconds-based factors for the calendar units.
 */
export const TIME_UNITS = ["seconds", "minutes", "hours", "days", "business_minutes"] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];
export type NumUnit = "minor" | TimeUnit;
export const SECONDS_IN: Partial<Record<TimeUnit, number>> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

export type Ty =
  | { t: "Text"; refine?: Refinement[] }
  /**
   * A number may carry the UNIT its owner declared: `minor` is an amount in minor units (cents) — still a number everywhere a number
   * is taken, and converted (÷100) wherever it is shown to a person (2026-10-01: "Budget cents: 120000" in an email). Declared,
   * never inferred from a name.
   */
  | { t: "Int" | "Number"; unit?: NumUnit }
  /**
   * A date may carry the GRANULARITY its owner compares it at: `per: "month"` is a date compared by its month — any day of the month
   * means that month (2026-10-01). There is one kind of time input, a date; whether it is read as a day or as the month containing it
   * is the filter's declaration, never a second type with its own string format to mismatch. Declared, never inferred from a name.
   */
  | { t: "Date"; per?: "month" }
  | { t: Exclude<Scalar, "Text" | "Int" | "Number" | "Date"> }
  | { t: "Json" }
  | { t: "Option"; of: Ty }
  | { t: "List"; of: Ty }
  | { t: "Record"; fields: Record<string, Ty> }
  | { t: "Rows"; of: Ty }
  | { t: "Envelope"; of: Ty }
  | { t: "Opaque" }
  | { t: "Never" };

// ── Constructors ────────────────────────────────────────────────────────────
export const T = {
  text: (refine?: Refinement[]): Ty => (refine?.length ? { t: "Text", refine } : { t: "Text" }),
  int: (): Ty => ({ t: "Int" }),
  number: (): Ty => ({ t: "Number" }),
  /** The same number, declared an amount in minor units. */
  minor: (ty: Ty): Ty => (ty.t === "Int" || ty.t === "Number" ? { t: ty.t, unit: "minor" } : ty),
  /** The same number, declared a length of time in `u` (P7, R23). */
  timeIn: (ty: Ty, u: TimeUnit): Ty => (ty.t === "Int" || ty.t === "Number" ? { t: ty.t, unit: u } : ty.t === "Option" && (ty.of.t === "Int" || ty.of.t === "Number") ? { t: "Option", of: { t: ty.of.t, unit: u } } : ty),
  bool: (): Ty => ({ t: "Bool" }),
  date: (per?: "month"): Ty => (per ? { t: "Date", per } : { t: "Date" }),
  dateTime: (): Ty => ({ t: "DateTime" }),
  month: (): Ty => ({ t: "Month" }),
  address: (): Ty => ({ t: "Address" }),
  /** A row's declared identity (an incident code): it comes from the row it names, never from typed words (dedupe keys). */
  key: (): Ty => ({ t: "Key" }),
  json: (): Ty => ({ t: "Json" }),
  option: (of: Ty): Ty => (of.t === "Option" ? of : { t: "Option", of }),
  list: (of: Ty): Ty => ({ t: "List", of }),
  record: (fields: Record<string, Ty>): Ty => ({ t: "Record", fields }),
  rows: (of: Ty): Ty => ({ t: "Rows", of }),
  envelope: (of: Ty): Ty => ({ t: "Envelope", of }),
  opaque: (): Ty => ({ t: "Opaque" }),
  never: (): Ty => ({ t: "Never" }),
};

// ── Rendering ───────────────────────────────────────────────────────────────
function renderRefinement(x: Refinement): string {
  switch (x.r) {
    case "SingleLine": case "NonEmpty": return x.r;
    case "MaxLen": return `MaxLen(${x.n})`;
    case "OneOf": return `OneOf[${x.values.join(", ")}]`;
  }
}

export function render(ty: Ty): string {
  switch (ty.t) {
    case "Text": return ty.refine?.length ? `Text<${ty.refine.map(renderRefinement).join(", ")}>` : "Text";
    case "Int": case "Number": return "unit" in ty && ty.unit === "minor" ? `${ty.t}<minor units>` : "unit" in ty && ty.unit ? `${ty.t}<${ty.unit.replace("_", " ")}>` : ty.t;
    case "Date": return "per" in ty && ty.per === "month" ? "Date<by month>" : "Date";
    case "Option": case "List": case "Rows": case "Envelope": return `${ty.t}<${render(ty.of)}>`;
    case "Record": {
      const fs = Object.entries(ty.fields).map(([k, v]) => `${k}: ${render(v)}`);
      return `{${fs.join(", ")}}`;
    }
    default: return ty.t;
  }
}

// ── Assignability ───────────────────────────────────────────────────────────

/**
 * A conversion the type system knows how to BUILD, never applies silently.
 * The temporal half mirrors the server's `CONVERSIONS` table
 * (`flow-input-compat.ts`) — same pairs, and a test holds them equal.
 */
export type Conversion = "month-from-date" | "month-from-datetime" | "date-from-datetime" | "datetime-from-date" | "to-text" | "to-number";

export const TEMPORAL_CONVERSIONS: ReadonlyArray<{ from: Scalar; to: Scalar; name: Conversion }> = [
  { from: "Date", to: "Month", name: "month-from-date" },
  { from: "DateTime", to: "Month", name: "month-from-datetime" },
  { from: "DateTime", to: "Date", name: "date-from-datetime" },
  { from: "Date", to: "DateTime", name: "datetime-from-date" },
];

export type Why =
  /** A nullable value into a port that requires one (FT0203). */
  | "nullable"
  /** A `Json` value into a typed port (FT0208). */
  | "json_untyped"
  /** A value that MIGHT fit but cannot be shown to (Text→Address, Number→Int). */
  | "narrowing"
  /** Plainly different types (FT0202). */
  | "mismatch"
  /** A `Record` lacks a field the target requires. */
  | "missing_field"
  /** `Never` has no value to give. */
  | "never";

export type Assign =
  | { ok: true; unchecked?: string[] }
  | { ok: false; why: Why; detail: string; conversion?: Conversion };

const OK: Assign = { ok: true };
const fail = (why: Why, from: Ty, to: Ty, detail?: string, conversion?: Conversion): Assign => ({
  ok: false,
  why,
  detail: detail ?? `${render(from)} is not ${render(to)}`,
  ...(conversion ? { conversion } : {}),
});

function merge(a: Assign, b: Assign): Assign {
  if (!a.ok) return a;
  if (!b.ok) return b;
  const u = [...(a.unchecked ?? []), ...(b.unchecked ?? [])];
  return u.length ? { ok: true, unchecked: u } : OK;
}

const isScalar = (ty: Ty): ty is Extract<Ty, { t: Scalar }> =>
  ["Text", "Int", "Number", "Bool", "Date", "DateTime", "Month", "Address", "Key"].includes(ty.t);

/**
 * May a value of `from` flow into a port of type `to`, with nothing done to it?
 *
 * Structural and strict: `T → T`, `T → Option<T>`, `Int → Number`,
 * `Address → Text`, a `Record` into a `Record` needing a subset of its fields,
 * `Rows<R> → List<R>`, anything into `Json`. Nothing else. A failure names why,
 * and names the conversion that would bridge it when one exists.
 */
export function assignable(from: Ty, to: Ty): Assign {
  if (from.t === "Opaque" || to.t === "Opaque") return { ok: true, unchecked: ["Opaque"] };
  if (from.t === "Never") return fail("never", from, to, "this step produces nothing to read");
  if (to.t === "Never") return fail("mismatch", from, to);

  // ⚠ Nullability is judged BEFORE `Json` accepts everything: a null is valid
  // JSON and still refused by a validator that needs a value (Kestra
  // `3VRhNsJO…`: `to: Expected string, received null`).
  if (to.t === "Option") {
    if (from.t === "Option") return assignable(from.of, to.of);
    return assignable(from, to.of);
  }
  if (from.t === "Option") {
    const inner = assignable(from.of, to);
    return inner.ok ? fail("nullable", from, to, `${render(from)} may be null; the port needs ${render(to)}`) : inner;
  }
  if (to.t === "Json") return OK; // every non-null value is JSON
  if (from.t === "Json") return fail("json_untyped", from, to, `an untyped JSON value is not ${render(to)} until it is converted`);

  if (isScalar(from) && isScalar(to)) return assignScalar(from, to);

  // The empty list (\`List<Never>\`, a projected \`[]\`) has one value, and it is in every list type.
  if (to.t === "List" && from.t === "List" && from.of.t === "Never") return OK;
  if (to.t === "List" && (from.t === "List" || from.t === "Rows")) return assignable(from.of, to.of);
  if (to.t === "Rows" && from.t === "Rows") return assignable(from.of, to.of);
  if (to.t === "Envelope" && from.t === "Envelope") return assignable(from.of, to.of);
  if (to.t === "Record" && from.t === "Record") {
    let acc: Assign = OK;
    for (const [k, want] of Object.entries(to.fields)) {
      const have = from.fields[k];
      if (!have) {
        if (want.t === "Option") continue; // an optional field may be absent
        return fail("missing_field", from, to, `field \`${k}\` is not in ${render(from)}`);
      }
      acc = merge(acc, assignable(have, want));
      if (!acc.ok) return { ...acc, detail: `field \`${k}\`: ${acc.detail}` };
    }
    return acc;
  }
  return fail("mismatch", from, to);
}

function assignScalar(from: Extract<Ty, { t: Scalar }>, to: Extract<Ty, { t: Scalar }>): Assign {
  if (from.t === to.t) {
    if (to.t !== "Text" || !("refine" in to) || !to.refine?.length) return OK;
    // Data cannot be shown to satisfy a refinement statically; literals are
    // checked against it elsewhere (FT0402). Say so rather than pass silently.
    const have = new Set((("refine" in from && from.refine) || []).map(renderRefinement));
    const missing = to.refine.map(renderRefinement).filter((r) => !have.has(r));
    return missing.length ? { ok: true, unchecked: missing } : OK;
  }
  if (from.t === "Int" && to.t === "Number") return OK;
  // A month is exactly what a date compared by its month asks for: the compiler reads the month of either (`left(…, 7)`).
  if (from.t === "Month" && to.t === "Date" && "per" in to && to.per === "month") return OK;
  if ((from.t === "Address" || from.t === "Key") && to.t === "Text") return assignScalar({ t: "Text" }, to);
  if (from.t === "Number" && to.t === "Int") return fail("narrowing", from, to, "a Number may not be whole");
  if (from.t === "Text" && to.t === "Address") return fail("narrowing", from, to, "Text is not known to be an email address");
  if (to.t === "Key") return fail("narrowing", from, to, "only a column declared as a row's identity is a Key");
  const conv = TEMPORAL_CONVERSIONS.find((c) => c.from === from.t && c.to === to.t);
  if (conv) return fail("mismatch", from, to, `${from.t} is not ${to.t} — convert it (${conv.name})`, conv.name);
  if (to.t === "Text") return fail("mismatch", from, to, `${from.t} is not Text — convert it (to-text)`, "to-text");
  if (to.t === "Number" && from.t === "Text") return fail("narrowing", from, to, "Text is not known to be a number", "to-number");
  return fail("mismatch", from, to);
}

/**
 * The type AFTER a Source's explicit `transform` (`node-types.ts` `Source`).
 * `null` means the conversion does not apply to that type — itself an error.
 */
export function convert(from: Ty, transform: "date" | "text" | "number" | "month"): Ty | null {
  const base = from.t === "Option" ? from.of : from;
  const wrap = (ty: Ty) => (from.t === "Option" ? T.option(ty) : ty);
  // `month` is never a guess over an unknown value: only a Date/DateTime is cut (D-272).
  if (transform === "month") return base.t === "Date" || base.t === "DateTime" ? wrap(T.month()) : null;
  if (base.t === "Opaque" || base.t === "Json") return wrap(transform === "date" ? T.date() : transform === "number" ? T.number() : T.text());
  // `tostring` accepts ANY value — a record or a list becomes its JSON text,
  // which is exactly what a text port fed a whole output wants.
  if (transform === "text") return wrap(T.text());
  if (!isScalar(base)) return null;
  switch (transform) {
    case "number": return ["Int", "Number", "Text"].includes(base.t) ? wrap(T.number()) : null;
    case "date": return ["Date", "DateTime", "Text"].includes(base.t) ? wrap(T.date()) : null;
  }
}

/**
 * D-273 — the type a source has once its `onNull` rule is applied. A field rule
 * strips the `Option` off the value (or off each element of a projected list); a
 * map rule strips it off the named fields of each row. Anything else unchanged.
 */
export function applyOnNull(ty: Ty, onNull: "skip" | "fail" | Record<string, "skip" | "fail"> | undefined): Ty {
  if (!onNull) return ty;
  if (typeof onNull === "string") {
    if (ty.t === "Option") return ty.of;
    if (ty.t === "List" && ty.of.t === "Option") return T.list(ty.of.of);
    return ty;
  }
  const strip = (r: Ty): Ty =>
    r.t === "Record"
      ? { t: "Record", fields: Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, k in onNull && v.t === "Option" ? v.of : v])) }
      : r;
  if (ty.t === "Envelope") return { t: "Envelope", of: applyOnNull(ty.of, onNull) };
  if (ty.t === "Rows" || ty.t === "List") return { ...ty, of: strip(ty.of) } as Ty;
  return strip(ty);
}

// ── From what the catalogue declares ───────────────────────────────────────

/**
 * An introspected Postgres/MySQL column type → a Ty. Unknown ⇒ `Opaque`,
 * never a widening to `Text` (a widened type accepts what the column rejects).
 */
/**
 * An enum's members, from the introspected type string (compiled-builder I-301): Postgres `user-defined:<name>(a,b)`
 * (`postgres.introspector.ts` `columnType`) or MySQL `enum('a','b')`. `null` when the type carries no member list.
 */
export function enumValuesOfType(columnType: string | null | undefined): string[] | null {
  const raw = String(columnType ?? "").trim();
  const pg = /^user-defined:[^()]+\((.+)\)$/i.exec(raw);
  if (pg) return pg[1]!.split(",");
  const my = /^enum\((.+)\)$/i.exec(raw);
  if (!my) return null;
  const vals = [...my[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
  return vals.length ? vals : null;
}

export function tyOfColumn(columnType: string | null | undefined, nullable = false, tag?: string | null, domain?: readonly string[] | null): Ty {
  const c = String(columnType ?? "").toLowerCase().trim();
  const values = domain?.length ? [...domain] : enumValuesOfType(columnType);
  let ty: Ty;
  if (/^(text|character varying|varchar|char|character|citext|uuid|name|bpchar)/.test(c) || c.startsWith("enum") || c === "user-defined" || (c.startsWith("user-defined:") && values)) ty = T.text();
  else if (/^(smallint|integer|int|bigint|int2|int4|int8|serial|bigserial|smallserial|tinyint|mediumint)\b/.test(c)) ty = T.int();
  else if (/^(numeric|decimal|real|double|float|money)/.test(c)) ty = T.number();
  else if (/^(boolean|bool)\b/.test(c)) ty = T.bool();
  else if (c === "date") ty = T.date();
  else if (/^timestamp|^datetime/.test(c)) ty = T.dateTime();
  else if (/^jsonb?$/.test(c)) ty = T.json();
  else ty = T.opaque();
  // A tag the SCHEMA OWNER declared (compiled-builder I-278) refines a text column; it is never inferred from a name.
  // `email` makes an address: the one refinement a mail port needs (E0.6: 26 of 26 mail ports had no typed source).
  if (tag && /^email(;|$)/.test(tag) && ty.t === "Text") ty = T.address();
  // `key` makes a row identity — what a dedupe key must be, so repeats of ONE row are suppressed and no other row is.
  if (tag && /^key(;|$)/.test(tag) && ty.t === "Text") ty = T.key();
  // `minor_units` makes a number an amount in minor units (cents): shown to a person only once converted.
  if (tag && /^minor_units(;|$)/.test(tag)) ty = T.minor(ty);
  // `unit=minutes` (P7, R23): a number declared a length of time — a value said in days is converted to it, never read as the number.
  const tu = tag ? /(?:^|;)unit=(seconds|minutes|hours|days|business_minutes)(?:;|$)/.exec(tag)?.[1] as TimeUnit | undefined : undefined;
  if (tu) ty = T.timeIn(ty, tu);
  // A KNOWN value domain (declared by the schema, or observed when the datasource opted in) makes the column a closed set —
  // a compared literal outside it is refused, and the person is asked with the real values (I-301).
  if (values?.length && ty.t === "Text" && !ty.refine?.length) ty = T.text([{ r: "OneOf", values }]);
  return nullable && ty.t !== "Opaque" ? T.option(ty) : ty;
}

/**
 * A tool/operation parameter's declared `type` + `format` → a Ty.
 * `format` wins where it is more specific (`string` + `month` ⇒ `Month`).
 */
export function tyOfParam(type: string | undefined, format?: string, per?: string): Ty {
  const f = String(format ?? "").toLowerCase();
  if (f === "month") return T.month();
  if (f === "date") return T.date(per === "month" ? "month" : undefined);
  if (f === "datetime" || f === "date-time") return T.dateTime();
  if (f === "email") return T.address();
  switch (String(type ?? "").toLowerCase()) {
    case "string": case "text": return T.text();
    case "integer": case "int": return T.int();
    case "number": case "float": return T.number();
    case "boolean": case "bool": return T.bool();
    case "date": return T.date();
    case "datetime": return T.dateTime();
    // ⚠ `object` and `array` are SHAPES, not "any JSON" (compiled-builder I-287): typing both `Json` let a text column fill a
    // tool's `variables: object` or `recipients: array`, which the service then refused at run time with every check green.
    // An object is some record (width subtyping: any record fits), an array is some list; only `json` accepts anything.
    case "object": return T.record({});
    case "array": return T.list(T.json());
    case "json": return T.json();
    default: return T.opaque();
  }
}
