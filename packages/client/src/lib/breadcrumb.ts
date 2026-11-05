// src/lib/breadcrumb.ts — where you are, derived from the URL and nothing else.
//
// ── THE MEASURED PROBLEM THIS SOLVES (ui-upgrade Phase 3.1) ───────────
//
// Before this, a detail page never said where it sat. `/runs/r-4f2a` rendered a
// run's steps under a title and no ancestor: the only way to know it belonged to
// an automation was to recognise the automation's name in the body. `/flows/[id]`
// was the same. The mock's topbar answers it with a crumb trail, and this module
// is where that trail is computed.
//
// ⚠ **It is PURE, and it takes only the pathname.** Not the router, not a
// context, not the page's own data. A crumb that needs the page to hand it a
// title is a crumb the shell cannot render until the page has loaded — which is
// exactly when a person most wants to know where they are. The cost is that a
// dynamic segment shows its id rather than its name; `LABELS` below carries the
// one exception worth making, and the docblock on `crumbsFor` states the bound.

/** One step in the trail. `href` is absent on the last crumb — you are there. */
export type Crumb = { label: string; href?: string };

// The first segment of a route → what that section is called ON SCREEN.
//
// ⚠ These must stay identical to the sidebar's own labels. A nav row saying
// ⚠ "Workflows" is the DESIGN PACK's word (mapping.md UX-001: the UI speaks the
// pack's vocabulary and Foundry's entities are what those words mean). It was
// "My Automations" until 2026-09-01, when /flows was rebuilt to S-28 — and the
// rail, the palette, the crumb and the page were renamed TOGETHER, because a rail
// row saying one thing over a page titled another is two names for one place, and
// the person has to learn both. `alpha-registry.test.ts` does not check this —
// `Sidebar.tsx` is the source, and the duplication is deliberate rather than
// extracted, because the nav row also carries an icon and a group and the crumb
// wants none of that.
const LABELS: Record<string, string> = {
  // Pack rail labels — must equal Sidebar.tsx groups[].label verbatim (04 nav table, UX-001)
  workflows: "Workflows",
  approvals: "Approvals",
  runs: "Runs & Activity",
  reports: "Dashboards & Reports",
  resources: "Resources",
  admin: "Admin",
  create: "New chat",
  chats: "Chats",
  // Sub-paths that are their own crumb (datasources owns /resources/new)
  members: "Members & roles",
  policies: "Policies",
  gates: "Release gates",
  downtime: "Downtime",
  audit: "Audit",
  incidents: "Incidents",
  // Legacy / Foundry routes kept for backward compat while old hrefs migrate to pack hrefs
  dashboard: "Dashboard",
  flows: "Workflows",
  history: "History",
  triggers: "Triggers",
  tools: "Tools",
  keys: "Credentials",
  apps: "Apps & systems",
  "data-sources": "Data sources",
  "ai-provider": "AI provider",
  organization: "Manage Workspaces",
};

// Second-and-later segments whose literal text IS the label. Everything else at
// that depth is treated as an identifier and rendered as one.
//
// ⚠ The distinction matters: `/flows/new` and `/flows/f-3a91` have the same
// shape, and only one of them has a name a person typed. `new` and `connect`
// are words; a uuid is not.
const STATIC_LEAVES = new Set(["new"]);

/**
 * The crumb trail for a pathname. The workspace is NOT a crumb — it is a
 * switcher in the same bar, and putting it in the trail implies you can
 * navigate "up" out of it, which is not a thing you can do.
 *
 * ⚠ **A dynamic segment renders as its identifier, shortened.** `/runs/r-4f2a…`
 * shows `r-4f2a…`, not the run's name — see this file's header for why the
 * shell cannot know the name. The page's own `<h1>` carries the name; the crumb
 * carries the position. Two different jobs, and conflating them is what makes a
 * crumb trail wait on a fetch.
 */
export function crumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const crumbs: Crumb[] = [];
  let href = "";

  segments.forEach((segment, i) => {
    href += `/${segment}`;
    const last = i === segments.length - 1;
    const label =
      i === 0
        ? (LABELS[segment] ?? titleise(segment))
        : STATIC_LEAVES.has(segment)
          ? titleise(segment)
          : shortId(segment);
    // The last crumb gets no href. A link to the page you are on is a control
    // that appears to do something and does not.
    crumbs.push(last ? { label } : { label, href });
  });

  return crumbs;
}

/** `data-sources` → `Data sources`. Used only for segments not in `LABELS`. */
function titleise(segment: string): string {
  const spaced = segment.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A uuid is 36 characters and a crumb bar is not. Truncated to the first eight,
 * which is enough to tell two runs apart on screen and short enough not to push
 * the rest of the trail off the edge.
 *
 * ⚠ It appends an ellipsis so the value reads as ABBREVIATED. An id silently
 * cut at eight characters is an id somebody copies and pastes into a query that
 * then returns nothing.
 */
function shortId(segment: string): string {
  return segment.length > 12 ? `${segment.slice(0, 8)}…` : segment;
}
