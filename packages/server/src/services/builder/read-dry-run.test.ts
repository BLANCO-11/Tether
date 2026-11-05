/**
 * Read dry-run — Strategy B Phase 3.
 */
import { afterEach, describe, expect, it } from "vitest";
import { dryRunRead, previewCompiledReads, previewLines, withPreviewLimit } from "./read-dry-run.js";

afterEach(() => {
  delete process.env.BUILDER_INTENT_IR;
});

describe("read-dry-run", () => {
  it("appends LIMIT when absent", () => {
    expect(withPreviewLimit("SELECT a FROM t")).toMatch(/LIMIT 5$/i);
  });

  it("does not duplicate LIMIT", () => {
    expect(withPreviewLimit("SELECT a FROM t LIMIT 2")).toBe("SELECT a FROM t LIMIT 2");
  });

  it("returns redacted preview without cell values", async () => {
    const r = await dryRunRead("SELECT email, name FROM people", [], async () => ({
      rows: [{ email: "secret@example.com", name: "Ada" }, { email: "x@y.z", name: "Bob" }],
    }));
    expect(r.ok).toBe(true);
    expect(r.rowCount).toBe(2);
    expect(r.columns).toEqual(["email", "name"]);
    expect(r.preview).not.toMatch(/secret@|Ada|Bob/);
    expect(r.preview).toMatch(/~2 row/);
  });

  it("reports empty preview honestly", async () => {
    const r = await dryRunRead("SELECT 1", [], async () => ({ rows: [] }));
    expect(r.rowCount).toBe(0);
    expect(r.preview).toMatch(/0 rows/);
  });

  it("previewLines lists each result", () => {
    expect(previewLines([{ ok: true, rowCount: 1, columns: ["a"], preview: "one" }])).toEqual(["one"]);
  });

  it("previewCompiledReads is a no-op when flag off", async () => {
    process.env.BUILDER_INTENT_IR = "0";
    const out = await previewCompiledReads([{ label: "r", sql: "SELECT 1" }], async () => ({ rows: [{ a: 1 }] }));
    expect(out).toEqual([]);
  });

  it("previewCompiledReads runs when flag on (default)", async () => {
    delete process.env.BUILDER_INTENT_IR;
    const out = await previewCompiledReads([{ label: "r", sql: "SELECT a FROM t" }], async () => ({ rows: [{ a: 1 }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.preview).toMatch(/r:/);
    expect(out[0]!.preview).not.toMatch(/secret/);
  });
});
