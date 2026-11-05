import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKERS = fileURLToPath(new URL("../src/workers.mjs", import.meta.url));

// A piece whose one action counts calls in ctx.store.
function fixturePiece(root) {
  const pkg = join(root, "node_modules", "@activepieces", "piece-counter");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "piece-host", private: true }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@activepieces/piece-counter", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), `
    const count = { name: "count", displayName: "Count", props: {}, requireAuth: false,
      run: async (ctx) => { const n = ((await ctx.store.get("n")) ?? 0) + 1; await ctx.store.put("n", n); return { n }; } };
    exports.counter = { displayName: "Counter", auth: undefined, actions: () => ({ count }), getAction: (a) => ({ count })[a] };
  `);
}

// One connector process: configure the store, run the action once, print the answer, exit.
const once = (dir, storeDir, workspaceId, connectionId = "c1") =>
  JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { runInWorker, configureStore, storeKey } from ${JSON.stringify(WORKERS)};
      configureStore(${JSON.stringify(storeDir)});
      const r = await runInWorker({ op: "run", dir: ${JSON.stringify(dir)}, name: "@activepieces/piece-counter", req: { piece: "@activepieces/piece-counter", action: "count", props: {}, mode: "execute" } },
        { proxyUrl: null, timeoutMs: 20000, storeKey: storeKey(${JSON.stringify(workspaceId)}, "@activepieces/piece-counter", ${JSON.stringify(connectionId)}) });
      console.log(JSON.stringify(r.output));
    `], { encoding: "utf8" }),
  );

test("a piece's store survives the connector restarting, and is separate per workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-store-"));
  fixturePiece(root);
  const store = join(root, "store");
  assert.deepEqual(once(root, store, "ws-a"), { n: 1 });
  assert.deepEqual(once(root, store, "ws-a"), { n: 2 }, "a NEW process read what the last one stored");
  assert.deepEqual(once(root, store, "ws-b"), { n: 1 }, "another workspace's store is its own");
  assert.equal(readdirSync(store).length, 2);
  assert.equal(statSync(store).mode & 0o777, 0o700);
});

// ⚠ plugins 8.2: the store was keyed by workspace + piece, so a person's own connection shared its piece memory with
// every other person's and with the workspace's. It is per connection now.
test("a store is separate per CONNECTION in one workspace, and forgetting one removes it from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-store-"));
  fixturePiece(root);
  const store = join(root, "store");
  assert.deepEqual(once(root, store, "ws-a", "alice-own"), { n: 1 });
  assert.deepEqual(once(root, store, "ws-a", "alice-own"), { n: 2 });
  assert.deepEqual(once(root, store, "ws-a", "bob-own"), { n: 1 }, "another person's connection has its own memory");
  assert.deepEqual(once(root, store, "ws-a", "team"), { n: 1 }, "so does the workspace's");
  // Forget from a NEW process, where the store is on disk but not loaded.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { configureStore, forgetStore, storeKey } from ${JSON.stringify(WORKERS)};
    configureStore(${JSON.stringify(store)});
    forgetStore(storeKey("ws-a", "@activepieces/piece-counter", "alice-own"));
  `]);
  assert.equal(readdirSync(store).length, 2, "only alice's store is gone");
  assert.deepEqual(once(root, store, "ws-a", "alice-own"), { n: 1 }, "and it starts again empty");
  assert.deepEqual(once(root, store, "ws-a", "bob-own"), { n: 2 }, "bob's is untouched");
});
