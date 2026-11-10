/**
 * The SMTP mail credential has exactly ONE reader.
 * email-send-tool · SC-004 · plan.md Decision 2
 *
 * ── Why this is asserted by reading the source tree ──────────────────────────
 *
 * A second place that reads `SMTP_PASS` would work
 * perfectly, pass every other test in this repo, and report nothing. That is the
 * one-reader-per-secret shape (D-42) and the reason
 * `revision-author.test.ts` reads the tree for its own one-minter rule: some
 * properties are about the absence of code, and no runtime assertion can see an
 * absence.
 *
 * What a second read site actually costs:
 *
 *  - a second place a credential can be logged or echoed into an error detail,
 *  - a second place to remember during a rotation,
 *  - and the loss of the one-file guarantee that makes moving off `.env` to Key
 *    Vault cheap. The `.env` sourcing is a deliberate, temporary deviation from
 *    `FOUNDRY_SECRET_SOURCE`; it stays cheap to undo only while there is one
 *    place to change.
 *
 * ── ⚠ The walk is rooted at `src/`, and that is load-bearing ────────────────
 *
 * Exactly as `revision-author.test.ts` does it (`path.resolve(import.meta.dirname,
 * "..")`). Since the 2026-08-18 pull, `build` runs `tsconfig.build.json`, which
 * keeps `*.test.ts` out of `dist/` but still emits every non-test module — so a
 * walk rooted at the package would find `dist/services/mail.service.js` and report
 * a phantom second read site on any machine that has run `pnpm build`. That
 * tsconfig's own docblock records the twin of this bug: grep-the-tree suites
 * matching their own compiled copies.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..");

/** The one module allowed to read the credential, relative to `src/`. */
const THE_READER = "services/mail.service.ts";

/** This file names the variables in prose, so it must not count as a read site. */
const THIS_FILE = "services/mail-secret-single-reader.test.ts";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = tsFilesUnder(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

describe("SC-004 — one reader for the SMTP mail secret", () => {
  it("only mail.service.ts reads `config.mail.pass`", () => {
    const readers = files
      .filter((f) => f.rel !== THIS_FILE)
      .filter((f) => /config\.mail\.pass/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(readers).toEqual([THE_READER]);
  });

  it("only config/index.ts reads `SMTP_PASS` from the environment", () => {
    // The env var itself has one read site too, and it is the config module —
    // every other consumer goes through `config.mail`. A direct `process.env`
    // read elsewhere would bypass the `missing[]` accounting that FR-008's
    // one-refusal-names-everything behaviour depends on.
    //
    // ⚠ Matches the READ EXPRESSION (`process.env.SMTP_PASS`), not the name.
    // `mail.service.test.ts` legitimately names the variable in a `missing[]`
    // fixture, and a suite asserting on the wording of a refusal is not a second
    // place the credential can leak from. Matching the bare name would have made
    // this test fail on the test that proves FR-008 works.
    const readers = files
      .filter((f) => f.rel !== THIS_FILE)
      .filter((f) => /process\.env\.SMTP_PASS|process\.env\[["']SMTP_PASS/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(readers).toEqual(["config/index.ts"]);
  });

  it("the credential is not interpolated into a log or thrown message anywhere", () => {
    // A narrower, cheaper version of the same worry: even inside the one allowed
    // reader, the secret must only ever be the transport's auth field.
    const reader = files.find((f) => f.rel === THE_READER);
    expect(reader).toBeDefined();

    // ⚠ Comment lines are stripped first. The module's own docblock explains that
    // it is the one read site, in backticks — matching that as a leak would make
    // documenting the rule break the rule.
    const codeLines = reader!.text
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

    const offending = codeLines
      .filter((line) => /config\.mail\.pass/.test(line))
      .filter((line) => /console\.|logger|throw |Error\(|JSON\.stringify|\$\{/.test(line));
    expect(offending).toEqual([]);

    // The positive control: the read site itself is still there, on a code line,
    // so this is an assertion about how it is used rather than an empty match.
    expect(codeLines.filter((l) => /config\.mail\.pass/.test(l))).toHaveLength(1);
  });

  it("the positive control: the walk actually found the source tree", () => {
    // I-38 — without this, every assertion above would pass just as well against
    // an empty file list, which is exactly how a broken walk reads as compliance.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === THE_READER)).toBe(true);
    expect(files.some((f) => f.rel === "config/index.ts")).toBe(true);
  });

  it("the walk never leaves src/, so a compiled dist/ copy cannot be counted", () => {
    // ⚠ See the module docblock. This is the assertion that keeps the suite from
    // going red on any machine that has run `pnpm build`.
    expect(files.every((f) => !f.rel.startsWith("../"))).toBe(true);
    expect(files.every((f) => !f.rel.includes("dist/"))).toBe(true);
    expect(SRC.endsWith(`${path.sep}src`)).toBe(true);
  });
});
