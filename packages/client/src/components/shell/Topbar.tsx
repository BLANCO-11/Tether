// src/components/shell/Topbar.tsx — where you are, which workspace you are in,
// and how to get anywhere. Three jobs that used to live in every page body.
//
// ── WHAT THIS TAKES OFF THE PAGES (ui-upgrade Phase 3.1) ──────────────
//
// Before this bar existed:
//   · no page said where it sat — `/runs/r-4f2a` gave you a run and no ancestor;
//   · the workspace switcher was at the top of the LEFT RAIL, so the thing every
//     figure on screen is scoped by sat in the navigation rather than beside the
//     content it scopes;
//   · there was no global way to reach a page by name.
//
// All three are shell concerns. A page that has to render its own breadcrumb is
// a page that renders it slightly differently from the last one.
//
// ⚠ **The workspace switcher REMOUNTS every page when it changes** — that is
// `app/(app)/layout.tsx`'s `key={workspaceId}` on `<main>`, and moving the
// control up here did not change it. Every page therefore refetches its own
// workspace-scoped data with no per-page wiring, which is the property that
// makes a switcher in the shell safe at all.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace";
import { listWorkspaces } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { crumbsFor } from "@/lib/breadcrumb";
import { usePageHeaderSlot } from "@/lib/page-header";
import { ChevronDown, ChevronLeft, Search } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { CommandPalette } from "@/components/shell/CommandPalette";

/**
 * Where a workspace switch lands — the "Home" row in the rail.
 *
 * ⚠ **THE SIXTH LANDING PATH, AND IT MUST STAY IN STEP WITH THE OTHER FIVE.**
 * `app/page.tsx`'s root redirect, `proxy.ts`'s already-signed-in bounce (`middleware.ts` before Next 16), both
 * sign-in buttons and the sidebar lockup all name `/dashboard`; `Sidebar.tsx`'s Home row
 * is `href: "/dashboard"`. They each write the literal today, so this one does too
 * rather than inventing a constant only one of the six imports — a shared constant that
 * five sites ignore is a second answer to "where is home", which is the thing being
 * avoided. If one ever moves, this moves with it.
 */
const HOME_PATH = "/dashboard";

// ⚠ Custom dropdown, not a native `<select>`: the native popup's direction is
// browser-controlled and opened UPWARD in this bar (covering the bar itself).
// `top-full` on an absolutely-positioned list always opens DOWNWARD, in every
// viewport, which is the whole point of this control.
function WorkspaceSwitcher() {
  const { workspaceId, switchWorkspace } = useWorkspace();
  const router = useRouter();
  const { data: spaces, error: spacesError } = useAsync(listWorkspaces);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const sorted = useMemo(
    () =>
      (spaces ?? [])
        .slice()
        .sort(
          (a, b) =>
            (a.kind === "fixture" ? 1 : 0) - (b.kind === "fixture" ? 1 : 0) ||
            a.name.localeCompare(b.name),
        ),
    [spaces],
  );
  const fallbackLabel = spacesError ? "Unavailable — check connection" : spaces ? "Workspace" : "Loading…";
  // ⚠ The fallback row is the selected value when the current id is not in the
  // list (loading / error / unknown id) — same contract the `<select>` had via
  // its extra `<option>`. It is selectable only when it maps to a real id.
  const hasCurrent = sorted.some((w) => w.id === workspaceId);
  const current = sorted.find((w) => w.id === workspaceId);
  const currentLabel = current
    ? current.kind === "fixture"
      ? `${current.name} · test fixture`
      : current.name
    : fallbackLabel;

  // Focus the selected (or first) option on open so arrows + Enter work at once.
  useEffect(() => {
    if (!open) return;
    const el =
      list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      list.current?.querySelector<HTMLElement>('[role="option"]');
    el?.focus();
  }, [open]);

  /** Close the menu and put focus back on the button. Picking nothing does only this. */
  const closeMenu = () => {
    setOpen(false);
    btn.current?.focus();
  };

  /**
   * ⚠ **A SWITCH LANDS ON HOME, AND IT IS A `push` RATHER THAN A `replace`.**
   *
   * Every page under the shell is scoped to a workspace, and a great many of them are
   * scoped to a THING inside one — `/flows/<id>`, `/runs/<id>`, `/resources/<id>`,
   * `/admin/workspaces/<id>` with a dialog open. Switching workspace while standing on
   * one of those leaves the person looking at a page about an object the new workspace
   * does not contain: `<main key={workspaceId}>` remounts it, it refetches, and it
   * renders a 404 or an empty state that reads as *"your data is gone"* rather than
   * *"you are somewhere else now"*.
   *
   * So a switch is a navigation, and it goes to the same place signing in goes —
   * `/dashboard`, which is the "Home" row in the rail and the landing page every other
   * entry path already points at (`app/page.tsx`, `proxy.ts`, both sign-in buttons,
   * the sidebar lockup). A second answer to "where do you land" is how two of them come
   * to disagree.
   *
   * `push`, not `replace`: the page they were on is a real place they were, and Back
   * should return them to it (in the workspace they have now chosen).
   *
   * ⚠ **`switchWorkspace` FIRST, THEN navigate.** It adopts the id into the cache every
   * scoped call reads (`adoptWorkspaceId`); navigating first would let `/dashboard`
   * mount and fetch against the workspace being switched away from — the I-103 defect,
   * reintroduced from the other end.
   *
   * ⚠ **Nothing happens when the pick is the current workspace.** Not even the
   * navigation: choosing the workspace you are already in must not throw away the page
   * you are reading.
   */
  const pick = (id: string) => {
    closeMenu();
    if (id === workspaceId) return;
    switchWorkspace(id);
    router.push(HOME_PATH);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      // ⚠ Buttons fire click on Enter/Space natively; the guard is for when
      // focus somehow lands on the list itself rather than an option.
      if (document.activeElement === list.current) {
        e.preventDefault();
        items[Math.max(i, 0)]?.click();
      }
    }
  };

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-label="Switch workspace"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="relative flex h-8 max-w-[200px] items-center gap-2 rounded-md pl-2 pr-7 text-body font-medium text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown s={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted" />
      </button>
      {open && (
        <>
          {/* click-catcher to close (same pattern as BuilderComposer's menu) */}
          <button type="button" aria-label="Close workspace menu" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default bg-transparent" />
          <ul
            ref={list}
            role="listbox"
            aria-label="Switch workspace"
            onKeyDown={onListKey}
            className="depth-6 absolute left-0 top-full z-50 mt-1.5 max-h-[320px] w-60 overflow-y-auto rounded-lg border border-line p-1"
          >
            {sorted.map((w) => {
              const label = w.kind === "fixture" ? `${w.name} · test fixture` : w.name;
              const selected = w.id === workspaceId;
              return (
                <li key={w.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(w.id)}
                    className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-body hover:bg-surface-2 focus-visible:bg-surface-2 focus:outline-none ${selected ? "font-medium text-text" : "text-text"}`}
                  >
                    <span className="truncate">{label}</span>
                    {selected && (
                      <span className="ml-auto pl-2 text-accent" aria-hidden>
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {!hasCurrent && (
              <li role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected
                  onClick={closeMenu}
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-body text-dim hover:bg-surface-2 focus-visible:bg-surface-2 focus:outline-none"
                >
                  <span className="truncate">{fallbackLabel}</span>
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = crumbsFor(pathname);
  // A page that owns its title and actions (the builder) puts them here — one bar, not one per pane.
  const pageHeader = usePageHeaderSlot();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Converged Back: /chats/new and /flows/[id]/builder redundant Back moved to navbar. A new conversation is a CHAT
  // (2026-10-30), so its trail and its Back go to Chats, never to Workflows.
  const isNewChat = pathname === "/chats/new";
  const isBuilder = pathname.endsWith("/builder") && pathname.startsWith("/flows/");
  const builderFlowId = isBuilder ? pathname.split("/")[2] : null;

  /**
   * ⚠ ONE Back control for the whole shell, always the leftmost element in the
   * bar — every route gets it, not only the two that used to carry their own.
   * `/chats/new` and the builder keep their specific destination (the flow they
   * came from, or the list) rather than raw history, because that is a more
   * predictable "back" than whatever the browser happened to visit before this
   * tab landed here (a bookmark, a reload, a link from outside the app). Every
   * other route falls through to `router.back()` — the literal previous route.
   */
  /*
   * Back appears only BELOW a destination (a workflow, a run, a form, an admin sub-page). On a page the rail opens
   * directly, "back" has nowhere in the product to go and could take a person out of the app.
   */
  const showBack = pathname.split("/").filter(Boolean).length >= 2;
  const parentPath = "/" + pathname.split("/").filter(Boolean).slice(0, -1).join("/");

  const goBack = () => {
    if (isBuilder) {
      router.push(builderFlowId ? `/flows/${builderFlowId}` : "/flows");
      return;
    }
    if (isNewChat) {
      router.push("/chats");
      return;
    }
    // Opened straight from a link there is no history to go back through; go up a level instead.
    if (typeof window !== "undefined" && window.history.length <= 1) {
      router.push(parentPath);
      return;
    }
    router.back();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !paletteOpen &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  return (
    <>
      {/* ⚠ `bg-bg` is opaque, not the mock's translucent `color-mix`. `--bg` has no
        RGB triplet in `tailwind.config.ts`, so `bg-bg/90` would be silently
        DROPPED by Tailwind rather than flagged — an invisible bar with no error.
        Adding the triplet is a five-place token edit for a blur nobody asked for. */}
      <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-3 border-b border-line bg-bg px-4 sm:px-5">
        {showBack && (
          <IconButton label="Back" onClick={goBack}>
            <ChevronLeft s={18} />
          </IconButton>
        )}
        {/* The workspace is the root of where you are — every figure on screen is scoped by it — so it leads the trail. */}
        <WorkspaceSwitcher />
        <span className="hidden text-line lg:inline" aria-hidden>
          /
        </span>
        <nav
          aria-label="Breadcrumb"
          className="hidden min-w-0 flex-1 items-center gap-2 text-body text-muted lg:flex"
        >
          {pageHeader ? (
            <>
              {crumbs[0]?.href ? (
                <Link href={crumbs[0].href} className="shrink-0 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  {crumbs[0].label}
                </Link>
              ) : (
                <span className="shrink-0">{crumbs[0]?.label}</span>
              )}
              <span className="text-line" aria-hidden>
                /
              </span>
              <span aria-current="page" className="flex min-w-0 items-center gap-2 text-text">
                {pageHeader.title}
              </span>
            </>
          ) : isNewChat || isBuilder ? (
            <>
              <Link href={isNewChat ? "/chats" : "/flows"} className="truncate hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                {isNewChat ? "Chats" : "Workflows"}
              </Link>
              <span className="text-line" aria-hidden>
                →
              </span>
              <span aria-current="page" className="truncate font-medium text-text">
                {isNewChat ? "New chat" : "Builder"}
              </span>
              {isBuilder && <span className="hidden sm:inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted/60">
                Draft
              </span>}
            </>
          ) : (
            crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-2">
                {i > 0 && <span className="text-line" aria-hidden>/</span>}
                {c.href ? (
                  <Link
                    href={c.href}
                    className="truncate hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="truncate text-text">
                    {c.label}
                  </span>
                )}
              </span>
            ))
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* The page's own actions, then a divider, then what is the same on every page. */}
          {pageHeader?.actions ? (
            <>
              <div className="flex items-center gap-2">{pageHeader.actions}</div>
              <span aria-hidden className="mx-2 h-5 w-px bg-line" />
            </>
          ) : null}


          {/* Wide screens get a field-shaped control so search is visibly there; narrow ones the icon. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search workflows, runs, resources (⌘K or /)"
            className="mr-1 hidden h-8 w-56 items-center gap-2 rounded-md border border-line bg-surface/60 pl-2.5 pr-1.5 text-body text-dim transition-colors duration-150 hover:border-line-2 hover:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:flex"
          >
            <Search s={14} />
            <span className="flex-1 truncate text-left">Search…</span>
            <kbd className="rounded border border-line px-1 font-sans text-[10px] text-dim" aria-hidden>
              ⌘K
            </kbd>
          </button>
          <IconButton label="Search workflows, runs, resources (⌘K or /)" onClick={() => setPaletteOpen(true)} className="md:hidden">
            <Search s={16} />
          </IconButton>

          <NotificationBell />
          <ThemeToggle />
          {pageHeader?.endActions ? <div className="ml-0.5 flex items-center gap-1">{pageHeader.endActions}</div> : null}
        </div>
      </header>
      <CommandPalette open={paletteOpen} onOpen={() => setPaletteOpen(true)} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
