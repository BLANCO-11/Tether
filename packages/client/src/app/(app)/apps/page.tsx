// src/app/(app)/apps/page.tsx — Connectors: what this workspace is connected to, and the marketplace to add more.
// plans/plugins-2026-10-27, phase 5.
//
// ── ⚠ WHAT THIS PAGE USED TO BE, THREE TIMES ────────────────────────────────
//
// Mock-backed (`faFallback` over `lib/mockdb.ts`), then a declared placeholder with three literal vendors, then a
// read of the Kestra engine's plugin registry — and Kestra left the stack on 2026-10-21, so that read had nothing to
// read. It is now the real thing: Activepieces connectors, INSTALLED for the deployment by someone holding
// `platform.plugins.install`, CONNECTED per workspace by someone holding `plugins.enable`.
//
// ── ⚠ THE RULES THIS PAGE KEEPS ─────────────────────────────────────────────
//
//   * Unreadable is never "none". A failed read renders as a failure with its reason, not as an empty list — the
//     `faFallback` lesson, on the page that lists what the product can reach.
//   * The marketplace lists 700-odd pieces; an INSTALLED one is code on this deployment, and a CONNECTED one is a
//     credential in this workspace. The two are said apart on every card, because "it is in the marketplace" is not
//     "my automations can use it".
//   * Offering is not enforcing. Buttons follow the permission the server reports, and the server refuses regardless.
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { connectorMarketplace, installConnector, listWorkspaceConnectors } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import {
  catalogueAuthNote,
  catalogueCategories,
  categoryLabel,
  filterCatalogue,
  workspaceState,
} from "@/lib/connector-ui";
import type { ConnectorCatalogueEntry } from "@/lib/types";
import { useCan, useCanPlatform } from "@/components/access/Can";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Search } from "@/components/ui/icons";
import { ConnectorMark } from "@/components/connectors/ConnectorMark";

type Tab = "here" | "marketplace";

export default function ConnectorsPage() {
  const [tab, setTab] = useState<Tab>("here");
  const read = useCan("plugins.read");
  const install = useCanPlatform("platform.plugins.install");

  return (
    <Page>
      <PageHeader
        title="Connectors"
        purpose="Services your automations and Forge can use. A connector is installed once for this deployment, then connected in each workspace that uses it."
      />
      <Zone name="controls">
        <div role="tablist" aria-label="Connectors" className="flex gap-1 border-b border-line">
          {(
            [
              ["here", "Connected here"],
              ["marketplace", "Marketplace"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Zone>
      {read.denied ? (
        <Zone name="notices">
          <Notice tone="info" title="You cannot see this workspace's connectors">
            Seeing connected services needs the “See connected services” permission here. Ask a workspace admin.
          </Notice>
        </Zone>
      ) : tab === "here" ? (
        <ConnectedHere onBrowse={() => setTab("marketplace")} canInstall={install.allowed} />
      ) : (
        <Marketplace canInstall={install.allowed} />
      )}
    </Page>
  );
}

function ConnectedHere({ onBrowse, canInstall }: { onBrowse: () => void; canInstall: boolean }) {
  const res = useAsync(listWorkspaceConnectors);
  const list = res.data ?? [];

  return (
    <Zone name="content">
      {res.error ? (
        <Notice tone="danger" title="Could not read this workspace's connectors">
          {res.error} — this is a failure to ask, not an empty list.
        </Notice>
      ) : res.loading && !res.data ? (
        <p className="text-sm text-muted">Reading connectors…</p>
      ) : list.length === 0 ? (
        <Notice
          tone="info"
          title="No connector is installed on this deployment yet"
          action={<Button variant="subtle" onClick={onBrowse}>Browse the marketplace</Button>}
        >
          {canInstall
            ? "Pick one in the marketplace and install it; then connect it here."
            : "Someone allowed to install connectors adds them for the whole deployment; then they can be connected here."}
        </Notice>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Installed connectors">
          {list.map((p) => {
            const state = workspaceState(p);
            return (
              <li key={p.name}>
                <Link
                  href={`/apps/${p.short}`}
                  className="flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent"
                >
                  <span className="flex items-center gap-3">
                    <ConnectorMark logoUrl={p.logoUrl} name={p.displayName} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.displayName}</span>
                      <span className="block text-caption text-dim">version {p.version}</span>
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted">{p.description || " "}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-2">
                    <StatusPill status={state.tone}>{state.label}</StatusPill>
                    {p.connections.length > 0 && (
                      <Tag>
                        {p.connections.length} connection{p.connections.length === 1 ? "" : "s"}
                      </Tag>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Zone>
  );
}

function Marketplace({ canInstall }: { canInstall: boolean }) {
  const res = useAsync(connectorMarketplace);
  const router = useRouter();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [installing, setInstalling] = useState<ConnectorCatalogueEntry | null>(null);
  const entries = res.data?.entries ?? [];
  const shown = useMemo(() => filterCatalogue(entries, { q, category, installedOnly }), [entries, q, category, installedOnly]);
  const categories = useMemo(() => catalogueCategories(entries), [entries]);

  return (
    <>
      <Zone name="notices" gap="tight">
        {res.error && (
          <Notice tone="danger" title="Could not read the marketplace">
            {res.error} — nothing below is a statement about what exists.
          </Notice>
        )}
        {res.data?.stale && (
          <Notice tone="warn" title="Showing the last copy of the marketplace">
            It could not be refreshed just now; this list was read {new Date(res.data.fetchedAt).toLocaleString()}.
          </Notice>
        )}
        {res.data && !res.data.connectorReachable && (
          <Notice tone="warn" title="The connector service did not answer">
            What is installed is shown from this deployment's records only.
          </Notice>
        )}
      </Zone>
      <Zone name="controls">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field label="Search">
              <span className="relative block">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">
                  <Search s={14} />
                </span>
                <Input
                  className="pl-9"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="A service, or what it does"
                  aria-label="Search the marketplace"
                />
              </span>
            </Field>
          </div>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="all">All</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-muted">
            <input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} />
            Installed only
          </label>
        </div>
        {res.data && (
          <p className="text-xs text-dim">
            {shown.length} of {entries.length} connectors
          </p>
        )}
      </Zone>
      <Zone name="content">
        {res.loading && !res.data ? (
          <p className="text-sm text-muted">Reading the marketplace…</p>
        ) : res.data && shown.length === 0 ? (
          <p className="text-sm text-muted">Nothing matches.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Marketplace">
            {shown.slice(0, 240).map((e) => {
              const note = catalogueAuthNote(e);
              return (
                <li key={e.name} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
                  <span className="flex items-center gap-3">
                    <ConnectorMark logoUrl={e.logoUrl} name={e.displayName} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{e.displayName}</span>
                      <span className="block text-caption text-dim">
                        {e.actions} action{e.actions === 1 ? "" : "s"} · {e.categories.map(categoryLabel).join(", ") || "Uncategorised"}
                      </span>
                    </span>
                  </span>
                  <span className="line-clamp-3 text-xs text-muted">{e.description || " "}</span>
                  {note && <span className="text-caption text-dim">{note}</span>}
                  <span className="mt-auto flex flex-wrap items-center gap-2">
                    {e.installedVersion ? (
                      <>
                        <StatusPill status="ok">Installed · {e.installedVersion}</StatusPill>
                        <Link className="text-xs text-accent hover:underline" href={`/apps/${e.short}`}>
                          Open
                        </Link>
                      </>
                    ) : canInstall ? (
                      <Button size="sm" variant="subtle" onClick={() => setInstalling(e)}>
                        Install
                      </Button>
                    ) : (
                      <StatusPill status="neutral">Not installed</StatusPill>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {shown.length > 240 && <p className="text-xs text-dim">Showing the first 240 — search to narrow.</p>}
      </Zone>
      {installing && (
        <InstallDialog
          entry={installing}
          onClose={() => setInstalling(null)}
          onInstalled={(short) => {
            setInstalling(null);
            router.push(`/apps/${short}`);
          }}
        />
      )}
    </>
  );
}

function InstallDialog({ entry, onClose, onInstalled }: { entry: ConnectorCatalogueEntry; onClose: () => void; onInstalled: (short: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Install ${entry.displayName}`}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          Adds {entry.displayName} {entry.version} to this deployment. It does nothing in any workspace until someone
          connects it there.
        </p>
        <p className="text-muted">
          Each run may reach only the service a connection names, plus hosts approved for this connector. After
          installing, the connector page lists the hosts its code mentions so you can approve the ones it needs.
        </p>
        {catalogueAuthNote(entry) && entry.authTypes.length > 0 && (
          <Notice tone={/not available yet/.test(catalogueAuthNote(entry)!) ? "warn" : "info"} title={catalogueAuthNote(entry)!}>
            {/not available yet/.test(catalogueAuthNote(entry)!)
              ? "It can be installed, but not connected yet."
              : "After installing, its page asks for the app you register with the service, and shows the return address to give it."}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" title="Not installed">
            {error}
          </Notice>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await installConnector(entry.short, { version: entry.version });
                onInstalled(entry.short);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {busy ? "Installing…" : `Install ${entry.version}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
