// src/components/home/HomeComposer.tsx — the home page's prompt composer.
//
// `S-01 § Layout`: *"a single bordered card spanning the full content width:
// textarea on the first row, a control strip beneath (`+`, `@`, `Ask before
// changes ▾` on the left; `Send` on the right)"*, with the suggestion chips
// **outside and below** the card. Copy is verbatim from `S-01 § Copy`:
// `Describe what you want to automate...` and `Send`.
//
// ── WHAT IS NOT DRAWN, AND WHY EACH ABSENCE IS DELIBERATE ───────────────────
//
// ⚠ `+` and `@` are the attachment and reference pickers — the pack's own S-04,
// which is not built. A control that opens nothing is worse than an absent one: it
// reads as a feature and reports as a bug, and `flows/01` is explicit that the
// restricted row in that picker *"is not optional"*, so a stub would misrepresent
// the one part of it that carries a policy.
//
// ⚠ `Ask before changes ▾` is the AI mode selector (S-15), and whether Foundry's
// assistant proposes a diff or applies an op is **`UX-002`, an OPEN decision** —
// `flow-chat` applies today. Rendering a selector whose safe-looking default is
// not what happens would be a claim about behaviour, made by a dropdown.
//
// ⚠ The four suggestion chips (`Monthly compliance report`, …) are prototype copy
// with nothing behind them. There is no template read in `lib/api.ts` to derive
// real ones from, and four invented prompts on the landing page would be
// fabricated content in the one place a new person looks first.
//
// ── WHERE SEND GOES ─────────────────────────────────────────────────────────
//
// To the chat builder, carrying the text as `?q=`. It does NOT create anything and
// does NOT auto-send: `/flows/new` prefills its composer and the person presses
// Send there. Auto-sending from a page they are leaving would start a real
// generation from a keystroke they never confirmed, and `goal` mode has no door
// any more (FE-2b.1) — chat is the entry that exists.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function HomeComposer() {
  const router = useRouter();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;

  const send = () => {
    if (!ready) return;
    router.push(`/chats/new?q=${encodeURIComponent(text.trim())}`);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="pi-composer"
    >
      <label htmlFor="home-composer" className="sr-only">
        Describe what you want to automate
      </label>
      <textarea
        id="home-composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⚠ Enter sends, Shift+Enter makes a line — the composer's own idiom in
          // `ChatPanel`. A composer where Enter inserts a newline and the button is
          // the only way out is the slower half of the two, and this text is one
          // sentence far more often than it is a paragraph.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder="Describe what you want to automate..."
        className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-text placeholder:text-dim focus:outline-none"
      />
      {/* The control strip. The left side is empty today — see the header note on
          `+`, `@` and the mode selector — so the strip carries the one verb that
          works, right-aligned as the capture has it. */}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-caption text-dim">Enter to send · Shift+Enter for a new line</span>
        <Button type="submit" size="sm" disabled={!ready} title={ready ? undefined : "Describe what you want to automate first"}>
          Send
        </Button>
      </div>
    </form>
  );
}
