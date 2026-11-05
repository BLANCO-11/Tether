# Contract: `POST /api/workspaces/:workspaceId/scripts`, policy-gated

Extends the existing route (`packages/server/src/routes/scripts.ts:48-73`).
All existing `202` (ALLOW) and `429` (capacity) behavior is unchanged.

## Request body additions (both optional, additive to `generateScriptSchema`)

```jsonc
{
  "task": "string, 3..20000 chars — unchanged",
  "title": "string, optional — unchanged",
  "language": "string, optional — unchanged",

  // New:
  "confirmationAvailable": true,   // default true (Decisions D4)
  "acceptedTransform": {           // present only on a resubmission after a shown proposal
    "proposalId": "opaque id echoed from a prior 200 transform response",
    "task": "the proposal's task text, unmodified or edited by the user"
  }
}
```

## Response: ALLOW (unchanged)

`202 Accepted`, existing `scriptGenerationService.start()` result body.

## Response: TRANSFORM (new)

Only when `confirmationAvailable` is `true` (or omitted). No script row is
created, no manifest built, no generation started.

```jsonc
// 200 OK
{
  "decision": "transform",
  "proposal": { "proposalId": "…", "task": "…rewritten request…" },
  "evidence": [ /* Evidence[], see data-model.md */ ],
  "reason": "Your request references an existing commercial product. It has been converted into an original application specification that preserves the overall goal while avoiding product-specific branding, workflows, and proprietary features.",
  "configVersion": "the PolicyConfig.version that produced this decision (FR-020)"
}
```

The client shows `proposal.task` to the user for confirm/edit. To proceed, the
client resubmits the same route with `acceptedTransform: { proposalId, task }`
set to the (possibly user-edited) text. The server verifies `proposalId`
corresponds to a proposal it actually issued before proceeding — an unrecognized
or stale `proposalId` is treated as a fresh request and re-evaluated from
scratch, not trusted blindly.

## Response: REJECT (new)

Produced either by FR-013 evidence (explicit product + reproduction intent) or
by TRANSFORM-eligible evidence evaluated under `confirmationAvailable: false`
(FR-012).

```jsonc
// 422 Unprocessable Entity
{
  "decision": "reject",
  "evidence": [ /* Evidence[] */ ],
  "reason": "…plain-language explanation naming the matched product/phrases…",
  "configVersion": "the PolicyConfig.version that produced this decision (FR-020)"
}
```

`configVersion` lets a decision be traced back to the exact dataset version
that produced it (FR-020) — e.g. for a support ticket asking why a request was
rejected under a config that has since changed. It was present on the internal
`PolicyDecision` object from the start (T022/T053) but omitted from this
contract's original response examples; **backfilled 2026-08-12 (T066/T067)**
to close that gap. `automations/new/page.tsx` no longer fabricates an empty
string for this field — it reads the real value the server now sends.

## Non-goals of this contract

- No new endpoint for "decision history" — see plan.md Decisions D5.
- No field for a policy bypass/override — FR-021 reserves the parameter at the
  service-function level (`request-policy.service.ts`), not at the HTTP
  contract; this route does not expose it.
