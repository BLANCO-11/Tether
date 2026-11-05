"use client";

// A chat's ONE address (2026-10-30). Whoever may continue it — the person who started it, or an Admin — gets the live
// conversation here, in whatever mode, with or without a workflow it built. Anybody else it was shared with READS it
// (sharing-boundaries P1-I5 "A"): the stored conversation, no Forge process, nothing to act on. The server's
// `canChange` decides which; this page never works it out.
//
// The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useResolvedWorkspace } from "@/lib/workspace";
import { useAsync } from "@/lib/hooks";
import { getPiChat } from "@/lib/pi-builder";
import { formatWhen } from "@/lib/audit";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { ReadOnlyConversation } from "@/components/pi-builder/PiBuilderWorkbench";
import { ChatWorkbench } from "@/components/pi-builder/ChatWorkbench";

export default function ReadChatPage() {
  const { id } = useParams<{ id: string }>();
  const workspaceId = useResolvedWorkspace();
  const read = useAsync(() => (workspaceId ? getPiChat(workspaceId, id) : new Promise<never>(() => undefined)), [workspaceId, id]);
  const t = read.data;

  if (t?.canChange) return <ChatWorkbench chatId={t.chat.id} title={t.chat.title} />;

  return (
    <Page>
      <PageHeader
        eyebrow="Chats"
        title={t?.chat.title ?? "Chat"}
        purpose={
          t
            ? `${t.mine ? "You" : (t.chat.createdBy.name ?? "Someone")} · ${formatWhen(t.chat.updatedAt)}`
            : undefined
        }
      />
      <Zone name="content">
        {read.error ? (
          <Notice tone="warn" title="This chat could not be read">
            It may have been deleted, or moved somewhere you do not see, or the check did not run. <Link href="/chats" className="underline">Back to chats</Link>
          </Notice>
        ) : !t ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-4">
            <Notice tone="info" title="Shared with you to read">
              {t.sharedWithMe
                ? `${t.chat.createdBy.name ?? "Its owner"} shared this conversation with you. Only they can continue it.`
                : `${t.chat.createdBy.name ?? "Its owner"} shared this conversation with the workspace. Only they can continue it.`}
            </Notice>
            <ReadOnlyConversation messages={t.chat.messages} />
          </div>
        )}
      </Zone>
    </Page>
  );
}
