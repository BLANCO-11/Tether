/**
 * `GET /api/workspaces/:workspaceId/email-box` — the Email box.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * Testing an automation that emails somebody used to have two bad outcomes and
 * no good one: either the flow named the simulated tool, in which case the
 * message went into a demo capture table nothing in the product read, or it
 * named `tether_email_send`, in which case a **draft run delivered real mail**
 * — before approval, because gate 1 requires a successful run before arming.
 *
 * The second half is now closed at the delivery boundary: `routes/mail.ts`
 * captures instead of dialling when the execution's namespace says `draft`
 * (migration 0058). This route is where a person reads what was held.
 *
 * ── ONE SOURCE ───────────────────────────────────────────────────────────────
 *
 * `tether_email_send` records into Foundry's own `email_sends`, which is
 * workspace-scoped and carries the resolved recipients, the outcome and — for a
 * captured message only — the rendered body. The second, simulated source (ops-api's
 * shared `mail_outbox`, which had no workspace column) went with ops-api on 2026-10-30.
 */
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.middleware.js";
import { db } from "../db/index.js";
import { emailSends, flowExecutions, flows } from "../db/schema.js";
import { emailHeldFileRepo, type HeldFileMeta } from "../repositories/email-held-file.repo.js";
import { previewOf } from "../pi-builder/file-preview.js";
import { contentVisibility } from "../services/content-visibility.service.js";

/**
 * ⚠ `mergeParams: true`, and leaving it off was a REAL SHIPPED DEFECT.
 *
 * This router is mounted at `/api/workspaces/:workspaceId/email-box`, and
 * without `mergeParams` an Express child router does not receive its parent's
 * path parameters — so `req.params.workspaceId` was `undefined`, the query
 * filtered on `undefined`, and the route answered **an empty list for every
 * workspace**.
 *
 * That is the worst available failure for this particular surface: an empty
 * Email box is indistinguishable from "no automation has sent an email", which
 * is the exact lie the page's own header warns about. Nothing caught it —
 * typecheck passes, the route returns 200 with a valid shape, and the page
 * renders its empty state.
 *
 * It was found by draft-running a real chat-built flow and then failing to see
 * the message the database plainly held. `email-box.test.ts` now pins it.
 */
export const emailBoxRouter = Router({ mergeParams: true });

type SendRow = typeof emailSends.$inferSelect;

/**
 * The held copy of a message's attachment at `position`: a row of `email_held_files`, or — for a message held before
 * 2026-10-13 — its inline `captured_attachments` entry matched by name. Null when nothing is held.
 */
function heldFileOf(
  r: Pick<SendRow, "attachments" | "capturedAttachments">,
  files: HeldFileMeta[] | undefined,
  position: number,
): { contentType: string; legacy?: { content: string; encoding?: string } } | null {
  const file = files?.find((f) => f.position === position);
  if (file) return { contentType: file.contentType };
  const name = (r.attachments ?? [])[position]?.name;
  const old = name ? (r.capturedAttachments ?? []).find((c) => c.name === name) : undefined;
  return old ? { contentType: old.contentType, legacy: { content: old.content, encoding: old.encoding } } : null;
}

emailBoxRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    /**
     * ⚠ Fails LOUDLY rather than answering an empty list.
     *
     * `mergeParams` above is what makes this reachable only through a mounting
     * mistake — and a mounting mistake must not present as "this workspace has
     * sent no email". A 500 naming the cause is recoverable; a plausible empty
     * list is not.
     */
    if (!workspaceId) {
      throw new Error(
        "email-box: no workspaceId on the request — the router is mounted without " +
          "`mergeParams: true`, so it cannot see its parent's path parameters",
      );
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);

    // Only the messages of runs this person may see (rbac-observability).
    const visible = contentVisibility.emailsWhere(await contentVisibility.viewer(req.user, workspaceId));
    const rows = await db
      .select()
      .from(emailSends)
      .where(and(eq(emailSends.workspaceId, workspaceId), visible))
      .orderBy(desc(emailSends.createdAt))
      .limit(limit);

    /**
     * ⚠ **`body` is present for a CAPTURED message and null for every other
     * outcome, and that asymmetry is the point.** A real send stores no body
     * (`schema.ts`), so returning a `body: ""` for one would read as an empty
     * email rather than as a message this product deliberately does not keep.
     */
    // What is held for the held messages, without the content (email_held_files, 0098): read once for the page.
    const heldFiles = await emailHeldFileRepo.metaFor(
      workspaceId,
      rows.filter((r) => r.outcome === "captured").map((r) => r.id),
    );
    /**
     * Which workflow each message came from, for the Email box's title and link. Read through the message's run:
     * `flow_id` is the LIVE workflow (null once it is deleted, `ON DELETE SET NULL`), and the run's name snapshot
     * keeps the title after that. So `flowId` null with a `flowName` means "deleted" — never a link to a 404 — and
     * both null means the message has no run at all (a bare tool test).
     */
    const execIds = [...new Set(rows.map((r) => r.flowExecutionId).filter((x): x is string => !!x))];
    const runs = execIds.length
      ? await db
          .select({
            id: flowExecutions.id,
            flowId: flowExecutions.flowId,
            snapshotName: flowExecutions.flowNameSnapshot,
            liveName: flows.name,
          })
          .from(flowExecutions)
          .leftJoin(flows, eq(flows.id, flowExecutions.flowId))
          .where(and(eq(flowExecutions.workspaceId, workspaceId), inArray(flowExecutions.id, execIds)))
      : [];
    const runById = new Map(runs.map((x) => [x.id, x]));
    const foundry = rows.map((r) => ({
      id: r.id,
      flowId: (r.flowExecutionId && runById.get(r.flowExecutionId)?.flowId) || null,
      flowName:
        (r.flowExecutionId &&
          (runById.get(r.flowExecutionId)?.liveName ?? runById.get(r.flowExecutionId)?.snapshotName)) ||
        null,
      subject: r.subject,
      recipients: r.recipients ?? [],
      cc: r.cc ?? [],
      resolvedFrom: r.resolvedFrom,
      outcome: r.outcome,
      /** True only for `captured` — a held message, not a delivered one. */
      delivered: r.outcome === "sent",
      failureReason: r.failureReason,
      body: r.outcome === "captured" ? r.capturedBody : null,
      /**
       * Names and sizes on every outcome. A CAPTURED message's files are HELD (the `body` rule, for the files) and
       * opened one at a time from `GET /:sendId/attachments/:position` — never sent with the list, which is why a
       * held file can now be any size (2026-10-13). `held` false means there is no file behind the name: a delivered
       * message keeps none, and a message held before 2026-10-13 kept none past 5 MB.
       */
      attachments: (r.attachments ?? []).map((a, position) => ({
        name: a.name,
        bytes: a.bytes,
        position,
        held: r.outcome === "captured" && heldFileOf(r, heldFiles.get(r.id), position) !== null,
        contentType: heldFileOf(r, heldFiles.get(r.id), position)?.contentType ?? null,
      })),
      flowExecutionId: r.flowExecutionId,
      stepId: r.stepId,
      at: r.createdAt,
    }));

    res.json({
      workspaceId,
      /** From `tether_email_send`. Workspace-scoped, and authoritative. */
      foundry,
      notes: {
        capturedMeansHeld:
          "outcome `captured` means Foundry deliberately did not contact the mail provider, " +
          "because the run was a draft (test) run. The message is complete and addressed; " +
          "nothing was delivered. Approving and arming the automation is what makes it deliver.",
        noBodyForRealSends:
          "A delivered, refused or failed message stores no body. Only a captured one does.",
      },
    });
  }),
);

/**
 * Clearing the Email box (2026-10-12): what may go, and what may not.
 *
 * ⚠ **A DELIVERED message (`outcome = 'sent'`) is never removed by a button.** It is the record that Foundry handed
 * real mail to a provider — the only evidence real mail left the building — and the rule stated above for the
 * simulated clear stands: a button does not delete audit history.
 *
 * Everything else was never delivered and is test or diagnostic residue: `captured` (held, because the run was a
 * draft), `refused` (Foundry declined before contacting the provider) and `failed` (the provider did not accept it).
 * Those may be cleared — all at once, or one at a time. The outcome set and the workspace are LITERAL in each query,
 * never a request input.
 */
const UNDELIVERED = ["captured", "refused", "failed"] as const;

/** `DELETE …/email-box/undelivered` — clear every held, refused and failed message in THIS workspace. */
emailBoxRouter.delete(
  "/undelivered",
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) {
      throw new Error("email-box: no workspaceId on the request — the router is mounted without `mergeParams: true`");
    }
    // Only the messages this person can see (rbac-observability) — never somebody else's private test runs.
    const visible = contentVisibility.emailsWhere(await contentVisibility.viewer(req.user, workspaceId));
    const removed = await db
      .delete(emailSends)
      .where(and(eq(emailSends.workspaceId, workspaceId), inArray(emailSends.outcome, [...UNDELIVERED]), visible))
      .returning({ id: emailSends.id });
    res.json({ ok: true, cleared: removed.length });
  }),
);

/** `DELETE …/email-box/messages/:id` — remove ONE message, if it was never delivered. A delivered one is a 409. */
emailBoxRouter.delete(
  "/messages/:id",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId?: string; id: string };
    if (!workspaceId) {
      throw new Error("email-box: no workspaceId on the request — the router is mounted without `mergeParams: true`");
    }
    const [row] = await db
      .select({ outcome: emailSends.outcome })
      .from(emailSends)
      .where(and(eq(emailSends.workspaceId, workspaceId), eq(emailSends.id, id), contentVisibility.emailsWhere(await contentVisibility.viewer(req.user, workspaceId))));
    if (!row) return res.status(404).json({ error: "not_found", message: "That email is not in this workspace's Email box." });
    if (row.outcome === "sent") {
      return res.status(409).json({
        error: "delivered",
        message: "A delivered email is the record that real mail was sent, so it cannot be removed.",
      });
    }
    await db
      .delete(emailSends)
      .where(and(eq(emailSends.workspaceId, workspaceId), eq(emailSends.id, id), inArray(emailSends.outcome, [...UNDELIVERED])));
    res.json({ ok: true, cleared: 1 });
  }),
);

/**
 * One held attachment (2026-10-13): the file itself, `?inline=1` to show it in the page (an image, a PDF, text), or
 * `?preview=1` for a sheet or Word document as a table or text — the chat files' contract, so the Email box uses the
 * same preview. Only a CAPTURED message in this workspace holds files; anything else is a 404 that says why.
 */
emailBoxRouter.get(
  "/:sendId/attachments/:position",
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) throw new Error("email-box: no workspaceId on the request (mounted without mergeParams)");
    const sendId = z.string().uuid().parse(req.params.sendId);
    const position = z.coerce.number().int().min(0).parse(req.params.position);
    const [row] = await db
      .select()
      .from(emailSends)
      .where(and(eq(emailSends.id, sendId), eq(emailSends.workspaceId, workspaceId), contentVisibility.emailsWhere(await contentVisibility.viewer(req.user, workspaceId))))
      .limit(1);
    const name = row?.attachments?.[position]?.name;
    if (!row || !name) {
      res.status(404).json({ error: "There is no such attachment on a message in this workspace." });
      return;
    }
    if (row.outcome !== "captured") {
      res.status(404).json({ error: "Only a held message keeps its files; this one was not held, so the file is not kept." });
      return;
    }
    let file: { name: string; contentType: string; body: Buffer } | null = await emailHeldFileRepo.read(workspaceId, sendId, position);
    if (!file) {
      const held = heldFileOf(row, undefined, position);
      if (held?.legacy) {
        const body = held.legacy.encoding === "base64" ? Buffer.from(held.legacy.content, "base64") : Buffer.from(held.legacy.content, "utf8");
        file = { name, contentType: held.contentType, body };
      }
    }
    if (!file) {
      res.status(404).json({ error: "This file was not kept: it was held before files of any size were kept (over 5 MB then)." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.query.preview === "1") {
      res.json({ preview: previewOf(file.name, file.body) });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.body.length));
    // Only types a browser renders safely are shown inline; anything else downloads, so a file never runs as a page.
    const inline = req.query.inline === "1" && /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|text\/csv)/.test(file.contentType);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(file.body);
  }),
);
