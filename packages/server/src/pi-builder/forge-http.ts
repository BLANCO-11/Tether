/**
 * Forge Agent calls web APIs (tools/http.mjs → POST /api/forge/http). The sandbox has no internet, so the server makes
 * the call: every hop is dialled through the guarded lookup (no private, loopback or metadata addresses), and a vault
 * secret is injected here, server-side, only while the hop's host is one the secret is bound to. Forge never sees the
 * value: responses are scrubbed, and a request that would carry a secret to another host drops it. GET/HEAD run
 * directly; anything that changes something becomes a draft the person confirms (see `httpPolicy`). No DB or config
 * imports: everything is injected so it can be tested.
 */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { z } from "zod";
import { READABLE, WebFetchError, checkLiteral, guardedLookup, redactUrl } from "../services/web-fetch.service.js";
import type { ChatMode } from "./instructions.js";

export class ForgeHttpError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

export const forgeHttpBodySchema = z
  .object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().min(1).max(4000),
    headers: z
      .record(z.string().max(8000))
      .refine((h) => Object.keys(h).length <= 30, { message: "at most 30 headers" })
      .optional(),
    query: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .refine((q) => Object.keys(q).length <= 50, { message: "at most 50 query parameters" })
      .optional(),
    body: z.string().max(1_000_000).optional(),
    json: z.unknown().optional(),
    secret: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  })
  .strict()
  .refine((v) => !(v.body !== undefined && v.json !== undefined), { message: "give body or json, not both" })
  .refine((v) => !((v.method === "GET" || v.method === "HEAD") && (v.body !== undefined || v.json !== undefined)), {
    message: "GET and HEAD carry no body",
  });

export type HttpPlacement = { kind: "header" | "query" | "bearer"; name: string | null };
export type HttpSecret = { name: string; value: string; hosts: string[]; placement: HttpPlacement };

export type ForgeHttpContext = {
  workspaceId: string;
  sessionId: string;
  chatId: string | null;
  mode: ChatMode;
  actor: string;
};

export type HttpTransport = (r: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal: AbortSignal;
  maxBytes: number;
}) => Promise<{
  status: number;
  statusText?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}>;

export type ForgeHttpRecord = {
  workspaceId: string;
  sessionId: string;
  chatId: string | null;
  actor: string;
  method: string;
  /** redactUrl of the URL Forge gave; never contains the secret. */
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
  secretName: string | null;
};

export type ForgeHttpCaps = { timeoutMs: number; maxBytes: number; perMinute: number; perHour: number };

export const DEFAULT_FORGE_HTTP_CAPS: ForgeHttpCaps = { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, perMinute: 20, perHour: 200 };

export type ForgeHttpDeps = {
  webAccess(): Promise<boolean>;
  secret(name: string): Promise<HttpSecret | null>;
  markUsed(name: string): Promise<void>;
  transport: HttpTransport;
  record(row: ForgeHttpRecord): Promise<void>;
  scrub(text: string): string;
  now(): number;
  caps: ForgeHttpCaps;
};

export const HTTP_CONFIRM_TTL_MS = 30 * 60_000;
const MAX_REDIRECTS = 5;

export type ForgeHttpDraft = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full URL including Forge's query; never the secret. */
  url: string;
  headers: Record<string, string>;
  body: string | null;
  contentType: string | null;
  secret: { name: string; host: string; placement: HttpPlacement } | null;
  expiresAt: string;
};

export type ForgeHttpResponse = {
  status: number;
  statusText: string;
  url: string;
  finalUrl: string;
  headers: Record<string, string>;
  contentType: string;
  bytes: number;
  truncated: boolean;
  note?: string;
  text?: string;
  data?: unknown;
  base64?: string;
  secretDropped?: boolean;
};

export type PreparedHttp = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | null;
  contentType: string | null;
  secret: HttpSecret | null;
};

/**
 * STAGE-2 HOOK. The single decision point for whether a call runs now or waits for the person's confirmation. Stage 2
 * (remembered approvals: allow in this chat / always) will widen it here. Callers must not decide the policy anywhere
 * else.
 */
export async function httpPolicy(
  _ctx: ForgeHttpContext,
  req: { method: string; url: URL; secret: string | null },
): Promise<"direct" | "confirm"> {
  return req.method === "GET" || req.method === "HEAD" ? "direct" : "confirm";
}

/** Timestamps of calls prepared in the last hour, per chat. */
const calls = new Map<string, number[]>();

export function resetForgeHttpRateLimit(): void {
  calls.clear();
}

const FORBIDDEN_HEADERS = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
];

async function writeRow(deps: ForgeHttpDeps, row: ForgeHttpRecord): Promise<void> {
  try {
    await deps.record(row);
  } catch (e) {
    console.warn(`[forge-http] could not record a call: ${(e as Error).message}`);
  }
}

function baseRow(ctx: ForgeHttpContext, method: string, url: string, secretName: string | null) {
  return {
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    chatId: ctx.chatId,
    actor: ctx.actor,
    method,
    url: redactUrl(url).slice(0, 4000),
    secretName,
  };
}

function parseHop(raw: string, base?: URL): URL {
  let u: URL;
  try {
    u = base ? new URL(raw.trim(), base) : new URL(raw.trim());
  } catch {
    throw new ForgeHttpError(`"${raw.slice(0, 200)}" is not a web address. Give the full address, starting with https://.`, 400);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ForgeHttpError(`Only http and https addresses can be called, not ${u.protocol}`, 400);
  }
  if (u.username || u.password) {
    throw new ForgeHttpError("Remove the user name and password from the address; use a secret to sign in.", 400);
  }
  return u;
}

export async function prepareHttp(
  ctx: ForgeHttpContext,
  input: z.infer<typeof forgeHttpBodySchema>,
  deps: ForgeHttpDeps,
): Promise<PreparedHttp> {
  if (ctx.mode !== "agent") throw new ForgeHttpError("Calling web APIs from a chat is for Forge Agent.", 403);

  const key = ctx.chatId ?? ctx.sessionId;
  const t = deps.now();
  const recent = (calls.get(key) ?? []).filter((x) => x > t - 3_600_000);
  const lastMinute = recent.filter((x) => x > t - 60_000).length;
  if (lastMinute >= deps.caps.perMinute) {
    calls.set(key, recent);
    throw new ForgeHttpError(`This chat has made ${lastMinute} web requests in the last minute. Try again later.`, 429);
  }
  if (recent.length >= deps.caps.perHour) {
    calls.set(key, recent);
    throw new ForgeHttpError(`This chat has made ${recent.length} web requests in the last hour. Try again later.`, 429);
  }
  recent.push(t);
  calls.set(key, recent);

  const refuse = async (message: string, status: number): Promise<never> => {
    await writeRow(deps, {
      ...baseRow(ctx, input.method, input.url, input.secret ?? null),
      finalUrl: null,
      status: null,
      contentType: null,
      bytes: null,
      durationMs: 0,
      ok: false,
      error: message.slice(0, 2000),
    });
    throw new ForgeHttpError(message, status);
  };

  if (!(await deps.webAccess())) {
    return refuse(
      "Web access is switched off for this workspace. Its admins can switch it on in the workspace's settings.",
      403,
    );
  }

  let url: URL;
  try {
    url = parseHop(input.url);
  } catch (e) {
    return refuse((e as Error).message, (e as ForgeHttpError).statusCode ?? 400);
  }
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.append(k, String(v));

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const name = k.trim().toLowerCase();
    if (FORBIDDEN_HEADERS.includes(name)) return refuse(`The ${name} header cannot be set; the server manages it.`, 400);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return refuse(`"${k.slice(0, 80)}" is not a valid header name.`, 400);
    if (/[\r\n\0]/.test(v)) return refuse(`The ${name} header has a line break in its value.`, 400);
    headers[name] = v;
  }

  let body: Buffer | null = input.body !== undefined ? Buffer.from(input.body, "utf8") : null;
  if (input.json !== undefined) {
    body = Buffer.from(JSON.stringify(input.json) ?? "null", "utf8");
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }

  let secret: HttpSecret | null = null;
  if (input.secret) {
    secret = await deps.secret(input.secret);
    if (!secret) {
      return refuse(
        `There is no usable secret named "${input.secret}" in this chat's vault. It may still be waiting for the person to choose its website, or they can add it with Add secret under the message box.`,
        404,
      );
    }
    const host = url.hostname.toLowerCase();
    if (!secret.hosts.map((h) => h.toLowerCase()).includes(host)) {
      return refuse(`This secret is only for ${secret.hosts.join(", ")}.`, 400);
    }
    const p = secret.placement;
    if (p.kind === "bearer" || p.kind === "header") {
      const n = p.kind === "bearer" ? "authorization" : (p.name ?? "authorization").toLowerCase();
      if (headers[n] !== undefined) return refuse(`Do not set ${n} yourself; the secret fills it.`, 400);
    } else if (p.name && url.searchParams.has(p.name)) {
      return refuse(`Do not set ${p.name} yourself; the secret fills it.`, 400);
    }
  }

  return { method: input.method, url, headers, body, contentType: headers["content-type"] ?? null, secret };
}

function decode(body: Buffer, contentType: string): string {
  const cs = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "") ?? "utf-8";
  try {
    return new TextDecoder(cs).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function validUtf8(body: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

export async function executeHttp(ctx: ForgeHttpContext, prepared: PreparedHttp, deps: ForgeHttpDeps): Promise<ForgeHttpResponse> {
  const began = deps.now();
  const { secret } = prepared;
  const follows = prepared.method === "GET" || prepared.method === "HEAD";
  const start = prepared.url;
  const secretName = secret?.name ?? null;
  const hosts = secret ? secret.hosts.map((h) => h.toLowerCase()) : [];
  const signal = AbortSignal.timeout(deps.caps.timeoutMs);
  const mb = (deps.caps.maxBytes / 1048576).toFixed(deps.caps.maxBytes % 1048576 === 0 ? 0 : 1);

  let url = new URL(start.toString());
  const headers = { ...prepared.headers };
  let dropped = false;
  let status: number | null = null;
  let contentType: string | null = null;
  let bytes: number | null = null;

  const fail = async (message: string, code: number): Promise<never> => {
    const msg = deps.scrub(message);
    await writeRow(deps, {
      ...baseRow(ctx, prepared.method, start.toString(), secretName),
      finalUrl: redactUrl(url.toString()),
      status,
      contentType,
      bytes,
      durationMs: deps.now() - began,
      ok: false,
      error: msg.slice(0, 2000),
    });
    throw new ForgeHttpError(msg, code);
  };

  let res: Awaited<ReturnType<HttpTransport>> | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (secret && !dropped && !hosts.includes(url.hostname.toLowerCase())) {
      dropped = true;
      if (secret.placement.kind === "query" && secret.placement.name) url.searchParams.delete(secret.placement.name);
      delete headers["authorization"];
      delete headers["cookie"];
    }
    const wireUrl = new URL(url.toString());
    const wireHeaders = { ...headers };
    if (secret && !dropped) {
      const p = secret.placement;
      if (p.kind === "bearer") wireHeaders["authorization"] = `Bearer ${secret.value}`;
      else if (p.kind === "header") wireHeaders[(p.name ?? "authorization").toLowerCase()] = secret.value;
      else if (p.name) wireUrl.searchParams.set(p.name, secret.value);
    }
    try {
      res = await deps.transport({
        url: wireUrl,
        method: prepared.method,
        headers: wireHeaders,
        body: prepared.body,
        signal,
        maxBytes: deps.caps.maxBytes,
      });
    } catch (e) {
      const err = e as Error;
      if (e instanceof WebFetchError) return fail(err.message, e.statusCode);
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        return fail(`${url.hostname} did not answer within ${deps.caps.timeoutMs / 1000} seconds.`, 504);
      }
      return fail(`${url.hostname} could not be reached: ${err.message}`, 502);
    }
    const loc = res.headers["location"];
    if (follows && res.status >= 300 && res.status < 400 && loc) {
      if (hop === MAX_REDIRECTS) return fail(`${start.hostname} redirected more than ${MAX_REDIRECTS} times.`, 502);
      try {
        url = parseHop(String(Array.isArray(loc) ? loc[0] : loc), url);
      } catch (e) {
        return fail((e as Error).message, 502);
      }
      continue;
    }
    break;
  }
  const r = res!;

  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    const name = k.toLowerCase();
    if (v === undefined || name === "set-cookie" || name === "set-cookie2") continue;
    outHeaders[name] = deps.scrub(Array.isArray(v) ? v.join(", ") : v);
  }
  const ct = outHeaders["content-type"] ?? "";
  status = r.status;
  contentType = ct.slice(0, 255) || null;
  bytes = r.body.length;

  const out: ForgeHttpResponse = {
    status: r.status,
    statusText: deps.scrub(r.statusText ?? ""),
    url: deps.scrub(start.toString()),
    finalUrl: deps.scrub(url.toString()),
    headers: outHeaders,
    contentType: ct,
    bytes: r.body.length,
    truncated: r.truncated,
  };
  if (dropped) out.secretDropped = true;

  if (prepared.method !== "HEAD" && r.body.length > 0) {
    const textual = READABLE.test(ct) || /^application\/x-www-form-urlencoded/i.test(ct) || (!ct && validUtf8(r.body));
    if (textual) {
      const text = deps.scrub(decode(r.body, ct));
      let parsed = false;
      if (/json/i.test(ct) && !r.truncated) {
        try {
          out.data = JSON.parse(text);
          parsed = true;
        } catch {
          /* not JSON after all: hand it back as text */
        }
      }
      if (!parsed) out.text = text;
    } else if (secret && secret.value && r.body.indexOf(Buffer.from(secret.value, "utf8")) >= 0) {
      out.text = "[the response contained this chat's secret, so it was withheld]";
    } else {
      out.base64 = r.body.toString("base64");
    }
  }
  if (r.truncated) out.note = `The response was larger than ${mb} MB; only the first ${mb} MB was read.`;

  await writeRow(deps, {
    ...baseRow(ctx, prepared.method, start.toString(), secretName),
    finalUrl: redactUrl(url.toString()),
    status: r.status,
    contentType,
    bytes: r.body.length,
    durationMs: deps.now() - began,
    ok: true,
    error: null,
  });
  if (secret) {
    try {
      await deps.markUsed(secret.name);
    } catch (e) {
      console.warn(`[forge-http] could not mark secret "${secret.name}" used: ${(e as Error).message}`);
    }
  }
  return out;
}

/** What the card shows and what is stored while waiting. Never holds the secret's value. */
export function draftOf(prepared: PreparedHttp, now: number, scrub: (text: string) => string): ForgeHttpDraft {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(prepared.headers)) headers[k] = scrub(v);
  return {
    method: prepared.method as ForgeHttpDraft["method"],
    url: scrub(prepared.url.toString()),
    headers,
    body: prepared.body ? scrub(prepared.body.toString("utf8")) : null,
    contentType: prepared.contentType,
    secret: prepared.secret
      ? { name: prepared.secret.name, host: prepared.url.hostname, placement: prepared.secret.placement }
      : null,
    expiresAt: new Date(now + HTTP_CONFIRM_TTL_MS).toISOString(),
  };
}

function draftRow(ctx: ForgeHttpContext, draft: ForgeHttpDraft, error: string): ForgeHttpRecord {
  return {
    ...baseRow(ctx, draft.method, draft.url, draft.secret?.name ?? null),
    finalUrl: null,
    status: null,
    contentType: null,
    bytes: null,
    durationMs: 0,
    ok: false,
    error,
  };
}

export async function confirmHttp(
  ctx: ForgeHttpContext,
  draft: ForgeHttpDraft,
  deps: ForgeHttpDeps,
): Promise<{ outcome: "done" | "failed" | "expired"; message: string; response?: ForgeHttpResponse }> {
  if (deps.now() > Date.parse(draft.expiresAt)) {
    await writeRow(deps, draftRow(ctx, draft, "expired: not confirmed within 30 minutes; nothing was sent"));
    return {
      outcome: "expired",
      message: "This request expired before it was confirmed (30 minutes), so nothing was sent. Ask Forge again.",
    };
  }
  try {
    const prepared = await prepareHttp(
      ctx,
      {
        method: draft.method,
        url: draft.url,
        ...(Object.keys(draft.headers).length ? { headers: draft.headers } : {}),
        ...(draft.body !== null ? { body: draft.body } : {}),
        ...(draft.secret ? { secret: draft.secret.name } : {}),
      },
      deps,
    );
    const response = await executeHttp(ctx, prepared, deps);
    const detail = response.text ?? (response.data !== undefined ? JSON.stringify(response.data) : "");
    return {
      outcome: "done",
      message: `HTTP ${response.status} ${response.statusText}\n${detail.slice(0, 2000)}`,
      response,
    };
  } catch (e) {
    if (e instanceof ForgeHttpError && e.statusCode !== 429) return { outcome: "failed", message: e.message };
    throw e;
  }
}

export async function cancelHttp(
  ctx: ForgeHttpContext,
  draft: ForgeHttpDraft,
  by: { label: string },
  deps: ForgeHttpDeps,
): Promise<void> {
  await writeRow(deps, draftRow(ctx, draft, `cancelled: ${by.label} pressed Cancel; nothing was sent`));
}

export const guardedTransport: HttpTransport = async ({ url, method, headers, body, signal, maxBytes }) => {
  await checkLiteral(url);
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const sendHeaders: Record<string, string> = {
      ...headers,
      "user-agent": "Tether-forge-http/1.0",
      "accept-encoding": "gzip, deflate, br",
    };
    if (body) sendHeaders["content-length"] = String(body.length);
    const req = mod.request(url, { method, lookup: guardedLookup as never, signal, headers: sendHeaders }, (res) => {
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const stream =
        enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated,
        });
      stream.on("data", (c: Buffer) => {
        if (truncated) return;
        if (size + c.length > maxBytes) {
          chunks.push(c.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          res.destroy();
          done();
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      stream.on("end", done);
      stream.on("error", (e) => (truncated ? undefined : reject(e)));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};
