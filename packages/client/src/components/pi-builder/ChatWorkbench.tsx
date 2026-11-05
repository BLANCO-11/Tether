// src/components/pi-builder/ChatWorkbench.tsx — the workbench as a whole page: /chats/new, /chats/<id>, and
// /flows/<id>/builder's own wrapper does the same for a workflow.
//
// The workbench is immersive: `body.wb` opts the page out of the shell's entrance, and the rail starts collapsed
// (its three panes are laid out against the collapsed rail).
"use client";

import { useEffect } from "react";
import { transitionUpdate } from "@/lib/view-transition";
import { storeRailCollapsed } from "@/lib/rail-preference";
import { PiBuilderWorkbench } from "@/components/pi-builder/PiBuilderWorkbench";

export function ChatWorkbench(props: React.ComponentProps<typeof PiBuilderWorkbench>) {
  useEffect(() => {
    transitionUpdate(() => document.body.classList.add("wb"));
    storeRailCollapsed(true);
    return () => document.body.classList.remove("wb");
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ viewTransitionName: "workbench" } as React.CSSProperties}>
      <div role="region" aria-live="polite" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PiBuilderWorkbench {...props} />
      </div>
    </div>
  );
}
