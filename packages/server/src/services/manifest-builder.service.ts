import type { DescribedQuery } from "./introspect/types.js";
import { withDeclaredTags } from "./query-column-tags.js";
import type { OutputShape } from "@foundry/flow-edit";
import { endpointKeyFor, outputShapeForEndpoint } from "./tool-output-shapes.js";
import crypto from "node:crypto";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { operationColumns } from "./db-operation-columns.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { modelVisible } from "./datasource-model-visibility.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { specParamOrder } from "./db-operation.service.js";
import { selectProjection } from "./sql-projection.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { schemaIntrospectorService } from "./schema-introspector.service.js";
import { manifestRepo } from "../repositories/manifest.repo.js";
import { detectInjection, type DetectionResult } from "../prompt-boundary/detect.js";
import { spansFromInventory, type InventoryDatasource } from "../prompt-boundary/spans.js";

// Renders the Workspace Manifest (MANIFEST_CONTRACT.md). Produces the full XML,
// the compact summary XML, a content hash, and versions it in the DB — inserting
// a new version only when the content hash changes.

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface RenderedManifest {
  version: number;
  hash: string;
  manifestXml: string;
  summaryXml: string;
  changed: boolean; // true when this render differs from the stored latest
  // FR-012/FR-013 (guardrail-port V4/V5/V8, research.md Decision 3). Computed
  // from the same tools/datasources/entities already assembled below — never
  // fed into hashBody, so a planted pattern changes this field and nothing
  // else (SC-003).
  warnings: DetectionResult;
}

const CONSTRAINTS = {
  language: "python",
  allowedPackages: "requests,psycopg2-binary,mysql-connector-python",
  writeArtifactsTo: "../artifacts/",
};

/**
 * A ref's fingerprint — `<ref>` → `sha256:…`.
 *
 * `tool_name` for a tool, `<datasource>.<query>` for a named query, and
 * `<datasource>.<operation>` for a DB operation: exactly the strings a flow
 * step puts in its `ref` field, so a step's captured refs and the current
 * manifest are comparable without a translation layer.
 */
export type RefFingerprints = Record<string, string>;

/**
 * A ref's PORTABLE call signature — see `refInterfaces` below for why this is a
 * separate concept from a fingerprint, and why treating them as one breaks flow
 * import.
 */
export interface RefInterface {
  kind: "tool" | "query" | "operation";
  /** Human- and model-readable, for findings. Not used for comparison. */
  signature: string;
  /** What the comparison actually runs on. In order for a query, sorted for a tool. */
  params: Array<{ name: string; type: string; required: boolean; format?: string; /** D-323: a catalogue-stated value (operations only). Not in `signature`. */ default?: string; /** A date compared by its month — declared by the operation's `month` filter. Not in `signature`. */ per?: string }>;
  /**
   * A named query's result columns as the DATABASE described them at registration (compiled-builder I-271): type,
   * nullability (conservative: any outer join ⇒ nullable) and a declared tag. Absent when never described.
   */
  columnTypes?: Array<{ name: string; type: string; nullable: boolean; tag: string | null }>;
  /**
   * A tool's declared output (compiled-builder 2c): its own `output_schema`, else the endpoint registry. Absent ⇒ the
   * output is `Opaque`. Not in `signature` (the import comparison reads names only).
   */
  outputShape?: OutputShape;
  /** The endpoint a tool calls (\`METHOD /path/template\`), for endpoint-keyed policy (2e). Absent for a non-Foundry endpoint. */
  endpoint?: string;
  /**
   * The column names each returned ROW carries — `operation` refs only.
   *
   * ⚠ **This is knowable EXACTLY, and until 2026-09-08 nothing used it.** A DB
   * operation is a structured spec that `compileOperation` turns into SQL, so
   * `specJson.columns[].alias` IS the key set of every object at
   * `.results[0].data[i]` — not a guess, not a sample, the projection itself.
   *
   * Its absence was a measured defect. `checkOutputShapes` validates the five
   * envelope keys and its docblock states the bound it believed: *"only the
   * tenant's data says whether `employees` exists."* That sentence was already
   * corrected once (the body is Foundry's envelope, hence checkable); it is
   * wrong a second time for the same reason, one level down, for an operation.
   * Meanwhile `catalogueText`'s `operationLine` rendered the operation's INPUTS
   * and nothing about its output, so a model was choosing column names from the
   * operation's *name*. Measured on this deployment: **14 of 29** transform
   * steps over an operation read a column the operation does not emit — and
   * only the ones feeding an email FAILED, because the mail route refuses a
   * null recipient. `sort_by(.created_at)` over all-null keys returns an
   * arbitrary row and the run goes GREEN. That is D-68's finding again.
   *
   * ⚠ **ABSENT means "this ref does not declare its output"** — a tool, a named
   * query (whose columns live in SQL text nothing here parses), or an operation
   * whose spec named no projection. Every consumer must say nothing in that
   * case, which is the `literalParamKeys` / `checkFlowParams` rule: cannot see,
   * so makes no claim.
   *
   * The field is OMITTED rather than set to `[]` because "it returns rows with
   * no columns" is a claim no operation can satisfy, and an empty array in an
   * API response reads as one. ⚠ **That is a presentation choice and nothing
   * depends on it** — `checkRefOutputFields` treats `[]` and absent identically,
   * and there is a test saying so. Do not write a comment here implying the
   * distinction is load-bearing; a perturbation setting `columns: []` turns
   * nothing red, which is exactly why this paragraph says so out loud (I-38).
   *
   * ⚠ **NOT in any fingerprint, and NOT in the import comparison.**
   * `refFingerprints` hashes `paramsSchema` (D-17) and never this object, so
   * adding this field moves no fingerprint and suspends no armed flow —
   * asserted by `manifest-fingerprint.test.ts`. `refInterfaces`' import check
   * compares `params` alone, which its own comment above states; a tenant's
   * operation legitimately projects different columns from another tenant's, so
   * comparing these across workspaces would be D-25's error exactly — a check
   * that fires always and therefore says nothing.
   */
  columns?: string[];
}

function sha(body: string): string {
  return "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * Canonical JSON — object keys sorted at every depth.
 *
 * A fingerprint compared across time is worthless if `JSON.stringify` key order
 * can move, and it can: `paramsSchema` is jsonb, and Postgres does not preserve
 * insertion order. Without this, re-saving a tool with no change at all would
 * suspend every flow that references it.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
}

/**
 * The workspace's `<triggers>` block — Phase 6.
 *
 * Every named `triggers` row renders as `<trigger type="…" name="…"/>` (the
 * type comes from the row, so webhook/api — and any existing manual/poll row —
 * all appear: the point is that the drafter sees every name that is taken).
 * Schedules never have a row, so each flow's DRAFT model is read for its
 * declared schedule and renders with `cron`/`timezone` attributes; a schedule's
 * identity is the flow it belongs to, so its `name` is the flow's kestra id.
 *
 * Deterministically ordered (rows by type then name, schedules by flow id) so
 * the content hash is stable. Renders the empty string — and therefore no
 * section at all — when the workspace has neither a named trigger row nor a
 * declared schedule.
 */
async function workspaceTriggersXml(workspaceId: string): Promise<string> {
  const [rows, flows] = await Promise.all([
    triggerRepo.listByWorkspace(workspaceId),
    flowRepo.listByWorkspace(workspaceId),
  ]);

  const entries: Array<{ type: string; name: string; cron?: string; timezone?: string }> = rows.map(
    (r) => ({ type: r.type, name: r.name }),
  );

  for (const flow of flows) {
    const revision = await flowRepo.getRevision(flow.id, flow.draftRevision);
    const modelJson = revision?.modelJson;
    const schedule: unknown =
      modelJson !== null && typeof modelJson === "object" && "schedule" in modelJson
        ? modelJson.schedule
        : undefined;
    const cron: unknown =
      schedule !== null && typeof schedule === "object" && "cron" in schedule ? schedule.cron : undefined;
    if (typeof cron !== "string") continue;
    const timezone: unknown =
      schedule !== null && typeof schedule === "object" && "timezone" in schedule
        ? schedule.timezone
        : undefined;
    entries.push({
      type: "schedule",
      name: flow.kestraFlowId,
      cron,
      ...(typeof timezone === "string" ? { timezone } : {}),
    });
  }

  if (!entries.length) return "";

  const sorted = entries.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
  const lines = sorted.map((t) => {
    const attrs = [`type="${xmlEscape(t.type)}"`, `name="${xmlEscape(t.name)}"`];
    if (t.cron !== undefined) attrs.push(`cron="${xmlEscape(t.cron)}"`);
    if (t.timezone !== undefined) attrs.push(`timezone="${xmlEscape(t.timezone)}"`);
    return `    <trigger ${attrs.join(" ")}/>`;
  });
  return `  <triggers>\n${lines.join("\n")}\n  </triggers>`;
}

/**
 * A tool's ref fingerprint — the workspace's rows, and (plans/personal-actions-2026-10-29) an action a person switched on
 * for themselves. ⚠ For a PERSONAL tool the credential's name is left out: which of the person's own connections a
 * workflow uses is pinned in its approved revision (`model.accounts`), so adding a second connection of their own must
 * not read as the action changing shape.
 */
export function toolFingerprint(t: Pick<Tool, "method" | "url" | "paramsSchema" | "authStyle" | "authParamName" | "secretEnvName">, opts: { personal?: boolean } = {}): string {
  return sha(
    canonical({
      kind: "tool",
      method: t.method ?? null,
      url: t.url ?? null,
      params: t.paramsSchema ?? null,
      // ⚠ HARDCODED `false`, and it must stay. This object is the ref
      // fingerprint's hash payload, and a fingerprint change means STALE: it
      // routes through `checkStaleness` → `markStale` → `status: "suspended"`,
      // which unarms the flow and removes its Kestra schedule.
      //
      // `tools.is_dummy` is gone, and every row it ever held was `false`. Dropping
      // the key would change every tool's fingerprint in every workspace, and the
      // next sweep would suspend every armed flow — reporting "the shape changed"
      // for a capability that was never used. A field's REMOVAL is not a shape
      // change; this keeps the payload saying what it always said.
      //
      // Delete this line only alongside a deliberate re-approval of every armed
      // flow.
      isDummy: false,
      authStyle: t.authStyle ?? null,
      authParamName: t.authParamName ?? null,
      // The NAME, never the value.
      secretEnvName: opts.personal ? "(the person's own)" : (t.secretEnvName ?? null),
    }),
  );
}

export const manifestBuilderService = {
  /**
   * Render + persist the current manifest for a workspace. Idempotent: if the
   * content hash matches the latest stored version, no new row is inserted and
   * `changed: false` is returned with the existing version.
   */
  async buildAndPersist(workspaceId: string): Promise<RenderedManifest> {
    const tools = await toolRepo.listByWorkspace(workspaceId);
    const datasources = await datasourceRepo.listByWorkspace(workspaceId);
    const allOperations = await dbOperationRepo.listByWorkspace(workspaceId);

    // Deterministic ordering for a stable content hash (MANIFEST_CONTRACT §5).
    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    /**
     * ⚠ **A PAUSED datasource is not rendered — not its schema, not its
     * operations, and not its spans for the injection detector.** The manifest
     * is most of a generation prompt, so this is the half of "pause" that does
     * the work: a table nobody wants the drafter reaching for stops being in
     * front of it.
     *
     * ⚠ The content hash therefore moves, and that is correct: what the agent
     * is told genuinely changed, so a new manifest version is the honest
     * record. It moves NO ref fingerprint — `refFingerprints()` below reads
     * tools, queries and operations directly and is deliberately NOT filtered,
     * because a fingerprint change suspends every armed flow that reads the
     * source and removes its Kestra schedule. `datasource-model-visibility.ts`
     * carries the full argument, `datasource-pause-boundary.test.ts` pins it,
     * and I-40 is the precedent for checking this before changing what the
     * manifest renders.
     */
    const sortedDs = modelVisible([...datasources], (d) => d).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const operationsByDs = new Map<string, typeof allOperations>();
    for (const row of allOperations) {
      const bucket = operationsByDs.get(row.operation.datasourceId) ?? [];
      bucket.push(row);
      operationsByDs.set(row.operation.datasourceId, bucket);
    }
    for (const bucket of operationsByDs.values()) {
      bucket.sort((a, b) => a.operation.name.localeCompare(b.operation.name));
    }

    // ── Triggers — Phase 6 ───────────────────────────────────────────────────
    //
    // Two sources, one section:
    //  * webhook/api (and any other named) triggers exist as `triggers` ROWS —
    //    materialised when their flow was saved — so the drafter sees every
    //    name that is already taken and does not collide with one.
    //  * schedule triggers never have a row (Kestra owns crons; the cron lives
    //    on the flow's model), so each flow's DRAFT model is read for its
    //    schedule. The schedule's "name" is its flow's kestra flow id — a
    //    schedule IS the flow's, and that id is what identifies it.
    const triggerXml = await workspaceTriggersXml(workspaceId);

    // --- full manifest XML ---
    const toolXml = sortedTools
      .map((t) => {
        // `kind` is emitted as the LITERAL "real" rather than removed. Dummy tools
        // are gone (see tool.service.ts), so the attribute has one possible value —
        // but the manifest XML is CONTENT-HASHED, and dropping the attribute would
        // change that hash for every workspace, inserting a new manifest version that
        // describes no actual change. Keeping the bytes identical is what makes this
        // deletion invisible to anything downstream. Do not "tidy" it away.
        const attrs = `name="${xmlEscape(t.name)}" kind="real" method="${xmlEscape(t.method ?? "")}" url="${xmlEscape(t.url ?? "")}"`;
        const parts: string[] = [];
        if (t.description) parts.push(`      <description>${xmlEscape(t.description)}</description>`);
        if (t.paramsSchema && typeof t.paramsSchema === "object") {
          // ⚠ `description` is rendered, and for a long time it was not.
          //
          // Every tool in the catalogue carries per-parameter prose — `sender:
          // "From address"`, `recipients: "One address or an array of up to 50"`
          // — stored in `paramsSchema` since the tools were written. The manifest
          // emitted `name`/`type`/`required` and dropped it, so the drafter saw
          // that `mail_send` takes a `recipients` array and never learnt what
          // belongs in it. The tool's own `<description>` had to carry every
          // parameter's meaning in one paragraph, which is why those
          // descriptions had grown to name their parameters by hand.
          //
          // Safe against the staleness sweep, and this is the check that matters:
          // `refFingerprints()` hashes `t.paramsSchema` WHOLE, descriptions
          // included, so it is unchanged by rendering more of it. The manifest's
          // own hash does change — a new manifest version, which is correct,
          // because what the agent is told genuinely changed.
          const params = Object.entries(
            t.paramsSchema as Record<
              string,
              { type?: string; required?: boolean; description?: string; format?: string }
            >,
          )
            .map(([pname, p]) => {
              const attrs =
                `name="${xmlEscape(pname)}" type="${xmlEscape(p?.type ?? "string")}" ` +
                `required="${p?.required ? "true" : "false"}"` +
                // Absent format renders nothing: unconstrained prose is the
                // default and existing manifests without it stay byte-identical.
                (p?.format ? ` format="${xmlEscape(p.format)}"` : "");
              return p?.description
                ? `        <param ${attrs}>${xmlEscape(p.description)}</param>`
                : `        <param ${attrs}/>`;
            })
            .join("\n");
          if (params) parts.push(`      <params>\n${params}\n      </params>`);
        }
        // A `<responseTemplate>` element was emitted here for dummy tools. No tool
        // was ever dummy, so it never appeared in a real manifest — removing it
        // cannot change any existing hash.
        if (t.secretEnvName) {
          parts.push(`      <secretRef env="${xmlEscape(t.secretEnvName)}"/>`);
          // WS-B.4 — say HOW to present it. `<secretRef>` alone told the agent a
          // key exists but not where it goes, so it had to guess between
          // `Authorization: Bearer`, `X-API-Key`, a query param and basic auth —
          // and a wrong guess is a 401 the audit calls `clean`. `style` names a
          // convention the prompt states once, so the agent reads it instead.
          if (t.authStyle) {
            const nameAttr =
              t.authStyle === "header" || t.authStyle === "query"
                ? ` name="${xmlEscape(t.authParamName ?? "")}"`
                : "";
            parts.push(
              `      <auth style="${xmlEscape(t.authStyle)}"${nameAttr} env="${xmlEscape(t.secretEnvName)}"/>`,
            );
          }
        }
        return `    <tool ${attrs}>\n${parts.join("\n")}\n    </tool>`;
      })
      .join("\n");

    const dsXmlParts: string[] = [];
    // Collected alongside the render for spansFromInventory (FR-012) — the same
    // entities already fetched below, no extra query (research.md Decision 3).
    const dsInventory: unknown[] = [];
    for (const d of sortedDs) {
      const entities = await schemaIntrospectorService.getStored(d.id);
      dsInventory.push({ name: d.name, type: d.type, entities });
      const tablesXml = entities
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const cols = (e.columns as Array<Record<string, unknown>>)
            .map((c) => {
              const a = [`name="${xmlEscape(String(c.name))}"`, `type="${xmlEscape(String(c.type ?? ""))}"`];
              if (c.isPrimaryKey) a.push(`pk="true"`);
              if (c.isForeignKey && c.foreignKeyReference) a.push(`fk="${xmlEscape(String(c.foreignKeyReference))}"`);
              if (c.nullable === false) a.push(`nullable="false"`);
              return `          <column ${a.join(" ")}/>`;
            })
            .join("\n");
          // WS-C.4: a null estimate renders NOTHING. It used to become `~-1` for a
          // never-analysed table, which is a confident false statement.
          const rowsEst = e.rowCountEstimate != null ? ` rowsEstimate="~${e.rowCountEstimate}"` : "";
          // WS-C.2: say what it IS. A view is not a table — it may be
          // non-updatable, its row estimate is meaningless, and the safest
          // production wiring (WS-A.7) exposes views rather than base tables, so
          // in production most of this list will be views.
          const kindAttr = e.entityType !== "table" ? ` kind="${xmlEscape(e.entityType)}"` : "";
          // WS-C.1: a NAMED schema must be rendered, because the agent has to
          // write `hr.presence_rollup` — an unqualified name only resolves for
          // schemas on the connection's search_path. `public` is on it by default,
          // so omitting that one keeps existing manifests byte-identical (and their
          // content hash stable); anything else is stated.
          const schemaAttr =
            e.schema && e.schema !== "public" ? ` schema="${xmlEscape(e.schema)}"` : "";
          return `        <table name="${xmlEscape(e.name)}"${schemaAttr}${kindAttr}${rowsEst}>\n${cols}\n        </table>`;
        })
        .join("\n");
      const secretRef = d.secretEnvName ? `      <secretRef env="${xmlEscape(d.secretEnvName)}"/>\n` : "";
      // ── DB operations — Phase 4. Rendered per datasource, only when present ──
      //
      // Named queries stay OUT of the manifest XML (stated in
      // `flow-generation.service.ts`) — they are hand-written SQL and their
      // parameters are visible in the catalogue. Operations are different: a
      // saved operation is a named component a step can call, and the drafter
      // must see its name, description and parameter contract. Only the
      // SPEC's structure is rendered — never a stored value, and never data.
      const opsForDs = operationsByDs.get(d.id) ?? [];
      const operationsXml = opsForDs.length
        ? `      <operations>\n` +
          opsForDs
            .map(({ operation: o }) => {
              const attrs =
                `name="${xmlEscape(o.name)}"` +
                (o.description ? ` description="${xmlEscape(o.description)}"` : "");
              const params = Object.entries(
                (o.paramsSchema ?? {}) as Record<
                  string,
                  { type?: string; required?: boolean; description?: string }
                >,
              ).map(([pname, p]) => {
                const pAttrs =
                  `name="${xmlEscape(pname)}" type="${xmlEscape(p?.type ?? "string")}" ` +
                  `required="${p?.required ? "true" : "false"}"`;
                return p?.description
                  ? `          <param ${pAttrs}>${xmlEscape(p.description)}</param>`
                  : `          <param ${pAttrs}/>`;
              });
              return params.length
                ? `        <operation ${attrs}>\n${params.join("\n")}\n        </operation>`
                : `        <operation ${attrs}/>`;
            })
            .join("\n") +
          `\n      </operations>\n`
        : "";
      dsXmlParts.push(
        `    <datasource name="${xmlEscape(d.name)}" type="${xmlEscape(d.type)}">\n${secretRef}      <schema>\n${tablesXml}\n      </schema>\n${operationsXml}    </datasource>`,
      );
    }

    const constraintsXml = `  <constraints language="${CONSTRAINTS.language}" allowedPackages="${xmlEscape(CONSTRAINTS.allowedPackages)}" writeArtifactsTo="${xmlEscape(CONSTRAINTS.writeArtifactsTo)}"/>`;

    // --- content hash (excludes version/generatedAt/hash metadata) ---
    const hashBody = `${constraintsXml}\n<tools>\n${toolXml}\n</tools>\n<datasources>\n${dsXmlParts.join("\n")}\n</datasources>${triggerXml ? `\n${triggerXml}` : ""}`;
    const hash = "sha256:" + crypto.createHash("sha256").update(hashBody).digest("hex");

    // FR-012/FR-013 — computed from the same tools/entities above, over the same
    // inventory shape provenance framing (US1) reads. Never mixed into hashBody:
    // a warning changes this field alone, never the manifest or its hash (SC-003).
    const warnings = detectInjection(
      spansFromInventory({
        tools: sortedTools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          method: t.method ?? null,
          url: t.url ?? null,
          paramsSchema: t.paramsSchema ?? null,
          secretEnvName: t.secretEnvName ?? null,
          authStyle: t.authStyle ?? null,
          authParamName: t.authParamName ?? null,
        })),
        datasources: dsInventory as InventoryDatasource[],
      }),
    );

    const latest = await manifestRepo.getLatest(workspaceId);
    if (latest && latest.hash === hash) {
      return {
        version: latest.version,
        hash,
        manifestXml: latest.manifestXml,
        summaryXml: latest.summaryXml,
        changed: false,
        warnings,
      };
    }

    const version = (latest?.version ?? 0) + 1;

    // Byte-identical to the pre-Phase-6 manifest when the workspace has no
    // triggers: `triggerBlock` is empty, so `</datasources>` is followed by
    // exactly the same `\n</workspaceManifest>` as before.
    const triggerBlock = triggerXml ? `\n${triggerXml}` : "";
    const manifestXml = `<workspaceManifest version="${version}" workspaceId="${xmlEscape(workspaceId)}" hash="${hash}">
${constraintsXml}
  <tools>
${toolXml}
  </tools>
  <datasources>
${dsXmlParts.join("\n")}
  </datasources>${triggerBlock}
</workspaceManifest>`;

    // --- summary XML ---
    const toolSummary = sortedTools
      // Literal "real" for the same hash-stability reason as the full manifest above.
      .map((t) => `${t.name}(${t.method ?? "?"},real)`)
      .join(", ");
    const dsSummaryParts: string[] = [];
    const secretNames = new Set<string>();
    for (const d of sortedDs) {
      if (d.secretEnvName) secretNames.add(d.secretEnvName);
      const entities = await schemaIntrospectorService.getStored(d.id);
      const tableNames = entities
        .map((e) => {
          const qualified = e.schema ? `${e.schema}.${e.name}` : e.name;
          return e.entityType === "table" ? qualified : `${qualified}(${e.entityType})`;
        })
        .join(", ");
      dsSummaryParts.push(
        `    <ds name="${xmlEscape(d.name)}" type="${xmlEscape(d.type)}" tables="${xmlEscape(tableNames)}"/>`,
      );
    }
    for (const t of sortedTools) if (t.secretEnvName) secretNames.add(t.secretEnvName);

    const summaryXml = `<manifestSummary version="${version}" hash="${hash}" file=".foundry/manifest.xml">
  <tools>${xmlEscape(toolSummary)}</tools>
  <datasources>
${dsSummaryParts.join("\n")}
  </datasources>
  <secrets>${xmlEscape([...secretNames].join(", "))}</secrets>
  <constraints language="${CONSTRAINTS.language}"/>
</manifestSummary>`;

    await manifestRepo.insert({ workspaceId, version, hash, manifestXml, summaryXml });

    return { version, hash, manifestXml, summaryXml, changed: true, warnings };
  },

  getLatest(workspaceId: string) {
    return manifestRepo.getLatest(workspaceId);
  },

  /**
   * A stable fingerprint for every callable ref in a workspace (§6.5, task 3.5).
   *
   * ── Why not just use the manifest hash ────────────────────────────────────
   *
   * The manifest hash covers the whole workspace, so registering an unrelated
   * tool would change it — and staleness computed from it would suspend every
   * approved schedule in the workspace for a change none of them can see. §6.5
   * says exactly that: *"Manifest version bump with no ref change → No effect."*
   * So this is per REF.
   *
   * ── What goes in, and the one judgement call ──────────────────────────────
   *
   * A tool's fingerprint covers its callable surface: method, URL, parameters,
   * and the auth STYLE plus the env-var NAME. Never a secret value — §6.5 is
   * explicit that rotating a secret has no effect, because a step binds to the
   * name.
   *
   * For a named query it covers the parameter contract AND `sql_text`, which is
   * the judgement call. A query's SQL reads like a body rather than a shape, and
   * §6.5's table names "changes shape". But an approver signed off on what the
   * flow DOES, and editing the SQL of a query an approved flow calls changes
   * that without producing a new revision — the same privilege-escalation-by-
   * editing the revision binding exists to prevent, one level down. Being
   * conservative costs a re-approval; being permissive costs the guarantee.
   */
  async refFingerprints(workspaceId: string): Promise<RefFingerprints> {
    const out: RefFingerprints = {};

    for (const t of await toolRepo.listByWorkspace(workspaceId)) out[t.name] = toolFingerprint(t);

    for (const { query, datasource } of await datasourceQueryRepo.listByWorkspace(workspaceId)) {
      out[`${datasource.name}.${query.name}`] = sha(
        canonical({
          kind: "datasource_query",
          // A postgres → mysql swap changes the dialect a bound query runs in.
          datasourceType: datasource.type,
          paramOrder: query.paramOrder ?? [],
          params: query.paramsSchema ?? null,
          sql: query.sqlText,
        }),
      );
    }

    for (const { operation, datasource } of await dbOperationRepo.listByWorkspace(workspaceId)) {
      out[`${datasource.name}.${operation.name}`] = sha(
        canonical({
          kind: "operation",
          // A postgres → mysql swap changes the dialect a bound operation runs in.
          datasourceType: datasource.type,
          // The VISUAL SPEC is the operation's whole shape — base table,
          // columns, joins, filters, sort, limit — and every identifier in it
          // was resolved against the introspected schema when it was saved, so
          // this object can never hold a VALUE. Editing a filter's param NAME
          // changes the call signature and must invalidate an approval;
          // editing a filter's value is impossible by construction — values
          // arrive at runtime, bound positionally.
          spec: operation.specJson ?? null,
          params: operation.paramsSchema ?? null,
          // The compiled statement is what actually executes. A compiler change
          // that rewrites the SQL must read as a shape change, exactly as
          // editing a named query's `sql_text` does.
          sql: operation.compiledSql ?? null,
        }),
      );
    }

    return out;
  },

  /**
   * The **portable INTERFACE** of every callable ref — its parameter signature,
   * and deliberately NOT its implementation. Phase 6.2/6.3.
   *
   * ── This is not `refFingerprints`, and confusing the two breaks import ──────
   *
   * `refFingerprints` above includes a named query's `sql_text` on purpose: an
   * approver signed off on what the flow does, so editing that SQL must
   * invalidate the approval. Correct *within* one tenant.
   *
   * Across tenants it is exactly wrong. The SQL is what is SUPPOSED to differ:
   * `hr_demo.attendance_below_threshold` selects from `attendance_monthly` with
   * rates as percentages, and the rehearsal tenant's equivalent selects from a
   * view with rates as fractions. Comparing fingerprints at import would report
   * "every ref changed" for two workspaces that are correctly configured, which
   * is a check that fires always and therefore says nothing.
   *
   * What genuinely has to agree for a flow to travel is the **call signature** —
   * the parameter names a `paramsExpr` supplies, in the order a bound query
   * expects them. So that, and nothing else, is what an export records and an
   * import compares.
   *
   * ⚠ **It says nothing about the returned columns, and cannot.** A query that
   * matches signatures and returns `presence_rate` as 0–1 where the origin
   * returned `attendance_rate` as 0–100 passes this check and produces a
   * confidently wrong answer. That gap is real, it is measured by the negative
   * control in `kestra:phase6`, and the only thing that closes it is running the
   * imported flow against the importing tenant's oracle.
   */
  async refInterfaces(workspaceId: string): Promise<Record<string, RefInterface>> {
    const out: Record<string, RefInterface> = {};

    for (const t of await toolRepo.listByWorkspace(workspaceId)) {
      const params = Object.entries(
        (t.paramsSchema ?? {}) as Record<string, { type?: string; required?: boolean; format?: string }>,
      )
        // Sorted: a tool's params are named, so declaration order is not part of
        // its signature and two workspaces must not disagree over it.
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, p]) => ({
          name,
          type: p?.type ?? "string",
          required: !!p?.required,
          // Machine format for feeder-compatibility checks (absent =
          // unconstrained prose, never blocking). NOT in `signature`: the
          // import comparison reads names only, and a format tightens the
          // contract without renaming anything.
          ...(typeof p?.format === "string" ? { format: p.format } : {}),
        }));
      const outputShape = (t.outputSchema as OutputShape | null) ?? outputShapeForEndpoint(t.url, t.method);
      const endpoint = endpointKeyFor(t.url, t.method);
      out[t.name] = {
        kind: "tool",
        params,
        ...(outputShape ? { outputShape } : {}),
        ...(endpoint ? { endpoint } : {}),
        signature:
          `tool ${t.method ?? "POST"}(` +
          params.map((p) => `${p.name}:${p.type}${p.required ? "!" : "?"}`).join(",") +
          `)`,
      };
    }

    for (const { query, datasource } of await datasourceQueryRepo.listByWorkspace(workspaceId)) {
      // `paramOrder` is kept IN ORDER — it maps onto `$1, $2` in the bound SQL.
      // Every bound parameter is required by construction: a positional
      // placeholder with nothing to bind is an error, not a default.
      // ⚠ compiled-builder G13: the DATABASE's type for each parameter, from the description stored at registration,
      // becomes its `format` (date / datetime). 22 of 27 date parameters were declared `string` with the format only in
      // prose, so a text input into a date parameter type-checked and failed at run time. `type` is left as declared.
      const described = (query.describedJson ?? null) as DescribedQuery | null;
      const params = (query.paramOrder ?? []).map((name, i) => {
        const pg = described?.params[i]?.type ?? "";
        const declared = ((query.paramsSchema ?? {}) as Record<string, { type?: string; format?: string }>)[name];
        // The database's own type first; else the format the query DECLARES (a month its SQL parses, which the database
        // types as text).
        const format = /^date$/.test(pg) ? "date" : /^timestamp/.test(pg) ? "datetime" : typeof declared?.format === "string" ? declared.format : undefined;
        return {
          name,
          type: declared?.type ?? "string",
          required: true,
          ...(format ? { format } : {}),
        };
      });
      /**
       * ⚠ **The hole this file named, closed — 2026-09-17.** `RefInterface`'s
       * own docblock said columns are knowable for an operation but not for
       * "a named query, whose columns live in SQL text nothing here parses."
       * `selectProjection` parses it, so a named query now declares its
       * projection too and `checkRefOutputFields` can see a step reading a
       * column it does not return.
       *
       * ⚠ Still `undefined` rather than `[]` whenever the statement cannot be
       * read with certainty — a star, a set operation, an unaliased expression.
       * The distinction is load-bearing and the field's docblock says why: an
       * empty array is a claim that the query projects NOTHING, which would
       * report every downstream read as unknown and block every save.
       */
      // The database's description wins over parsing the SQL (compiled-builder I-271): `selectProjection` returns
      // nothing for a statement it cannot read with certainty, which is how R04's missing-column reads went unseen.
      const columns = described?.columns.length ? described.columns.map((c) => c.name) : selectProjection(query.sqlText);
      out[`${datasource.name}.${query.name}`] = {
        kind: "query",
        params,
        ...(columns && columns.length > 0 ? { columns } : {}),
        // A computed column's tag is the query owner's declaration (query-column-tags.ts); a refused one is simply not applied.
        ...(described?.columns.length ? { columnTypes: withDeclaredTags(described.columns, query.columnTags).columns } : {}),
        // The datasource TYPE is in, because a bound query is dialect-specific
        // and a postgres flow does not travel to a mysql tenant unexamined.
        signature: `query ${datasource.type}(${params.map((p) => p.name).join(",")})`,
      };
    }

    for (const { operation, datasource } of await dbOperationRepo.listByWorkspace(workspaceId)) {
      // An operation's param ORDER is its spec's encounter order — `latestOne`
      // inner conditions first, then `filters[]`, then `having` — because the
      // compiler numbers positions in exactly that order. `paramsSchema` is
      // a flat map and cannot supply an order; the fallback is sorted names,
      // matching what the catalogue renderer does for the same gap. A param
      // the top-level filters never name (lateral lookups, post-aggregation
      // filters) is still declared: it binds a placeholder, so omitting it
      // would refuse a step that passes it.
      const described = (operation.paramsSchema ?? {}) as Record<string, { type?: string; default?: string; format?: string; per?: string }>;
      const inSpecOrder = specParamOrder(operation.specJson);
      const order = [...new Set(inSpecOrder.length > 0 ? inSpecOrder : Object.keys(described).sort())];
      const params = order.map((name) => ({
        name,
        type: described[name]?.type ?? "string",
        // Positional binding ⇒ every bound parameter is required, exactly as
        // for a named query.
        required: true,
        ...(typeof described[name]?.default === "string" ? { default: described[name]!.default } : {}),
        // The shape its author declared (`paramFormats`) — a column the database types as text can hold months.
        ...(typeof described[name]?.format === "string" ? { format: described[name]!.format! } : {}),
        ...(typeof described[name]?.per === "string" ? { per: described[name]!.per! } : {}),
      }));
      // The projection, in the spec's own order. `alias` is what the compiled
      // SQL says `AS`, so it is the key the row arrives under; `column` is the
      // fallback for a spec that named no alias, which compiles to the bare
      // column name. A spec with no `columns` array leaves this UNDEFINED
      // rather than empty — see the field's docblock for why that matters.
      const columns = operationColumns(operation.specJson);

      out[`${datasource.name}.${operation.name}`] = {
        kind: "operation",
        params,
        ...(columns && columns.length > 0 ? { columns } : {}),
        // The datasource TYPE is in for the same dialect reason as a query.
        signature: `operation ${datasource.type}(${params.map((p) => p.name).join(",")})`,
      };
    }

    return out;
  },

  /**
   * Collapse the refs a revision uses into one comparable value.
   *
   * Sorted, so the aggregate does not depend on the order steps happened to be
   * written in. A ref that has DISAPPEARED fingerprints as `"<missing>"` rather
   * than being skipped — a deleted tool must read as a change, and skipping it
   * would make deletion the one edit that never invalidates an approval.
   */
  aggregateFingerprint(refs: string[], current: RefFingerprints): string {
    const body = [...new Set(refs)]
      .sort()
      .map((r) => `${r}=${current[r] ?? "<missing>"}`)
      .join("\n");
    return sha(body);
  },
};
