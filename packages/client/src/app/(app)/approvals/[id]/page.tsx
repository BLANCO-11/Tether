// src/app/(app)/approvals/[id]/page.tsx — S-39 Exception approval detail
// (design handoff pack record removed 2026-09-11; the worked example below is the
// surviving source of truth). The fully worked example: Rahul Desai July attendance exception.
// UI-only B-22: no exception_requests / approval_requests read exists, so this renders
// verbatim static copy where the capture is the source of truth, with local decision state.
// Backend items B-14 + B-22 (ux-upgrade programme, closed; record removed).
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { MainAside } from "@/components/layout/MainAside";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Field, Textarea } from "@/components/ui/Field";

// ── Verbatim pack copy — S-39 § Copy — must not drift ───────────────────────
const PACK = {
  id: "EXC-2026-07-0042",
  eyebrowPrefix: "EXCEPTION",
  title: "Rahul Desai \u00b7 July 2026",
  status: "Partially approved",
  purpose: "9 days in office (12 required)",
  noticeTitle: "Parallel approval",
  noticeBody:
    "Both your manager (Anita Rao) and your HR business partner (Sanjay Nair) must approve this. If either declines, the request fails.",
  request: {
    title: "Request",
    datesLabel: "Dates",
    datesValue: "2026-07-14 \u2013 2026-07-25",
    categoryLabel: "Category",
    categoryValue: "Client site visit",
    daysLabel: "Days",
    daysValue: "14, 15, 16, 17, 18, 21, 22, 23, 24, 25",
    documentLabel: "Document",
    documentValue: "pune-site-attendance-jul2026.pdf \u00b7 240 KB",
    reason:
      "I was at the Pune client site for two weeks for the claims migration go-live. Badge records are with the client's security team, not ours.",
  },
  approvalPathTitle: "Approval path",
  approvers: [
    {
      ordinal: "1",
      name: "Anita Rao",
      role: "Manager",
      decision: "Approved 3 Aug 2026, 11:20 IST",
      comment: "Confirmed, Rahul was on site with the migration team.",
    },
    {
      ordinal: "2",
      name: "Sanjay Nair",
      role: "HR Business Partner",
      decision: "Pending for 8 days",
      comment: "No decision yet",
    },
  ] as const,
  commentLabel: "Comment for Rahul",
  figures: [
    { value: "9", label: "days in office" },
    { value: "12", label: "required" },
    { value: "10", label: "days requested" },
  ] as const,
  declineLabel: "Decline & notify",
  approveLabel: "Approve & notify",
  decidedNotified: "The requester and other approvers were notified.",
  consumerUpdate: "Rahul\u2019s consumer status updates from the same decision.",
} as const;

export default function ExceptionApprovalPage() {
  // The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.
  const params = useParams<{ id: string }>();
  const id = params?.id ?? PACK.id;
  const eyebrow = `${PACK.eyebrowPrefix} \u00b7 ${id}`;
  const [decision, setDecision] = useState<null | "approved" | "declined">(null);
  const [comment, setComment] = useState<string>("");

  return (
    <Page measure="page">
      <PageHeader
        eyebrow={eyebrow}
        title={PACK.title}
        badge={
          <span
            data-testid="s39-status-chip"
            className="inline-flex items-center gap-1.5 rounded-full border border-warn-line bg-warn-bg px-2.5 py-1 text-xs text-warn"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
            {PACK.status}
          </span>
        }
        purpose={PACK.purpose}
      />

      <Zone name="notices" gap="tight">
        <Notice tone="warn" title={PACK.noticeTitle}>
          {PACK.noticeBody}
        </Notice>
        {decision === "approved" && (
          <div data-testid="s39-decided-notice">
            <Notice tone="ok" title="Approved — request granted">
              {PACK.decidedNotified} {PACK.consumerUpdate}
            </Notice>
          </div>
        )}
        {decision === "declined" && (
          <div data-testid="s39-decided-notice">
            <Notice tone="danger" title="Declined — request failed">
              {PACK.decidedNotified} {PACK.consumerUpdate}
            </Notice>
          </div>
        )}
      </Zone>

      <Zone name="content">
        {/* ⚠ Content + sidebar is `MainAside`, not a page-local grid: the two
            columns are one shape with one width, and a second template is how
            the nine bespoke row grids came back. */}
        <MainAside asideLabel="Figures" asideWidth="340px" aside={
          <section
            className="rounded-lg border border-line bg-surface p-4"
            aria-labelledby="s39-figures-title"
            data-testid="s39-figures-card"
          >
            <h2 id="s39-figures-title" className="sr-only">
              Figures
            </h2>
            <div className="grid grid-cols-3 gap-4">
              {PACK.figures.map((f) => (
                <div key={f.label}>
                  <div className="text-[26px] font-normal leading-none text-text">{f.value}</div>
                  <div className="mt-1.5 text-xs text-dim">{f.label}</div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-col gap-2">
              <Button
                variant="danger"
                size="md"
                className="w-full"
                data-testid="s39-decline"
                onClick={() => setDecision("declined")}
                disabled={decision !== null}
                aria-label={PACK.declineLabel}
              >
                {PACK.declineLabel}
              </Button>
              <Button
                variant="primary"
                size="md"
                className="w-full"
                data-testid="s39-approve"
                onClick={() => setDecision("approved")}
                disabled={decision !== null}
                aria-label={PACK.approveLabel}
              >
                {PACK.approveLabel}
              </Button>
            </div>
            {decision !== null && (
              <p className="mt-3 text-xs text-muted" data-testid="s39-decided-hint">
                {PACK.decidedNotified}
              </p>
            )}
          </section>
        }>
            {/* Request card */}
            <section
              className="overflow-hidden rounded-lg border border-line bg-surface"
              aria-labelledby="s39-request-title"
              data-testid="s39-request-card"
            >
              <div className="border-b border-line px-4 py-3">
                <h2 id="s39-request-title" className="text-sm font-semibold text-text">
                  {PACK.request.title}
                </h2>
              </div>
              <div className="px-4 py-4">
                <dl className="divide-y divide-line/60">
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-sm text-dim">{PACK.request.datesLabel}</dt>
                    <dd className="text-sm text-text">{PACK.request.datesValue}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-sm text-dim">{PACK.request.categoryLabel}</dt>
                    <dd className="text-sm text-text">{PACK.request.categoryValue}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-sm text-dim">{PACK.request.daysLabel}</dt>
                    <dd className="text-sm text-text">{PACK.request.daysValue}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-sm text-dim">{PACK.request.documentLabel}</dt>
                    <dd className="text-sm text-text">{PACK.request.documentValue}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-sm leading-relaxed text-muted">{PACK.request.reason}</p>
              </div>
            </section>

            {/* Approval path */}
            <section
              className="overflow-hidden rounded-lg border border-line bg-surface"
              aria-labelledby="s39-approval-path-title"
              data-testid="s39-approval-path"
            >
              <div className="border-b border-line px-4 py-3">
                <h2 id="s39-approval-path-title" className="text-sm font-semibold text-text">
                  {PACK.approvalPathTitle}
                </h2>
              </div>
              <div className="px-4 py-4">
                <ol className="relative space-y-6">
                  {/* connecting rule */}
                  <span className="absolute left-[11px] top-2 h-[calc(100%-16px)] w-px bg-line" aria-hidden />
                  {PACK.approvers.map((a) => (
                    <li key={a.ordinal} className="relative flex gap-3" data-testid="s39-approver">
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-medium text-text"
                        aria-hidden
                      >
                        {a.ordinal}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-text">
                          {a.name} \u00b7 {a.role}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">{a.decision}</div>
                        <div className="mt-1 text-sm text-muted">{a.comment}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            {/* Comment for Rahul */}
            <Field label={PACK.commentLabel}>
              <Textarea
                rows={5}
                mono={false}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                aria-label={PACK.commentLabel}
                data-testid="s39-comment"
                placeholder=""
              />
          </Field>
        </MainAside>
      </Zone>
    </Page>
  );
}
