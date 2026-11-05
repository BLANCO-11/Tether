/**
 * Which connection a Forge chat uses for a connected service (plugins 8.4–8.5, 2026-10-28).
 *
 * The person decides, never Forge and never a silent default (user: "ask user what to use, let user define it. never
 * assume unless made very clear"). For a call, the connections that COULD serve it are:
 *   - the workspace's connection, when the action runs through it (it is on for the workspace, or allowed in this chat
 *     through the workspace's connection);
 *   - the person's own ("only for me") connections to the service.
 * One ⇒ it is used, and named. Several ⇒ the chat's remembered choice if it is still one of them, else the person is
 * asked on a card and nothing runs. None ⇒ refused, saying how to connect.
 */
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";
import type { Tool } from "../repositories/tool.repo.js";
import { connectionOwning } from "../services/plugin-credentials.js";
import type { PiAccount, PiAccountChoice, PiAccountQuestion } from "./types.js";

export type AccountOption = PiAccount & { secretName: string };
export type Resolution =
  | { kind: "use"; account: AccountOption }
  | { kind: "ask"; question: PiAccountQuestion }
  | { kind: "none"; why: string };

const view = (c: PluginConnection): AccountOption => ({
  connectionId: c.id,
  label: c.label,
  personal: c.ownerSubject != null,
  identity: c.lastTestOk ? (c.lastTestMessage ?? null) : null,
  secretName: c.secretName,
});

/** The connections that could serve this tool's call for this person, the workspace's first. */
export async function accountOptions(workspaceId: string, piece: string, tool: Pick<Tool, "secretEnvName">, subject: string | null | undefined): Promise<AccountOption[]> {
  const out: AccountOption[] = [];
  const owner = await connectionOwning(workspaceId, tool.secretEnvName);
  if (owner && !owner.ownerSubject && owner.piece === piece) out.push(view(owner));
  if (subject) {
    for (const c of await pluginRepo.listConnections(workspaceId, piece, subject)) {
      if (c.ownerSubject === subject) out.push(view(c));
    }
  }
  return out;
}

export async function resolveAccount(
  workspaceId: string,
  piece: string,
  service: string,
  tool: Pick<Tool, "secretEnvName">,
  subject: string | null | undefined,
  choices: Record<string, PiAccountChoice>,
  /** A workflow in My space: only the person's own connections (sharing-boundaries Q3) — no workspace one is offered. */
  opts: { ownOnly?: boolean } = {},
): Promise<Resolution> {
  const options = (await accountOptions(workspaceId, piece, tool, subject)).filter((o) => !opts.ownOnly || o.personal);
  if (!options.length && opts.ownOnly) {
    return {
      kind: "none",
      why: `This workflow is in My space, so it uses your own ${service} account, and you have not connected one. Connect it on Apps → ${service} → Connect (only for me). To use the workspace's ${service}, move the workflow to a project or the Workspace.`,
    };
  }
  if (!options.length) {
    return { kind: "none", why: `There is no ${service} connection you can use here. Connect it as yourself on Apps → ${service} → Connect (only for me), or ask an Admin to connect it for the workspace.` };
  }
  const chosen = choices[piece] && options.find((o) => o.connectionId === choices[piece]!.connectionId);
  if (chosen) return { kind: "use", account: chosen };
  if (options.length === 1) return { kind: "use", account: options[0]! };
  return { kind: "ask", question: { piece, service, options: options.map(({ secretName: _s, ...o }) => o) } };
}

/** How a connection is named on a card and to Forge: "your own GitHub “Mine” (Connected as x)". */
export function accountLine(a: PiAccount, service: string): string {
  const whose = a.personal ? `your own ${service} connection` : `the workspace's ${service} connection`;
  return `${whose} “${a.label}”${a.identity ? ` (${a.identity})` : ""}`;
}

/** The message Forge gets when it must stop and let the person choose. */
export function askMessage(q: PiAccountQuestion): string {
  return (
    `Nothing was done: more than one ${q.service} connection could be used here (${q.options.map((o) => `“${o.label}”${o.personal ? ", their own" : ", the workspace's"}`).join("; ")}). ` +
    `A card under your reply asks the person which one to use in this chat. Tell them to choose on the card, then stop: ` +
    `do not call ${q.service} again in this reply, and never choose one yourself.`
  );
}
