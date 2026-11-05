/**
 * What a workflow needs before it can run, and who can fix each thing (sharing-boundaries phase 4, D7). ONE check,
 * asked wherever it matters — the workflow's page when it opens, before Run, before "Turn on for me", before approving,
 * on a duplicate, and by the runner before a live run starts — so nothing is first found out after something was sent.
 *
 * Five causes, each a sentence naming who fixes it:
 *   not_installed   — the connector is not installed on this deployment (a platform admin).
 *   not_enabled     — the action is not switched on in this workspace (an Admin; or the person, "For me").
 *   not_connected   — nobody connected the account it needs: the workspace's (an Admin), or the person's own (them).
 *   choose_account  — the person has several accounts of their own for it and has not said which (them).
 *   connection_gone — the account it was approved to use is gone or no longer its owner's (its owner, or an Admin).
 *
 * It reads; it decides nothing about who may SEE or RUN the workflow (content-visibility, the guards). It answers for one
 * person — whoever would run it: on a workflow that runs on each person's own account, that person's accounts count.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { personAccountChoices } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { parsePluginUrl, type PieceDescription } from "./plugin-connector.service.js";
import type { PiRunAs } from "./run-as.service.js";

export type NeedCause = "not_installed" | "not_enabled" | "not_connected" | "choose_account" | "connection_gone";
export type Need = {
  cause: NeedCause;
  /** The service as people read it ("GitHub"), or the tool's name when it is not a connector. */
  service: string;
  piece: string | null;
  message: string;
  /** Who can fix it, in words: "you", "an Admin", "its owner", "a platform admin". */
  fixBy: string;
  /** Where to fix it, when there is a page for it. */
  href: string | null;
  /** For `choose_account`: the person's own accounts to choose from. */
  options?: Array<{ connectionId: string; label: string }>;
};
export type Readiness = { ready: boolean; needs: Need[] };

const connectorPage = (piece: string, tab?: "mine") => `/apps/${encodeURIComponent(piece)}${tab ? `?tab=${tab}` : ""}`;

/** The connection a person's runs use for a service when they have several — null when not chosen, or no longer theirs. */
export async function chosenAccount(workspaceId: string, subject: string, piece: string, own: PluginConnection[]): Promise<PluginConnection | null> {
  const [row] = await db
    .select()
    .from(personAccountChoices)
    .where(and(eq(personAccountChoices.workspaceId, workspaceId), eq(personAccountChoices.subject, subject), eq(personAccountChoices.piece, piece)));
  return (row && own.find((c) => c.id === row.connectionId)) || null;
}

/** Remember which of their own accounts a person's runs use for a service. Only one of their own is accepted. */
export async function chooseAccount(workspaceId: string, subject: string, piece: string, connectionId: string): Promise<void> {
  const conn = await pluginRepo.getConnection(workspaceId, connectionId);
  if (!conn || conn.piece !== piece || conn.ownerSubject !== subject) {
    throw Object.assign(new Error("That is not one of your own accounts for this service."), { statusCode: 403 });
  }
  await db
    .insert(personAccountChoices)
    .values({ workspaceId, subject, piece, connectionId })
    .onConflictDoUpdate({ target: [personAccountChoices.workspaceId, personAccountChoices.subject, personAccountChoices.piece], set: { connectionId, chosenAt: new Date() } });
}

/** A person's own connections to a service. */
export async function ownConnections(workspaceId: string, subject: string, piece: string): Promise<PluginConnection[]> {
  return (await pluginRepo.listConnections(workspaceId, piece, subject)).filter((c) => c.ownerSubject === subject);
}

/**
 * Readiness of a workflow's revision for one person. `revision` defaults to the approved one (what a live run runs),
 * else the draft. `person` is who would run it — null for a schedule or a reviewer's look, where each person's own
 * accounts are not asked about (each person is asked when THEY run it or turn it on).
 */
export async function readinessOf(
  workspaceId: string,
  flowId: string,
  opts: { person: string | null; revision?: "approved" | "draft" | number },
): Promise<Readiness | null> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow || flow.runtime !== "foundry") return flow ? { ready: true, needs: [] } : null;
  const rev = typeof opts.revision === "number" ? opts.revision : opts.revision === "draft" ? flow.draftRevision : (flow.armedRevision ?? flow.draftRevision);
  const row = rev ? await flowRepo.getRevision(flow.id, rev) : undefined;
  const model = row?.modelJson as { workflow?: unknown; files?: Record<string, string>; accounts?: Record<string, PiRunAs> } | undefined;
  if (!model?.workflow) return { ready: true, needs: [] };
  // What it ACTUALLY runs as where it lives — in My space, its owner's own accounts (Q3).
  const { effectiveAccounts } = await import("./run-as.service.js");
  model.accounts = await effectiveAccounts(workspaceId, flow, model);
  const { forgeRefsOf } = await import("./pi-flow.service.js");
  const names = forgeRefsOf(model as never).filter((n) => !n.includes("."));

  const { connectorPieces } = await import("./plugin-connector.service.js");
  const pieces: PieceDescription[] | null = await connectorPieces().catch(() => null);
  const display = (piece: string) => pieces?.find((p) => p.name === piece)?.displayName ?? piece.replace("@activepieces/piece-", "");

  const all = await toolRepo.listByWorkspace(workspaceId);
  const { personalTools } = await import("./personal-actions.js");
  const mine = opts.person ? await personalTools(workspaceId, opts.person) : [];
  const needs: Need[] = [];
  const pieceTool = new Map<string, (typeof all)[number]>();

  for (const name of names) {
    const tool = all.find((t) => t.name === name);
    if (tool && tool.isActive === false) {
      needs.push({ cause: "not_enabled", service: name, piece: parsePluginUrl(tool.url)?.piece ?? null, fixBy: "an Admin", href: "/tools", message: `It uses “${name}”, which is switched off in this workspace. An Admin switches it on.` });
      continue;
    }
    if (tool) {
      const ref = parsePluginUrl(tool.url);
      if (ref) {
        if (pieces && !pieces.some((p) => p.name === ref.piece)) {
          needs.push({ cause: "not_installed", service: display(ref.piece), piece: ref.piece, fixBy: "a platform admin", href: null, message: `${display(ref.piece)} is not installed on this deployment. A platform admin installs it.` });
          continue;
        }
        if (!pieceTool.has(ref.piece)) pieceTool.set(ref.piece, tool);
      }
      continue;
    }
    if (mine.some((t) => t.name === name)) continue;
    // Named by the workflow and nowhere in this workspace: a connector action nobody switched on, or a tool removed.
    const piece = pieces?.find((p) => name.startsWith(`${p.name.replace("@activepieces/piece-", "").replace(/-/g, "_")}_`))?.name ?? null;
    needs.push(
      piece
        ? { cause: "not_enabled", service: display(piece), piece, fixBy: "an Admin, or you for yourself", href: connectorPage(piece), message: `It uses the ${display(piece)} action “${name}”, which is not switched on here. An Admin switches it on for the workspace, or you switch it on for yourself (“For me”).` }
        : { cause: "not_enabled", service: name, piece: null, fixBy: "its owner", href: null, message: `It uses “${name}”, which this workspace no longer has. Its owner changes the workflow.` },
    );
  }

  for (const [piece, tool] of pieceTool) {
    const service = display(piece);
    const choice = model.accounts?.[piece];
    if (choice?.each || choice?.own) {
      // Each person: whoever runs it. Its owner's own (My space): the owner, whoever is looking.
      const person = choice.own ? (flow.ownerSubject ?? null) : opts.person;
      if (!person) continue;
      const you = person === opts.person;
      const own = await ownConnections(workspaceId, person, piece);
      if (!own.length) {
        needs.push(
          you
            ? { cause: "not_connected", service, piece, fixBy: "you", href: connectorPage(piece, "mine"), message: `It runs on your own ${service} account, and you have not connected one. Connect it on the ${service} page (“For me”).` }
            : { cause: "not_connected", service, piece, fixBy: "its owner", href: null, message: `It runs on its owner's own ${service} account, and they have not connected one. Its owner connects it.` },
        );
      } else if (own.length > 1 && !(await chosenAccount(workspaceId, person, piece, own))) {
        needs.push(
          you
            ? { cause: "choose_account", service, piece, fixBy: "you", href: null, options: own.map((c) => ({ connectionId: c.id, label: c.label })), message: `You have ${own.length} ${service} accounts of your own. Choose which one your runs use.` }
            : { cause: "choose_account", service, piece, fixBy: "its owner", href: null, message: `Its owner has ${own.length} ${service} accounts of their own and has not chosen which its runs use.` },
        );
      }
      continue;
    }
    if (choice) {
      const conn = await pluginRepo.getConnection(workspaceId, choice.connectionId);
      const ownerOk = !conn?.ownerSubject || conn.ownerSubject === flow.ownerSubject;
      if (!conn || conn.piece !== piece || !ownerOk) {
        needs.push(
          choice.personal
            ? { cause: "connection_gone", service, piece, fixBy: "its owner", href: `/flows/${flow.id}`, message: `It runs on its owner's own ${service} account “${choice.label}”, which is gone or no longer theirs. Its owner chooses its account again, then it is approved again.` }
            : { cause: "connection_gone", service, piece, fixBy: "an Admin", href: connectorPage(piece), message: `It runs on the workspace's ${service} account “${choice.label}”, which was removed. An Admin connects one, then its owner chooses it again.` },
        );
      }
      continue;
    }
    // Nothing chosen: the action's own (the workspace's) connection.
    const shared = (await pluginRepo.listConnections(workspaceId, piece, null)).filter((c) => !c.ownerSubject && c.secretName === tool.secretEnvName);
    if (!shared.length) {
      needs.push({ cause: "not_connected", service, piece, fixBy: "an Admin", href: connectorPage(piece), message: `The workspace has no ${service} account connected for it. An Admin connects one.` });
    }
  }
  return { ready: needs.length === 0, needs };
}

/** One sentence for a refusal: what is missing first, and how many more. */
export function needsSentence(r: Readiness): string {
  const [first, ...rest] = r.needs;
  if (!first) return "";
  return `${first.message}${rest.length ? ` (${rest.length} more thing${rest.length === 1 ? "" : "s"} to fix — see the workflow's page.)` : ""}`;
}
