/**
 * A tool's DECLARED output shape, and its type (compiled-builder phase 2c, E0.7 G1).
 *
 * A tool used to declare its parameters and nothing about what it returns, so every tool output was `Opaque` and a
 * flow reading it wrote guesses (`.manager.work_email // .manager_email`, baseline D01). The shape is declared as tool
 * DATA beside `paramsSchema`, with the same small vocabulary, and checked against the live tool by a contract test
 * so a declaration cannot silently drift from what the endpoint really returns.
 *
 * ⚠ `nullable: true` is the only way a field may be null, and `optional: true` the only way it may be absent. Both
 * default to false, so a declaration that forgets one is refused by the contract test on the first null, not
 * believed.
 */
import { T, type Ty } from "./types.js";

export type OutputShape =
  | { type: "string"; format?: "email" | "date" | "datetime"; nullable?: boolean; optional?: boolean }
  | { type: "integer" | "number" | "boolean"; nullable?: boolean; optional?: boolean }
  | { type: "object"; fields: Record<string, OutputShape>; nullable?: boolean; optional?: boolean }
  | { type: "array"; items: OutputShape; nullable?: boolean; optional?: boolean };

/** The type a declared shape describes. An optional field is `Option`, the same as a nullable one: a read of it can miss. */
export function tyOfOutputShape(s: OutputShape): Ty {
  let ty: Ty;
  switch (s.type) {
    case "string":
      ty = s.format === "email" ? T.address() : s.format === "date" ? T.date() : s.format === "datetime" ? T.dateTime() : T.text();
      break;
    case "integer": ty = T.int(); break;
    case "number": ty = T.number(); break;
    case "boolean": ty = T.bool(); break;
    case "array": ty = T.list(tyOfOutputShape(s.items)); break;
    case "object": ty = T.record(Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, tyOfOutputShape(v)]))); break;
  }
  return s.nullable || s.optional ? T.option(ty) : ty;
}

/**
 * Does a live value conform to its declared shape? Returns every violation with its path, `[]` when it conforms.
 * The contract test's judge: pure, so it is tested here and used against the real endpoints elsewhere.
 * Extra fields are allowed (a tool may return more than it declares; nothing may READ an undeclared field).
 */
export function checkOutputShape(value: unknown, s: OutputShape, path = "$"): string[] {
  if (value === undefined) return s.optional ? [] : [`${path}: missing`];
  if (value === null) return s.nullable ? [] : [`${path}: null, but not declared nullable`];
  switch (s.type) {
    case "string":
      if (typeof value !== "string") return [`${path}: expected a string, got ${typeof value}`];
      if (s.format === "date" && !/^\d{4}-\d{2}-\d{2}/.test(value)) return [`${path}: "${value}" is not a date`];
      return [];
    case "integer": return Number.isInteger(value) ? [] : [`${path}: expected an integer, got ${JSON.stringify(value)}`];
    case "number": return typeof value === "number" ? [] : [`${path}: expected a number, got ${typeof value}`];
    case "boolean": return typeof value === "boolean" ? [] : [`${path}: expected a boolean, got ${typeof value}`];
    case "array":
      return Array.isArray(value) ? value.flatMap((v, i) => checkOutputShape(v, s.items, `${path}[${i}]`)) : [`${path}: expected an array`];
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object`];
      const o = value as Record<string, unknown>;
      return Object.entries(s.fields).flatMap(([k, f]) => checkOutputShape(o[k], f, `${path}.${k}`));
    }
  }
}
