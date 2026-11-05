# Tasks (backfilled 2026-09-10 from working tree)

Every task below is reverse-engineered from the implemented diff and marked
`[X]` (completed retroactively). Paths are exact.

## Backfilled 2026-09-10 from working tree

- [X] Composite-key joins in the compiler (`andOn`, latestOne refusal, readback, tests)
  — `packages/server/src/services/db-operation.service.ts`,
  `packages/server/src/services/db-operation-readback.ts`,
  `packages/server/src/services/db-operation.test.ts`
- [X] Compute expression tree (`greatest`, `least`, `businessMinutes`, coalesce-list migration, readback, tests)
  — `packages/server/src/services/db-operation.service.ts`,
  `packages/server/src/services/db-operation-readback.ts`,
  `packages/server/src/services/db-operation.test.ts`
- [X] Six new catalogue operations + ITOPS array + registry (support/orders/hiring/itops×3), live row proofs
  — `packages/server/src/demo/catalogue/operations.ts`
- [X] Catalogue test strengthening (six domains, all-params prose rule, address rule) + param declarations + HR address alias
  — `packages/server/src/demo/catalogue/operations.test.ts`,
  `packages/server/src/demo/catalogue/operations.ts`
- [X] Generic flows onto compiled operations (support/orders/hiring + operation digest), texts preserved, equivalence proven
  — `packages/server/src/scenarios/generic-flows.ts`
- [X] ITOPS triage onto consumed-minutes op (collapsed query, merged shaping, escalation chain, window clamp), equivalence + recipients proven vs oracle
  — `packages/server/src/scenarios/itops-flows.ts`,
  `packages/server/src/demo/catalogue/operations.ts`
- [X] ITOPS vuln flow onto `vuln_finding_rows` (split/stale in jq), counts proven
  — `packages/server/src/scenarios/itops-flows.ts`
- [X] Showcase flows onto month query + rollup transform, assess/message untouched
  — `packages/server/src/showcase/flows.ts`
- [X] Verify harness fixes (mail freshness limit 200→2000; guard-shape cycle and guard race resolved in flow topology)
  — `packages/server/src/scenarios/itops-verify.ts`,
  `packages/server/src/scenarios/itops-flows.ts`
- [X] Client named-query removal (panel + test deleted, data-source pages, builder, chat and lib re-pointed)
  — `packages/client/src/components/data/NamedQueryPanel.tsx` (deleted),
  `packages/client/src/components/data/NamedQueryPanel.test.tsx` (deleted),
  `packages/client/src/components/data/DbOperationsPanel.tsx`,
  `packages/client/src/app/(app)/data-sources/page.tsx`,
  `packages/client/src/app/(app)/data-sources/[id]/page.tsx`,
  `packages/client/src/app/(app)/flows/new/page.tsx`,
  `packages/client/src/app/(app)/flows/[id]/builder/page.tsx`,
  `packages/client/src/app/globals.css`,
  `packages/client/src/components/flow/ChatPanel.tsx`,
  `packages/client/src/components/flow/ChatPanel.test.tsx`,
  `packages/client/src/components/flow/ChatWorkbench.tsx`,
  `packages/client/src/components/flow/FlowBuilder.tsx`,
  `packages/client/src/components/flow/FlowBuilder.test.tsx`,
  `packages/client/src/components/flow/FlowCanvas.tsx`,
  `packages/client/src/components/flow/FlowCanvas.test.tsx`,
  `packages/client/src/components/flow/FlowCanvas.fields.test.tsx`,
  `packages/client/src/components/flow/FlowReview.tsx`,
  `packages/client/src/components/flow/StepInspector.tsx`,
  `packages/client/src/components/flow/StepInspector.transform-code.test.tsx`,
  `packages/client/src/components/flow/builder/BuilderShell.tsx`,
  `packages/client/src/components/flow/builder/StepIO.tsx`,
  `packages/client/src/components/flow/builder/StepIO.test.tsx`,
  `packages/client/src/components/flow/builder/StepPalette.tsx`,
  `packages/client/src/components/flow/builder/StepPanel.tsx`,
  `packages/client/src/lib/alpha-registry.ts`,
  `packages/client/src/lib/api.ts`,
  `packages/client/src/lib/canvas-layout.ts`,
  `packages/client/src/lib/canvas-layout.test.ts`,
  `packages/client/src/lib/flow-authoring.ts`,
  `packages/client/src/lib/flow-authoring.test.ts`,
  `packages/client/src/lib/foundry-client.ts`,
  `packages/client/src/lib/step-io.ts`,
  `packages/client/src/lib/step-shape.test.ts`,
  `packages/client/src/lib/theme.test.ts`,
  `packages/client/src/lib/tool-edit.ts`
- [X] Server named-query deletion (query modules, provision/verify references, seed/scaffold call sites)
  — `packages/server/src/demo/finance/finance-queries.ts` (deleted),
  `packages/server/src/demo/itops/itops-queries.ts` (deleted),
  `packages/server/src/demo/legal/legal-queries.ts` (deleted),
  `packages/server/src/kestra/hr-scenarios.queries.ts` (deleted),
  `packages/server/src/kestra/hr-screening.queries.ts` (deleted),
  `packages/server/src/showcase/queries.ts` (deleted)
  — provision/verify/seed call sites, generated fixtures, proposal services, finance/hr flows migrated earlier in this branch:
  `packages/server/src/demo/finance/provision-finance.ts`,
  `packages/server/src/demo/finance/verify-finance.ts`,
  `packages/server/src/demo/finance/finance-generated.ts`,
  `packages/server/src/demo/itops/provision-itops.ts`,
  `packages/server/src/demo/itops/verify-itops.ts`,
  `packages/server/src/demo/itops/itops-generated.ts`,
  `packages/server/src/demo/legal/provision-legal.ts`,
  `packages/server/src/demo/legal/verify-legal.ts`,
  `packages/server/src/demo/legal/legal-generated.ts`,
  `packages/server/src/demo/generic-generated.ts`,
  `packages/server/src/demo/hr-generated.ts`,
  `packages/server/src/kestra/alt-screening.queries.ts`,
  `packages/server/src/kestra/e2e-ui-journey.ts`,
  `packages/server/src/kestra/phase1-prove.ts`,
  `packages/server/src/kestra/phase3-verify.ts`,
  `packages/server/src/kestra/phase6-verify.ts`,
  `packages/server/src/routes/datasources.ts`,
  `packages/server/src/scenarios/finance-flows.ts`,
  `packages/server/src/scenarios/generic-seed.ts`,
  `packages/server/src/scenarios/hr-demo-flows.ts`,
  `packages/server/src/scenarios/propose-adjudicate.ts`,
  `packages/server/src/scenarios/propose-measure.test.ts`,
  `packages/server/src/scenarios/seed.ts`,
  `packages/server/src/scenarios/uat-lifecycle-setup.ts`,
  `packages/server/src/services/datasource-query.service.ts`,
  `packages/server/src/services/flow-generation.service.ts`,
  `packages/server/src/services/manifest-builder.service.ts`,
  `packages/server/src/services/step-execution.service.ts`,
  `packages/server/src/services/db-query-proposal.service.ts`,
  `packages/server/src/services/db-query-proposal.service.test.ts`,
  `packages/server/src/showcase/seed.ts`,
  `packages/server/package.json`
