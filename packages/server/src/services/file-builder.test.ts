/**
 * Structured rows → a file: the flattening both formats share, and the
 * refusals that must arrive before a build, not after it.
 *
 * The XLSX assertions check BYTES, not a parsed workbook: SheetJS's own
 * round-trip would be the library testing itself. What this pins is that a
 * real zip left this function, with the same columns the CSV would carry.
 */
import { describe, expect, it } from "vitest";
import { buildRowsFile, MAX_GENERATED_ROWS, rowsToCsv } from "./file-builder.js";

describe("rowsToCsv — RFC 4180", () => {
  it("writes a header from the union of keys, in first-seen order", () => {
    const csv = rowsToCsv([
      { b: 1 },
      { a: 2, b: 3 },
      { a: 4, c: 5 },
    ]);
    expect(csv).toBe("b,a,c\r\n1,,\r\n3,2,\r\n,4,5\r\n");
  });

  it("quotes only what needs quoting, and doubles the quotes inside", () => {
    const csv = rowsToCsv([
      { plain: "yes", comma: "a,b", quote: 'say "hi"', nl: "line1\nline2" },
      { plain: "007", comma: "", quote: "", nl: "" },
    ]);
    const [header, row1, row2] = csv.split("\r\n");
    expect(header).toBe("plain,comma,quote,nl");
    expect(row1).toBe('yes,"a,b","say ""hi""","line1\nline2"');
    // A leading zero stays a STRING — a spreadsheet must not turn it into 7.
    expect(row2).toBe('007,,,');
  });

  it("null and undefined become EMPTY cells, never the text 'null'", () => {
    expect(rowsToCsv([{ a: null, b: undefined, c: "kept" }])).toBe(
      "a,b,c\r\n,,kept\r\n",
    );
  });

  it("a nested value is JSON, not [object Object]", () => {
    const csv = rowsToCsv([{ v: { x: 1 }, arr: [1, 2] }]);
    expect(csv).toContain('"{""x"":1}"');
    expect(csv).toContain('"[1,2]"');
    expect(csv).not.toContain("[object Object]");
  });

  it("numbers and booleans render as themselves; non-finite as text", () => {
    expect(rowsToCsv([{ n: 1.5, b: false, bad: Number.POSITIVE_INFINITY }])).toBe(
      "n,b,bad\r\n1.5,false,Infinity\r\n",
    );
  });

  it("is CRLF-separated with a trailing CRLF — what Excel and Papa.parse accept", () => {
    const csv = rowsToCsv([{ a: 1 }, { a: 2 }]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(4); // header, 2 records, trailing empty
  });
});

describe("buildRowsFile", () => {
  it("CSV: text AND bytes agree", () => {
    const r = buildRowsFile("csv", [{ a: "x" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.text).toBe("a\r\nx\r\n");
    expect(r.file.data.toString("utf8")).toBe(r.file.text);
    expect(r.file.bytes).toBe(Buffer.byteLength(r.file.text!, "utf8"));
  });

  it("XLSX: real bytes, text null — a workbook is not a string", () => {
    const r = buildRowsFile("xlsx", [{ a: "x", b: 2 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.text).toBeNull();
    expect(r.file.data.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(r.file.bytes).toBe(r.file.data.byteLength);
  });

  it("refuses empty rows by name — an empty file reads as a report of nothing", () => {
    const r = buildRowsFile("csv", []);
    expect(r).toMatchObject({ ok: false, message: "attachment is empty" });
  });

  it("refuses a row cap breach with both numbers, before building", () => {
    const rows = Array.from({ length: MAX_GENERATED_ROWS + 1 }, (_, i) => ({ i }));
    const r = buildRowsFile("csv", rows);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toMatchObject({ actual: MAX_GENERATED_ROWS + 1, allowed: MAX_GENERATED_ROWS });
  });

  it("refuses all-empty-object rows — there would be no columns", () => {
    const r = buildRowsFile("csv", [{}, {}]);
    expect(r).toMatchObject({ ok: false, message: "attachment has no columns" });
  });
});
