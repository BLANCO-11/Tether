/**
 * The email report renderer — raw step output in, a formatted HTML report out.
 * email-send-tool · report formatting pass
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Before this module, `body` went to Microsoft Graph exactly as the flow produced
 * it: a JSON blob from a `query`/`code` step, or a wall of model prose from an
 * `llm_complete` step. Both arrive in a mailbox as raw data — the recipient reads
 * `[{"employee":"A. Sharma","present":21}, …]` and does the parsing themselves.
 *
 * This module turns that into a report: a heading, a summary, and **tables** with
 * real columns.
 *
 * ── ⚠ Why rendering happens HERE and not in the model ───────────────────────
 *
 * The obvious alternative was a prompt rule telling the drafter to write a nice
 * body. SESSION-NOTES records two consecutive real runs that failed on the model
 * getting `body` *rendering* wrong (T049, T051) — and those were plain strings.
 * Asking the same model to hand-build table markup inside a Pebble expression is
 * the same class of defect with more surface. The model supplies data; Foundry
 * decides what it looks like. That is deterministic, testable, and identical for
 * every flow in every workspace.
 *
 * ── ⚠ HTML is safe here for one reason only: nothing external is markup ─────
 *
 * spec.md's Edge Cases rejected HTML bodies because upstream content is unvetted
 * — a script's output can carry text from a database row, a web page or a
 * document, and an attacker who controls that text should not be able to render a
 * live link or a spoofed sender block in the recipient's client.
 *
 * That reasoning still holds, and it is why **every single value that crosses
 * into the output goes through `escapeHtml`** — no exceptions, no "this one is a
 * number so it is fine". The tags in the output are produced by this file's own
 * string literals and by nothing else. `mail-report.test.ts` asserts that a body
 * containing `<script>`, `<a href>` and an `onerror=` attribute comes out as
 * visible text.
 *
 * The rule to keep: **a value is data, and data is escaped.** If a future change
 * ever needs to emit caller-supplied markup, it does not belong in this file.
 *
 * ── ⚠ Inline styles, and tables for layout ──────────────────────────────────
 *
 * This looks like 2005 HTML on purpose. Outlook renders with Word's engine: no
 * flexbox, no grid, no `<style>` reliability, no `border-radius` on a `<div>`
 * that survives. Inline attributes on nested tables is the shape that actually
 * arrives looking like the design. Do not "modernise" this without sending a
 * test message to a real Outlook client and looking at it.
 *
 * ── Nothing here throws ──────────────────────────────────────────────────────
 *
 * The renderer is pure and total: unparseable input is not an error, it is a text
 * report. The one refusal is size, and it is returned as data in the same
 * `MailRefusal` shape the rest of the mail path uses, so the route records it
 * like any other refusal.
 */
import type { MailRefusal } from "./mail-recipients.js";

/**
 * ⚠ A ceiling on the RENDERED bytes, distinct from `MAIL_MAX_BODY_BYTES`.
 *
 * The input cap bounds what the flow sent; this bounds what Graph is asked to
 * carry, and the two differ by however much table markup a wide result set
 * generates. Graph's practical message ceiling is ~4 MB, so a report that has
 * grown past 3 MB is refused *here*, in Foundry's words, naming both numbers —
 * rather than at Microsoft, in Microsoft's words, about a limit nobody set.
 *
 * ⚠ Deliberately NOT a truncation. spec.md: "a report larger than the cap is
 * refused with the actual and allowed sizes named, not silently truncated —
 * truncating a report and delivering it is a wrong answer wearing a success
 * shape." A half-rendered table is exactly that.
 */
export const MAX_RENDERED_BYTES = 3_000_000;

/** Column heads that carry no information once the table is on the page. */
const GENERIC_KEYS = new Set(["rows", "data", "results", "items", "records", "value", "output"]);

export type ReportSection =
  /** A real table: column heads and cells, already stringified, never escaped yet. */
  | { kind: "table"; title: string | null; columns: string[]; rows: string[][] }
  /** Two-column label/value pairs — a summary block, not a data grid. */
  | { kind: "kv"; title: string | null; pairs: Array<[string, string]> }
  /** Prose. Rendered with `white-space: pre-wrap`, so the author's line breaks survive. */
  | { kind: "text"; title: string | null; text: string };

export type ReportRender = {
  ok: true;
  html: string;
  /** What the input turned out to be — surfaced so the route can log it. */
  shape: "structured" | "text";
  tables: number;
  rows: number;
  bytes: number;
};

export type ReportRenderResult = ReportRender | MailRefusal;

/* ────────────────────────────── escaping ────────────────────────────────── */

/**
 * ⚠ The single control that makes an HTML body safe. Applied to EVERY value.
 *
 * `'` is escaped as well as `"` — attribute values in this file are
 * double-quoted, but a renderer that only escapes the quote style it happens to
 * use today is one edit away from an attribute break.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ─────────────────────────── value formatting ───────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isScalar = (v: unknown): boolean =>
  v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);

/** Markdown emphasis around a label or cell, stripped so it is not shown literally. */
const stripEmphasis = (s: string): string =>
  s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").trim();

/**
 * `total_present` → `Total Present`, `avgRate` → `Avg Rate`.
 *
 * ⚠ An all-caps token is left alone (`ID`, `WFH`, `EMP_ID` → `EMP ID`). Title-
 * casing an acronym reads as a typo to the person the report is for.
 */
export function humanise(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w) => (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * One cell's text.
 *
 * ⚠ **A number is never reformatted.** Thousand-separating looks tidier right up
 * until an id, a year or an account number renders as `20,260,618` and the reader
 * cannot match it against the system it came from. Reports are read next to other
 * screens; the value has to be the value.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "string") return value.trim().length === 0 ? "—" : stripEmphasis(value);
  // A nested object in a cell is compacted rather than dropped: a visibly ugly
  // cell is a bug report, a missing one is a silent hole in the data.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A column is right-aligned only when every populated cell in it is a number. */
function isNumericColumn(rows: string[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = (row[index] ?? "").trim();
    if (cell === "" || cell === "—") continue;
    seen += 1;
    if (!/^[-+]?[\d,]*\.?\d+\s*%?$/.test(cell)) return false;
  }
  return seen > 0;
}

/* ──────────────────────────── JSON → sections ───────────────────────────── */

/**
 * Unwrap the envelopes Foundry's own steps produce.
 *
 * A `datasource`/`query` step's body is `{results:[{data: …}]}` (see
 * `flow-output-shape.ts`), and a drafter that passes the whole body rather than
 * the leaf is the common case — that shape is *why* the raw JSON was reaching
 * mailboxes. Unwrapped twice at most, because a nested `results` beyond that is
 * not a shape this system produces and guessing further would be inventing.
 */
export function unwrapEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (isRecord(current) && Array.isArray(current.results) && current.results.length > 0) {
      const first = current.results[0];
      if (isRecord(first) && "data" in first) {
        current = first.data;
        continue;
      }
    }
    break;
  }
  return current;
}

/** Union of keys across rows, in first-seen order — so column order follows the data. */
function columnsOf(rows: Array<Record<string, unknown>>): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        known.add(key);
        seen.push(key);
      }
    }
  }
  return seen;
}

function tableFromObjects(
  title: string | null,
  rows: Array<Record<string, unknown>>,
): ReportSection {
  const keys = columnsOf(rows);
  return {
    kind: "table",
    title,
    columns: keys.map(humanise),
    rows: rows.map((row) => keys.map((key) => formatValue(row[key]))),
  };
}

function titleFor(key: string): string | null {
  return GENERIC_KEYS.has(key.toLowerCase()) ? null : humanise(key);
}

/**
 * A parsed JSON value → the sections that represent it.
 *
 * The shapes, in the order they are recognised:
 *   • array of objects        → one table
 *   • array of scalars        → one single-column table
 *   • object of scalars       → a summary block
 *   • object with arrays      → a summary block for the scalars, a table per array
 *   • long / multi-line string→ a text section (prose that happened to be JSON-wrapped)
 */
function sectionsFromJson(value: unknown, title: string | null = null): ReportSection[] {
  const node = unwrapEnvelope(value);

  if (Array.isArray(node)) {
    if (node.length === 0) {
      return [{ kind: "text", title, text: "No rows were returned." }];
    }
    const objectRows = node.filter(isRecord);
    if (objectRows.length === node.length) return [tableFromObjects(title, objectRows)];
    return [
      {
        kind: "table",
        title,
        columns: [title ? humanise(title) : "Value"],
        rows: node.map((item) => [formatValue(item)]),
      },
    ];
  }

  if (isRecord(node)) {
    const pairs: Array<[string, string]> = [];
    const rest: ReportSection[] = [];

    for (const [key, raw] of Object.entries(node)) {
      // A long or multi-line string is prose, not a summary value — putting a
      // three-paragraph narrative in the right-hand column of a two-column table
      // is how a report becomes unreadable.
      if (typeof raw === "string" && (raw.includes("\n") || raw.length > 200)) {
        rest.push(...sectionsFromText(raw, titleFor(key)));
        continue;
      }
      if (isScalar(raw)) {
        pairs.push([humanise(key), formatValue(raw)]);
        continue;
      }
      rest.push(...sectionsFromJson(raw, titleFor(key)));
    }

    const sections: ReportSection[] = [];
    if (pairs.length > 0) sections.push({ kind: "kv", title, pairs });
    sections.push(...rest);
    return sections.length > 0 ? sections : [{ kind: "text", title, text: "No data." }];
  }

  const text = formatValue(node);
  return sectionsFromText(text, title);
}

/* ──────────────────────────── text → sections ───────────────────────────── */

/** `## Heading` / `**Heading**` / `HEADING:` on a line of its own. */
const MD_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*\*\*(.{1,80}?)\*\*\s*:?\s*$/;
/** `====` or `----` underlining the line above it. */
const SETEXT_RULE = /^\s*(={3,}|-{3,})\s*$/;
/** A markdown separator row: `|---|:--:|`. Its presence is what makes a table a table. */
const MD_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** `Label: value`, optionally bulleted — the shape a model writes a summary in. */
const KV_LINE = /^\s*(?:[-*•]\s+)?\*{0,2}([A-Za-z][\w \-/()%.'&]{0,58}?)\*{0,2}\s*:\s+(\S.*)$/;

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripEmphasis(cell));

/**
 * Prose → sections, recognising the structures a model actually writes.
 *
 * ⚠ This is a **best-effort reader of free text**, and it is written to fall back
 * rather than to guess hard. Anything it does not recognise stays a paragraph and
 * is shown verbatim — a report that renders one block as prose is fine; a report
 * that mangles a sentence into a two-column table because it contained a colon is
 * not. Hence the `KV_LINE` run of two (a single `Note: …` line is prose) and the
 * required divider row for a markdown table.
 */
export function sectionsFromText(input: string, title: string | null = null): ReportSection[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const sections: ReportSection[] = [];

  /** The title the NEXT section takes, from a heading line. Consumed once. */
  let pending: string | null = title;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text.length === 0) return;
    sections.push({ kind: "text", title: pending, text });
    pending = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ── a heading ────────────────────────────────────────────────────────────
    const md = line.match(MD_HEADING) ?? line.match(BOLD_HEADING);
    if (md) {
      flushParagraph();
      pending = stripEmphasis(md[1]);
      continue;
    }
    if (line.trim().length > 0 && SETEXT_RULE.test(lines[i + 1] ?? "")) {
      flushParagraph();
      pending = stripEmphasis(line);
      i += 1;
      continue;
    }
    if (SETEXT_RULE.test(line)) continue;

    // ── a markdown table: header row, divider, then rows ─────────────────────
    if (line.includes("|") && MD_DIVIDER.test(lines[i + 1] ?? "")) {
      flushParagraph();
      const columns = splitRow(line);
      const rows: string[][] = [];
      let cursor = i + 2;
      while (cursor < lines.length && lines[cursor].includes("|")) {
        const cells = splitRow(lines[cursor]);
        // Ragged rows are padded rather than dropped: a missing cell is a gap in
        // the table, a dropped row is a gap in the report.
        while (cells.length < columns.length) cells.push("—");
        rows.push(cells.slice(0, columns.length));
        cursor += 1;
      }
      sections.push({ kind: "table", title: pending, columns, rows });
      pending = null;
      i = cursor - 1;
      continue;
    }

    // ── a run of `Label: value` lines ────────────────────────────────────────
    const kv = line.match(KV_LINE);
    if (kv && (lines[i + 1] ?? "").match(KV_LINE)) {
      flushParagraph();
      const pairs: Array<[string, string]> = [];
      let cursor = i;
      let match: RegExpMatchArray | null;
      while (cursor < lines.length && (match = (lines[cursor] ?? "").match(KV_LINE))) {
        pairs.push([stripEmphasis(match[1]), stripEmphasis(match[2])]);
        cursor += 1;
      }
      sections.push({ kind: "kv", title: pending, pairs });
      pending = null;
      i = cursor - 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  return sections;
}

/* ───────────────────────────────── HTML ─────────────────────────────────── */

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const HEAD_BG = "#f3f4f6";
const ZEBRA = "#fafafa";
const CANVAS = "#f4f5f7";
const ACCENT = "#1f3a8a";

const sectionTitle = (title: string | null): string =>
  title
    ? `<tr><td style="padding:22px 0 8px 0;font:600 14px/20px ${FONT};color:${INK};">${escapeHtml(title)}</td></tr>`
    : "";

function renderTable(section: Extract<ReportSection, { kind: "table" }>): string {
  const numeric = section.columns.map((_, index) => isNumericColumn(section.rows, index));
  const align = (index: number) => (numeric[index] ? "right" : "left");

  const head = section.columns
    .map(
      (column, index) =>
        `<th align="${align(index)}" style="padding:9px 12px;border-bottom:1px solid ${LINE};` +
        `font:600 11px/16px ${FONT};letter-spacing:.06em;text-transform:uppercase;` +
        `color:${MUTED};white-space:nowrap;">${escapeHtml(column)}</th>`,
    )
    .join("");

  const body = section.rows
    .map((row, rowIndex) => {
      const background = rowIndex % 2 === 1 ? ` background:${ZEBRA};` : "";
      const cells = section.columns
        .map(
          (_, index) =>
            `<td align="${align(index)}" style="padding:9px 12px;border-bottom:1px solid ${LINE};` +
            `font:400 13px/19px ${FONT};color:${INK};${background}">` +
            `${escapeHtml(row[index] ?? "—")}</td>`,
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const empty = section.rows.length === 0;
  const emptyRow = empty
    ? `<tr><td colspan="${section.columns.length}" style="padding:12px;font:400 13px/19px ${FONT};color:${MUTED};">No rows.</td></tr>`
    : "";

  return (
    sectionTitle(section.title) +
    `<tr><td style="padding:0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;width:100%;border:1px solid ${LINE};border-radius:6px;">` +
    `<thead style="background:${HEAD_BG};"><tr>${head}</tr></thead>` +
    `<tbody>${body}${emptyRow}</tbody></table></td></tr>`
  );
}

function renderKv(section: Extract<ReportSection, { kind: "kv" }>): string {
  const rows = section.pairs
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td width="42%" style="padding:8px 12px;border-bottom:1px solid ${LINE};` +
        `font:400 13px/19px ${FONT};color:${MUTED};">${escapeHtml(label)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid ${LINE};` +
        `font:600 13px/19px ${FONT};color:${INK};">${escapeHtml(value)}</td>` +
        `</tr>`,
    )
    .join("");

  return (
    sectionTitle(section.title) +
    `<tr><td style="padding:0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;width:100%;border:1px solid ${LINE};border-radius:6px;">` +
    `<tbody>${rows}</tbody></table></td></tr>`
  );
}

function renderText(section: Extract<ReportSection, { kind: "text" }>): string {
  return (
    sectionTitle(section.title) +
    `<tr><td style="padding:${section.title ? "0" : "4px 0 0 0"};font:400 14px/21px ${FONT};` +
    `color:${INK};white-space:pre-wrap;word-break:break-word;">${escapeHtml(section.text)}</td></tr>`
  );
}

const renderSection = (section: ReportSection): string =>
  section.kind === "table"
    ? renderTable(section)
    : section.kind === "kv"
      ? renderKv(section)
      : renderText(section);

/**
 * ⚠ The timestamp is formatted in UTC and says so.
 *
 * The server, the Kestra worker and the reader are not reliably in one timezone,
 * and a report header that says `09:14` without naming a zone is a fact that
 * cannot be checked against anything. `Intl` with an explicit zone, not
 * `toLocaleString()` with the process default.
 */
function stamp(at: Date): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${date} · ${time} UTC`;
}

export type ReportMeta = {
  flowExecutionId?: string | null;
  stepId?: string | null;
  /** Injected so tests are not clock-dependent. Defaults to now. */
  generatedAt?: Date;
};

/**
 * Render one report.
 *
 * `subject` becomes the heading, so the mail's subject line and its title cannot
 * disagree — two names for one report is a question the reader has to resolve.
 */
export function renderReport(input: {
  subject: string;
  body: string;
  meta?: ReportMeta;
  maxRenderedBytes?: number;
}): ReportRenderResult {
  const raw = input.body;
  const trimmed = raw.trim();

  let sections: ReportSection[];
  let shape: "structured" | "text";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      sections = sectionsFromJson(JSON.parse(trimmed));
      shape = "structured";
    } catch {
      // Malformed JSON is not an error the recipient can act on, and refusing
      // here would lose a report over a stray brace. It is prose that looked
      // like JSON, so it is read as prose.
      sections = sectionsFromText(raw);
      shape = "text";
    }
  } else {
    sections = sectionsFromText(raw);
    shape = "text";
  }

  const generatedAt = input.meta?.generatedAt ?? new Date();
  const footerParts = [`Sent by Tether · ${stamp(generatedAt)}`];
  if (input.meta?.flowExecutionId) footerParts.push(`run ${input.meta.flowExecutionId}`);
  if (input.meta?.stepId) footerParts.push(`step ${input.meta.stepId}`);

  const html =
    `<div style="margin:0;padding:0;background:${CANVAS};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:${CANVAS};padding:24px 12px;"><tr><td align="center">` +
    `<table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:720px;background:#ffffff;border:1px solid ${LINE};` +
    `border-radius:8px;">` +
    // ── header ──────────────────────────────────────────────────────────────
    `<tr><td style="padding:22px 26px;border-bottom:3px solid ${ACCENT};">` +
    `<div style="font:600 19px/26px ${FONT};color:${INK};">${escapeHtml(input.subject.trim())}</div>` +
    `<div style="padding-top:4px;font:400 12px/18px ${FONT};color:${MUTED};">` +
    `${escapeHtml(stamp(generatedAt))}</div>` +
    `</td></tr>` +
    // ── body ────────────────────────────────────────────────────────────────
    `<tr><td style="padding:6px 26px 26px 26px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    sections.map(renderSection).join("") +
    `</table></td></tr>` +
    // ── footer ──────────────────────────────────────────────────────────────
    `<tr><td style="padding:14px 26px;border-top:1px solid ${LINE};background:${HEAD_BG};` +
    `font:400 11px/17px ${FONT};color:${MUTED};border-radius:0 0 8px 8px;">` +
    `${escapeHtml(footerParts.join(" · "))}</td></tr>` +
    `</table></td></tr></table></div>`;

  const bytes = Buffer.byteLength(html, "utf8");
  const ceiling = input.maxRenderedBytes ?? MAX_RENDERED_BYTES;
  if (bytes > ceiling) {
    return {
      ok: false,
      status: 422,
      message: "the rendered report is too large to send",
      detail: {
        actual: bytes,
        allowed: ceiling,
        rule: "measured on the rendered HTML in UTF-8 bytes, not on the body that was passed in",
        remedy: "send fewer rows, or split the report across several messages",
      },
    };
  }

  const tables = sections.filter((s) => s.kind === "table").length;
  const rows = sections.reduce(
    (total, s) => total + (s.kind === "table" ? s.rows.length : s.kind === "kv" ? s.pairs.length : 0),
    0,
  );

  return { ok: true, html, shape, tables, rows, bytes };
}
