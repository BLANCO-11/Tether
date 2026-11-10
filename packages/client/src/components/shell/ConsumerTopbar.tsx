// src/components/shell/ConsumerTopbar.tsx — the CONSUMER shell's topbar (S-42).
//
// ⚠ A separate, simpler product, not a permission-filtered view of the app shell.
// The W-word never appears. Neither does search, workspace switcher, or rail.
// Spec: S-42.md + flows/13-consumer.md + 22-consumer-status.png
// - 64px bar (app shell is 56px) — h-[64px]
// - Left: product mark + wordmark `Foundry` — NOT the workspace name
// - Right: three controls — density, theme, notifications with 3 badge. No search. No avatar.
// - Tabs live in a second bar beneath this one (see ConsumerTabs).
"use client";

import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Bell } from "@/components/ui/icons";

function DensityIcon({ s = 16, className }: { s?: number; className?: string }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

export function ConsumerTopbar() {
  return (
    <header className="flex h-[64px] shrink-0 items-center gap-4 border-b border-line bg-bg px-4 sm:px-6">
      {/* Left: product mark + wordmark — NOT workspace name */}
      <div className="flex items-center gap-2">
        <div
          className="h-5 w-5 shrink-0 rounded-[4px]"
          style={{ background: "var(--grad)" }}
          aria-hidden
        />
        <span className="text-sm font-semibold tracking-tight text-text">Tether</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Density control — present but inert (spec: three right controls) */}
        <button
          type="button"
          aria-label="Density"
          title="Density"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <DensityIcon s={16} />
        </button>

        <ThemeToggle />

        {/* Notifications with the 3 badge — verbatim from capture */}
        <div className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted">
          <Bell s={16} />
          <span
            className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white"
            aria-label="3 notifications"
          >
            3
          </span>
        </div>
      </div>
    </header>
  );
}

export function ConsumerTabs({ active = "status" }: { active?: "status" | "reports" | "requests" }) {
  const tabs = [
    { key: "status", label: "My status" },
    { key: "reports", label: "Reports" },
    { key: "requests", label: "My requests" },
  ] as const;
  return (
    <nav
      aria-label="Consumer sections"
      className="flex h-10 shrink-0 items-center gap-6 border-b border-line bg-bg px-4 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-[880px] items-center gap-6">
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <a
              key={t.key}
              href={t.key === "status" ? "/me" : t.key === "reports" ? "/me?tab=reports" : "/me?tab=requests"}
              aria-current={isActive ? "page" : undefined}
              className={`inline-flex h-10 items-center border-b-2 text-sm transition-colors ${
                isActive
                  ? "border-text font-medium text-text"
                  : "border-transparent text-muted hover:text-text"
              }`}
            >
              {t.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
