/** A chat file as a preview (file-preview.ts): bounded, and honest about what it left out. */
import { describe, expect, it } from "vitest";
import { CFB, utils, write } from "xlsx";
import { PREVIEW_ROWS, docxText, previewOf } from "./file-preview.js";

const xlsx = (rows: unknown[][], more?: Record<string, unknown[][]>) => {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), "Rates");
  for (const [n, r] of Object.entries(more ?? {})) utils.book_append_sheet(wb, utils.aoa_to_sheet(r), n);
  return Buffer.from(write(wb, { type: "buffer", bookType: "xlsx" }));
};

describe("previewOf", () => {
  it("reads every sheet of a workbook, cut to the first rows, with the true totals", () => {
    const rows = [["name", "rate"], ...Array.from({ length: 450 }, (_, i) => [`p${i}`, i])];
    const p = previewOf("rates.xlsx", xlsx(rows, { Notes: [["hello"]] }));
    expect(p.kind).toBe("table");
    if (p.kind !== "table") return;
    expect(p.sheets.map((s) => s.name)).toEqual(["Rates", "Notes"]);
    expect(p.sheets[0]!.rows).toHaveLength(PREVIEW_ROWS);
    expect(p.sheets[0]!.rows[1]).toEqual(["p0", "0"]);
    expect(p.sheets[0]!.totalRows).toBe(451);
  });

  it("reads a CSV the same way", () => {
    const p = previewOf("r.csv", Buffer.from("name,rate\nAsha,10\n"));
    expect(p.kind === "table" && p.sheets[0]!.rows).toEqual([["name", "rate"], ["Asha", "10"]]);
  });

  /**
   * ⚠ A legacy file stores its text in a code page, not Unicode. xlsx 0.18.5 (CommonJS) loaded the code-page tables
   * itself; 0.20's ESM build does not, and without `set_cptable` this reads " café" — the "€" silently gone. A dBASE
   * table in Windows-1252 (header byte 29 = 0x57) is the smallest such file to build by hand; SheetJS reads by
   * content, so the extension is only what lets `previewOf` try it.
   */
  it("decodes a legacy code-page file — Windows-1252 text keeps its €", () => {
    const text = Buffer.from([0x80, 0x20, 0x63, 0x61, 0x66, 0xe9]); // "€ café" in Windows-1252
    const hdr = Buffer.alloc(32);
    hdr[0] = 0x03;
    hdr.writeUInt32LE(1, 4); // one record
    hdr.writeUInt16LE(32 + 32 + 1, 8); // header length
    hdr.writeUInt16LE(1 + 10, 10); // record length
    hdr[29] = 0x57; // code page 1252
    const field = Buffer.alloc(32);
    field.write("NAME", 0, "ascii");
    field[11] = 0x43; // 'C' — character field
    field[16] = 10;
    const record = Buffer.concat([Buffer.from([0x20]), text, Buffer.alloc(4, 0x20)]);
    const dbf = Buffer.concat([hdr, field, Buffer.from([0x0d]), record, Buffer.from([0x1a])]);

    const p = previewOf("legacy.xls", dbf);
    expect(p.kind).toBe("table");
    if (p.kind !== "table") return;
    expect(p.sheets[0]!.rows[1]).toEqual(["€ café"]);
  });

  it("says plainly when a file has no preview or cannot be read, instead of drawing nothing", () => {
    expect(previewOf("deck.pptx", Buffer.from("x")).kind).toBe("none");
    expect(previewOf("broken.docx", Buffer.from("not a zip")).kind).toBe("none");
  });
});

describe("docxText", () => {
  it("gives a Word document's paragraphs, one per line, with its entities decoded", () => {
    const zip = CFB.utils.cfb_new();
    CFB.utils.cfb_add(
      zip,
      "/word/document.xml",
      Buffer.from('<w:document><w:body><w:p><w:r><w:t>Rates &amp; people</w:t></w:r></w:p><w:p><w:r><w:t>Asha</w:t><w:tab/><w:t>10</w:t></w:r></w:p></w:body></w:document>'),
    );
    const body = Buffer.from(CFB.write(zip, { type: "buffer", fileType: "zip" }) as Uint8Array);
    expect(docxText(body)).toBe("Rates & people\nAsha\t10");
  });
});
