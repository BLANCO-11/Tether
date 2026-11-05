// src/components/workspace/ChatPlaceLine.tsx — where a chat lives, in the builder (sharing-boundaries P6-I4).
"use client";

import { WherePill } from "@/components/workspace/WherePill";
import { placeLabel } from "@/components/workspace/MoveDialog";

/**
 * Where this chat lives, said before anything is saved (sharing-boundaries P6-I4): a new chat started anywhere but a
 * project's page is in My space, and nothing else on screen said so until it was listed. Not shown on somebody else's
 * chat — that notice says whose it is.
 *
 * 2026-11-04: visibly just the place pill, small and to the right; the sentence (who sees it, where to move it) is its
 * tooltip and is read to screen readers. A full sentence above the composer on every chat was noise once known.
 */
export function ChatPlaceLine({ place, othersChat }: { place: { key: string; projectName: string | null } | null; othersChat: boolean }) {
  if (!place || othersChat) return null;
  const who =
    place.key === "mine"
      ? "only you (and Admins) see it"
      : place.key === "workspace"
        ? "everyone in this workspace can read it"
        : "its members (and Admins) see it";
  const where = place.key.startsWith("project:") ? (place.projectName ?? "a project") : placeLabel(place.key, null);
  const sentence = `This chat lives in ${where}: ${who}. Move it from Chats.`;
  return (
    <div role="status" className="mb-1.5 flex justify-end">
      <span title={sentence} className="cursor-default opacity-80 transition-opacity hover:opacity-100">
        <span aria-hidden>
          <WherePill place={place.key} projectName={place.projectName} />
        </span>
        <span className="sr-only">{sentence}</span>
      </span>
    </div>
  );
}
