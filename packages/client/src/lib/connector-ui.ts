// src/lib/connector-ui.ts — the display rules for connectors (plans/plugins-2026-10-27, phase 5), kept PURE and out of
// the pages so each rule can be asserted without rendering anything.
//
// ⚠ Three rules every function here keeps:
//   * an action that does not DECLARE it only reads is shown as one that may change data — 15% of pieces' actions
//     declare nothing, and "reads" is the claim that would make somebody switch one on carelessly;
//   * a connection that was never checked is never shown as working — a piece with no check of its own says so;
//   * a field's VALUE is never displayed. A form takes one; a connection lists the NAMES of the fields it holds.
import type {
  ConnectorAction,
  ConnectorAuth,
  ConnectorAuthField,
  ConnectorCatalogueEntry,
  ConnectorConnection,
  WorkspaceConnector,
} from "@/lib/types";

type Tone = "ok" | "warn" | "danger" | "neutral";

/** What an action does to the service it calls, in words a person deciding whether to switch it on needs. */
export function actionEffect(a: Pick<ConnectorAction, "writes" | "destructive" | "classification" | "unsupported">): { label: string; tone: Tone } {
  if (a.unsupported.length) return { label: "Not offered", tone: "neutral" };
  if (a.destructive) return { label: "Deletes data", tone: "danger" };
  if (!a.writes) return { label: "Only reads", tone: "ok" };
  if (!a.classification) return { label: "May change data", tone: "warn" };
  return { label: "Changes data", tone: "warn" };
}

/** The raw API call is never offered: with the connection it can reach any address of the service. */
export const NEVER_OFFERED = new Set(["custom_api_call"]);
export function offerable(a: ConnectorAction): boolean {
  return !a.unsupported.length && !NEVER_OFFERED.has(a.name);
}

/** What a connection's last check said. ⚠ Untested and "no check offered" are never "Connected". */
export function connectionState(c: Pick<ConnectorConnection, "lastTestedAt" | "lastTestOk" | "lastTestMessage">): { label: string; tone: Tone; detail: string | null } {
  if (!c.lastTestedAt) return { label: "Not tested", tone: "neutral", detail: "Test it to see whether the service accepts it." };
  if (c.lastTestOk === true) return { label: "Connected", tone: "ok", detail: `Accepted by the service ${when(c.lastTestedAt)}.` };
  if (c.lastTestOk === false) return { label: "Refused", tone: "danger", detail: c.lastTestMessage ?? "The service did not accept this connection." };
  return { label: "Not checked", tone: "neutral", detail: c.lastTestMessage ?? "This connector has no check of its own; it is tried the first time an action runs." };
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `on ${d.toLocaleString()}`;
}

/**
 * How a connection field is entered. ⚠ Masked whenever it MAY be a secret — the piece's own type says SECRET_TEXT, or
 * its name says pass/secret/token/key. ServiceNow types its password as plain text; trusting the type alone would echo
 * a password on screen.
 */
export function fieldInput(f: ConnectorAuthField): "password" | "select" | "text" {
  if (f.options?.length) return "select";
  if (f.secret || /pass|secret|token|key|private|credential/i.test(f.name)) return "password";
  return "text";
}

/**
 * How a piece can be connected: by a FORM (keys, username/password, custom fields), by SIGNING IN (OAuth — the person
 * consents at the provider; no token is ever typed), both, or not at all yet (identity federation only).
 */
export function connectableAuths(auth: ConnectorAuth[]): { forms: ConnectorAuth[]; signIn: ConnectorAuth | null; notYet: boolean; none: boolean } {
  const forms = auth.filter((a) => a.type !== "OAUTH2" && a.type !== "OIDC");
  const signIn = auth.find((a) => a.type === "OAUTH2") ?? null;
  return { forms, signIn, notYet: auth.length > 0 && forms.length === 0 && !signIn, none: auth.length === 0 };
}

/** One connector in this workspace, as one sentence and a tone — the card and the detail header share it. */
export function workspaceState(p: Pick<WorkspaceConnector, "connections" | "enabled">): { label: string; tone: Tone } {
  if (p.enabled.length) return { label: `${p.enabled.length} action${p.enabled.length === 1 ? "" : "s"} on`, tone: "ok" };
  if (p.connections.length) return { label: "Connected — no actions on", tone: "warn" };
  return { label: "Not connected here", tone: "neutral" };
}

/**
 * A piece's setup instructions as Foundry shows them. ⚠ Pieces are written for Activepieces' own product, and some
 * paragraphs describe ITS screens ("When you connect, Activepieces shows a permissions selector…") — true there, false
 * here. A paragraph naming Activepieces is left out rather than reworded: a rewrite of somebody else's instructions is
 * a claim nobody checked. What remains is how to obtain the credential at the service, which holds anywhere.
 */
export function setupInstructions(description: string | undefined): string {
  return (description ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .filter((para) => !/activepieces/i.test(para))
    .join("\n\n")
    .trim();
}

/** A field's hint, unless it only repeats the instructions shown above it (a one-field key repeats them verbatim). */
export function fieldHint(fieldDescription: string | undefined, authDescription: string | undefined): string | undefined {
  const d = (fieldDescription ?? "").trim();
  if (!d) return undefined;
  const a = (authDescription ?? "").trim();
  return a && (a === d || a.startsWith(d.replace(/…$/, ""))) ? undefined : d;
}

/** `CONTENT_AND_FILES` → `Content and files`. */
export function categoryLabel(c: string): string {
  const s = c.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What connecting it involves, when that is worth saying on a marketplace card. */
export function catalogueAuthNote(e: Pick<ConnectorCatalogueEntry, "authTypes">): string | null {
  if (!e.authTypes.length) return "No sign-in needed";
  if (e.authTypes.every((t) => t === "OIDC")) return "Identity federation only — not available yet";
  if (e.authTypes.every((t) => t === "OAUTH2" || t === "OIDC")) return "Connects by signing in (OAuth) — an administrator sets up its app once";
  return null;
}

/** The sign-in's scopes, one line: what the provider's consent screen will ask for. */
export function scopeLine(scopes: string[]): string {
  return scopes.length ? scopes.join(", ") : "the provider's default access";
}

export function filterCatalogue(
  entries: ConnectorCatalogueEntry[],
  f: { q: string; category: string; installedOnly: boolean },
): ConnectorCatalogueEntry[] {
  const q = f.q.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!f.installedOnly || e.installedVersion) &&
      (f.category === "all" || e.categories.includes(f.category)) &&
      (!q || e.displayName.toLowerCase().includes(q) || e.short.includes(q) || e.description.toLowerCase().includes(q)),
  );
}

export function catalogueCategories(entries: ConnectorCatalogueEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.categories))].sort();
}

/** One host per line or comma; the server is the judge of what a host is. */
export function parseHosts(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))];
}
