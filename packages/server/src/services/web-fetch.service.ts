/**
 * `web_fetch` — read one public web address (2026-10-30, plans/builtin-tools-2026-10-30).
 *
 * A workflow step has no network (it runs on `flow-runner`, internal network only), so reading the web is a built-in
 * tool like `foundry_email_send`: a `tools` row in every workspace pointing at `POST /api/web/fetch` on this server,
 * and the same service behind Forge's build-time fetch (`/api/forge/fetch`). One implementation, one set of rules.
 *
 * The rules, all here:
 *  - the workspace's `web_access` must be on (its admins may switch it off);
 *  - http(s) only, GET or HEAD, no cookies, no credentials, no request body;
 *  - ⚠ the address is checked WHEN THE CONNECTION IS OPENED: the request's own DNS lookup is the guarded one, so the
 *    address classified is the address dialled (this closes the rebinding window `guardedFetch` only narrows). An IP
 *    literal is checked before dialling, since Node does not look one up. Every redirect hop goes through the same;
 *  - private, internal, loopback, link-local (cloud metadata), CGNAT, ULA, multicast and unresolvable are refused
 *    (`STRICT`), whatever the setting says;
 *  - a time limit, a size cap (what is read beyond it is dropped and `truncated` says so), and only readable types;
 *  - a site that answers an error status fails the call (a step that read nothing must not look like one that read);
 *  - every call is a `web_fetches` row, refusals included.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import zlib from "node:zlib";
import { eq } from "drizzle-orm";
import { classifyHost, STRICT } from "@foundry/shared";
import { db } from "../db/index.js";
import { webFetches, workspaces } from "../db/schema.js";
import { htmlTitle, htmlToMarkdown } from "./html-markdown.js";

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type WebFetchResult = {
  url: string;
  final_url: string;
  status: number;
  content_type: string;
  bytes: number;
  /** True when the page was bigger than the cap and the rest was not read. */
  truncated: boolean;
  /** An HTML page's title. */
  title?: string | null;
  /** The page as text: Markdown for HTML (unless `raw`), the body itself for everything else. Absent for HEAD. */
  text?: string;
  /** A JSON response, parsed. */
  data?: unknown;
};

export type WebFetchWho = { executionId?: string | null; stepId?: string | null; sessionId?: string | null; actor?: string | null };

export class WebFetchError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

const REASON: Record<string, string> = {
  loopback: "a loopback address",
  "link-local": "a link-local address (this is where cloud metadata lives)",
  rfc1918: "a private network address",
  "unspecified-or-broadcast": "not a real destination",
  multicast: "a multicast address",
  unresolvable: "a name that does not resolve",
};

const refused = (host: string, reason: string | null) =>
  new WebFetchError(
    403,
    "address_refused",
    `web_fetch reads public web addresses only, and ${host} is ${REASON[reason ?? ""] ?? "not a public address"}.`,
  );

/**
 * The request's DNS lookup, guarded: every address the name resolves to must be public, and the one dialled is one of
 * those. Used as `lookup` on the request, so it runs at connection time for this very socket.
 */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
    if (err || !addrs?.length) return cb(refused(hostname, "unresolvable"));
    void (async () => {
      for (const a of addrs) {
        const d = await classifyHost(a.address, STRICT);
        if (!d.allowed) return cb(refused(hostname, d.reason));
      }
      if (options.all) cb(null, addrs);
      else cb(null, addrs[0]!.address, addrs[0]!.family);
    })().catch((e) => cb(e as Error));
  });
}

const READABLE = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|[a-z.+-]*\+json|[a-z.+-]*\+xml|javascript|x-javascript|csv)\b)/i;

/** Credential-shaped query values are not stored in the record (the address itself is). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (/(key|token|secret|password|passwd|pwd|auth|sig|signature|session|credential)/i.test(k)) u.searchParams.set(k, "[redacted]");
    }
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return raw.slice(0, 2000);
  }
}

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

function once(url: URL, method: "GET" | "HEAD", signal: AbortSignal): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method,
        lookup: guardedLookup as never,
        signal,
        headers: {
          "user-agent": "Foundry-web_fetch/1.0",
          accept: "text/html,application/xhtml+xml,application/json,application/xml,application/rss+xml,application/atom+xml,text/*;q=0.9,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          if (size + c.length > WEB_FETCH_MAX_BYTES) {
            chunks.push(c.subarray(0, WEB_FETCH_MAX_BYTES - size));
            size = WEB_FETCH_MAX_BYTES;
            truncated = true;
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        stream.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        stream.on("error", (e) => (truncated ? undefined : reject(e)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function checkLiteral(url: URL): Promise<void> {
  const d = await classifyHost(url.hostname, STRICT);
  // A name is checked again, for real, by the guarded lookup at connection time; this refuses literals and names that
  // already resolve somewhere private, before anything is dialled.
  if (!d.allowed) throw refused(url.hostname, d.reason);
}

function parseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new WebFetchError(400, "bad_url", `"${raw.slice(0, 200)}" is not a web address. Give the full address, starting with https://.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new WebFetchError(400, "bad_url", `web_fetch reads http and https addresses only, not ${u.protocol}`);
  if (u.username || u.password) throw new WebFetchError(400, "bad_url", "web_fetch does not sign in: remove the user name and password from the address.");
  return u;
}

function decode(body: Buffer, contentType: string): string {
  const cs = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "") ?? "utf-8";
  try {
    return new TextDecoder(cs).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Fetch without the workspace check or the record. Exported for tests; everything in the product calls `webFetch`. */
export async function fetchPublic(raw: string, opts: { method?: "GET" | "HEAD"; raw?: boolean } = {}): Promise<WebFetchResult> {
  const method = opts.method ?? "GET";
  const start = parseUrl(raw);
  const signal = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  let url = start;
  let res: Raw | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkLiteral(url);
    try {
      res = await once(url, method, signal);
    } catch (e) {
      if (e instanceof WebFetchError) throw e;
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
        throw new WebFetchError(504, "timeout", `${url.hostname} did not answer within ${WEB_FETCH_TIMEOUT_MS / 1000} seconds.`);
      }
      throw new WebFetchError(502, "unreachable", `${url.hostname} could not be reached: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === MAX_REDIRECTS) throw new WebFetchError(502, "too_many_redirects", `${start.hostname} redirected more than ${MAX_REDIRECTS} times.`);
      url = parseUrl(new URL(String(res.headers.location), url).toString());
      continue;
    }
    break;
  }
  const r = res!;
  if (r.status < 200 || r.status >= 300) {
    throw new WebFetchError(502, "site_error", `${url.hostname} answered HTTP ${r.status}, so nothing was read.`);
  }
  const contentType = String(r.headers["content-type"] ?? "");
  const out: WebFetchResult = { url: start.toString(), final_url: url.toString(), status: r.status, content_type: contentType, bytes: r.body.length, truncated: r.truncated };
  if (method === "HEAD") return out;
  if (contentType && !READABLE.test(contentType)) {
    throw new WebFetchError(415, "not_readable", `${url.hostname} returned ${contentType.split(";")[0]}, which web_fetch does not read. It reads web pages, JSON, XML and RSS feeds, and plain text.`);
  }
  const text = decode(r.body, contentType);
  if (/json/i.test(contentType) && !r.truncated) {
    try {
      out.data = JSON.parse(text);
      return out;
    } catch {
      /* not JSON after all: hand it back as text */
    }
  }
  if (/html/i.test(contentType) || (!contentType && /^\s*<(!doctype html|html)\b/i.test(text))) {
    out.title = htmlTitle(text);
    out.text = opts.raw ? text : htmlToMarkdown(text, url.toString());
    return out;
  }
  out.text = text;
  return out;
}

/**
 * Fetch for a workspace: its `web_access` must be on, and the call is recorded — workflow step or Forge, success or
 * refusal.
 */
export async function webFetch(
  workspaceId: string,
  url: string,
  who: WebFetchWho,
  opts: { method?: "GET" | "HEAD"; raw?: boolean } = {},
): Promise<WebFetchResult> {
  const began = Date.now();
  const record = (r: { ok: boolean; result?: WebFetchResult; error?: string }) =>
    db
      .insert(webFetches)
      .values({
        workspaceId,
        executionId: who.executionId ?? null,
        stepId: who.stepId?.slice(0, 255) ?? null,
        sessionId: who.sessionId?.slice(0, 64) ?? null,
        actor: who.actor?.slice(0, 255) ?? null,
        url: redactUrl(url),
        finalUrl: r.result ? redactUrl(r.result.final_url) : null,
        status: r.result?.status ?? null,
        contentType: r.result?.content_type?.slice(0, 255) ?? null,
        bytes: r.result?.bytes ?? null,
        durationMs: Date.now() - began,
        ok: r.ok,
        error: r.error?.slice(0, 2000) ?? null,
      })
      .catch((e) => console.warn(`[web_fetch] could not record a fetch: ${(e as Error).message}`));

  const [ws] = await db.select({ webAccess: workspaces.webAccess }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws?.webAccess) {
    const e = new WebFetchError(403, "web_access_off", "Web access is switched off for this workspace. Its admins can switch it on in the workspace's settings.");
    await record({ ok: false, error: e.message });
    throw e;
  }
  try {
    const result = await fetchPublic(url, opts);
    await record({ ok: true, result });
    return result;
  } catch (e) {
    await record({ ok: false, error: (e as Error).message });
    throw e;
  }
}
