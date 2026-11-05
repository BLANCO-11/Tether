"use client";
/**
 * One header bar (2026-10-10). A page that owns a title and its primary actions puts them IN the shell's top bar
 * instead of stacking its own bar under it — the builder stacked four (app bar, panel heads, a model row, the canvas
 * title) and said its status four times. The shell renders what a page sets here; when nothing is set it renders its
 * own breadcrumb, exactly as before.
 *
 * ⚠ Set from an effect and cleared on unmount, so leaving the page can never leave its actions in the bar.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type PageHeader = { title: ReactNode; actions?: ReactNode };

const Ctx = createContext<{ header: PageHeader | null; set: (h: PageHeader | null) => void }>({ header: null, set: () => {} });

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [header, set] = useState<PageHeader | null>(null);
  return <Ctx.Provider value={{ header, set }}>{children}</Ctx.Provider>;
}

/** What the shell's top bar should show for the current page — null: its own breadcrumb. */
export function usePageHeaderSlot(): PageHeader | null {
  return useContext(Ctx).header;
}

/** Put this page's title and actions in the top bar while it is mounted. Pass `deps` that change what it shows. */
export function usePageHeader(header: PageHeader | null, deps: unknown[]): void {
  const { set } = useContext(Ctx);
  useEffect(() => {
    set(header);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => set(null), [set]);
}
