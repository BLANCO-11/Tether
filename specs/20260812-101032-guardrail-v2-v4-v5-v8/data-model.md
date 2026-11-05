# Data Model: Guardrail Port — V2/V4/V5/V8

No database schema changes anywhere in this feature — every new entity below is either an in-memory
runtime shape or a plain-data config module, matching the prior feature's precedent (that feature also
added no migrations).

## mcp-bridge credential

Not a stored entity — a single env var, `MCP_BRIDGE_API_KEY`, compared against an incoming
`x-api-key` header. No database, no per-workspace scoping (Decision 1: nothing calls mcp-bridge with a
workspace concept today).

```ts
// packages/mcp-bridge/src/auth.ts
function requireApiKey(req: Request, res: Response, next: NextFunction): void
```

## Provenance declaration + injection warnings (`packages/server/src/prompt-boundary/`)

Ported types, unchanged from the source branch (see research.md Decision 3 for the one integration
point):

```ts
// envelope.ts
export const UNTRUSTED_OPEN: string;
export const UNTRUSTED_CLOSE: string;
export const PROVENANCE_DECLARATION: string;
export function wrapUntrusted(content: string, label?: string): string;

// spans.ts
export type SpanSource = "tool" | "datasource" | "schema";
export interface UntrustedSpan { source: SpanSource; itemName: string; field: string; value: string; }
export const SPAN_FIELDS: readonly string[];  // adapted to v1-alpha's actual tool/entity column names
export function spansFromInventory(inv: WorkspaceInventory): UntrustedSpan[];

// detect.ts
export interface ManifestWarning {
  source: SpanSource; itemName: string; field: string;
  pattern: string; describes: string; excerpt: string;
}
export interface DetectionResult { items: ManifestWarning[]; truncated: boolean; total: number; cap: number; }
export function detectInjection(spans: UntrustedSpan[]): DetectionResult;
```

**`manifestBuilderService.buildAndPersist()`'s return type gains one field**:

```ts
interface RenderedManifest {
  version: number; hash: string; manifestXml: string; summaryXml: string; changed: boolean;
  warnings: DetectionResult;   // NEW — never affects hash, manifestXml, or summaryXml
}
```

## Request-policy engine (`@foundry/shared/src/request-policy/`)

Ported types, unchanged from the source branch (research.md Decision 5):

```ts
export type Evidence =
  | { kind: "productReference"; product: string; matchedAlias: string }
  | { kind: "reproductionIntent"; phrase: string }
  | { kind: "differentiationQualifier"; phrase: string; qualifierKind: "alternative"|"interop"|"similar"|"vertical" }
  | { kind: "capabilitySignature"; product: string; matched: readonly string[]; missing: readonly string[] };

export type EvaluationMode = "confirmation-available" | "confirmation-unavailable";
export interface ResolvedRequest { task: string; }
export interface PolicyProposal { proposalId: string; task: string; }

export type PolicyDecision =
  | { decision: "allow"; evidence: readonly Evidence[]; reason: string; configVersion: string; originalRequest: string }
  | { decision: "transform"; proposal: PolicyProposal; evidence: readonly Evidence[]; reason: string; configVersion: string; originalRequest: string }
  | { decision: "reject"; evidence: readonly Evidence[]; reason: string; configVersion: string; originalRequest: string };

export interface PolicyConfig {
  version: string;
  products: readonly ProductEntry[];
  featureSubstitutes: readonly FeatureSubstitute[];
  intentLexicon: IntentLexicon;
}

export function evaluatePolicy(request: ResolvedRequest, mode: EvaluationMode, config: PolicyConfig): PolicyDecision;
export const policyConfig: PolicyConfig;  // the versioned default dataset
```

**`packages/server/src/services/request-policy.service.ts`** (thin wrapper, in-memory proposal tracking):

```ts
export const requestPolicyService = {
  evaluate(task: string, opts: { confirmationAvailable: boolean }): PolicyDecision;
  verifyAcceptedTransform(accepted: { proposalId: string; task: string }): string | null;
};
```

## New outcome variants — `GenerationOutcome` and `TurnOutcome`

Both follow the exact shape convention `DraftRefusal`/`isDraftRefusal` already established
(`status` literal discriminant, 200-not-error per D-38 — research.md Decision 6):

```ts
// flow-generation-job.service.ts — GenerationOutcome gains:
| { status: "policy_reject"; reason: string; evidence: readonly Evidence[] }
| { status: "policy_transform"; reason: string; evidence: readonly Evidence[]; proposal: PolicyProposal }

// flow-chat.service.ts — TurnOutcome gains the equivalent fields on the turn row's
// `findingsJson`/status, surfaced the same way an existing refused turn is surfaced.
```

## Relationships

- `manifestBuilderService.buildAndPersist()` → `flow-generation.service.ts`'s `buildDraftPrompt` is a
  **1:1, already-existing** call relationship; this feature only changes what happens at each end
  (a new `warnings` field produced; the manifest text wrapped when consumed), not the relationship
  itself.
- `runGeneration()` and `flowChatService.turn()` each call `requestPolicyService.evaluate()`
  **independently** — no shared request/response object between them; they share only the underlying
  `@foundry/shared` function, per research.md Decision 2's "one function, two call sites" design.
- `packages/mcp-bridge` has no relationship to any other package's entities — its auth check is
  self-contained by design (Decision 1).
