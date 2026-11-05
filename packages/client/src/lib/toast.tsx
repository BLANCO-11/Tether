// src/lib/toast.tsx — lightweight toasts so every action confirms itself.
// Wrap the app in <ToastProvider>; call useToast() to show one.
//
//   const toast = useToast();
//   toast.success("Saved");            // green
//   toast.error("Could not save: …");  // red
//   toast.warn("Heads up: …");         // amber
//   toast("Copied");                   // neutral — for a message that is neither a success nor a failure
//
// Every toast is the same width, sits bottom-right, and goes away after 6 seconds (a click dismisses it sooner).
// The type is shown by colour AND by an icon, so it does not rest on colour alone. Colours are the same tokens
// `Notice` uses, so a toast and a banner of one tone look related and follow the light/dark theme.
"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Alert, Check, Close, Info } from "@/components/ui/icons";
import { TOAST_MS } from "@/lib/toast-timing";

export type ToastKind = "success" | "error" | "warn" | "info";
type Toast = { id: number; text: string; kind: ToastKind };

export type ToastFn = ((text: string) => void) & {
  success: (text: string) => void;
  error: (text: string) => void;
  warn: (text: string) => void;
};


const noop = () => {};
const NOOP_TOAST: ToastFn = Object.assign((_: string) => {}, { success: noop, error: noop, warn: noop });
const ToastContext = createContext<ToastFn>(NOOP_TOAST);

const LOOK: Record<ToastKind, { box: string; icon: React.ReactNode }> = {
  success: { box: "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] bg-ok-bg text-ok", icon: <Check className="h-4 w-4" /> },
  error: { box: "border-danger-line bg-danger-bg text-danger", icon: <Close className="h-4 w-4" /> },
  warn: { box: "border-warn-line bg-warn-bg text-warn", icon: <Alert className="h-4 w-4" /> },
  info: { box: "border-line bg-surface-2 text-text", icon: <Info className="h-4 w-4" /> },
};

let seq = 0;

/** Provides toast() and renders the stack in the bottom-right. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback(
    (kind: ToastKind, text: string) => {
      const id = (seq += 1);
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  // Stable identity: callers put `toast` in effect dependency lists.
  const toast = useMemo<ToastFn>(
    () =>
      Object.assign((text: string) => show("info", text), {
        success: (text: string) => show("success", text),
        error: (text: string) => show("error", text),
        warn: (text: string) => show("warn", text),
      }),
    [show],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            data-kind={t.kind}
            className={`pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md border px-4 py-2.5 text-left text-sm shadow-lg ${LOOK[t.kind].box}`}
          >
            <span className="mt-0.5 shrink-0" aria-hidden>{LOOK[t.kind].icon}</span>
            <span className="min-w-0 flex-1 break-words text-text">{t.text}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Show a toast: `const toast = useToast(); toast.success("Saved")`. */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}
