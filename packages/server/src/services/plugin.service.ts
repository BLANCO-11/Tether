/**
 * Connectors (Activepieces pieces) — the marketplace, the deployment's installs, and each workspace's connections and
 * enabled actions. plans/plugins-2026-10-27, phases 1 and 3.
 *
 * Three tiers, three permissions:
 *   - the MARKETPLACE is Activepieces' public catalogue, read and cached here (`plugins.read`);
 *   - INSTALLING adds a piece's code to the deployment once (`platform.plugins.install`) and does nothing in any
 *     workspace on its own;
 *   - CONNECTING stores a workspace's credential for a piece and chooses which of its actions automations may use
 *     (`plugins.enable`). An enabled action is an ordinary `tools` row (`plugin-connector.service.ts`).
 *
 * ⚠ **A connection's value is written and never read back.** It is encrypted into `workspace_secrets` under a name;
 * `plugin_connections` holds that name and the NAMES of the fields given. No function here returns a value, and the
 * test path decrypts it only to hand it to the connector for the one call.
 */
import { suspendRunningAs } from "./run-as.service.js";
import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { tools, workspaces } from "../db/schema.js";
import { config } from "../config/index.js";
import { withResponseBody } from "../middleware/error.middleware.js";
import { pluginRepo, type PluginConnection, type PluginInstall } from "../repositories/plugin.repo.js";
import { platformAuditRepo } from "../repositories/platform-audit.repo.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { auditService } from "./audit.service.js";
import {
  connectorPieces,
  connectorRequest,
  parsePluginUrl,
  pluginToolName,
  pluginUrl,
  type PieceActionDescription,
  type PieceAuth,
  type PieceDescription,
} from "./plugin-connector.service.js";
import { StepError } from "./step-error.js";
import { ownConnections, personallyOfferable } from "./personal-actions.js";
import { DECLARED_PREFIX, declarationHash, declarationOf, declarationProblem, declaredCallSchema, declaredDescription, declaredParams, type Declaration } from "./declared-call.js";
import { packsFor } from "./declared-call-packs.js";
import {
  authorizeUrl,
  checkScopes,
  clientFor,
  effectiveScopes,
  fillTemplate,
  freshConnection,
  hashState,
  isMicrosoft,
  isOauthValue,
  newAppUrl,
  openState,
  redirectUri,
  signInAppAvailable,
  tokenRequest,
  toValue,
  type OauthDecl,
} from "./plugin-oauth.service.js";
import type { PluginOauthApp } from "../repositories/plugin.repo.js";

export type Actor = { subject: string; email?: string | null };
const who = (a: Actor) => a.email || a.subject;

/** An error whose message is OUR sentence, shown to the caller whatever the status (5xx included). */
function fail(message: string, statusCode: number, extra: Record<string, unknown> = {}): never {
  const err = Object.assign(new Error(message), { statusCode });
  throw withResponseBody(err, { error: statusCode >= 500 ? "connector_unavailable" : "plugin_refused", message, ...extra });
}
/** The connector's own refusals arrive as StepError(status); carry them with their words. */
async function viaConnector<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof StepError) fail(e.message, e.status);
    throw e;
  }
}

const PREFIX = "@activepieces/piece-";
export const shortName = (piece: string) => piece.replace(PREFIX, "");
export const pieceName = (short: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) fail(`not a connector name: ${short}`, 400);
  return `${PREFIX}${short}`;
};

// ── The marketplace (Activepieces' public catalogue) ─────────────────────────────────────────────────────────────────

export type CatalogueEntry = {
  name: string;
  short: string;
  displayName: string;
  description: string;
  logoUrl: string | null;
  version: string;
  categories: string[];
  authTypes: string[];
  actions: number;
  triggers: number;
};

/**
 * Activepieces' own flow plumbing — delays, branches, HTTP, storage. Foundry has its own for every one of them, and a
 * second way to branch or wait inside a connector is a step the compiler and the approval gate cannot see.
 */
const NOT_OFFERED_CATEGORIES = new Set(["CORE", "FLOW_CONTROL"]);
const CATALOGUE_TTL_MS = 6 * 60 * 60_000;
let catalogueCache: { at: number; entries: CatalogueEntry[] } | null = null;

function shapeCatalogue(raw: unknown): CatalogueEntry[] {
  if (!Array.isArray(raw)) throw new Error("the catalogue is not a list");
  const out: CatalogueEntry[] = [];
  for (const x of raw as Array<Record<string, unknown>>) {
    const name = String(x.name ?? "");
    if (!/^@activepieces\/piece-[a-z0-9][a-z0-9-]*$/.test(name) || !/^\d+\.\d+\.\d+$/.test(String(x.version ?? ""))) continue;
    const categories = Array.isArray(x.categories) ? x.categories.map(String) : [];
    if (categories.some((c) => NOT_OFFERED_CATEGORIES.has(c))) continue;
    const auth = x.auth == null ? [] : Array.isArray(x.auth) ? x.auth : [x.auth];
    const logo = typeof x.logoUrl === "string" && /^https:\/\/cdn\.activepieces\.com\//.test(x.logoUrl) ? x.logoUrl : null;
    out.push({
      name,
      short: shortName(name),
      displayName: String(x.displayName ?? shortName(name)).slice(0, 120),
      description: String(x.description ?? "").slice(0, 600),
      logoUrl: logo,
      version: String(x.version),
      categories,
      authTypes: [...new Set(auth.map((a) => String((a as { type?: unknown })?.type ?? "")).filter(Boolean))],
      actions: Number(x.actions ?? 0) || 0,
      triggers: Number(x.triggers ?? 0) || 0,
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The catalogue, cached for six hours. A failed refresh keeps the last good copy and says it is stale. */
async function catalogue(): Promise<{ entries: CatalogueEntry[]; fetchedAt: string; stale: boolean }> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
    return { entries: catalogueCache.entries, fetchedAt: new Date(catalogueCache.at).toISOString(), stale: false };
  }
  try {
    const res = await fetch(config.plugins.catalogueUrl, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    catalogueCache = { at: Date.now(), entries: shapeCatalogue(await res.json()) };
    return { entries: catalogueCache.entries, fetchedAt: new Date(catalogueCache.at).toISOString(), stale: false };
  } catch (e) {
    console.error(JSON.stringify({ event: "plugin_catalogue_unreadable", why: (e as Error).message }));
    if (catalogueCache) return { entries: catalogueCache.entries, fetchedAt: new Date(catalogueCache.at).toISOString(), stale: true };
    return fail(`the connector marketplace could not be read (${(e as Error).message})`, 502);
  }
}

// ── Installs (deployment-wide) ───────────────────────────────────────────────────────────────────────────────────────

export type InstallView = {
  name: string;
  short: string;
  displayName: string;
  description: string;
  logoUrl: string | null;
  version: string;
  license: string | null;
  hosts: string[];
  suggestedHosts: string[];
  /** `installed` — on the connector and recorded; `unrecorded` — on the connector, installed before records were kept; `missing` — recorded, but the connector does not have it. */
  status: "installed" | "unrecorded" | "missing";
  installedBy: string | null;
  installedAt: string | null;
  auth: PieceAuth[];
  actions: PieceActionDescription[];
};

function installView(row: PluginInstall | undefined, live: PieceDescription | undefined): InstallView {
  const name = live?.name ?? row!.piece;
  return {
    name,
    short: shortName(name),
    displayName: live?.displayName ?? row!.displayName,
    description: live?.description ?? "",
    logoUrl: live?.logoUrl && /^https:\/\/cdn\.activepieces\.com\//.test(live.logoUrl) ? live.logoUrl : (row?.logoUrl ?? null),
    version: live?.version ?? row!.version,
    license: live?.license ?? row?.license ?? null,
    hosts: live?.hosts ?? row?.hosts ?? [],
    suggestedHosts: live?.suggestedHosts ?? [],
    status: live && row ? "installed" : live ? "unrecorded" : "missing",
    installedBy: row?.installedBy ?? null,
    installedAt: row?.installedAt?.toISOString() ?? null,
    auth: live?.auth ?? [],
    actions: live?.actions ?? [],
  };
}

async function installs(): Promise<InstallView[]> {
  const [rows, live] = await Promise.all([pluginRepo.listInstalls(), viaConnector(connectorPieces)]);
  const byName = new Map(rows.map((r) => [r.piece, r]));
  const out = live.map((p) => installView(byName.get(p.name), p));
  for (const r of rows) if (!live.some((p) => p.name === r.piece)) out.push(installView(r, undefined));
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function liveDescription(piece: string): Promise<PieceDescription> {
  const p = (await viaConnector(connectorPieces)).find((x) => x.name === piece);
  if (!p) fail(`${shortName(piece)} is not installed on this deployment`, 404);
  return p;
}

const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;
function cleanHosts(hosts: unknown): string[] {
  if (hosts === undefined) return [];
  if (!Array.isArray(hosts)) fail("hosts must be a list of host names", 400);
  const out = [...new Set(hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
  const bad = out.filter((h) => !HOST.test(h));
  if (bad.length) fail(`not host names: ${bad.join(", ")} (a host, host:port, or *.domain)`, 400);
  return out;
}

/** Tools in every workspace that run one piece — what an upgrade re-points and an uninstall must name. */
async function toolsOfPiece(piece: string): Promise<Tool[]> {
  return db.select().from(tools).where(like(tools.url, `plugin://${piece}@%`));
}

async function workspaceNames(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces);
  return [...new Set(ids)].map((id) => rows.find((r) => r.id === id)?.name ?? id);
}

export const pluginService = {
  shortName,
  pieceName,

  /** The marketplace, with what this deployment has installed marked on each entry. */
  async marketplace() {
    const [cat, rows, live] = await Promise.all([
      catalogue(),
      pluginRepo.listInstalls(),
      viaConnector(connectorPieces).catch(() => null),
    ]);
    const installed = new Map<string, string>();
    for (const r of rows) installed.set(r.piece, r.version);
    for (const p of live ?? []) installed.set(p.name, p.version);
    return {
      fetchedAt: cat.fetchedAt,
      stale: cat.stale,
      connectorReachable: live !== null,
      entries: cat.entries.map((e) => ({ ...e, installedVersion: installed.get(e.name) ?? null })),
    };
  },

  installs,

  async install(input: { piece: string; version?: string; hosts?: unknown }, actor: Actor): Promise<InstallView> {
    const hosts = cleanHosts(input.hosts);
    let version = input.version;
    if (!version) {
      const entry = (await catalogue()).entries.find((e) => e.name === input.piece);
      if (!entry) fail(`${shortName(input.piece)} is not in the marketplace`, 404);
      version = entry.version;
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`a connector is installed at an exact version (x.y.z), got "${version}"`, 400);
    const prior = await pluginRepo.getInstall(input.piece);
    if (prior && prior.version !== version) fail(`${shortName(input.piece)} is already installed at ${prior.version}; upgrade it instead`, 409);
    const live = await viaConnector(() =>
      connectorRequest<PieceDescription>("/pieces/install", { name: input.piece, version, hosts: hosts.length ? hosts : (prior?.hosts ?? []) }),
    );
    const row = await pluginRepo.upsertInstall({
      piece: live.name,
      version: live.version,
      integrity: live.integrity ?? "",
      license: live.license ?? null,
      displayName: live.displayName,
      logoUrl: live.logoUrl ?? null,
      hosts: live.hosts ?? [],
      installedBy: who(actor),
    });
    await platformAuditRepo.record({
      actor: actor.subject,
      actorEmail: actor.email ?? null,
      action: "plugin.install",
      entity: "plugin",
      entityId: live.name,
      subject: live.displayName,
      after: { version: live.version, integrity: live.integrity, hosts: live.hosts },
    });
    return installView(row, live);
  },

  async setHosts(piece: string, hostsIn: unknown, actor: Actor): Promise<InstallView> {
    const hosts = cleanHosts(hostsIn);
    const before = await liveDescription(piece);
    const live = await viaConnector(() => connectorRequest<PieceDescription>("/pieces/hosts", { name: piece, hosts }));
    const row = await pluginRepo.setHosts(piece, live.hosts ?? hosts);
    await platformAuditRepo.record({
      actor: actor.subject,
      actorEmail: actor.email ?? null,
      action: "plugin.hosts",
      entity: "plugin",
      entityId: piece,
      subject: live.displayName,
      before: { hosts: before.hosts ?? [] },
      after: { hosts: live.hosts ?? hosts },
    });
    return installView(row, live);
  },

  /**
   * Move every workspace to another exact version. ⚠ This re-points each tool's address, and the address is in the
   * ref fingerprint — so an armed automation using it is suspended by the staleness sweep and must be approved again
   * against the new code. That is the point: an upgrade is new code.
   */
  async upgrade(piece: string, version: string, actor: Actor): Promise<{ install: InstallView; toolsRepointed: number }> {
    if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail(`a connector is upgraded to an exact version (x.y.z), got "${version}"`, 400);
    const prior = await liveDescription(piece);
    if (prior.version === version) fail(`${shortName(piece)} is already at ${version}`, 409);
    const live = await viaConnector(() => connectorRequest<PieceDescription>("/pieces/install", { name: piece, version, hosts: prior.hosts ?? [] }));
    // An action the new version dropped stays pointed at the old address and fails by name, rather than vanishing.
    const kept = new Set(live.actions.map((a) => a.name));
    // A declared call runs through the piece's raw call, so it moves with the piece while the new version still has one.
    const keepsDeclared = kept.has("custom_api_call");
    let toolsRepointed = 0;
    for (const t of await toolsOfPiece(piece)) {
      const ref = parsePluginUrl(t.url);
      if (!ref || !(kept.has(ref.action) || (keepsDeclared && ref.action.startsWith(DECLARED_PREFIX)))) continue;
      await toolRepo.update(t.workspaceId, t.id, { url: pluginUrl({ ...ref, version: live.version }) });
      toolsRepointed++;
    }
    const row = await pluginRepo.upsertInstall({
      piece,
      version: live.version,
      integrity: live.integrity ?? "",
      license: live.license ?? null,
      displayName: live.displayName,
      logoUrl: live.logoUrl ?? null,
      hosts: live.hosts ?? [],
      installedBy: who(actor),
    });
    await platformAuditRepo.record({
      actor: actor.subject,
      actorEmail: actor.email ?? null,
      action: "plugin.upgrade",
      entity: "plugin",
      entityId: piece,
      subject: live.displayName,
      before: { version: prior.version },
      after: { version: live.version, integrity: live.integrity, toolsRepointed },
    });
    return { install: installView(row, live), toolsRepointed };
  },

  /** Refused while any workspace still connects to it or has its actions — naming those workspaces. */
  async uninstall(piece: string, actor: Actor): Promise<void> {
    const [conns, used] = await Promise.all([pluginRepo.listConnectionsForPiece(piece), toolsOfPiece(piece)]);
    const inUse = [...conns.map((c) => c.workspaceId), ...used.filter((t) => t.isActive !== false).map((t) => t.workspaceId)];
    if (inUse.length) {
      const names = await workspaceNames(inUse);
      fail(`${shortName(piece)} is still connected in ${names.length === 1 ? "workspace" : "workspaces"} ${names.join(", ")}. Remove those connections first.`, 409, {
        workspaces: names,
      });
    }
    await viaConnector(() => connectorRequest("/pieces/uninstall", { name: piece })).catch((e) => {
      // Already gone from the connector (a lost volume) is fine: the record still has to go.
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    });
    await pluginRepo.removeInstall(piece);
    await platformAuditRepo.record({ actor: actor.subject, actorEmail: actor.email ?? null, action: "plugin.uninstall", entity: "plugin", entityId: piece });
  },

  // ── A workspace's connected services ──────────────────────────────────────────────────────────────────────────────

  /** Every installed connector, with this workspace's connections (names only) and which actions are switched on. */
  async workspaceView(workspaceId: string, viewer?: string | null) {
    const [live, conns, wsTools, apps] = await Promise.all([
      viaConnector(connectorPieces),
      pluginRepo.listConnections(workspaceId, undefined, viewer),
      toolRepo.listByWorkspace(workspaceId),
      pluginRepo.listOauthApps(),
    ]);
    return live
      .map((p) => {
        const enabled = wsTools
          .map((t) => ({ t, ref: parsePluginUrl(t.url) }))
          .filter((x) => x.ref?.piece === p.name && x.t.isActive !== false)
          .map((x) => ({ action: x.ref!.action, tool: x.t.name, connection: conns.find((c) => c.secretName === x.t.secretEnvName)?.id ?? null, version: x.ref!.version }));
        return {
          name: p.name,
          short: shortName(p.name),
          displayName: p.displayName,
          description: p.description ?? "",
          logoUrl: p.logoUrl && /^https:\/\/cdn\.activepieces\.com\//.test(p.logoUrl) ? p.logoUrl : null,
          version: p.version,
          auth: p.auth,
          /** Whether signing in is set up, and what it will ask for — shown on the Connect screen before consent. */
          oauth: oauthStatus(p, apps.find((a) => a.piece === p.name)),
          actions: p.actions,
          connections: conns.filter((c) => c.piece === p.name).map(connectionView),
          enabled,
        };
      })
      .sort((a, b) => Number(b.connections.length > 0) - Number(a.connections.length > 0) || a.displayName.localeCompare(b.displayName));
  },

  async createConnection(
    workspaceId: string,
    piece: string,
    input: { label: string; authType?: string; fields: Record<string, unknown>; asMe?: boolean },
    actor: Actor,
  ) {
    const p = await liveDescription(piece);
    const decl = authDeclFor(p, input.authType);
    const label = cleanLabel(input.label);
    const owner = input.asMe ? actor.subject : null;
    await assertFreeLabel(workspaceId, p, label, owner);
    const fields = checkFields(decl, input.fields, {});
    const secretName = await freeSecretName(workspaceId, secretStem(piece, label, owner));
    await workspaceSecretRepo.upsertByName({
      workspaceId,
      name: secretName,
      description: `${p.displayName} connection "${label}" (managed on Connected services)`,
      kind: "tool",
      valueEnc: encrypt(JSON.stringify(fields)),
    } as never);
    const row = await pluginRepo.createConnection({
      workspaceId,
      piece,
      label,
      authType: decl.type,
      secretName,
      fieldNames: Object.keys(fields).sort(),
      createdBy: who(actor),
      ownerSubject: owner,
    });
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "create",
      entity: "connection",
      entityId: row.id,
      description: `Connected ${p.displayName} as "${label}"${owner ? " (personal)" : ""}`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece, label, authType: decl.type, fields: row.fieldNames },
    });
    return connectionView(row);
  },

  /** Rotate or rename. A field left blank keeps its stored value, so a form never has to show one to keep it. */
  async updateConnection(workspaceId: string, id: string, input: { label?: string; fields?: Record<string, unknown> }, actor: Actor) {
    const row = await this.getConnectionRow(workspaceId, id, actor.subject);
    const p = await liveDescription(row.piece);
    if (row.authType === "OAUTH2" && input.fields !== undefined) fail("a sign-in connection is renewed by signing in again, not by entering values", 400);
    const decl = row.authType === "OAUTH2" ? oauthAuth(p) : authDeclFor(p, row.authType);
    const set: Parameters<typeof pluginRepo.updateConnection>[2] = {};
    if (input.label !== undefined) {
      const label = cleanLabel(input.label);
      if (label !== row.label) await assertFreeLabel(workspaceId, p, label, row.ownerSubject);
      set.label = label;
    }
    if (input.fields !== undefined) {
      const stored = await storedFields(workspaceId, row.secretName);
      const fields = checkFields(decl, input.fields, stored);
      const secret = await workspaceSecretRepo.getByName(workspaceId, row.secretName);
      if (!secret) fail(`the stored value of "${row.label}" is missing; remove the connection and connect again`, 409);
      await workspaceSecretRepo.update(workspaceId, secret.id, { valueEnc: encrypt(JSON.stringify(fields)) } as never);
      set.fieldNames = Object.keys(fields).sort();
      // A rotated credential has not been tested.
      Object.assign(set, { lastTestedAt: null, lastTestOk: null, lastTestMessage: null });
    }
    const out = await pluginRepo.updateConnection(workspaceId, id, set);
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "connection",
      entityId: id,
      description: `${input.fields !== undefined ? "Changed the credential of" : "Renamed"} ${p.displayName} connection "${out!.label}"`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece: row.piece, label: out!.label, fieldsChanged: input.fields ? Object.keys(input.fields).filter((k) => input.fields![k] !== "" && input.fields![k] != null) : [] },
    });
    return connectionView(out!);
  },

  /**
   * A person who leaves the workspace loses their own ("only for me") connections in it (plugins 8.7): the credential,
   * the connection and its piece memory. Nothing else could use them (8.1), so they would sit there — a live token to
   * that person's account, in a workspace they are no longer part of. Returns how many were removed; each is audited.
   */
  async removePersonalConnections(workspaceId: string, subject: string, by: string): Promise<number> {
    const mine = (await pluginRepo.listConnections(workspaceId, undefined, subject)).filter((c) => c.ownerSubject === subject);
    for (const row of mine) {
      const secret = await workspaceSecretRepo.getByName(workspaceId, row.secretName);
      if (secret) await workspaceSecretRepo.remove(workspaceId, secret.id);
      await pluginRepo.removeConnection(workspaceId, row.id);
      await connectorRequest("/store/forget", { workspaceId, piece: row.piece, connectionId: row.id }).catch((e) =>
        console.warn(`[plugins] the store of removed connection ${row.id} could not be cleared: ${(e as Error).message}`),
      );
      await auditService.record({
        workspaceId,
        actor: by,
        operation: "delete",
        entity: "connection",
        entityId: row.id,
        description: `Removed a personal ${shortName(row.piece)} connection "${row.label}": its owner left the workspace`,
        whereText: `Connected services · ${shortName(row.piece)}`,
        raw: { piece: row.piece, label: row.label, owner: subject, reason: "member_removed" },
      });
    }
    // What they switched on for themselves goes with them (plans/personal-actions-2026-10-29).
    await pluginRepo.removePersonalActions(workspaceId, subject);
    // Workflows approved to act as these accounts stop, saying why — never a fall back to another account (8.6).
    if (mine.length) {
      await suspendRunningAs(workspaceId, mine.map((c) => c.id), "It runs as a personal connection of someone who left the workspace. Choose its connection again, then approve it.", by);
    }
    return mine.length;
  },

  /** Refused while an action still uses it — naming those actions. */
  async deleteConnection(workspaceId: string, id: string, actor: Actor) {
    const row = await this.getConnectionRow(workspaceId, id, actor.subject);
    const using = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => t.secretEnvName === row.secretName && t.isActive !== false);
    if (using.length) {
      fail(`"${row.label}" is used by ${using.map((t) => t.name).join(", ")}. Switch those actions off first.`, 409, { tools: using.map((t) => t.name) });
    }
    const secret = await workspaceSecretRepo.getByName(workspaceId, row.secretName);
    if (secret) await workspaceSecretRepo.remove(workspaceId, secret.id);
    await pluginRepo.removeConnection(workspaceId, id);
    // A workflow approved to act as it stops, saying why (8.6). (A workspace connection still used by actions was refused above.)
    await suspendRunningAs(workspaceId, [id], `The ${shortName(row.piece)} connection “${row.label}” it runs as was removed. Choose its connection again, then approve it.`, who(actor));
    // Its piece memory goes with it. Best effort: the connection is gone either way, and a store nobody can name again
    // is never read — but say so if it stays behind.
    await connectorRequest("/store/forget", { workspaceId, piece: row.piece, connectionId: id }).catch((e) =>
      console.warn(`[plugins] the store of removed connection ${id} could not be cleared: ${(e as Error).message}`),
    );
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "delete",
      entity: "connection",
      entityId: id,
      description: `Removed ${shortName(row.piece)} connection "${row.label}"`,
      whereText: `Connected services · ${shortName(row.piece)}`,
      raw: { piece: row.piece, label: row.label },
    });
  },

  /** The piece's own check, through the connector. `checked: false` means the piece offers none — never "valid". */
  async testConnection(workspaceId: string, id: string, actor: Actor) {
    const row = await this.getConnectionRow(workspaceId, id, actor.subject);
    let result: { checked: boolean; valid?: boolean; error?: string | null; identity?: string | null };
    try {
      // A sign-in about to expire is renewed first; a renewal that fails is the test's answer.
      const fields = await freshConnection(workspaceId, row.secretName, row.piece, await storedFields(workspaceId, row.secretName));
      result = await connectorRequest("/validate", { piece: row.piece, authType: row.authType, auth: fields }, 90_000);
    } catch (e) {
      if (!(e instanceof StepError) || e.status >= 500 && e.status !== 502) throw e;
      // The connector refused the check itself (e.g. the proxy refused the host): a failed test with its reason.
      result = { checked: true, valid: false, error: e.message };
    }
    const message = !result.checked
      ? "This connector has no check of its own; it is tried the first time an action runs."
      : result.valid
        ? result.identity
          ? `Connected as ${result.identity}`
          : "Connected"
        : (result.error ?? "Not accepted");
    const out = await pluginRepo.updateConnection(workspaceId, id, {
      lastTestedAt: new Date(),
      lastTestOk: result.checked ? !!result.valid : null,
      lastTestMessage: message.slice(0, 1000),
    });
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "access",
      entity: "connection",
      entityId: id,
      description: `Tested ${shortName(row.piece)} connection "${row.label}": ${result.checked ? (result.valid ? "accepted" : "refused") : "no check offered"}`,
      whereText: `Connected services · ${shortName(row.piece)}`,
      raw: { piece: row.piece, checked: result.checked, valid: result.valid ?? null },
    });
    return { ...result, connection: connectionView(out!) };
  },

  /**
   * Which of a piece's actions this workspace's automations may use, through which connection. Each becomes (or stays)
   * a tool; an action switched off keeps its tool row INACTIVE rather than deleting it, so an automation that used it
   * fails by name instead of losing a reference.
   */
  async setActions(workspaceId: string, piece: string, input: { connectionId: string; actions: string[] }, actor: Actor) {
    const p = await liveDescription(piece);
    const conn = await this.getConnectionRow(workspaceId, input.connectionId, actor.subject);
    if (conn.piece !== piece) fail(`that connection is for ${shortName(conn.piece)}, not ${shortName(piece)}`, 400);
    if (conn.ownerSubject) fail(`"${conn.label}" is a personal connection; automations use the workspace's connections only`, 422);
    const wanted = [...new Set(input.actions ?? [])];
    const unknown = wanted.filter((a) => !p.actions.some((x) => x.name === a));
    if (unknown.length) fail(`${p.displayName} has no action ${unknown.join(", ")}`, 400);
    const unoffered = wanted.map((a) => p.actions.find((x) => x.name === a)!).filter((a) => a.unsupported.length);
    if (unoffered.length) fail(`not offered: ${unoffered.map((a) => `${a.displayName} (${a.unsupported.join("; ")})`).join(", ")}`, 422);
    if (wanted.includes("custom_api_call")) fail("the raw API call action is never offered: it can reach any address of the service with the connection", 422);

    const existing = await toolRepo.listByWorkspace(workspaceId);
    // ⚠ Declared calls (`call_<hash>`) are switched on and off by their own routes; this list never touches them.
    const mine = existing.filter((t) => {
      const ref = parsePluginUrl(t.url);
      return ref?.piece === piece && !ref.action.startsWith(DECLARED_PREFIX);
    });
    const on: string[] = [];
    for (const name of wanted) {
      const a = p.actions.find((x) => x.name === name)!;
      const row = {
        workspaceId,
        name: pluginToolName(p.name, a.name),
        url: pluginUrl({ piece: p.name, version: p.version, action: a.name }),
        method: "POST",
        description: toolDescription(p, a),
        paramsSchema: a.params,
        secretEnvName: conn.secretName,
        authStyle: null,
        isActive: true,
      };
      const clash = existing.find((t) => t.name === row.name && parsePluginUrl(t.url)?.piece !== piece);
      if (clash) fail(`a tool called "${row.name}" already exists here and is not this connector's; rename it first`, 409);
      const prior = mine.find((t) => t.name === row.name);
      if (prior) await toolRepo.update(workspaceId, prior.id, row);
      else await toolRepo.create(row);
      on.push(row.name);
    }
    const off: string[] = [];
    for (const t of mine) {
      if (on.includes(t.name) || t.isActive === false) continue;
      await toolRepo.update(workspaceId, t.id, { isActive: false });
      off.push(t.name);
    }
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "plugin",
      entityId: piece,
      description: `${p.displayName}: ${on.length} action(s) on via "${conn.label}"${off.length ? `, ${off.length} switched off` : ""}`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece, connection: conn.label, on, off },
    });
    return this.workspaceView(workspaceId, actor.subject).then((v) => v.find((x) => x.name === piece)!);
  },

  /**
   * Declared API calls (plans/declared-api-calls-2026-10-29): the piece's raw call, fixed in advance. What this workspace
   * has declared for a piece, whether each is on, and the curated packs offered for it.
   */
  async listDeclaredCalls(workspaceId: string, piece: string) {
    const rows = await pluginRepo.declaredCalls(workspaceId, piece);
    const tools = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => parsePluginUrl(t.url)?.piece === piece);
    // The current one per name is the one its tool points at; older hashes are history.
    const calls = tools
      .map((t) => ({ tool: t, ref: parsePluginUrl(t.url)! }))
      .filter(({ ref }) => ref.action.startsWith(DECLARED_PREFIX))
      .map(({ tool, ref }) => {
        const row = rows.find((r) => r.hash === ref.action.slice(DECLARED_PREFIX.length));
        return row
          ? {
              name: row.name,
              tool: tool.name,
              on: tool.isActive !== false,
              displayName: row.displayName,
              description: row.description,
              pack: row.pack,
              writes: (row.declaration as Declaration).method !== "GET",
              declaration: row.declaration as Declaration,
            }
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const packs = packsFor(piece).map((p) => ({
      key: p.key,
      displayName: p.displayName,
      description: p.description,
      needs: p.needs,
      calls: p.calls.map((c) => ({ name: c.name, displayName: c.displayName, writes: c.method !== "GET" })),
    }));
    return { calls, packs };
  },

  /**
   * Declare one call and switch it on through a WORKSPACE connection. The same name declared again with a different
   * shape gets a new address, so automations already switched on with it are suspended for re-approval.
   */
  async declareCall(workspaceId: string, piece: string, input: { connectionId: string; call: unknown; pack?: string | null }, actor: Actor) {
    const p = await liveDescription(piece);
    if (!p.actions.some((a) => a.name === "custom_api_call")) fail(`${p.displayName} has no raw API call, so nothing can be declared for it`, 422);
    const conn = await this.getConnectionRow(workspaceId, input.connectionId, actor.subject);
    if (conn.piece !== piece) fail(`that connection is for ${shortName(conn.piece)}, not ${shortName(piece)}`, 400);
    if (conn.ownerSubject) fail(`"${conn.label}" is a personal connection; automations use the workspace's connections only`, 422);
    const parsed = declaredCallSchema.safeParse(input.call);
    if (!parsed.success) fail(`the call is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "call"}: ${i.message}`).join("; ")}`, 400);
    const call = parsed.data;
    const declaration = declarationOf(call);
    const problem = declarationProblem(declaration);
    if (problem) fail(`the call is not valid: ${problem}`, 400);
    const hash = declarationHash(declaration);

    const name = pluginToolName(p.name, call.name);
    const existing = await toolRepo.listByWorkspace(workspaceId);
    const clash = existing.find((t) => t.name === name && parsePluginUrl(t.url)?.piece !== piece);
    if (clash) fail(`a tool called "${name}" already exists here and is not this connector's; choose another name`, 409);
    const prior = existing.find((t) => t.name === name);
    const priorRef = prior ? parsePluginUrl(prior.url) : null;
    if (priorRef && !priorRef.action.startsWith(DECLARED_PREFIX)) fail(`"${name}" is one of ${p.displayName}'s own actions; choose another name`, 409);

    await pluginRepo.saveDeclaredCall({
      workspaceId,
      piece,
      name: call.name,
      displayName: call.displayName,
      description: call.description,
      declaration,
      hash,
      pack: input.pack ?? null,
      createdBy: who(actor),
    });
    const writes = call.method !== "GET";
    const row = {
      workspaceId,
      name,
      url: pluginUrl({ piece: p.name, version: p.version, action: `${DECLARED_PREFIX}${hash}` }),
      method: "POST",
      description: declaredDescription(p.displayName, call),
      paramsSchema: declaredParams(call),
      secretEnvName: conn.secretName,
      authStyle: null,
      isActive: true,
    };
    if (prior) await toolRepo.update(workspaceId, prior.id, row);
    else await toolRepo.create(row);
    const changed = !!priorRef && priorRef.action !== `${DECLARED_PREFIX}${hash}`;
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: prior ? "update" : "create",
      entity: "plugin",
      entityId: piece,
      description: `${p.displayName}: declared call "${call.displayName}" (${call.method} ${call.path}) ${changed ? "changed" : prior ? "switched on" : "added"} via "${conn.label}"${input.pack ? ` from the ${input.pack} pack` : ""}`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece, name: call.name, hash, method: call.method, path: call.path, pack: input.pack ?? null, connection: conn.label },
    });
    return { name, hash, writes, changed };
  },

  /** Switch on every call of a curated pack through one workspace connection. */
  async enablePack(workspaceId: string, piece: string, input: { connectionId: string; pack: string }, actor: Actor) {
    const pack = packsFor(piece).find((p) => p.key === input.pack);
    if (!pack) fail(`no pack "${input.pack}" for ${shortName(piece)}`, 404);
    const out = [];
    for (const call of pack.calls) out.push(await this.declareCall(workspaceId, piece, { connectionId: input.connectionId, call, pack: pack.key }, actor));
    return { pack: pack.key, calls: out };
  },

  /** Switch a declared call off. Its tool stays, inactive, so an automation using it fails by name. */
  async removeDeclaredCall(workspaceId: string, piece: string, name: string, actor: Actor) {
    const toolName = pluginToolName(piece, name);
    const t = (await toolRepo.listByWorkspace(workspaceId)).find((x) => x.name === toolName && parsePluginUrl(x.url)?.action.startsWith(DECLARED_PREFIX));
    if (!t) fail(`no declared call "${name}" here`, 404);
    if (t.isActive !== false) await toolRepo.update(workspaceId, t.id, { isActive: false });
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "plugin",
      entityId: piece,
      description: `${shortName(piece)}: declared call "${name}" switched off`,
      whereText: `Connected services · ${shortName(piece)}`,
      raw: { piece, name },
    });
    return { name: toolName, on: false };
  },

  // ── For me: actions a person switches on for themselves (plans/personal-actions-2026-10-29) ────────────────────────

  /** What "For me" shows for one connector: may they, are they connected, what they have on, and the packs offered. */
  async personalView(workspaceId: string, piece: string, subject: string) {
    const p = await liveDescription(piece);
    const [allowed, own, rows, declared] = await Promise.all([
      pluginRepo.personalAllowed(workspaceId, piece),
      ownConnections(workspaceId, piece, subject),
      pluginRepo.personalActions(workspaceId, subject, piece),
      pluginRepo.declaredCalls(workspaceId, piece),
    ]);
    const calls = rows
      .filter((r) => r.action.startsWith(DECLARED_PREFIX))
      .map((r) => declared.find((d) => `${DECLARED_PREFIX}${d.hash}` === r.action))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({
        name: d.name,
        displayName: d.displayName,
        description: d.description,
        pack: d.pack,
        writes: (d.declaration as Declaration).method !== "GET",
        declaration: d.declaration as Declaration,
      }));
    const packs = p.actions.some((a) => a.name === "custom_api_call")
      ? packsFor(piece).map((x) => ({ key: x.key, displayName: x.displayName, description: x.description, needs: x.needs, calls: x.calls.map((c) => ({ name: c.name, displayName: c.displayName, writes: c.method !== "GET" })) }))
      : [];
    return { allowed, connected: own.length > 0, actions: rows.filter((r) => !r.action.startsWith(DECLARED_PREFIX)).map((r) => r.action), calls, packs };
  },

  /** Why this person may not switch this connector's actions on for themselves, or nothing. */
  async mayUseOwn(workspaceId: string, piece: string, subject: string) {
    if (!(await pluginRepo.personalAllowed(workspaceId, piece))) {
      fail(`An admin has turned off members switching ${shortName(piece)} actions on for themselves in this workspace.`, 403);
    }
    if (!(await ownConnections(workspaceId, piece, subject)).length) {
      fail(`Connect your own ${shortName(piece)} account first (Connect as yourself); actions you switch on for yourself run through it.`, 409);
    }
  },

  /** Set which of a connector's own actions are on for this person. Declared calls are switched by their own routes. */
  async setMyActions(workspaceId: string, piece: string, input: { actions: string[] }, actor: Actor) {
    const p = await liveDescription(piece);
    await this.mayUseOwn(workspaceId, piece, actor.subject);
    const wanted = [...new Set(input.actions ?? [])];
    const unknown = wanted.filter((a) => !p.actions.some((x) => x.name === a));
    if (unknown.length) fail(`${p.displayName} has no action ${unknown.join(", ")}`, 400);
    if (wanted.includes("custom_api_call")) fail("the raw API call action is never offered: it can reach any address of the service with the connection", 422);
    const unoffered = wanted.map((a) => p.actions.find((x) => x.name === a)!).filter((a) => !personallyOfferable(a));
    if (unoffered.length) fail(`not offered: ${unoffered.map((a) => `${a.displayName} (${a.unsupported.join("; ")})`).join(", ")}`, 422);
    const had = (await pluginRepo.personalActions(workspaceId, actor.subject, piece)).filter((r) => !r.action.startsWith(DECLARED_PREFIX)).map((r) => r.action);
    const on = wanted.filter((a) => !had.includes(a));
    const off = had.filter((a) => !wanted.includes(a));
    await pluginRepo.addPersonalActions(workspaceId, actor.subject, piece, on);
    await pluginRepo.removePersonalActions(workspaceId, actor.subject, piece, off);
    if (on.length || off.length) {
      await auditService.record({
        workspaceId,
        actor: who(actor),
        operation: "update",
        entity: "plugin",
        entityId: piece,
        description: `${p.displayName}: for themselves, ${on.length} action(s) on${off.length ? `, ${off.length} off` : ""}`,
        whereText: `Connected services · ${p.displayName}`,
        raw: { piece, personal: true, on, off },
      });
    }
    return this.personalView(workspaceId, piece, actor.subject);
  },

  /** Switch every call of a curated pack on for this person. The calls are the pack's own: the same checks, the same hashes. */
  async enableMyPack(workspaceId: string, piece: string, packKey: string, actor: Actor) {
    const p = await liveDescription(piece);
    if (!p.actions.some((a) => a.name === "custom_api_call")) fail(`${p.displayName} has no raw API call, so nothing can be declared for it`, 422);
    const pack = packsFor(piece).find((x) => x.key === packKey);
    if (!pack) fail(`no pack "${packKey}" for ${shortName(piece)}`, 404);
    await this.mayUseOwn(workspaceId, piece, actor.subject);
    const before = await pluginRepo.declaredCalls(workspaceId, piece);
    const on: string[] = [];
    for (const raw of pack!.calls) {
      const call = declaredCallSchema.parse(raw);
      const declaration = declarationOf(call);
      const problem = declarationProblem(declaration);
      if (problem) fail(`the pack's call "${call.name}" is not valid: ${problem}`, 500);
      const hash = declarationHash(declaration);
      await pluginRepo.saveDeclaredCall({ workspaceId, piece, name: call.name, displayName: call.displayName, description: call.description, declaration, hash, pack: pack!.key, createdBy: who(actor) });
      // An older shape of the same call is replaced, never kept beside it.
      const older = before.filter((d) => d.name === call.name && d.hash !== hash).map((d) => `${DECLARED_PREFIX}${d.hash}`);
      await pluginRepo.removePersonalActions(workspaceId, actor.subject, piece, older);
      on.push(`${DECLARED_PREFIX}${hash}`);
    }
    await pluginRepo.addPersonalActions(workspaceId, actor.subject, piece, on);
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "plugin",
      entityId: piece,
      description: `${p.displayName}: the ${pack!.displayName} pack (${on.length} calls) switched on for themselves`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece, personal: true, pack: pack!.key },
    });
    return this.personalView(workspaceId, piece, actor.subject);
  },

  /** Switch one declared call off for this person (every shape it has had). */
  async removeMyCall(workspaceId: string, piece: string, name: string, actor: Actor) {
    const hashes = (await pluginRepo.declaredCalls(workspaceId, piece)).filter((d) => d.name === name).map((d) => `${DECLARED_PREFIX}${d.hash}`);
    const gone = await pluginRepo.removePersonalActions(workspaceId, actor.subject, piece, hashes);
    if (!gone) fail(`"${name}" is not on for you`, 404);
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "plugin",
      entityId: piece,
      description: `${shortName(piece)}: declared call "${name}" switched off for themselves`,
      whereText: `Connected services · ${shortName(piece)}`,
      raw: { piece, personal: true, name },
    });
    return this.personalView(workspaceId, piece, actor.subject);
  },

  /** An admin: may members switch this connector's actions on for themselves here? Off stops them at the next call. */
  async setPersonalAllowed(workspaceId: string, piece: string, allowed: boolean, actor: Actor) {
    const p = await liveDescription(piece);
    await pluginRepo.setPersonalAllowed(workspaceId, piece, allowed, who(actor));
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "plugin",
      entityId: piece,
      description: `${p.displayName}: members ${allowed ? "may" : "may no longer"} switch its actions on for themselves`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece, personalAllowed: allowed },
    });
    return { allowed };
  },

  /** ⚠ Another person's personal connection answers 404, exactly as one that does not exist. */
  async getConnectionRow(workspaceId: string, id: string, viewer?: string | null): Promise<PluginConnection> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail("not a connection id", 400);
    const row = await pluginRepo.getConnection(workspaceId, id);
    if (!row || (row.ownerSubject && row.ownerSubject !== viewer)) fail("no such connection in this workspace", 404);
    return row;
  },

  // ── Signing in (OAuth, phase 4) ───────────────────────────────────────────────────────────────────────────────────

  /** The OAuth app a connector signs in with, as an administrator sees it. ⚠ Never the secret — whether one is set. */
  async oauthApp(piece: string) {
    const p = await liveDescription(piece);
    return oauthAppView(p, await pluginRepo.getOauthApp(piece));
  },

  async setOauthApp(piece: string, input: { useSignInApp?: boolean; clientId?: string; clientSecret?: string; scopes?: string[] }, actor: Actor) {
    const p = await liveDescription(piece);
    const decl = oauthAuth(p).oauth!;
    const prior = await pluginRepo.getOauthApp(piece);
    const useSignInApp = input.useSignInApp === true;
    if (useSignInApp && !isMicrosoft(decl)) fail("Foundry's sign-in app signs in to Microsoft only", 400);
    if (useSignInApp && !signInAppAvailable()) fail("Foundry's sign-in app is not configured on this deployment (AUTH_MICROSOFT_ENTRA_ID_ID / _SECRET)", 409);
    const clientId = useSignInApp ? null : String(input.clientId ?? prior?.clientId ?? "").trim();
    if (!useSignInApp && !clientId) fail("an OAuth app needs its client id", 400);
    if (clientId && clientId.length > 300) fail("that client id is too long", 400);
    // A blank secret keeps the stored one, as a connection's fields do: the form never has to show it to keep it.
    const secretGiven = typeof input.clientSecret === "string" && input.clientSecret.trim() !== "";
    if (secretGiven && input.clientSecret!.length > 2000) fail("that client secret is too long", 400);
    const clientSecretEnc = useSignInApp ? null : secretGiven ? encrypt(input.clientSecret!.trim()) : (prior?.clientSecretEnc ?? null);
    if (!useSignInApp && !clientSecretEnc && !decl.pkce) fail("an OAuth app needs its client secret", 400);
    let scopes: string[];
    try {
      scopes = checkScopes(decl, input.scopes);
    } catch (e) {
      return fail((e as Error).message, 400);
    }
    const row = await pluginRepo.upsertOauthApp({ piece, useSignInApp, clientId, clientSecretEnc, scopes, updatedBy: who(actor) });
    await platformAuditRepo.record({
      actor: actor.subject,
      actorEmail: actor.email ?? null,
      action: "plugin.oauth_app",
      entity: "plugin",
      entityId: piece,
      subject: p.displayName,
      before: prior ? { useSignInApp: prior.useSignInApp, clientId: prior.clientId, scopes: prior.scopes } : null,
      after: { useSignInApp, clientId, secretChanged: secretGiven, scopes: effectiveScopes(decl, row) },
    } as never);
    return oauthAppView(p, row);
  },

  async removeOauthApp(piece: string, actor: Actor) {
    const p = await liveDescription(piece);
    await pluginRepo.removeOauthApp(piece);
    await platformAuditRepo.record({ actor: actor.subject, actorEmail: actor.email ?? null, action: "plugin.oauth_app", entity: "plugin", entityId: piece, subject: p.displayName, after: { removed: true } } as never);
  },

  /**
   * Begin a sign-in. Answers the provider's authorize URL — the browser goes there — or, for a connector that signs in
   * without a person (client credentials), connects at once. `connectionId` signs an existing connection in again.
   */
  async startOauth(
    workspaceId: string,
    piece: string,
    input: { label?: string; connectionId?: string; asMe?: boolean; props?: Record<string, unknown> },
    actor: Actor,
  ): Promise<{ authorizeUrl: string; scopes: string[] } | { connection: ConnectionView }> {
    const p = await liveDescription(piece);
    const auth = oauthAuth(p);
    const decl = auth.oauth!;
    const app = await pluginRepo.getOauthApp(piece);
    const client = (() => {
      try {
        return clientFor(app);
      } catch (e) {
        return fail((e as Error).message, (e as StepError).status ?? 409);
      }
    })();
    let label: string;
    let owner: string | null;
    let props: Record<string, unknown>;
    if (input.connectionId) {
      const row = await this.getConnectionRow(workspaceId, input.connectionId, actor.subject);
      if (row.piece !== piece || row.authType !== "OAUTH2") fail("that connection is not a sign-in connection of this connector", 400);
      label = row.label;
      owner = row.ownerSubject;
      const stored = await storedFields(workspaceId, row.secretName);
      props = isOauthValue(stored) ? stored.props : {};
      if (input.props) props = checkFields(auth, input.props, props);
    } else {
      label = cleanLabel(input.label);
      owner = input.asMe ? actor.subject : null;
      await assertFreeLabel(workspaceId, p, label, owner);
      props = checkFields(auth, input.props, {});
    }
    const scopes = effectiveScopes(decl, app);

    if (decl.grantType === "client_credentials") {
      const tokenUrl = fillTemplate(decl.tokenUrl ?? "", props);
      const body = await viaConnector(() => tokenRequest(tokenUrl, { grant_type: "client_credentials", ...(scopes.length ? { scope: scopes.join(" ") } : {}) }, client, decl.authorizationMethod ?? "BODY"));
      const value = toValue(body, { tokenUrl, method: decl.authorizationMethod ?? "BODY", props });
      return { connection: await saveOauthConnection(workspaceId, p, { label, owner, connectionId: input.connectionId ?? null, value }, actor) };
    }

    let built: ReturnType<typeof authorizeUrl>;
    try {
      built = authorizeUrl(decl, { clientId: client.clientId, scopes, props, workspaceId });
    } catch (e) {
      return fail((e as Error).message, (e as StepError).status ?? 400);
    }
    await pluginRepo.createOauthState({
      stateHash: hashState(built.state),
      workspaceId,
      piece,
      label,
      connectionId: input.connectionId ?? null,
      ownerSubject: owner,
      subject: actor.subject,
      subjectEmail: actor.email ?? null,
      codeVerifierEnc: built.verifier ? encrypt(built.verifier) : null,
      propsEnc: encrypt(JSON.stringify(props)),
      redirectUri: redirectUri(),
      scopes,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return { authorizeUrl: built.url, scopes };
  },

  /**
   * The provider's answer. ⚠ The state must exist (single use — it is deleted as it is read), be unexpired, and
   * belong to THIS person in THIS workspace; a code arriving in anybody else's browser is refused.
   */
  async finishOauth(workspaceId: string, input: { code?: string; state?: string; error?: string; errorDescription?: string }, actor: Actor, opts: { canEnable: boolean }) {
    if (!input.state) fail("the sign-in came back without its state; start it again", 400);
    const st = await pluginRepo.takeOauthState(hashState(input.state));
    if (!st || st.workspaceId !== workspaceId) fail("this sign-in is unknown or was already used; start it again", 400);
    if (st.subject !== actor.subject) fail("this sign-in was started by somebody else", 403);
    if (st.expiresAt.getTime() < Date.now()) fail("this sign-in took longer than ten minutes; start it again", 400);
    if (!st.ownerSubject && !opts.canEnable) fail("connecting a service for the whole workspace needs the “Connect services” permission here", 403);
    const p = await liveDescription(st.piece);
    if (input.error) fail(`${p.displayName} did not sign in: ${[input.error, input.errorDescription].filter(Boolean).join(" — ").slice(0, 300)}`, 400, { piece: shortName(st.piece) });
    if (!input.code) fail("the sign-in came back without a code; start it again", 400);
    const decl = oauthAuth(p).oauth!;
    const { props, verifier } = openState(st);
    const tokenUrl = fillTemplate(decl.tokenUrl ?? "", props);
    const client = clientFor(await pluginRepo.getOauthApp(st.piece));
    const method = decl.authorizationMethod ?? "BODY";
    const params: Record<string, string> = { grant_type: "authorization_code", code: input.code, redirect_uri: st.redirectUri };
    if (verifier) params.code_verifier = verifier;
    const body = await viaConnector(() => tokenRequest(tokenUrl, params, client, method));
    const value = toValue(body, { tokenUrl, method, props });
    const connection = await saveOauthConnection(workspaceId, p, { label: st.label, owner: st.ownerSubject, connectionId: st.connectionId, value }, actor);
    // Tested at once, so the page shows whether the service accepts it rather than "Not tested".
    const tested = await this.testConnection(workspaceId, connection.id, actor).catch(() => null);
    return { piece: shortName(st.piece), connection: tested?.connection ?? connection };
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ConnectionView = ReturnType<typeof connectionView>;
/** ⚠ Names and dates only. There is no field here a value could travel in. */
function connectionView(c: PluginConnection) {
  return {
    id: c.id,
    piece: c.piece,
    label: c.label,
    authType: c.authType,
    fieldNames: c.fieldNames,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    lastTestedAt: c.lastTestedAt?.toISOString() ?? null,
    lastTestOk: c.lastTestOk,
    lastTestMessage: c.lastTestMessage,
    /** A personal connection ("as me") — only its owner ever sees it. */
    personal: c.ownerSubject != null,
  };
}

/** The piece's sign-in declaration, or a refusal naming why there is none. */
function oauthAuth(p: PieceDescription): PieceAuth {
  const a = p.auth.find((x) => x.type === "OAUTH2");
  if (!a?.oauth) fail(`${p.displayName} does not sign in with OAuth`, 400);
  return a;
}

function oauthStatus(p: PieceDescription, app: PluginOauthApp | undefined) {
  const a = p.auth.find((x) => x.type === "OAUTH2");
  if (!a?.oauth) return null;
  return { configured: !!app, useSignInApp: !!app?.useSignInApp, scopes: effectiveScopes(a.oauth, app), redirectUri: redirectUri() };
}

function oauthAppView(p: PieceDescription, app: PluginOauthApp | undefined) {
  const decl: OauthDecl = oauthAuth(p).oauth!;
  return {
    piece: p.name,
    configured: !!app,
    useSignInApp: !!app?.useSignInApp,
    clientId: app?.clientId ?? null,
    hasClientSecret: !!app?.clientSecretEnc,
    scopes: effectiveScopes(decl, app),
    pieceScopes: decl.scope,
    narrowed: !!app?.scopes?.length,
    pkce: !!decl.pkce,
    redirectUri: redirectUri(),
    signInAppOffered: isMicrosoft(decl) && signInAppAvailable(),
    newAppUrl: newAppUrl(decl),
    updatedBy: app?.updatedBy ?? null,
    updatedAt: app?.updatedAt?.toISOString() ?? null,
  };
}

async function assertFreeLabel(workspaceId: string, p: PieceDescription, label: string, owner: string | null) {
  const taken = (await pluginRepo.listConnections(workspaceId, p.name, owner)).some((c) => c.label === label && (c.ownerSubject ?? null) === owner);
  if (taken) fail(`${p.displayName} already has ${owner ? "a personal" : "a"} connection called "${label}" here`, 409);
}

/** A personal connection's credential name says so, and carries a short hash of the owner rather than their id. */
function secretStem(piece: string, label: string, owner: string | null): string {
  const tag = owner ? `_ME_${createHash("sha256").update(owner).digest("hex").slice(0, 6)}` : "";
  return `PLUGIN_${shortName(piece)}${tag}_${label}`;
}

/** Store a sign-in's value: a new connection, or the same connection signed in again (its value replaced). */
async function saveOauthConnection(
  workspaceId: string,
  p: PieceDescription,
  input: { label: string; owner: string | null; connectionId: string | null; value: ReturnType<typeof toValue> },
  actor: Actor,
): Promise<ConnectionView> {
  const fieldNames = [...Object.keys(input.value.props), "access_token", ...(input.value.refresh_token ? ["refresh_token"] : [])].sort();
  if (input.connectionId) {
    const row = await pluginRepo.getConnection(workspaceId, input.connectionId);
    if (!row) fail("that connection was removed while signing in", 404);
    const secret = await workspaceSecretRepo.getByName(workspaceId, row.secretName);
    if (secret) await workspaceSecretRepo.update(workspaceId, secret.id, { valueEnc: encrypt(JSON.stringify(input.value)) } as never);
    else await workspaceSecretRepo.upsertByName({ workspaceId, name: row.secretName, description: `${p.displayName} connection "${row.label}" (managed on Connected services)`, kind: "tool", valueEnc: encrypt(JSON.stringify(input.value)) } as never);
    const out = await pluginRepo.updateConnection(workspaceId, row.id, { fieldNames, lastTestedAt: null, lastTestOk: null, lastTestMessage: null });
    await auditService.record({
      workspaceId,
      actor: who(actor),
      operation: "update",
      entity: "connection",
      entityId: row.id,
      description: `Signed ${p.displayName} connection "${row.label}" in again`,
      whereText: `Connected services · ${p.displayName}`,
      raw: { piece: p.name, label: row.label, authType: "OAUTH2", scope: input.value.scope ?? null },
    });
    return connectionView(out!);
  }
  const secretName = await freeSecretName(workspaceId, secretStem(p.name, input.label, input.owner));
  await workspaceSecretRepo.upsertByName({
    workspaceId,
    name: secretName,
    description: `${p.displayName} connection "${input.label}" (managed on Connected services)`,
    kind: "tool",
    valueEnc: encrypt(JSON.stringify(input.value)),
  } as never);
  const row = await pluginRepo.createConnection({ workspaceId, piece: p.name, label: input.label, authType: "OAUTH2", secretName, fieldNames, createdBy: who(actor), ownerSubject: input.owner });
  await auditService.record({
    workspaceId,
    actor: who(actor),
    operation: "create",
    entity: "connection",
    entityId: row.id,
    description: `Connected ${p.displayName} as "${input.label}" by signing in${input.owner ? " (personal)" : ""}`,
    whereText: `Connected services · ${p.displayName}`,
    raw: { piece: p.name, label: input.label, authType: "OAUTH2", scope: input.value.scope ?? null },
  });
  return connectionView(row);
}

function authDeclFor(p: PieceDescription, authType?: string): PieceAuth {
  if (!p.auth.length) fail(`${p.displayName} needs no connection`, 400);
  const decl = authType ? p.auth.find((a) => a.type === authType) : p.auth.find((a) => a.type !== "OAUTH2") ?? p.auth[0];
  if (!decl) fail(`${p.displayName} takes no ${authType} connection`, 400);
  if (decl.type === "OAUTH2" || decl.type === "OIDC") {
    fail(decl.type === "OAUTH2" ? `${p.displayName} connects by signing in, not with values: use "Connect with ${p.displayName}"` : `${p.displayName}'s identity-federation connection is not available yet`, 422);
  }
  return decl;
}

function cleanLabel(label: unknown): string {
  const s = String(label ?? "").trim();
  if (!s) fail("a connection needs a name", 400);
  if (s.length > 60) fail("a connection's name is at most 60 characters", 400);
  return s;
}

/**
 * The fields the piece declares, and only those. `stored` is the current value on a rotation: a field given blank keeps
 * it. Required fields must end up non-empty; values are text, numbers or booleans — never objects.
 */
function checkFields(decl: PieceAuth, given: Record<string, unknown> | undefined, stored: Record<string, unknown>): Record<string, unknown> {
  const declared = decl.fields ?? [];
  const g = given ?? {};
  if (typeof g !== "object" || Array.isArray(g)) fail("fields must be an object of name → value", 400);
  const unknown = Object.keys(g).filter((k) => !declared.some((f) => f.name === k));
  if (unknown.length) fail(`not fields of this connection: ${unknown.join(", ")}`, 400);
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const f of declared) {
    let v = g[f.name];
    if (v === "" || v === undefined || v === null) v = stored[f.name];
    if ((v === "" || v === undefined || v === null) && f.defaultValue !== undefined) v = f.defaultValue;
    if (v === "" || v === undefined || v === null) {
      if (f.required) missing.push(f.label ?? f.name);
      continue;
    }
    if (typeof v === "object") fail(`"${f.label ?? f.name}" must be text`, 400);
    if (typeof v === "string" && v.length > 20_000) fail(`"${f.label ?? f.name}" is too long`, 400);
    if (f.options?.length && !f.options.some((o) => o.value === v)) fail(`"${f.label ?? f.name}" must be one of ${f.options.map((o) => o.label).join(", ")}`, 400);
    out[f.name] = v;
  }
  if (missing.length) fail(`missing: ${missing.join(", ")}`, 400);
  return out;
}

async function storedFields(workspaceId: string, secretName: string): Promise<Record<string, unknown>> {
  const s = await workspaceSecretRepo.getByName(workspaceId, secretName);
  if (!s) return {};
  try {
    return JSON.parse(decrypt(s.valueEnc)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function freeSecretName(workspaceId: string, base: string): Promise<string> {
  const stem = base.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? stem : `${stem}_${n}`;
    if (!(await workspaceSecretRepo.getByName(workspaceId, name))) return name;
  }
  return fail("could not find a free credential name", 409);
}

function toolDescription(p: PieceDescription, a: PieceActionDescription): string {
  const effect = a.destructive ? "DELETES or irreversibly changes data in" : a.writes ? "CHANGES data in" : "Only reads from";
  return `${p.displayName} — ${a.displayName}. ${a.description} (${effect} ${p.displayName}. A test run records a change and does not perform it.)`;
}

export const __test = { shapeCatalogue, checkFields, cleanHosts, authDeclFor, connectionView };
