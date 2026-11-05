/**
 * The datasource-name rule, and the suggestion the form offers for it.
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * 2026-09-17: a real onboarding attempt used the database's own name,
 * `ML-ZERO-DB`. The server refused it (a step ref is `<datasource>.<query>`,
 * so the name must be a plain identifier) and `/data-sources/new` rendered that
 * refusal as the literal words "Couldn't connect" — a message about the network
 * for a problem with a name. It cost a morning; the fix was one character.
 *
 * These tests pin the two halves of the remedy: the rule has ONE definition
 * that both sides import, and the suggestion is always itself legal.
 */
import { describe, expect, it } from "vitest";
import { DATASOURCE_NAME_RE, suggestDatasourceName } from "./index.js";

describe("a datasource name is a plain identifier", () => {
  it("refuses the shapes a person actually types", () => {
    // Every one of these is a real database name from the incident.
    for (const n of ["ML-ZERO-DB", "ml-zero", "ta-test", "ml-zero-interview", "ML ZERO", "9lives"]) {
      expect(DATASOURCE_NAME_RE.test(n), `${n} should be refused`).toBe(false);
    }
  });

  it("accepts identifiers", () => {
    for (const n of ["ML_ZERO_DB", "ml_zero", "mlzero", "_private", "db2"]) {
      expect(DATASOURCE_NAME_RE.test(n), `${n} should be accepted`).toBe(true);
    }
  });

  it("⚠ still refuses a DOT, which is the one that breaks at execution", () => {
    // The structural hazard, and the reason the rule exists at all: a name with
    // a dot makes every query on the datasource unresolvable AFTER approval,
    // mid-run. If a future change widens this regex, this must keep failing.
    expect(DATASOURCE_NAME_RE.test("ml.zero")).toBe(false);
  });
});

describe("the suggestion the form offers", () => {
  it("turns the reported name into the one that worked", () => {
    // `ML_ZERO_DB` is what the user typed by hand before this existed.
    expect(suggestDatasourceName("ML-ZERO-DB")).toBe("ML_ZERO_DB");
  });

  it("is ALWAYS legal itself, or it is not offered", () => {
    // A button that fills the box with another refusal is worse than no button.
    for (const raw of ["ML-ZERO-DB", "ml zero", "9lives", "a..b", "  spaced  name  ", "café"]) {
      const s = suggestDatasourceName(raw);
      if (s !== null) expect(DATASOURCE_NAME_RE.test(s), `${raw} → ${s}`).toBe(true);
    }
  });

  it("offers nothing when there is nothing to offer", () => {
    // Rather than a button that types `_` into the field.
    expect(suggestDatasourceName("")).toBeNull();
    expect(suggestDatasourceName("---")).toBeNull();
  });

  it("offers nothing when the name is already legal", () => {
    // The caller renders the suggestion only beside an error, but a suggestion
    // identical to the current value would read as a no-op button.
    expect(suggestDatasourceName("ML_ZERO_DB")).toBeNull();
  });

  it("prefixes a leading digit rather than dropping it", () => {
    // Dropping it changes which database the name refers to.
    expect(suggestDatasourceName("9lives")).toBe("_9lives");
  });
});
