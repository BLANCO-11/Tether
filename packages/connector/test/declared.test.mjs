import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeclaredCall, checkDeclaration, declarationHash, declaredOutput } from "../src/declared.mjs";

/**
 * Declared API calls — the enforcement. ⚠ Every escape measured in phase 0 (`..`, `%2e%2e`) and every way a value could
 * widen the call is refused here, and each refusal has its control: the same call with an ordinary value is built.
 */
const LIST_ITEMS = {
  method: "GET",
  path: "/{project}/_apis/git/repositories/{repo}/items",
  query: { "api-version": "7.1" },
  params: [
    { name: "project", in: "path", type: "string", required: true },
    { name: "repo", in: "path", type: "string", required: true },
    { name: "path", in: "query", type: "string", required: false },
  ],
  returns: "json",
};

test("CONTROL: an ordinary call is built under the template, a GET is a read", () => {
  const b = buildDeclaredCall(LIST_ITEMS, { project: "Platform Team", repo: "api", path: "/src" });
  assert.equal(b.writes, false);
  assert.equal(b.props.method, "GET");
  assert.equal(b.props.url.url, "/Platform%20Team/_apis/git/repositories/api/items?api-version=7.1&path=%2Fsrc");
  assert.equal(b.props.body_type, "none");
  assert.equal(b.props.followRedirects, false);
  assert.equal(b.props.failsafe, false);
});

test("⚠ a value cannot climb out: . and .. are refused, and so is any separator — the service may decode it", () => {
  for (const v of ["..", "."]) assert.throws(() => buildDeclaredCall(LIST_ITEMS, { project: v, repo: "api" }), /may not be \. or \.\./);
  // Measured live: Azure DevOps decoded "..%2Fother-org" and left the organisation, so encoding a / is not enough.
  for (const v of ["../other-org", "a/b", "a\\b", "%2e%2e", "a%2Fb", "line\nbreak"]) {
    assert.throws(() => buildDeclaredCall(LIST_ITEMS, { project: v, repo: "api" }), /one part of the address/, v);
  }
  // CONTROL: ordinary names, spaces and dots inside a name are fine, and are encoded.
  const b = buildDeclaredCall(LIST_ITEMS, { project: "Platform Team", repo: "my.repo?x#y" });
  assert.equal(b.props.url.url, "/Platform%20Team/_apis/git/repositories/my.repo%3Fx%23y/items?api-version=7.1");
});

test("⚠ a template cannot climb out either: dot segments, % and odd characters are refused", () => {
  const t = (path) => () => checkDeclaration({ ...LIST_ITEMS, path, params: [] });
  assert.throws(t("/../other/_apis"), /\. or \.\. segments/);
  assert.throws(t("/./x"), /\. or \.\. segments/);
  assert.throws(t("/%2e%2e/other"), /characters a template may not use/);
  assert.throws(t("/a?b=c"), /characters a template may not use/);
  assert.throws(t("/a//b"), /empty segment/);
  assert.throws(t("https://evil.example/x"), /must start with \//);
  assert.doesNotThrow(t("/_apis/projects")); // CONTROL
});

test("only the declared inputs, each of its type, and the required ones present", () => {
  assert.throws(() => buildDeclaredCall(LIST_ITEMS, { project: "p" }), /missing: repo/);
  assert.throws(() => buildDeclaredCall(LIST_ITEMS, { project: "p", repo: "r", url: "https://x" }), /not inputs of this call: url/);
  const n = { method: "GET", path: "/x", params: [{ name: "top", in: "query", type: "number", required: true }] };
  assert.throws(() => buildDeclaredCall(n, { top: "ten" }), /must be a number/);
  assert.equal(buildDeclaredCall(n, { top: "10" }).props.url.url, "/x?top=10");
});

test("DELETE is never declared; a GET has no body; a blank must be used where it says", () => {
  assert.throws(() => checkDeclaration({ ...LIST_ITEMS, method: "DELETE" }), /DELETE is never declared/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", params: [{ name: "a", in: "body", type: "string" }] }), /a GET has no body/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", params: [{ name: "a", in: "path", type: "string" }] }), /does not appear in the path/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/{a}", params: [] }), /not declared as a path input/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", query: { "api-version": "7.1" }, params: [{ name: "api-version", in: "query", type: "string" }] }), /lower_snake_case/);
});

test("a write carries its body as JSON and says it changes data", () => {
  const create = {
    method: "POST",
    path: "/{project}/_apis/git/repositories/{repo}/pullrequests",
    query: { "api-version": "7.1" },
    params: [
      { name: "project", in: "path", type: "string", required: true },
      { name: "repo", in: "path", type: "string", required: true },
      { name: "title", in: "body", type: "string", required: true },
      { name: "is_draft", in: "body", type: "boolean", required: false },
    ],
  };
  const b = buildDeclaredCall(create, { project: "p", repo: "r", title: "Fix", is_draft: "true" });
  assert.equal(b.writes, true);
  assert.equal(b.props.body_type, "json");
  assert.deepEqual(b.props.body, { data: { title: "Fix", is_draft: true } });
  assert.equal(b.props.headers["Content-Type"], "application/json");
});

test("the hash covers what the call does, not how it is worded — and it is the server's (shared fixture)", () => {
  const same = { ...LIST_ITEMS, displayName: "Anything", description: "Reworded", query: { "api-version": "7.1" } };
  assert.equal(declarationHash(same), declarationHash(LIST_ITEMS));
  assert.notEqual(declarationHash({ ...LIST_ITEMS, method: "POST" }), declarationHash(LIST_ITEMS));
  assert.notEqual(declarationHash({ ...LIST_ITEMS, query: { "api-version": "7.0" } }), declarationHash(LIST_ITEMS));
  // ⚠ The same literal is asserted in packages/server/src/services/declared-call.service.test.ts. If either side's
  // canonical form drifts, one of the two tests goes red.
  assert.equal(declarationHash(LIST_ITEMS), "c881f7cd98bc5fde");
});

test("a blank is sent under the service's own name (key); a path blank has none, and two may not collide", () => {
  const d = { method: "GET", path: "/x", params: [{ name: "top", in: "query", type: "number", key: "$top" }, { name: "status", in: "query", type: "string", key: "searchCriteria.status" }] };
  assert.equal(buildDeclaredCall(d, { top: 5, status: "active" }).props.url.url, "/x?%24top=5&searchCriteria.status=active");
  assert.throws(() => checkDeclaration({ method: "GET", path: "/{a}", params: [{ name: "a", in: "path", type: "string", key: "b" }] }), /a key is the service's name/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", params: [{ name: "a", in: "query", type: "string", key: "q" }, { name: "b", in: "query", type: "string", key: "q" }] }), /two blanks are sent as query "q"/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", query: { q: "1" }, params: [{ name: "a", in: "query", type: "string", key: "q" }] }), /both fixed and a blank/);
  assert.notEqual(declarationHash(d), declarationHash({ ...d, params: [{ ...d.params[0], key: "top" }, d.params[1]] }));
});

test("cookies the service sets are not handed back", () => {
  const out = declaredOutput({ status: 200, headers: { "set-cookie": "s=1", "x-ms-continuationtoken": "abc" }, body: [] });
  assert.deepEqual(out.headers, { "x-ms-continuationtoken": "abc" });
});

const PUSH = {
  method: "POST",
  path: "/{project}/_apis/git/repositories/{repo}/pushes",
  query: { "api-version": "7.1" },
  body: { "commits[0].changes[0].changeType": "add", "commits[0].changes[0].newContent.contentType": "rawtext" },
  params: [
    { name: "project", in: "path", type: "string", required: true },
    { name: "repo", in: "path", type: "string", required: true },
    { name: "branch", in: "body", key: "refUpdates[0].name", type: "string", required: true },
    { name: "old", in: "body", key: "refUpdates[0].oldObjectId", type: "string", required: true },
    { name: "message", in: "body", key: "commits[0].comment", type: "string", required: true },
    { name: "file", in: "body", key: "commits[0].changes[0].item.path", type: "string", required: true },
    { name: "content", in: "body", key: "commits[0].changes[0].newContent.content", type: "string", required: true },
    { name: "note", in: "body", key: "commits[1].comment", type: "string", required: false },
  ],
  returns: "json",
};

test("a body place nests: dots are fields, [n] is a list position, and fixed body values sit beside the blanks", () => {
  const b = buildDeclaredCall(PUSH, { project: "p", repo: "r", branch: "refs/heads/x", old: "abc", message: "m", file: "/a.md", content: "hi" });
  assert.deepEqual(b.props.body.data, {
    commits: [{ changes: [{ changeType: "add", newContent: { contentType: "rawtext", content: "hi" }, item: { path: "/a.md" } }], comment: "m" }],
    refUpdates: [{ name: "refs/heads/x", oldObjectId: "abc" }],
  });
  assert.equal(b.props.body_type, "json");
  assert.equal(b.writes, true);
});

test("a body may be a top-level list: [0].name", () => {
  const refs = {
    method: "POST",
    path: "/refs",
    query: {},
    body: { "[0].oldObjectId": "0".repeat(40) },
    params: [
      { name: "name", in: "body", key: "[0].name", type: "string", required: true },
      { name: "at", in: "body", key: "[0].newObjectId", type: "string", required: true },
    ],
    returns: "json",
  };
  assert.deepEqual(buildDeclaredCall(refs, { name: "refs/heads/x", at: "abc" }).props.body.data, [{ oldObjectId: "0".repeat(40), name: "refs/heads/x", newObjectId: "abc" }]);
});

test("⚠ a body shape that cannot be one object is refused, and so is a place that could reach a prototype", () => {
  const with1 = (extra) => ({ ...PUSH, params: [...PUSH.params.slice(0, 2), ...extra] });
  const one = (key) => ({ name: "x", in: "body", key, type: "string", required: false });
  assert.throws(() => checkDeclaration(with1([one("a"), { ...one("a.b"), name: "y" }])), /inside another/);
  assert.throws(() => checkDeclaration(with1([one("a[0]"), { ...one("a.b"), name: "y" }])), /both an array and an object/);
  assert.throws(() => checkDeclaration(with1([one("a[1]")])), /skips a position/);
  assert.throws(() => checkDeclaration(with1([one("__proto__.x")])), /body field/);
  assert.throws(() => checkDeclaration(with1([one("a..b")])), /body field/);
  assert.throws(() => checkDeclaration({ ...PUSH, body: { "commits[0].comment": "fixed" } }), /both fixed and a blank/);
  assert.throws(() => checkDeclaration({ method: "GET", path: "/x", query: {}, params: [], body: { a: "1" } }), /GET has no body/);
  assert.doesNotThrow(() => checkDeclaration(PUSH)); // CONTROL
});

test("⚠ an optional blank left out may not leave a hole in a list", () => {
  const holey = { ...PUSH, params: PUSH.params.map((p) => (p.name === "note" ? { ...p, key: "commits[1].comment" } : p)) };
  const full = { project: "p", repo: "r", branch: "b", old: "o", message: "m", file: "/f", content: "c" };
  assert.doesNotThrow(() => buildDeclaredCall(holey, full)); // commits[1] simply absent: no hole
  const gap = { ...PUSH, body: {}, params: [...PUSH.params.slice(0, 2), { name: "a", in: "body", key: "x[0]", type: "string", required: false }, { name: "b", in: "body", key: "x[1]", type: "string", required: true }] };
  assert.throws(() => buildDeclaredCall(gap, { project: "p", repo: "r", b: "only the second" }), /gap/);
});

test("the fixed body is in the hash; a declaration with none keeps the hash it always had", () => {
  assert.equal(declarationHash({ ...LIST_ITEMS, body: {} }), declarationHash(LIST_ITEMS));
  assert.notEqual(declarationHash(PUSH), declarationHash({ ...PUSH, body: { ...PUSH.body, "commits[0].changes[0].changeType": "edit" } }));
});
