/**
 * A chat's vault, the pure part (0150): input schemas, the safe view, the owner rule, and catching a secret that the
 * person pasted into a message. A value is written and never read back. No DB or config imports: it is tested alone.
 */
import { z } from "zod";
import { findSecretValues } from "@foundry/redact";

export class ChatSecretError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ChatSecretError";
  }
}

/** A pasted secret that no one has chosen a website for expires after this. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;

export const secretNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "A name is lowercase letters, digits and dashes, like twitterapi-key.");

const DNS_NAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const NOT_A_HOST = "That is not a website address, like api.example.com.";

/** `api.example.com` or a pasted URL, normalised to the lowercase hostname. */
export const hostSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const bad = () => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: NOT_A_HOST });
      return z.NEVER;
    };
    if (!raw || /\s/.test(raw)) return bad();
    let host: string;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      return bad();
    }
    const ip = IPV4_RE.exec(host);
    if (ip) return ip.slice(1).every((o) => Number(o) <= 255) ? host : bad();
    return DNS_NAME_RE.test(host) ? host : bad();
  });

export const placementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer") }),
  z.object({ kind: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,128}$/, "A header name is letters, digits and dashes.") }),
  z.object({ kind: z.literal("query"), name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, "A query name is letters, digits, dots, dashes and underscores.") }),
]);

export const valueSchema = z.string().trim().min(8, "A secret is at least 8 characters.").max(8192, "A secret is at most 8192 characters.");

const extraHostsSchema = z.array(hostSchema).max(5, "At most 5 extra websites.");
const expiresSchema = z.string().datetime("Expiry is a date and time.").nullable();

export const createInputSchema = z
  .object({
    name: secretNameSchema,
    host: hostSchema,
    extraHosts: extraHostsSchema.optional(),
    placement: placementSchema,
    value: valueSchema,
    expiresAt: expiresSchema.optional(),
  })
  .strict();

export const updateInputSchema = z
  .object({
    value: valueSchema.optional(),
    host: hostSchema.optional(),
    extraHosts: extraHostsSchema.optional(),
    placement: placementSchema.optional(),
    expiresAt: expiresSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change." });

export type Placement = z.infer<typeof placementSchema>;

export type ChatSecretView = {
  id: string;
  name: string;
  status: "pending" | "active";
  host: string | null;
  extraHosts: string[];
  placement: { kind: "header" | "query" | "bearer"; name: string | null };
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export type ChatSecretMetaRow = {
  id: string;
  name: string;
  status: string;
  boundHost: string | null;
  extraHosts: string[];
  placementKind: string;
  placementName: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

/** What the person (and Forge) may see of a secret: never its value. Fields are copied one by one on purpose. */
export function toView(row: ChatSecretMetaRow): ChatSecretView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "pending" ? "pending" : "active",
    host: row.boundHost,
    extraHosts: [...(row.extraHosts ?? [])],
    placement: { kind: row.placementKind as "header" | "query" | "bearer", name: row.placementName },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Only the person a chat belongs to. An Admin is not allowed. */
export function assertSecretOwner(ownerSubject: string | null | undefined, personSubject: string | null | undefined): void {
  if (!ownerSubject || !personSubject || ownerSubject !== personSubject) {
    throw new ChatSecretError("Only the person this chat belongs to can see or change its secrets.", 403);
  }
}

const KIND_NAMES: Record<string, string> = {
  anthropic: "anthropic-key",
  openai: "openai-key",
  github: "github-token",
  aws: "aws-access-key",
  slack: "slack-token",
  google: "google-api-key",
  stripe: "stripe-key",
  jwt: "jwt",
  "private-key": "private-key",
  bearer: "bearer-token",
};

export function suggestName(kind: string, value: string): string {
  const fixed = KIND_NAMES[kind];
  if (fixed) return fixed;
  if (kind === "prefixed") {
    const prefix = value.split(/[-_]/, 1)[0] ?? "";
    const slug = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) return `${slug}-key`;
  }
  return "pasted-key";
}

export type CaughtSecret = { name: string; value: string; kind: string };

/** Replace each secret found in a message with `{{secret:<name>}}`. The same value twice keeps one name. */
export function interceptSecrets(text: string, existingNames: string[]): { text: string; caught: CaughtSecret[] } {
  const hits = findSecretValues(text, { heuristics: true });
  if (hits.length === 0) return { text, caught: [] };
  const taken = new Set(existingNames);
  const byValue = new Map<string, string>();
  const caught: CaughtSecret[] = [];
  for (const h of hits) {
    if (byValue.has(h.value)) continue;
    const base = suggestName(h.kind, h.value);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    byValue.set(h.value, name);
    caught.push({ name, value: h.value, kind: h.kind });
  }
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    out = out.slice(0, h.start) + `{{secret:${byValue.get(h.value)}}}` + out.slice(h.end);
  }
  return { text: out, caught };
}

/** A paragraph added to what Forge receives (never shown to the person). */
export function forgeNoteFor(caught: Array<{ name: string }>): string {
  if (caught.length === 0) return "";
  const n = caught.length;
  const names = caught.map((c) => c.name).join(", ");
  return `\n\n(Tether: the person pasted ${n} secret${n === 1 ? "" : "s"} into this message. They were moved to this chat's vault as ${names} and replaced above with {{secret:<name>}}. They are not usable until the person chooses each one's website on the card under their message. Never ask them to paste a key into the chat again; to call an API with a secret use node tools/http.mjs ... --secret <name>.)`;
}

const VAULT_LINE_MAX = 10;

/** The per-turn line about this chat's vault (Forge Agent). Names and websites only, never a value. */
export function vaultLine(secrets: ChatSecretView[]): string {
  if (!secrets.length) {
    return "No keys in this chat's vault. If a job needs an API key, ask the person to add it with the key button under the message box — never ask them to paste it into chat.";
  }
  const sentAs = (p: ChatSecretView["placement"]) =>
    p.kind === "bearer" ? "bearer" : p.kind === "header" ? `header ${p.name ?? ""}`.trim() : `query ${p.name ?? ""}`.trim();
  const active = secrets.filter((v) => v.status === "active");
  const pending = secrets.filter((v) => v.status === "pending");
  const shown = [...active, ...pending].slice(0, VAULT_LINE_MAX);
  const parts = shown.map((v) =>
    v.status === "pending"
      ? `${v.name} (waiting for the person to choose its website)`
      : `${v.name} — for ${[v.host, ...v.extraHosts].filter(Boolean).join(", ")}, sent as ${sentAs(v.placement)}`,
  );
  const more = secrets.length > shown.length ? `; and ${secrets.length - shown.length} more` : "";
  const first = active[0];
  return (
    `Keys saved in this chat's vault (use them by name; you never see the values): ${parts.join("; ")}${more}.` +
    (first
      ? ` Call a web API with: node tools/http.mjs GET https://${first.host ?? "<host>"}/... --secret ${first.name}. A saved key does NOT need a connected service.`
      : "")
  );
}
