/**
 * The email report renderer.
 * email-send-tool · report formatting pass
 *
 * ── What is worth asserting here ─────────────────────────────────────────────
 *
 * The renderer's output is markup, and markup is easy to assert badly — a test
 * that pins byte-for-byte HTML fails on every styling change and teaches the next
 * person to update the expectation without reading it. So these assert
 * **properties**:
 *
 *  - every value that came from the caller is escaped (the security case, and the
 *    only reason an HTML body is defensible at all),
 *  - a structured payload becomes a table with the right columns and the right
 *    number of rows,
 *  - prose stays prose rather than being mangled into a table by a colon,
 *  - and nothing is ever silently dropped or truncated.
 */
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  humanise,
  formatValue,
  renderReport,
  sectionsFromText,
} from "./mail-report.js";

/** A fixed clock, so a footer assertion is not a flake at midnight. */
const AT = new Date("2026-08-18T09:14:00Z");

const render = (subject: string, body: string) =>
  renderReport({ subject, body, meta: { generatedAt: AT } });

const html = (subject: string, body: string): string => {
  const result = render(subject, body);
  if (!result.ok) throw new Error(`expected a render, got: ${result.message}`);
  return result.html;
};

/** Cell text, with the markup stripped — what a reader would actually see. */
const visibleText = (markup: string): string =>
  markup.replace(/<[^>]*>/g, " ").replace(/ +/g, " ");

describe("escaping — the reason an HTML body is defensible", () => {
  it("escapes every character that could open a tag or break an attribute", () => {
    expect(escapeHtml(`<a href="x" onerror='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("renders injected markup in a table cell as VISIBLE TEXT, never as markup", () => {
    /**
     * ⚠ The load-bearing test in this file. Upstream content is unvetted — a
     * database row, a scraped page, a document — and spec.md's Edge Cases reject
     * an HTML body precisely because such content could render as a live link or
     * a spoofed sender block. That objection is answered by escaping and by
     * nothing else, so it is asserted on the shape an attacker would actually
     * use.
     */
    const payload = JSON.stringify([
      {
        employee: `<script>alert(1)</script>`,
        note: `<a href="https://evil.example">click me</a>`,
        img: `<img src=x onerror="alert(1)">`,
      },
    ]);
    const out = html("Attendance", payload);

    expect(out).not.toContain("<script>");
    expect(out).not.toContain('<a href="https://evil.example"');
    expect(out).not.toContain('onerror="alert(1)"');
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("evil.example");
  });

  it("escapes the SUBJECT too — it is caller-supplied and it becomes the heading", () => {
    const out = html(`<img src=x onerror="alert(1)">`, "anything");
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x");
  });

  it("escapes a column HEADING, which comes from the caller's own keys", () => {
    const out = html("Report", JSON.stringify([{ "<b>dept</b>": "Engineering" }]));
    expect(out).not.toContain("<b>dept</b>");
    expect(out).toContain("&lt;b&gt;");
  });
});

describe("structured payloads become tables", () => {
  const ROWS = JSON.stringify([
    { employee_name: "A. Sharma", dept: "Engineering", present: 21, rate: "95.5%" },
    { employee_name: "R. Iyer", dept: "Finance", present: 19, rate: "86.4%" },
  ]);

  it("renders one row per record and one column per key", () => {
    const result = render("Attendance", ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).toBe("structured");
    expect(result.tables).toBe(1);
    expect(result.rows).toBe(2);
    expect((result.html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("humanises a snake_case key into a column heading", () => {
    expect(humanise("employee_name")).toBe("Employee Name");
    expect(humanise("avgRate")).toBe("Avg Rate");
    // ⚠ An acronym is left alone — title-casing `ID` reads as a typo.
    expect(humanise("EMP_ID")).toBe("EMP ID");
    expect(html("Attendance", ROWS)).toContain("Employee Name");
  });

  it("right-aligns a column whose every populated cell is a number", () => {
    const out = html("Attendance", ROWS);
    expect(out).toContain('align="right"');
    // The name column is text and must stay left.
    expect(out).toContain('align="left"');
  });

  it("unwraps Foundry's own `results[0].data` envelope", () => {
    /**
     * ⚠ This shape is WHY raw JSON was reaching mailboxes: a `datasource`/`query`
     * step's body is this envelope (`flow-output-shape.ts`), and a drafter that
     * passes the whole body rather than the leaf is the common case.
     */
    const body = JSON.stringify({ results: [{ data: [{ invoice: "INV-1", amount: 120 }] }] });
    const result = render("Overdue", body);
    if (!result.ok) throw new Error("expected a render");
    expect(result.tables).toBe(1);
    expect(result.rows).toBe(1);
    expect(result.html).toContain("INV-1");
  });

  it("renders an object of scalars as a summary block, not a one-row table", () => {
    const result = render("Summary", JSON.stringify({ employees: 128, average: "94.2%" }));
    if (!result.ok) throw new Error("expected a render");
    expect(result.tables).toBe(0);
    expect(result.rows).toBe(2);
    expect(result.html).toContain("Employees");
    expect(result.html).toContain("128");
  });

  it("splits an object into a summary block plus a table per array", () => {
    const body = JSON.stringify({
      period: "2026-06",
      total: 128,
      below_target: [{ employee: "A. Sharma", rate: 74.5 }],
    });
    const result = render("Attendance", body);
    if (!result.ok) throw new Error("expected a render");
    expect(result.tables).toBe(1);
    expect(result.html).toContain("Below Target");
    expect(result.html).toContain("2026-06");
  });

  it("says so when a result set is empty, rather than rendering an empty page", () => {
    expect(html("Overdue", "[]")).toContain("No rows were returned.");
  });

  it("keeps a nested value visible by compacting it, never by dropping the column", () => {
    const out = html("Report", JSON.stringify([{ id: 1, tags: ["a", "b"] }]));
    expect(out).toContain("[&quot;a&quot;,&quot;b&quot;]");
  });

  it("renders a missing value as an em dash rather than an empty cell", () => {
    const out = html("Report", JSON.stringify([{ a: 1, b: null }, { a: 2, c: 3 }]));
    expect(out).toContain("—");
  });

  it("does NOT reformat a number", () => {
    // ⚠ Thousand-separating an id or a year makes it unmatchable against the
    // system it came from. `20260618` must stay `20260618`.
    expect(formatValue(20260618)).toBe("20260618");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(null)).toBe("—");
  });

  it("falls back to prose when the body only LOOKS like JSON", () => {
    const result = render("Report", "{ this is not json, it just starts with a brace");
    if (!result.ok) throw new Error("expected a render");
    expect(result.shape).toBe("text");
    expect(result.html).toContain("this is not json");
  });
});

describe("prose keeps its meaning", () => {
  it("turns a markdown table into a real table", () => {
    const body = [
      "Attendance for June.",
      "",
      "| Employee | Dept | Rate |",
      "|---|---|---|",
      "| A. Sharma | Engineering | 95.5% |",
      "| R. Iyer | Finance | 86.4% |",
    ].join("\n");

    const result = render("Attendance", body);
    if (!result.ok) throw new Error("expected a render");
    expect(result.tables).toBe(1);
    expect(result.rows).toBe(2);
    expect(result.html).toContain("<th");
    expect(visibleText(result.html)).toContain("A. Sharma");
    // The `|` characters must not survive into the rendered cells.
    expect(result.html).not.toContain("| A. Sharma |");
  });

  it("turns a RUN of `Label: value` lines into a summary block", () => {
    const body = ["Employees: 128", "Average: 94.2%", "Below target: 7"].join("\n");
    const result = render("Attendance", body);
    if (!result.ok) throw new Error("expected a render");
    expect(result.rows).toBe(3);
    expect(result.html).toContain("Below target");
  });

  it("leaves a SINGLE colon line as prose", () => {
    /**
     * ⚠ The guard that keeps this a reader rather than a guesser. One sentence
     * containing a colon is prose; turning it into a two-column table because of
     * the punctuation is worse than doing nothing.
     */
    const sections = sectionsFromText("Note: the figures exclude contractors.");
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("text");
  });

  it("takes a markdown heading as the section title", () => {
    const sections = sectionsFromText("## Below target\n\nSome prose.");
    expect(sections[0].title).toBe("Below target");
  });

  it("preserves the author's line breaks in a paragraph", () => {
    expect(html("Report", "line one\nline two")).toContain("white-space:pre-wrap");
  });

  it("pads a ragged markdown row rather than dropping it", () => {
    const body = ["| A | B | C |", "|---|---|---|", "| 1 | 2 |"].join("\n");
    const result = render("Report", body);
    if (!result.ok) throw new Error("expected a render");
    expect(result.rows).toBe(1);
  });
});

describe("the report shell", () => {
  it("uses the subject as the heading, so the two cannot disagree", () => {
    expect(html("Attendance Report — June 2026", "x")).toContain("Attendance Report — June 2026");
  });

  it("stamps the footer in UTC and names the run", () => {
    const result = renderReport({
      subject: "Attendance",
      body: "x",
      meta: { generatedAt: AT, flowExecutionId: "68254629-5f1b-4968-a09f-85404b1efc17" },
    });
    if (!result.ok) throw new Error("expected a render");
    expect(result.html).toContain("18 Aug 2026");
    expect(result.html).toContain("UTC");
    expect(result.html).toContain("run 68254629-5f1b-4968-a09f-85404b1efc17");
  });

  it("refuses — rather than truncates — a report larger than the ceiling", () => {
    /**
     * ⚠ spec.md: a report over the cap is refused with both sizes named, never
     * silently truncated. A half-rendered table delivered as a success is the
     * false-green this whole feature is written against.
     */
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const result = renderReport({
      subject: "Big",
      body: JSON.stringify(rows),
      meta: { generatedAt: AT },
      maxRenderedBytes: 2_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.detail.actual).toBeGreaterThan(2_000);
    expect(result.detail.allowed).toBe(2_000);
  });
});
