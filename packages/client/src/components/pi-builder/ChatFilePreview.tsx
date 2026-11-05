"use client";

/**
 * A chat file shown in the Files pane (2026-10-13): an image or a PDF as itself, a sheet as a table, a Word document
 * or a text file as its text. Since 2026-10-28 a web page, Markdown, an SVG and code each get their own renderer
 * (FileRenderers.tsx): the page in a sandboxed frame, the document laid out, the picture drawn, code with line numbers. The server renders sheets and documents (`?preview=1`, file-preview.ts); the browser
 * shows images and PDFs straight from the file (`?inline=1`). Anything else says there is no preview and offers the
 * download — never a blank box.
 */
import { useEffect, useState } from "react";
import { Download, Spinner } from "@/components/ui/icons";
import { CodeView, HtmlPreview, MarkdownPreview, SvgPreview, type FileView } from "./FileRenderers";

type Preview =
  | { kind: "table"; sheets: Array<{ name: string; rows: string[][]; totalRows: number; totalCols: number }> }
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "none"; reason: string };

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;
const PLAIN = /\.(txt|log)$/i;
const HTML = /\.html?$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const SVG = /\.svg$/i;
const CODE = /\.(json|xml|ya?ml|css|scss|m?js|cjs|jsx|tsx?|vue|svelte|py|sh|sql|toml|ini|java|kt|go|rs|rb|php|cs|c|h|cpp|swift)$/i;
const SERVER = /\.(xlsx|xlsm|xls|ods|csv|tsv|docx)$/i;
const SHEET = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i;
const TEXT_LIMIT = 200_000;
/** A web page, Markdown or an SVG is SEEN, not read line by line, and a cut one would not render: these get far more. */
const VISUAL_LIMIT = 10_000_000;
const VISUAL = new Set<PreviewKind>(["html", "markdown", "svg"]);

/** How a file of this name is previewed — exported for the tests. */
export type PreviewKind = "image" | "pdf" | "html" | "markdown" | "svg" | "code" | "plain" | "server" | "none";
export function previewKind(name: string): PreviewKind {
  if (IMAGE.test(name)) return "image";
  if (PDF.test(name)) return "pdf";
  if (HTML.test(name)) return "html";
  if (MARKDOWN.test(name)) return "markdown";
  if (SVG.test(name)) return "svg";
  if (CODE.test(name)) return "code";
  if (PLAIN.test(name)) return "plain";
  return SERVER.test(name) ? "server" : "none";
}
/** Read as text in the browser, then drawn by its renderer. */
const AS_TEXT = new Set<PreviewKind>(["plain", "html", "markdown", "svg", "code"]);

const withQuery = (href: string, q: string) => `${href}${href.includes("?") ? "&" : "?"}${q}`;

export function ChatFilePreview({ name, href, view = "page" }: { name: string; href: string | null; view?: FileView }) {
  const kind = previewKind(name);
  const [state, setState] = useState<{ for: string; preview?: Preview; error?: string } | null>(null);
  const [sheet, setSheet] = useState(0);
  // Images and PDFs load in the browser, not through `state` — this is their loading flag.
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    setSheet(0);
    if (!href || (!AS_TEXT.has(kind) && kind !== "server")) return;
    let live = true;
    setState(null);
    (async () => {
      try {
        if (AS_TEXT.has(kind)) {
          const res = await fetch(href, { cache: "no-store" });
          if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
          const text = await res.text();
          const limit = VISUAL.has(kind) ? VISUAL_LIMIT : TEXT_LIMIT;
          if (live) setState({ for: href, preview: { kind: "text", text: text.slice(0, limit), cut: text.length > limit } });
        } else {
          const res = await fetch(withQuery(href, "preview=1"), { cache: "no-store" });
          if (!res.ok) throw new Error(`The preview could not be made (${res.status}).`);
          const { preview } = (await res.json()) as { preview: Preview };
          if (live) setState({ for: href, preview });
        }
      } catch (e) {
        if (live) setState({ for: href, error: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [href, kind]);

  if (!href) return <Note>This file is not saved with the chat yet, so it cannot be shown.</Note>;
  if (kind === "image") {
    return (
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-sunken/40 p-4">
        {shown !== href ? <LoadingOverlay /> : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={withQuery(href, "inline=1")}
          alt={name}
          onLoad={() => setShown(href)}
          onError={() => setShown(href)}
          className={`max-w-full rounded border border-line bg-surface transition-opacity duration-200 ${shown === href ? "opacity-100" : "opacity-0"}`}
        />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <div className="relative flex min-h-0 flex-1">
        {shown !== href ? <LoadingOverlay /> : null}
        <iframe src={withQuery(href, "inline=1")} title={`Preview of ${name}`} onLoad={() => setShown(href)} className="min-h-0 w-full flex-1 border-0" />
      </div>
    );
  }
  if (kind === "none") return <Note href={href} name={name}>There is no preview for this kind of file.</Note>;
  if (!state || state.for !== href) return <Loading shape={SHEET.test(name) ? "table" : "text"} />;
  if (state.error) return <Note href={href} name={name}>{state.error}</Note>;
  const p = state.preview!;
  if (p.kind === "none") return <Note href={href} name={name}>{p.reason}</Note>;
  if (p.kind === "text") {
    const cut = p.cut ? <p className="shrink-0 px-4 py-2 text-caption text-dim">Only the start is shown. Download the file to see all of it.</p> : null;
    const drawn =
      kind === "html" ? <HtmlPreview name={name} text={p.text} view={view} /> :
      kind === "markdown" ? <MarkdownPreview name={name} text={p.text} view={view} /> :
      kind === "svg" ? <SvgPreview name={name} text={p.text} view={view} /> :
      kind === "code" ? <CodeView name={name} text={p.text} /> : null;
    if (drawn) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {drawn}
          {cut}
        </div>
      );
    }
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="whitespace-pre-wrap break-words p-4 font-sans text-[13px] leading-relaxed text-text">{p.text}</pre>
        {p.cut ? <p className="px-4 pb-4 text-caption text-dim">Only the start is shown. Download the file to see all of it.</p> : null}
      </div>
    );
  }
  const s = p.sheets[Math.min(sheet, p.sheets.length - 1)];
  if (!s) return <Note href={href} name={name}>This sheet is empty.</Note>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {p.sheets.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1" role="tablist" aria-label="Sheets">
          {p.sheets.map((x, i) => (
            <button
              key={x.name}
              type="button"
              role="tab"
              aria-selected={i === sheet}
              onClick={() => setSheet(i)}
              className={`shrink-0 rounded px-2 py-0.5 text-[12px] ${i === sheet ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2"}`}
            >
              {x.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]" aria-label={`Sheet ${s.name}`}>
          <tbody>
            {s.rows.map((r, i) => (
              <tr key={i} className={i === 0 ? "bg-surface-2 font-medium text-text" : "text-text"}>
                <td className="sticky left-0 border border-line bg-surface-2 px-1.5 text-right text-[10.5px] text-dim">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j} className="max-w-[260px] truncate border border-line px-2 py-0.5" title={c}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.totalRows > s.rows.length || s.totalCols > (s.rows[0]?.length ?? 0) ? (
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-caption text-dim">
          Showing {s.rows.length} of {s.totalRows} rows{s.totalCols > (s.rows[0]?.length ?? 0) ? ` and ${s.rows[0]?.length ?? 0} of ${s.totalCols} columns` : ""}. Download the file to
          see all of it.
        </p>
      ) : null}
    </div>
  );
}

function Note({ children, href, name }: { children: React.ReactNode; href?: string; name?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted">
      <p>{children}</p>
      {href && name ? (
        <a href={href} download={name} className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12.5px] text-text hover:border-accent/50">
          <Download className="h-3.5 w-3.5" />
          Download {name}
        </a>
      ) : null}
    </div>
  );
}

/** The spinner and its words — the part of every loading state a screen reader announces. */
function LoadingLabel() {
  return (
    <p role="status" className="flex items-center gap-2 text-caption text-muted">
      <Spinner s={14} className="animate-spin text-accent" />
      Loading the preview…
    </p>
  );
}

/**
 * While a sheet or a document is being made: the spinner, and faded bars in the shape of what is coming — a table
 * for a sheet, lines of text for a document — so the wait reads as work and the content lands without a jump.
 */
function Loading({ shape }: { shape: "table" | "text" }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4" aria-busy="true" data-testid="preview-loading">
      <LoadingLabel />
      {shape === "table" ? (
        <div className="grid grid-cols-5 gap-x-3 gap-y-2.5" aria-hidden>
          {Array.from({ length: 45 }, (_, i) => (
            <div key={i}>
              {/* Header row stronger; body cells vary in width so it reads as data, not a slab. */}
              <div className={`skel-bar ${i < 5 ? "opacity-100" : "opacity-60"}`} style={{ width: `${[90, 70, 55, 80, 45][(i * 3) % 5]}%` }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5" aria-hidden>
          {[96, 88, 92, 70, 94, 84, 60].map((w, i) => (
            <div key={i}>
              <div className="skel-bar" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Over an image or a PDF the browser is still fetching. */
function LoadingOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface" aria-busy="true" data-testid="preview-loading">
      <LoadingLabel />
    </div>
  );
}
