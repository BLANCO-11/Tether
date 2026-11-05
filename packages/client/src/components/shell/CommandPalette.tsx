// src/components/shell/CommandPalette.tsx — ⌘K or `/`. Global search across six kinds.
// Flows 14 + phases/17: placeholder "Search workflows, runs, resources" verbatim, six result kinds each its own group
// in fixed order workflow · step · run · resource · approval · person. Each result: title + meta line + icon.
// Recent searches per person shown when query empty. Permission-aware: a kind a role cannot reach is absent.
// Steps are searchable objects — "attendance policy" finds step 7, not just its workflow.
// Every result's href resolves (law 7 — same records every other surface renders).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Cube, Database, Gauge, Key, Plus, Wrench, Home, Activity, Building, Box, Shield, Search, User } from "@/components/ui/icons";
import { useAuth } from "@/lib/auth";
import {
  SEARCH_KINDS,
  SEARCH_KIND_LABEL,
  SEARCH_PLACEHOLDER,
  STATIC_SEARCH_INDEX,
  filterResults,
  groupByKind,
  loadRecent,
  saveRecent,
  clearRecent,
  type SearchKind,
  type SearchResult,
} from "@/lib/search";

const ICONS: Record<string, (p: { s?: number }) => JSX.Element> = {
  Cube,
  Database,
  Gauge,
  Key,
  Plus,
  Wrench,
  Home,
  Activity,
  Building,
  Box,
  Shield,
  Search,
  User,
  Bolt: Cube,
};

const PAGES: SearchResult[] = [
  { kind: "workflow", id: "nav-home", title: "Home", meta: "nav · /", href: "/", iconKey: "Home" },
  { kind: "workflow", id: "nav-workflows", title: "Workflows", meta: "build · /workflows", href: "/workflows", iconKey: "Cube" },
  { kind: "approval", id: "nav-approvals", title: "Approvals", meta: "build · /approvals", href: "/approvals", iconKey: "Cube" },
  { kind: "run", id: "nav-runs", title: "Runs & Activity", meta: "watch · /runs", href: "/runs", iconKey: "Activity" },
  { kind: "run", id: "nav-reports", title: "Dashboards & Reports", meta: "watch · /reports", href: "/reports", iconKey: "Gauge" },
  { kind: "run", id: "nav-datasources", title: "Data sources", meta: "connect · /data-sources/new", href: "/data-sources/new", iconKey: "Database" },
  { kind: "resource", id: "nav-resources", title: "Resources", meta: "connect · /resources", href: "/resources", iconKey: "Box" },
  { kind: "person", id: "nav-admin", title: "Admin", meta: "admin · /admin", href: "/admin", iconKey: "Building" },
  { kind: "run", id: "nav-dashboard", title: "Dashboard", meta: "watch · /dashboard", href: "/dashboard", iconKey: "Gauge" },
  { kind: "resource", id: "nav-data-sources", title: "Data sources", meta: "connect · /data-sources", href: "/data-sources", iconKey: "Database" },
];

const ACTIONS: SearchResult[] = [
  { kind: "resource", id: "act-connect-ds", title: "Connect a data source", meta: "connect · /data-sources/new", href: "/data-sources/new", iconKey: "Plus" },
  { kind: "resource", id: "act-add-tool", title: "Add tool", meta: "connect · /tools", href: "/tools", iconKey: "Wrench" },
  { kind: "resource", id: "act-add-credential", title: "Add credential", meta: "connect · /keys", href: "/keys", iconKey: "Key" },
];

const BASE_INDEX: SearchResult[] = [...STATIC_SEARCH_INDEX, ...PAGES, ...ACTIONS];

export function CommandPalette({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const subject = user?.email ?? user?.name ?? "anon";
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [kindFilter, setKindFilter] = useState<Set<SearchKind> | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const recent = useMemo(() => loadRecent(subject), [subject, open, recentTick]);

  const filteredRaw = useMemo(() => filterResults(query, BASE_INDEX), [query]);
  const filtered = useMemo(() => {
    if (!kindFilter) return filteredRaw;
    return filteredRaw.filter((r) => kindFilter.has(r.kind));
  }, [filteredRaw, kindFilter]);

  const grouped = useMemo(() => groupByKind(filtered), [filtered]);

  const flat = useMemo(() => {
    const out: SearchResult[] = [];
    for (const k of SEARCH_KINDS) out.push(...(grouped[k] ?? []));
    return out;
  }, [grouped]);

  const qEmpty = query.trim().length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (inField) return;
        e.preventDefault();
        onOpen();
        return;
      }
      if (e.key === "/" && !open) {
        if (inField) return;
        e.preventDefault();
        onOpen();
        return;
      }
      if (e.key === "Escape" && open) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpen, onClose]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setKindFilter(null);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const go = (entry: SearchResult) => {
    if (query.trim()) saveRecent(subject, query.trim());
    onClose();
    router.push(entry.href);
  };

  const toggleKind = (k: SearchKind) => {
    const next = new Set(kindFilter ?? []);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    if (next.size === 0) setKindFilter(null);
    else if (next.size === SEARCH_KINDS.length) setKindFilter(null);
    else setKindFilter(next);
    setSel(0);
  };

  const showFilters = !qEmpty && flat.length > 0;
  const kindsWithResults = SEARCH_KINDS.filter((k) => (grouped[k]?.length ?? 0) > 0);

  return (
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Global search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, flat.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter" && flat[sel]) {
            e.preventDefault();
            go(flat[sel]);
          }
        }}
        className="mx-auto mt-[72px] flex w-[640px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-line-2 bg-surface shadow-raised"
      >
        <div className="relative flex h-12 shrink-0 items-center border-b border-line">
          <span className="pointer-events-none absolute left-3 text-muted">
            <Search s={16} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label={SEARCH_PLACEHOLDER}
            className="h-full w-full border-0 bg-transparent pl-9 pr-16 text-sm text-text outline-none placeholder:text-dim"
          />
          <span className="pointer-events-none absolute right-3 hidden items-center gap-1 text-micro text-dim sm:flex" aria-hidden>
            <span className="rounded border border-line px-1 py-0.5 font-mono">/</span>
            <span className="rounded border border-line px-1 py-0.5 font-mono">⌘K</span>
          </span>
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-1 border-b border-line bg-surface-2 px-2 py-2">
            {kindsWithResults.map((k) => {
              const active = kindFilter === null || kindFilter.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleKind(k)}
                  aria-pressed={active}
                  className={`rounded-full border px-2 py-1 text-micro transition-colors ${
                    active ? "border-accent bg-accent-bg text-text" : "border-line bg-surface text-dim hover:text-text"
                  }`}
                >
                  {SEARCH_KIND_LABEL[k]}
                </button>
              );
            })}
            {kindFilter !== null && (
              <button type="button" onClick={() => setKindFilter(null)} className="rounded-full px-2 py-1 text-micro text-muted hover:text-text">
                Clear filters
              </button>
            )}
          </div>
        )}

        <div className="max-h-[420px] overflow-y-auto p-2">
          {qEmpty ? (
            recent.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-2 py-2">
                  <span className="text-micro uppercase tracking-label text-dim">Recent searches</span>
                  <button
                    type="button"
                    onClick={() => {
                      clearRecent(subject);
                      setRecentTick((t) => t + 1);
                    }}
                    className="text-micro text-muted hover:text-text"
                  >
                    Clear
                  </button>
                </div>
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setQuery(r)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-body text-text hover:bg-accent-bg"
                  >
                    <span className="shrink-0 text-muted">
                      <Search s={16} />
                    </span>
                    <span className="min-w-0 truncate">{r}</span>
                  </button>
                ))}
                <div className="mt-2 border-t border-line pt-2">
                  <div className="px-2 py-2 text-body text-dim">
                    Try <span className="font-mono text-text">attendance policy</span> — steps are searchable objects. Searching finds step 7, not just the workflow.
                  </div>
                </div>
              </>
            ) : (
              <div className="px-2 py-6 text-body text-dim">
                <p>Recent searches will appear here.</p>
                <p className="mt-2">
                  Try <span className="font-mono text-text">attendance policy</span> — steps are searchable objects. Searching finds step 7, not just the workflow.
                </p>
              </div>
            )
          ) : (
            <>
              {SEARCH_KINDS.map((kind) => {
                const items = grouped[kind] ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={kind}>
                    <div className="px-2 py-2 text-micro uppercase tracking-label text-dim">
                      {SEARCH_KIND_LABEL[kind]} · {items.length}
                    </div>
                    {items.map((entry) => {
                      const idx = flat.indexOf(entry);
                      return (
                        <PaletteRow
                          key={`${entry.kind}:${entry.id}`}
                          entry={entry}
                          selected={idx === sel}
                          onHover={() => setSel(idx)}
                          onSelect={() => go(entry)}
                        />
                      );
                    })}
                  </div>
                );
              })}
              {flat.length === 0 && (
                <div className="px-2 py-6 text-body text-dim">
                  <p>No results for &ldquo;{query}&rdquo;.</p>
                  <p className="mt-1">Try a different term or check the spelling. Every result links to something the product can show — no dead ends.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  entry,
  selected,
  onHover,
  onSelect,
}: {
  entry: SearchResult;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const Icon = ICONS[entry.iconKey] ?? Search;
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseMove={onHover}
      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-app hover:bg-accent-bg ${
        selected ? "bg-accent-bg" : ""
      } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      <span className="shrink-0 text-muted">
        <Icon s={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-text">{entry.title}</span>
        <span className="block truncate font-mono text-micro text-dim">{entry.meta}</span>
      </span>
      <span className="ml-auto shrink-0 font-mono text-micro uppercase tracking-label text-muted">{entry.kind}</span>
    </button>
  );
}
