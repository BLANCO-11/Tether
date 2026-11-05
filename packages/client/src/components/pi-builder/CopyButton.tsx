"use client";

/**
 * A message's copy button (2026-10-13): a small icon under a person's message or Forge's reply that copies its text.
 * Shown on hover or focus (always on a touch screen), a tick for a moment when it worked, a cross when it did not.
 * The clipboard API needs a secure page; over plain http it falls back to the older copy command.
 */
import { useEffect, useRef, useState } from "react";
import { Copy } from "@/components/ui/icons";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the older way.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      aria-label={state === "done" ? "Copied" : state === "failed" ? "Could not copy" : label}
      title={state === "done" ? "Copied" : state === "failed" ? "Could not copy" : label}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "done" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1500);
      }}
      className={`flex h-6 w-6 items-center justify-center rounded text-dim opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${
        state !== "idle" ? "opacity-100" : ""
      } ${className}`}
    >
      {state === "done" ? (
        <span aria-hidden className="text-[12px] text-accent">
          ✓
        </span>
      ) : state === "failed" ? (
        <span aria-hidden className="text-[12px] text-danger">
          ✕
        </span>
      ) : (
        <Copy s={13} />
      )}
    </button>
  );
}
