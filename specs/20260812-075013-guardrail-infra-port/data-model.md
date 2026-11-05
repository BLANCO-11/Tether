# Phase 1 Data Model: Guardrail Infrastructure Port

No new persisted database tables (Decision 1 in `research.md`: rate-limit and
concurrency state is in-memory, per-process). The entities below are runtime
objects and shared-package types, not schema/migrations.

## RequestContext

Attached to every inbound request by `middleware/request-id.middleware.ts`.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID v4) | Server-generated only; never taken from a caller-supplied header (Decision 6). |
| `startedAt` | `number` (ms epoch) | For future latency logging; not surfaced in responses. |

Declared via `declare global { namespace Express { interface Request { id: string } } }`,
matching the existing pattern in `identity.middleware.ts` (`req.user`) and
`step-token.middleware.ts` (`req.stepAuth`).

## ValidationFailure

Produced by the shared `validate({params, query, body})` middleware factory
(`packages/shared/src/validation/`) on a schema mismatch.

| Field | Type | Notes |
|---|---|---|
| `field` | `string` | Dotted path of the first invalid field (e.g. `params.workspaceId`). |
| `message` | `string` | Human-readable reason (from the underlying zod issue). |
| `code` | `"validation_error"` | Fixed discriminant, matches `error.middleware.ts`'s existing `ZodError` branch shape so the two error paths stay consistent. |

Response shape (400): `{ error: "validation_error", issues: ValidationFailure[] }`
— identical field names to the existing `ZodError` branch in
`error.middleware.ts` so routes migrated onto the new middleware produce a
byte-identical error body to routes already validating with a raw
`schema.parse()` inside their handler (no client-visible difference — FR-013).

## AuthFailureRule

The only rate-limit-shaped state this feature actually adds (Decision 5 —
flow-generation and execution-start concurrency ceilings already exist
elsewhere and are not duplicated). A static configuration value (not
persisted — a plain object literal in `packages/shared/src/rate-limit/rules.ts`).

| Field | Type | Notes |
|---|---|---|
| `windowMs` | `number` | Sliding-window size for counting failures. |
| `max` | `number` | Failures allowed per IP per window before throttling. |

## AuthFailureState (runtime, in-memory)

One `Map<string, WindowCounter>` keyed by caller IP.

| Field | Type | Notes |
|---|---|---|
| `count` | `number` | Auth failures seen from this IP in the current window. |
| `windowStart` | `number` (ms epoch) | Reset when `now - windowStart > windowMs`. |

Per-process in-memory only (Decision 1) — a restart clearing the throttle is
an accepted tradeoff, same reasoning as before.

## EgressPolicyProfile

| Field | Type | Notes |
|---|---|---|
| `name` | `"strict" \| "permissive"` | Decision 2. |
| `deniesRfc1918` | `boolean` | `true` for `strict`, `false` for `permissive`. |
| `deniesLoopback` | `boolean` | `true` for `strict` only — `permissive` is byte-for-byte `datasource-target.service.ts`'s existing `NEVER_A_DATABASE`, which does **not** deny loopback (corrected after reading that file directly: it denies link-local, unspecified/broadcast, and multicast — never loopback or RFC1918). |
| `deniesLinkLocal` | `boolean` | `true` for both profiles (169.254.0.0/16 — cloud metadata). |

## EgressDecision

Returned by `classifyHost(host, profile)`; consumed at both registration time
(existing call sites, unchanged) and dial time (new `guardedFetch` wrapper).

| Field | Type | Notes |
|---|---|---|
| `allowed` | `boolean` | |
| `reason` | `string \| null` | Populated when `allowed === false` (e.g. `"loopback"`, `"rfc1918"`, `"link-local"`). Never includes the resolved IP in a value that could reach a response body verbatim without review — FR-004 applies to this path too. |
| `resolvedAddress` | `string` | The address actually classified, for server-side logging only. |

## Shared package public surface (`@foundry/shared`)

```ts
// validation/
export function validate(schemas: { params?: ZodSchema; query?: ZodSchema; body?: ZodSchema }): RequestHandler;

// rate-limit/
export function authFailureThrottle(rule: AuthFailureRule): {
  recordFailure(ip: string): void;   // called from requireApiKey/resolveIdentity's failure branch
  isThrottled(ip: string): boolean;  // checked before processing the request further
};

// egress/
export function classifyHost(host: string, profile: EgressPolicyProfile): Promise<EgressDecision>;
export function guardedFetch(url: string | URL, init: RequestInit, profile: EgressPolicyProfile): Promise<Response>;
export const STRICT: EgressPolicyProfile;
export const PERMISSIVE: EgressPolicyProfile;

// rules/
export const ENV_NAME_RE: RegExp;
export const AUTH_STYLES: readonly string[];
```

Every export here is dependency-free (no Express types leak into `rules/`;
`validate` returns a plain `RequestHandler`, and `authFailureThrottle` returns
plain data-checking functions with no Express dependency at all, so
`packages/client` never imports Express-typed code — it only ever imports
from `rules/`, per FR-010's "usable from both client and server" while each
side takes only what applies to it).
