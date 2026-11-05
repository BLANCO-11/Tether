import { describe, expect, it } from "vitest";
import {
  attachmentHeld,
  attachmentMeta,
  checkAttachments,
  foldFlatAttachment,
  promoteOversizedBody,
  BODY_TABLE_MAX_ROWS,
  PROMOTED_BODY_BRIEF,
  sanitizeAttachBaseName,
} from "./mail-attachments.js";

const CAPS = { maxCount: 5, maxTotalBytes: 1000 };

describe("sanitizeAttachBaseName", () => {
  it("strips commas and prose junk from a sink quote (UAT attach_name 422)", () => {
    expect(sanitizeAttachBaseName("in a excel report, email it to me")).toBe("in a excel report email it to me");
    expect(sanitizeAttachBaseName("Employee working days report")).toBe("Employee working days report");
  });
});

describe("checkAttachments — the text form", () => {
  it("accepts none — absent and empty are both 'no attachments'", () => {
    expect(checkAttachments(undefined, CAPS)).toEqual({ ok: true, attachments: [] });
    expect(checkAttachments([], CAPS)).toEqual({ ok: true, attachments: [] });
  });

  it("derives the content type from the extension, case-insensitively", () => {
    const r = checkAttachments(
      [
        { name: "report.csv", content: "a,b\n1,2\n" },
        { name: "Notes.TXT", content: "hi" },
        { name: "data.json", content: "{}" },
        { name: "tab.tsv", content: "a\tb" },
      ],
      CAPS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachments.map((a) => a.contentType)).toEqual([
      "text/csv",
      "text/plain",
      "application/json",
      "text/tab-separated-values",
    ]);
  });

  it("measures size in UTF-8 bytes, not characters", () => {
    const r = checkAttachments([{ name: "u.csv", content: "é" }], CAPS);
    expect(r.ok && r.attachments[0].bytes).toBe(2);
    expect(r.ok && r.attachments[0].text).toBe("é");
  });

  it.each([
    ["report.html", "markup a client renders"],
    ["run.exe", "an executable"],
    ["report.csv.exe", "a double extension — the LAST one is what a client honours"],
    ["../etc/report.csv", "a path"],
    ["dir/report.csv", "a folder separator"],
    [".csv", "no name before the extension"],
    ["report", "no extension"],
    ["report.svg", "an image that can carry script"],
  ])("refuses %s (%s)", (name) => {
    const r = checkAttachments([{ name, content: "x" }], CAPS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/name is not allowed/);
  });

  it("refuses an empty file rather than delivering a report of nothing", () => {
    const r = checkAttachments([{ name: "empty.csv", content: "" }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/empty/);
  });

  it("refuses two files with one name (case-insensitive)", () => {
    const r = checkAttachments(
      [
        { name: "a.csv", content: "x" },
        { name: "A.csv", content: "y" },
      ],
      CAPS,
    );
    expect(r.ok).toBe(false);
  });

  it("refuses more files than the cap", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    const r = checkAttachments(six, CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatchObject({ actual: 6, allowed: 5 });
  });

  it("refuses — never truncates — when the TOTAL is over the cap, naming both sizes", () => {
    const r = checkAttachments(
      [
        { name: "a.csv", content: "x".repeat(600) },
        { name: "b.csv", content: "x".repeat(600) },
      ],
      CAPS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatchObject({ actual: 1200, allowed: 1000 });
  });

  it("THE CONTROL — exactly at the cap is accepted", () => {
    const r = checkAttachments([{ name: "a.csv", content: "x".repeat(1000) }], CAPS);
    expect(r.ok).toBe(true);
  });
});

describe("checkAttachments — the generated form", () => {
  const ROWS = [
    { employee_id: 1, department: "Ops" },
    { employee_id: 2, department: "Finance" },
  ];

  it("builds a .csv from rows, with the content type derived from the name", () => {
    const r = checkAttachments([{ name: "headcount.csv", format: "csv", rows: ROWS }], CAPS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a] = r.attachments;
    expect(a.contentType).toBe("text/csv");
    expect(a.text).toBe("employee_id,department\r\n1,Ops\r\n2,Finance\r\n");
    expect(a.bytes).toBe(Buffer.byteLength(a.text!, "utf8"));
    expect(a.data.toString("utf8")).toBe(a.text);
  });

  it("builds a binary .xlsx from rows — bytes, with text null", () => {
    // A workbook is kilobytes of zip, so this one needs headroom the
    // deliberately tiny CAPS above do not give.
    const r = checkAttachments([{ name: "headcount.xlsx", format: "xlsx", rows: ROWS }], {
      maxCount: 5,
      maxTotalBytes: 100_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a] = r.attachments;
    expect(a.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(a.text).toBeNull();
    // A zip file opens with "PK" — the workbook is real bytes, not a string.
    expect(a.data.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(a.bytes).toBe(a.data.byteLength);
    expect(a.bytes).toBeGreaterThan(0);
  });

  it("refuses a name whose extension does not match the format", () => {
    const r = checkAttachments([{ name: "report.csv", format: "xlsx", rows: ROWS }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/does not match the format/);
  });

  it("refuses rows without a format", () => {
    const r = checkAttachments(
      [{ name: "report.csv", rows: ROWS } as { name: string; rows: typeof ROWS }],
      CAPS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/format/);
  });

  it("refuses text content under an .xlsx name — a workbook cannot be a string", () => {
    const r = checkAttachments([{ name: "report.xlsx", content: "not a workbook" }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/text file/);
  });

  it("refuses an item with neither content nor rows", () => {
    const r = checkAttachments([{ name: "report.csv" }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/neither/);
  });

  it("refuses an item carrying BOTH content and rows", () => {
    const r = checkAttachments(
      [{ name: "report.csv", content: "a,b", format: "csv", rows: ROWS }],
      CAPS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/both/);
  });

  it("refuses empty rows — the same empty-file rule as the text form", () => {
    const r = checkAttachments([{ name: "report.csv", format: "csv", rows: [] }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/empty/);
  });

  it("counts the BUILT bytes toward the total cap", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ id: i, filler: "x".repeat(40) }));
    const r = checkAttachments([{ name: "big.csv", format: "csv", rows: big }], CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatchObject({ allowed: 1000 });
  });
});

describe("attachmentMeta", () => {
  it("records name and size and NEVER the content", () => {
    const r = checkAttachments([{ name: "a.csv", content: "SECRET-ROW" }], CAPS);
    if (!r.ok) throw new Error("unexpected refusal");
    const meta = attachmentMeta(r.attachments);
    expect(meta).toEqual([{ name: "a.csv", bytes: 10 }]);
    expect(JSON.stringify(meta)).not.toContain("SECRET-ROW");
  });
});

describe("attachmentHeld — what a draft run keeps for the Email box", () => {
  it("keeps a text file's TEXT, with no encoding marker", () => {
    const r = checkAttachments([{ name: "a.csv", content: "x,y\n1,2\n" }], CAPS);
    if (!r.ok) throw new Error("unexpected refusal");
    expect(attachmentHeld(r.attachments[0])).toEqual({
      name: "a.csv",
      contentType: "text/csv",
      content: "x,y\n1,2\n",
      bytes: 8,
    });
  });

  it("keeps a generated .xlsx as BASE64 and says so", () => {
    const r = checkAttachments(
      [{ name: "a.xlsx", format: "xlsx", rows: [{ x: 1 }] }],
      { maxCount: 5, maxTotalBytes: 1_000_000 },
    );
    if (!r.ok) throw new Error("unexpected refusal");
    const held = attachmentHeld(r.attachments[0]);
    expect(held.encoding).toBe("base64");
    // Round trip — the Email box hands back exactly the bytes Graph would get.
    expect(Buffer.from(held.content, "base64").subarray(0, 2).toString("latin1")).toBe("PK");
    expect(held.bytes).toBe(Buffer.from(held.content, "base64").byteLength);
  });
});

describe("the flat attachment — attach_rows + attach_name + attach_format", () => {
  const rows = [{ id: 1, who: "a@x.example" }];

  it("folds into ONE generated file, adding the extension from the format", () => {
    const r = foldFlatAttachment(undefined, { attach_rows: rows, attach_name: "overdue invoices", attach_format: "xlsx" });
    expect(r).toEqual({ ok: true, attachments: [{ name: "overdue invoices.xlsx", format: "xlsx", rows }], skipped: [] });
  });

  it("infers the format from a name that already ends in .csv / .xlsx", () => {
    const r = foldFlatAttachment(undefined, { attach_rows: rows, attach_name: "list.csv" });
    expect(r.ok && r.attachments).toEqual([{ name: "list.csv", format: "csv", rows }]);
  });

  it("appends after any explicit `attachments`", () => {
    const r = foldFlatAttachment([{ name: "a.txt", content: "x" }], { attach_rows: rows, attach_name: "b", attach_format: "csv" });
    expect(r.ok && r.attachments.map((a) => a.name)).toEqual(["a.txt", "b.csv"]);
  });

  it("with NO rows attaches nothing, says so, and does not refuse the email", () => {
    const r = foldFlatAttachment(undefined, { attach_rows: [], attach_name: "overdue", attach_format: "csv" });
    expect(r).toEqual({ ok: true, attachments: [], skipped: [{ name: "overdue.csv", reason: "no rows — nothing to attach" }] });
  });

  it("refuses a half-declared file by name", () => {
    expect(foldFlatAttachment(undefined, { attach_rows: rows })).toMatchObject({ ok: false, message: /without attach_name/ });
    expect(foldFlatAttachment(undefined, { attach_name: "x", attach_format: "csv" })).toMatchObject({ ok: false, message: /without attach_rows/ });
    expect(foldFlatAttachment(undefined, { attach_rows: rows, attach_name: "report" })).toMatchObject({ ok: false, message: /format is not stated/ });
  });

  it("rows + a stated format and NO name take the subject as the name (“email me a csv report” names nothing)", () => {
    const r = foldFlatAttachment(undefined, { attach_rows: rows, attach_format: "csv", fallbackName: "Leave report: under 6 / week 12" });
    expect(r.ok && r.attachments).toEqual([{ name: "Leave report under 6 week 12.csv", format: "csv", rows }]);
    // A stated name still wins over the subject.
    const named = foldFlatAttachment(undefined, { attach_rows: rows, attach_name: "mine", attach_format: "csv", fallbackName: "Subject" });
    expect(named.ok && named.attachments[0]?.name).toBe("mine.csv");
  });

  it("CONTROL: the subject never rescues rows with NO format — a file nobody stated is still refused", () => {
    expect(foldFlatAttachment(undefined, { attach_rows: rows, fallbackName: "Subject" })).toMatchObject({ ok: false, message: /without attach_name/ });
  });

  it("leaves a name ending in the OTHER format alone, so the check refuses the mismatch", () => {
    const r = foldFlatAttachment(undefined, { attach_rows: rows, attach_name: "x.csv", attach_format: "xlsx" });
    expect(r.ok && r.attachments[0]).toMatchObject({ name: "x.csv", format: "xlsx" });
    const checked = checkAttachments(r.ok ? r.attachments : [], { maxCount: 5, maxTotalBytes: 1_500_000 });
    expect(checked).toMatchObject({ ok: false, message: "the file name does not match the format" });
  });

  it("takes a step's whole output as TEXT — what the step engine binds — unwrapped as the report unwraps `body`", () => {
    const envelope = JSON.stringify({ results: [{ data: rows }], succeeded: 1, failed: 0, warnings: [] });
    const r = foldFlatAttachment(undefined, { attach_rows: envelope, attach_name: "q", attach_format: "csv" });
    expect(r.ok && r.attachments).toEqual([{ name: "q.csv", format: "csv", rows }]);
    // A transform's plain list, and one record, both work.
    expect(foldFlatAttachment(undefined, { attach_rows: JSON.stringify(rows), attach_name: "q.csv" })).toMatchObject({ ok: true });
    const one = foldFlatAttachment(undefined, { attach_rows: JSON.stringify(rows[0]), attach_name: "q.csv" });
    expect(one.ok && one.attachments[0]?.rows).toEqual([rows[0]]);
  });

  it("an empty output as text is no rows — skipped, not refused", () => {
    const empty = JSON.stringify({ results: [{ data: [] }], succeeded: 1, failed: 0, warnings: [] });
    const r = foldFlatAttachment(undefined, { attach_rows: empty, attach_name: "q", attach_format: "csv" });
    expect(r).toMatchObject({ ok: true, attachments: [], skipped: [{ name: "q.csv" }] });
  });

  it("refuses text that is not a step's rows, rather than attaching nonsense", () => {
    for (const bad of ["not json", "42", JSON.stringify(["a", "b"])]) {
      expect(foldFlatAttachment(undefined, { attach_rows: bad, attach_name: "q.csv" })).toMatchObject({
        ok: false,
        message: "attach_rows is not a list of records",
      });
    }
  });

  it("an empty rows list with no name and no format declares no file — same as not given", () => {
    const existing = [{ name: "a.txt", content: "x" }];
    expect(foldFlatAttachment(existing, { attach_rows: [] })).toEqual({ ok: true, attachments: existing, skipped: [] });
    // CONTROL: rows given with no name are still refused.
    expect(foldFlatAttachment(undefined, { attach_rows: [{ a: 1 }] })).toMatchObject({ ok: false, message: "attach_rows given without attach_name" });
  });

  it("adds nothing when none of the three is given", () => {
    expect(foldFlatAttachment(undefined, {})).toEqual({ ok: true, attachments: [], skipped: [] });
  });
});

describe("promoteOversizedBody — oversized row dump → attachment", () => {
  const rows = [
    { employee_id: 1, department: "Ops" },
    { employee_id: 2, department: "Finance" },
  ];
  const big = JSON.stringify({ results: [{ data: rows }], succeeded: 1, failed: 0, warnings: [] });
  // Cap below `big` so promotion fires; real default is 262_144.
  const maxBodyBytes = 40;

  it("under the cap is a no-op", () => {
    const r = promoteOversizedBody({
      body: "short",
      subject: "Report",
      maxBodyBytes: 1000,
    });
    expect(r).toEqual({ body: "short", promoted: false });
  });

  it("a body TABLE past BODY_TABLE_MAX_ROWS goes as a file even under the byte cap (2026-10-13)", () => {
    const many = JSON.stringify(Array.from({ length: BODY_TABLE_MAX_ROWS + 1 }, (_, i) => ({ employee_id: i })));
    const r = promoteOversizedBody({ body: many, subject: "Muster", maxBodyBytes: 262_144 });
    expect(r).toMatchObject({ promoted: true, body: PROMOTED_BODY_BRIEF, attach_rows: many, attach_format: "xlsx" });
  });

  it("CONTROL: a short table and long-ish prose under the cap stay in the body", () => {
    const few = JSON.stringify(rows);
    expect(promoteOversizedBody({ body: few, subject: "s", maxBodyBytes: 262_144 }).promoted).toBe(false);
    const prose = "Hi team,\n" + "Everyone was present. ".repeat(200);
    expect(promoteOversizedBody({ body: prose, subject: "s", maxBodyBytes: 262_144 }).promoted).toBe(false);
  });

  it("promotes an oversized Foundry envelope into attach_rows (xlsx) and a brief body", () => {
    const r = promoteOversizedBody({
      body: big,
      subject: "Leave applications report",
      maxBodyBytes,
    });
    expect(r.promoted).toBe(true);
    expect(r.body).toBe(PROMOTED_BODY_BRIEF);
    expect(r.attach_rows).toBe(big);
    expect(r.attach_format).toBe("xlsx");
    expect(r.fromBytes).toBe(Buffer.byteLength(big, "utf8"));
  });

  it("when attach_rows is already set, only shrinks the body (no second file)", () => {
    const r = promoteOversizedBody({
      body: big,
      subject: "Leave applications report",
      maxBodyBytes,
      attach_rows: big,
      attach_format: "xlsx",
      attach_name: "leave",
    });
    expect(r.promoted).toBe(true);
    expect(r.body).toBe(PROMOTED_BODY_BRIEF);
    expect(r.attach_rows).toBe(big);
    expect(r.attach_name).toBe("leave");
    expect(r.attach_format).toBe("xlsx");
  });

  it("CONTROL: oversized prose is NOT promoted — the ordinary body cap must still refuse", () => {
    const prose = "x".repeat(200);
    const r = promoteOversizedBody({
      body: prose,
      subject: "Hello",
      maxBodyBytes: 40,
    });
    expect(r.promoted).toBe(false);
    expect(r.body).toBe(prose);
    expect(r.attach_rows).toBeUndefined();
  });
});

/** A file a step saved travels by id; the route fills in its bytes (2026-10-12). */
describe("a saved file", () => {
  const caps = { maxCount: 5, maxTotalBytes: 50 * 1024 * 1024 };
  const pdf = Buffer.from("%PDF-1.7 ...");

  it("is attached as the bytes the step saved, typed from its name", () => {
    const r = checkAttachments([{ name: "LOP report.pdf", file: "f-1", fileData: pdf }], caps);
    expect(r).toMatchObject({ ok: true, attachments: [{ name: "LOP report.pdf", contentType: "application/pdf", bytes: pdf.length, text: null }] });
  });

  it("is refused when the run did not save it", () => {
    const r = checkAttachments([{ name: "LOP report.xlsx", file: "f-other" }], caps);
    expect(r).toMatchObject({ ok: false, message: "the saved file was not found" });
  });

  it("is one form only", () => {
    const r = checkAttachments([{ name: "a.xlsx", file: "f-1", fileData: pdf, format: "xlsx", rows: [] }], caps);
    expect(r).toMatchObject({ ok: false, message: "attachment is both a saved file and text or rows" });
  });

  it("still cannot carry a name a mail client would run", () => {
    const r = checkAttachments([{ name: "report.html", file: "f-1", fileData: pdf }], caps);
    expect(r).toMatchObject({ ok: false, message: "attachment name is not allowed" });
  });

  it("over the total says the sizes in plain words", () => {
    const r = checkAttachments([{ name: "big.xlsx", file: "f-1", fileData: Buffer.alloc(2000) }], { maxCount: 5, maxTotalBytes: 1024 * 1024 * 0.001 });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/^attachments are too large: 0\.0 MB, and one email can carry at most/);
  });
});
