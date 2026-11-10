// src/app/(app)/layout.tsx — the authenticated shell. Guards every page inside it:
// if there is no session, it sends the user to /login. Otherwise it renders the
// rail + topbar + alpha notice + the page content. The rail is always on the side; below lg it
// is an icon rail that expands over the page.
//
// ⚠ **Three jobs moved OUT of the page bodies in Phase 3 of ui-upgrade**:
// where you are (the breadcrumb), which workspace you are in (the switcher, up
// out of the rail), and the alpha disclosure. A page that renders its own
// breadcrumb renders it slightly differently from the last one.
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { storedRailCollapsed, storeRailCollapsed } from "@/lib/rail-preference";
import { ActivityProvider } from "@/lib/activity";
import { useAsync } from "@/lib/hooks";
import { listWorkspaces } from "@/lib/api";
import { PERSONAL_PRODUCT } from "@/lib/personal";
import { PermissionsProvider } from "@/lib/permissions";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { PageHeaderProvider } from "@/lib/page-header";

/** The pages the workbench owns — immersive: the rail starts collapsed (D-146). */
const FLOW_WORK_PREFIXES = ["/flows/new", "/chats/new"];

function isFlowWork(pathname: string | null): boolean {
  if (!pathname) return false;
  if (FLOW_WORK_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  // /flows/[id]/builder — both chat and manual building panes
  if (/^\/flows\/[^/]+\/builder/.test(pathname)) return true;
  // /chats/[id] — a chat's one address, live for whoever may continue it (2026-10-30)
  if (/^\/chats\/[^/]+$/.test(pathname)) return true;
  return false;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const { workspaceId } = useWorkspace();

  const router = useRouter();
  const pathname = usePathname();
  /**
   * ⚠ **FR-016 — A PERSON WITH NO WORKSPACE IS SENT SOMEWHERE THAT EXPLAINS IT.**
   *
   * Enterprise: empty list → /no-access. Personal fork: the API ensures a home
   * workspace on list, and we never send anyone to that dead-end page.
   *
   * ⚠ **It redirects on an EMPTY list, never on a FAILED read.** `useAsync` reports those
   * separately, and sending somebody to "you have no access" because the API was
   * unreachable would be telling them they were refused when nobody refused them — the
   * same lie the three-state permission gate exists to prevent.
   */
  const visibleWorkspaces = useAsync(() => listWorkspaces(), []);
  useEffect(() => {
    if (PERSONAL_PRODUCT) {
      // Leftover bookmark / race: bounce off the enterprise dead-end.
      if (pathname === "/no-access") router.replace("/dashboard");
      return;
    }
    if (pathname === "/no-access") return;
    if (visibleWorkspaces.loading || visibleWorkspaces.error) return;
    if ((visibleWorkspaces.data?.length ?? 0) === 0) router.replace("/no-access");
  }, [visibleWorkspaces.loading, visibleWorkspaces.error, visibleWorkspaces.data, pathname, router]);
  /** Below `lg` the rail is an icon rail that expands OVER the page; `smallExpanded` is that transient state. */
  const [isLg, setIsLg] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches);
  const [smallExpanded, setSmallExpanded] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => {
      setIsLg(mq.matches);
      setSmallExpanded(false);
    };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => setSmallExpanded(false), [pathname]);
  /**
   * ⚠ Starts `false` and is corrected in an effect, NEVER read from storage
   * during render. This layout renders on the server first, where `window` does
   * not exist; a render that reads localStorage produces markup the client
   * disagrees with, and React reports that as a hydration error about the whole
   * tree rather than about this line.
   */
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    // D-146: flow-work pages are immersive. The workbench's three-pane layout
    // is arithmetic'd against the COLLAPSED rail (lib/workbench.ts SHELL_CHROME
    // is 68 + 64), so a workbench page with an expanded rail folds the DAG into
    // a sliver at 1440. The user can still toggle the rail open — the workbench
    // then folds gracefully instead of squeezing. The preference re-applies on
    // non-flow-work pages.
    const flowWork = isFlowWork(pathname);
    setRailCollapsed(flowWork ? true : (storedRailCollapsed() ?? false));
  }, [pathname]);

  const toggleRail = () => {
    // Smooth via CSS transition-[width] on Sidebar (200ms var(--ease)), not viewTransition
    // viewTransition + CSS width transition double-animates and flickers, so apply directly
    setRailCollapsed((v) => {
      storeRailCollapsed(!v);
      return !v;
    });
  };

  // Stored preference from `lg` up; default-collapsed below it, whatever was stored.
  const effectiveCollapsed = isLg ? railCollapsed : !smallExpanded;
  const toggleNav = () => (isLg ? toggleRail() : setSmallExpanded((v) => !v));

  // Once the session check is done, bounce out if nobody is signed in.
  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  // Wait for the session check; avoids a flash of the shell before redirecting.
  if (!ready || !user) return null;

  return (
    // ── ⚠ `h-screen overflow-hidden`, NOT `min-h-screen` ────────────────────
    //
    // It was `min-h-screen`, which makes the shell as tall as the PAGE. Two
    // things followed and both were reported from use: the rail stretched to
    // the full document height and scrolled away with the content, and `main`'s
    // own `overflow-y-auto` never engaged, because an element with no bounded
    // height has nothing to overflow.
    //
    // Fixing the height to the viewport is what makes the rail and the topbar
    // fixed furniture and gives the content its own scroll region. The
    // consequence to know about: the document itself no longer scrolls, so
    // anything reaching for `window.scrollTo` will do nothing — scroll the
    // region below instead.
    // ⚠ `ActivityProvider` wraps the SHELL, not the page. One poller for the
    // whole app: the bell reads it, and every page reads its epoch to know when
    // to refetch. A provider inside `<main>` would be torn down and re-mounted
    // by the `key={workspaceId}` below on every workspace switch — losing the
    // notification history and, worse, re-announcing everything already running
    // as newly started.
    /*
     * ⚠ `PermissionsProvider` wraps the SHELL, beside `ActivityProvider` and for the same
     * reason: the sidebar, the topbar and every page ask the same question about the same
     * workspace, and one provider means one read per workspace rather than one per
     * consumer. It is keyed on the active workspace, so switching re-asks.
     *
     * ⚠ It is INSIDE `WorkspaceProvider` (mounted in the root layout) because it needs
     * the active workspace id, and OUTSIDE the `key={workspaceId}` remount below so a
     * switch does not tear down a poll that is already in flight.
     */
    <ActivityProvider>
    <PermissionsProvider workspaceId={workspaceId}>
    <PageHeaderProvider>
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={effectiveCollapsed}
        onToggleCollapsed={toggleNav}
        onNavigate={() => setSmallExpanded(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* The bar carries the rail toggle on small screens, so it replaces
            the old mobile-only header rather than sitting beside it. It is now
            outside the scroll region, so it is genuinely fixed rather than
            `sticky` — which it also still declares, harmlessly. */}
        <Topbar onOpenNav={toggleNav} navExpanded={!effectiveCollapsed} />
        <div className="shell-scroll flex-1 overflow-y-auto">
          {/* Keyed on the workspace: switching remounts every page, so each one
              refetches its (workspace-scoped) data — no per-page wiring needed.
              ⚠ The switcher moved into the topbar in Phase 3; this key is what
              makes that safe, and it did not move with it. */}
          {/* ⚠ The INSET lives here, not in `<Page>` (D-95). Both had it before
              this phase, so `/triggers` — the one migrated page — was padded
              twice. The shell owns the gap between the chrome and the content;
              `Page` owns the measure and the zone rhythm inside it.
              ⚠ Flat 24px side gutter at every breakpoint (mock `.page`), not
              the old 16/24/32 responsive ramp. Vertical stays — the app's
              `PageHeader` (unlike the mock's zone-header) carries no top
              padding, so `py-6` is the pages' top rhythm (L1). */}
          <main key={workspaceId} className="px-6 py-6">
            {/* Route-change entrance: keyed on pathname so every page slides in
             * once, 180ms, opacity + translateY only (compositor — no layout,
             * no paint cost). `body.wb` opts out: the immersive workbench owns
             * its own view-transition and a second entrance would double-animate.
             * Reduced-motion opts out in CSS alongside it. */}
            <div key={pathname} className="page-enter">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
    </PageHeaderProvider>
    </PermissionsProvider>
    </ActivityProvider>
  );
}
