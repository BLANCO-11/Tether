// src/lib/rail-preference.ts — is the navigation rail collapsed? One reader of
// one key, the same shape `lib/workspace-choice.ts` and `lib/theme.ts` take.
//
// ── ⚠ WHY THIS IS ITS OWN MODULE AND ON THE STORAGE ALLOWLIST ───────────────
//
// `scripts/ui-honesty-check.sh` holds a NAMED SET of files allowed to touch
// browser storage, because the defect it guards is a shipped shadow database —
// the deleted `lib/mockdb.ts`, which answered from localStorage whenever the
// server errored. The allowlist is not a formality: adding a file to it is a
// deliberately visible edit, and it is only correct for a **UI preference**.
//
// This is one. It holds a boolean about how wide a menu is. It is not tenant
// data, nothing is read from it that the server also knows, and losing it costs
// one click.
//
// ⚠ **Reads must survive server-side rendering.** This module is imported by the
// shell, which Next renders on the server first, where `window` does not exist.
// Every function here checks — and the layout applies the stored value in an
// effect rather than in initial state, so the server-rendered markup and the
// first client render agree. Reading storage during render is a hydration
// mismatch, which React reports as a wall of text about the whole tree.

const KEY = "foundry.rail.collapsed";

/** The stored preference, or `null` when nobody has chosen — never a default. */
export function storedRailCollapsed(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : raw === "1";
  } catch {
    // Private browsing, a blocked origin, a full quota. A preference that cannot
    // be read is the same as one nobody set.
    return null;
  }
}

export function storeRailCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, collapsed ? "1" : "0");
  } catch {
    /* see above — failing to remember a menu width is not worth an error */
  }
}
