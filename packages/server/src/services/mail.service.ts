/**
 * SMTP transport (nodemailer) — and the ONLY reader of the mail credential.
 *
 * ── What this module is, and what it deliberately is not ─────────────────────
 *
 * It turns a resolved message into an SMTP submission and reports what came
 * back. It decides **nothing** about who may receive an email — that is
 * `mail-recipients.ts`, and the separation is the whole design: SMTP delivers to
 * whatever the envelope names, so if recipient policy lived anywhere near here it
 * would be one refactor away from being bypassable.
 *
 * By the time `send()` is called, the recipient list has already passed the
 * allowlist. This module trusts it and does not re-check.
 *
 * ── ⚠ The one read site for `config.mail.pass` ──────────────────────────────
 *
 * `mail-secret-single-reader.test.ts` fails the suite if any other module under
 * `src/` reads it: a second read site is a second place a credential can be
 * logged, echoed into an error, or forgotten during a rotation.
 *
 * ── Everything is a return value; nothing here throws for a provider problem ──
 *
 * `send()` returns a discriminated union. A refusal is data with a status on it,
 * because the caller must record the attempt in `email_sends` before answering.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config/index.js";

export type MailSendResult =
  | { ok: true; messageId: string | null; requestId: string | null }
  | { ok: false; status: 409 | 413 | 424 | 502; message: string; detail: Record<string, unknown> };

export type MailMessage = {
  subject: string;
  body: string;
  /**
   * How the recipient's client should interpret `body`.
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
   * type, size, and the bytes themselves. `data` is what is attached to the message: the server produced these bytes in every case (text encoded
   * UTF-8, or a generated `.xlsx`), never the caller.
   */
  attachments?: ReadonlyArray<{ name: string; contentType: string; data: Buffer }>;
};


/** Cached for the life of the process: one deployment-level SMTP account, built on first use. */
let transport: Transporter | null = null;

/** Test seam — drops the cached transport so a suite starts cold. */
export function resetMailTokenCache(): void {
  transport?.close?.();
  transport = null;
}

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      // ⚠ The only read of the SMTP password in the entire server.
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

const fail = (
  status: 409 | 413 | 424 | 502,
  message: string,
  detail: Record<string, unknown> = {},
): MailSendResult => ({ ok: false, status, message, detail });

const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export const mailService = {
  /**
   * Send one message. Returns a result; never throws for a provider problem, so
   * the caller can record the attempt before answering.
   *
   * ⚠ Order matters. Disabled is checked **before** unconfigured: telling an
   * operator who switched delivery off to go and add variables they already
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

    const html = message.contentType === "HTML";
    try {
      const info = await getTransport().sendMail({
        from: config.mail.from,
        to: [...message.to],
        ...(message.cc && message.cc.length > 0 ? { cc: [...message.cc] } : {}),
        subject: message.subject,
        // ⚠ `Text` stays the default; `HTML` is only for markup `mail-report.ts` generated and escaped.
        ...(html ? { html: message.body } : { text: message.body }),
        ...(message.attachments && message.attachments.length > 0
          ? {
              attachments: message.attachments.map((a) => ({
                filename: a.name,
                contentType: a.contentType,
                content: a.data,
              })),
            }
          : {}),
      });
      return { ok: true, messageId: info.messageId ?? null, requestId: null };
    } catch (e) {
      const err = e as { message?: string; code?: string; responseCode?: number };
      const reason = String(err.message ?? e).slice(0, 300);
      const detail: Record<string, unknown> = { reason };
      if (err.code) detail.code = String(err.code).slice(0, 100);
      if (err.responseCode) detail.responseCode = err.responseCode;
      const totalBytes = (message.attachments ?? []).reduce((n, a) => n + a.data.byteLength, 0);
      if (err.responseCode === 552 || /message size|size limit|too large|too big/i.test(reason)) {
        return fail(
          413,
          `your mail server refused an email this size (${megabytes(totalBytes)}). Its limit is set by the SMTP ` +
            `provider — send a summary or fewer rows, or ask for the limit to be raised`,
          detail,
        );
      }
      return fail(502, `the SMTP server refused or could not take the message: ${reason.slice(0, 120)}`, detail);
    }
  },
};

/**
 * System mail only (sign-in codes): one message to ONE address the server chose,
 * never to a caller-supplied list. It deliberately does not consult
 * MAIL_ALLOWED_RECIPIENT_DOMAINS or `mail-recipients.ts`, which govern mail that
 * users and agents ask for.
 */
export async function sendSystemMail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<MailSendResult> {
  if (!config.mail.enabled) {
    return fail(409, "email delivery is switched off for this deployment (MAIL_ENABLED)", {
      remedy: "unset MAIL_ENABLED, or set it to anything other than `false`",
    });
  }
  if (!config.mail.configured) {
    return fail(424, "email delivery is not configured on this deployment", {
      missing: config.mail.missing,
      remedy: "set the named variables in .env and restart the server",
    });
  }
  try {
    const info = await getTransport().sendMail({
      from: config.mail.from,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return { ok: true, messageId: info.messageId ?? null, requestId: null };
  } catch (e) {
    const reason = String((e as { message?: string }).message ?? e).slice(0, 300);
    return fail(502, `the SMTP server refused or could not take the message: ${reason.slice(0, 120)}`, { reason });
  }
}
