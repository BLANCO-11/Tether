# Contract: new outcome variants on generation/chat responses

## `POST /workspaces/:ws/flows/generate` and `.../flows/generate/jobs` (goal/outline mode)

**Unchanged for `allow`** — the response is byte-identical to today's success/refusal shapes.
`policy_reject`/`policy_transform` are NEW variants, never seen before this feature, so no existing
client code path is affected by their existence (SC-005/SC-007).

**New — `policy_reject`** (HTTP 200, matching `insufficient_catalogue`'s precedent):

```json
{
  "status": "policy_reject",
  "reason": "Your request names \"Slack\" together with reproduction language (\"clone\"). Foundry does not generate direct reproductions of an existing commercial product.",
  "evidence": [
    { "kind": "productReference", "product": "Slack", "matchedAlias": "slack" },
    { "kind": "reproductionIntent", "phrase": "clone" }
  ]
}
```

No manifest is built, no `draftFlow`/`authorFlow` call is made, no flow row is created.

**New — `policy_transform`** (HTTP 200):

```json
{
  "status": "policy_transform",
  "reason": "Your request describes several capabilities (channels, threads, workspace) that closely match an existing commercial product (\"Slack\"), without naming it.",
  "evidence": [{ "kind": "capabilitySignature", "product": "Slack", "matched": ["channels", "threads", "workspace"], "missing": [] }],
  "proposal": {
    "proposalId": "policy-proposal-<uuid>",
    "task": "Build an original application with the following capabilities: topic-based rooms, message replies, team space. Your request references an existing commercial product. It has been converted into an original application specification that preserves the overall goal while avoiding product-specific branding, workflows, and proprietary functionality."
  }
}
```

**Resubmission after a `policy_transform`** — the client re-submits the SAME generate/job endpoint
with an added field:

```json
{ "goal": "<original or edited text>", "acceptedProposal": { "proposalId": "policy-proposal-<uuid>", "task": "<confirmed text>" } }
```

The server calls `requestPolicyService.verifyAcceptedTransform(...)`. If it returns a verified task
string, generation proceeds on THAT text (re-evaluated against the policy first — FR-009; an edited
resubmission that still matches is `policy_reject`/`policy_transform` again, not a silent pass-through).
If it returns `null` (unknown/expired `proposalId`), the server treats `goal`/`outline` as fresh input
and re-evaluates from scratch — never trusts the client's claim that this was already confirmed.

## `POST /workspaces/:ws/flow-chat/threads/:id/turns` (chat editing)

Same two new variants, surfaced on `TurnOutcome`/the turn row, following the existing pattern for a
`failed` turn (a readable record, not a thrown 5xx). `allow` turns are unaffected — same response
shape as today.

## Invariant asserted by tests, not just described here

- SC-004: for a `policy_reject`/`policy_transform`-decided input, `manifestBuilderService.buildAndPersist`
  and the inference client's `complete()` are never invoked — asserted via a spy/mock call-count of
  zero, not by reading the response shape alone.
- SC-005/SC-007: for an `allow`-decided input, the full existing test suite for `runGeneration()` and
  `flowChatService.turn()` passes unchanged — no new field appears on an `allow` response, no new
  latency-visible step is added to that path.
