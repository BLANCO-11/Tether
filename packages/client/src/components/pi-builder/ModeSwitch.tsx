"use client";

/**
 * The chat's mode, as a toggle in the chat's footer under the message box (2026-10-13): on is Forge Agent, off is
 * Workflow Builder. Shown only where the workspace offers Forge Agent (or the chat is somehow in it), so a workspace
 * without it never sees a choice it cannot make. A switch applies from the next message. "Make default" sets the
 * person's own default for new chats.
 */
import { useEffect, useState } from "react";
import { getMe } from "@/lib/api";
import { MODE_BLURB, MODE_LABEL, setForgeDefaultMode, type ChatMode } from "@/lib/pi-builder";

// Module-level, so the effect that reads the default runs once rather than on every render.
const readDefault = async (): Promise<ChatMode> => (await getMe()).forgeDefaultMode ?? "workflow";

export function ModeSwitch({
  mode,
  agentAllowed,
  busy,
  onSwitch,
  loadDefault = readDefault,
  saveDefault = setForgeDefaultMode,
}: {
  mode: ChatMode;
  agentAllowed: boolean;
  /** Forge is answering: a switch waits until it has finished. */
  busy: boolean;
  onSwitch: (mode: ChatMode) => Promise<void>;
  loadDefault?: () => Promise<ChatMode>;
  saveDefault?: (mode: ChatMode) => Promise<ChatMode>;
}) {
  const [pending, setPending] = useState<ChatMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unread is not "workflow": the default link is only offered once the person's default is known.
  const [byDefault, setByDefault] = useState<ChatMode | null>(null);
  const shown = agentAllowed || mode === "agent";
  useEffect(() => {
    if (!shown) return;
    let live = true;
    loadDefault()
      .then((m) => live && setByDefault(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [loadDefault, shown]);

  if (!shown) return null;

  const choose = async (m: ChatMode) => {
    if (m === mode || busy || pending) return;
    setError(null);
    setPending(m);
    try {
      await onSwitch(m);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setPending(null);
    }
  };

  const agent = mode === "agent";
  const locked = busy || !!pending || (!agent && !agentAllowed);
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <button
        type="button"
        role="switch"
        aria-checked={agent}
        aria-label="Forge Agent"
        disabled={locked}
        onClick={() => void choose(agent ? "workflow" : "agent")}
        title={
          !agentAllowed && !agent
            ? "Forge Agent is not turned on for this workspace."
            : agent
              ? `Forge Agent: ${MODE_BLURB.agent} Turn off for Workflow Builder.`
              : `Workflow Builder: ${MODE_BLURB.workflow} Turn on for Forge Agent.`
        }
        className="group flex items-center gap-1.5 rounded text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${agent ? "bg-accent" : "bg-line"}`}
        >
          <span
            className={`absolute h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${agent ? "translate-x-[11px]" : "translate-x-[2px]"}`}
          />
        </span>
        <span className={agent ? "whitespace-nowrap font-medium text-text" : "whitespace-nowrap"}>{pending ? "Switching…" : MODE_LABEL.agent}</span>
      </button>
      {byDefault && byDefault !== mode && agentAllowed ? (
        <button
          type="button"
          onClick={() =>
            void saveDefault(mode)
              .then(setByDefault)
              .catch((e) => setError(friendly(e)))
          }
          title={`New chats will open in ${MODE_LABEL[mode]}.`}
          className="shrink-0 text-accent hover:underline"
        >
          Make default
        </button>
      ) : null}
      {error ? (
        <span role="alert" title={error} className="min-w-0 truncate text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** A server refusal reads as its message, not as "403 {json}". */
function friendly(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const json = raw.replace(/^\d{3}\s+/, "");
  try {
    const b = JSON.parse(json) as { message?: string; error?: string };
    return b.message ?? b.error ?? raw;
  } catch {
    return json || raw;
  }
}
