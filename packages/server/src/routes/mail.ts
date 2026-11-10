/**
 * `POST /api/mail/send` — REAL email delivery.
 * email-send-tool · US1–US4 · contracts/mail-send.md §2
 *
 * ── Why this endpoint exists at all ──────────────────────────────────────────
 *
 * The registered tool `tether_email_send` points **here**, not at
 * `graph.microsoft.com`. That is the load-bearing decision of the whole feature
 * (plan.md Decision 1): Graph delivers to whatever the request body names, so a
 * tool aimed straight at Microsoft would hand the model the destination. The
 * recipient policy has to run somewhere the model cannot reach, and this is that
 * place.
 *
 * ── What this route decides: nothing ─────────────────────────────────────────
 *
 * It resolves inputs, calls `resolveRecipients()`, records the attempt, and calls
 * the transport. Every judgement about who may receive an email is in
 * `services/mail-recipients.ts`, which is pure and exhaustively tested. If a rule
 * appears in this file, it is in the wrong place.
 *
 * ── ⚠ The order of operations is the control ─────────────────────────────────
 *
 *   caps check → policy check → RENDER → record intent → send → record outcome
 *
 * Rendering sits after the policy check and before the intent row on purpose. It
 * is the last thing that can refuse (a report can render larger than Graph will
 * carry), and putting a refusal *after* the row that says "we are about to send"
 * would leave an attempted-unknown record for a message that was never dialled.
 *
 * **No Graph call may happen before `resolveRecipients()` returns `ok`**, and
 * `routes/mail.test.ts` asserts zero transport calls on every refusal path
 * (SC-002). A route that decides correctly but dials first has already delivered
 * the message; the decision would then be documentation.
 *
 * The intent row is written **before** the send and completed after. A process
 * that dies mid-send therefore leaves "we may have sent something" rather than
 * silence — which is the state you want to wake up to, because it is
 * investigable.
 *
 * ── Where the requester comes from ───────────────────────────────────────────
 *
 * `x-foundry-run` is the `flowExecutionId` header `invokeTool` already sends on
 * every tool call (`step-execution.service.ts:446`) — nothing new had to be
 * plumbed through the executor. The requester is read **off the `flow_executions`
 * row**, not joined from `flow_run_requests` (plan.md Decision 3): the row carries
 * a copy taken at `begin`, and that copy is the fact. The workspace comes from the
 * same row and **never from the request body** (FR-010) — a body-supplied
 * workspace would let one tenant's step name another's.
 */
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.middleware.js";
import { db } from "../db/index.js";
import { flowExecutions, flows, platformUsers } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { emailSendRepo } from "../repositories/email-send.repo.js";
import { config } from "../config/index.js";
import { mailService } from "../services/mail.service.js";
import {
  checkMessageCaps,
  resolveRecipients,
  resolveRequester,
  type MailCaps,
} from "../services/mail-recipients.js";
import { renderReport } from "../services/mail-report.js";
import {
  attachmentMeta,
  checkAttachments,
  foldFlatAttachment,
  promoteOversizedBody,
  type MailAttachment,
} from "../services/mail-attachments.js";
import { envForExecution } from "../services/execution-env.service.js";
import { stepFileRepo } from "../repositories/step-file.repo.js";
import { emailHeldFileRepo } from "../repositories/email-held-file.repo.js";

export const mailRouter = Router();

/**
 * ⚠ `.strict()` — an unknown field is a `400`, never a silent drop.
 *
 * A field accepted-and-ignored is the worst answer available: the caller
 * believes it did something, the recipient sees nothing, and nothing anywhere
 * says so — which is why `attachments` was REFUSED while it was out of scope
 * (spec.md). It is now a declared field, checked by `mail-attachments.ts`;
 * anything else unknown is still a 400.
 *
 * ⚠ `workspaceId` is deliberately **absent** from this schema rather than
 * accepted-and-ignored. FR-010 says the body's workspace must not be honoured;
 * refusing the field outright is a stronger statement of that than ignoring it,
 * and it tells a caller who sent one that they misunderstood.
 */
const sendSchema = z
  .object({
    subject: z.string(),
    /**
     * ⚠ **A non-string `body` is JSON-encoded rather than refused, and the reason
     * is that the string is the TRANSPORT, not the intent.**
     *
     * `renderReport` already treats a string that looks like JSON as structured
     * data — it parses it and renders real tables. So the two forms a flow can
     * produce differ only in whether the value crossed the wire quoted:
     *
     *   body: "[{\"employee\":\"A. Sharma\"}]"   → structured, tables
     *   body: [{ employee: "A. Sharma" }]        → 400, "Expected string, received array"
     *
     * The second is what a `datasource`/`code` step naturally yields, and it is
     * exactly the I-42 trap in a new place: a Pebble expression that emits rows
     * emits an array, and the encode-it-first form (`| jq('… | @json')`, I-43) is
     * a step the drafter has been observed to miss. Refusing it means a call that
     * carried the right data dies at the last hop for a quoting reason, and the
     * remedy is invisible from the message.
     *
     * ⚠ **This is a widening, and it must not be read as accepting caller markup.**
     * The encoded value goes through the same `renderReport` path as any other
     * string, so every value is still escaped by `mail-report.ts`. What changes is
     * only whether the caller had to quote it.
     *
     * ⚠ **`paramsSchema` in `platform-tool-catalogue.ts` is deliberately NOT
     * changed to say `string | array`.** `refFingerprints()` hashes it whole, so
     * editing that description or type suspends every armed flow using this tool.
     * The tool still ASKS for a string — this route simply stops failing the calls
     * that arrive one encode short of it.
     */
    body: z.preprocess(
      (v) => (v === null || v === undefined || typeof v === "string" ? v : JSON.stringify(v)),
      z.string(),
    ),
    /**
     * ONE address is accepted where the list is (phase 3 step 3). A typed
     * binding renders what it reads — a literal or a per-row `.email` is a
     * string — and every such call died "to: Expected array, received string"
     * (build:measure F1, 2026-09-23). Same bargain as `body` above: the tool's
     * `paramsSchema` is NOT changed (it is in the ref fingerprint), the route
     * stops failing the call that arrives one wrap short. Every address still
     * goes through `resolveRecipients` exactly as before.
     */
    to: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string())).optional(),
    cc: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string())).optional(),
    /**
     * Files to attach — either the file's TEXT (`{name, content}`, a CSV a
     * `code` step built) or structured ROWS to generate one from
     * (`{name, format, rows}` → `.csv` or a binary `.xlsx`, built by
     * `file-builder.ts`). Checked by `mail-attachments.ts`: allowlisted
     * extensions, a derived content type, a size cap, refused rather than
     * truncated. `.strict()` on each item for the reason it is on the body: a
     * `contentType` or `contentBytes` supplied by a caller is refused, not ignored.
     */
    attachments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            content: z.string().optional(),
            format: z.enum(["csv", "xlsx"]).optional(),
            rows: z.array(z.record(z.unknown())).optional(),
            /** A file this run's step saved (`POST /api/steps/files`) — how a large report travels. */
            file: z.string().max(64).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * The FLAT attachment — a step's rows, a name and a format, which the step engine can bind where it
     * cannot build `attachments`' records. Folded into one generated file by `foldFlatAttachment`.
     */
    attach_rows: z.union([z.array(z.record(z.unknown())), z.string()]).optional(),
    attach_name: z.string().max(120).optional(),
    attach_format: z.enum(["csv", "xlsx"]).optional(),
    /** Optional, informational: which step asked. Recorded, never trusted. */
    stepId: z.string().max(200).optional(),
  })
  .strict();

const caps = (): MailCaps => ({
  maxRecipients: config.mail.maxRecipients,
  maxBodyBytes: config.mail.maxBodyBytes,
});

/**
 * The execution named by `x-foundry-run`, or `null`.
 *
 * A malformed or unknown id resolves to `null` rather than throwing: from the
 * caller's point of view "this run does not exist" and "no run was named" lead to
 * the same place — no requester — and the 422 that follows says so. Throwing here
 * would turn a stale header into a 500.
 */
async function resolveExecution(runId: string | undefined) {
  if (!runId) return null;
  // A non-uuid would make Postgres throw on the comparison, so it is rejected
  // before the query rather than caught after it.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return null;

  const rows = await db
    .select({
      id: flowExecutions.id,
      workspaceId: flowExecutions.workspaceId,
      requestedBy: flowExecutions.requestedBy,
      requestedByKind: flowExecutions.requestedByKind,
      requestedBySubject: flowExecutions.requestedBySubject,
      flowId: flowExecutions.flowId,
    })
    .from(flowExecutions)
    .where(eq(flowExecutions.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The email of a workflow's owner, for a schedule run that has no requester of its
 * own. `flows.owner_subject` is a subject; `email:<addr>` subjects carry the address,
 * any other is looked up in `platform_users`. Null when there is no owner or no address.
 */
async function ownerEmailOf(flowId: string | null): Promise<string | null> {
  if (!flowId) return null;
  const f = await db.select({ owner: flows.ownerSubject }).from(flows).where(eq(flows.id, flowId)).limit(1);
  const subject = f[0]?.owner;
  if (!subject) return null;
  if (subject.startsWith("email:")) return subject.slice(6);
  const u = await db.select({ email: platformUsers.email }).from(platformUsers).where(eq(platformUsers.subject, subject)).limit(1);
  return u[0]?.email ?? null;
}

mailRouter.post(
  "/send",
  asyncHandler(async (req, res) => {
    const parsed = sendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid_body", detail: parsed.error.flatten() });
    }
    const input = parsed.data;

    const runId = req.header("x-foundry-run") ?? undefined;
    const execution = await resolveExecution(runId);

    /**
     * ⚠ No execution means no workspace, and `email_sends.workspace_id` is NOT
     * NULL — so this one refusal cannot be recorded. It is the only unrecorded
     * path, and it is the one where nothing tenant-specific was ever identified:
     * there is no workspace to record it against, and inventing one would be
     * worse than the gap. Everything downstream of here IS recorded.
     */
    if (!execution) {
      return res.status(422).json({
        error: "no_recipient",
        message:
          "no recipient: this call is not attached to a known run, so there is no person to send to",
        detail: {
          runKind: runId ? "unknown-run" : "no-run",
          remedy: "name a recipient in `to`, or call this from a flow step",
        },
      });
    }

    const workspace = await workspaceRepo.get(execution.workspaceId);
    const requester = resolveRequester({
      ...execution,
      ownerEmail:
        execution.requestedByKind === "schedule" && !execution.requestedBySubject
          ? await ownerEmailOf(execution.flowId)
          : null,
    });

    /** Record and answer in one place, so no refusal path can forget the row. */
    const refuse = async (
      status: number,
      error: string,
      message: string,
      detail: Record<string, unknown>,
      outcome: "refused" | "failed" = "refused",
    ) => {
      await emailSendRepo.record({
        workspaceId: execution.workspaceId,
        flowExecutionId: execution.id,
        stepId: input.stepId ?? null,
        recipients: [],
        cc: [],
        subject: input.subject.slice(0, 500),
        outcome,
        failureReason: `${message} ${JSON.stringify(detail)}`.slice(0, 2000),
      });
      return res.status(status).json({ error, message, detail });
    };

    // ── 0. Oversized tabular body → attachment (safety net) ─────────────────
    /**
     * A flow that binds the whole read into `body` (and often also `attach_rows`)
     * used to die on `MAIL_MAX_BODY_BYTES` before the xlsx path ran. When the
     * body is step output (rows / envelope JSON) over the cap, move it to an
     * attachment and leave a brief body. Long prose still refuses at caps.
     */
    const mailCaps = caps();
    const promoted = promoteOversizedBody({
      body: input.body,
      subject: input.subject,
      maxBodyBytes: mailCaps.maxBodyBytes,
      attach_rows: input.attach_rows,
      attach_name: input.attach_name,
      attach_format: input.attach_format,
    });
    if (promoted.promoted) {
      console.info(
        `[mail] body promoted to attachment: ${promoted.fromBytes} bytes → brief body` +
          (input.attach_rows !== undefined ? " (attach_rows already set)" : " (new xlsx)"),
      );
    }
    const bodyForSend = promoted.body;
    const attachRows = promoted.attach_rows;
    const attachName = promoted.attach_name;
    const attachFormat = promoted.attach_format;

    // ── 1. Caps, before anything else touches a recipient ────────────────────
    const capsResult = checkMessageCaps({
      subject: input.subject,
      body: bodyForSend,
      caps: mailCaps,
    });
    if (!capsResult.ok) {
      return refuse(capsResult.status, "message_rejected", capsResult.message, capsResult.detail);
    }

    // ── 1b. Attachments — checked with the caps, before any recipient work ───
    const folded = foldFlatAttachment(input.attachments, {
      attach_rows: attachRows,
      attach_name: attachName,
      attach_format: attachFormat,
      fallbackName: input.subject,
    });
    if (!folded.ok) {
      return refuse(folded.status, "message_rejected", folded.message, folded.detail);
    }
    // A saved file is read here, bound to THIS run and workspace — an id from another run reads as not found.
    const withFiles = await Promise.all(
      folded.attachments.map(async (a) =>
        a.file === undefined
          ? a
          : { ...a, fileData: (await stepFileRepo.read(execution.workspaceId, execution.id, a.file)) ?? undefined },
      ),
    );
    const attached = checkAttachments(withFiles, {
      maxCount: config.mail.maxAttachments,
      maxTotalBytes: config.mail.maxAttachmentBytes,
    });
    if (!attached.ok) {
      return refuse(attached.status, "message_rejected", attached.message, attached.detail);
    }
    const attachments: MailAttachment[] = attached.attachments;

    // ── 2. The recipient decision. Nothing is dialled before this passes ─────
    //
    // ⚠ `env` is read HERE (it used to be read at 4b, after this decision) only
    // so a DRAFT run may pass RFC 2606 reserved recipients (D-267) — addresses
    // that can never receive mail, on a run that is captured, never delivered.
    // Same function, same namespace rule (D-52), same fail-closed default.
    const env = await envForExecution(execution.id);
    const recipients = resolveRecipients({
      draftAllowsReserved: env === "draft",
      explicitTo: input.to ?? [],
      explicitCc: input.cc ?? [],
      requester,
      deploymentAllowlist: config.mail.allowedDomains,
      workspaceAllowlist: workspace?.mailRecipientAllowlist ?? null,
      caps: mailCaps,
    });
    if (!recipients.ok) {
      return refuse(
        recipients.status,
        "recipients_rejected",
        recipients.message,
        // The run kind is added here rather than in the pure module, which has no
        // business knowing about execution rows — it is what makes a `trigger`
        // run's refusal explain itself without a database query.
        { ...recipients.detail, runKind: execution.requestedByKind ?? "unknown" },
      );
    }

    // ── 3. Render the report ────────────────────────────────────────────────
    /**
     * ⚠ **What the flow passes in `body` is DATA, not the message.**
     *
     * A `code`/`query` step hands over raw JSON and an `llm_complete` step hands
     * over prose; both used to arrive in a mailbox exactly as produced, leaving
     * the recipient to read `[{"employee":"A. Sharma",…}]` and do the parsing
     * themselves. `renderReport` turns either into a titled report with real
     * tables, and it does so HERE — server-side, identically for every workspace
     * — rather than by asking the drafter to write markup it has already been
     * observed to get wrong twice (SESSION-NOTES T049, T051).
     *
     * ⚠ The rendered HTML is safe to send as `contentType: "HTML"` for one
     * reason: `mail-report.ts` escapes every value it interpolates, so nothing
     * from upstream can become markup. That guarantee lives in that module and
     * `mail-report.test.ts` holds it; do not send caller markup through here.
     */
    const report = renderReport({
      subject: input.subject,
      body: bodyForSend,
      meta: { flowExecutionId: execution.id, stepId: input.stepId ?? null },
    });
    if (!report.ok) {
      return refuse(report.status, "message_rejected", report.message, report.detail);
    }

    /**
     * The report and the attachments used to have to fit ONE Graph request (4 MB). Since 2026-10-12 a message past
     * that goes up as a draft with each large file uploaded in pieces (`mail.service.ts`), so the cap is
     * `MAIL_MAX_ATTACHMENT_BYTES` alone; the tenant's own send limit can still refuse, and that refusal is named.
     */

    // ── 4. The intent row, BEFORE the provider is called ─────────────────────
    const intent = await emailSendRepo.record({
      workspaceId: execution.workspaceId,
      flowExecutionId: execution.id,
      stepId: input.stepId ?? null,
      recipients: recipients.to,
      cc: recipients.cc,
      resolvedFrom: recipients.resolvedFrom,
      subject: input.subject.slice(0, 500),
      attachments: attachmentMeta(attachments),
      // Pessimistic until the provider answers. A crash between here and the
      // outcome write therefore reads as "attempted, unknown", never as "sent".
      outcome: "failed",
      failureReason: "no provider answer yet",
    });

    // ── 4b. A DRAFT RUN IS CAPTURED, NEVER DELIVERED ────────────────────────
    /**
     * ⚠ **THE EXPOSURE THIS CLOSES.** Nothing bound tool choice to the run
     * environment: a step names its tool at authoring time, so a *test* run of
     * a flow naming `tether_email_send` delivered real mail through Graph. And
     * gate 1 requires a successful run before a flow can be armed, so that real
     * send happened **before anybody had approved anything** — the same shape
     * D-52 closed for datasource reads, in the one place where the side effect
     * cannot be taken back.
     *
     * ⚠ **The selector is the EXECUTION'S NAMESPACE and there is no flag.**
     * `envForExecution` is the one function that decides (D-52), reading the
     * namespace `POST /api/executions/begin` wrote from Kestra's own record of
     * the execution rather than from any request body (I-07). So a flow cannot
     * lie about where it lives, and neither can a step callback. Adding a
     * `draft: false` field to `sendSchema` would hand the decision to whoever
     * can write the body, and there are more callers than reviewers.
     *
     * ⚠ **It FAILS CLOSED, and that is the opposite direction from D-52's
     * datasource rule — deliberately.** An unreadable execution or an
     * unparseable namespace resolves to `draft`, so the failure mode is a
     * message held that should have been sent: visible, recoverable, and
     * somebody is watching. D-52 lets a draft run read production because
     * refusing on day one is a control everybody routes around; reading the
     * wrong rows is recoverable and mailing a real person is not.
     *
     * ⚠ **The recipient policy has ALREADY RUN by this point, on purpose.**
     * Capturing before `resolveRecipients` would hold a message whose
     * destination was never decided, so the Email box would show an address
     * that the live run might refuse — a test that proves less than it appears
     * to. Everything except the Graph call happens exactly as it would live.
     */
    if (env === "draft") {
      await emailSendRepo.finish(intent.id, {
        // ⚠ `captured`, not `refused` and not `sent` (migration 0058). Nothing
        // was declined and nothing was delivered.
        outcome: "captured",
        graphMessageId: null,
        failureReason: null,
        capturedBody: report.html,
        // The files are held as files (`email_held_files`), every one at any size the route accepted, and read one at
        // a time from the Email box. They used to be inline here, returned with every message in the list — so a file
        // past 5 MB was dropped and a test run's report could not be opened (2026-10-13).
        capturedAttachments: null,
      });
      await emailHeldFileRepo.saveAll(execution.workspaceId, intent.id, attachments).catch((e) => {
        // Holding a copy is for the person testing; the run's result does not depend on it — but it is said.
        console.error(`[mail] could not hold the attachments of ${intent.id}: ${(e as Error).message}`);
      });
      return res.status(200).json({
        /**
         * ⚠ A DISTINCT status string, not `"sent"`. A flow step reading
         * `status` must be able to tell a held message from a delivered one —
         * returning `"sent"` here would be the false green this whole path
         * exists to remove, arriving from the far end.
         */
        status: "captured",
        message:
          "captured, not delivered — this is a draft (test) run, so the message was rendered " +
          "and held in Tether's Email box instead of being sent. Approving and arming this " +
          "automation is what makes it deliver." +
          (recipients.reservedAllowed?.length
            ? ` ⚠ ${recipients.reservedAllowed.length} recipient(s) are on reserved test domains ` +
              `(${recipients.reservedAllowed.join(", ")}), which pass only in a draft run — a live run ` +
              "would refuse them unless their domain is on MAIL_ALLOWED_RECIPIENT_DOMAINS."
            : ""),
        /**
         * The held message's own id (its Email box record), prefixed so it can never be read as a delivery receipt.
         * A test answers in the SAME shape a live send does (2026-10-10): with `null` here, every step that kept the
         * id came back empty in every test — and failed the empty-output check — while working in production.
         * `status` is what says captured-not-sent.
         */
        message_id: `captured:${intent.id}`,
        recipients: recipients.to,
        cc: recipients.cc,
        resolved_from: recipients.resolvedFrom,
        attachments: attachmentMeta(attachments),
        ...(folded.skipped.length ? { attachments_skipped: folded.skipped } : {}),
        ...(promoted.promoted
          ? { body_promoted_to_attachment: true, body_promoted_from_bytes: promoted.fromBytes }
          : {}),
        ...(recipients.reservedAllowed?.length ? { reserved_allowed_in_draft: recipients.reservedAllowed } : {}),
      });
    }

    // ── 5. Send ─────────────────────────────────────────────────────────────
    const sent = await mailService.send({
      subject: input.subject.trim(),
      /** ⚠ The rendered report, not `input.body`. See the render step above. */
      body: report.html,
      contentType: "HTML",
      to: recipients.to,
      cc: recipients.cc,
      attachments,
    });

    // ── 6. Record the outcome ───────────────────────────────────────────────
    if (!sent.ok) {
      // `refused` for a config problem (nothing left the building; the fix is
      // here), `failed` for a provider problem (Microsoft was reached; the fix is
      // there). Collapsing them would send someone whose MAIL_ENABLED is `false`
      // to go and read Azure logs.
      const outcome = sent.status === 502 ? "failed" : "refused";
      await emailSendRepo.finish(intent.id, {
        outcome,
        graphMessageId: null,
        // ⚠ The detail carries a status and Graph's error code — never the body,
        // never the credential. `mail.service.ts` narrows it before we see it.
        failureReason: `${sent.message} ${JSON.stringify(sent.detail)}`.slice(0, 2000),
      });
      return res.status(sent.status).json({
        error: sent.status === 502 ? "delivery_failed" : sent.status === 413 ? "message_too_large" : "mail_unavailable",
        message: sent.message,
        detail: sent.detail,
      });
    }

    await emailSendRepo.finish(intent.id, {
      outcome: "sent",
      graphMessageId: sent.messageId,
      failureReason: null,
    });

    return res.status(200).json({
      status: "sent",
      /**
       * ⚠ Not an RFC 5322 Message-ID — Graph answers `202` with an empty body, so
       * this is the request correlation id. Documented in contracts §2 because a
       * reader will otherwise go looking for it in a mail header.
       */
      message_id: sent.messageId,
      recipients: recipients.to,
      cc: recipients.cc,
      /** So the run page can explain the destination without reading the flow. */
      resolved_from: recipients.resolvedFrom,
      attachments: attachmentMeta(attachments),
      ...(folded.skipped.length ? { attachments_skipped: folded.skipped } : {}),
      ...(promoted.promoted
        ? { body_promoted_to_attachment: true, body_promoted_from_bytes: promoted.fromBytes }
        : {}),
    });
  }),
);
