import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { reconcileMigrations, type MigrationDb } from "./migrate-reconcile.js";

/** A migrations folder drizzle can read: `meta/_journal.json` plus one `<tag>.sql` per entry. */
function folder(files: Array<{ tag: string; when: number; sql: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-"));
  mkdirSync(path.join(dir, "meta"));
  writeFileSync(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: files.map((f, idx) => ({ idx, version: "7", when: f.when, tag: f.tag, breakpoints: true })) }),
  );
  for (const f of files) writeFileSync(path.join(dir, `${f.tag}.sql`), f.sql);
  return dir;
}
const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");

let pg: PGlite;
let db: MigrationDb;
beforeEach(async () => {
  pg = new PGlite();
  db = {
    exec: async (sql) => { await pg.exec(sql); },
    rows: async <T,>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows,
  };
  await pg.exec(`create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
                 create table flows (id int primary key);`);
});
const recorded = async () => (await db.rows<{ hash: string }>(`select hash from drizzle.__drizzle_migrations`)).map((r) => r.hash);
const columns = async (t: string) =>
  (await db.rows<{ column_name: string }>(`select column_name from information_schema.columns where table_name = $1`, [t])).map((r) => r.column_name);

describe("reconcileMigrations — a migration older than the newest recorded row is still applied", () => {
  it("applies the migrations another branch's same-timestamp rows hid from drizzle, and records them (the prod VM)", async () => {
    const ours = [
      { tag: "0074_flow_incomplete_model", when: 1790400000000, sql: `ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "incomplete_model" jsonb;` },
      { tag: "0080_datasource_column_tags", when: 1791000000000, sql: `ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "tags" jsonb;` },
    ];
    // The other branch's 0076 ran first (a later created_at than our 0074, a different hash); then drizzle applied only our 0080.
    await db.rows(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('other-branch-0076', 1790600000000)`);
    await db.exec(ours[1].sql);
    await db.rows(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, 1791000000000)`, [hash(ours[1].sql)]);

    const r = await reconcileMigrations(db, folder(ours));
    expect(r.applied.map((a) => a.tag)).toEqual(["0074_flow_incomplete_model"]);
    expect(await columns("flows")).toContain("incomplete_model");
    expect(await recorded()).toContain(hash(ours[0].sql));
    // CONTROL: run again, nothing left to apply.
    expect((await reconcileMigrations(db, folder(ours))).applied).toEqual([]);
  });

  it("skips a drizzle-split statement whose object already exists and still runs the rest", async () => {
    const sql = `CREATE TABLE "pins" (id int);\n--> statement-breakpoint\nALTER TABLE "flows" ADD COLUMN "note" text;`;
    await db.exec(`create table pins (id int)`); // made by another branch
    const r = await reconcileMigrations(db, folder([{ tag: "0090_pins", when: 1, sql }]));
    expect(r.applied).toEqual([{ tag: "0090_pins", skippedStatements: 1 }]);
    expect(await columns("flows")).toContain("note");
  });

  it("refuses — rolled back and named — when it cannot tell what already exists, or any other error", async () => {
    await db.exec(`create table pins (id int)`);
    const oneChunk = `CREATE TABLE "pins" (id int); ALTER TABLE "flows" ADD COLUMN "note" text;`;
    await expect(reconcileMigrations(db, folder([{ tag: "0091_one_chunk", when: 1, sql: oneChunk }]))).rejects.toThrow(/0091_one_chunk.*unknowable/);
    const broken = `ALTER TABLE "nope" ADD COLUMN "x" text;`;
    await expect(reconcileMigrations(db, folder([{ tag: "0092_broken", when: 1, sql: broken }]))).rejects.toThrow(/0092_broken/);
    expect(await columns("flows")).not.toContain("note");
    expect(await recorded()).toEqual([]);
  });
});
