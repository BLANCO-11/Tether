/**
 * Personal connector actions (plans/personal-actions-2026-10-29): an action a member switched on for THEMSELVES.
 *
 * At run time it is a tool shaped like the row Apps writes for the workspace — so a call goes through exactly the same
 * path — with three differences that are the whole point:
 *   - it exists only for its person: their Forge chats, and workflows they own (live) or test (draft);
 *   - its credential is ALWAYS that person's own connection, never the workspace's (`mayRunThrough`);
 *   - it is built fresh from the records every time, so switching it off, an admin turning personal use off, or the
 *     person's connection going away takes effect at the next call, refused by name.
 */
import { config } from "../config/index.js";
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";
import type { Tool } from "../repositories/tool.repo.js";
import { DECLARED_PREFIX, declaredDescription, declaredParams, type DeclaredCall } from "./declared-call.js";
import { connectorPieces, pluginToolName, pluginUrl, toolDescription, type PieceActionDescription, type PieceDescription } from "./plugin-connector.service.js";

/** A personal tool's id names its person, so it can never be mistaken for a workspace row. */
const PREFIX = "mine:";
export const isPersonalTool = (t: Pick<Tool, "id">): boolean => String(t.id).startsWith(PREFIX);

/** Whether a piece's action may be switched on for oneself — the same set the workspace may switch on. */
export function personallyOfferable(a: PieceActionDescription): boolean {
  return a.name !== "custom_api_call" && !a.name.startsWith(DECLARED_PREFIX) && a.unsupported.length === 0;
}

/** The person's own connections to a piece, oldest first. */
export async function ownConnections(workspaceId: string, piece: string, subject: string): Promise<PluginConnection[]> {
  return (await pluginRepo.listConnections(workspaceId, piece, subject)).filter((c) => c.ownerSubject === subject);
}

/**
 * Every action `subject` has on for themselves here, as tools. Left out — never half-built: a piece no longer
 * installed, an action the installed version no longer has, a declared call whose record is gone, a piece whose
 * personal use an admin turned off, and a piece the person has no own connection to.
 */
export async function personalTools(workspaceId: string, subject: string | null | undefined): Promise<Tool[]> {
  if (!subject || !config.plugins.enabled) return [];
  const rows = await pluginRepo.personalActions(workspaceId, subject);
  if (!rows.length) return [];
  const pieces = await connectorPieces().catch(() => [] as PieceDescription[]);
  const out: Tool[] = [];
  for (const pieceName of [...new Set(rows.map((r) => r.piece))]) {
    const p = pieces.find((x) => x.name === pieceName);
    if (!p || !(await pluginRepo.personalAllowed(workspaceId, pieceName))) continue;
    const conn = (await ownConnections(workspaceId, pieceName, subject))[0];
    if (!conn) continue;
    const declared = rows.some((r) => r.piece === pieceName && r.action.startsWith(DECLARED_PREFIX)) ? await pluginRepo.declaredCalls(workspaceId, pieceName) : [];
    for (const r of rows.filter((x) => x.piece === pieceName)) {
      const base = { workspaceId, method: "POST", secretEnvName: conn.secretName, authStyle: null, isActive: true };
      if (r.action.startsWith(DECLARED_PREFIX)) {
        if (!p.actions.some((a) => a.name === "custom_api_call")) continue;
        const d = declared.find((x) => `${DECLARED_PREFIX}${x.hash}` === r.action);
        if (!d) continue;
        const call = { ...(d.declaration as object), name: d.name, displayName: d.displayName, description: d.description } as DeclaredCall;
        out.push({
          ...base,
          id: `${PREFIX}${subject}:${pieceName}:${r.action}`,
          name: pluginToolName(p.name, d.name),
          url: pluginUrl({ piece: p.name, version: p.version, action: r.action }),
          description: declaredDescription(p.displayName, call),
          paramsSchema: declaredParams(call),
        } as unknown as Tool);
        continue;
      }
      const a = p.actions.find((x) => x.name === r.action);
      if (!a || !personallyOfferable(a)) continue;
      out.push({
        ...base,
        id: `${PREFIX}${subject}:${pieceName}:${a.name}`,
        name: pluginToolName(p.name, a.name),
        url: pluginUrl({ piece: p.name, version: p.version, action: a.name }),
        description: toolDescription(p, a),
        paramsSchema: a.params,
      } as unknown as Tool);
    }
  }
  return out;
}

/**
 * ⚠ The one rule that keeps a personal action personal: it may run only through a connection OWNED by the person it is
 * running for. Called on the connection a run or a chat resolved, right before the call.
 */
export async function mayRunThrough(workspaceId: string, tool: Pick<Tool, "id">, secretName: string, subject: string | null | undefined): Promise<true | string> {
  if (!isPersonalTool(tool)) return true;
  const conn = (await pluginRepo.listConnections(workspaceId, undefined, subject ?? null)).find((c) => c.secretName === secretName);
  if (conn && subject && conn.ownerSubject === subject) return true;
  return "it is switched on for one person only, so it runs only through that person's own connection";
}
