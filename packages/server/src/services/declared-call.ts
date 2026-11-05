/**
 * Declared API calls (plans/declared-api-calls-2026-10-29) — the pure half: what a declaration may say, and the hash that
 * becomes the tool's address. The CONNECTOR is the enforcement (`packages/connector/src/declared.mjs`): it rebuilds the
 * request from the declaration and refuses anything that could leave the template. This side refuses a bad declaration
 * before it is stored, so a person sees why at once rather than at the first run.
 *
 * ⚠ `canonical` / `declarationHash` must stay byte-identical to the connector's: the address carries the hash and the
 * connector refuses a declaration that does not hash to it. `declared-call.test.ts` asserts the connector's own fixture
 * hash AND runs the connector's module on the same inputs.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const DECLARED_PREFIX = "call_";
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const LITERAL = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
const BLANK = /^\{([a-z][a-z0-9_]{0,62})\}$/;
const QUERY_KEY = /^[A-Za-z0-9_.$-]{1,64}$/;
const BODY_STEP = /^([A-Za-z_$][A-Za-z0-9_$-]{0,63})?((?:\[\d\])*)$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export const declaredParamSchema = z
  .object({
    name: z.string().regex(NAME, "a blank's name is lower_snake_case"),
    in: z.enum(["path", "query", "body"]),
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().default(false),
    description: z.string().trim().max(500).default(""),
    /**
     * The service's own name for a query field (`$top`, `searchCriteria.status`, sent as written), or a body field's
     * PLACE — dots nest and `[n]` indexes a list: `commits[0].changes[0].item.path`, `[0].name` for a top-level list.
     */
    key: z.string().regex(/^[A-Za-z0-9_.$[\]-]{1,128}$/, "a key is letters, digits, _ . $ - and [n]").optional(),
  })
  .strict();

export const declaredCallSchema = z
  .object({
    /** The tool is named `<service>_<name>`. */
    name: z.string().regex(NAME, "a call's name is lower_snake_case"),
    displayName: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10, "say in a sentence what it does").max(1000),
    method: z.enum(["GET", "POST", "PUT", "PATCH"], { message: "method is GET, POST, PUT or PATCH (DELETE is never declared)" }),
    path: z.string().min(1).max(500),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    params: z.array(declaredParamSchema).max(30).default([]),
    returns: z.enum(["json", "file"]).default("json"),
    /** Body fields sent on every call, by place (`commits[0].changes[0].changeType` → `add`). Never with a GET. */
    body: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type DeclaredCall = z.infer<typeof declaredCallSchema>;
export type Declaration = Pick<DeclaredCall, "method" | "path" | "query" | "params" | "returns"> & { body?: DeclaredCall["body"] };

/** The fields that decide what the call does — never its wording. Key order is fixed; the connector's is the same. */
export function canonical(d: Declaration): string {
  return JSON.stringify({
    method: d.method,
    path: d.path,
    query: Object.keys(d.query ?? {})
      .sort()
      .map((k) => [k, String(d.query[k])]),
    params: [...(d.params ?? [])]
      .map((p) => [p.name, p.in, p.type, p.required === true, wireName(p)])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    returns: d.returns === "file" ? "file" : "json",
    // Only when present, so a declaration with no fixed body keeps the hash it always had.
    ...(Object.keys(d.body ?? {}).length
      ? {
          body: Object.keys(d.body!)
            .sort()
            .map((k) => [k, d.body![k]]),
        }
      : {}),
  });
}

/** A body field's place: `a.b[0].c` → ["a", "b", 0, "c"]; `[0].name` → [0, "name"]. Null when it is not one. */
export function bodyPath(key: string): Array<string | number> | null {
  if (key.length === 0 || key.length > 128) return null;
  const out: Array<string | number> = [];
  const steps = key.split(".");
  for (let i = 0; i < steps.length; i++) {
    const m = BODY_STEP.exec(steps[i]!);
    if (!m || (!m[1] && !m[2]) || (!m[1] && i > 0)) return null;
    if (m[1]) {
      if (FORBIDDEN.has(m[1])) return null;
      out.push(m[1]);
    }
    for (const n of m[2]!.matchAll(/\[(\d)\]/g)) out.push(Number(n[1]));
  }
  return out;
}

/** Every body place must agree on its shape: no place inside another, one kind per container, no gaps. */
function bodyShapeProblem(paths: Array<Array<string | number>>): string | null {
  const seen = new Map<string, { kind: string; indices: Set<number>; leaf: boolean }>();
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const at = JSON.stringify(path.slice(0, i));
      const kind = typeof path[i] === "number" ? "array" : "object";
      if (seen.get(at)?.leaf) return "one body field sits inside another";
      if (seen.has(at) && seen.get(at)!.kind !== kind) return `body field ${at === "[]" ? "(the body)" : at} is both an array and an object`;
      if (!seen.has(at)) seen.set(at, { kind, indices: new Set(), leaf: false });
      if (kind === "array") seen.get(at)!.indices.add(path[i] as number);
    }
    const leafAt = JSON.stringify(path);
    if (seen.has(leafAt)) return "one body field sits inside another";
    seen.set(leafAt, { kind: "leaf", indices: new Set(), leaf: true });
  }
  for (const v of seen.values()) if (v.kind === "array" && [...v.indices].some((n) => n >= v.indices.size)) return "a body array skips a position";
  return null;
}

/** The name a query or body blank is sent under: its `key`, else its name. A path blank has no key. */
export const wireName = (p: { name: string; in: string; key?: string }) => (p.in === "path" ? p.name : (p.key ?? p.name));

export function declarationHash(d: Declaration): string {
  return createHash("sha256").update(canonical(d)).digest("hex").slice(0, 16);
}

/** The rules the shape cannot say. Returns the first broken one, or null. Mirrors the connector's `checkDeclaration`. */
export function declarationProblem(d: Declaration): string | null {
  if (!d.path.startsWith("/")) return "the path starts with /";
  const names = new Set<string>();
  for (const p of d.params) {
    if (names.has(p.name)) return `blank "${p.name}" is declared twice`;
    names.add(p.name);
    if (p.in === "body" && d.method === "GET") return `a GET has no body (blank "${p.name}")`;
    if (p.key !== undefined && p.in === "path") return `blank "${p.name}": a path blank has no key`;
    if (p.in === "query" && !QUERY_KEY.test(wireName(p))) return `blank "${p.name}": a query key is letters, digits, _ . $ -`;
    if (p.in === "body" && !bodyPath(wireName(p))) return `blank "${p.name}": "${wireName(p)}" is not a body field's place (e.g. commits[0].comment)`;
  }
  const wire = new Set<string>();
  for (const p of d.params) {
    if (p.in === "path") continue;
    const w = `${p.in}:${wireName(p)}`;
    if (wire.has(w)) return `two blanks are sent as ${p.in} "${wireName(p)}"`;
    wire.add(w);
  }
  const inPath = new Set<string>();
  for (const s of d.path === "/" ? [] : d.path.slice(1).split("/")) {
    if (s === "") return "the path has an empty segment (//) or a trailing /";
    const blank = BLANK.exec(s);
    if (blank) {
      const p = d.params.find((x) => x.name === blank[1]);
      if (!p || p.in !== "path") return `path blank {${blank[1]}} is not declared as a path input`;
      inPath.add(blank[1]!);
      continue;
    }
    if (s === "." || s === "..") return "the path may not contain . or .. segments";
    if (!LITERAL.test(s)) return `path segment "${s}" has characters a template may not use (no %, ?, #, spaces or braces)`;
  }
  for (const p of d.params) if (p.in === "path" && !inPath.has(p.name)) return `path input "${p.name}" does not appear in the path`;
  for (const k of Object.keys(d.query)) {
    if (!/^[A-Za-z0-9_.$-]{1,64}$/.test(k)) return `fixed query key "${k}" is not allowed`;
    if (d.params.some((p) => p.in === "query" && wireName(p) === k)) return `query "${k}" is both fixed and a blank`;
  }
  const fixedBody = d.body ?? {};
  if (Object.keys(fixedBody).length && d.method === "GET") return "a GET has no body";
  for (const k of Object.keys(fixedBody)) {
    if (!bodyPath(k)) return `fixed body field "${k}" is not a body field's place`;
    if (d.params.some((p) => p.in === "body" && wireName(p) === k)) return `body "${k}" is both fixed and a blank`;
  }
  return bodyShapeProblem([...Object.keys(fixedBody), ...d.params.filter((p) => p.in === "body").map(wireName)].map((k) => bodyPath(k)!));
}

/** The tool's parameters, in the flat `{name: {type, required, description}}` shape every tool uses. */
export function declaredParams(d: DeclaredCall): Record<string, { type: string; required: boolean; description: string }> {
  return Object.fromEntries(d.params.map((p) => [p.name, { type: p.type, required: p.required, description: p.description }]));
}

export const declarationOf = (d: DeclaredCall): Declaration => ({
  method: d.method,
  path: d.path,
  query: d.query,
  params: d.params,
  returns: d.returns,
  ...(Object.keys(d.body ?? {}).length ? { body: d.body } : {}),
});

/** How a declared call describes itself as a tool — the workspace's and a person's own say the same thing. */
export function declaredDescription(service: string, call: Pick<DeclaredCall, "displayName" | "description" | "method" | "path">): string {
  const writes = call.method !== "GET";
  return `${service} — ${call.displayName}. ${call.description} (${writes ? "CHANGES data in" : "Only reads from"} ${service}, through a declared ${call.method} ${call.path}.${writes ? " A test run records a change and does not perform it." : ""})`;
}
