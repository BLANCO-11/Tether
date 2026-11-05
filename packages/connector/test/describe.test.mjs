import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAction } from "../src/describe.mjs";
import { connectionValue, Unsupported } from "../src/context.mjs";
import { installPiece, InstallError } from "../src/install.mjs";
import { runAction } from "../src/run.mjs";

const action = (over = {}) => ({
  name: "send",
  displayName: "Send",
  description: "Sends.",
  props: {
    to: { type: "SHORT_TEXT", required: true, description: "Who" },
    kind: { type: "STATIC_DROPDOWN", required: false, displayName: "Kind", options: { options: [{ value: "a" }, { value: "b" }] } },
    note: { type: "MARKDOWN" },
    count: { type: "NUMBER", required: false, defaultValue: 3 },
  },
  run: async (ctx) => ({ got: ctx.propsValue }),
  ...over,
});

test("params come out in Foundry's FLAT shape, listed values as 'One of:', display-only props dropped", () => {
  const d = describeAction(action());
  assert.deepEqual(Object.keys(d.params), ["to", "kind", "count"]);
  assert.deepEqual(d.params.to, { type: "string", required: true, description: "Who" });
  assert.match(d.params.kind.description, /One of: a, b\./);
  assert.match(d.params.count.description, /Default: 3/);
});

test("an action that does not declare READ is a write (fail closed); one that does is not", () => {
  assert.equal(describeAction(action()).writes, true);
  assert.equal(describeAction(action()).classificationDeclared, false);
  assert.equal(describeAction(action({ classification: "READ" })).writes, false);
  assert.equal(describeAction(action({ classification: "SEARCH" })).writes, false);
  assert.equal(describeAction(action({ classification: "WRITE" })).writes, true);
  const del = describeAction(action({ classification: "DESTRUCTIVE" }));
  assert.equal(del.writes, true);
  assert.equal(del.destructive, true);
  assert.equal(describeAction(action({ classification: "SOMETHING_NEW" })).writes, true);
});

test("DYNAMIC and CUSTOM props are named as unsupported", () => {
  const d = describeAction(action({ props: { x: { type: "DYNAMIC", required: true } } }));
  assert.deepEqual(d.unsupported, ['input "x" is a DYNAMIC property']);
});

test("the credential's TYPE comes from the piece, not the caller", () => {
  assert.deepEqual(connectionValue({ type: "CUSTOM_AUTH" }, { a: 1 }), { type: "CUSTOM_AUTH", props: { a: 1 } });
  assert.deepEqual(connectionValue({ type: "SECRET_TEXT" }, { secret_text: "s" }), { type: "SECRET_TEXT", secret_text: "s" });
  assert.throws(() => connectionValue({ type: "SOMETHING_NEW" }, {}), Unsupported);
});

test("install refuses a name outside the scope and a version that is not exact — before touching the network", async () => {
  await assert.rejects(installPiece("/tmp/x", { name: "left-pad", version: "1.0.0" }), InstallError);
  await assert.rejects(installPiece("/tmp/x", { name: "@activepieces/piece-x", version: "^1.0.0" }), InstallError);
  await assert.rejects(installPiece("/tmp/x", { name: "@activepieces/piece-x", version: "latest" }), InstallError);
});

const piece = (act) => ({ displayName: "P", auth: undefined, actions: () => ({ [act.name]: act }), getAction: (n) => (n === act.name ? act : undefined) });

test("capture mode does not run a write; execute mode does", async () => {
  let ran = 0;
  const p = piece(action({ run: async () => ((ran += 1), { ok: true }) }));
  const cap = await runAction(p, { piece: "p", action: "send", props: { to: "x" }, mode: "capture" });
  assert.equal(cap.captured, true);
  assert.equal(ran, 0);
  const ex = await runAction(p, { piece: "p", action: "send", props: { to: "x" }, mode: "execute" });
  assert.equal(ex.captured, false);
  assert.equal(ran, 1);
});

test("capture mode still runs a declared READ", async () => {
  let ran = 0;
  const p = piece(action({ classification: "READ", run: async () => ((ran += 1), []) }));
  const r = await runAction(p, { piece: "p", action: "send", props: { to: "x" }, mode: "capture" });
  assert.equal(r.captured, false);
  assert.equal(ran, 1);
});

test("missing required and unknown inputs are refused by name; a default fills an omitted optional", async () => {
  const p = piece(action());
  await assert.rejects(runAction(p, { piece: "p", action: "send", props: {} }), /missing: to/);
  await assert.rejects(runAction(p, { piece: "p", action: "send", props: { to: "x", tone: 1 } }), /not inputs of this action: tone/);
  const r = await runAction(p, { piece: "p", action: "send", props: { to: "x", count: "7" } });
  assert.equal(r.output.got.count, 7);
});

test("a piece asking for an unprovided context feature fails as 'unsupported', naming it", async () => {
  const p = piece(action({ run: async (ctx) => ctx.run.createWaitpoint({ type: "WEBHOOK" }) }));
  await assert.rejects(runAction(p, { piece: "p", action: "send", props: { to: "x" } }), (e) => e.kind === "unsupported" && /waiting for a person/.test(e.message));
});

import { buildContext, MAX_FILE_BYTES } from "../src/context.mjs";

test("a piece's files come back in the answer, base64, and nothing is written to disk", async () => {
  const p = { actions: () => ({ make: { ...action(), name: "make", props: {}, run: async (ctx) => ({ file: await ctx.files.write({ fileName: "../../etc/x.txt", data: Buffer.from("hello") }) }) } }) };
  const r = await runAction(p, { piece: "p", action: "make", props: {}, mode: "execute" });
  assert.equal(r.output.file, "x.txt", "the name is a base name — no path out of the answer");
  assert.deepEqual(r.files, [{ name: "x.txt", bytes: 5, base64: Buffer.from("hello").toString("base64") }]);
});

test("files over the cap fail the call by name (too_large)", async () => {
  const files = [];
  const ctx = buildContext({ files, store: {} });
  await ctx.files.write({ fileName: "a", data: Buffer.alloc(MAX_FILE_BYTES - 1) });
  await assert.rejects(ctx.files.write({ fileName: "b", data: Buffer.alloc(2) }), /pass \d+ bytes together/);
  const p = { actions: () => ({ big: { ...action(), name: "big", props: {}, run: async (c) => c.files.write({ fileName: "z", data: Buffer.alloc(MAX_FILE_BYTES + 1) }) } }) };
  await assert.rejects(runAction(p, { piece: "p", action: "big", props: {}, mode: "execute" }), (e) => e.kind === "too_large");
});
