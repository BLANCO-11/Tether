// The "add a declared API call" form, as data (plans/declared-api-calls-2026-10-29). Pure, so the page test and this
// file's own test cover it without rendering. The SERVER decides whether a call is valid and says why; this only shapes
// what a person typed, and says the obvious things before a round trip.
import type { DeclaredCallInput, DeclaredParam } from "./types";

export type DeclaredCallForm = {
  name: string;
  displayName: string;
  description: string;
  method: DeclaredCallInput["method"];
  path: string;
  /** One `key=value` per line. */
  query: string;
  /** One `place=value` per line, sent in the body on every call (not with GET). */
  body: string;
  params: DeclaredParam[];
  returns: DeclaredCallInput["returns"];
};

export const emptyDeclaredCallForm = (): DeclaredCallForm => ({
  name: "",
  displayName: "",
  description: "",
  method: "GET",
  path: "/",
  query: "",
  body: "",
  params: [],
  returns: "json",
});

/** The blanks a path names — `{project}` — so the form can add the matching inputs for the person. */
export function pathBlanks(path: string): string[] {
  return [...path.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/** The form as the server's input, or the first thing that is plainly missing. */
export function toDeclaredCall(f: DeclaredCallForm): { call: DeclaredCallInput } | { problem: string } {
  if (!/^[a-z][a-z0-9_]*$/.test(f.name)) return { problem: "Give it a short name in lower_snake_case, e.g. list_repositories." };
  if (f.displayName.trim().length < 3) return { problem: "Give it a name people will read." };
  if (f.description.trim().length < 10) return { problem: "Say in a sentence what it does." };
  if (!f.path.startsWith("/")) return { problem: "The path starts with /, after the connection's own address." };
  const query = pairs(f.query);
  if ("problem" in query) return query;
  const body = f.method === "GET" ? { values: {} } : pairs(f.body);
  if ("problem" in body) return body;
  const missing = pathBlanks(f.path).filter((b) => !f.params.some((p) => p.name === b && p.in === "path"));
  if (missing.length) return { problem: `Add an input for {${missing[0]}} in the path.` };
  const params = f.params.map((p) => {
    const out: DeclaredParam = { name: p.name, in: p.in, type: p.type, required: p.required, description: p.description };
    if (p.in !== "path" && p.key?.trim()) out.key = p.key.trim();
    return out;
  });
  return {
    call: {
      name: f.name,
      displayName: f.displayName.trim(),
      description: f.description.trim(),
      method: f.method,
      path: f.path.trim(),
      query: query.values,
      params,
      returns: f.returns,
      ...(Object.keys(body.values).length ? { body: body.values } : {}),
    },
  };
}

/** `key=value` lines. Values are sent as text; the server decides whether a key is allowed where it is used. */
function pairs(text: string): { values: Record<string, string> } | { problem: string } {
  const values: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i < 1) return { problem: `"${line}" is not key=value.` };
    values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { values };
}
