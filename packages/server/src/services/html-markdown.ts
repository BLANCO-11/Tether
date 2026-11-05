/**
 * A web page as readable Markdown, for `web_fetch` (2026-10-30). Written here rather than taken from a library: the job
 * is narrow — headings, paragraphs, links, lists, simple tables, emphasis — and what a step or a model needs from a
 * page is its words and its links, not a faithful rendering. Scripts, styles and page furniture (nav, footer, forms)
 * are dropped, because they are what fills a fetch without saying anything.
 *
 * ⚠ Not a sanitiser and not a security boundary: the output is text handed to Python or to `llm_complete`, never
 * rendered as HTML anywhere.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };

/** `&amp;`, `&#39;`, `&#x27;` → the character. Unknown named entities stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const DROP = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "form", "button", "select", "head"];

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const inline = (s: string) => s.replace(/\s+/g, " ").trim();

/** The page's `<title>`, if it has one. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? inline(decodeEntities(m[1]!.replace(/<[^>]+>/g, ""))) : "";
  return t || null;
}

/** HTML → Markdown. `base` resolves relative links. */
export function htmlToMarkdown(html: string, base: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  // Preformatted text keeps its lines; everything else is reflowed.
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    pres.push(decodeEntities(body.replace(/<[^>]+>/g, "")));
    return `\n\n\u0000PRE${pres.length - 1}\u0000\n\n`;
  });
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, body: string) => `\n\n${"#".repeat(Number(n))} ${inline(body.replace(/<[^>]+>/g, " "))}\n\n`)
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, a: string, b: string, c: string, body: string) => {
      const text = inline(body.replace(/<[^>]+>/g, " "));
      const href = absolute(a ?? b ?? c ?? "", base);
      if (!text) return "";
      return href ? `[${text}](${href})` : text;
    })
    .replace(/<img\b[^>]*\balt\s*=\s*"([^"]+)"[^>]*>/gi, (_m, alt: string) => ` ${alt} `)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, body: string) => (inline(body) ? `**${inline(body)}**` : ""))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, body: string) => (inline(body) ? `_${inline(body)}_` : ""))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, body: string) => `\`${inline(body)}\``)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/(p|div|section|article|header|main|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption|h[1-6])\s*>/gi, "\n\n")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => "```\n" + (pres[Number(i)] ?? "").replace(/\n+$/, "") + "\n```");
}
