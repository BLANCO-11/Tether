// src/lib/search.ts — global search index shape per flows/14-cross-cutting.md + phases/17-cross-cutting.md
//
// Six result kinds, each its own group in a FIXED order: workflow · step · run · resource · approval · person.
// Each result carries title, meta line (status/owner), icon, and an href that must resolve (law 7 — a result never
// leads to not-found). Recent searches are remembered PER PERSON and shown when query is empty.
// Permission-aware by construction: a kind a role cannot reach is absent from that role's index.

export const SEARCH_KINDS = ["workflow", "step", "run", "resource", "approval", "person"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  workflow: "Workflows",
  step: "Steps",
  run: "Runs",
  resource: "Resources",
  approval: "Approvals",
  person: "People",
};

export type SearchResult = {
  kind: SearchKind;
  id: string;
  title: string;
  meta: string;
  href: string;
  iconKey: string;
};

export const SEARCH_PLACEHOLDER = "Search workflows, runs, resources";

// Fixed order index — which group comes first is part of the spec (AC-17-1).
export function sortByKindOrder(a: SearchResult, b: SearchResult): number {
  return SEARCH_KINDS.indexOf(a.kind) - SEARCH_KINDS.indexOf(b.kind);
}

export function groupByKind(results: SearchResult[]): Record<SearchKind, SearchResult[]> {
  const out = {} as Record<SearchKind, SearchResult[]>;
  for (const k of SEARCH_KINDS) out[k] = [];
  for (const r of results) out[r.kind]?.push(r);
  return out;
}

export function filterResults(query: string, results: SearchResult[]): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return results;
  return results.filter(
    (r) => r.title.toLowerCase().includes(q) || r.meta.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
  );
}

// ── ⚠ `filterByCapabilities` WAS HERE AND IS DELETED (RBAC T092c) ────────────
//
//   export function filterByCapabilities(results, caps, superAdmin) {
//     return results.filter((r) => {
//       if (r.kind === "resource" && !caps.has("resources") && !superAdmin) return false;
//       if (r.kind === "approval" && !caps.has("approve") && !superAdmin) return false;
//       if (r.kind === "person"   && !caps.has("admin")     && !superAdmin) return false;
//       return true;
//     });
//   }
//
// **The filtering moved to the server**, where `searchService.index` now takes the
// viewer's permissions and filters each of the six kinds by the permission for that kind
// — `flows.read`, `runs.read`, `datasources.read`/`tools.read`, `approvals.read`,
// `members.read`.
//
// Two reasons it had to move, and the second is the one that mattered:
//
//  1. **It was decoration.** The server returned every kind to everybody, so a result the
//     client hid had already crossed the wire. Anything that could read the response
//     could read the rows.
//  2. **It was a SECOND policy**, in capability names the server had stopped using, and it
//     was already wrong: `resource` is datasources ∪ tools, which are two permissions, and
//     one coarse check leaked whichever half it covered.
//
// ⚠ **Do not reintroduce a client-side filter "to hide results sooner".** Two answers to
// one question is what this whole feature exists to remove, and `ui-honesty-check.sh`
// fails on a policy table under `app/` or `components/`.

// ── Recent searches per person ───────────────────────────────────────────────
// Stored in localStorage so it survives reloads, keyed by subject/email. Shown when query is empty.

const RECENT_KEY = (subject: string) => `foundry:recent-searches:${subject}`;
const RECENT_LIMIT = 5;

export function loadRecent(subject: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY(subject));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function saveRecent(subject: string, query: string): void {
  const q = query.trim();
  if (!q) return;
  if (typeof window === "undefined") return;
  try {
    const prev = loadRecent(subject);
    const next = [q, ...prev.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY(subject), JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function clearRecent(subject: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RECENT_KEY(subject));
  } catch {
    // ignore
  }
}

// ── Demo / static index that is true without a server search route ─────────────
// Until GET /workspaces/:ws/search exists (B-29), the palette is backed by the same
// records every other surface renders — so no result points at something the product
// cannot show (law 7). These six are the captured flagship objects; searching
// "attendance policy" finds step 7 by title, not only its workflow.

export const STATIC_SEARCH_INDEX: SearchResult[] = [
  {
    kind: "workflow",
    id: "wf-monthly-compliance",
    title: "Monthly compliance check",
    meta: "Published · HR Operations",
    href: "/workflows",
    iconKey: "Cube",
  },
  {
    kind: "step",
    id: "step-7-attendance-policy",
    title: "Apply attendance policy",
    meta: "Step 7 · Monthly compliance check",
    href: "/workflows",
    iconKey: "Box",
  },
  {
    kind: "run",
    id: "RUN-2026-08-08-0714",
    title: "RUN-2026-08-08-0714",
    meta: "Failed · Monthly compliance check",
    href: "/runs",
    iconKey: "Activity",
  },
  {
    kind: "resource",
    id: "leave-management-db",
    title: "Leave management DB",
    meta: "PostgreSQL · Published",
    href: "/resources",
    iconKey: "Database",
  },
  {
    kind: "approval",
    id: "EXC-2026-07-0042",
    title: "EXC-2026-07-0042 · Rahul Desai · July 2026",
    meta: "Exception · Pending · 8 days",
    href: "/approvals",
    iconKey: "Shield",
  },
];
