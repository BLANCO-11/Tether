import express, { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  datasourceService,
  createDatasourceInputSchema,
  updateDatasourceSchema,
} from "../services/datasource.service.js";
import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { readMockFile } from "../services/mock-file-store.js";
import { rebuildMockDataset } from "../services/mock-dataset.service.js";
import { resourceService } from "../services/resource.service.js";
import {
  datasourceQueryService,
  namedQueryBodySchema,
  namedQueryUpdateSchema,
} from "../services/datasource-query.service.js";
import {
  dbOperationService,
  dbOperationBodySchema,
  dbOperationSpecSchema,
  dbOperationUpdateSchema,
} from "../services/db-operation.service.js";
import { sandboxService } from "../services/sandbox.service.js";
import { needSchema, proposeOperation } from "../services/db-operation-proposal.service.js";
import { queryNeedSchema, proposeQuery } from "../services/db-query-proposal.service.js";
import { MAX_SQLITE_BYTES, sqliteFileService } from "../services/sqlite-file.service.js";

export const datasourcesRouter = Router({ mergeParams: true });

datasourcesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // B-13 widened read: include ResourceCategory/status/owner/health/dependents/hasMockData
    const enriched = await resourceService.listDatasources(req.params.workspaceId);
    res.json({ datasources: enriched });
  }),
);
datasourcesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createDatasourceInputSchema.parse(req.body);
    const ds = await datasourceService.create(req.params.workspaceId, input);
    res.status(201).json({ datasource: ds });
  }),
);
/**
 * Upload a SQLite database file, before registering the datasource that reads it.
 *
 * The body is the file itself (`application/octet-stream`), parsed HERE rather
 * than by a raised process-wide limit — `app.ts` keeps JSON at 2 MB on purpose.
 * The parser allows a little over 50 MB so the service, not the parser, is what
 * refuses an oversized file, and it refuses it by size in words.
 *
 * Nothing about the file is served back but its metadata and table count: the
 * file is this datasource's credential, and it is stored encrypted.
 */
datasourcesRouter.post(
  "/sqlite-files",
  express.raw({ type: "application/octet-stream", limit: MAX_SQLITE_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const nameHeader = req.header("x-file-name");
    let filename: string | null = null;
    if (nameHeader) {
      try {
        filename = decodeURIComponent(nameHeader);
      } catch {
        filename = nameHeader; // a malformed escape is a name, not a 500
      }
    }
    const f = await sqliteFileService.store(req.params.workspaceId, raw, filename);
    res.status(201).json({
      file: {
        id: f.id,
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        tables: f.tables,
        views: f.views,
      },
    });
  }),
);
datasourcesRouter.get(
  "/:dsId",
  asyncHandler(async (req, res) => {
    const all = await resourceService.listDatasources(req.params.workspaceId);
    const found = all.find((r) => r.id === req.params.dsId);
    if (!found) return res.status(404).json({ error: "not_found" });
    res.json({ datasource: found });
  }),
);
datasourcesRouter.patch(
  "/:dsId",
  asyncHandler(async (req, res) => {
    const input = updateDatasourceSchema.parse(req.body);
    const ds = await datasourceService.update(req.params.workspaceId, req.params.dsId, input);
    if (!ds) return res.status(404).json({ error: "not_found" });
    res.json({ datasource: ds });
  }),
);

datasourcesRouter.delete(
  "/:dsId",
  asyncHandler(async (req, res) => {
    const ok = await datasourceService.remove(req.params.workspaceId, req.params.dsId);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);

datasourcesRouter.post(
  "/:dsId/test",
  asyncHandler(async (req, res) => {
    const result = await datasourceService.test(req.params.workspaceId, req.params.dsId);
    if (!result) return res.status(404).json({ error: "not_found" });
    res.json(result);
  }),
);

datasourcesRouter.get(
  "/:dsId/schema",
  asyncHandler(async (req, res) => {
    const schema = await datasourceService.getSchema(req.params.workspaceId, req.params.dsId);
    if (schema === undefined) return res.status(404).json({ error: "not_found" });
    res.json({ entities: schema });
  }),
);

datasourcesRouter.post(
  "/:dsId/schema/refresh",
  asyncHandler(async (req, res) => {
    const summary = await datasourceService.refreshSchema(req.params.workspaceId, req.params.dsId);
    if (summary === undefined) return res.status(404).json({ error: "not_found" });
    res.json({ refreshed: true, ...summary });
  }),
);

// ── mock testing DB ─────────────────────────────────────────────────────────
// Mock-data plan, rev 2. Read-only projection of the fixtures row + JSON file.
// These endpoints NEVER touch production data: the only read is readMockFile.
// Literal paths declared BEFORE any `/:dsId/:name`-shaped handler.

datasourcesRouter.get(
  "/:dsId/mock",
  asyncHandler(async (req, res) => {
    const ds = await datasourceService.get(req.params.workspaceId, req.params.dsId);
    if (!ds) return res.status(404).json({ error: "not_found", message: "datasource not found" });
    const latest = await datasourceFixtureRepo.latest(req.params.dsId);
    if (!latest) return res.json({ mock: { status: null, error: null, version: null, fingerprint: null } });
    res.json({
      mock: {
        status: latest.mockStatus,
        error: latest.mockError,
        version: latest.version,
        fingerprint: latest.schemaFingerprint,
      },
    });
  }),
);

/**
 * Rebuild the mock dataset for one datasource, on purpose, from a browser.
 *
 * ⚠ **This used to be CLI-only, and the sentence saying so was on screen.** The
 * reason given was that a rebuild "drops and regenerates rows" — true, and a
 * reason to CONFIRM rather than a reason to withhold. The state it left people
 * in was worse: a datasource whose mock build had failed (a 46-table schema
 * against the old table ceiling, say) showed a red panel, told the reader test
 * runs would refuse until it was fixed, and then offered no way to fix it
 * short of shell access to the server. A dead end is not a safety property.
 *
 * ⚠ **`rebuildMockDataset`, never `requestMockBuild`.** The latter declines with
 * `already_has_fixture` when a fixture exists, which is right for the automatic
 * hook on introspection and exactly wrong here: a person pressing "rebuild" is
 * saying they want a fresh one. `rebuildMockDataset` forces a new version.
 *
 * ⚠ **AWAITED, unlike the two internal call sites.** Those are fire-and-forget
 * because a mock problem must never turn a successful introspection or update
 * into a failure. Here the rebuild IS the request, so the outcome is the
 * answer — reporting "started" for a build that declined would be a green
 * button over a panel that never changes. The build is seeded RNG with no model
 * call, so there is nothing slow to block on.
 *
 * A decline is a 200 with `started:false` and its reason, not an error: the
 * outcomes are states of this datasource, not failures of the request, and the
 * panel renders each one as itself.
 */
datasourcesRouter.post(
  "/:dsId/mock/rebuild",
  asyncHandler(async (req, res) => {
    const ds = await datasourceService.get(req.params.workspaceId, req.params.dsId);
    if (!ds) return res.status(404).json({ error: "not_found", message: "datasource not found" });
    const outcome = await rebuildMockDataset(req.params.workspaceId, req.params.dsId);
    res.json({ mock: outcome });
  }),
);

datasourcesRouter.get(
  "/:dsId/mock/rows",
  asyncHandler(async (req, res) => {
    const ds = await datasourceService.get(req.params.workspaceId, req.params.dsId);
    if (!ds) return res.status(404).json({ error: "not_found", message: "datasource not found" });
    const table = typeof req.query.table === "string" ? req.query.table : "";
    if (!table || table.length > 128) {
      return res.status(400).json({ error: "validation", message: "query param 'table' is required" });
    }
    const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize ?? 10)) || 10));
    const latest = await datasourceFixtureRepo.latest(req.params.dsId);
    if (!latest) {
      return res.status(404).json({ error: "not_found", message: "no mock has been built for this datasource" });
    }
    let file;
    try {
      file = await readMockFile(req.params.workspaceId, req.params.dsId, latest.version);
    } catch {
      return res.status(409).json({
        error: "mock_file_missing",
        message: "the mock file is missing for a ready fixture — rebuild it (POST /schema/refresh or the rebuild trigger) before running tests",
      });
    }
    // File keys are schema-qualified (`public.candidates`); the viewer asks bare.
    // Exact match wins; a unique `.<table>` suffix match serves; a clash refuses.
    const exact = file.tables.find((x) => x.name === table);
    const suffixed = file.tables.filter((x) => x.name.endsWith(`.${table}`));
    const t = exact ?? (suffixed.length === 1 ? suffixed[0] : undefined);
    if (!t) {
      if (suffixed.length > 1) {
        return res.status(409).json({
          error: "ambiguous",
          message: `table '${table}' exists in several schemas: ${suffixed.map((x) => x.name).join(", ")} — qualify it`,
        });
      }
      return res.status(404).json({ error: "not_found", message: `table '${table}' is not in the mock` });
    }
    res.json({ rows: t.rows.slice((page - 1) * pageSize, page * pageSize), total: t.rows.length });
  }),
);

// ── named queries ───────────────────────────────────────────────────────────
//
// A `datasource` step names a QUERY, so this is what makes such a step
// authorable at all — `e2e:ui` recorded its absence as a GAP because the
// callable catalogue could only be seeded through the repo by a harness.
//
// Addressed by NAME rather than by id: the name is what a step's `ref` carries,
// so a client that can PATCH a query already holds the only identifier that
// matters, and a uuid here would be a second one to keep in step. It also makes
// a rename impossible by construction, which is right — the name IS the ref, and
// the thing a rename would break is a flow that has already been approved.

datasourcesRouter.get(
  "/:dsId/queries",
  asyncHandler(async (req, res) => {
    res.json({
      queries: await datasourceQueryService.list(req.params.workspaceId, req.params.dsId),
    });
  }),
);

datasourcesRouter.post(
  "/:dsId/queries",
  asyncHandler(async (req, res) => {
    const input = namedQueryBodySchema.parse(req.body);
    const out = await datasourceQueryService.create(
      req.params.workspaceId,
      req.params.dsId,
      input,
    );
    res.status(201).json(out);
  }),
);

/**
 * Check without saving.
 *
 * Here because the shape rules are strict enough that discovering them one 400
 * at a time is how an author starts working around them — and the way around a
 * "single statement" rule is a second query nobody reviews.
 */
datasourcesRouter.post(
  "/:dsId/queries/check",
  asyncHandler(async (req, res) => {
    res.json(datasourceQueryService.check(namedQueryBodySchema.parse(req.body)));
  }),
);
/**
 * Propose SQL for a NEED — the dynamic-read path. CREATES NOTHING: two
 * channels, both HTTP 200 — a shape-checked proposal, or `insufficient_schema`.
 * A person reviews the SQL and saves it through `POST /:dsId/queries`, which
 * re-runs `check()` on whatever arrives. Declared BEFORE `/:name` handlers so
 * the literal is never captured as a name.
 */
datasourcesRouter.post(
  "/:dsId/queries/propose",
  asyncHandler(async (req, res) => {
    const { need } = queryNeedSchema.parse(req.body);
    const ds = await datasourceService.get(req.params.workspaceId, req.params.dsId);
    if (!ds) return res.status(404).json({ error: "not_found" });
    res.json(
      await proposeQuery({
        workspaceId: req.params.workspaceId,
        dsId: req.params.dsId,
        need,
        ...(ds.type === "sqlite" ? { dialect: "sqlite" as const } : {}),
      }),
    );
  }),
);

datasourcesRouter.get(
  "/:dsId/queries/:name",
  asyncHandler(async (req, res) => {
    const q = await datasourceQueryService.get(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
    );
    if (!q) return res.status(404).json({ error: "not_found" });
    res.json({ query: q });
  }),
);

/**
 * What changing this query would unarm, without changing it.
 *
 * A GET, and separate from PATCH on purpose: the consequence of an edit is not
 * reversible by putting the old SQL back — the approval is closed by then — so a
 * client has to be able to ask before it writes, not only read the answer after.
 */
datasourcesRouter.get(
  "/:dsId/queries/:name/impact",
  asyncHandler(async (req, res) => {
    const out = await datasourceQueryService.impact(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
    );
    if (!out) return res.status(404).json({ error: "not_found" });
    res.json(out);
  }),
);

datasourcesRouter.patch(
  "/:dsId/queries/:name",
  asyncHandler(async (req, res) => {
    const input = namedQueryUpdateSchema.parse(req.body);
    const out = await datasourceQueryService.update(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
      input,
    );
    if (!out) return res.status(404).json({ error: "not_found" });
    // 200 with `willSuspendFlows` — the edit succeeded AND it unarms flows. Both
    // facts travel together, because the suspension happens on a later poll tick
    // and would otherwise look like an unrelated outage.
    res.json(out);
  }),
);

datasourcesRouter.delete(
  "/:dsId/queries/:name",
  asyncHandler(async (req, res) => {
    const out = await datasourceQueryService.remove(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
    );
    if (!out) return res.status(404).json({ error: "not_found" });
    // 200, not 204: a deletion that will unarm flows has something to say, and
    // 204 has nowhere to say it.
    res.json({ deleted: true, ...out });
  }),
);

// ── DB operations ────────────────────────────────────────────────────────────
//
// The `query` step kind's callable (07 §7.0). Addressed by NAME like named
// queries, for the same reason: the name is what a step's `ref` carries, the
// name IS the ref, and a rename would break an approved flow.
//
// Unlike a named query, an operation's SQL is COMPILED server-side from a
// `DbOperationSpec` against the introspected schema — the author never writes
// SQL, so the authoring surface exposes only schema metadata, and the compile
// happens on save AND on check (below) so the author sees the emitted SQL
// before anything is stored.

datasourcesRouter.get(
  "/:dsId/operations",
  asyncHandler(async (req, res) => {
    res.json({
      operations: await dbOperationService.list(req.params.workspaceId, req.params.dsId),
    });
  }),
);

datasourcesRouter.post(
  "/:dsId/operations",
  asyncHandler(async (req, res) => {
    const input = dbOperationBodySchema.parse(req.body);
    const out = await dbOperationService.create(
      req.params.workspaceId,
      req.params.dsId,
      input,
    );
    res.status(201).json(out);
  }),
);

/**
 * Check without saving — compile the spec against the introspected schema and
 * return the emitted read-only SQL (or the structured findings). The visual
 * builder's preview endpoint; same shape rule as `…/queries/check`.
 */
datasourcesRouter.post(
  "/:dsId/operations/check",
  asyncHandler(async (req, res) => {
    const input = dbOperationSpecSchema.parse(req.body);
    res.json(await dbOperationService.check(req.params.workspaceId, req.params.dsId, input));
  }),
);

/**
 * Propose an operation from a NEED, for a datasource with no readable components
 * yet — `specs/20260827-053157-proposed-db-operations/contracts/operation-proposal.md`.
 *
 * ⚠ **CREATES NOTHING** (FR-010, SC-004). Two channels, both HTTP 200: a proposal,
 * or `insufficient_schema`. The refusal is a SUCCESS and is never retried, the
 * same rule `insufficient_catalogue` and `insufficient_contract` follow — a 4xx
 * here is how a client renders a correct "this schema cannot express that" as a
 * failure and puts a Retry button on it.
 *
 * ⚠ **ROUTE ORDERING.** This and `/operations/check` are literal paths declared
 * BEFORE the `/:dsId/operations/:name` handlers below, which is what stops
 * `:name` capturing the words "check" and "propose". Nothing shadows them today —
 * there is no `POST /:dsId/operations/:name` — but one declared ABOVE these would
 * swallow both, and the symptom is a 404 that reads like a missing operation
 * rather than a routing mistake. Same note as `/generate/jobs`.
 *
 * ⚠ **The 404 lives HERE, not in the proposer**, and that placement is the point:
 * `datasourceService.get` returns `toPublic`, which never returns the connection
 * string. The proposer therefore needs no datasource lookup of its own and does
 * not import `datasourceRepo` at all — `datasourceRepo.get` would put a DSN one
 * property access away from a prompt builder (FR-005).
 */
datasourcesRouter.post(
  "/:dsId/operations/propose",
  asyncHandler(async (req, res) => {
    const { need } = needSchema.parse(req.body);
    const ds = await datasourceService.get(req.params.workspaceId, req.params.dsId);
    if (!ds) return res.status(404).json({ error: "not_found" });
    // 409 (no introspected schema) and 502 (gateway unreachable) are thrown by
    // the service and carried by the error middleware, which is where every other
    // deliberate status on this router is handled.
    res.json(
      await proposeOperation({
        workspaceId: req.params.workspaceId,
        dsId: req.params.dsId,
        need,
      }),
    );
  }),
);

datasourcesRouter.get(
  "/:dsId/operations/:name",
  asyncHandler(async (req, res) => {
    const op = await dbOperationService.get(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
    );
    if (!op) return res.status(404).json({ error: "not_found" });
    res.json({ operation: op });
  }),
);

datasourcesRouter.patch(
  "/:dsId/operations/:name",
  asyncHandler(async (req, res) => {
    const input = dbOperationUpdateSchema.parse(req.body);
    const out = await dbOperationService.update(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
      input,
    );
    if (!out) return res.status(404).json({ error: "not_found" });
    res.json(out);
  }),
);

/**
 * Delete a saved reader.
 *
 * ⚠ **409, not 204, while a flow still names it** — and the body carries the
 * flow NAMES, because "no" without them leaves a person to find out which flow
 * by reading `flow_steps` by hand. A missing reader fails at RUN time, on a
 * flow that may be armed, for somebody who did not delete it.
 *
 * ⚠ **`?force=true` is read from the QUERY STRING and never from a body**, and
 * the panel only offers it after the refusal has been shown with its list. A
 * deliberate break is a real decision somebody may need to make; what it must
 * not be is the default, or something a caller can assert without ever having
 * seen the consequence.
 */
datasourcesRouter.delete(
  "/:dsId/operations/:name",
  asyncHandler(async (req, res) => {
    const out = await dbOperationService.remove(
      req.params.workspaceId,
      req.params.dsId,
      req.params.name,
      { force: req.query.force === "true" },
    );
    if (!out.ok) {
      return res.status(409).json({
        error: "referenced_by_flows",
        referencedBy: out.referencedBy,
        message:
          `"${req.params.name}" is still read by ${out.referencedBy.length} automation(s): ` +
          `${out.referencedBy.join(", ")}. Deleting it does not fail the edit — it fails the ` +
          `next RUN of each, with a reference nothing can resolve.`,
      });
    }
    if (!out.removed) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);

// ── the development sandbox ─────────────────────────────────────────────────
//
// READ ONLY over HTTP, deliberately (Stage 4). Provisioning generates rows with
// a model, drops and recreates a database and creates a role — a minutes-long,
// destructive, credential-creating operation, and the exact shape of the
// `POST /api/demo/provision` route Stage 1 deleted for being "a destructive
// reseed from one authenticated request". It is a CLI command:
//
//   pnpm --filter @foundry/server sandbox:provision --workspace=<id> --datasource=<name>
//
// What a browser gets is the state and the exposure sentence, which is what a
// person needs in order to decide whether a test run is safe to start.

datasourcesRouter.get(
  "/:dsId/sandbox",
  asyncHandler(async (req, res) => {
    const status = await sandboxService.status(req.params.workspaceId, req.params.dsId);
    if (!status) return res.status(404).json({ error: "not_found" });
    res.json({ sandbox: status });
  }),
);
