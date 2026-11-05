// src/components/ui/CopyableId.tsx — a fixed-width, truncated id with a
// copy-to-clipboard button before it. Shared by History's Workflow ID and Run
// ID columns (see app/(app)/history/page.tsx) so the truncation rule and the
// copy/toast behavior live in exactly one place.
"use client";

import Link from "next/link";
import { useToast } from "@/lib/toast";
import { Copy } from "./icons";

const TRUNCATE_CHARS = 5;

/**
 * `id` is opaque — a uuid, most of the time. Truncation is display-only: the
 * full value is always what gets copied, and what `title` exposes on hover.
 * `null` renders "—" with no copy button, since there is nothing to copy.
 *
 * `href`, when given, makes the truncated text a link to the id's own detail
 * page — the copy button stays a plain SIBLING, never nested inside the
 * link, so the two controls (copy vs navigate) cannot conflict or produce a
 * button-inside-an-anchor accessibility hazard.
 */
export function CopyableId({ id, href }: { id: string | null; href?: string }) {
  const toast = useToast();

  if (!id) {
    return <span className="font-mono text-xs text-muted">—</span>;
  }

  const short = `${id.slice(0, TRUNCATE_CHARS)}…`;

  const copy = () => {
    // ⚠ Best effort, same shape as FlowIntegrationPanel.tsx / AllowRequest.tsx:
    // `navigator.clipboard` is absent over plain http on a non-localhost
    // origin, and a button that silently does nothing is worse than one that
    // says it couldn't. Both branches report themselves — see Constitution V.
    navigator.clipboard
      ?.writeText(id)
      .then(() => toast.success("Copied to clipboard"))
      .catch(() => toast.error("Could not copy — try selecting it manually"));
    if (!navigator.clipboard) toast.error("Could not copy — try selecting it manually");
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button
        type="button"
        aria-label="Copy id"
        onClick={copy}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Copy s={13} />
      </button>
      {href ? (
        <Link
          href={href}
          title={id}
          className="truncate font-mono text-xs text-muted hover:text-accent hover:underline"
        >
          {short}
        </Link>
      ) : (
        <span title={id} className="truncate font-mono text-xs text-muted">
          {short}
        </span>
      )}
    </span>
  );
}
