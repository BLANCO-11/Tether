"use client";

import { useState } from "react";

/**
 * A connector's logo, or its initial.
 *
 * ⚠ The server only ever passes a logo from Activepieces' CDN (anything else arrives as null), and it is rendered as
 * an `<img>` — never inlined markup — with no referrer, so the CDN learns nothing about this deployment's pages.
 * `alt=""` because the name is always rendered as text beside it. A logo that fails to load falls back to the initial
 * rather than a broken-image box.
 */
export function ConnectorMark({ logoUrl, name, size = 40 }: { logoUrl: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2"
      style={{ width: size, height: size }}
    >
      {logoUrl && !failed ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-[66%] w-[66%] object-contain"
        />
      ) : (
        <span className="text-sm font-semibold text-dim" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
