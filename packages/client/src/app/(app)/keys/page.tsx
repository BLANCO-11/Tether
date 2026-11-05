// src/app/(app)/keys/page.tsx — Credentials: the unified, one-list surface
// (frozen mock D-01, Phase 5).
//
// ── WHAT CHANGED, AND WHY (D-01) ────────────────────────────────────────────
//
// The page previously rendered two `DataTable`s — "Secrets" and "Data source
// sign-ins" — plus the audit banners and two runtime cards, in six stacked
// blocks. The mock's D-01 redesign collapses the two collections into ONE
// grouped table driven by `listCredentials`, and this page follows it exactly:
//
//   1. WORKSPACE SECRETS (old table one) → `CredentialView`s with the kind the
//      server derives (legacy rows → `generic`). `hasValue` is presence,
//      computed server-side; no value ever returns.
//   2. DATA-SOURCE SIGN-INS (old table two) → `database`-kind rows (`ref` =
//      datasource name). The per-connector `CredentialForm` sign-in modal is
//      gone with the table: the seam owns the secret store, and a database
//      credential's value (the DSN) is managed on the data source's own page.
//      The unified modal still opens for these rows, and the server refuses the
//      write with a clean 409 rather than the client guessing.
//
// The AUDIT is unchanged and stays in zone 2: `auditSecrets` still answers "why
// did my tool call 401?" with the collision and missing-value banners, and they
// are folded into the notices zone ABOVE the new audit banner — they are the
// actionable part, the encryption banner is the stated limit.
//
// ── VALUES ARE WRITE-ONLY, AND THERE IS NO WAY AROUND IT ────────────────────
// `listCredentials` returns `hasValue` and nothing else. The modal's value box
// is write-only with a reveal toggle and NEVER shows a stored value; an edit
// opens blank with "leave blank to keep the current one".
//
// ── THE MOCK'S PLACEHOLDERS ─────────────────────────────────────────────────
// The mock's per-row second lines ("hr_postgres · DSN", "publish_token ·
// api_publish") and the mock's "connected" last-used cell have NO data
// source in `CredentialView` — rows render label + ref, and last-used is a
// real timestamp or "never". The mock's "API" section carries the "New" tag
// and its modal defaulted the kind select to API; this page defaults the modal
// to Tool, because the seam refuses api-kind upserts (managed on the trigger),
// and a default that 409s on first save is a broken default.
"use client";

import { useState } from "react";
import {
  listCredentials, deleteCredential, auditSecrets,
} from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type { CredentialKind, CredentialView } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Confirm } from "@/components/ui/Confirm";
import { Input, Select } from "@/components/ui/Field";
import { CredentialsTable } from "@/components/keys/CredentialsTable";
import { CredentialModal, type CredentialModalMode } from "@/components/keys/CredentialModal";
import { Plus, Shield } from "@/components/ui/icons";

/** The kind filter's options — the mock's select verbatim: no "Generic" row,
 * because legacy secrets are a migration artefact, not something to scope to.
 * They still appear under "All kinds" and in search. */
const KIND_FILTERS: Array<{ value: CredentialKind | "all"; label: string }> = [
  { value: "all", label: "All kinds" },
  { value: "tool", label: "Tool" },
  { value: "database", label: "Database" },
  { value: "webhook", label: "Webhook" },
  { value: "api", label: "API" },
  { value: "llm", label: "LLM" },
];

export default function KeysPage() {
  const credentials = useAsync(listCredentials);
  const audit = useAsync(auditSecrets);
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<CredentialKind | "all">("all");
  const [modal, setModal] = useState<{ mode: CredentialModalMode; initial: CredentialView | null } | null>(null);
  const [removing, setRemoving] = useState<CredentialView | null>(null);

  const reload = () => {
    // ⚠ Both. The list is the surface that shows the row; the audit is the
    // surface that notices an orphaned reference, and it notices on the very
    // next read — which only happens if this reloads it.
    credentials.reload();
    audit.reload();
  };

  const missing = audit.data?.missing ?? [];
  const collisions = audit.data?.collisions ?? [];

  return (
    <Page>
      <PageHeader
        eyebrow="Connect"
        title="Credentials"
        purpose="Every secret your automations use, in one place."
        actions={[
          { label: "Add credential", icon: <Plus s={15} />, onClick: () => setModal({ mode: "create", initial: null }) },
        ]}
      />

      {/* Zone 2 — the audit. The collision/missing banners are the ACTIONABLE
          part and keep their old copy; the encryption banner is the mock's
          stated limit (shield + the vault-seam phrase in the alpha hue). The
          shield is `text-muted` — the mock's `.notice-info .ic` — not accent,
          because `--accent` is interactive-only (doc §2.3) and this icon is
          static. The body is `text-body` (13px), the mock's notice recipe. */}
      <Zone name="notices" gap="tight">
        <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3 text-body">
          <span className="mt-0.5 shrink-0 text-muted">
            <Shield s={13} />
          </span>
          <span>
            Secrets are encrypted at rest (AES-256-GCM) and never returned to the UI — only whether a value exists. A{" "}
            <span className="text-alpha">vault provider seam</span> is the future integration point for external key management.
          </span>
        </div>

        {collisions.length > 0 && (
          <Notice
            tone="danger"
            title={`${collisions.length} name${collisions.length === 1 ? " is" : "s are"} claimed twice`}
          >
            {collisions.join(", ")} — a run using {collisions.length === 1 ? "it" : "these"} is
            refused with a 409 rather than picking one at random, so nothing silently signs in with
            the wrong credential. Delete or rename the duplicate.
          </Notice>
        )}
        {missing.length > 0 && (
          <Notice
            tone="warn"
            title={`${missing.length} secret${missing.length === 1 ? "" : "s"} referenced but not stored`}
          >
            <ul className="mt-1 space-y-0.5">
              {missing.map((m) => (
                <li key={`${m.envName}-${m.neededBy}`}>
                  <span className="font-mono text-body">{m.envName}</span>
                  <span className="text-muted"> — needed by {m.neededBy}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Anything using {missing.length === 1 ? "it" : "them"} will fail to sign in. This is the
              usual reason for a 401 — and it is also what a renamed secret leaves behind.
            </p>
          </Notice>
        )}
      </Zone>

      {/* Zone 3 — the D-01 controls: one search, one kind filter. The atoms
          are w-full by design; the wrappers own the measure (same wrapper
          pattern as /apps' search). */}
      <Zone name="controls">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-72">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search credentials…"
              aria-label="Search credentials"
            />
          </div>
          <div className="w-40">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as CredentialKind | "all")}
              aria-label="Filter by kind"
            >
              {KIND_FILTERS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </Select>
          </div>
        </div>
      </Zone>

      {/* Zone 4 — ONE pane, ONE table (the mock's `cred-table`). */}
      <Zone name="content">
        <div className="rounded-lg border border-line bg-surface">
          <CredentialsTable
            credentials={credentials.data ?? []}
            loading={credentials.loading}
            error={credentials.error}
            query={query}
            kind={kind}
            onEdit={(c) => setModal({ mode: "edit", initial: c })}
            onRotate={(c) => setModal({ mode: "rotate", initial: c })}
            onRemove={setRemoving}
          />
        </div>
      </Zone>

      {/* ── Overlays, not zones ────────────────────────────────────────────
          A modal is `position: fixed` and a closed one renders nothing, so
          neither takes the zone gap nor appears in the stack. */}
      <CredentialModal
        open={modal !== null}
        mode={modal?.mode ?? "create"}
        initial={modal?.initial ?? null}
        onClose={() => setModal(null)}
        onSaved={(message) => {
          toast.success(message);
          setModal(null);
          reload();
        }}
      />

      <Confirm
        open={!!removing}
        title={`Remove ${removing?.label ?? removing?.ref}?`}
        body="Anything referencing this ref will fail to sign in until a new value is stored. The server refuses kinds it does not own — database, webhook and api credentials live on their owning pages and cannot be removed from here."
        confirmLabel="Remove credential"
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await deleteCredential(removing.ref);
            toast.success(`${removing.label ?? removing.ref} removed`);
            reload();
          } catch (e) {
            toast.error(`Could not remove: ${e instanceof Error ? e.message : String(e)}`);
          }
        }}
        onClose={() => setRemoving(null)}
      />
    </Page>
  );
}
