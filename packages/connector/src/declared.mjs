/**
 * Declared API calls (plans/declared-api-calls-2026-10-29). A piece's raw "custom API call" takes a free URL and method,
 * so it is never run as such; a DECLARED call fixes the method, a path template with typed blanks, fixed query values
 * and which inputs go in the body, and a run fills only the blanks. This module, in the PARENT (before any piece code
 * runs), is the enforcement: it builds the raw call's inputs itself and refuses anything that could leave the template.
 *
 * ⚠ Measured (phase 0): the HTTP client resolves `..` and even `%2e%2e`, and a call left the organisation's base address
 * on the same host, carrying the credential. So dot segments are refused in the template and in every value, `%` may
 * not appear in the template, values are percent-encoded, and the FINAL path is compared after URL normalisation.
 *
 * ⚠ `canonical` / `declarationHash` must stay byte-identical to the server's (`declared-call.service.ts`): the tool's
 * address carries the hash, and a declaration that does not hash to it is refused. A shared fixture pins both.
 */
import { createHash } from "node:crypto";
import { RunError } from "./run.mjs";

export const DECLARED_PREFIX = "call_";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);
const TYPES = new Set(["string", "number", "boolean"]);
const PLACES = new Set(["path", "query", "body"]);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const QUERY_KEY = /^[A-Za-z0-9_.$-]{1,64}$/;
/** A literal path segment: RFC 3986 pchar without `%` (no pre-encoded text in a template). */
const LITERAL = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
const BLANK = /^\{([a-z][a-z0-9_]{0,62})\}$/;
/** One step of a body path: a field name, then any `[n]` indices. `commits[0].changes[0].item.path`; `[0].name` is a top-level array. */
const BODY_STEP = /^([A-Za-z_$][A-Za-z0-9_$-]{0,63})?((?:\[\d\])*)$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

const bad = (message) => new RunError("validation", `declared call: ${message}`);

/** The fields that decide what the call does — and nothing a person might reword. Key order is fixed. */
export function canonical(d) {
  return JSON.stringify({
    method: d.method,
    path: d.path,
    query: Object.keys(d.query ?? {})
      .sort()
      .map((k) => [k, String(d.query[k])]),
    params: [...(d.params ?? [])]
      .map((p) => [p.name, p.in, p.type, p.required === true, wireName(p)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    returns: d.returns === "file" ? "file" : "json",
    // Only when present, so a declaration with no fixed body keeps the hash it always had.
    ...(Object.keys(d.body ?? {}).length
      ? {
          body: Object.keys(d.body)
            .sort()
            .map((k) => [k, d.body[k]]),
        }
      : {}),
  });
}

/** The name a query or body blank is sent under: its `key` (the service's own spelling, e.g. `$top`), else its name. */
export const wireName = (p) => (p.in === "path" ? p.name : p.key ?? p.name);

export function declarationHash(d) {
  return createHash("sha256").update(canonical(d)).digest("hex").slice(0, 16);
}

/**
 * A body field's place: `a.b[0].c` → ["a", "b", 0, "c"]; `[0].name` → [0, "name"]. Null when it is not a path. Dots
 * NEST in a body (a query key is sent as written). Indices are single digits: a declared body is small.
 */
export function bodyPath(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 128) return null;
  const out = [];
  const steps = key.split(".");
  for (let i = 0; i < steps.length; i++) {
    const m = BODY_STEP.exec(steps[i]);
    if (!m || (!m[1] && !m[2]) || (!m[1] && i > 0)) return null;
    if (m[1]) {
      if (FORBIDDEN.has(m[1])) return null;
      out.push(m[1]);
    }
    for (const n of m[2].matchAll(/\[(\d)\]/g)) out.push(Number(n[1]));
  }
  return out;
}

/** Every body place (fixed and blank) must agree on its shape: no place inside another, one kind per container, no gaps. */
function bodyShapeProblem(paths) {
  const seen = new Map();
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const at = JSON.stringify(path.slice(0, i));
      const kind = typeof path[i] === "number" ? "array" : "object";
      if (seen.get(at)?.leaf) return "one body field sits inside another";
      if (seen.has(at) && seen.get(at).kind !== kind) return `body field ${at === "[]" ? "(the body)" : at} is both an array and an object`;
      if (!seen.has(at)) seen.set(at, { kind, indices: new Set(), leaf: false });
      if (kind === "array") seen.get(at).indices.add(path[i]);
    }
    const leafAt = JSON.stringify(path);
    if (seen.has(leafAt)) return "one body field sits inside another";
    seen.set(leafAt, { kind: "leaf", indices: new Set(), leaf: true });
  }
  for (const v of seen.values()) if (v.kind === "array" && [...v.indices].some((n) => n >= v.indices.size)) return "a body array skips a position";
  return null;
}

/** Every rule a declaration must meet. Throws a validation RunError naming the first broken one. */
export function checkDeclaration(d) {
  if (!d || typeof d !== "object") throw bad("missing");
  if (!METHODS.has(d.method)) throw bad(`method must be one of ${[...METHODS].join(", ")} (DELETE is never declared)`);
  if (typeof d.path !== "string" || !d.path.startsWith("/") || d.path.length > 500) throw bad("path must start with /");
  const params = Array.isArray(d.params) ? d.params : [];
  const names = new Set();
  for (const p of params) {
    if (!p || !NAME.test(p.name ?? "")) throw bad(`a blank's name must be lower_snake_case (got "${p?.name}")`);
    if (names.has(p.name)) throw bad(`blank "${p.name}" is declared twice`);
    names.add(p.name);
    if (!PLACES.has(p.in)) throw bad(`blank "${p.name}" must go in path, query or body`);
    if (!TYPES.has(p.type)) throw bad(`blank "${p.name}" must be a string, number or boolean`);
    if (p.in === "body" && d.method === "GET") throw bad(`a GET has no body (blank "${p.name}")`);
    if (p.key !== undefined && (p.in === "path" || typeof p.key !== "string" || !(p.in === "query" ? QUERY_KEY.test(p.key) : bodyPath(p.key)))) {
      throw bad(`blank "${p.name}": a key is the service's name for a query field (letters, digits, _ . $ -) or a body field's place (e.g. commits[0].comment)`);
    }
    if (p.in === "body" && !bodyPath(wireName(p))) throw bad(`blank "${p.name}" is not a body field name`);
  }
  const wire = new Set();
  for (const p of params) {
    if (p.in === "path") continue;
    const w = `${p.in}:${wireName(p)}`;
    if (wire.has(w)) throw bad(`two blanks are sent as ${p.in} "${wireName(p)}"`);
    wire.add(w);
  }
  const inPath = new Set();
  const segments = d.path === "/" ? [] : d.path.slice(1).split("/");
  for (const s of segments) {
    if (s === "" ) throw bad("the path has an empty segment (//) or a trailing /");
    const blank = BLANK.exec(s);
    if (blank) {
      const p = params.find((x) => x.name === blank[1]);
      if (!p || p.in !== "path") throw bad(`path blank {${blank[1]}} is not declared as a path input`);
      inPath.add(blank[1]);
      continue;
    }
    if (s === "." || s === "..") throw bad("the path may not contain . or .. segments");
    if (!LITERAL.test(s)) throw bad(`path segment "${s}" has characters a template may not use (no %, ?, #, spaces or braces)`);
  }
  for (const p of params) if (p.in === "path" && !inPath.has(p.name)) throw bad(`path input "${p.name}" does not appear in the path`);
  for (const [k, v] of Object.entries(d.query ?? {})) {
    if (!QUERY_KEY.test(k)) throw bad(`fixed query key "${k}" is not allowed`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw bad(`fixed query "${k}" must be a plain value`);
    if (params.some((p) => p.in === "query" && wireName(p) === k)) throw bad(`query "${k}" is both fixed and a blank`);
  }
  const fixedBody = d.body ?? {};
  if (typeof fixedBody !== "object" || Array.isArray(fixedBody)) throw bad("the fixed body is field → value");
  if (Object.keys(fixedBody).length && d.method === "GET") throw bad("a GET has no body");
  for (const [k, v] of Object.entries(fixedBody)) {
    if (!bodyPath(k)) throw bad(`fixed body field "${k}" is not a body field's place`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw bad(`fixed body "${k}" must be a plain value`);
    if (params.some((p) => p.in === "body" && wireName(p) === k)) throw bad(`body "${k}" is both fixed and a blank`);
  }
  const shape = bodyShapeProblem([...Object.keys(fixedBody), ...params.filter((p) => p.in === "body").map(wireName)].map(bodyPath));
  if (shape) throw bad(shape);
  if (d.returns !== undefined && d.returns !== "json" && d.returns !== "file") throw bad(`returns must be json or file`);
}

/** Put one value at its place, making the containers on the way. */
function place(root, path, value) {
  let at = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (at[path[i]] === undefined) at[path[i]] = typeof path[i + 1] === "number" ? [] : {};
    at = at[path[i]];
  }
  at[path[path.length - 1]] = value;
}

function typed(p, v) {
  if (p.type === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) throw bad(`"${p.name}" must be a number`);
    return n;
  }
  if (p.type === "boolean") {
    if (v === true || v === "true") return true;
    if (v === false || v === "false") return false;
    throw bad(`"${p.name}" must be true or false`);
  }
  if (typeof v !== "string" && typeof v !== "number") throw bad(`"${p.name}" must be text`);
  return String(v);
}

/**
 * The raw call's inputs for this declaration and these values, and whether it changes data. Refuses an unknown or
 * missing value, a path value that is a dot segment, and — the last line — a final path that URL normalisation would
 * change: the request goes exactly where the template says or nowhere.
 */
export function buildDeclaredCall(d, values) {
  checkDeclaration(d);
  const given = values && typeof values === "object" ? values : {};
  const params = d.params ?? [];
  const unknown = Object.keys(given).filter((k) => !params.some((p) => p.name === k));
  if (unknown.length) throw bad(`not inputs of this call: ${unknown.join(", ")}`);
  const val = {};
  for (const p of params) {
    const v = given[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw bad(`missing: ${p.name}`);
      continue;
    }
    val[p.name] = typed(p, v);
  }

  const segments = d.path === "/" ? [] : d.path.slice(1).split("/");
  const built = segments.map((s) => {
    const blank = BLANK.exec(s);
    if (!blank) return s;
    const v = val[blank[1]];
    if (v === undefined) throw bad(`missing: ${blank[1]}`);
    const text = String(v);
    if (text === "." || text === "..") throw bad(`"${blank[1]}" may not be . or ..`);
    // ⚠ Measured: Azure DevOps DECODES %2F in a path and resolves "..%2Fother-org" itself, server-side — the request
    // left the organisation though we sent one encoded segment. So a path value may not carry a separator at all,
    // encoded or not. A name (project, repository) never needs one; a file path goes in the query.
    if (/[/\\%]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) {
      throw bad(`"${blank[1]}" is one part of the address: it may not contain /, \\, % or control characters (a file path goes in a query input)`);
    }
    return encodeURIComponent(text);
  });
  const path = `/${built.join("/")}`;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(d.query ?? {})) query.set(k, String(v));
  for (const p of params) if (p.in === "query" && val[p.name] !== undefined) query.set(wireName(p), String(val[p.name]));
  const qs = query.toString();
  const relative = qs ? `${path}?${qs}` : path;

  // Resolved against a stand-in base, the path must come back EXACTLY as built: normalisation changed nothing.
  const probe = new URL(relative.slice(1), "https://base.invalid/b/");
  if (probe.host !== "base.invalid" || probe.pathname !== `/b${path === "/" ? "/" : path}`) {
    throw bad("the built address does not stay where the template says");
  }

  const places = [
    ...Object.entries(d.body ?? {}).map(([k, v]) => [bodyPath(k), v]),
    ...params.filter((p) => p.in === "body" && val[p.name] !== undefined).map((p) => [bodyPath(wireName(p)), val[p.name]]),
  ];
  const hasBody = d.method !== "GET" && (params.some((p) => p.in === "body") || Object.keys(d.body ?? {}).length > 0);
  const body = places.length && typeof places[0][0][0] === "number" ? [] : {};
  for (const [path, v] of places) place(body, path, v);
  // An optional blank left out may leave an array with a hole; the service would read it as null. Refuse instead.
  const holes = (x) => (Array.isArray(x) ? [...x.keys()].some((i) => !(i in x)) || x.some(holes) : x && typeof x === "object" ? Object.values(x).some(holes) : false);
  if (holes(body)) throw bad("a body list would have a gap: give the inputs that fill it");
  return {
    writes: d.method !== "GET",
    props: {
      url: { url: relative },
      method: d.method,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
      body_type: hasBody ? "json" : "none",
      ...(hasBody ? { body: { data: body } } : {}),
      response_is_binary: d.returns === "file",
      failsafe: false,
      followRedirects: false,
    },
  };
}

/** The answer a declared call returns: the service's, without cookies it set. */
export function declaredOutput(output) {
  if (!output || typeof output !== "object" || !output.headers) return output;
  const headers = Object.fromEntries(Object.entries(output.headers).filter(([k]) => k.toLowerCase() !== "set-cookie"));
  return { ...output, headers };
}
