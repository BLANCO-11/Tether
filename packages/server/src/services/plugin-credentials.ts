/**
 * A connected service's credential belongs to its CONNECTION (plugins phase 8.1, 2026-10-28).
 *
 * A connection's value is an ordinary `workspace_secrets` row, resolved by name like every other credential — so until
 * this, a hand-made HTTP tool could name `PLUGIN_GITHUB_TEAM` (or a person's "only for me" one) as its credential and
 * send the token to any address it liked, and the secrets pages could overwrite or delete it. The `plugin_connections`
 * row already records which credential it owns and for whom, so it is the one definition here; nothing new is stored.
 *
 * The rules:
 *   - only a `plugin://` tool, on its own piece, may use a connection's credential;
 *   - a personal ("only for me") credential is used only for a call its OWNER makes — no acting person ⇒ refused;
 *   - a connection's credential is changed and removed on its Apps page, never on the secrets pages.
 */
import { pluginRepo, type PluginConnection } from "../repositories/plugin.repo.js";

type Refusal = Error & { statusCode: number };
const refusal = (message: string, statusCode: number): Refusal => Object.assign(new Error(message), { statusCode });

/** The connection that owns this credential name, or undefined when it is an ordinary credential. */
export function connectionOwning(workspaceId: string, secretName: string | null | undefined): Promise<PluginConnection | undefined> {
  if (!secretName) return Promise.resolve(undefined);
  return pluginRepo.connectionBySecret(workspaceId, secretName);
}

/** Refuse when any of these names is a connected service's credential — for a hand-made tool or a secrets-page write. */
export async function assertNotConnectionCredential(workspaceId: string, names: Array<string | null | undefined>, what: string): Promise<void> {
  for (const name of names) {
    if (!name) continue;
    if (await connectionOwning(workspaceId, name)) {
      throw refusal(`"${name}" is a connected service's credential; it ${what}. It is managed on the service's Apps page.`, 403);
    }
  }
}

/**
 * The check at the CALL of a plugin tool: the credential must belong to a connection of this piece in this workspace,
 * and a personal one only to the person the call is made for.
 */
export async function assertMayUseConnection(
  workspaceId: string,
  secretName: string,
  piece: string,
  actingSubject: string | null | undefined,
): Promise<PluginConnection> {
  const conn = await connectionOwning(workspaceId, secretName);
  if (!conn || conn.piece !== piece) {
    throw refusal(`"${secretName}" is not a connection to this service in this workspace`, 403);
  }
  if (conn.ownerSubject && conn.ownerSubject !== actingSubject) {
    throw refusal(`the connection "${conn.label}" belongs to one person and is used only for that person's own calls`, 403);
  }
  return conn;
}

/**
 * The names the secrets pages leave out (plugins 8.3): a connection's credential is managed on its Apps page, and a
 * personal one's name alone says whose account is connected.
 */
export function connectionSecretNames(workspaceId: string): Promise<Set<string>> {
  return pluginRepo.secretNamesIn(workspaceId);
}
