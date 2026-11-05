"use client";
/**
 * A component's configuration as tokens (phase Z, I-320) — the way a workflow tool draws a node: a variable is a chip naming the
 * step (and field) it comes from, an operator is plain, a value is quoted, a run input is a `{x}` chip, a note is dim. Used on the
 * canvas card and in the inspector, so the two cannot draw one binding two ways.
 */
import type { Token } from "@/lib/engine-canvas";

const TONE: Record<Token["k"], string> = {
  var: "rounded border border-[color:var(--accent-line)] bg-accent/10 px-1 font-mono text-accent",
  input: "rounded border border-line bg-surface-2 px-1 font-mono text-text before:mr-0.5 before:text-dim before:content-['{x}']",
  field: "rounded bg-surface-2 px-1 font-mono text-text",
  op: "text-dim",
  value: "text-text",
  dim: "text-dim",
  warn: "rounded border border-warn/40 bg-warn-bg px-1 text-warn",
};

export function Tokens({ tokens, className = "" }: { tokens: Token[]; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 truncate ${className}`} data-testid="tokens">
      {tokens.map((t, i) => <span key={i} className={`shrink-0 truncate ${TONE[t.k]}`} title={t.t}>{t.t}</span>)}
    </span>
  );
}
