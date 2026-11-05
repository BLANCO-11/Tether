/**
 * Every migration on disk is in the journal, and every journal entry has a file.
 * Phase 1 task 1.8 · I-142.
 *
 * ── THE DEFECT THIS EXISTS FOR, AND IT SHIPPED ──────────────────────────────
 *
 * `0031_generation_llm.sql` was committed without a `meta/_journal.json` entry,
 * and the journal is the only thing `db:migrate` reads. Measured when it was
 * found: **33 `.sql` files, 31 journal entries, 31 applied rows.** So the
 * migration had never run anywhere, and a fresh deployment would come up with no
 * `generation_llm` table — breaking the generation half of `/ai-provider`, a
 * feature that had been shipped and demonstrated. Every existing deployment
 * already had the table (created out-of-band), which is exactly why nobody hit
 * it.
 *
 * ⚠ **A migration file sitting in `drizzle/` beside thirty-two others is the most
 * convincing possible evidence that it runs.** `ls` positively agrees with the
 * wrong answer. That is Redis's healthy container (GAPS §6.4) and I-120's
 * call-site-less detector in a third shape, and the only thing that catches it is
 * a check that reads both sides and compares.
 *
 * ── WHY BOTH DIRECTIONS ─────────────────────────────────────────────────────
 *
 * A file with no entry never runs — that is I-142. An entry with no file is the
 * opposite failure and is worse on arrival: `db:migrate` throws mid-run, on a
 * deployment, with some migrations applied and some not. Neither direction is
 * hypothetical enough to leave out, and asserting only equal COUNTS would pass on
 * one of each.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIZZLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

async function read() {
  const files = (await readdir(DRIZZLE))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
  ) as Journal;
  return { files, journal };
}

describe("the migration journal and the migration files agree (I-142)", () => {
  it("has no .sql file that the migrator would never see", async () => {
    const { files, journal } = await read();
    // The control: a real directory with a real journal. An empty read on either
    // side would make the comparison below vacuously true (I-38).
    expect(files.length).toBeGreaterThan(30);
    expect(journal.entries.length).toBeGreaterThan(30);

    const tags = new Set(journal.entries.map((e) => e.tag));
    expect(files.filter((f) => !tags.has(f))).toEqual([]);
  });

  it("has no journal entry pointing at a file that does not exist", async () => {
    const { files, journal } = await read();
    const present = new Set(files);
    expect(journal.entries.filter((e) => !present.has(e.tag)).map((e) => e.tag)).toEqual([]);
  });

  it("numbers entries consecutively from zero, so ordering is unambiguous", async () => {
    const { journal } = await read();
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs).toEqual(idxs.map((_, i) => i));
  });

  /**
   * ⚠ The file's numeric prefix must match its journal `idx`.
   *
   * Not pedantry: while I-142 was open, `db:generate` produced a file it wanted
   * to call `0031_…` when `0031_generation_llm.sql` already existed, because the
   * journal said 31 was free. Two files claiming one number, one of them invisible
   * to the migrator, is how the whole thing stayed hidden — a human reading `ls`
   * sees a plausible sequence.
   */
  it("agrees with each file's numeric prefix", async () => {
    const { journal } = await read();
    const mismatched = journal.entries.filter(
      (e) => e.tag.slice(0, 4) !== String(e.idx).padStart(4, "0"),
    );
    expect(mismatched.map((e) => `${e.tag} is idx ${e.idx}`)).toEqual([]);
  });
});
