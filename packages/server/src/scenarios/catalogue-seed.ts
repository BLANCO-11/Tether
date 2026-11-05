/**
 * `pnpm catalogue:seed` — GIVE EACH WORKSPACE A REAL CATALOGUE.
 *
 * ── What it fixes, measured ─────────────────────────────────────────────────
 *
 * Four workspaces held THREE tools and ONE DB operation each. Consequences,
 * both measured rather than suspected:
 *
 *  · Every automation anybody could build was "read the one thing, email it".
 *    A demo with one flow shape does not show a branch, a digest or a report.
 *  · `needs_component` fired ZERO times across eleven chat conversations,
 *    because a reusable-looking reader always existed — so flows reused it
 *    even where it was wrong (`past_due_orders` for "unshipped orders",
 *    `expiring_offers` for "where every candidate is in the process").
 *  · The single reader per domain projected no contact address, so a drafted
 *    notification wrote `{to: [.customer_email]}` against rows that have no
 *    such column. 14 of 29 transform steps had that defect and most ran GREEN.
 *
 * ── ⚠ WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────
 *
 * It does NOT re-run a provisioner. `generic:seed` reseeds the domain databases,
 * which would re-materialise every sandbox from a fresh introspection and throw
 * away the frozen fixtures every draft run currently reads. This adds rows to
 * `datasource_operations` and `tools` and writes two secrets; nothing else.
 *
 * It does NOT delete anything without `--prune`, and `--prune` removes only the
 * FOUR original single operations, by name, and only once no flow references
 * them — reported, never assumed.
 *
 * ⚠ Idempotent: an operation whose name exists is left alone (`create` is not an
 * upsert — a silent overwrite would replace the spec a `query` step was
 * approved against). Re-run it freely.
 */
import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { SCHEMA_ONLY_TWINS } from "../demo/heldout/seal.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { dbOperationBodySchema, dbOperationService } from "../services/db-operation.service.js";
import { toolService, createToolSchema } from "../services/tool.service.js";
import { workspaceSecretService } from "../services/workspace-secret.service.js";
import {
  OPS_AUTH_STYLE,
  OPS_SECRET_ENV,
  opsServiceKey,
} from "../services/ops-client.service.js";
import { LEAN_OPS_SERVICES, leanToolCatalogue } from "../demo/lean-catalogue.js";
import { CATALOGUE_OPERATIONS } from "../demo/catalogue/operations.js";

/** Datasource name → the `ACTION_WORDS` key its workspace uses. */
const DOMAIN_KEY: Record<string, string> = {
  finance_demo: "finance",
  support_demo: "support",
  orders_demo: "orders",
  hiring_demo: "hiring",
};

/** The one-reader-per-domain rows this replaces. Removed only with `--prune`. */
const SUPERSEDED = new Set([
  "past_due_orders",
  "support_tickets",
  "expiring_offers",
  "overdue_invoices",
]);

function head(s: string) {
  console.log(`\n\x1b[1m${s}\x1b[0m`);
}

async function main() {
  const prune = process.argv.includes("--prune");
  // D-323: write the declared defaults onto readers that ALREADY exist, and nothing else — no tool rewrite, no new reader.
  // A full run on 2026-09-26 created 15 readers in workspaces measured without them; this is the mode that cannot.
  const defaultsOnly = process.argv.includes("--defaults-only");
  console.log(`catalogue:seed — ops-api at ${config.opsApiBase}${prune ? "  (--prune)" : ""}`);

  const workspaces = await workspaceRepo.list();
  let opsCreated = 0;
  let opsSkipped = 0;
  let opsFailed = 0;
  let toolsCreated = 0;

  for (const ws of workspaces) {
    if (ws.deletedAt) continue;
    // ⚠ The held-out twins share the curated DATABASES and must hold ZERO saved readers (heldout:seed asserts it): matching
    // by datasource name alone seeded 9 readers into them on 2026-09-26. A twin is never this seeder's to touch.
    if (SCHEMA_ONLY_TWINS.includes(ws.name)) { console.log(`\n  (skipped ${ws.name} — a schema-only twin)`); continue; }
    const datasources = await datasourceRepo.listByWorkspace(ws.id);
    const seeded = datasources.filter((d) => CATALOGUE_OPERATIONS[d.name]);
    if (!seeded.length) continue;

    head(`${ws.name}`);

    // ── 1. credentials for every service this workspace may reach ───────────
    //
    // ⚠ `ticketing` and `chat` are NEW members of `LEAN_OPS_SERVICES`, so a
    // workspace provisioned before today holds no key for either and every
    // call would 401 — the refusal being at the service is exactly what makes
    // the catalogue's absences a control, and it cuts both ways.
    for (const service of LEAN_OPS_SERVICES) {
      await workspaceSecretService.put(
        ws.id,
        OPS_SECRET_ENV[service],
        opsServiceKey(service),
        `ops-api ${service} credential (${OPS_AUTH_STYLE[service].style}; synthetic, derived from OPS_API_KEY).`,
      );
    }

    // ── 2. tools, upsert by name ────────────────────────────────────────────
    const key = DOMAIN_KEY[seeded[0].name];
    if (!defaultsOnly) {
    const existingTools = new Map(
      (await toolRepo.listByWorkspace(ws.id)).map((t) => [t.name, t]),
    );
    for (const t of leanToolCatalogue(key)) {
      const found = existingTools.get(t.name);
      if (found) {
        await toolService.update(ws.id, found.id, {
          url: t.url,
          method: t.method,
          description: t.description,
          paramsSchema: t.paramsSchema,
          secretEnvName: t.secretEnvName ?? null,
          authStyle: t.authStyle ?? null,
          authParamName: t.authParamName ?? null,
        });
      } else {
        await toolService.create(ws.id, createToolSchema.parse(t));
        toolsCreated++;
        console.log(`  + tool  ${t.name}`);
      }
    }
    }

    // ── 3. the readers ──────────────────────────────────────────────────────
    for (const ds of seeded) {
      const existing = await dbOperationRepo.listByDatasource(ds.id);
      const have = new Set(existing.map((o) => o.name));
      for (const seed of CATALOGUE_OPERATIONS[ds.name]) {
        if (have.has(seed.name)) {
          // D-323: a reader seeded before its constants were declared gets them now — only the defaults move (a PATCH keeps
          // the stored spec and prose), and only when they differ, so a re-run is a no-op.
          const stored = (existing.find((o) => o.name === seed.name)?.paramsSchema ?? {}) as Record<string, { default?: string; format?: string }>;
          const stale = Object.entries(seed.defaults ?? {}).filter(([k, v]) => stored[k]?.default !== v);
          // Formats the same way (2026-09-29): a reader seeded before its formats were declared gets them now.
          const staleFmt = Object.entries(seed.formats ?? {}).filter(([k, v]) => stored[k]?.format !== v);
          if (stale.length || staleFmt.length) {
            await dbOperationService.update(ws.id, ds.id, seed.name, { ...(seed.defaults ? { paramDefaults: seed.defaults } : {}), ...(seed.formats ? { paramFormats: seed.formats } : {}) });
            console.log(`  ~ ${ds.name}.${seed.name}  (${[...stale.map(([k, v]) => `${k}=${v}`), ...staleFmt.map(([k, v]) => `${k} is a ${v}`)].join(", ")})`);
            continue;
          }
          opsSkipped++;
          console.log(`  = ${ds.name}.${seed.name}  (exists)`);
          continue;
        }
        if (defaultsOnly) { console.log(`  · ${ds.name}.${seed.name}  (absent; --defaults-only creates nothing)`); continue; }
        try {
          // ⚠ Parsed through the body schema rather than cast: the spec's
          // `joins`/`filters`/`sort` carry `.default([])`, which only applies on
          // parse, and `create` takes the OUTPUT type. Casting past it would
          // hand the compiler `undefined` where it expects an array — and it is
          // the same schema a route applies, so a spec that only works here
          // would not work from the UI.
          const { operation } = await dbOperationService.create(
            ws.id,
            ds.id,
            dbOperationBodySchema.parse({
              name: seed.name,
              description: seed.description,
              spec: seed.spec,
              paramDescriptions: seed.params,
              ...(seed.defaults ? { paramDefaults: seed.defaults } : {}),
              ...(seed.formats ? { paramFormats: seed.formats } : {}),
            }),
          );
          opsCreated++;
          const cols = (operation.paramsSchema ?? {}) as Record<string, unknown>;
          console.log(
            `  + ${ds.name}.${seed.name}  (${Object.keys(cols).join(", ") || "no params"})`,
          );
        } catch (e) {
          opsFailed++;
          // ⚠ Printed in FULL, findings and all. A compile finding names the
          // offending identifier and what was available, and truncating it
          // would leave a spec that cannot be fixed without re-running.
          console.log(`  ✗ ${ds.name}.${seed.name}`);
          console.log(`      ${(e as Error).message}`);
          const findings = (e as { findings?: unknown }).findings;
          if (findings) console.log(`      ${JSON.stringify(findings)}`);
        }
      }

      // ── 4. the superseded single readers ──────────────────────────────────
      const superseded = [...have].filter((n) => SUPERSEDED.has(n));
      for (const name of superseded) {
        // Which flows still name it. Reported either way, because a removal
        // that breaks a stored revision is worse than a stale row.
        // ⚠ `getRevision`, NOT `listRevisions`. `listRevisions` is the ONE
        // place `hidden_at` is honoured — it serves the version list — and a
        // chat turn writes its revision ALREADY HIDDEN. Using it here would
        // report "unreferenced" for an operation every chat-built flow reads,
        // which is this morning's inspector bug in a destructive place.
        //
        // ⚠ Its BOUND, stated rather than left to be discovered: only the
        // DRAFT and the ARMED revision are checked. An intermediate revision
        // that named the operation and has since been edited past is not — it
        // cannot be run or armed, but a replay of an old execution would still
        // resolve against it. `--prune` is therefore for a slate somebody has
        // decided about, not routine hygiene.
        // ⚠ The scan moved into `dbOperationService.referencingFlows` — the
        // delete route needed the same answer, and two copies of "is this
        // reader still referenced" drift in the direction where the untested
        // one says no, which is the destructive answer (D-197). Every caveat
        // above is now that function's docblock, kept verbatim.
        const refs = await dbOperationService.referencingFlows(ws.id, `${ds.name}.${name}`);
        if (refs.length) {
          console.log(
            `  ! ${ds.name}.${name} is superseded but ${refs.length} flow(s) still name it: ` +
              `${[...new Set(refs)].join(", ")}`,
          );
          continue;
        }
        if (!prune) {
          console.log(`  ! ${ds.name}.${name} is superseded and unreferenced — --prune removes it`);
          continue;
        }
        // `force`: the reference scan directly above is the same one `remove`
        // would run, and it found none. Passing it stops a second identical
        // query rather than bypassing a check.
        await dbOperationService.remove(ws.id, ds.id, name, { force: true });
        console.log(`  - ${ds.name}.${name}  (removed)`);
      }
    }
  }

  head("summary");
  console.log(`  readers  ${opsCreated} created · ${opsSkipped} already there · ${opsFailed} failed`);
  console.log(`  tools    ${toolsCreated} created`);
  if (opsFailed) {
    console.log(
      `\n\x1b[33mA reader that failed to compile is a spec bug, not a data problem — read the\n` +
        `finding above: it names the identifier and what the datasource actually has.\x1b[0m`,
    );
  }
  process.exit(opsFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
