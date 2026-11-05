import { describe, expect, it } from "vitest";
import { canonical, declarationHash, declarationProblem, type Declaration } from "./declared-call.js";
import { DECLARED_CALL_PACKS } from "./declared-call-packs.js";
// ⚠ The connector's own module — the enforcement. Imported here so the two sides cannot drift apart unnoticed.
// @ts-expect-error — a plain .mjs module with no types
import * as connector from "../../../connector/src/declared.mjs";

/**
 * Declared API calls: the server and the connector must agree on (1) the hash — the tool's address carries it and the
 * connector refuses a declaration that does not hash to it — and (2) what a valid declaration is, or a person would be
 * told a call is fine and see it refused at the first run. And every call Foundry ships in a pack must pass the
 * connector's own rules.
 */
const LIST_ITEMS: Declaration = {
  method: "GET",
  path: "/{project}/_apis/git/repositories/{repo}/items",
  query: { "api-version": "7.1" },
  params: [
    { name: "project", in: "path", type: "string", required: true, description: "" },
    { name: "repo", in: "path", type: "string", required: true, description: "" },
    { name: "path", in: "query", type: "string", required: false, description: "" },
  ],
  returns: "json",
};

const bodyBlank = (name: string, key: string) => ({ name, in: "body" as const, type: "string" as const, required: false, description: "", key });
const PUSHLIKE: Declaration = { method: "POST", path: "/x", query: {}, params: [], returns: "json", body: {} };

describe("the server and the connector agree", () => {
  it("on the hash — the same literal the connector's own test pins", () => {
    expect(declarationHash(LIST_ITEMS)).toBe("c881f7cd98bc5fde");
    expect(connector.declarationHash(LIST_ITEMS)).toBe("c881f7cd98bc5fde");
  });

  it("on the canonical form of every pack call, byte for byte", () => {
    for (const pack of DECLARED_CALL_PACKS) for (const c of pack.calls) expect(canonical(c)).toBe(connector.canonical(c));
    // A fixed body is in the hash on both sides, and its absence leaves an old declaration's hash as it was.
    expect(declarationHash({ ...LIST_ITEMS, body: {} })).toBe("c881f7cd98bc5fde");
    const withBody: Declaration = { ...PUSHLIKE, body: { "a.b": 1, c: "x" } };
    expect(declarationHash(withBody)).toBe(connector.declarationHash(withBody));
  });

  it("on which declarations are refused — both sides refuse, and both accept the control", () => {
    const cases: Array<[string, Declaration]> = [
      ["dot segment", { ...LIST_ITEMS, path: "/../x", params: [] }],
      ["percent", { ...LIST_ITEMS, path: "/%2e%2e/x", params: [] }],
      ["empty segment", { ...LIST_ITEMS, path: "/a//b", params: [] }],
      ["undeclared blank", { ...LIST_ITEMS, path: "/{nope}", params: [] }],
      ["unused path input", { ...LIST_ITEMS, path: "/x" }],
      ["GET body", { method: "GET", path: "/x", query: {}, params: [{ name: "a", in: "body", type: "string", required: false, description: "" }], returns: "json" }],
      ["key on a path blank", { method: "GET", path: "/{a}", query: {}, params: [{ name: "a", in: "path", type: "string", required: true, description: "", key: "b" }], returns: "json" }],
      ["fixed and blank", { method: "GET", path: "/x", query: { q: "1" }, params: [{ name: "a", in: "query", type: "string", required: false, description: "", key: "q" }], returns: "json" }],
      ["GET fixed body", { method: "GET", path: "/x", query: {}, params: [], returns: "json", body: { a: "1" } }],
      ["body inside body", { ...PUSHLIKE, params: [bodyBlank("a", "x"), bodyBlank("b", "x.y")] }],
      ["array and object", { ...PUSHLIKE, params: [bodyBlank("a", "x[0]"), bodyBlank("b", "x.y")] }],
      ["array gap", { ...PUSHLIKE, params: [bodyBlank("a", "x[1]")] }],
      ["prototype", { ...PUSHLIKE, params: [bodyBlank("a", "__proto__.y")] }],
      ["body fixed and blank", { ...PUSHLIKE, body: { x: "1" }, params: [bodyBlank("a", "x")] }],
      ["bracket in a query key", { method: "GET", path: "/x", query: {}, params: [{ name: "a", in: "query", type: "string", required: false, description: "", key: "a[0]" }], returns: "json" }],
    ];
    for (const [label, d] of cases) {
      expect(declarationProblem(d), label).not.toBeNull();
      expect(() => connector.checkDeclaration(d), label).toThrow();
    }
    expect(declarationProblem(LIST_ITEMS)).toBeNull();
    const nested: Declaration = { ...PUSHLIKE, body: { "[0].old": "0" }, params: [bodyBlank("a", "[0].name"), bodyBlank("b", "[0].at")] };
    expect(declarationProblem(nested)).toBeNull();
    expect(() => connector.checkDeclaration(nested)).not.toThrow();
    expect(() => connector.checkDeclaration(LIST_ITEMS)).not.toThrow();
  });
});

describe("every pack call", () => {
  it("passes the connector's rules and builds with sample values, reads as a read and writes as a write", () => {
    expect(DECLARED_CALL_PACKS.length).toBeGreaterThan(0);
    for (const pack of DECLARED_CALL_PACKS) {
      for (const c of pack.calls) {
        expect(declarationProblem(c), `${pack.key}/${c.name}`).toBeNull();
        expect(() => connector.checkDeclaration(c), `${pack.key}/${c.name}`).not.toThrow();
        const values = Object.fromEntries(c.params.filter((p) => p.required).map((p) => [p.name, p.type === "number" ? 1 : p.type === "boolean" ? true : "sample"]));
        const built = connector.buildDeclaredCall(c, values);
        expect(built.writes, `${pack.key}/${c.name}`).toBe(c.method !== "GET");
        expect(built.props.url.url.startsWith("/sample/_apis/")).toBe(true);
      }
    }
  });
});

describe("the Azure Repos pack, as sent", () => {
  const pack = DECLARED_CALL_PACKS.find((p) => p.key === "azure-repos")!;
  const call = (name: string) => pack.calls.find((c) => c.name === name)!;

  it("creating a branch sends the refs list Azure expects, from a commit that did not exist as that ref", () => {
    const b = connector.buildDeclaredCall(call("create_branch"), { project: "P", repository: "R", new_branch: "refs/heads/x", from_commit: "abc" });
    expect(b.props.url.url).toBe("/P/_apis/git/repositories/R/refs?api-version=7.1");
    expect(b.props.body.data).toEqual([{ oldObjectId: "0".repeat(40), name: "refs/heads/x", newObjectId: "abc" }]);
  });

  it("a commit is one push: the branch's current commit, one change of the declared kind, raw text", () => {
    const v = { project: "P", repository: "R", branch: "refs/heads/x", branch_commit: "abc", message: "m", file_path: "/a.md", content: "hi" };
    const add = connector.buildDeclaredCall(call("commit_new_file"), v).props.body.data;
    expect(add).toEqual({
      commits: [{ changes: [{ changeType: "add", newContent: { contentType: "rawtext", content: "hi" }, item: { path: "/a.md" } }], comment: "m" }],
      refUpdates: [{ name: "refs/heads/x", oldObjectId: "abc" }],
    });
    expect(connector.buildDeclaredCall(call("commit_file_change"), v).props.body.data.commits[0].changes[0].changeType).toBe("edit");
  });

  it("nothing in the pack deletes or merges", () => {
    const changes = pack.calls.flatMap((c) => Object.entries(c.body ?? {})).filter(([k]) => k.endsWith("changeType")).map(([, v]) => v);
    expect(changes.sort()).toEqual(["add", "edit"]);
    expect(pack.calls.some((c) => /complete|merge|delete/i.test(c.name))).toBe(false);
  });
});
