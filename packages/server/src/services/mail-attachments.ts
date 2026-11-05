/**
 * Attachments on `foundry_email_send` — the pure checks, text or generated.
 *
 * ── Two ways to attach a file, one set of checks ───────────────────────────
 *
 *   1. **Text**: `{name, content}` where `content` is the file's TEXT — a CSV
 *      a code step built, say. Ported from release/beta unchanged: a flow's
 *      steps produce JSON and strings, and the server encodes for Graph.
 *   2. **Generated**: `{name, format, rows}` where `rows` is structured output
 *      (a query's records, a transform's list) and `file-builder.ts` makes the
 *      file — `.csv` from rows, or a binary `.xlsx`.
 *
 * ⚠ **Caller-supplied base64 stays refused.** Accepting it would add a second
 * encoding path whose only producer is a caller working around this one; both
 * forms above end in bytes the SERVER produced.
 *
 * ⚠ **The extension allowlist is the control, not a nicety.** An attachment is
 * delivered to a real mailbox under a name the flow chose. `.html`, `.svg`,
 * `.js`, `.exe` or a double extension (`report.csv.exe`) would turn "the flow
 * attached its data" into "the flow attached something a mail client will run
 * or render". The content type is DERIVED from the extension and never taken
 * from the caller, for the same reason `contentType: "HTML"` is only ever set
 * by `mail-report.ts` (see `MailMessage.contentType`).
 *
 * ⚠ **Refused, never truncated.** A CSV cut at the cap is a wrong file that
 * looks complete — the same rule `mail-report.ts` states for a report.
 */
import { buildRowsFile, type Row } from "./file-builder.js";
import { unwrapEnvelope } from "./mail-report.js";

/** Extension → content type. Derived, never caller-supplied. */
const EXT_TYPES: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Reachable only as a SAVED FILE (`{name, file}`): bytes a step wrote, never text or rows.
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  // A zipped CSV — what a step's library sends when a report is still too large as Excel.
  zip: "application/zip",
};

/** Extensions whose file IS text — the `content` form accepts exactly these. */
const TEXT_EXTS = ["csv", "tsv", "txt", "json"];

/** What `format` may name, and the extension each format must carry. */
const GENERATED_FORMATS = ["csv", "xlsx"];

export type GeneratedFormat = "csv" | "xlsx";

/** What the route accepts — either the file's text, or rows to build it from. */
export type AttachmentInput = {
  name: string;
  /** The text form: the file's TEXT, e.g. a CSV a `code` step built. */
  content?: string;
  /** The generated form: which file `rows` become. */
  format?: GeneratedFormat;
  /** The generated form: structured rows, flattened by `file-builder.ts`. */
  rows?: readonly Row[];
  /**
   * The saved-file form: the id of a file the step saved (`POST /api/steps/files`) — how a large report travels,
   * as the step's own file rather than as rows inside a JSON body.
   */
  file?: string;
  /** The saved file's bytes — filled in by the route from `file`, never by a caller. */
  fileData?: Buffer;
};

/** A checked attachment, ready for the transport and the Email box. */
export type MailAttachment = {
  name: string;
  contentType: string;
  /** The file's bytes. `mail.service.ts` base64-encodes these for Graph. */
  data: Buffer;
  /** The file's text when the file IS text; `null` for a binary `.xlsx`. */
  text: string | null;
  /** Byte length of `data`. */
  bytes: number;
};

export type AttachmentCaps = {
  /** How many files one message may carry. */
  maxCount: number;
  /** Bytes across every attachment on one message. */
  maxTotalBytes: number;
};

export type AttachmentCheck =
  | { ok: true; attachments: MailAttachment[] }
  | { ok: false; status: 422; message: string; detail: Record<string, unknown> };

/**
 * A plain file name with ONE allowed extension: letters, digits, space, `.`,
 * `_`, `-`; no path separators, no leading dot, at most 100 characters.
 * `report.csv.exe` fails because the LAST extension is what a client honours.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,95}\.([A-Za-z0-9]{1,4})$/;

/**
 * Basename for attach_name — same character set as NAME_RE, no extension.
 * Strips commas and path junk so solver drafts cannot 422 at send (UAT cb921665
 * bound the sink quote “in a excel report, email it to me”).
 */
export function sanitizeAttachBaseName(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base = cleaned.replace(/^[.\s_-]+|[.\s_-]+$/g, "") || "report";
  return /^[A-Za-z0-9]/.test(base) ? base : `report ${base}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

function refuse(message: string, detail: Record<string, unknown>): AttachmentCheck {
  return { ok: false, status: 422, message, detail };
}

export function checkAttachments(
  input: readonly AttachmentInput[] | undefined,
  caps: AttachmentCaps,
): AttachmentCheck {
  const list = input ?? [];
  if (list.length === 0) return { ok: true, attachments: [] };

  if (list.length > caps.maxCount) {
    return refuse("too many attachments", { actual: list.length, allowed: caps.maxCount });
  }

  const allowed = Object.keys(EXT_TYPES).map((e) => `.${e}`);
  const seen = new Set<string>();
  const out: MailAttachment[] = [];
  let total = 0;

  for (const [index, a] of list.entries()) {
    const m = NAME_RE.exec(a.name);
    const ext = m?.[1]?.toLowerCase();
    if (!m || !ext || !(ext in EXT_TYPES)) {
      return refuse("attachment name is not allowed", {
        index,
        name: a.name.slice(0, 120),
        rule:
          "a plain file name (letters, digits, space, . _ -; no folders) ending in one of " +
          allowed.join(", "),
      });
    }
    const key = a.name.toLowerCase();
    if (seen.has(key)) {
      return refuse("two attachments share a name", { index, name: a.name });
    }
    seen.add(key);

    // ── Exactly one form: the file's text, rows to build it from, OR a saved file ─
    const hasContent = a.content !== undefined;
    const hasRows = a.rows !== undefined;
    if (a.file !== undefined) {
      if (hasContent || hasRows || a.format !== undefined) {
        return refuse("attachment is both a saved file and text or rows", {
          index,
          name: a.name,
          rule: "pass `file` (a saved file) alone, or `content`, or `format` + `rows`",
        });
      }
      if (!a.fileData) {
        return refuse("the saved file was not found", {
          index,
          name: a.name,
          rule: "attach a file this run saved — `{\"name\": …, \"path\": …}` from a step uploads it",
        });
      }
      if (a.fileData.byteLength === 0) {
        return refuse("attachment is empty", { index, name: a.name, remedy: "omit it, or attach the data" });
      }
      total += a.fileData.byteLength;
      out.push({ name: a.name, contentType: EXT_TYPES[ext]!, text: null, data: a.fileData, bytes: a.fileData.byteLength });
      continue;
    }
    if (hasContent && (hasRows || a.format !== undefined)) {
      return refuse("attachment is both text and generated", {
        index,
        name: a.name,
        rule: "pass `content` (the file's text) or `format` + `rows`, never both",
      });
    }
    if (!hasContent && !hasRows) {
      return refuse("attachment has neither content nor rows", {
        index,
        name: a.name,
        rule: "pass `content` (the file's text) or `format` + `rows`",
      });
    }

    let file: { text: string | null; data: Buffer; bytes: number };

    if (hasContent) {
      if (!TEXT_EXTS.includes(ext)) {
        return refuse("attachment content is text but the name is not a text file", {
          index,
          name: a.name,
          rule:
            "an .xlsx cannot be built from a string — pass `format: \"xlsx\"` and `rows`, " +
            "or name a text extension (.csv, .tsv, .txt, .json)",
        });
      }
      if (a.content!.length === 0) {
        // An empty file delivered is a report of nothing that reads as a report.
        return refuse("attachment is empty", {
          index,
          name: a.name,
          remedy: "omit it, or attach the data",
        });
      }
      const data = Buffer.from(a.content!, "utf8");
      file = { text: a.content!, data, bytes: data.byteLength };
    } else {
      const format = a.format;
      if (!format || !GENERATED_FORMATS.includes(format)) {
        return refuse("generated attachment does not name its format", {
          index,
          name: a.name,
          rule: "pass `format` — one of csv, xlsx",
        });
      }
      if (ext !== format) {
        return refuse("the file name does not match the format", {
          index,
          name: a.name,
          rule: `format ${format} builds a .${format} file — the name must end in .${format}`,
        });
      }
      const built = buildRowsFile(format, a.rows!);
      if (!built.ok) return refuse(built.message, { index, name: a.name, ...built.detail });
      file = built.file;
    }

    total += file.bytes;
    out.push({ name: a.name, contentType: EXT_TYPES[ext]!, ...file });
  }

  if (total > caps.maxTotalBytes) {
    return refuse(
      `attachments are too large: ${(total / 1024 / 1024).toFixed(1)} MB, and one email can carry at most ` +
        `${(caps.maxTotalBytes / 1024 / 1024).toFixed(0)} MB — send a summary, or fewer rows`,
      {
      actual: total,
      allowed: caps.maxTotalBytes,
      rule: "MAIL_MAX_ATTACHMENT_BYTES is the total across every attachment on one message",
    });
  }

  return { ok: true, attachments: out };
}

/** What is recorded about an attachment on EVERY outcome: never its content. */
export function attachmentMeta(list: readonly MailAttachment[]): Array<{ name: string; bytes: number }> {
  return list.map((a) => ({ name: a.name, bytes: a.bytes }));
}

/**
 * What a DRAFT run's row holds so the Email box can hand the file back: text
 * files keep their text, a generated `.xlsx` is base64 and says so. Written on
 * the `captured` path only — see `email_sends.captured_attachments`.
 */
export function attachmentHeld(a: MailAttachment): {
  name: string;
  contentType: string;
  content: string;
  bytes: number;
  encoding?: "base64";
} {
  return {
    name: a.name,
    contentType: a.contentType,
    content: a.text ?? a.data.toString("base64"),
    bytes: a.bytes,
    ...(a.text === null ? { encoding: "base64" as const } : {}),
  };
}

/** The three flat params, as the route receives them. */
export type FlatAttachment = {
  /** The rows, or a step's whole output as JSON text (what the step engine binds) — unwrapped as `body` is. */
  attach_rows?: readonly Row[] | string;
  attach_name?: string;
  attach_format?: GeneratedFormat;
  /** The name used when rows and a format are given and no name — the route passes the message's subject. */
  fallbackName?: string;
};

export type FoldResult =
  | { ok: true; attachments: AttachmentInput[]; skipped: Array<{ name: string; reason: string }> }
  | { ok: false; status: 422; message: string; detail: Record<string, unknown> };

/**
 * `attach_rows` + `attach_name` + `attach_format` → one generated attachment, appended to `attachments`.
 *
 * They exist because the step engine can bind a step's rows to a port and fill two literals, and cannot
 * build the record `attachments` wants. Three rules:
 *
 *   - **All or nothing, by name.** Rows without a name, or a name/format without rows, is a half-declared
 *     file — refused, never guessed. (`attach_format` alone is inferred from the name's extension.) One
 *     exception: rows WITH a stated format and no name take the message's subject as the name (`fallbackName`)
 *     — "email me a csv report" states a file and names nothing, and the subject is what the person reads it as.
 *   - **The extension follows the format.** `"overdue invoices"` + `xlsx` → `overdue invoices.xlsx`, because
 *     a person on the canvas types a name, not a file name. A name ending in the OTHER format's extension is
 *     left alone so `checkAttachments` refuses the mismatch by name.
 *   - ⚠ **No rows is no file, and the email still goes.** A reader bound here returns nothing on a quiet
 *     day; refusing the whole message would turn "nothing overdue" into a failed run. It is REPORTED
 *     (`skipped`), not silent — the general rule that an empty file is refused still holds for
 *     `attachments`, where a person built the file on purpose.
 */
export function foldFlatAttachment(
  attachments: readonly AttachmentInput[] | undefined,
  flat: FlatAttachment,
): FoldResult {
  const list = [...(attachments ?? [])];
  const { attach_rows: given, attach_name: rawName, attach_format: rawFormat, fallbackName } = flat;
  if (given === undefined && rawName === undefined && rawFormat === undefined) {
    return { ok: true, attachments: list, skipped: [] };
  }
  if (given === undefined) {
    return {
      ok: false,
      status: 422,
      message: "attach_name / attach_format given without attach_rows",
      detail: { rule: "a generated file needs the rows to build it from — bind attach_rows to a step's records" },
    };
  }
  const stated = (rawName ?? "").trim();
  // A format was stated and no name: the subject names it — characters a file name cannot hold removed.
  const name = stated || (rawFormat && fallbackName ? fallbackName.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) : "");
  if (!name) {
    return {
      ok: false,
      status: 422,
      message: "attach_rows given without attach_name",
      detail: { rule: "name the file — e.g. attach_name \"overdue invoices\" with attach_format xlsx" },
    };
  }
  const ext = /\.([A-Za-z0-9]{1,4})$/.exec(name)?.[1]?.toLowerCase();
  const format: GeneratedFormat | undefined =
    rawFormat ?? (ext === "csv" || ext === "xlsx" ? ext : undefined);
  if (!format) {
    return {
      ok: false,
      status: 422,
      message: "the attachment's format is not stated",
      detail: { name, rule: "pass attach_format csv or xlsx, or end attach_name in .csv or .xlsx" },
    };
  }
  const fileName = ext === "csv" || ext === "xlsx" ? name : `${name}.${format}`;
  const rows = rowsOf(given);
  if (rows === null) {
    return {
      ok: false,
      status: 422,
      message: "attach_rows is not a list of records",
      detail: {
        name: fileName,
        rule: "bind attach_rows to a step's whole output (a query, a reader, a transform's rows) — its rows become the file",
      },
    };
  }
  if (rows.length === 0) {
    return { ok: true, attachments: list, skipped: [{ name: fileName, reason: "no rows — nothing to attach" }] };
  }
  list.push({ name: fileName, format, rows });
  return { ok: true, attachments: list, skipped: [] };
}

/**
 * Brief body used when an oversized tabular `body` is moved to an attachment.
 * Kept well under `MAIL_MAX_BODY_BYTES` by construction.
 */
export const PROMOTED_BODY_BRIEF =
  "The full results are in the attached file.";

/**
 * A table in a message body past this many rows is a report, not a summary, and goes as a file (2026-10-13) — at any
 * byte size, not only past the body cap. Mirrors BODY_TABLE_MAX_ROWS in the flow-runner SDK, which applies the same
 * rule before the call leaves the step; this is the net for any other caller.
 */
export const BODY_TABLE_MAX_ROWS = 50;

export type PromoteOversizedBodyInput = {
  body: string;
  subject: string;
  maxBodyBytes: number;
  attach_rows?: readonly Row[] | string;
  attach_name?: string;
  attach_format?: GeneratedFormat;
};

export type PromoteOversizedBodyResult = {
  body: string;
  attach_rows?: readonly Row[] | string;
  attach_name?: string;
  attach_format?: GeneratedFormat;
  /** True when we replaced an oversized row dump with a brief body (+ attachment if needed). */
  promoted: boolean;
  /** Bytes of the original body when promoted — for logs / response flags. */
  fromBytes?: number;
};

/**
 * When `body` exceeds the message-body cap **and** it is step output (rows / Foundry
 * envelope JSON), do not refuse: put those rows on an attachment and leave a short
 * note in `body`. Prose that is merely long still fails the ordinary body cap.
 *
 * ⚠ Prefer the builder binding a brief body + `attach_rows`. This is the safety net
 * for flows that dump the whole read into both (the leave-report failure mode).
 *
 * - Attachment already declared → only shrink `body` (do not duplicate the file).
 * - No attachment yet → set `attach_rows` from the body, default format `xlsx`,
 *   name from the subject (same fallback `foldFlatAttachment` uses).
 */
export function promoteOversizedBody(input: PromoteOversizedBodyInput): PromoteOversizedBodyResult {
  const body = input.body ?? "";
  const bytes = Buffer.byteLength(body, "utf8");
  // A short body is checked for being a long TABLE only when it could be one (JSON) — prose is never parsed.
  const longTable = bytes <= input.maxBodyBytes && /^\s*[[{]/.test(body) && (rowsOf(body)?.length ?? 0) > BODY_TABLE_MAX_ROWS;
  if (bytes <= input.maxBodyBytes && !longTable) {
    return {
      body,
      attach_rows: input.attach_rows,
      attach_name: input.attach_name,
      attach_format: input.attach_format,
      promoted: false,
    };
  }
  const rows = rowsOf(body);
  if (!rows || rows.length === 0) {
    // Not tabular output — leave unchanged; `checkMessageCaps` refuses by size.
    return {
      body,
      attach_rows: input.attach_rows,
      attach_name: input.attach_name,
      attach_format: input.attach_format,
      promoted: false,
    };
  }

  const alreadyAttached = input.attach_rows !== undefined;
  if (alreadyAttached) {
    return {
      body: PROMOTED_BODY_BRIEF,
      attach_rows: input.attach_rows,
      attach_name: input.attach_name,
      attach_format: input.attach_format,
      promoted: true,
      fromBytes: bytes,
    };
  }

  return {
    body: PROMOTED_BODY_BRIEF,
    attach_rows: body,
    attach_name: input.attach_name,
    attach_format: input.attach_format ?? "xlsx",
    promoted: true,
    fromBytes: bytes,
  };
}

/**
 * A step's rows from what `attach_rows` carried: the records themselves, or a step's output as JSON text,
 * unwrapped by the REPORT's own `unwrapEnvelope` so a file and a body read one output identically. One record
 * is one row. `null` for anything else — text that is not JSON, a number, a list of non-records — so the
 * route refuses by name rather than attaching a file of nonsense.
 */
function rowsOf(given: readonly Row[] | string): Row[] | null {
  let value: unknown = given;
  if (typeof given === "string") {
    const trimmed = given.trim();
    if (trimmed === "") return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  value = unwrapEnvelope(value);
  const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(value)) return value.every(isRecord) ? (value as Row[]) : null;
  if (isRecord(value)) return [value];
  return null;
}
