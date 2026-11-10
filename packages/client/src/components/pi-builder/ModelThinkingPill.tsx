"use client";

/**
 * One pill for the Forge composer (2026-11-04): the model's plain name and, where the chat has one, the thinking level.
 * Clicking it opens a small menu with both choices. The parent owns open/closed so the `/` command can open it too.
 * Changes apply from the next message, so the pill is locked while Forge is working.
 */
import { useEffect, useRef, useState } from "react";
import { Check } from "@/components/ui/icons";
import { prettyModelName } from "@/lib/model-names";
import { THINKING_HINT, THINKING_LABEL, THINKING_LEVELS, type ThinkingLevel } from "@/lib/thinking-levels";

export type PillMenu = { focus: "model" | "thinking"; filter?: string };

const PILL = "flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-2 px-3 text-sm leading-none text-text";
const ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:opacity-50";

export function ModelThinkingPill({
  model,
  models,
  thinking,
  disabled,
  menu,
  onMenu,
  onPickModel,
  onPickThinking,
}: {
  /** The effective raw model id. */
  model: string;
  /** Enabled raw model ids. */
  models: string[];
  /** Undefined when this chat has no thinking control. */
  thinking?: ThinkingLevel;
  /** True while Forge is working: nothing can change mid-reply. */
  disabled: boolean;
  menu: PillMenu | null;
  onMenu: (m: PillMenu | null) => void;
  onPickModel: (id: string) => Promise<void>;
  onPickThinking: (level: ThinkingLevel) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const options = !model || models.includes(model) ? models : [model, ...models];
  const open = menu !== null && !disabled;
  const focus = menu?.focus;

  useEffect(() => {
    if (menu && disabled) onMenu(null);
  }, [menu, disabled, onMenu]);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onMenu(null);
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open, onMenu]);

  useEffect(() => {
    if (!open || wasOpen.current) return;
    wasOpen.current = true;
    setError(null);
    const group = popover.current?.querySelector<HTMLElement>(`[role="group"][aria-label="${focus === "thinking" ? "Thinking" : "Model"}"]`);
    const items = group ? Array.from(group.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) : [];
    const target = items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0] ?? popover.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
    target?.focus();
  }, [open, focus]);

  const raw = (id: string) => `${id}`;
  const hint = disabled ? "Wait for Forge to finish to change it" : "Applies from your next message";

  if (!model) {
    return (
      <span className="relative inline-flex min-w-0">
        <a data-testid="model-pill" href="/ai-provider" title="Set one on the AI models page" className={PILL}>
          <span className="truncate">No model configured</span>
        </a>
      </span>
    );
  }

  if (options.length <= 1 && thinking === undefined) {
    return (
      <span className="relative inline-flex min-w-0">
        <span data-testid="model-pill" title={raw(model)} className={PILL}>
          <span className="truncate">{prettyModelName(model)}</span>
        </span>
      </span>
    );
  }

  const pick = async (run: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await run();
      onMenu(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const pickModel = (id: string) => (id === model ? onMenu(null) : void pick(() => onPickModel(id)));
  const pickThinking = (l: ThinkingLevel) => (l === thinking ? onMenu(null) : void pick(() => onPickThinking(l)));

  const filter = menu?.filter?.trim().toLowerCase() ?? "";
  const shownModels = filter && focus === "model" ? options.filter((id) => prettyModelName(id).toLowerCase().includes(filter) || id.toLowerCase().includes(filter)) : options;
  const shownLevels = filter && focus === "thinking" ? THINKING_LEVELS.filter((l) => l.includes(filter) || THINKING_LABEL[l].toLowerCase().includes(filter)) : THINKING_LEVELS;

  const itemKeys = (act: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onMenu(null);
      button.current?.focus();
      return;
    }
    const items = Array.from(popover.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next !== null) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  const check = (on: boolean) => (on ? <Check s={13} className="text-accent" /> : <span className="w-[13px]" />);

  return (
    <span ref={box} className="relative inline-flex min-w-0">
      <button
        ref={button}
        type="button"
        data-testid="model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${prettyModelName(model)}${thinking ? `, thinking: ${THINKING_LABEL[thinking]}` : ""}`}
        title={`${raw(model)}. ${hint}`}
        disabled={disabled}
        onClick={() => onMenu(menu ? null : { focus: "model" })}
        className={`${PILL} transition-colors duration-150 hover:bg-line/60 disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className="truncate">{prettyModelName(model)}</span>
        {thinking ? <span className="shrink-0 text-dim">{THINKING_LABEL[thinking]}</span> : null}
      </button>
      {open ? (
        <div ref={popover} role="menu" aria-label="Model and thinking" onKeyDown={onMenuKey} className="absolute bottom-full right-0 z-30 mb-2 w-72 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface p-1.5 text-[12px] shadow-lg">
          <div role="group" aria-label="Model">
            <div className="px-2 pb-1 pt-1 text-[11px] text-dim">Model</div>
            {options.length === 1 ? (
              <div className="flex w-full items-center gap-2 px-2 py-1.5">
                {check(true)}
                <span className="truncate text-text">{prettyModelName(options[0])}</span>
                <span className="ml-auto truncate text-[11px] text-dim">{options[0]}</span>
              </div>
            ) : shownModels.length === 0 ? (
              <p className="px-2 py-1 text-muted">No model matches &quot;{menu?.filter}&quot;.</p>
            ) : (
              shownModels.map((id) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={id === model} disabled={saving} onClick={() => pickModel(id)} onKeyDown={itemKeys(() => pickModel(id))} className={ITEM}>
                  {check(id === model)}
                  <span className="truncate text-text">{prettyModelName(id)}</span>
                  <span className="ml-auto truncate text-[11px] text-dim">{id}</span>
                </button>
              ))
            )}
          </div>
          {thinking !== undefined ? (
            <>
              <div className="my-1 border-t border-line" />
              <div role="group" aria-label="Thinking">
                <div className="px-2 pb-1 pt-1 text-[11px] text-dim">Thinking</div>
                {shownLevels.length === 0 ? (
                  <p className="px-2 py-1 text-muted">No level matches &quot;{menu?.filter}&quot;.</p>
                ) : (
                  shownLevels.map((l) => (
                    <button key={l} type="button" role="menuitemradio" aria-checked={l === thinking} title={THINKING_HINT[l]} disabled={saving} onClick={() => pickThinking(l)} onKeyDown={itemKeys(() => pickThinking(l))} className={ITEM}>
                      {check(l === thinking)}
                      <span className="truncate text-text">{THINKING_LABEL[l]}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : null}
          <p className="px-2 pb-0.5 pt-1 text-[11px] text-dim">Applies from your next message.</p>
          {error ? (
            <p role="alert" className="px-2 pb-1 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
