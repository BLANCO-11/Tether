// src/components/workspace/WherePill.tsx — where an item lives, in the three words (sharing-boundaries phase 6).
//
// The same pill on every surface that shows a workflow or a chat: "My space", the project's name, or "Workspace". Where
// it lives IS who sees it, so the title says that in a sentence. One component, so no screen can start using another
// word ("public", "private", "shared") for the same thing.
"use client";

import { placeLabel } from "@/components/workspace/MoveDialog";

const WHO: Record<string, string> = {
  mine: "Only its owner (and Admins) see it.",
  workspace: "Everyone in this workspace sees it.",
};

export function WherePill({ place, projectName, className = "" }: { place: string; projectName?: string | null; className?: string }) {
  const project = place.startsWith("project:");
  const label = project ? (projectName ?? placeLabel(place, null)) : placeLabel(place, null);
  const tone = place === "mine" ? "bg-surface-2 text-muted" : project ? "bg-surface-2 text-text" : "bg-accent-bg text-accent";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${tone} ${className}`}
      title={project ? `The members of ${label} (and Admins) see it.` : WHO[place]}
    >
      {label}
    </span>
  );
}
