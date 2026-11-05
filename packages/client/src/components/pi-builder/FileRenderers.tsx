"use client";

/**
 * How a text file is SHOWN in the Files pane (2026-10-28): a web page as the page, Markdown as a document, an SVG as a
 * picture, code as code with line numbers. Each has a Source view beside it.
 *
 * ⚠ A page Forge wrote runs ONLY in a sandboxed frame: `sandbox="allow-scripts"` without `allow-same-origin` gives it
 * an opaque origin (no Foundry cookies, storage, pages or API), and a Content-Security-Policy put at the top of the page
 * allows no network at all, so it cannot fetch, post or load anything from outside. Nothing here uses
 * `dangerouslySetInnerHTML`: Markdown and code are built as React elements, so their text can never become markup.
 */
import { useMemo, type ReactNode } from "react";
import { MermaidDiagram, isDiagram } from "./MermaidDiagram";

/** No network, no forms, no frames inside it: inline script and style only, images and fonts from data/blob. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; frame-src 'none'; base-uri 'none'";

/** The page as the frame gets it: the policy first, so it applies before anything in the page can run. */
export function sandboxedPage(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">\n${html}`;
}

/** Page or its source. The toggle lives in the Files pane's one toolbar (PiSidePane), not over the preview. */
export type FileView = "page" | "source";

export function HtmlPreview({ name, text, view = "page" }: { name: string; text: string; view?: FileView }) {
  return (
    <>
      {view === "page" ? (
        <iframe
          title={`Preview of ${name}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={sandboxedPage(text)}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          data-testid="html-preview"
        />
      ) : (
        <CodeView name={name} text={text} />
      )}
    </>
  );
}

export function SvgPreview({ name, text, view = "page" }: { name: string; text: string; view?: FileView }) {
  // An SVG shown as an image runs no script and loads nothing.
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, [text]);
  return (
    <>
      {view === "page" ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-sunken/40 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={name} className="max-w-full rounded border border-line bg-surface" />
        </div>
      ) : (
        <CodeView name={name} text={text} />
      )}
    </>
  );
}

export function MarkdownPreview({ name, text, view = "page" }: { name: string; text: string; view?: FileView }) {
  return (
    <>
      {view === "page" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <article className="mx-auto max-w-[760px] px-6 py-5 text-[14px] leading-relaxed text-text" data-testid="markdown-preview">
            {markdownBlocks(text)}
          </article>
        </div>
      ) : (
        <CodeView name={name} text={text} />
      )}
    </>
  );
}

/** The word for the rendered view of a file that has one (and a Source view beside it); null when it has only one. */
export function renderedViewLabel(name: string): string | null {
  return /\.html?$/i.test(name) ? "Page" : /\.(md|markdown)$/i.test(name) ? "Document" : /\.svg$/i.test(name) ? "Picture" : null;
}

export function ViewToggle({ label, view, onView }: { label: string; view: FileView; onView: (v: FileView) => void }) {
  return (
    <div className="pis-seg" role="tablist" aria-label="View">
      {(["page", "source"] as const).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onView(v)} className={view === v ? "on" : undefined}>
          {v === "page" ? label : "Source"}
        </button>
      ))}
    </div>
  );
}

// ── code ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  (
    "import export from default function return const let var if else for while do switch case break continue new class extends " +
    "async await try catch finally throw typeof instanceof in of this null undefined true false def lambda pass yield with as " +
    "elif None True False and or not is self public private protected static void int string bool interface type enum package fn " +
    "struct impl mut use match select insert update delete where join on group by order limit create table"
  ).split(" "),
);
export const MAX_CODE_LINES = 5_000;
const HASH_COMMENTS = /\.(py|sh|ya?ml|toml|ini|rb|r)$/i;

/** One line split into coloured pieces: comments, strings, numbers and keywords. Approximate by design. */
export function tokens(line: string, hashComments: boolean): Array<{ t: string; k?: "c" | "s" | "n" | "k" }> {
  const out: Array<{ t: string; k?: "c" | "s" | "n" | "k" }> = [];
  const re = hashComments
    ? /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g
    : /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > at) out.push({ t: line.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ t: m[1], k: "c" });
    else if (m[2] !== undefined) out.push({ t: m[2], k: "s" });
    else if (m[3] !== undefined) out.push({ t: m[3], k: "n" });
    else out.push(KEYWORDS.has(m[4]!) ? { t: m[4]!, k: "k" } : { t: m[4]! });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ t: line.slice(at) });
  return out;
}

const TOKEN_CLASS = { c: "text-dim italic", s: "text-ok", n: "text-warn", k: "text-accent font-medium" } as const;

export function CodeView({ name, text }: { name: string; text: string }) {
  const shown = useMemo(() => {
    if (/\.json$/i.test(name)) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }
    return text;
  }, [name, text]);
  const hash = HASH_COMMENTS.test(name);
  const all = shown.replace(/\r\n/g, "\n").split("\n");
  // A very long file shows its first lines as code: tens of thousands of rows would freeze the page.
  const lines = all.length > MAX_CODE_LINES ? all.slice(0, MAX_CODE_LINES) : all;
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-sunken/30" data-testid="code-view">
      {all.length > lines.length ? (
        <p className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-1.5 text-caption text-dim">
          Showing the first {MAX_CODE_LINES.toLocaleString()} of {all.length.toLocaleString()} lines. Download the file to see all of it.
        </p>
      ) : null}
      <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.55]">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="sticky left-0 select-none bg-sunken/60 px-3 text-right align-top text-[11px] text-dim">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all px-3 align-top text-text">
                {tokens(l, hash).map((p, j) =>
                  p.k ? (
                    <span key={j} className={TOKEN_CLASS[p.k]}>
                      {p.t}
                    </span>
                  ) : (
                    p.t
                  ),
                )}
                {l === "" ? "​" : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Markdown, as a document ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Headings, paragraphs, lists, quotes, rules, fenced code, tables, and ```mermaid diagrams (drawn as an image,
 * MermaidDiagram.tsx). Raw HTML inside Markdown stays text.
 */
export function markdownBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(
        isDiagram(fence[2]) ? (
          <MermaidDiagram key={key()} code={body.join("\n")} />
        ) : (
          <pre key={key()} className="my-3 overflow-auto rounded-md border border-line bg-sunken/50 p-3 font-mono text-[12.5px] leading-[1.55]">
            {body.join("\n")}
          </pre>
        ),
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const size = ["text-[22px]", "text-[18px]", "text-[16px]", "text-[14.5px]", "text-[14px]", "text-[13.5px]"][h[1]!.length - 1];
      out.push(
        <div key={key()} role="heading" aria-level={h[1]!.length} className={`${size} mb-2 mt-5 font-semibold text-text first:mt-0`}>
          {inlineDoc(h[2]!)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} className="my-4 border-line" />);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key()} className="my-3 overflow-auto">
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className="border border-line bg-surface-2 px-2 py-1 text-left font-medium">{inlineDoc(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k} className="border border-line px-2 py-1">{inlineDoc(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key()} className="my-3 border-l-2 border-line pl-3 text-muted">
          {inlineDoc(body.join(" "))}
        </blockquote>,
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(lines[i++]!.replace(re, ""));
      const List = re === bullet ? "ul" : "ol";
      out.push(
        <List key={key()} className={`my-2 space-y-1 pl-5 ${re === bullet ? "list-disc" : "list-decimal"}`}>
          {items.map((t, j) => (
            <li key={j}>{inlineDoc(t.replace(/^\[( |x)\]\s+/i, (_, x) => (x === " " ? "☐ " : "☑ ")))}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    out.push(
      <p key={key()} className="my-2">
        {inlineDoc(para.join(" "))}
      </p>,
    );
  }
  return out;
}

/** `code`, **bold**, *italic*, and [links](https://…) that open a new tab. Images are shown as their alt text. */
export function inlineDoc(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?:^|(?<=\s))[*_]([^*_]+)[*_]|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = m.index;
    if (m[1] !== undefined) out.push(<code key={k} className="rounded bg-sunken px-1 py-0.5 font-mono text-[12.5px]">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k} className="font-semibold">{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4] !== undefined) out.push(<span key={k} className="text-muted">[{m[4] || "image"}]</span>);
    else
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {m[5]}
        </a>,
      );
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
