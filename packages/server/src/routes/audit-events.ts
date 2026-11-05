import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { auditService } from "../services/audit.service.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });

const querySchema = z.object({
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  view: z.string().optional(),
  download: z.string().optional(),
  format: z.string().optional(),
  /** A page (2026-10-12). With `limit`, the response also carries `total` — how many the filter matches. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function toApiEvent(row: {
  id: string;
  time: Date;
  actor: string;
  operation: string;
  entity: string;
  entityId: string | null;
  description: string;
  whereText: string;
  whereEntityType: string | null;
  whereEntityId: string | null;
  raw: unknown;
}, view: string | undefined) {
  const base = {
    id: row.id,
    time: row.time instanceof Date ? row.time.toISOString() : String(row.time),
    actor: row.actor,
    operation: row.operation,
    entity: row.entity,
    entityId: row.entityId ?? undefined,
    description: row.description,
    where: row.whereText,
    whereEntityType: row.whereEntityType ?? undefined,
    whereEntityId: row.whereEntityId ?? undefined,
  };
  if (view === "raw") {
    return { ...base, raw: row.raw as unknown };
  }
  return { ...base, raw: undefined as unknown as undefined };
}

function csvEscape(value: string): string {
  const v = value ?? "";
  return `"${v.replace(/"/g, '""')}"`;
}

function toCsv(rows: ReturnType<typeof toApiEvent>[]): string {
  const header = ["id", "time", "actor", "operation", "entity", "entityId", "description", "where", "raw"];
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        csvEscape(r.id),
        csvEscape(r.time),
        csvEscape(r.actor),
        csvEscape(String(r.operation)),
        csvEscape(String(r.entity)),
        csvEscape(String(r.entityId ?? "")),
        csvEscape(r.description),
        csvEscape(r.where),
        csvEscape(r.raw ? JSON.stringify(r.raw) : ""),
      ].join(","),
    ),
  ];
  return lines.join("\n");
}

export const auditEventsRouter = Router({ mergeParams: true });

// GET /workspaces/:workspaceId/audit-events?q=&from=&to=&view=&download=
auditEventsRouter.get(
  "/",
  validate({ params: paramsSchema, query: querySchema }),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const { q, from, to, view, download, format } = req.query as {
      q?: string;
      from?: string;
      to?: string;
      view?: string;
      download?: string;
      format?: string;
    };
    // Download via ?download=1 or ?format=csv — always the WHOLE filtered set, never a page.
    const wantsDownload = download === "1" || format === "csv";
    const limit = wantsDownload || req.query.limit === undefined ? undefined : Number(req.query.limit);
    const offset = limit === undefined ? undefined : Number(req.query.offset ?? 0);

    const rows = await auditService.list({ workspaceId, q, from, to, limit, offset });
    const events = rows.map((r) => toApiEvent(r, view));
    if (wantsDownload) {
      const csv = toCsv(events);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="audit-events-${workspaceId}.csv"`);
      res.send(csv);
      return;
    }

    if (limit !== undefined) {
      res.json({ events, total: await auditService.count({ workspaceId, q, from, to }), limit, offset });
      return;
    }
    res.json({ events });
  }),
);

// GET /workspaces/:workspaceId/audit-events/export — filtered export (json/csv)
auditEventsRouter.get(
  "/export",
  validate({ params: paramsSchema, query: querySchema }),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const { q, from, to, view, format } = req.query as {
      q?: string;
      from?: string;
      to?: string;
      view?: string;
      format?: string;
    };

    const rows = await auditService.list({ workspaceId, q, from, to });
    const events = rows.map((r) => toApiEvent(r, view));

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="audit-events-${workspaceId}.json"`);
      res.json({ events });
      return;
    }

    const csv = toCsv(events);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-events-${workspaceId}.csv"`);
    res.send(csv);
  }),
);
