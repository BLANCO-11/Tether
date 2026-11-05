/**
 * Emailing a cost report (2026-10-26). The point of the feature is that a report can reach somebody with NO access to
 * the workspaces it covers, so it is a sharing path with its own rules and its own record:
 *
 *   - the sender can only share what they could open themselves (the caller hands this module runs already limited to
 *     the workspaces they hold `reports.read` in);
 *   - every recipient must be on an allowed domain (`config.reports.emailDomains`, `microland.com` by default);
 *   - the message carries the workbook as an attachment, a snapshot taken now. There is no link back into the
 *     product, because the recipient may not be able to open it;
 *   - every attempt leaves a `report_shares` row, written BEFORE the send and finished after, so a crash mid-send
 *     reads as "attempted", never as "sent".
 *
 * Delivery is `mailService.send`, the same Graph transport `foundry_email_send` uses. This path does not go through
 * `POST /api/mail/send`: that route's recipient policy is built around a flow run's requester, and a report has none.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { reportShares } from "../db/schema.js";
import { config } from "../config/index.js";
import { mailService } from "./mail.service.js";
import { periodText, stampText } from "./pdf-charts.js";
import { buildReportPdf, reportPdfFilename, PDF_CONTENT_TYPE } from "./report-pdf.js";
import { buildReportWorkbook, reportFilename, XLSX_CONTENT_TYPE } from "./report-workbook.js";
import { summarise, type ReportRun, type ReportWindow } from "./report.service.js";

const ADDRESS = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;

export type RecipientCheck =
  | { ok: true; to: string[] }
  | { ok: false; message: string; offending: string[] };

/** Lowercase, de-duplicate, and require every address to be well formed and on an allowed domain. */
export function checkRecipients(raw: readonly string[], domains: readonly string[] = config.reports.emailDomains): RecipientCheck {
  const to = [...new Set(raw.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!to.length) return { ok: false, message: "Add at least one email address.", offending: [] };
  const malformed = to.filter((a) => !ADDRESS.test(a));
  if (malformed.length) return { ok: false, message: "These are not valid email addresses.", offending: malformed };
  if (!domains.length) {
    return { ok: false, message: "No recipient domain is configured for reports (REPORT_EMAIL_DOMAINS).", offending: [] };
  }
  const outside = to.filter((a) => !domains.includes(a.slice(a.lastIndexOf("@") + 1)));
  if (outside.length) {
    return { ok: false, message: `Reports can only be sent to ${domains.map((d) => `@${d}`).join(", ")} addresses.`, offending: outside };
  }
  return { ok: true, to };
}

export interface SendReportInput {
  sender: { subject: string; email: string | null; name: string | null };
  to: readonly string[];
  note?: string;
  /** Which files to attach; both when omitted. */
  formats?: ReadonlyArray<"pdf" | "xlsx">;
  runs: readonly ReportRun[];
  /** The period of equal length just before, for the PDF's comparison. */
  previous?: readonly ReportRun[];
  window: ReportWindow;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  /** Plain-words drill filters, and the raw ones for the record. */
  filterWords: readonly string[];
  filters: Record<string, string>;
}

export type SendReportResult =
  | { ok: true; filename: string; recipients: string[]; bytes: number }
  | { ok: false; status: 400 | 409 | 413 | 422 | 502; message: string; offending?: string[] };


export const reportShareService = {
  async send(input: SendReportInput): Promise<SendReportResult> {
    const rc = checkRecipients(input.to);
    if (!rc.ok) return { ok: false, status: 422, message: rc.message, offending: rc.offending };
    if (!input.runs.length) return { ok: false, status: 422, message: "There is no usage in this selection to send." };

    const who = input.sender.name || input.sender.email || input.sender.subject;
    const names = input.workspaces.map((w) => w.name);
    const wantPdf = !input.formats || input.formats.includes("pdf");
    const wantXlsx = !input.formats || input.formats.includes("xlsx");
    if (!wantPdf && !wantXlsx) return { ok: false, status: 422, message: "Choose at least one file to send." };
    const xlsxName = reportFilename(names, input.window);
    const pdfName = reportPdfFilename(names, input.window);
    const attachments: Array<{ name: string; contentType: string; data: Buffer }> = [];
    if (wantXlsx) {
      const data = await buildReportWorkbook({ runs: input.runs, previous: input.previous, window: input.window, workspaces: names, filters: input.filterWords, generatedBy: who });
      attachments.push({ name: xlsxName, contentType: XLSX_CONTENT_TYPE, data });
    }
    if (wantPdf) {
      const data = await buildReportPdf({ runs: input.runs, previous: input.previous, window: input.window, workspaces: names, filters: input.filterWords, generatedBy: who });
      attachments.push({ name: pdfName, contentType: PDF_CONTENT_TYPE, data });
    }
    const filename = attachments[0].name;
    const total = attachments.reduce((a, f) => a + f.data.length, 0);
    if (total > config.mail.maxAttachmentBytes) {
      return { ok: false, status: 413, message: "The report is too large to email. Narrow the period or the workspaces, or download it instead." };
    }

    const totals = summarise(input.runs, input.window).tiles;
    const note = input.note?.trim();
    const lines: string[] = [];
    if (wantPdf) lines.push("• PDF: the summary. Key figures against the previous period, cost per day, and the biggest workspaces, workflows and people. Start here.");
    if (wantXlsx) lines.push("• Excel: the data. The same figures by workspace, workflow, person and day, plus every individual run, to filter, sort or total yourself.");
    const body = [
      `${who} has shared the model (LLM) cost report.`,
      "",
      `Report period: ${periodText(input.window.fromDay, input.window.toDay)}`,
      `Generated: ${stampText(new Date())}`,
      ...(note ? ["", note] : []),
      "",
      "Attached:",
      ...lines,
    ].join("\n");

    const [intent] = await db
      .insert(reportShares)
      .values({
        senderSubject: input.sender.subject,
        senderEmail: input.sender.email,
        recipients: rc.to,
        workspaceIds: input.workspaces.map((w) => w.id),
        workspaceNames: names,
        periodFrom: input.window.fromDay,
        periodTo: input.window.toDay,
        filters: input.filters,
        filename,
        bytes: total,
        runCount: totals.runs,
        costUsd: totals.costUsd.toFixed(6),
        outcome: "failed",
        failureReason: "no provider answer yet",
      })
      .returning({ id: reportShares.id });

    const sent = await mailService.send({
      subject: `Cost report, ${input.window.fromDay} to ${input.window.toDay}`,
      body,
      contentType: "Text",
      to: rc.to,
      attachments,
    });

    if (!sent.ok) {
      await db
        .update(reportShares)
        .set({ outcome: sent.status === 502 ? "failed" : "refused", failureReason: `${sent.message} ${JSON.stringify(sent.detail)}`.slice(0, 2000) })
        .where(eq(reportShares.id, intent.id));
      return { ok: false, status: sent.status === 502 ? 502 : sent.status === 413 ? 413 : 409, message: sent.message };
    }
    await db.update(reportShares).set({ outcome: "sent", failureReason: null }).where(eq(reportShares.id, intent.id));
    return { ok: true, filename, recipients: rc.to, bytes: total };
  },
};
