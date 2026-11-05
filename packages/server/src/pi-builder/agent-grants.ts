/**
 * What the person talking to Forge Agent can reach in connected services, and switching an action ON or OFF — proposed
 * by Forge, decided by the person's click. Two places an action can be on, the same two the connector's Apps page has:
 *
 *   - FOR THE WORKSPACE: an ordinary `tools` row, exactly what Apps → <service> → "For the workspace" makes. Automations
 *     and every chat can use it. Needs `plugins.enable` (an admin) and the workspace's own connection.
 *   - FOR ME: a personal action (`plugin_personal_actions`, services/personal-actions.ts), exactly what Apps → <service>
 *     → "For me" makes. The person's chats and the workflows they own can use it, ALWAYS through their own connection
 *     (`mayRunThrough`); nobody else gains it. Needs their own connection, and an admin not having turned personal use
 *     off for that service.
 *
 * ⚠ ONE answer to "what can this person reach": `connectedServices` reads the connections WITH the person as viewer, so
 * their own connection counts in what Forge lists exactly as it counts in `mayDecide`. Listing workspace connections
 * only hid an "only for me" connection from Forge while the person could use it (chat 48357b29, 2026-10-29).
 *
 * ⚠ There is no "this chat only" any more: a chat's card and the Apps page write the same record. The workspace's
 * settings stay the ceiling — Forge Agent must be offered (`assistant`), a CHANGE is still proposed and confirmed on
 * its own card (`agent_changes`, agent-changes.ts), and deleting actions and the raw API call are never switched on.
 */
import { pluginRepo } from "../repositories/plugin.repo.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { effectivePermissionsService } from "../services/effective-permissions.service.js";
import { pluginService } from "../services/plugin.service.js";
import { DECLARED_PREFIX } from "../services/declared-call.js";
import { packsFor } from "../services/declared-call-packs.js";
import { ownConnections, personalTools } from "../services/personal-actions.js";
import {
  connectorPieces,
  isPluginTool,
  parsePluginUrl,
  pluginToolName,
  type PieceActionDescription,
  type PieceDescription,
} from "../services/plugin-connector.service.js";

type Refusal = Error & { statusCode: number };
const refuse = (message: string, statusCode = 403): never => {
  throw Object.assign(new Error(message), { statusCode }) as Refusal;
};

/** The person asking, as verified. */
export type Who = Parameters<typeof effectivePermissionsService.has>[0];

export type GrantScope = "me" | "workspace";
/** Where an action is on now, for this person. */
export type ActionState = "workspace" | "me" | "off";

/** Why an action can never be switched on from chat, or null. */
export function neverFromChat(a: PieceActionDescription): string | null {
  if (a.name === "custom_api_call") return "the raw API call can reach any address of the service, so it is never switched on from chat";
  if (a.destructive) return "it deletes or irreversibly changes data, so it is never switched on from chat";
  if (a.unsupported.length) return `Foundry cannot offer it (${a.unsupported.join("; ")})`;
  return null;
}

/** A service's names as one key: "@activepieces/piece-azure-devops", "azure-devops", "Azure DevOps" all agree. */
export function serviceKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^@activepieces\/piece-/, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The piece a word names: its short name, package name or display name (case, spaces and hyphens ignored), else the
 * ONE piece whose name contains the word ("devops" → Azure DevOps). Several contain it ⇒ none: never a guess.
 */
export function matchService<T extends { name: string; displayName: string }>(pieces: T[], word: string): T | null {
  const k = serviceKey(word);
  if (!k) return null;
  const exact = pieces.find((p) => serviceKey(p.name) === k || serviceKey(p.displayName) === k);
  if (exact) return exact;
  if (k.length < 3) return null;
  const partial = pieces.filter((p) => serviceKey(p.name).includes(k) || serviceKey(p.displayName).includes(k));
  return partial.length === 1 ? partial[0]! : null;
}

/** The installed piece and its action, named by the service (any of its names, `matchService`) or by a tool name. */
export async function findAction(serviceOrTool: string, action?: string): Promise<{ piece: PieceDescription; action: PieceActionDescription }> {
  const pieces = await connectorPieces();
  if (action) {
    const piece = matchService(pieces, serviceOrTool);
    if (!piece) refuse(`No connected service "${serviceOrTool}" is installed here. Installed: ${pieces.map((p) => p.name.replace("@activepieces/piece-", "")).join(", ") || "none"}.`, 404);
    const a = piece!.actions.find((x) => x.name === action || pluginToolName(piece!.name, x.name) === action);
    if (!a) refuse(`${piece!.displayName} has no action "${action}". List them with tools/connector-actions.mjs ${piece!.name.replace("@activepieces/piece-", "")}.`, 404);
    return { piece: piece!, action: a! };
  }
  const want = serviceOrTool.trim().toLowerCase();
  for (const p of pieces) {
    const a = p.actions.find((x) => pluginToolName(p.name, x.name) === want);
    if (a) return { piece: p, action: a };
  }
  return refuse(`No connected-service action is called "${serviceOrTool}". List them with tools/connector-actions.mjs <service>.`, 404);
}

/** The workspace's connection an action would run through: the one its other actions use, else the only one there. */
export async function workspaceConnection(workspaceId: string, piece: string) {
  const conns = (await pluginRepo.listConnections(workspaceId, piece)).filter((c) => !c.ownerSubject);
  if (!conns.length) return null;
  const tools = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => parsePluginUrl(t.url)?.piece === piece && t.isActive !== false);
  return conns.find((c) => tools.some((t) => t.secretEnvName === c.secretName)) ?? conns[0]!;
}

const mayEnable = (workspaceId: string, who: Who) => effectivePermissionsService.has(who, workspaceId, "plugins.enable").catch(() => false);

/**
 * Whether THIS person may switch the action on (or off) at this scope — `true`, or the reason not, in words the card
 * shows. Read fresh at the click as well as when proposed: a role can change in between.
 */
export async function mayDecide(workspaceId: string, who: Who, piece: string, scope: GrantScope): Promise<true | string> {
  if (scope === "workspace") {
    const admin = await mayEnable(workspaceId, who);
    if (!admin) return "Switching it on for the whole workspace needs a person who can change connectors (an Admin).";
    if (!(await workspaceConnection(workspaceId, piece))) return "The workspace has no connection to this service yet. Connect it on its Apps page first.";
    return true;
  }
  // For me: the same rules as the Apps page's "For me" tab (plugin.service.ts `mayUseOwn`), worded for the card.
  if (!(await pluginRepo.personalAllowed(workspaceId, piece))) return "An admin has turned off members switching this service's actions on for themselves in this workspace.";
  if (!who?.subject || !(await ownConnections(workspaceId, piece, who.subject)).length) {
    return "Connect your own account first (Apps → the service → Connect as yourself): actions you switch on for yourself run through it.";
  }
  return true;
}

/** One connected service as this person can reach it. */
export type ConnectedService = {
  piece: PieceDescription;
  /** Its connections this person can see: the workspace's, and their own. Never somebody else's. */
  connections: Array<{ label: string; whose: "workspace" | "yours" }>;
  /** Action → where it is on for this person. Only actions that can be on: never the raw API call. */
  on: Map<string, ActionState>;
  /** Curated declared-call packs offered for the service (declared-call-packs.ts), and where each is on. */
  packs: Array<{ key: string; displayName: string; description: string; on: ActionState }>;
};

/**
 * Every installed service this person can reach in the workspace — through the workspace's connection or their own —
 * with where each action is on FOR THEM. The one definition Forge's list, the turn's message and the cards read.
 */
export async function connectedServices(workspaceId: string, who: Who): Promise<ConnectedService[]> {
  const subject = who?.subject ?? null;
  const [pieces, conns, wsTools, mine] = await Promise.all([
    connectorPieces(),
    pluginRepo.listConnections(workspaceId, undefined, subject),
    toolRepo.listByWorkspace(workspaceId).then((ts) => ts.filter((t) => t.isActive !== false && isPluginTool(t))),
    personalTools(workspaceId, subject),
  ]);
  const where = (tool: string): ActionState => (wsTools.some((t) => t.name === tool) ? "workspace" : mine.some((t) => t.name === tool) ? "me" : "off");
  return pieces
    .filter((p) => conns.some((c) => c.piece === p.name))
    .map((p) => ({
      piece: p,
      connections: conns
        .filter((c) => c.piece === p.name)
        .map((c) => ({ label: c.label, whose: c.ownerSubject ? ("yours" as const) : ("workspace" as const) })),
      on: new Map(
        p.actions
          .filter((a) => a.name !== "custom_api_call")
          .map((a) => [a.name, where(pluginToolName(p.name, a.name))] as const),
      ),
      // A pack is on where any of its calls is: its calls are switched on together.
      packs: packsFor(p.name).map((k) => {
        const states = k.calls.map((c) => where(pluginToolName(p.name, c.name)));
        return { key: k.key, displayName: k.displayName, description: k.description, on: states.includes("workspace") ? "workspace" : states.includes("me") ? "me" : "off" };
      }),
    }));
}

/** A service as one line, the way Forge is told and the way a miss names what is there. */
export function serviceLine(s: ConnectedService): string {
  const short = s.piece.name.replace("@activepieces/piece-", "");
  const via = s.connections.map((c) => (c.whose === "yours" ? `your own connection “${c.label}”` : `the workspace's connection “${c.label}”`)).join(", ");
  const on = [...s.on.values()].filter((x) => x !== "off").length;
  const packs = s.packs.map((k) =>
    k.on === "off"
      ? `the ${k.displayName} pack is offered but off (a person switches it on in Apps → ${s.piece.displayName} → For me; an Admin, For the workspace)`
      : `the ${k.displayName} pack is on ${k.on === "me" ? "for them" : "for everyone"}`,
  );
  return `${short} (${[s.piece.displayName, via, on ? `${on} action${on === 1 ? "" : "s"} on` : "no actions switched on yet", ...packs].join("; ")})`;
}

/**
 * What Forge lists (`tools/connector-actions.mjs`): every action of every service this person can reach, and where each
 * is on. A service named and not reachable is a refusal NAMING what is reachable — "No connected service" alone reads as
 * "nothing is connected" when the word simply was not the service's name.
 */
export async function actionsFor(workspaceId: string, who: Who, service?: string) {
  const all = await connectedServices(workspaceId, who);
  let shown = all;
  if (service?.trim()) {
    const hit = matchService(
      all.map((s) => s.piece),
      service,
    );
    if (!hit) {
      refuse(
        all.length
          ? `No connected service "${service}" here. Connected services you can use: ${all.map(serviceLine).join("; ")}. Ask again with one of those names.`
          : `No connected service "${service}" here: nothing is connected that you can use in this workspace. Connect one as yourself (Apps → the service → Connect, only for me), or ask an Admin to connect it for the workspace.`,
        404,
      );
    }
    shown = all.filter((s) => s.piece.name === hit!.name);
  }
  const detail = !!service?.trim();
  return shown.map((s) => ({
    service: s.piece.name.replace("@activepieces/piece-", ""),
    name: s.piece.displayName,
    connections: s.connections,
    packs: s.packs.map((k) => ({ pack: k.key, name: k.displayName, on: k.on, ...(detail ? { description: k.description } : {}) })),
    actions: s.piece.actions
      .filter((a) => a.name !== "custom_api_call")
      .map((a) => {
        const never = neverFromChat(a);
        return {
          action: a.name,
          tool: pluginToolName(s.piece.name, a.name),
          title: a.displayName,
          on: s.on.get(a.name) ?? "off",
          effect: a.destructive ? "deletes" : a.writes ? "changes" : "reads",
          ...(never ? { never } : {}),
          // Only for the one service asked about: its inputs, so Forge never guesses them.
          ...(detail ? { description: a.description, params: a.params } : {}),
        };
      }),
  }));
}

/** Switch the action on or off for this person — the Apps page's "For me" call, keeping their others as they are. */
export async function applyMine(workspaceId: string, piece: string, action: string, on: boolean, actor: { subject: string; email?: string | null }) {
  const current = (await pluginRepo.personalActions(workspaceId, actor.subject, piece)).map((r) => r.action).filter((a) => !a.startsWith(DECLARED_PREFIX));
  const next = on ? [...new Set([...current, action])] : current.filter((a) => a !== action);
  await pluginService.setMyActions(workspaceId, piece, { actions: next }, actor);
}

/** Switch the action on or off for the whole workspace — the same call Apps makes, keeping the others as they are. */
export async function applyWorkspace(workspaceId: string, piece: string, action: string, on: boolean, actor: { subject: string; email?: string | null }) {
  const conn = await workspaceConnection(workspaceId, piece);
  if (!conn) refuse("The workspace has no connection to this service yet. Connect it on its Apps page first.", 409);
  const current = (await toolRepo.listByWorkspace(workspaceId))
    .filter((t) => t.isActive !== false && t.secretEnvName === conn!.secretName && parsePluginUrl(t.url)?.piece === piece)
    .map((t) => parsePluginUrl(t.url)!.action);
  const next = on ? [...new Set([...current, action])] : current.filter((a) => a !== action);
  await pluginService.setActions(workspaceId, piece, { connectionId: conn!.id, actions: next }, actor);
}
