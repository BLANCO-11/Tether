# Contract: Standards Existence Gate

Behavioral contract for the standards branch added to `scripts/spec-gate-core.sh`
(policy helpers in `ci/spec-policy.sh`). This is a **guardrail**, not a security
boundary; the pre-commit and CI gates remain authoritative.

## Invocation

Same entry points as the existing gate — invoked by each agent adapter:

```text
spec-gate-core.sh write <path>       # a file is about to be written
spec-gate-core.sh shell <command>    # a shell command is about to run
```

The standards check runs **in addition to** the existing feature-gate + secret
checks, and is evaluated for the `write` and `shell` modes only. The `content`
(secret-scan) mode is unchanged.

## Inputs

- `<path>` normalized to a repo-relative path (existing logic).
- `.specify/memory/standards.json` (the manifest) — read via `jq`.
- Filesystem existence of each required standard file.

## Preconditions / short-circuits (unchanged, evaluated first)

1. Not inside a spec-kit project (`ROOT` unresolved) → **allow** (exit 0).
2. `SPECKIT_ENFORCE=0` → **allow**.
3. `.speckit-template-dev` present → **allow**.
4. Path is always-editable (`is_always_editable`) → **allow**. (This keeps
   `/speckit-start` able to write the standards themselves under `.specify/` and
   the skills dirs.)

## Decision table (for a non-exempt source `write`)

| Manifest | `status` | Missing required standard | Result |
|---|---|---|---|
| absent | — | — | **allow** (standards gate inactive; existing feature gate still applies) |
| present, unreadable/malformed | — | — | **allow** (fail-open) + note |
| present | `pending` | — | **deny**: "Project standards not established — run `/speckit-start` to set up constitution, frameworks, security (and design if there's a UI)." |
| present | `established` | none | **allow** (existence satisfied; conformance deferred to `/speckit-comply`) |
| present | `established` | `security.md` | **deny**: names `security` + "run `/speckit-start`" |
| present | `established` | `design.md` **and** `has_ui=true` | **deny**: names `design` + "run `/speckit-start`" |
| present | `established` | `design.md` **and** `has_ui=false` | **allow** (design not required) |
| present | `established` | `constitution.md` or `frameworks.md` | **deny**: names the missing standard |

Notes:
- "Missing required standard" = manifest marks it `required:true` AND the file is
  absent on disk. The gate re-checks the filesystem; it does not trust
  `present` blindly.
- `shell` mode applies the same allow/deny outcome to obvious file-mutating
  commands (reusing the existing mutation heuristic + always-editable tolerance).

## Ordering relative to the existing feature gate

The standards existence gate is **independent of and prior to** the feature gate:
if a required standard is missing, a source write is denied **even inside a
complete feature** (spec+plan+tasks present). Rationale: you cannot build
compliant code before the standards that define compliance exist. When both
gates would deny, the standards message is shown (it is the earlier blocker).

## Outputs

- Exit `0` = allow (silent).
- Exit `2` = deny; a **single line** on stdout naming the missing standard (or
  pending state) and the exact command to run (`/speckit-start`). The adapter
  formats it for its agent (existing behavior).

## Non-goals (hard constraints)

- MUST NOT parse code or standard file *contents* to judge conformance
  (FR-019). Existence + manifest booleans only.
- MUST NOT block writes to always-editable paths.
- MUST fail open on its own internal errors (missing `jq`, unreadable manifest,
  sourcing failure) — never brick the agent (mirrors existing lines 46-48).

## Test assertions (see tests/standards-gate/)

1. absent manifest + source write inside valid feature → allow.
2. absent manifest + source write with no feature → denied by *feature* gate
   (unchanged), not the standards gate.
3. pending manifest + any source write → deny mentioning `/speckit-start`.
4. established + all present → allow.
5. established + security.md removed → deny naming `security`.
6. established + has_ui=true + design.md removed → deny naming `design`.
7. established + has_ui=false + design.md absent → allow.
8. established + missing standard but path is always-editable → allow.
9. malformed manifest → allow (fail-open).
10. `.speckit-template-dev` present + pending manifest → allow (escape hatch).
