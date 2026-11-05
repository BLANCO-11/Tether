/**
 * Microsoft Graph `sendMail` — the transport, and the ONLY reader of the mail credential.
 * email-send-tool · US1, US4 · plan.md Decision 1, 2
 *
 * ── What this module is, and what it deliberately is not ─────────────────────
 *
 * It turns a resolved message into an HTTP call to Microsoft and reports what
 * came back. It decides **nothing** about who may receive an email — that is
 * `mail-recipients.ts`, and the separation is the whole design: Graph delivers to
 * whatever the body names, so if recipient policy lived anywhere near here it
 * would be one refactor away from being bypassable.
 *
 * By the time `send()` is called, the recipient list has already passed the
 * allowlist. This module trusts it and does not re-check — a second, weaker copy
 * of the rule is worse than one strong one, because the two eventually disagree.
 *
 * ── ⚠ The one read site for `config.mail.clientSecret` ──────────────────────
 *
 * `mail-secret-single-reader.test.ts` fails the suite if any other module under
 * `src/` reads it. That is not tidiness: a second read site is a second place a
 * credential can be logged, echoed into an error, or forgotten during a rotation.
 * It is also what makes moving off `.env` to Key Vault a one-file change (the
 * `.env` sourcing here is a deliberate, temporary deviation from
 * `FOUNDRY_SECRET_SOURCE` — see the config block's docblock).
 *
 * ── ⚠ Why `resolveOAuth2Bearer` could not be reused ─────────────────────────
 *
 * Foundry already has a client-credentials exchange in
 * `step-execution.service.ts`, and a tool registered with
 * `authStyle: "oauth2_client_credentials"` looks like it would work. It cannot:
 * that exchange sends `grant_type`/`client_id`/`client_secret` and **no `scope`**,
 * and Graph's client-credentials grant requires
 * `scope=https://graph.microsoft.com/.default`. So the token would be refused
 * before the recipient-policy problem even came up. Two independent reasons, one
 * conclusion.
 *
 * ── Everything is a return value; nothing here throws for a provider problem ──
 *
 * `send()` returns a discriminated union. A refusal is data with a status on it,
 * because the caller must record the attempt in `email_sends` before answering —
 * and an exception thrown past the recorder is how a real send ends up with no
 * evidence that it happened.
 */
import { z } from "zod";
import { guardedFetch, STRICT } from "@foundry/shared";
import { config } from "../config/index.js";

/** Graph's client-credentials scope. Not configurable — it is `.default` or the grant fails. */
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/** Subtracted from the provider's `expires_in` so a token is never used in its final seconds. */
const TOKEN_SAFETY_MARGIN_MS = 30_000;
/** Ceiling on how long a token is cached, however long the provider says it lives. */
const TOKEN_TTL_CAP_MS = 300_000;

/**
 * ⚠ **One retry, not a backoff loop, and a hard cap on the wait.**
 *
 * This runs inside a step, which is inside a request, which has a timeout. A
 * provider is entitled to answer `Retry-After: 3600`; a request handler is not
 * entitled to wait an hour, and a long retry chain turns a throttle into a hung
 * flow that reports nothing. Two attempts total, then a 502 the caller can see.
 */
const RETRY_MAX_WAIT_MS = 20_000;
const RETRY_DEFAULT_WAIT_MS = 2_000;

export type MailSendResult =
  | { ok: true; messageId: string | null; requestId: string | null }
  | { ok: false; status: 409 | 413 | 424 | 502; message: string; detail: Record<string, unknown> };

export type MailMessage = {
  subject: string;
  body: string;
  /**
   * How Graph should interpret `body`.
   *
   * ⚠ **`HTML` is only ever legitimate for markup this server generated.** The
   * one producer is `services/mail-report.ts`, which escapes every value that
   * crosses into its output — the tags are its own string literals and nothing
   * else. Passing a caller's string through with `contentType: "HTML"` would
   * hand an upstream data source the ability to render a live link or a spoofed
   * sender block in a recipient's client, which is the exact risk spec.md's Edge
   * Cases named.
   *
   * Defaults to `Text`, so a caller that does not think about this gets the safe
   * answer.
   */
  contentType?: "Text" | "HTML";
  /** Already resolved and allowlisted by `mail-recipients.ts`. Not re-checked here. */
  to: readonly string[];
  cc?: readonly string[];
  /**
   * Already checked by `mail-attachments.ts` — name, extension-derived content
   * type, size, and the bytes themselves. `data` is what Graph's `contentBytes`
   * is built from: the server produced these bytes in every case (text encoded
   * UTF-8, or a generated `.xlsx`), never the caller.
   */
  attachments?: ReadonlyArray<{ name: string; contentType: string; data: Buffer }>;
};

type TokenCacheEntry = { token: string; expiresAt: number };

/**
 * Process-global, mirroring `oauth2TokenCache` in `step-execution.service.ts`
 * rather than inventing a second idiom for the same job. One key, because there
 * is one deployment-level credential — unlike the tool path, this is not
 * per-workspace.
 */
const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_CACHE_KEY = "graph:mail:v1";

/**
 * Test seam — the cache lives for the life of the process, so a suite that
 * exercises the exchange must be able to start from a cold cache. Same seam
 * `resetOAuth2TokenCache` provides, for the same reason.
 */
export function resetMailTokenCache(): void {
  tokenCache.clear();
}

/** RFC 6749 §5.1 / §5.2 — parsed rather than trusted, because it is external input. */
const tokenResponseSchema = z
  .object({
    access_token: z.string().optional(),
    expires_in: z.number().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

/** Graph's error envelope. Only the code and a truncated message are ever surfaced. */
const graphErrorSchema = z
  .object({
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const fail = (
  status: 409 | 413 | 424 | 502,
  message: string,
  detail: Record<string, unknown> = {},
): MailSendResult => ({ ok: false, status, message, detail });

/**
 * The correlation id from Graph's response headers.
 *
 * ⚠ **Not an RFC 5322 Message-ID.** `sendMail` answers `202 Accepted` with an
 * EMPTY body — there is no provider-side message id in existence at that point.
 * What comes back is a request correlation id, which is the thing a Microsoft
 * support case is actually opened against. Anyone reading `message_id` in the
 * response and expecting to find it in a mail header will not.
 */
function correlationId(res: Response): string | null {
  return res.headers.get("request-id") ?? res.headers.get("client-request-id") ?? null;
}

/**
 * Acquire an app-only access token, from cache when it is still comfortably valid.
 *
 * TTL = `min(expires_in − 30s, 300s)`. A provider answering an expiry inside the
 * safety margin yields a negative TTL, so the entry is already stale and every
 * call re-exchanges — the safe failure mode (never present a token we suspect is
 * dying) rather than something to clamp away.
 */
async function acquireToken(): Promise<{ ok: true; token: string } | MailSendResult> {
  const cached = tokenCache.get(TOKEN_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, token: cached.token };

  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.mail.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.mail.clientId,
    // ⚠ The only read of the Graph client secret in the entire server.
    client_secret: config.mail.clientSecret,
    // ⚠ Required by Graph. Its absence is why `resolveOAuth2Bearer` is not reused.
    scope: GRAPH_SCOPE,
  });

  let res: Response;
  try {
    res = await guardedFetch(
      url,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      STRICT,
    );
  } catch (e) {
    // The message from a transport throw is a hostname and an errno — safe. The
    // request body, which carries the client secret, is never referenced here.
    return fail(502, "could not reach the Microsoft token endpoint", {
      reason: (e as Error).message.slice(0, 300),
    });
  }

  let parsed: z.infer<typeof tokenResponseSchema>;
  try {
    parsed = tokenResponseSchema.parse(await res.json());
  } catch {
    parsed = {};
  }

  if (!res.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    /**
     * ⚠ `detail` carries only the RFC 6749 error fields, truncated — never the
     * request body. Copied from `resolveOAuth2Bearer`'s detail-narrowing comment,
     * which exists because a broken provider echo could otherwise put a client
     * secret into a log line.
     */
    const detail: Record<string, unknown> = { status: res.status };
    if (typeof parsed.error === "string") detail.graphError = parsed.error.slice(0, 200);
    if (typeof parsed.error_description === "string") {
      detail.errorDescription = parsed.error_description.slice(0, 500);
    }
    const requestId = correlationId(res);
    if (requestId) detail.requestId = requestId;
    return fail(502, `Microsoft token exchange failed (HTTP ${res.status})`, detail);
  }

  const expiresInMs =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in * 1000
      : TOKEN_TTL_CAP_MS;
  const ttl = Math.min(expiresInMs - TOKEN_SAFETY_MARGIN_MS, TOKEN_TTL_CAP_MS);
  tokenCache.set(TOKEN_CACHE_KEY, { token: parsed.access_token, expiresAt: Date.now() + ttl });

  return { ok: true, token: parsed.access_token };
}

/** `Retry-After` in seconds, clamped to something a request handler may actually wait. */
function retryAfterMs(res: Response): number {
  const raw = Number(res.headers.get("retry-after"));
  const requested = Number.isFinite(raw) && raw > 0 ? raw * 1000 : RETRY_DEFAULT_WAIT_MS;
  return Math.min(requested, RETRY_MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Percent-encode a UPN for a URL path segment, but leave `@` literal.
 *
 * ⚠ Both halves matter. `encodeURIComponent` alone escapes the `@` to `%40`,
 * producing `users/automation%40example.com/sendMail` — which Graph does accept,
 * but is not the form Microsoft documents, and betting a real send on an
 * equivalence nobody verified is exactly the kind of assumption this feature is
 * written against. Dropping the encoding altogether is worse: `senderUpn` is
 * operator-supplied configuration, and a value containing `/` or `?` would then
 * rewrite the request path.
 *
 * So: encode everything, then restore the one character a UPN legitimately
 * contains and RFC 3986 permits unencoded in a path segment.
 */
const upnPathSegment = (upn: string): string => encodeURIComponent(upn).replace(/%40/g, "@");

const graphUser = () => `https://graph.microsoft.com/v1.0/users/${upnPathSegment(config.mail.senderUpn)}`;

/** The message as Graph takes it, without attachments when `withAttachments` is false (the draft path adds them). */
function graphMessage(message: MailMessage, withAttachments: boolean) {
  const recipient = (address: string) => ({ emailAddress: { address } });
  return {
      subject: message.subject,
      body: {
        /**
         * ⚠ **`Text` remains the default, and the reason has not changed.** The
         * body is a script's output, which may contain content from a database, a
         * web page or a document that nobody vetted; plain text is what stops
         * injected markup rendering as a live link or a spoofed sender block in
         * the recipient's client (spec.md Edge Cases).
         *
         * `HTML` is permitted for ONE producer — `services/mail-report.ts` — and
         * the safety argument survives only because that module escapes every
         * value it interpolates. See the `contentType` docblock on `MailMessage`.
         * A caller passing `HTML` around it has defeated the control.
         */
        contentType: message.contentType ?? "Text",
        content: message.body,
      },
      toRecipients: message.to.map(recipient),
      ...(message.cc && message.cc.length > 0 ? { ccRecipients: message.cc.map(recipient) } : {}),
      ...(withAttachments && message.attachments && message.attachments.length > 0
        ? {
            // Inline `fileAttachment`s — Graph's `sendMail` takes these up to its
            // 4 MB request limit, which the route's caps keep us under.
            attachments: message.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.name,
              contentType: a.contentType,
              contentBytes: a.data.toString("base64"),
            })),
          }
        : {}),
  };
}

async function postSendMail(token: string, message: MailMessage): Promise<Response> {
  const url = `${graphUser()}/sendMail`;
  const payload = {
    message: graphMessage(message, true),
    /** The sender's Sent Items is the operator's independent record of what left. */
    saveToSentItems: true,
  };

  return guardedFetch(
    url,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    STRICT,
  );
}

/**
 * ── Large messages: draft, upload, send (2026-10-12) ──────────────────────────
 *
 * `sendMail` takes the whole message in ONE request, and Graph caps that at 4 MB — so a report past ~3 MB of files
 * could not be sent at all. Past `INLINE_MAX_BYTES` the message is saved as a DRAFT in the sender's mailbox, each
 * file under 3 MB is added to it directly, each larger one goes up through an upload session in pieces, and then the
 * draft is sent. Needs `Mail.ReadWrite` beside `Mail.Send` (granted on this deployment's app registration).
 *
 * ⚠ A half-built draft is deleted on any failure, so a refused send leaves nothing behind in the sender's Drafts.
 * ⚠ The tenant's own message size limit (Exchange's MaxSendSize, 35 MB by default) is not readable from Graph, so it
 * is met at send time: `ErrorMessageSizeExceeded` comes back as a 413 with a plain sentence, never a generic 502.
 */
const INLINE_MAX_BYTES = 3_500_000;
const FILE_INLINE_MAX = 3 * 1024 * 1024;
/** Upload pieces must be a multiple of 320 KiB; 12 × 320 KiB = 3.75 MiB. */
const UPLOAD_CHUNK = 12 * 320 * 1024;

/** Bytes `sendMail` would carry: the body plus every file as base64. */
export function inlineBytes(message: MailMessage): number {
  return (
    Buffer.byteLength(message.body, "utf8") +
    (message.attachments ?? []).reduce((n, a) => n + Math.ceil(a.data.byteLength / 3) * 4, 0)
  );
}

const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function graphCall(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  const go = () =>
    guardedFetch(
      url,
      {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      STRICT,
    );
  let res = await go();
  if (res.status === 429) {
    await sleep(retryAfterMs(res));
    res = await go();
  }
  return res;
}

/** A Graph refusal, narrowed to status + Graph's code + correlation id (never a body or a credential). */
async function graphFailure(res: Response, what: string, totalBytes: number): Promise<MailSendResult> {
  let graphError: string | undefined;
  let graphMessage: string | undefined;
  try {
    const parsed = graphErrorSchema.parse(await res.json());
    graphError = parsed.error?.code?.slice(0, 200);
    graphMessage = parsed.error?.message?.slice(0, 500);
  } catch {
    // An empty or non-JSON error body is normal for some statuses.
  }
  const detail: Record<string, unknown> = { status: res.status, step: what };
  if (graphError) detail.graphError = graphError;
  if (graphMessage) detail.graphMessage = graphMessage;
  const requestId = correlationId(res);
  if (requestId) detail.requestId = requestId;
  if (res.status === 413 || /MessageSizeExceeded|MessageTooBig|SizeExceeded/i.test(`${graphError} ${graphMessage}`)) {
    return fail(
      413,
      `your mail server refused an email this size (${megabytes(totalBytes)}). Its limit is set by your Microsoft 365 ` +
        `admin — send a summary or fewer rows, or ask for the limit to be raised`,
      detail,
    );
  }
  return fail(502, `Microsoft Graph refused the message while ${what} (HTTP ${res.status})`, detail);
}

async function uploadLargeFile(
  token: string,
  messageUrl: string,
  file: { name: string; contentType: string; data: Buffer },
  totalBytes: number,
): Promise<MailSendResult | null> {
  const session = await graphCall(token, "POST", `${messageUrl}/attachments/createUploadSession`, {
    AttachmentItem: { attachmentType: "file", name: file.name, size: file.data.byteLength, contentType: file.contentType },
  });
  if (!session.ok) return graphFailure(session, `preparing to upload ${file.name}`, totalBytes);
  const { uploadUrl } = (await session.json()) as { uploadUrl?: string };
  if (!uploadUrl) return fail(502, "Microsoft Graph gave no upload address", { file: file.name });
  const size = file.data.byteLength;
  for (let start = 0; start < size; start += UPLOAD_CHUNK) {
    const end = Math.min(size, start + UPLOAD_CHUNK) - 1;
    // ⚠ No Authorization header: the upload address carries its own credential, and Graph refuses a request that
    // presents both.
    const put = await guardedFetch(
      uploadUrl,
      {
        method: "PUT",
        headers: { "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
        body: file.data.subarray(start, end + 1),
      },
      STRICT,
    );
    if (put.status !== 200 && put.status !== 201) return graphFailure(put, `uploading ${file.name}`, totalBytes);
  }
  return null;
}

async function sendLarge(token: string, message: MailMessage): Promise<MailSendResult> {
  const totalBytes = (message.attachments ?? []).reduce((n, a) => n + a.data.byteLength, 0);
  const draft = await graphCall(token, "POST", `${graphUser()}/messages`, graphMessage(message, false));
  if (draft.status !== 201) return graphFailure(draft, "saving the draft", totalBytes);
  const { id } = (await draft.json()) as { id?: string };
  if (!id) return fail(502, "Microsoft Graph saved the draft without an id", {});
  const messageUrl = `${graphUser()}/messages/${encodeURIComponent(id)}`;
  const discard = () => graphCall(token, "DELETE", messageUrl).catch(() => undefined);

  for (const a of message.attachments ?? []) {
    if (a.data.byteLength < FILE_INLINE_MAX) {
      const added = await graphCall(token, "POST", `${messageUrl}/attachments`, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.data.toString("base64"),
      });
      if (added.status !== 201) {
        const failed = await graphFailure(added, `attaching ${a.name}`, totalBytes);
        await discard();
        return failed;
      }
    } else {
      const failed = await uploadLargeFile(token, messageUrl, a, totalBytes);
      if (failed) {
        await discard();
        return failed;
      }
    }
  }

  const sent = await graphCall(token, "POST", `${messageUrl}/send`);
  if (sent.status !== 202) {
    const failed = await graphFailure(sent, "sending", totalBytes);
    await discard();
    return failed;
  }
  return { ok: true, messageId: correlationId(sent) ?? id, requestId: correlationId(sent) };
}

export const mailService = {
  /**
   * Send one message. Returns a result; never throws for a provider problem, so
   * the caller can record the attempt before answering.
   *
   * ⚠ Order matters. Disabled is checked **before** unconfigured: telling an
   * operator who switched delivery off to go and add four variables they already
   * have is a refusal that costs more than saying nothing.
   */
  async send(message: MailMessage): Promise<MailSendResult> {
    if (!config.mail.enabled) {
      return fail(409, "email delivery is switched off for this deployment (MAIL_ENABLED)", {
        remedy: "unset MAIL_ENABLED, or set it to anything other than `false`",
      });
    }

    if (!config.mail.configured) {
      // Every missing variable at once (FR-008). Naming the first one sends an
      // operator round the loop once per variable.
      return fail(424, "email delivery is not configured on this deployment", {
        missing: config.mail.missing,
        remedy: "set the named variables in .env and restart the server",
      });
    }

    const token = await acquireToken();
    if (!("token" in token)) return token;

    if (inlineBytes(message) > INLINE_MAX_BYTES) {
      try {
        return await sendLarge(token.token, message);
      } catch (e) {
        return fail(502, "could not reach Microsoft Graph", { reason: (e as Error).message.slice(0, 300) });
      }
    }

    let res: Response;
    try {
      res = await postSendMail(token.token, message);
      if (res.status === 429) {
        // One retry, honouring (a capped) Retry-After. See RETRY_MAX_WAIT_MS.
        await sleep(retryAfterMs(res));
        res = await postSendMail(token.token, message);
      }
    } catch (e) {
      return fail(502, "could not reach Microsoft Graph", {
        reason: (e as Error).message.slice(0, 300),
      });
    }

    /**
     * ⚠ **`202` and only `202`.** Graph answers `sendMail` with `202 Accepted`
     * and an empty body. A `200` means something else answered — a proxy, a
     * captive portal, a misrouted base URL — and accepting it would report a send
     * that never happened. That is the false-green this whole feature is written
     * against, so the check is an equality, not `res.ok`.
     */
    if (res.status === 202) {
      const id = correlationId(res);
      return { ok: true, messageId: id, requestId: id };
    }

    let graphError: string | undefined;
    let graphMessage: string | undefined;
    try {
      const parsed = graphErrorSchema.parse(await res.json());
      graphError = parsed.error?.code?.slice(0, 200);
      graphMessage = parsed.error?.message?.slice(0, 500);
    } catch {
      // An empty or non-JSON error body is normal for some statuses. The status
      // and correlation id are what a support case needs anyway.
    }

    const detail: Record<string, unknown> = { status: res.status };
    if (graphError) detail.graphError = graphError;
    if (graphMessage) detail.graphMessage = graphMessage;
    const requestId = correlationId(res);
    if (requestId) detail.requestId = requestId;

    /**
     * ⚠ The detail never carries the message body or the credential — only the
     * status, Graph's own error code, and the correlation id. `403` is the failure
     * to expect in practice: a perfectly valid credential with no admin consent on
     * the `Mail.Send` application permission, or no Exchange application access
     * policy for this mailbox. Neither is visible from Foundry's side, which is
     * why Graph's code has to survive into the response.
     */
    return fail(502, `Microsoft Graph refused the message (HTTP ${res.status})`, detail);
  },
};
