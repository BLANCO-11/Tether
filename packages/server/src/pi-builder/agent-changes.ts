/**
 * Forge Agent's changes to connected services — PROPOSED by Forge, PERFORMED only by the person's click
 * (plans/plugins-2026-10-27, phase 6, decision 2).
 *
 * ⚠ **Why the click, and not a question card.** A question's answer travels through files in Forge's own folder, which
 * Forge can write: a "Yes" there cannot be told from one Forge wrote itself. So Forge's call can only ever PROPOSE
 * (`tools/propose-change.mjs` → `POST /api/forge/propose`, checked and stored, nothing performed). The change happens
 * when the person who asked clicks "Do it" in their own browser — a request carrying THEIR identity, to a route Forge
 * holds no key for — and the server then runs exactly the stored call, once.
 *
 * The rules, each checked when proposed AND again when clicked (a setting or a tool can change in between):
 *   - the workspace allows it (`workspaces.agent_changes`, off by default; it needs Forge Agent on as well);
 *   - the tool is an enabled connector action of this workspace;
 *   - it CHANGES something — a read is just done with use-plugin — and it does not DELETE: a deleting action is never
 *     proposed from chat;
 *   - its values are valid for the action (the connector checks them in capture mode, which performs nothing).
 * It runs through the person's own connection to that connector when they have one ("as me"), else the workspace's.
 */
import { config } from "../config/index.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { auditService } from "../services/audit.service.js";
import { connectorPieces, invokePluginTool, isPluginTool, parsePluginUrl, type PieceActionDescription } from "../services/plugin-connector.service.js";
import type { PiProposal } from "./types.js";

type Refusal = Error & { statusCode: number };
const refuse = (message: string, statusCode = 403): never => {
  throw Object.assign(new Error(message), { statusCode }) as Refusal;
};

/** At most this many proposals in one reply: a card per change, and a person reads each. */
export const MAX_PROPOSALS_PER_TURN = 5;
/** At most this many entries in one batch proposal (one action, many items): one card, one table, one click. */
export const MAX_BATCH = 25;

/** A proposal's params as the list of calls it stands for (one, or a batch). Refuses a shape that is neither. */
export function callsOf(params: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(params) ? params : [params];
  if (!list.length) refuse("A batch needs at least one entry.", 400);
  if (list.length > MAX_BATCH) refuse(`At most ${MAX_BATCH} entries in one proposal; split the rest into another.`, 400);
  for (const x of list) if (!x || typeof x !== "object" || Array.isArray(x)) refuse("Each entry must be one JSON object of parameters.", 400);
  return list as Array<Record<string, unknown>>;
}

/** The workspace's two settings, read fresh. */
export async function changesAllowed(workspaceId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!config.plugins.enabled) return { ok: false, why: "Connected services are not turned on in this deployment." };
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws?.assistant) return { ok: false, why: "This workspace does not offer Forge Agent." };
  if (!ws.agentChanges) {
    return {
      ok: false,
      why: "This workspace lets Forge Agent read from connected services, not change them. A super admin can allow confirmed changes in the workspace's settings (Organization → the workspace → What Forge may do here).",
    };
  }
  return { ok: true };
}

/** The enabled connector tool and its action, or a refusal naming what is there instead. */
export async function proposable(workspaceId: string, toolName: string, chatTools: Tool[] = []): Promise<{ tool: Tool; action: PieceActionDescription; connector: string }> {
  const ws = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => t.isActive !== false && isPluginTool(t));
  // Actions the person switched on for themselves (agent-grants.ts) count as well; a workspace tool of the same name wins.
  const tools = [...ws, ...chatTools.filter((c) => !ws.some((t) => t.name === c.name))];
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) refuse(`There is no connected-service tool named "${toolName}". ${tools.length ? `Use one of: ${tools.map((t) => t.name).join(", ")}.` : "This workspace has none."}`, 404);
  const ref = parsePluginUrl(tool!.url)!;
  const piece = (await connectorPieces()).find((p) => p.name === ref.piece);
  const action = piece?.actions.find((a) => a.name === ref.action);
  if (!piece || !action) refuse(`"${toolName}" is not available on the connector service right now.`, 409);
  if (action!.destructive) refuse(`"${toolName}" deletes or irreversibly changes data, so it is never done from chat. The person can do it in ${piece!.displayName} themselves, or a workflow can, after approval.`);
  if (!action!.writes) refuse(`"${toolName}" only reads. Run it now with tools/use-plugin.mjs; there is nothing to confirm.`, 400);
  return { tool: tool!, action: action!, connector: piece!.displayName };
}

/**
 * A value standing in for one not yet known: "PLACEHOLDER", "TODO", "<content>", "{{sha}}", "…". Refused by name
 * (chat 4ecefa5a: Forge could not see an action's inputs and proposed committing the literal text "PLACEHOLDER" as
 * index.html; only GitHub's refusal stopped it). The connector's own check cannot see it: a placeholder is a valid
 * string. Exact whole values only, so ordinary text that mentions the word passes.
 */
const PLACEHOLDER = /^\s*(placeholder|todo|tbd|tba|fixme|xxx+|changeme|replace[ _-]?me|your[ _-]\w+[ _-]here|<[^<>]{1,60}>|\{\{[^{}]{1,60}\}\}|\[[A-Z_ ]{3,40}\]|\.{3}|…)\s*$/i;
export function placeholdersIn(calls: Array<Record<string, unknown>>): string[] {
  return calls.flatMap((c, i) =>
    Object.entries(c)
      .filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v))
      .map(([k, v]) => `${calls.length > 1 ? `entry ${i + 1}: ` : ""}${k} = "${String(v).trim()}"`),
  );
}

/** The values, checked by the connector without performing anything: what is proposed is what can run. */
export async function checkValues(workspaceId: string, tool: Tool, params: unknown, actingSubject?: string | null, secretName?: string | null): Promise<void> {
  const calls = callsOf(params);
  const held = placeholdersIn(calls);
  if (held.length) {
    refuse(
      `These values are placeholders, not the real ones: ${held.join("; ")}. Work out the real values first (read catalogue.json for what each parameter takes, look up what you can, or ask the person), then propose again.`,
      400,
    );
  }
  const { results } = await invokePluginTool(workspaceId, tool, calls, undefined, { actingSubject, secretName }); // no run ⇒ capture: a change is only recorded
  results.forEach((r, i) => {
    const which = calls.length > 1 ? ` (entry ${i + 1})` : "";
    if (!r.ok) refuse(`Those values do not work for "${tool.name}"${which}: ${r.error ?? "no answer"}. Fix them and propose again.`, 400);
    if (!r.captured) refuse(`"${tool.name}" ran as a read, so there is nothing to confirm.`, 400);
  });
}

/**
 * Where the result can be seen at the service — its web page, never an API address: the first `html_url`, `web_url`,
 * `permalink` or `webViewLink` in the answer, else a `url` on a host that is not an API host. Taken from the WHOLE
 * answer (the stored text is shortened, and a link cut in half is worse than none). https only.
 */
export function answerLink(data: unknown): string | null {
  const seen = new Set<unknown>();
  const found: Record<"page" | "url", string | null> = { page: null, url: null };
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4 || seen.has(v) || (found.page && found.url)) return;
    seen.add(v);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && /^https:\/\//.test(x)) {
        if (!found.page && /^(html_url|web_url|permalink|webViewLink|htmlUrl|webUrl)$/.test(k)) found.page = x;
        else if (!found.url && k === "url" && !/^https:\/\/(api\.|[^/]*\/_apis\/)/.test(x) && !/\/_apis\//.test(x)) found.url = x;
      }
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(data, 0);
  return found.page ?? found.url;
}

/** A few facts a person recognises in the answer (its number, name, state, a short sha), each at most once. */
export function answerBrief(data: unknown): Array<[string, string]> {
  const keys = ["number", "title", "name", "path", "state", "status", "sha"];
  const out: Array<[string, string]> = [];
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || depth > 2 || out.length >= 4) return;
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (out.some(([kk]) => kk === k) || (typeof x !== "string" && typeof x !== "number")) continue;
      const text = String(x);
      if (!text || text.length > 80 || out.some(([, vv]) => vv === text)) continue;
      out.push([k, k === "sha" ? text.slice(0, 7) : text]);
      if (out.length >= 4) return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

/** Shorten what a service answered to what a card can show. */
export function shortResult(data: unknown): string {
  const s = typeof data === "string" ? data : JSON.stringify(data ?? null);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

/**
 * Perform a confirmed proposal: the rules again, then exactly the stored call, through the person's own connection
 * when they have one. Recorded in the workspace audit under the PERSON. Never throws for the service's own refusal —
 * that is the card's answer ("failed: …").
 */
export async function performConfirmed(
  workspaceId: string,
  p: PiProposal,
  person: { subject: string; label: string },
  where: { chatId: string | null },
  chatTools: Tool[] = [],
  /**
   * ⚠ The connection the PERSON chose for this chat (connection-choice.ts), re-checked at the click by the caller —
   * never picked here (plugins 8.5: no silent default). Absent ⇒ the tool's own (the workspace's) connection.
   */
  use?: { secretName: string; personal: boolean; label?: string },
): Promise<Pick<PiProposal, "status" | "result" | "results" | "via" | "link" | "brief">> {
  const allowed = await changesAllowed(workspaceId);
  if (!allowed.ok) refuse(allowed.why, 409);
  const { tool } = await proposable(workspaceId, p.tool, chatTools);
  const via: "personal" | "workspace" = use?.personal ? "personal" : "workspace";
  const calls = callsOf(p.params);
  const batch = Array.isArray(p.params);
  let status: "done" | "partial" | "failed";
  let result: string;
  let each: Array<{ ok: boolean; result: string; link?: string | null; brief?: Array<[string, string]> }> | undefined;
  try {
    // One call per entry, in order; an entry the service refuses does not stop the rest (each is reported).
    const { results } = await invokePluginTool(workspaceId, tool, calls, undefined, { confirmed: true, secretName: use?.secretName ?? tool.secretEnvName, actingSubject: person.subject });
    each = results.map((r) =>
      r.ok
        ? { ok: true, result: shortResult(r.data), link: answerLink(r.data), brief: answerBrief(r.data) }
        : { ok: false, result: r.error ?? "the service gave no answer" },
    );
    const okN = each.filter((x) => x.ok).length;
    status = okN === each.length ? "done" : okN === 0 ? "failed" : "partial";
    result = batch ? `${okN} of ${each.length} done${okN < each.length ? `; ${each.length - okN} failed` : ""}` : each[0]!.result;
  } catch (e) {
    status = "failed";
    result = (e as Error).message;
  }
  await auditService
    .record({
      workspaceId,
      actor: person.label,
      operation: "update",
      entity: "tool",
      description: `${status === "done" ? "Confirmed and done" : status === "partial" ? `Confirmed, partly done (${result})` : "Confirmed, but it failed"} from Forge Agent: ${p.summary} (${p.tool}, through ${via === "personal" ? "their own" : "the workspace's"} connection${use?.label ? ` “${use.label}”` : ""})`,
      whereText: where.chatId ? "Chats" : "Forge",
      whereEntityType: where.chatId ? "chat" : null,
      whereEntityId: where.chatId,
      raw: { proposalId: p.id, tool: p.tool, params: p.params, via, status, results: each?.map((x) => x.ok), chatId: where.chatId },
    })
    .catch((e) => console.warn(`[agent-changes] could not record a confirmed change: ${(e as Error).message}`));
  const one = !batch && each?.[0]?.ok ? each[0] : null;
  return { status, result, via, ...(batch && each ? { results: each } : {}), ...(one ? { link: one.link ?? null, brief: one.brief ?? [] } : {}) };
}

/** The line Forge reads at the start of the next turn about what became of its proposals. */
export function outcomeLine(p: PiProposal): string {
  if (p.kind === "http" && p.http) {
    const { method, url } = p.http;
    if (p.status === "declined") return `The person CANCELLED the ${method} request to ${url}; nothing was sent. Do not send it again unless they ask.`;
    if (p.status === "done") return `The person confirmed the ${method} request to ${url} and it was SENT. ${p.result ?? ""}`;
    return `The ${method} request to ${url} was NOT sent: ${p.result ?? ""}`;
  }
  if (p.kind === "email" && p.email) {
    const who = p.email.to.join(", ") + (p.email.cc.length ? ` (cc ${p.email.cc.join(", ")})` : "");
    const subject = p.email.subject;
    if (p.status === "declined") return `The person CANCELLED the email “${subject}” to ${who}; nothing was sent. Do not send it again unless they ask.`;
    if (p.status === "done") return `The person confirmed the email “${subject}” to ${who} and it was SENT.`;
    return `The email “${subject}” to ${who} was NOT sent: ${p.result ?? ""}`;
  }
  if (p.kind === "account" && p.choice) {
    const o = p.choice.options.find((x) => x.connectionId === p.choice!.chosen);
    if (p.status === "declined" || !o) return `The person did not choose a ${p.choice.service} connection; do not use ${p.choice.service} until they do.`;
    return `The person chose “${o.label}” (${o.personal ? "their own" : "the workspace's"}${o.identity ? `, ${o.identity}` : ""}) for ${p.choice.service} in this chat. Continue with what you were doing; ${p.choice.service} calls now go through it.`;
  }
  if (p.kind === "setting" && p.setting) {
    const what = `switching ${p.setting.on ? "on" : "off"} ${p.setting.service} · ${p.setting.title} (${p.tool})`;
    if (p.status === "declined") return `The person DECLINED ${what}; it is as it was.`;
    if (p.status === "done") return `The person confirmed ${what}: ${p.result ?? ""}${p.setting.on ? " Use it now; read its inputs with tools/connector-actions.mjs first." : ""}`;
    return `The person tried ${what} but it FAILED: ${p.result ?? ""}`;
  }
  if (p.kind === "edge" && p.edge) {
    const what = `edge job on ${p.edge.deviceName}: ${p.summary}`;
    if (p.status === "declined") return `The person DECLINED ${what}; it will not run.`;
    if (p.status === "done") return `The person APPROVED ${what}. Keep polling edge-job for the result.`;
    return `The person tried to approve ${what} but it FAILED: ${p.result ?? ""}`;
  }
  if (p.kind === "surface" && p.surface) {
    const title = p.surface.title;
    if (p.status === "declined") return `The person CANCELLED the card “${title}”; do not assume a choice.`;
    if (p.surface.mode === "ask" && p.surface.selected?.length) {
      const names = p.surface.selected.map((id) => p.surface!.items.find((i) => i.id === id)?.title ?? id);
      return `The person chose on “${title}”: ${names.join(", ")}. Continue with that.`;
    }
    if (p.surface.acted) {
      const a = p.surface.actions?.find((x) => x.id === p.surface!.acted);
      const payload = p.surface.actedPayload;
      const payloadBit =
        payload && Object.keys(payload).length ? ` with context ${JSON.stringify(payload)}` : "";
      return `The person pressed “${a?.label ?? p.surface.acted}” (action id “${p.surface.acted}”) on the card “${title}”${payloadBit}${p.result ? ` — ${p.result}` : ""}. Use that context; do not invent a different choice.`;
    }
    if (p.status === "done") return `The person confirmed the card “${title}”: ${p.result ?? ""}`;
    return `The person tried the card “${title}” but it FAILED: ${p.result ?? ""}`;
  }
  if (p.status === "declined") return `The person DECLINED your proposed change "${p.summary}" (${p.tool}); nothing was done.`;
  if (p.status === "done") return `The person confirmed "${p.summary}" (${p.tool}) and it was DONE through ${p.account ? `“${p.account.label}”${p.account.personal ? " (their own)" : " (the workspace's)"}` : p.via === "personal" ? "their own connection" : "the workspace's connection"}. The service answered: ${p.result ?? ""}`;
  if (p.status === "partial") {
    const failed = (p.results ?? []).map((r, i) => (r.ok ? null : `entry ${i + 1}: ${r.result}`)).filter(Boolean);
    return `The person confirmed "${p.summary}" (${p.tool}): PARTLY done, ${p.result ?? ""}. Failed: ${failed.join("; ")}`;
  }
  return `The person confirmed "${p.summary}" (${p.tool}) but it FAILED: ${p.result ?? ""}`;
}
