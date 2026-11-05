/**
 * Forge's instructions for a chat (2026-10-13): the shared core plus the part for the chat's MODE.
 *
 * Workflow Builder builds and changes the chat's one workflow and answers questions about it. Forge Agent does the
 * job now (questions, real data, files, drafts) and never changes the workflow. Each mode carries only its own
 * rules, so Forge no longer decides per message which job it is doing; the person chose.
 *
 * Read from the server's own template (TEMPLATE_ROOT), never from the conversation's folder, which Forge can write.
 * Written into the folder as SYSTEM.md, which Forge loads when its process starts: a mode switch restarts it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_ROOT } from "./paths.js";
import { sandboxDir } from "./sandbox-fs.js";

export const CHAT_MODES = ["workflow", "agent"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export function isChatMode(v: unknown): v is ChatMode {
  return typeof v === "string" && (CHAT_MODES as readonly string[]).includes(v);
}

/** What each mode is called on screen and in what Forge is told. */
export const MODE_NAME: Record<ChatMode, string> = { workflow: "Workflow Builder", agent: "Forge Agent" };

const cache = new Map<string, string>();
function part(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(join(TEMPLATE_ROOT, "instructions", `${name}.md`), "utf8");
    cache.set(name, text);
  }
  return text;
}

export function systemPromptFor(mode: ChatMode): string {
  return `${part("core").trimEnd()}\n\n${part(mode).trimEnd()}\n`;
}

/** Put this mode's instructions where Forge loads them. Takes effect when its process (re)starts. */
export function writeSystemPrompt(workspaceId: string, sessionId: string, mode: ChatMode): void {
  writeFileSync(join(sandboxDir(workspaceId, sessionId), "SYSTEM.md"), systemPromptFor(mode));
}
