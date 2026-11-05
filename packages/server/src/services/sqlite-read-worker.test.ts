/**
 * The SQLite read runs in a worker: the rows come back, a declared flag can still be recognised, a statement the
 * file cannot run is SQLite's own message, a read past the limit is stopped — and while a slow read runs, the
 * server's own thread keeps answering. That last one is the bug this exists for: a production read froze the app.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "./sqlite-driver.js";
import { readSqliteInWorker, SqliteReadTimeoutError } from "./sqlite-read-worker.js";
import { flagColumnsOf, flagResults } from "./introspect/sqlite-flags.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-worker-"));
  file = path.join(dir, "data.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN)");
  const ins = db.prepare("INSERT INTO people (name, active) VALUES (?, ?)");
  for (let i = 0; i < 2000; i++) ins.run(`p${i}`, i % 2);
  db.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readSqliteInWorker", () => {
  it("returns one result per parameter set, as plain objects", async () => {
    const r = await readSqliteInWorker({
      path: file,
      sql: "SELECT id, name, active FROM people WHERE id <= ?",
      bindings: [[2n], [0n]],
      timeoutMs: 10_000,
    });
    expect(r.results).toEqual([
      { ok: true, rows: [{ id: 1, name: "p0", active: 0 }, { id: 2, name: "p1", active: 1 }] },
      { ok: true, rows: [] },
    ]);
    expect(Object.getPrototypeOf((r.results[0] as { rows: object[] }).rows[0])).toBe(Object.prototype);
  });

  it("sends back what the flag rule needs, so a declared flag is still recognised", async () => {
    const r = await readSqliteInWorker({ path: file, sql: "SELECT name, active, id + 1 AS n FROM people LIMIT 1", bindings: [[]], timeoutMs: 10_000 });
    expect(flagResults(r.origins, flagColumnsOf(r.schema))).toEqual(["active"]);
  });

  it("a statement the file cannot run rejects with SQLite's message", async () => {
    await expect(readSqliteInWorker({ path: file, sql: "SELECT nope FROM people", bindings: [[]], timeoutMs: 10_000 })).rejects.toThrow(/no such column/);
  });

  it("refuses to write — the file is opened read-only", async () => {
    const r = await readSqliteInWorker({ path: file, sql: "DELETE FROM people", bindings: [[]], timeoutMs: 10_000 });
    expect(r.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/readonly/i) });
  });

  it("stops a read past the limit, and the main thread keeps answering while it runs", async () => {
    // A cross join big enough to run for many seconds.
    const slow = "SELECT count(*) AS c FROM people a, people b, people c";
    let ticks = 0;
    const tick = setInterval(() => ticks++, 20);
    const started = Date.now();
    await expect(readSqliteInWorker({ path: file, sql: slow, bindings: [[]], timeoutMs: 600 })).rejects.toBeInstanceOf(SqliteReadTimeoutError);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(3000);
    // ~30 ticks in 600 ms on a free thread; a blocked thread would manage none.
    expect(ticks).toBeGreaterThan(10);
  });

  it("names the limit in plain words", () => {
    expect(new SqliteReadTimeoutError(120_000).message).toMatch(/^The read took longer than 2 minutes and was stopped\./);
    expect(new SqliteReadTimeoutError(60_000).message).toMatch(/1 minute and/);
  });
});
