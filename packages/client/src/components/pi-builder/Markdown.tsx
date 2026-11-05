"use client";

import type { ReactNode } from "react";
import { MermaidDiagram, isDiagram } from "./MermaidDiagram";

/**
 * The little Markdown Pi writes — paragraphs, `-`/`1.` lists, **bold**, `code`, fenced blocks, and ```mermaid diagrams
 * drawn as an image (MermaidDiagram.tsx, 2026-10-29) — rendered as elements (2026-10-10).
 * It reached the chat as raw `**Monthly Employee Working Hours**` and backticks. React elements only: nothing is ever
 * set as HTML, so text from a model cannot become markup.
 */
/**
 * `links`: also render `[text](https://…)` as a link that opens a new tab. Off by default — Pi's chat keeps links as
 * text; a connector's own setup instructions (written by the piece's authors, read before connecting) turn it on.
 * Only `https:` is ever a link.
 */
export function Markdown({ text, links = false }: { text: string; links?: boolean }) {
  const inline = (l: string) => inlineMd(l, links);
  return (
    <div className="space-y-2">
      {fencedParts(text).map((part, k) =>
        part.kind === "fence" ? (
          isDiagram(part.lang) && part.closed ? (
            <MermaidDiagram key={k} code={part.body} />
          ) : (
            <pre key={k} className="overflow-auto rounded-md border border-line bg-sunken/50 p-3 font-mono text-[12.5px] leading-[1.55]">
              {part.body}
            </pre>
          )
        ) : (
          part.text
            .split(/\n{2,}/)
            .filter((b) => b.trim())
            .map((block, i) => <Block key={`${k}-${i}`} lines={block.split("\n")} inline={inline} />)
        ),
      )}
    </div>
  );
}

/**
 * The text cut at fenced blocks (``` or ~~~), each fence kept whole — a blank line inside one does not end it. An
 * unclosed fence runs to the end, as a reader would read it, and is `closed: false`: a reply still streaming in holds a
 * half-written diagram, which is shown as its text until it is whole rather than failing to draw on every update.
 */
export function fencedParts(text: string): Array<{ kind: "text"; text: string } | { kind: "fence"; lang: string; body: string; closed: boolean }> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Array<{ kind: "text"; text: string } | { kind: "fence"; lang: string; body: string; closed: boolean }> = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(lines[i]!);
    if (!open) {
      prose.push(lines[i]!);
      continue;
    }
    if (prose.length) out.push({ kind: "text", text: prose.join("\n") });
    prose = [];
    const body: string[] = [];
    while (++i < lines.length && !lines[i]!.trim().startsWith(open[1]!)) body.push(lines[i]!);
    out.push({ kind: "fence", lang: open[2] ?? "", body: body.join("\n"), closed: i < lines.length });
  }
  if (prose.length) out.push({ kind: "text", text: prose.join("\n") });
  return out;
}

function Block({ lines, inline }: { lines: string[]; inline: (l: string) => ReactNode[] }) {
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return (
      <ul className="list-disc space-y-1 pl-5">
        {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
      </ul>
    );
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return (
      <ol className="list-decimal space-y-1 pl-5">
        {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>)}
      </ol>
    );
  }
  return (
    <p>
      {lines.map((l, j) => (
        <span key={j}>
          {j > 0 ? <br /> : null}
          {inline(l)}
        </span>
      ))}
    </p>
  );
}

/** `code` and **bold** within a line. Unclosed markers stay as written. */
export function inline(line: string): ReactNode[] {
  return inlineMd(line, false);
}

function inlineMd(line: string, links: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const re = links ? /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g : /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > at) out.push(line.slice(at, m.index));
    out.push(
      m[3] !== undefined ? (
        <a key={m.index} href={m[4]} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
          {m[3]}
        </a>
      ) : m[1] !== undefined ? (
        <code key={m.index} className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px] text-text">
          {m[1]}
        </code>
      ) : (
        <strong key={m.index} className="font-semibold text-text">
          {m[2]}
        </strong>
      ),
    );
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}
