/**
 * What an automation TOUCHES — its owner's own things only, or anything of the workspace's (plugins phase 9,
 * 2026-10-29). It decides who may switch the automation on: an automation that uses only its owner's own things,
 * its owner; anything of the workspace's, a reviewer, as before.
 *
 * Computed by the server from the revision itself — its workflow's declared uses (which the step API holds every
 * run to, `forge-uses.ts`) and the connection it runs as per service (`model.accounts`, which only the server
 * writes). Never from the client, and it fails closed: anything not positively the owner's is the workspace's.
 *
 * The owner's own:
 *   - a connected service called through the owner's OWN connection ("only for me"), chosen for this revision;
 *   - the AI summary tool (`llm_complete`) — its usage is counted per person;
 *   - steps that only compute.
 * The workspace's: every read of a workspace datasource, every file in the shared Files library, the org mailbox
 * (`tether_email_send`), a service called through the workspace's connection, any other tool (it carries the
 * workspace's credentials), and anything this workspace no longer has.
 */
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { declaredUses } from "./forge-uses.js";
import { EMAIL_TOOL_NAME, LLM_TOOL_NAME } from "./platform-tool-names.js";
import { parsePluginUrl } from "./plugin-connector.service.js";
import type { PiRevisionModel } from "./pi-flow.service.js";

export type Reach = {
  /** True when every thing it uses is its owner's own — the owner may switch it on. */
  ownOnly: boolean;
  /** Each thing of the workspace's it uses, in words. Empty when `ownOnly`. */
  workspace: string[];
  /** Each of the owner's own things it uses, in words. */
  own: string[];
};

/** What the classification needs to know about the workspace — loaded by `reachOf`, given directly by tests. */
export type ReachFacts = {
  tools: Map<string, { url: string | null }>;
  connections: Map<string, Pick<PluginConnection, "piece" | "ownerSubject">>;
};

const serviceName = (piece: string) => piece.replace(/^@activepieces\/piece-/, "");

export function classifyReach(model: Pick<PiRevisionModel, "workflow" | "accounts">, facts: ReachFacts, ownerSubject: string | null): Reach {
  const uses = declaredUses(model.workflow);
  const workspace: string[] = [];
  const own: string[] = [];
  for (const name of [...uses.reads].sort()) workspace.push(`reads the workspace's data ("${name}")`);
  for (const name of [...uses.files].sort()) workspace.push(`reads "${name}" from the workspace's Files`);
  for (const name of [...uses.tools].sort()) {
    if (name === LLM_TOOL_NAME) {
      own.push("the AI summary tool");
      continue;
    }
    if (name === EMAIL_TOOL_NAME) {
      workspace.push("sends email from the workspace's mailbox");
      continue;
    }
    const tool = facts.tools.get(name);
    if (!tool) {
      workspace.push(`uses "${name}", which this workspace does not have`);
      continue;
    }
    const plugin = parsePluginUrl(tool.url);
    if (!plugin) {
      workspace.push(`calls "${name}" with the workspace's credentials`);
      continue;
    }
    const service = serviceName(plugin.piece);
    const choice = model.accounts?.[plugin.piece];
    const conn = choice ? facts.connections.get(choice.connectionId) : undefined;
    // In My space it always uses its owner's own account (sharing-boundaries Q3) — its owner's thing, by definition.
    if (choice?.own && ownerSubject) {
      own.push(`your own ${service} account`);
    } else if (choice && conn && conn.piece === plugin.piece && ownerSubject && conn.ownerSubject === ownerSubject) {
      own.push(`your own ${service} connection “${choice.label}”`);
    } else {
      workspace.push(`uses ${service} through the workspace's connection`);
    }
  }
  // An automation nobody can be shown to own has no owner to switch it on.
  if (!ownerSubject) workspace.unshift("has no owner");
  return { ownOnly: workspace.length === 0, workspace: [...new Set(workspace)], own: [...new Set(own)] };
}

/** `classifyReach` with the workspace's tools and the revision's chosen connections loaded. */
export async function reachOf(
  workspaceId: string,
  model: Pick<PiRevisionModel, "workflow" | "accounts">,
  ownerSubject: string | null,
  /** Where it lives: in My space its services are its owner's own whatever was stored (Q3). */
  place?: { visibility: string; projectId?: string | null },
): Promise<Reach> {
  if (place) {
    const { effectiveAccounts } = await import("./run-as.service.js");
    model = { ...model, accounts: await effectiveAccounts(workspaceId, { ...place, ownerSubject }, model as never) };
  }
  const tools = new Map((await toolRepo.listByWorkspace(workspaceId)).map((t) => [t.name, { url: t.url }]));
  const connections = new Map<string, Pick<PluginConnection, "piece" | "ownerSubject">>();
  for (const choice of Object.values(model.accounts ?? {})) {
    // "Each person" and "its owner's own" name no connection: nothing to look up.
    if (!choice.connectionId) continue;
    const c = await pluginRepo.getConnection(workspaceId, choice.connectionId);
    if (c) connections.set(c.id, c);
  }
  return classifyReach(model, { tools, connections }, ownerSubject);
}
