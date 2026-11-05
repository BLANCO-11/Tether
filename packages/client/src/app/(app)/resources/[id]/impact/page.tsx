// src/app/(app)/resources/[id]/impact/page.tsx — S-54 Dependency impact report.
//
// Pack truth: `19-resource-impact.png` + `S-54.md` + `flows/09-resources-and-change.md § Step 4`.
// Measure: page. Zones: header (eyebrow LEAVE MANAGEMENT DB · SCHEMA V3 + title +
// two-line purpose + primary Submit resource change), notices (warn blocked), content (table).
// Verbatim copy: header title/purpose, notice title/body, table heads/rows, submit
// success title/body — must not drift. See `backend-required.md` B-24 for the missing
// impact read (field use expressions + impact levels + required actions per workflow).
//
// UI-only: no impact read exists — `listFlows` gives dependents count only, not
// fieldUse/impact/action. This renders the capture's four rows as verbatim static copy
// (the pack is the source of truth for layout/copy), with local submit state.
// Same honest-empty rule as other pack-verbatim pages (S-39, S-52): when a read
// lands, the table will derive from it; until then verbatim stands.
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { ImpactWord, type ImpactLevel } from "@/components/resource/ImpactWord";
import { PACK } from "./pack";

export default function ImpactReportPage() {
  // The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.
  const params = useParams<{ id: string }>();
  const [submitted, setSubmitted] = useState(false);
  // Eyebrow is verbatim for the worked example; other ids fall back to a derived form
  // but the test pins the leave-management-db rendering.
  const rawId = params?.id ?? "leave-management-db";
  const eyebrow =
    rawId === "leave-management-db" || rawId === "leave-management-db-impact"
      ? PACK.eyebrow
      : `${rawId.toUpperCase().replace(/-/g, " ")} \u00b7 SCHEMA V3`;

  return (
    <Page measure="page">
      <PageHeader
        eyebrow={eyebrow}
        title={PACK.title}
        purpose={PACK.purpose}
        actions={[{ label: PACK.submitLabel, onClick: () => setSubmitted(true) }]}
      />

      <Zone name="notices">
        <Notice tone="warn" title={PACK.noticeTitle}>
          {PACK.noticeBody}
        </Notice>
        {submitted && (
          <Notice tone="ok" title={PACK.successTitle}>
            {PACK.successBody}
          </Notice>
        )}
      </Zone>

      <Zone name="content">
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm" aria-label="Dependency impact">
            <thead>
              <tr className="border-b border-line bg-surface-2/40 text-caption uppercase tracking-label text-dim">
                {PACK.heads.map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PACK.rows.map((r) => (
                <tr key={r.workflow} className="border-b border-line/60 last:border-0 hover:bg-surface-2/50" data-testid="impact-row">
                  <td className="px-4 py-3 align-top">
                    <a href={`/flows/${encodeURIComponent(r.workflow)}`} className="font-medium text-text hover:text-accent">
                      {r.workflow}
                    </a>
                  </td>
                  <td className="px-4 py-3 align-top text-muted">{r.owner}</td>
                  <td className="px-4 py-3 align-top font-mono text-xs text-muted" data-testid="field-use-cell">
                    {r.fieldUse}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <ImpactWord impact={r.impact} />
                  </td>
                  <td className="px-4 py-3 align-top text-muted">{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Zone>
    </Page>
  );
}

