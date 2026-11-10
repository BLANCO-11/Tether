// src/components/shell/Sidebar.tsx — Foundry's left rail: logo lockup, primary action, nav
// grouped per pack's information architecture (04), and the user at the foot.
// Always on the side as a rail: 240px expanded, 57px icon rail collapsed, at every width. Below `lg` it
// starts collapsed and expands OVER the page (with a fading scrim); from `lg` up it pushes the content.
//
// ⚠ **The design handoff pack defined the app shell** (pack record removed 2026-09-11;
// the rail below is the surviving implementation). Every child href
// is a real filter the destination list reads from the URL — a rail that looks like
// a filter and behaves like a link to one unfiltered page is a defect.
// ⚠ **Datasources vs Resources:** Datasources OWNS `/resources/new` while Resources
// owns `/resources` — a prefix match would light both, so longest-claim wins and
// exactly one nav item is ever active (pathname only; query is a filter, not a
// destination). `/` is exact or Home is active everywhere.
// ⚠ **Two things left this file in Phase 3 of `ui-upgrade` and must not
// come back**: the workspace switcher and the theme control, both now in
// `components/shell/Topbar.tsx`. There must be exactly one of each.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { getMe, listPendingApprovals } from "@/lib/api";
import { listEdgePending } from "@/lib/edge";
import { PERSONAL_PRODUCT } from "@/lib/personal";
import { useAsync } from "@/lib/hooks";
import { usePermissions } from "@/lib/permissions";
import { useActivityEpoch } from "@/lib/activity";
import { Chat, Folder, Workflow, Wrench, Activity, CheckCheck, Shield, Building, Database, Key, Bolt, ChevronLeft, Home, Plus, Cube, Mail, LogOut, Apps, User, Sparkle } from "@/components/ui/icons";
import { AlphaChip } from "@/components/shell/AlphaChip";

// ── Pack nav: 04 § nav rail — the full product, not just the 5-row prototype ──
// Prototype capture (23-shells-showcase) shows Home · Workflows · Approvals 3 · Runs & Activity · Dashboards & Reports.
// Full registry (04) adds Datasources · Resources · Admin on top. Children are real filters; the list reads them from
// the URL. `ownedPaths` extends the claim beyond `href` for the Datasources/Resources split.
export type NavChild = { href: string; label: string };
export type NavItem = {
  href: string;
  label: string;
  Icon: (p: { s?: number }) => JSX.Element;
  badgeHref?: string;
  tag?: string;
  superAdminOnly?: boolean;
  /** The cost report is an Admin's: shown only when the server says this person may open it (`/api/me`). */
  needsReports?: boolean;
  /** Shown only when the server says this person may manage who signs in (`userAdmin` on `/api/me`). */
  userAdminOnly?: boolean;
  ownedPaths?: string[];
  children?: NavChild[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

export const groups: NavGroup[] = [
  {
    label: null,
    items: [
      {
        href: "/dashboard",
        label: "Home",
        Icon: Home,
        ownedPaths: ["/dashboard"],
      },
      {
        href: "/workflows",
        label: "Workflows",
        Icon: Workflow,
        ownedPaths: ["/flows"],
        children: [
          { href: "/workflows?view=all", label: "All" },
          { href: "/workflows?view=mine", label: "Mine" },
          { href: "/workflows?view=live", label: "Live" },
          { href: "/workflows?view=scheduled", label: "Scheduled" },
          { href: "/workflows?view=drafts", label: "Drafts" },
          { href: "/workflows?view=suspended", label: "Suspended" },
        ],
      },
      /** Saved chats with Forge (0095): every conversation, from its first message, kept until someone deletes it. */
      {
        href: "/chats",
        label: "Chats",
        Icon: Chat,
        ownedPaths: ["/chats"],
      },
      /** Projects (sharing-boundaries phase 5): smaller circles with shared instructions. */
      {
        href: "/projects",
        label: "Projects",
        Icon: Folder,
        ownedPaths: ["/projects"],
      },
      ...(PERSONAL_PRODUCT
        ? [
            {
              href: "/memory",
              label: "Memory",
              Icon: Sparkle,
              ownedPaths: ["/memory"],
            },
          ]
        : []),
      {
        href: "/approvals",
        // Personal: one morning inbox for gates + agent questions (Phase 1.3) — unify, don't add.
        label: PERSONAL_PRODUCT ? "Needs you" : "Approvals",
        Icon: CheckCheck,
        badgeHref: "/approvals?tab=pending-me",
        children: PERSONAL_PRODUCT
          ? [
              { href: "/approvals?tab=pending-me", label: "Waiting" },
              { href: "/approvals?tab=history", label: "History" },
            ]
          : [
              { href: "/approvals?tab=pending-me", label: "Pending me" },
              { href: "/approvals?tab=requested-by-me", label: "Requested by me" },
              { href: "/approvals?tab=delegated", label: "Delegated" },
              { href: "/approvals?tab=history", label: "History" },
            ],
      },
    ],
  },
  {
    label: "Resources",
    items: [
      {
        href: "/resources?type=datasource",
        label: "Data sources",
        Icon: Database,
        ownedPaths: ["/data-sources", "/data-sources/new", "/resources?type=datasource"],
        children: [
          { href: "/data-sources/new", label: "Onboard a data source" },
          { href: "/resources?type=datasource", label: "All data sources" },
        ],
      },
      {
        href: "/tools",
        label: "Tools",
        Icon: Wrench,
        ownedPaths: ["/tools"],
      },
      /**
       * Connectors (plans/plugins-2026-10-27): the marketplace and this workspace's connected services. Beside Tools,
       * because an enabled connector action IS a tool row — the same thing reached from its service rather than its URL.
       */
      {
        href: "/apps",
        label: "Connectors",
        Icon: Apps,
        ownedPaths: ["/apps"],
      },
      {
        href: "/keys",
        label: "Credentials",
        Icon: Key,
        ownedPaths: ["/keys"],
      },
      /**
       * The Email box — what automations tried to email, and what was HELD
       * because the run was a draft (migration 0058).
       *
       * ⚠ It lives under Resources rather than Admin deliberately: it is
       * something whoever BUILDS an automation needs while testing it, not an
       * operator surface. A test run never delivers, so this is the only place
       * the message it would have sent can be read.
       */
      {
        href: "/email-box",
        label: "Email box",
        Icon: Mail,
        ownedPaths: ["/email-box"],
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/triggers",
        label: "Triggers",
        // ⚠ `Bolt`, and deliberately NOT `Clock`. A schedule is not a trigger
        // here — a flow's cron lives on its MODEL (D-18) and this page refuses a
        // `schedule` kind BY NAME — so a clock is the one glyph that would send
        // somebody looking for "every Monday" to the page that cannot set it.
        Icon: Bolt,
        ownedPaths: ["/triggers"],
      },
      {
        href: "/runs",
        label: "Runs & Activity",
        Icon: Activity,
        // Personal fork: incidents / admin ops are removed from the product surface
        // (`lib/personal.ts`). Runs claim history only.
        ownedPaths: ["/history"],
      },
      {
        // Personal settings — kept fat. Enterprise Admin (people / workspaces /
        // roles / gates / audit / break-glass) is thinned out of this fork.
        href: "/ai-provider",
        label: "AI models",
        Icon: Shield,
        ownedPaths: ["/ai-provider"],
      },
      {
        // Personal fork: thin allowlist + invites (not enterprise Admin → People).
        href: "/people",
        label: "People",
        Icon: User,
        ownedPaths: ["/people"],
      },
      { href: "/admin/users", label: "Users", Icon: Building, userAdminOnly: true, ownedPaths: ["/admin/users"] },
      {
        // Phase 6 edge agent: pair this computer, approve local commands.
        href: "/devices",
        label: "Devices",
        Icon: Activity,
        ownedPaths: ["/devices"],
      },
    ],
  },
];

// ── Active matching: pathname only, longest-claim wins, exactly one active ──
// `/` is exact. Otherwise an item claims `href` + every `ownedPaths`. Longest claim wins; ties → first declared.
export function claimFor(item: NavItem): string[] {
  return [item.href, ...(item.ownedPaths ?? [])];
}

function longestClaimLength(item: NavItem, pathname: string): number {
  let best = -1;
  for (const c of claimFor(item)) {
    const p = c.split("?")[0];
    if (pathname === p || pathname.startsWith(p + "/")) best = Math.max(best, p.length);
    if (pathname === c || pathname === p) best = Math.max(best, p.length);
  }
  return best;
}

export function getActiveTopHref(pathname: string): string | null {
  type Best = { href: string; len: number; idx: number };
  let best: Best | null = null;
  const flat = groups.flatMap((g) => g.items);
  for (let idx = 0; idx < flat.length; idx++) {
    const it = flat[idx];
    if (it.href === "/" && pathname !== "/") {
      const viaOwned = it.ownedPaths?.some((p) => pathname === p.split("?")[0] || pathname.startsWith(p.split("?")[0] + "/"));
      if (!viaOwned) continue;
      const len = 10;
      if (best === null || len > best.len || (len === best.len && idx < best.idx)) best = { href: it.href, len, idx };
      continue;
    }
    const len = longestClaimLength(it, pathname);
    if (len < 0) continue;
    if (best === null || len > best.len || (len === best.len && idx < best.idx)) best = { href: it.href, len, idx };
  }
  if (best === null) return null;
  return best.href;
}

export function isTopActive(item: NavItem, pathname: string): boolean {
  return getActiveTopHref(pathname) === item.href;
}

export function isChildActive(childHref: string, pathname: string, search: string): boolean {
  try {
    const childUrl = new URL(childHref, "http://x");
    const curUrl = new URL(pathname + search, "http://x");
    const childPath =
      childUrl.pathname === "/workflows" || childUrl.pathname.startsWith("/workflows/")
        ? childUrl.pathname.replace(/^\/workflows/, "/flows")
        : childUrl.pathname;
    const curPath =
      curUrl.pathname === "/workflows" || curUrl.pathname.startsWith("/workflows/")
        ? curUrl.pathname.replace(/^\/workflows/, "/flows")
        : curUrl.pathname;
    if (childPath !== curPath) return false;
    for (const [k, v] of childUrl.searchParams.entries()) {
      if (curUrl.searchParams.get(k) !== v) return false;
    }
    return true;
  } catch {
    return pathname === childHref || pathname.startsWith(childHref);
  }
}

/**
 * The persistent left navigation rail.
 *
 * `collapsed`/`onToggleCollapsed` drive the width at EVERY size (the shell decides what "collapsed"
 * means: stored preference from `lg` up, default-collapsed below it). `onNavigate` fires when a link is
 * tapped so the shell can fold an overlaid rail back to icons on a small screen.
 *
 * ⚠ The `<aside>` is absolutely positioned inside a wrapper that owns the flex-row space. Below `lg` the
 * wrapper stays 57px, so the expanded 240px rail OVERLAYS the page instead of pushing it; from `lg` the
 * wrapper follows the rail's width (same 280ms curve) and the content is pushed.
 *
 * ⚠ The rail's HEIGHT is the shell's, not this file's: `app/(app)/layout.tsx`
 * is `h-screen overflow-hidden`, which is what stops the rail growing with the
 * page. Reintroducing `min-h-screen` there brings the scrolling rail back.
 */
export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = typeof window !== "undefined" ? window.location.search : "";
  const { user, signOut } = useAuth();
  const { workspaceId } = useWorkspace();
  const { can: canHere } = usePermissions();
  const adminHere = canHere("members.grant");
  // An Observer may not build (rbac-observability): no "New chat". Unreadable still shows it — the server decides.
  const mayBuild = canHere("flows.write") !== "denied";
  const me = useAsync(() => getMe(workspaceId), [workspaceId]);
  const epoch = useActivityEpoch();
  const { data: pendingApprovals, error: approvalsError } = useAsync(listPendingApprovals, [workspaceId, epoch]);
  const edgePending = useAsync(
    () =>
      PERSONAL_PRODUCT && workspaceId
        ? listEdgePending()
        : Promise.resolve({ jobs: [], connects: [], relays: [] }),
    [workspaceId, epoch],
  );
  // Edge *jobs* approve in chat; Needs you counts connect + plugin-relay (+ flow approvals).
  const pendingCount =
    (!approvalsError ? (pendingApprovals?.length ?? 0) : 0) +
    (edgePending.data?.connects.length ?? 0) +
    (edgePending.data?.relays.length ?? 0);

  /* ⚠ An unreadable access check leaves the Admin row HIDDEN — see the comment at the group filter below. */
  const isVisible = (i: NavItem) =>
    (!i.superAdminOnly || me.data?.superAdmin || adminHere === "allowed") &&
    // The cost report is an Admin's. Hidden while loading and when the check failed: "could not check" must not read
    // as "you may". The report routes refuse everybody else regardless, so this only decides whether the link shows.
    (!i.needsReports || me.data?.canViewReports === true) &&
    // Same rule: hidden while loading and on failure. The server decides who may manage users.
    (!i.userAdminOnly || me.data?.userAdmin === true);

  const initials =
    (user?.name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";

  /**
   * ⚠ **A label FADES AND COLLAPSES; it never `display:none`s.** The rail's width
   * animates over 300ms and `lg:hidden` applies on the same tick you click — so
   * every word vanished, or appeared, against a rail that was still moving. That
   * mismatch is the whole of what read as jank; the width transition was already
   * correct.
   *
   * ⚠ **The two directions are deliberately ASYMMETRIC.** Collapsing, the words
   * leave first and the rail closes behind them. Expanding, the rail widens and
   * the words arrive 150ms later, into space that already exists — a label
   * fading in at 56px is a label being clipped by the container it is growing
   * into. One symmetric timing cannot do both.
   *
   * ⚠ **Nav icons glide on `mx-auto`, never `justify-center`.** `justify-content`
   * is not continuously animatable, so centring the ROW snapped the icon to the
   * middle of a still-wide rail on collapse — the drift-then-jump that read as
   * jank. Auto margins absorb the width change continuously, so the icon travels
   * with the rail in both directions while the labels dissolve around it.
   *
   * `max-width` and not `width`: `width: auto` does not animate, so a symmetric
   * pair needs a number at both ends, and a number here would have to be right
   * for every label in the rail.
   */
  const railLabel =
    "min-w-0 whitespace-nowrap transition-[opacity,visibility,transform] ease-out motion-reduce:transition-none";
  const hideWhenNarrow = collapsed
    ? `${railLabel} duration-150 invisible opacity-0 -translate-x-1`
    : `${railLabel} duration-200 delay-100 motion-reduce:delay-0`;

  return (
    <>
      <div
        className={`relative h-full w-[var(--sidebar-collapsed-w)] shrink-0 transition-[width] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${
          collapsed ? "lg:w-[var(--sidebar-collapsed-w)]" : "lg:w-[var(--sidebar-w)]"
        }`}
      >
      {/* Below lg an expanded rail floats over the page: this scrim fades in behind it and collapses it on tap. */}
      <div
        onClick={onToggleCollapsed}
        aria-hidden
        className={`fixed inset-0 z-40 bg-scrim transition-opacity duration-[280ms] ease-out motion-reduce:transition-none lg:hidden ${
          collapsed ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      />

      <aside
        className={`rail-surface absolute inset-y-0 left-0 z-50 flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${
          collapsed ? "w-[var(--sidebar-collapsed-w)]" : "w-[var(--sidebar-w)]"
        }`}
      >
        <div className="flex h-topbar shrink-0 items-center gap-2 overflow-hidden border-b border-line px-3.5">
          <Link href="/dashboard" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5">
            <span className="btn-grad flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ color: "var(--on-cta)" }}>
              <Cube s={16} />
            </span>
            <span className={`text-sm font-semibold ${hideWhenNarrow}`}>Tether</span>
          </Link>
          <span className={`ml-auto shrink-0 ${hideWhenNarrow}`}>
            <AlphaChip />
          </span>
        </div>

        {mayBuild && <div className="px-2 py-3">
          <Link
            href="/chats/new"
            onClick={onNavigate}
            title={collapsed ? "New chat" : undefined}
            aria-label="New chat"
            className="btn-cta flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-lg pl-3 pr-3 text-body font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="shrink-0"><Plus s={16} /></span>
            <span className={hideWhenNarrow}>New chat</span>
          </Link>
        </div>}

        <nav className="rail-nav flex-1 overflow-y-auto overflow-x-hidden px-2 py-1">
          {groups.map((group, gi) => {
            /*
             * ⚠ **`capabilities?.includes("admin")` IS GONE** (RBAC T092b). `admin` was a
             * ROLE wearing a capability's clothes — a statement about who somebody is,
             * not a thing they may do — and migration 0065 dropped it (INV-10). A gate on
             * a string nobody can hold any more fails CLOSED and silently: every
             * non-super-admin loses the row for ever, with no error anywhere.
             *
             * The replacement asks the server's answer for the workspace. An
             * **unreadable** check leaves the row HIDDEN, deliberately — this is the
             * 2026-08-20 rule for `/organization`'s nav row: *"we could not check" must
             * not render as "you may"*, and a row that 403s when clicked is worse than an
             * absent one.
             *
             * ⚠ **An empty group must not render its heading** — the 2026-08-21 fix. The
             * filter is per group and the `visible.length === 0` return below is what
             * keeps the heading and its rows from disagreeing.
             */
            const visible = group.items.filter(isVisible);
            if (visible.length === 0) return null;
            return (
            <div key={gi} className="mb-2">
              {group.label && (
                <div
                  data-rail-group-label
                  className={`rail-group-label flex h-[38px] items-end overflow-hidden whitespace-nowrap px-3 pb-1.5 transition-[height,padding] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${collapsed ? "is-collapsed h-[13px] pb-0" : ""}`}
                >
                  {group.label}
                </div>
              )}
              {visible.map((item) => {
                const active = isTopActive(item, pathname);
                const showChildren = active && item.children && item.children.length > 0;
                const hasPending = item.href === "/approvals" && pendingCount > 0;
                const tip = hasPending ? `${item.label} · ${pendingCount} waiting` : item.label;
                return (
                  <div key={item.href} className="mb-0.5">
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      title={collapsed ? tip : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      aria-current={active ? "page" : undefined}
                      className="rail-item flex h-9 w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-lg pl-3 pr-2 text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <span className="rail-icon relative flex shrink-0 items-center justify-center">
                        <item.Icon s={16} />
                        {hasPending && collapsed && <span className="rail-dot" aria-hidden />}
                      </span>
                      <span className={hideWhenNarrow}>{item.label}</span>
                      {item.tag && (
                        <span className={`ml-auto shrink-0 ${hideWhenNarrow}`}>
                          <span className="inline-flex items-center rounded border border-alpha-line bg-alpha-bg px-1.5 py-px text-micro font-semibold uppercase tracking-label text-alpha">
                            {item.tag}
                          </span>
                        </span>
                      )}
                      {hasPending && (
                        <span className={`ml-auto shrink-0 rounded-full bg-warn-bg px-1.5 py-px text-caption font-medium tabular-nums text-warn ${hideWhenNarrow}`}>
                          {pendingCount}
                        </span>
                      )}

                    </Link>
                    {showChildren && (
                      /* Folds with the rail (grid 1fr → 0fr) instead of unmounting, so the rows below it slide up
                         rather than jump on the first frame of the collapse. */
                      <div
                        className={`grid grid-rows-[1fr] transition-[grid-template-rows,opacity,visibility] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${
                          collapsed ? "invisible grid-rows-[0fr] opacity-0" : ""
                        }`}
                      >
                      <div className="min-h-0 overflow-hidden">
                      <div className="mb-1 ml-[1.375rem] mt-0.5 space-y-0.5 border-l border-line pl-2.5">
                        {item.children!.map((ch) => {
                          const childActive = isChildActive(ch.href, pathname, searchParams);
                          return (
                            <Link
                              key={ch.href}
                              href={ch.href}
                              onClick={onNavigate}
                              aria-current={childActive ? "page" : undefined}
                              className="rail-sub block truncate px-2 py-1.5 text-[12.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {ch.label}
                            </Link>
                          );
                        })}
                      </div>
                      </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            );
          })}
        </nav>

        <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2">
          <div
            title={collapsed ? (user?.email ? `${user.name} · ${user.email}` : user?.name) : undefined}
            className="flex w-full items-center gap-2.5 overflow-hidden rounded-lg p-1.5"
          >
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-bg text-[11px] font-semibold text-accent"
            >
              {initials}
            </span>
            <div className={`min-w-0 flex-1 ${hideWhenNarrow}`} title={user?.email || undefined}>
              <div className="truncate text-body font-medium capitalize leading-tight">{user?.name ?? "Guest"}</div>
              {user?.email && <div className="truncate text-caption text-dim leading-tight">{user.email}</div>}
            </div>
            <button
              onClick={signOut}
              aria-label="Sign out"
              title="Sign out"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${hideWhenNarrow}`}
            >
              <LogOut s={14} />
            </button>
          </div>
          <button
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand the navigation" : "Collapse the navigation"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand the navigation" : "Collapse the navigation"}
            className="flex h-9 w-full shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-lg pl-3 pr-2 text-body text-muted transition-[background-color,color] duration-150 ease-out hover:bg-surface-raised hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className={`flex shrink-0 items-center justify-center transition-transform duration-200 ease-[var(--ease)] ${collapsed ? "rotate-180" : ""}`}>
              <ChevronLeft s={16} />
            </span>
            <span className={hideWhenNarrow}>Collapse</span>
          </button>
        </div>
      </aside>
      </div>
    </>
  );
}
