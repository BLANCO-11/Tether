// src/components/workspace/ChatPlaceLine.tsx — where a chat lives, in the builder (sharing-boundaries P6-I4).
"use client";

import { WherePill } from "@/components/workspace/WherePill";

/**
 * Where this chat lives, said before anything is saved (sharing-boundaries P6-I4): a new chat started anywhere but a
 * project's page is in My space, and nothing else on screen said so until it was listed. One line, in the place words,
 * with who that means; moving it is on the Chats list. Not shown on somebody else's chat — that notice says whose it is.
 */
export function ChatPlaceLine({ place, othersChat }: { place: { key: string; projectName: string | null } | null; othersChat: boolean }) {
  if (!place || othersChat) return null;
  const who =
    place.key === "mine"
      ? "only you (and Admins) see it"
      : place.key === "workspace"
        ? "everyone in this workspace can read it"
        : "its members (and Admins) see it";
  return (
    <div role="status" className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-muted">
      <span>This chat lives in</span>
      <WherePill place={place.key} projectName={place.projectName} />
      <span>: {who}. Move it from Chats.</span>
    </div>
  );
}
