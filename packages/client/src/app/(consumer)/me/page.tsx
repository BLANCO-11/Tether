// src/app/(consumer)/me/page.tsx — S-42 My attendance status (consumer).
//
// ⚠ The consumer shell is a separate product, not a permission variant.
// No W-word, no sidebar, 64px topbar (in layout), 3 tabs, 880px measure.
// Copy verbatim from S-42.md + 22-consumer-status.png.
// mode: "consumer" — Rahul Desai (Senior Analyst, Claims) per flows/13 + UXI-009 Meera persona
// Honest-empty: verbatim static copy until read lands; when read lands figures/freshness/history flip from that read.
// Identity line reads signed-in user's displayName · title when available, else Meera Iyer · HR Operations Lead (capture persona).
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { foundryApi, resolveWorkspaceId } from "@/lib/foundry-client";
import type { FAAttendanceStatus, FAExceptionNotice } from "@/lib/foundry-client";

// Verbatim copy — must not drift (S-42 § Copy)
const FALLBACK_IDENTITY_NAME = "Meera Iyer";
const FALLBACK_IDENTITY_ROLE = "HR Operations Lead";

type AttendanceView = FAAttendanceStatus;
type ExceptionView = FAExceptionNotice;

function formatFreshness(lastIso: string, nextIso: string): string {
  try {
    const last = new Date(lastIso);
    const next = new Date(nextIso);
    // Format as "1 Aug 2026, 02:00 IST" — force Asia/Kolkata
    const opts: Intl.DateTimeFormatOptions = {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
      hour12: false,
    };
    const lastStr = new Intl.DateTimeFormat("en-GB", opts).format(last);
    const nextStr = new Intl.DateTimeFormat("en-GB", opts).format(next);
    return `Last calculated ${lastStr} IST · Next ${nextStr} IST`;
  } catch {
    return "Last calculated 1 Aug 2026, 02:00 IST · Next 1 Sep 2026, 02:00 IST";
  }
}

export default function ConsumerMePage() {
  const [attendance, setAttendance] = useState<AttendanceView | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionView[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const wsId = await resolveWorkspaceId();
        const period = "2026-07";
        const [a, e] = await Promise.all([
          foundryApi.getMyAttendance(wsId, period).catch(() => null),
          foundryApi.getMyExceptions(wsId, period).catch(() => ({ period, exceptions: [] as ExceptionView[] })),
        ]);
        if (cancelled) return;
        if (a) setAttendance(a);
        if (e && Array.isArray(e.exceptions)) setExceptions(e.exceptions);
      } catch {
        // honest-empty: keep static copy
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const identityName = attendance?.identity.displayName ?? FALLBACK_IDENTITY_NAME;
  const identityRole = attendance?.identity.title ?? FALLBACK_IDENTITY_ROLE;
  const daysInOffice = attendance?.daysInOffice ?? 9;
  const requiredDays = attendance?.requiredDays ?? 12;
  const avgHours = attendance?.avgHours ?? "7h 20m";
  const freshness = attendance
    ? formatFreshness(attendance.lastCalculatedAt, attendance.nextCalculationAt)
    : "Last calculated 1 Aug 2026, 02:00 IST · Next 1 Sep 2026, 02:00 IST";
  const officeLabel = attendance?.calculated.officeDaysMeetingThreshold.label ?? "9 of 9 days";
  const leaveDays = attendance?.calculated.annualLeaveDays ?? 2;
  const holidays = attendance?.calculated.publicHolidays ?? 1;
  const resultLabel = attendance?.calculated.result.label ?? "3 days short";
  const history = attendance?.history ?? [
    { month: "2026-02", compliant: true, label: "Feb" },
    { month: "2026-03", compliant: true, label: "Mar" },
    { month: "2026-04", compliant: true, label: "Apr" },
    { month: "2026-05", compliant: false, label: "May" },
    { month: "2026-06", compliant: true, label: "Jun" },
    { month: "2026-07", compliant: false, label: "Jul" },
  ];
  const compliant = attendance ? attendance.compliant : false;

  const pendingNotice = exceptions.find((x) => x.status === "pending");
  const declinedNotice = exceptions.find((x) => x.status === "declined");

  return (
    <div className="flex flex-col gap-6 text-[15px]">
      {/* Identity — small avatar + name · role ABOVE the page title, inside content column */}
      <div className="flex items-center gap-2">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-dim"
          aria-hidden
        >
          {identityName
            .split(" ")
            .map((p) => p[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <span className="text-sm text-muted">
          {identityName} · {identityRole}
        </span>
      </div>

      {/* Header zone */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-text">My attendance status</h1>
          {/* Compliance chip — red with ✕ when non-compliant, green with ✓ when compliant */}
          {compliant ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-ok-line bg-ok-bg px-2 text-caption font-medium text-ok">
              <span aria-hidden>✓</span> Compliant
            </span>
          ) : (
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-danger-line bg-danger-bg px-2 text-caption font-medium text-danger">
              <span aria-hidden>✕</span> Non-compliant
            </span>
          )}
        </div>
        <p className="text-sm text-dim">July 2026 · Your own information only</p>
      </div>

      {/* Live notices from exception state (same state the approver wrote) */}
      {pendingNotice ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {pendingNotice.notice}
        </div>
      ) : null}
      {declinedNotice ? (
        <div className="rounded-md border border-danger-line bg-danger-bg px-4 py-3 text-sm text-danger">
          {declinedNotice.notice}
        </div>
      ) : null}

      {/* Figures card — 9 / 12 / 7h 20m + freshness */}
      <div className="rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-3 gap-4 px-5 py-5">
          <div>
            <div className="text-[22px] font-semibold leading-none text-text">{daysInOffice}</div>
            <div className="mt-1 text-caption text-dim">days in office</div>
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-none text-text">{requiredDays}</div>
            <div className="mt-1 text-caption text-dim">required days</div>
          </div>
          <div>
            <div className="text-[22px] font-semibold leading-none text-text">{avgHours}</div>
            <div className="mt-1 text-caption text-dim">average hours</div>
          </div>
        </div>
        <div className="border-t border-line px-5 py-3">
          <p className="text-caption text-dim">{freshness}</p>
        </div>
      </div>

      {/* How July was calculated — the most important panel */}
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line bg-surface px-4 py-3">
          <h2 className="text-sm font-semibold text-text">How July was calculated</h2>
        </div>
        <div className="divide-y divide-line">
          <div className="flex h-12 items-center justify-between px-4 text-sm">
            <span className="text-muted">Office days meeting 6 hours</span>
            <span className="font-medium text-text">{officeLabel}</span>
          </div>
          <div className="flex h-12 items-center justify-between px-4 text-sm">
            <span className="text-muted">Approved annual leave</span>
            <span className="font-medium text-text">{leaveDays} days</span>
          </div>
          <div className="flex h-12 items-center justify-between px-4 text-sm">
            <span className="text-muted">Public holidays</span>
            <span className="font-medium text-text">{holidays} day</span>
          </div>
          <div className="flex h-12 items-center justify-between bg-surface px-4 text-sm">
            <span className="font-medium text-muted">Result</span>
            <span className="font-semibold text-text">{resultLabel}</span>
          </div>
        </div>
      </div>

      {/* Six-month history */}
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-text">Six-month history</h2>
        </div>
        <div className="grid grid-cols-3 gap-3 p-4 sm:grid-cols-6">
          {history.map((c) => (
            <div
              key={c.month}
              className="flex h-[68px] flex-col items-center justify-center gap-1 rounded-md border border-line bg-bg"
            >
              <span className="text-caption font-medium text-muted">{c.label}</span>
              <span
                className={`text-sm font-semibold ${c.compliant ? "text-ok" : "text-danger"}`}
                aria-label={c.compliant ? "compliant" : "non-compliant"}
              >
                {c.compliant ? "✓" : "✕"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Primary action — 44px touch */}
      <div className="flex">
        <Link
          href="/me?exception=1"
          className="btn-primary inline-flex h-11 min-h-[44px] items-center justify-center rounded-md px-5 text-sm font-medium transition hover:bg-accent/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Request an exception
        </Link>
      </div>
      {/* Freshness notice already in figures; no W-word anywhere */}
    </div>
  );
}
