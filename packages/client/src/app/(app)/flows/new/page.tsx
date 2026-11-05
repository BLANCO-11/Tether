// src/app/(app)/flows/new/page.tsx — an OLD address (2026-10-30). A conversation with Forge is a chat, and lives at
// /chats/new and /chats/<id>; links and bookmarks to this page land there. `?chat=<id>` → that chat; `?q=` and
// `?project=` carry over. The legacy `?mode=` values (`chat`, `canvas`, `template`, …) are dropped.
"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/Skeleton";
import { newChatTarget } from "@/lib/pi-builder";

function Redirect() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    router.replace(newChatTarget(new URLSearchParams(params.toString())));
  }, [params, router]);
  return <Skeleton className="m-6" />;
}

export default function OldNewFlowPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <Redirect />
    </Suspense>
  );
}
