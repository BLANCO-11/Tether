# Implementation Plan: Corporate CA trust for Docker builds

**Branch**: `20260824-211547-docker-ca-trust` | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260824-211547-docker-ca-trust/spec.md`

## Summary

Every image in this repository fails to build on a workstation whose network
re-signs TLS with a private root certificate authority, because each build performs
a network fetch and no build container trusts that authority. This plan makes the
certificate an **optional, explicitly-requested build input** for all six images.

The approach is **three mechanisms, not one** — a finding from Phase 0 that
overturned the intended design. `node:22-slim` has no system trust store at all, the
Python base has one and its package manager consults it, and the JVM ignores every
environment variable involved and reads its own truststore. A uniform mechanism
would have silently failed on two of six images. See [research.md](./research.md)
R1–R3.

One staged location (`infra/certs/`) serves all six by moving two build contexts up
one level. With no certificate requested, `ENV …=${CORP_CA_FILE:+…}` leaves the
variable empty and every image behaves exactly as it does today.

## Technical Context

**Language/Version**: Dockerfile syntax 1.x; POSIX `sh` for build steps and the
staging helper. No application code changes.

**Primary Dependencies**: Docker Engine 29.7.2 (measured on the affected host);
BuildKit default. Per-image toolchains already present: Node 22.23.2, Python
3.12.13 / pip 25.0.1, OpenJDK 25.0.3 JRE with `keytool`.

**Storage**: N/A — no database, schema or migration. One gitignored directory
holding one certificate file.

**Testing**: shell-level verification against **built images**, not against
Dockerfile text. Trust cannot be confirmed by reading an image definition, because
the three toolchains honour different mechanisms (research R1–R3). Each check is
paired with a control that shows it can fail. Extends the existing
`pnpm kestra:check` boundary-assertion idiom rather than adding a framework.

**Target Platform**: Linux containers built on macOS (Docker Desktop) and on CI.

**Project Type**: Build infrastructure. Six Dockerfiles, one compose file, one
staging helper, one gitignore rule, documentation.

**Performance Goals**: no build-time regression when no certificate is supplied.
The added layers are a `COPY` of one small file and one `RUN`; the `RUN` is a no-op
when the argument is empty.

**Constraints**:

- MUST NOT weaken or bypass certificate verification anywhere (FR-007).
- MUST NOT commit certificate material (FR-008, Constitution VIII).
- MUST NOT make the certificate mandatory (FR-003) — the primary risk of this
  feature is relocating the breakage to every other build environment.
- MUST NOT add a network fetch to fix a network failure (rules out installing
  `ca-certificates` in the Node images; research R1).

**Scale/Scope**: 6 Dockerfiles · 2 compose build stanzas · 2 new shell helpers ·
1 `.gitignore` rule · 1 tracked `.gitkeep` · 1 `.env.example` entry.

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Article | Status | Notes |
| :--- | :--- | :--- |
| **I — Spec-First** | **PASS** | This feature exists because the gate refused the edits. `spec.md` written before any source change; no source file has been modified yet. |
| **II — Test-First** | **PASS** | Every mechanism already has a measured control in `research.md` *before* implementation. Verification tasks are written before the Dockerfile edits they check. |
| **III — Code Review** | **PASS** | `/speckit-comply` before review. The two judgement calls most worth a reviewer's attention are named explicitly below rather than buried. |
| **IV — Simplicity** | **PASS, with one justified deviation** | Three mechanisms instead of one is forced by the runtimes, not chosen — see Complexity Tracking. No new dependency, no new abstraction, no framework. |
| **V — Observability** | **PASS** | FR-005/FR-006 are the whole of this article for this feature: a requested-but-absent certificate fails at the trust step naming the file, the directory and the fix. The default behaviour (silently ignore) is what is being replaced. |
| **VI — Branch Discipline** | **PASS** | `20260824-211547-docker-ca-trust`, one feature, one specs directory. |
| **VII — Documentation Currency** | **PASS** | Two Dockerfile comments document standalone build commands that this change invalidates (research R4); both are updated in the same commit. `.env.example` and CLAUDE.md updated in the same commit. |
| **VIII — Secrets Hygiene** | **PASS, and it required a correction** | `.gitignore` covers `*.pem` but **not** `*.crt` (research R7). Naming the staged file `.crt` — which Debian's anchor directory wants — would have placed key material under a name git does not exclude. Staged as `*.pem`, renamed by `COPY`, plus an explicit `infra/certs/` rule. |

**No gate violations requiring justification beyond the Complexity Tracking entry
below.**

⚠ **Two judgement calls a reviewer should challenge**, stated here so they are not
found by accident:

1. **Setting `PIP_CERT` when it is measurably unnecessary.** pip 25.0.1 consults the
   system store and works without it. The argument for the extra line is that
   omitting it makes the build depend on a current pip default rather than on a
   bundle we named. A reviewer preferring strict YAGNI would drop it; the cost of
   dropping it is a silent future regression when pip's default changes.
2. **Moving two build contexts up one level.** It buys a single staged certificate
   location and a single ignore rule. The alternative — three staged copies — avoids
   touching production compose but multiplies a security-relevant file. See
   research R4.

## Project Structure

### Documentation (this feature)

```text
specs/20260824-211547-docker-ca-trust/
├── spec.md              # Phase -1 output (/speckit-specify)
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0 output — all measurements and controls
├── data-model.md        # Phase 1 output — the entities, such as they are
├── quickstart.md        # Phase 1 output — how to run and verify
├── contracts/
│   └── build-inputs.md  # Phase 1 output — the build-argument contract
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infra/
├── certs/                        # NEW — staged certificate lives here
│   └── .gitkeep                  # NEW, tracked: the dir must exist for COPY
├── docker-compose.yml            # EDIT: build.args on 6 services; 2 contexts move
├── fragment-base/Dockerfile      # EDIT: anchor + refresh + PIP_CERT; comment fix
└── kestra/Dockerfile             # EDIT: keytool import + refresh; comment fix

packages/
├── server/Dockerfile             # EDIT: CA trust, both stages
├── client/Dockerfile             # EDIT: CA trust, both stages
├── ops-api/Dockerfile            # EDIT: CA trust, both stages
└── mcp-bridge/Dockerfile         # EDIT: CA trust, both stages

(repo helpers directory)
├── stage-corp-ca.sh              # NEW — the one documented staging action
└── check-corp-ca-trust.sh        # NEW — per-image verification, with controls

.gitignore                        # EDIT: explicit infra/certs/ rule
.env.example                      # EDIT: document CORP_CA_FILE / CORP_CA_SOURCE
CLAUDE.md                         # EDIT: record the mechanism and its bounds
```

**Structure Decision**: no application source is touched — no application package,
no test directory, no new module. The work is entirely in build definitions plus two
shell helpers in the repository's existing helpers directory, which is where
`kestra-env.sh`, `backup.sh` and the boundary checks already live. Verification
follows the `kestra:check` precedent: a shell script asserting properties of the
running system, each assertion paired with a control.

## Implementation phases

### Phase 1 — staging and the contract (no image changes)

A staging helper copies a certificate from a source path (`CORP_CA_SOURCE`,
defaulting to the conventional host location) into `infra/certs/corp-ca.pem`,
refusing anything that does not parse as a certificate. `infra/certs/.gitkeep` is
tracked; `.gitignore` gains an explicit rule. Nothing builds differently yet, which
is what makes this phase independently reviewable.

### Phase 2 — the four Node images

`ARG CORP_CA_FILE=` · `COPY infra/certs/ …` · one `RUN` that validates and places
the certificate (failing loudly per FR-005/FR-006) · `ENV
NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+…}`. Applied to **both** stages of each image,
because both run `pnpm install`. This phase alone unblocks the four images that fail
first, and is the largest share of the value.

### Phase 3 — fragment-base and kestra

The two remaining mechanisms (research D-2, D-3), each with its Dockerfile comment
corrected in the same edit. This phase carries the **deferred `kestra` plugin-fetch
proof** — the one mechanism Phase 0 could not verify end-to-end.

### Phase 4 — compose wiring

`build.args` on all six services, driven by `${CORP_CA_FILE:-}` so the value comes
from `.env` and defaults to absent. The two context moves land here.

### Phase 5 — verification and documentation

The verification helper, the FR-003 no-interception build, `.env.example`, and the
CLAUDE.md entry recording the mechanism, its three-way split, and the two claims
that rest on a single environment.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Three trust mechanisms rather than one (Article IV) | Measured: `node:22-slim` has no system trust store, no `update-ca-certificates` and no openssl; the Python base has all three and its package manager consults them; the JVM ignores all of it and reads `lib/security/cacerts`. Research R1–R3. | A single mechanism was the intended design. "Add to the system store and point everything at it" is **impossible** in the Node images and **inert** for the JVM — it would have produced a fix that works on four of six images, with the two failures reading as an unrelated problem. The uniform alternative is not simpler, it is wrong. |
| Two build contexts move up one level (Article IV, VII) | A build reads only its own context, so one staged certificate cannot serve three contexts without either moving them or duplicating the file. Research R4. | Three staged copies of a security-relevant file, and three ignore rules, to avoid a two-line compose change — and an ambiguity about which copy an image used. Cost accepted and paid: both affected Dockerfile comments are corrected in the same commit. |
