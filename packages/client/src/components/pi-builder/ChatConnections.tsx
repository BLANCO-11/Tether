"use client";

import { useEffect, useRef, useState } from "react";
import type { PiAccountChoice } from "@/lib/pi-builder";
import { Link } from "@/components/ui/icons";

/**
 * The connections a Forge Agent chat uses, one per service (chosen on a card the first time Forge needs that service).
 * A quiet control in the chat's top corner, beside "Hide chat" — never in the composer, where the person types. It names
 * the services at a glance; opening it shows whose account each goes through, and Change forgets that choice so Forge
 * asks again on a card the next time — the choice itself is only ever made there.
 */
export function ChatConnections({
  accounts,
  busy,
  onChange,
}: {
  accounts: Record<string, PiAccountChoice>;
  busy: boolean;
  onChange: (piece: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const entries = Object.entries(accounts);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (entries.length === 0) return null;
  const services = entries.map(([, a]) => a.service);
  const summary = services.length === 1 ? services[0]! : `${services.length} connections`;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Connections this chat uses: ${services.join(", ")}`}
        className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface/80 px-2.5 text-[11.5px] text-muted backdrop-blur transition-colors duration-150 hover:border-line-2 hover:text-text"
      >
        <Link s={12} />
        <span className="max-w-[10rem] truncate">{summary}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Connections this chat uses"
          className="absolute right-0 top-9 z-20 w-72 rounded-xl border border-line bg-surface p-1.5 shadow-raised animate-[chatIn_140ms_ease]"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-dim">Connections this chat uses</p>
          <ul className="flex flex-col">
            {entries.map(([piece, a]) => (
              <li key={piece} className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-2">
                <div className="min-w-0 flex-1" title={`Chosen by ${a.chosenBy}${a.identity ? ` · signed in as ${a.identity}` : ""}`}>
                  <p className="text-[13px] font-medium text-text">{a.service}</p>
                  <p className="truncate text-[11.5px] text-muted">
                    {a.personal ? "Your own" : "The workspace's"} · {a.label}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Change the ${a.service} connection for this chat`}
                  onClick={() =>
                    onChange(piece)
                      .then(() => entries.length === 1 && setOpen(false))
                      .catch((e) => setError((e as Error).message))
                  }
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                >
                  Change
                </button>
              </li>
            ))}
          </ul>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-dim">
            {error ? <span className="text-danger">{error}</span> : "After a change, Forge asks which to use the next time it needs that service."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
