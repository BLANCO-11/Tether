// src/app/(app)/chats/new/page.tsx — a new chat with Forge (2026-10-30).
//
// "New chat" is the one way in, from the rail, the Chats page and a project. What a chat produces — a workflow, or an
// answer — is not known until the person says, so it lives under Chats, not Workflows. Its first message saves it and
// the address becomes /chats/<id> (the workbench rewrites it).
//
// `?q=` (from the home composer) seeds the first message; `?project=<id>` starts it inside that project; `?mode=workflow`
// (the Workflows page's "New workflow") or `?mode=agent` chooses the mode it starts in, else the person's default. Any
// other `?mode=` value is ignored rather than refused.
//
// ⚠ Nothing here polls a generation job: `flow_generation_jobs` has no route any more. A refusal is the builder's to
// say, in the conversation, and it still gets no Retry button (§6.7).
"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ChatMode } from "@/lib/pi-builder";
import { ChatWorkbench } from "@/components/pi-builder/ChatWorkbench";

function NewChatContent() {
  const params = useSearchParams();
  // Read once: the workbench rewrites the address when the first message saves the chat, and that must not start
  // another conversation (or re-send `?q=`).
  const [seededDraft] = useState(() => params.get("q"));
  const [projectId] = useState(() => params.get("project"));
  const [mode] = useState<ChatMode | null>(() => {
    const m = params.get("mode");
    return m === "workflow" || m === "agent" ? m : null;
  });
  return <ChatWorkbench initialDraft={seededDraft} projectId={projectId} mode={mode} />;
}

// ⚠ `useSearchParams()` outside a Suspense boundary fails the build ("Missing Suspense boundary with useSearchParams").
export default function NewChatPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <NewChatContent />
    </Suspense>
  );
}
