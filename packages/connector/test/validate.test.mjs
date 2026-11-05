import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConnection } from "../src/validate.mjs";

const seen = [];
const piece = (auth) => ({ auth });
const check = (type, extra = {}) => ({ type, validate: async ({ auth }) => (seen.push(auth), auth === "good" || auth?.key === "good" || auth?.password === "good" ? { valid: true } : { valid: false, error: "bad key" }), ...extra });

test("the piece's own check gets the value in the framework's shape for each auth kind", async () => {
  seen.length = 0;
  assert.deepEqual(await validateConnection(piece(check("SECRET_TEXT")), { auth: { secret_text: "good" } }), { checked: true, valid: true, error: null });
  assert.deepEqual(await validateConnection(piece(check("CUSTOM_AUTH")), { auth: { key: "good", region: "x" } }), { checked: true, valid: true, error: null });
  assert.deepEqual(await validateConnection(piece(check("BASIC_AUTH")), { auth: { username: "u", password: "good" } }), { checked: true, valid: true, error: null });
  assert.deepEqual(seen, ["good", { key: "good", region: "x" }, { username: "u", password: "good" }]);
});

test("a rejected connection is reported with the service's own reason; a throw is a failed check, not a crash", async () => {
  assert.deepEqual(await validateConnection(piece(check("SECRET_TEXT")), { auth: { secret_text: "nope" } }), { checked: true, valid: false, error: "bad key" });
  const throws = { type: "SECRET_TEXT", validate: async () => { throw new Error("401 from the API"); } };
  assert.deepEqual(await validateConnection(piece(throws), { auth: { secret_text: "x" } }), { checked: true, valid: false, error: "401 from the API" });
});

test("a piece with no check answers checked:false — never valid", async () => {
  const r = await validateConnection(piece({ type: "CUSTOM_AUTH", props: {} }), { auth: { a: 1 } });
  assert.deepEqual(r, { checked: false });
  assert.notEqual(r.valid, true);
});

test("the auth kind is chosen by the caller among the piece's own, and an unknown one is refused", async () => {
  const two = piece([check("SECRET_TEXT"), check("CUSTOM_AUTH")]);
  assert.equal((await validateConnection(two, { authType: "CUSTOM_AUTH", auth: { key: "good" } })).valid, true);
  await assert.rejects(validateConnection(two, { authType: "BASIC_AUTH", auth: {} }), (e) => e.kind === "validation");
});

test("a sign-in is checked by asking the service who it belongs to; ⚠ an EMPTY answer is a refusal, not a pass", async () => {
  const oauth = (answer) => piece({ type: "OAUTH2", getConnectionIdentifier: async ({ auth }) => (auth.access_token === "live" ? answer : undefined) });
  assert.deepEqual(await validateConnection(oauth("octocat"), { auth: { access_token: "live" } }), { checked: true, valid: true, error: null, identity: "octocat" });
  // GitHub's own identifier catches a 401 and returns nothing — that must read as refused.
  const dead = await validateConnection(oauth("octocat"), { auth: { access_token: "revoked" } });
  assert.equal(dead.checked, true);
  assert.equal(dead.valid, false);
  assert.match(dead.error, /did not say who/);
});

test("a sign-in is handed to the piece WITHOUT a refresh token or token address, whatever was sent", async () => {
  let got;
  const p = piece({ type: "OAUTH2", getConnectionIdentifier: async ({ auth }) => ((got = auth), "me") });
  await validateConnection(p, { auth: { access_token: "a", refresh_token: "r", token_url: "https://t", props: { x: 1 }, data: { y: 2 } } });
  assert.equal(got.type, "OAUTH2");
  assert.equal(got.access_token, "a");
  assert.deepEqual(got.props, { x: 1 });
  assert.equal(JSON.stringify(got).includes('"r"'), false);
  assert.equal("token_url" in got, false);
});
