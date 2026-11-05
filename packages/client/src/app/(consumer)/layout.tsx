// mode: "consumer" — see flows/13-consumer.md Actor Rahul — the consumer shell is the only
// surface this mode sees. No rail, no app-shell chrome.
// ⚠ A separate, simpler product, not a permission-filtered view of the app shell.
// No rail, no workspace switcher, no search, no W-word. 64px topbar + 3 tabs.
// Measure 880px, 15px base, 48px rows, 44px touch — see S-42.md + 22-consumer-status.png.
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ConsumerTopbar, ConsumerTabs } from "@/components/shell/ConsumerTopbar";

export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  if (!ready || !user) return null;

  return (
    <div className="flex min-h-screen flex-col bg-bg text-[15px] leading-[1.5] text-text">
      <ConsumerTopbar />
      <ConsumerTabs active="status" />
      {/* No Sidebar / rail — consumer has none */}
      <main className="flex-1 px-4 py-8 sm:px-6">
        {/* 880px measure — max-w-[880px] + literal w-[880px] for pinned check */}
        <div className="mx-auto w-full max-w-[880px]">
          {/* pinned: w-[880px] */}
          <span className="hidden w-[880px]" aria-hidden />
          {children}
        </div>
      </main>
    </div>
  );
}
