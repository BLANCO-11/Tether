# Implementation Plan: Resource detail shows schema and DB operations

**Branch**: `fix/resource-detail-schema-and-operations` | **Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

## Summary

Mount the schema tree and the DB operations panel on `/resources/[id]` for datasource-category
resources, reusing the components `/data-sources/[id]` already uses. Extract the category decision
into one shared module so the list and the detail page cannot drift. No server change.

## Technical Context

**Language/Version**: TypeScript, React 19 / Next.js (client), Node 22
**Primary Dependencies**: none new. `AssetTree`, `DbOperationsPanel`, `SandboxPanel` all exist.
**Storage**: N/A — no schema change, no migration.
**Testing**: vitest + @testing-library/react (jsdom), plus `scripts/ui-honesty-check.sh`
**Target Platform**: browser
**Project Type**: web (client package only)
**Performance Goals**: N/A — the page already fetches `getConnectionMetadata`; the operations panel
adds one list read it performs itself.
**Constraints**: schema-only visibility (no row fetch or preview) must be preserved.
**Scale/Scope**: one page, one new shared module, two test files.

### Investigation findings that shape the plan

1. **The components exist and are correct.** `/data-sources/[id]` mounts `AssetTree`,
   `SandboxPanel` and `DbOperationsPanel` and gates none of them on engine — each degrades honestly
   on its own (empty tree states "No metadata discovered yet"; the operations builder refuses to
   open without a schema and says why). The plan therefore *reuses*, and adds no new rule.

2. **The page already has the data.** `ResourceDetailPage` already calls
   `getConnectionMetadata(id)` and stores it as `metadata`, then uses it only to count "mapped
   fields". `AssetTree` and `DbOperationsPanel` both take exactly that array. `DbOperationsPanel`
   takes `datasourceId`, and the route id here *is* the datasource id — `getConnection` resolves it
   via `foundryApi.getDatasource(ws, id)`.

3. **`categoryFor` is defined once, in the list page, and is not exported.** Copying it into the
   detail page would create the second definition the repo repeatedly records as the failure mode
   (D-197). It moves to `lib/resource-category.ts`; the list page imports it.

4. **NFR-001 is a live trap, not a hypothetical.** `resources/[id]/page.test.tsx` mocks `@/lib/api`
   with a whole-module factory listing four functions. `DbOperationsPanel` imports
   `listOperations`/`createOperation`/`checkOperation`/`proposeOperation` and `SandboxPanel` its own
   reads; each omitted export arrives as `undefined`, is invoked, and crashes every test in the
   file. This is precisely the `tools/page.test.tsx` incident already recorded in CLAUDE.md. The
   mock is extended in the same commit.

5. **FR-007 has a concrete subject.** The page currently renders "Field mapping is available in the
   data source schema view" — a pointer to a surface navigation no longer offers. Once the schema is
   on this page that sentence is false as well as stale.

## Constitution Check

| Principle | Status | Note |
| :-- | :-- | :-- |
| I. Spec-First | PASS | spec.md, plan.md, tasks.md created before any source edit. |
| II. Test-First | PASS | Both directions tested (rendered for datasource, absent for connector), plus the honest-empty state. |
| III. Code Review | PASS | `/speckit-comply` to be run before review. |
| IV. Simplicity | PASS | No new dependency, no new abstraction layer. One module extraction, and it *removes* a duplication risk rather than adding indirection. |
| V. Observability | N/A | No new failure path: the panels own their own error and empty states. |
| VI. Branch Discipline | **DEVIATION — see below** | Branch is `fix/…`, not `YYYYMMDD-HHMMSS-slug`. |
| VII. Documentation Currency | PASS | Page docblocks updated in the same commit. |
| VIII. Secrets Hygiene | PASS | No credential touched; the page shows the credential by reference, unchanged. |

### Deviation: Principle VI (branch naming)

Constitution VI requires `YYYYMMDD-HHMMSS-slug`. `docs/VERSIONING.md` — the project's release
document — instead requires all beta work on `release/beta`, with **`fix/*`** short-lived branches
for risky or multi-day work, and explicitly rejects per-patch timestamp branches ("No per-patch
branches — they multiply and rot"). The user directed this work to follow `VERSIONING.md`.

**Resolution taken**: branch `fix/resource-detail-schema-and-operations`; spec directory keeps the
mandated timestamp name, so `specs/` numbering is unaffected. The spec gate resolves the feature
through `.specify/feature.json`, which is branch-independent, so enforcement still applies.

**Unresolved**: the two documents genuinely disagree and one of them should be amended. That is a
governance decision, not this feature's to take. Flagged to the user rather than silently picked.

The mandatory `before_specify` git hook (`speckit.git.feature`) was **not** run, because it would
have created a second, timestamp-named branch and moved off the branch the user asked for. The spec
directory it would have produced was created directly instead, which the `/speckit-specify`
contract explicitly permits ("the spec directory and file are always created by this command, never
by the hook").

## Project Structure

### Documentation (this feature)

```
specs/20260912-184048-resource-detail-schema-and-operations/
├── spec.md
├── plan.md
├── tasks.md
├── quickstart.md
└── checklists/requirements.md
```

### Source Code (repository root)

```
packages/client/src/
├── lib/
│   ├── resource-category.ts          # NEW — the one category definition
│   └── resource-category.test.ts     # NEW
└── app/(app)/resources/
    ├── page.tsx                      # MODIFIED — import the shared category fn
    └── [id]/
        ├── page.tsx                  # MODIFIED — mount Schema + DB operations
        └── page.test.tsx             # MODIFIED — extend the api mock; both directions
```

No server, no migration, no new route.

## Design decisions

- **D-1 · Gate on category, not on engine.** A datasource that cannot be introspected (S3, SFTP) is
  still a datasource; its panes degrade to honest-empty. An engine-specific gate would be a second
  rule that can drift from `schemaIntrospectorService.supports()` on the server, and the client
  mirror of that set already lives only in a test file. Category is the rule the list page already
  applies, so reusing it keeps one answer to "is this a datasource".

- **D-2 · Extract rather than export-from-page.** `categoryFor` could be exported from
  `resources/page.tsx` and imported by the detail page, but importing a helper from a Next page
  module drags the page's whole import graph into the consumer. A `lib/` module is the shape every
  other shared client predicate here uses.

- **D-3 · Include the sandbox pane (US3) but rank it last.** It is one line and answers "does a
  draft run read production", which the repo requires be stated wherever a draft run is implied.
  If it causes any test friction it can be dropped without touching FR-001/FR-002.

- **D-4 · Keep the legacy page.** Out of scope. Deleting a working surface is a separate decision
  with its own blast radius, and nothing in the report asks for it.

## Complexity Tracking

No constitution complexity gate is triggered. The one structural change (a new `lib/` module)
reduces duplication rather than adding a layer, per Principle IV's "prefer deleting code".

## Completion record (2026-09-12)

**Verified.** Client typecheck clean · `next build` exit 0 · `ui-honesty-check.sh` **229 PASS / 0
FAIL, identical to the pre-change baseline** · resources suites **110 passed**.

Full client suite, before → after: **150 files / 2456 passed → 151 files / 2472 passed**. The two
failing files are the same in both and are **pre-existing and flaky**, not this feature's:
`app/(app)/runs/[id]/page.test.tsx` and `lib/workspace-placeholder.test.ts` — they reported 2, 5 and
3 failing tests across three runs of unchanged code.

**Perturbations, both fired:**

1. Render the panes unconditionally (`isDatasource &&` → `true &&`) → the FR-003 connector-direction
   test fails. 1 failed / 18 passed.
2. Drop the five mock additions → **7 of 19 tests in the file crash**, exactly the documented
   whole-module-mock trap.
3. Re-duplicating `categoryFor` is **not** mechanically caught — recorded honestly rather than
   claimed. Only review catches that one.

### ⚠ A defect in this feature's own first draft, caught before commit

The metadata tree's top level is `db_schema`; **tables are its children**. The first version labelled
`metadata.length` as a table count, which reads "1 table" for a datasource with nine. The page's
pre-existing `mapped fields` figure counts the same top-level nodes — that inaccuracy is older than
this feature and was left alone (changing a captured figure is out of scope), but nothing new was
allowed to repeat it. `tableCount` walks one level down and is pinned by its own test.

### ⚠ Two environment findings, neither this feature's to fix

- **`ci/check-spec-compliance.sh` rejects this branch**, and rejects `release/beta` too. The
  constitution's Principle VI and `docs/VERSIONING.md` genuinely disagree; the user chose to keep
  `fix/*`. One of the two documents needs amending.
- **`CORP_CA_FILE=corp-ca.pem` in `.env` breaks every Docker image build on this machine** —
  `infra/certs/` is empty and there is no CA at `~/zscaler-ca.pem`. The first web rebuild died on it.
  Built with `CORP_CA_FILE=` instead; `.env` deliberately left untouched at the user's direction.
