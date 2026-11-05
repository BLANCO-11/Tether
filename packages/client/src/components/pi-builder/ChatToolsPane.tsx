"use client";

/**
 * Right tools drawer for Forge chat — Files and Canvas. Icon switches (not text tabs),
 * left-edge drag to resize, and an expand that fills the workbench width.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Close, Folder, Workflow } from "@/components/ui/icons";

export type ToolsTab = "files" | "canvas";

export const TOOLS_DEFAULT_W = 420;
export const TOOLS_MIN_W = 320;
export const TOOLS_MAX_W = 900;

export function ChatToolsPane({
  open,
  tab,
  onTab,
  onClose,
  width,
  onWidth,
  expanded,
  onToggleExpand,
  showCanvas,
  files,
  canvas,
}: {
  open: boolean;
  tab: ToolsTab;
  onTab: (t: ToolsTab) => void;
  onClose: () => void;
  width: number;
  onWidth: (w: number) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  /** False when the workbench already shows the canvas column — avoids two canvases. */
  showCanvas: boolean;
  files: ReactNode;
  canvas: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const [, bump] = useState(0);

  const clamp = useCallback((w: number) => {
    const total = ref.current?.parentElement?.getBoundingClientRect().width || window.innerWidth;
    const max = Math.min(TOOLS_MAX_W, Math.max(TOOLS_MIN_W, total - 280));
    return Math.round(Math.min(max, Math.max(TOOLS_MIN_W, w)));
  }, []);

  if (!open) return null;
  const w = expanded ? "100%" : `${width}px`;

  return (
    <aside
      ref={ref}
      className="chat-tools absolute inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-surface shadow-raised"
      style={{ width: w, maxWidth: "100%" }}
      aria-label="Chat tools"
      role="complementary"
    >
      {!expanded ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize tools"
          aria-valuenow={width}
          aria-valuemin={TOOLS_MIN_W}
          aria-valuemax={TOOLS_MAX_W}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          className={`absolute inset-y-0 -left-[3px] z-20 hidden w-[6px] cursor-col-resize touch-none outline-none min-[708px]:block ${dragging.current ? "bg-accent/30" : ""}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            dragging.current = true;
            bump((n) => n + 1);
            document.body.classList.add("chat-resizing");
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const parent = ref.current?.parentElement?.getBoundingClientRect();
            if (!parent) return;
            onWidth(clamp(parent.right - e.clientX));
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            dragging.current = false;
            bump((n) => n + 1);
            document.body.classList.remove("chat-resizing");
          }}
          onPointerCancel={() => {
            dragging.current = false;
            bump((n) => n + 1);
            document.body.classList.remove("chat-resizing");
          }}
          onDoubleClick={() => onWidth(TOOLS_DEFAULT_W)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              onWidth(clamp(width + 16));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              onWidth(clamp(width - 16));
            } else if (e.key === "Home") {
              e.preventDefault();
              onWidth(TOOLS_DEFAULT_W);
            }
          }}
        />
      ) : null}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Tools">
          <IconTab active={tab === "files"} onClick={() => onTab("files")} icon={<Folder s={15} />} label="Files" />
          {showCanvas ? (
            <IconTab active={tab === "canvas"} onClick={() => onTab("canvas")} icon={<Workflow s={15} />} label="Canvas" />
          ) : null}
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          aria-label={expanded ? "Shrink tools" : "Give tools the whole width"}
          title={expanded ? "Shrink" : "Full width"}
          aria-pressed={expanded}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Close tools"
          title="Close"
        >
          <Close className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{tab === "canvas" && showCanvas ? canvas : files}</div>
    </aside>
  );
}

function IconTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        active ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      {icon}
    </button>
  );
}
