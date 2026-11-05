/**
 * `/api/reports` — the cost report: what the model calls behind workspaces, workflows, runs and people cost.
 *
 * ⚠ These routes are IDENTITY-ONLY in the route map, and that is not the same as open. The report spans workspaces, so
 * there is no single workspace for a per-route guard to ask about. The check is `reports.read` per workspace inside
 * `reportService.allowedWorkspaces`, and every answer is limited to the workspaces the caller holds it in (every one
 * for a super admin). A caller who holds it nowhere is refused (403) on every route, and a workspace named outside
 * their set is refused too: a forged id must not look like an empty one.
 *
 * What a person may see here is NOT what they may see elsewhere: `reports.read` is an Admin's, so a member or an
 * Observer gets a 403 even in a workspace where they can read their own usage on the older observability route.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import {
  NO_FLOW,
  RUN_SORTS,
  applyDrill,
  pageOfRuns,
  reportService,
  summarise,
  windowOf,
  type ReportRun,
  type ReportWindow,
  type ReportWorkspace,
} from "../services/report.service.js";
import { buildReportWorkbook, reportFilename, XLSX_CONTENT_TYPE } from "../services/report-workbook.js";
import { previousWindow } from "../services/report-compare.js";
import { forecastMonth, monthBounds } from "../services/report-forecast.js";
import { writeZip } from "../services/zip-lite.js";
import { buildReportPdf, reportPdfFilename, PDF_CONTENT_TYPE } from "../services/report-pdf.js";
import { reportShareService } from "../services/report-share.service.js";
import type { Request, Response } from "express";

const ZIP_CONTENT_TYPE = "application/zip";
/** `cost-report_finance_2026-10-01_to_2026-10-28.zip`: the workbook's name with the format swapped. */
const reportZipFilename = (workspaces: readonly string[], window: ReportWindow) => reportFilename(workspaces, window).replace(/\.xlsx$/, ".zip");

export const reportsRouter = Router();
reportsRouter.use(requireIdentity);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const uuid = z.string().uuid();

const scopeShape = {
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  flowId: z.union([uuid, z.literal(NO_FLOW)]).optional(),
  subject: z.string().min(1).max(255).optional(),
};

/** `workspaces` arrives as a comma-separated list in a query string and as an array in a body. */
const idList = z
  .preprocess((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v), z.array(uuid).max(500))
  .optional();

function checkWindow(v: { from?: string; to?: string }, ctx: z.RefinementCtx) {
  if (!!v.from !== !!v.to) ctx.addIssue({ code: "custom", message: "Give both a start and an end date." });
  else if (v.from && v.to) {
    const span = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
    if (!(span >= 0)) ctx.addIssue({ code: "custom", message: "The start date is after the end date." });
    else if (span > 366) ctx.addIssue({ code: "custom", message: "A report covers at most a year." });
  }
}

const baseQuery = z.object({ ...scopeShape, workspaces: idList }).superRefine(checkWindow);
/** The workbook is the default, so every existing caller of `/export` is unchanged; `format=pdf` asks for the PDF report and `both` for the two in one zip. */
const exportQuery = z.object({ ...scopeShape, workspaces: idList, format: z.enum(["xlsx", "pdf", "both"]).optional().default("xlsx") }).superRefine(checkWindow);
const forecastQuery = z.object({ workspaces: idList, flowId: scopeShape.flowId, subject: scopeShape.subject });
const runsQuery = z
  .object({
    ...scopeShape,
    workspaces: idList,
    sort: z.enum(RUN_SORTS).optional().default("at"),
    dir: z.enum(["asc", "desc"]).optional().default("desc"),
    offset: z.coerce.number().int().min(0).optional().default(0),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .superRefine(checkWindow);
const emailBody = z
  .object({
    ...scopeShape,
    workspaces: idList,
    /** Who receives it. (`to` is already the end of the period.) */
    recipients: z.preprocess((v) => (typeof v === "string" ? v.split(/[,;\s]+/).filter(Boolean) : v), z.array(z.string().max(254)).min(1).max(200)),
    note: z.string().max(1000).optional(),
    /** Which files to attach. Both when omitted, so every existing caller is unchanged. */
    formats: z.array(z.enum(["pdf", "xlsx"])).min(1).max(2).optional(),
  })
  .strict()
  .superRefine(checkWindow);

interface Loaded {
  window: ReportWindow;
  allowed: ReportWorkspace[];
  selected: ReportWorkspace[];
  /** Every run in the window across everything the caller may see. */
  all: ReportRun[];
  /** The runs after the workspace picker and the drill. */
  runs: ReportRun[];
  /** The same for the period of equal length just before; only read when asked for (the PDF's comparison). */
  previous: ReportRun[];
  filterWords: string[];
  filters: Record<string, string>;
}

/** The one place a request becomes data. Sends the refusal itself and returns null when there is one. */
async function load(
  request: Request,
  res: Response,
  q: { days?: number; from?: string; to?: string; workspaces?: string[]; flowId?: string; subject?: string },
  o: { previous?: boolean } = {},
): Promise<Loaded | null> {
  const allowed = await reportService.allowedWorkspaces(request.user);
  const r = reportService.resolve(allowed, q.workspaces ?? []);
  if (!r.ok) {
    res.status(403).json({
      error: "forbidden",
      message:
        r.reason === "none_allowed"
          ? "Cost reports are available to workspace Admins and super admins."
          : "That report includes a workspace you do not have access to.",
    });
    return null;
  }
  const window = windowOf(q);
  const names = new Map(allowed.map((w) => [w.id, w.name]));
  const all = await reportService.runs(allowed.map((w) => w.id), window, names);
  const drill = { workspaceIds: r.workspaces.map((w) => w.id), flowId: q.flowId, subject: q.subject };
  const runs = applyDrill(all, drill);
  // Same workspaces, same drill, same permissions: an earlier period must not show anything this one may not.
  const previous = o.previous ? applyDrill(await reportService.runs(allowed.map((w) => w.id), previousWindow(window), names), drill) : [];

  const filterWords: string[] = [];
  const filters: Record<string, string> = {};
  if (q.flowId) {
    filters.flowId = q.flowId;
    filterWords.push(`Workflow: ${all.find((x) => (q.flowId === NO_FLOW ? x.flowId === null : x.flowId === q.flowId))?.flowName ?? q.flowId}`);
  }
  if (q.subject) {
    filters.subject = q.subject;
    filterWords.push(`Person: ${all.find((x) => x.subject === q.subject)?.person ?? q.subject}`);
  }
  return { window, allowed, selected: r.workspaces, all, runs, previous, filterWords, filters };
}

/** Tiles, the daily series, the kind split and the three lenses, plus the picker's workspaces with their cost. */
reportsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const q = baseQuery.parse(req.query);
    const d = await load(req, res, q);
    if (!d) return;
    const perWorkspace = new Map<string, number>();
    for (const r of d.all) perWorkspace.set(r.workspaceId, (perWorkspace.get(r.workspaceId) ?? 0) + r.costUsd);
    res.json({
      ...summarise(d.runs, d.window),
      workspaces: d.allowed.map((w) => ({ id: w.id, name: w.name, costUsd: perWorkspace.get(w.id) ?? 0 })),
      selected: d.selected.map((w) => w.id),
    });
  }),
);

/** Where this calendar month is heading, from the filters the screen has applied (the period picker does not apply: it is always this month). Screen only. */
reportsRouter.get(
  "/forecast",
  asyncHandler(async (req, res) => {
    const q = forecastQuery.parse(req.query);
    const now = new Date();
    const d = await load(req, res, { ...q, ...monthBounds(now) });
    if (!d) return;
    res.json(forecastMonth(d.runs, now));
  }),
);

/** One page of runs, 50 at a time by default. The download carries the full set. */
reportsRouter.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const q = runsQuery.parse(req.query);
    const d = await load(req, res, q);
    if (!d) return;
    res.json(pageOfRuns(d.runs, { sort: q.sort, dir: q.dir, offset: q.offset, limit: q.limit }));
  }),
);

/** The whole report as one workbook (every run, not just the page on screen), or with `format=pdf` as the PDF report. */
reportsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const q = exportQuery.parse(req.query);
    const d = await load(req, res, q, { previous: true });
    if (!d) return;
    if (!d.runs.length) return void res.status(422).json({ error: "empty", message: "There is no usage in this selection." });
    const who = req.user?.name || req.user?.email || req.user?.subject || "Foundry";
    const names = d.selected.map((w) => w.name);
    if (q.format === "both") {
      const pdf = await buildReportPdf({ runs: d.runs, previous: d.previous, window: d.window, workspaces: names, filters: d.filterWords, generatedBy: who });
      const xlsx = await buildReportWorkbook({ runs: d.runs, previous: d.previous, window: d.window, workspaces: names, filters: d.filterWords, generatedBy: who });
      const zip = writeZip(new Map([[reportFilename(names, d.window), xlsx], [reportPdfFilename(names, d.window), pdf]]));
      res.setHeader("Content-Type", ZIP_CONTENT_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="${reportZipFilename(names, d.window)}"`);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      return void res.send(zip);
    }
    if (q.format === "pdf") {
      const pdf = await buildReportPdf({ runs: d.runs, previous: d.previous, window: d.window, workspaces: names, filters: d.filterWords, generatedBy: who });
      res.setHeader("Content-Type", PDF_CONTENT_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="${reportPdfFilename(names, d.window)}"`);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      return void res.send(pdf);
    }
    const file = await buildReportWorkbook({ runs: d.runs, previous: d.previous, window: d.window, workspaces: names, filters: d.filterWords, generatedBy: who });
    const filename = reportFilename(names, d.window);
    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.send(file);
  }),
);

/** Email the same workbook, and the PDF report, to people who may hold no access here. Recipients are checked against the allowed domains. */
reportsRouter.post(
  "/email",
  asyncHandler(async (req, res) => {
    const body = emailBody.parse(req.body ?? {});
    const d = await load(req, res, body, { previous: true });
    if (!d) return;
    const sent = await reportShareService.send({
      sender: { subject: req.user!.subject, email: req.user!.email ?? null, name: req.user!.name ?? null },
      to: body.recipients,
      note: body.note,
      formats: body.formats,
      runs: d.runs,
      previous: d.previous,
      window: d.window,
      workspaces: d.selected,
      filterWords: d.filterWords,
      filters: d.filters,
    });
    if (!sent.ok) {
      return void res.status(sent.status).json({ error: "not_sent", message: sent.message, ...(sent.offending ? { offending: sent.offending } : {}) });
    }
    res.status(200).json({ status: "sent", filename: sent.filename, recipients: sent.recipients });
  }),
);
