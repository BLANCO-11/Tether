---
description: "Task list for Docker corporate CA trust"
---

# Tasks: Corporate CA trust for Docker builds

**Input**: Design documents from `/specs/20260824-211547-docker-ca-trust/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/build-inputs.md](./contracts/build-inputs.md), [quickstart.md](./quickstart.md)

**Tests**: **INCLUDED, and not optional here.** Constitution Article II requires every
behaviour change to ship with tests. There is no unit-test framework for a Dockerfile,
so verification is shell-level and asserts properties of **built images** — the
`pnpm kestra:check` idiom this repository already uses. Trust cannot be verified by
reading a Dockerfile, because the three toolchains honour different mechanisms
(research R1–R3), so a text-level check would pass over an image that trusts nothing.

**Organization**: grouped by user story. US1 and US2 are both P1 and both required for
a defensible result — US1 makes builds work behind the proxy, US2 proves that did not
break every other build environment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 per spec.md
- Exact file paths in every task

## Path conventions

Build infrastructure only. No application source is touched: no `packages/*/src`, no
new module, no migration.

- Image definitions: `packages/{server,client,ops-api,mcp-bridge}/Dockerfile`, `infra/{fragment-base,kestra}/Dockerfile`
- Orchestration: `infra/docker-compose.yml`
- Helpers: `scripts/stage-corp-ca.sh`, `scripts/check-corp-ca-trust.sh`
- Staged material: `infra/certs/`

⚠ **Two global rules for every task below**

1. **Never weaken verification** (FR-007). No `NODE_TLS_REJECT_UNAUTHORIZED=0`, no
   `pip --trusted-host`, no `-Dcom.sun.net.ssl.checkRevocation=false`, no
   `--no-check-certificate`. If a task seems to need one, the task is wrong.
2. **Every check needs a control.** A check that has never been observed failing is
   indistinguishable from a check that examines nothing.

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: create the staged location and the one documented staging action. Nothing
builds differently after this phase, which is what makes it independently reviewable.

- [X] T001 Create the staged certificate directory with a tracked placeholder at `infra/certs/.gitkeep` (empty file). The directory MUST exist in a fresh clone or `COPY certs/ …` fails the build; the ignore rule in T002 and this placeholder are a pair and removing either breaks a clean checkout.
- [X] T002 [P] Add an explicit `infra/certs/` exclusion to `.gitignore` alongside the existing `*.pem` rule at line 87, with a comment stating that the staged file must be `*.pem` because `*.crt` is **not** covered (research R7, Constitution VIII), and that `infra/certs/.gitkeep` is deliberately tracked via a negation.
- [X] T003 [P] Create `scripts/stage-corp-ca.sh`: read the source path from `CORP_CA_SOURCE` (default `$HOME/zscaler-ca.pem`), refuse anything that does not parse as an X.509 certificate, place it at `infra/certs/corp-ca.pem`, and print the exact `.env` line the caller must add next. Must be idempotent and must refuse rather than overwrite silently if the target differs.
- [X] T004 Make `scripts/stage-corp-ca.sh` executable and verify it refuses a non-certificate: run it with `CORP_CA_SOURCE` pointing at `package.json` and confirm a non-zero exit naming the file — this is T003's control.

**Checkpoint**: a certificate can be staged, and staging junk is refused. No image changed.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the verification harness, and the **pre-change baseline** that US2's
no-regression claim is measured against.

**⚠️ CRITICAL**: T006–T008 capture state that **cannot be recovered after the
Dockerfiles are edited**. They must complete before Phase 3 begins.

- [X] T005 Create `scripts/check-corp-ca-trust.sh` with a `PASS`/`FAIL` assertion helper, a per-image dispatch table, and a `--control` mode that deliberately runs each assertion against an image built without a certificate so the assertion is observed failing. Exit non-zero on any FAIL, and exit non-zero if a control did **not** fail (an assertion that cannot fail is a defect, not a pass).
- [X] T006 Capture the pre-change baseline: build all six images from the current `HEAD` with `--no-cache`, and record for each the image digest plus the trusted-authority evidence its runtime exposes (Node: absence of `NODE_EXTRA_CA_CERTS`; Python: `grep -c BEGIN.CERTIFICATE /etc/ssl/certs/ca-certificates.crt`; Kestra: `keytool -list -cacerts` entry count). Write to `specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt`.
- [X] T007 Record in the same baseline file that the four Node images have **no** system trust infrastructure (no `ca-certificates` package, no `/etc/ssl/certs/ca-certificates.crt`, no `update-ca-certificates`, no `/usr/local/share/ca-certificates`, no `openssl`), so the Phase 3 Node mechanism choice is justified by evidence in-repo rather than only in research.md.
- [X] T008 Confirm the three base images are pullable and that pulls are **not** affected by the interception (research R8), so a later pull failure is not mistaken for this feature regressing.

**Checkpoint**: baseline captured, harness exists and can fail. User story work may begin.

---

## Phase 3: User Story 1 — Build the stack behind an intercepting proxy (Priority: P1) 🎯 MVP

**Goal**: with a certificate staged and requested, all six images build behind the
intercepting proxy, and the trust is added to the **image** so outbound requests from
running containers also validate.

**Independent Test**: on the affected workstation, stage the certificate, set
`CORP_CA_FILE=corp-ca.pem`, build all six images with `--no-cache`, and observe zero
certificate-validation failures — against a control build with the argument empty,
which must still fail on this network.

⚠ **Three mechanisms, not one.** `node:22-slim` has no system trust store at all; the
Python base has one and pip consults it; the JVM ignores every environment variable and
reads its own truststore. Applying one mechanism uniformly silently fails on two of six
images (research R1–R3, plan.md Complexity Tracking).

### Node images (mechanism: `NODE_EXTRA_CA_CERTS`, appends to Node's built-in roots)

- [X] T009 [P] [US1] In `packages/server/Dockerfile`, add to **both** the `build` and `runtime` stages: `ARG CORP_CA_FILE=`, `COPY infra/certs/ /tmp/foundry-ca/`, a `RUN` that places the requested file at `/etc/foundry/corp-ca.pem`, and `ENV NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+/etc/foundry/corp-ca.pem}`. Both stages run `pnpm install`, so both need it. Place the block **before** the first `RUN corepack enable`.
- [X] T010 [P] [US1] Apply the identical block to `packages/client/Dockerfile`, both stages, before `RUN corepack enable`.
- [X] T011 [P] [US1] Apply the identical block to `packages/ops-api/Dockerfile`, both stages, before `RUN corepack enable`.
- [X] T012 [P] [US1] Apply the identical block to `packages/mcp-bridge/Dockerfile`, both stages, before `RUN corepack enable`.
- [X] T013 [US1] Verify the `${CORP_CA_FILE:+…}` expansion behaves in a real build of `packages/server/Dockerfile`: empty argument yields an empty `NODE_EXTRA_CA_CERTS`, a set argument yields the path (research R5). Add both directions as assertions to `scripts/check-corp-ca-trust.sh`.

### fragment-base (mechanism: anchor dir + `update-ca-certificates`, plus `PIP_CERT`)

- [X] T014 [US1] In `infra/fragment-base/Dockerfile`, add `ARG CORP_CA_FILE=`, `COPY certs/ /tmp/foundry-ca/`, a `RUN` that places the requested file at `/usr/local/share/ca-certificates/corp-ca.crt` and runs `update-ca-certificates`, and `ENV PIP_CERT=${CORP_CA_FILE:+/etc/ssl/certs/ca-certificates.crt}` — before the existing `RUN pip install`.
- [X] T015 [US1] In the same file, comment **why the anchor file must end in `.crt`** (`update-ca-certificates` silently ignores a `.pem` there — a failure with no error message) and **why `PIP_CERT` names the full system bundle and never the lone root** (`PIP_CERT` replaces where Node appends; naming the root alone removes trust in every public authority, FR-004).
- [X] T016 [US1] In the same file, correct the standalone build command in the header comment from `docker build -t foundry/fragment-base:py3.12-pandas2.2.3 infra/fragment-base` to the `-f infra/fragment-base/Dockerfile … infra` form required by the context move in T021 (Constitution VII — same commit as the change that invalidates it).

### kestra (mechanism: `keytool` into the JDK truststore)

- [X] T017 [US1] In `infra/kestra/Dockerfile`, after `USER root` and **before** the first `kestra plugins install` layer, add `ARG CORP_CA_FILE=`, `COPY certs/ /tmp/foundry-ca/`, and a `RUN` that imports the requested file with `keytool -importcert -cacerts -storepass changeit -noprompt -alias foundry-corp-ca -file …` and also places it in the anchor dir with `update-ca-certificates` for non-JVM tooling.
- [X] T018 [US1] In the same file, comment that the JVM reads `/opt/java/openjdk/lib/security/cacerts` and honours **none** of `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `PIP_CERT` or the system bundle — the reason this image cannot share either other mechanism (research R3).
- [X] T019 [US1] In the same file, correct the standalone build command in the header comment for the context move in T021.
- [X] T020 [US1] **Take the deferred end-to-end proof** (research R3, the one mechanism Phase 0 could not verify): build `infra/kestra/Dockerfile` with a certificate and confirm all six `kestra plugins install` layers complete, against a control build with the argument empty which must fail at the first plugin layer. Record both outcomes in `specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt` under a "deferred proofs" heading. If the control does **not** fail, stop and report — it would mean the JVM was reaching Maven Central by some path this design does not model.

### Compose wiring

- [X] T021 [US1] In `infra/docker-compose.yml`, change the `fragment-base` build stanza from `context: ./fragment-base` to `context: .` with `dockerfile: fragment-base/Dockerfile`, and the `kestra` stanza from `context: ./kestra` to `context: .` with `dockerfile: kestra/Dockerfile`, so one staged `infra/certs/` serves every context (research R4).
- [X] T022 [US1] In `infra/docker-compose.yml`, add `build.args` with `CORP_CA_FILE: ${CORP_CA_FILE:-}` to all six building services — `migrate`, `server`, `seed`, `mcp-bridge`, `ops-migrate`, `ops-api`, `web`, `fragment-base`, `kestra` (note: several services share the `packages/server` and `packages/ops-api` Dockerfiles; every build stanza needs the argument or those services build without trust).
- [X] T023 [US1] Add a comment in `infra/docker-compose.yml` beside the new args stating that Compose interpolates `${VAR}` from the **project directory** (`infra/`), not the repo root, so the repo-root `.env` reaches it only via `--env-file .env` run from the repo root — and that without it `CORP_CA_FILE` silently expands to empty and the build proceeds untrusted, which presents as the original bug.
- [X] T024 [US1] Build all six images with `CORP_CA_FILE=corp-ca.pem` and `--no-cache`, and assert via `scripts/check-corp-ca-trust.sh` that each image's own runtime reports the certificate trusted: Node images expose `/etc/foundry/corp-ca.pem` and parse it with `crypto.X509Certificate`; fragment-base's bundle count exceeds the T006 baseline; Kestra's `keytool -list -cacerts -alias foundry-corp-ca` returns the entry.
- [X] T025 [US1] Assert the **runtime** half of FR-002, not only the build half: from a built Node image, perform an outbound HTTPS request through the intercepting proxy and confirm it validates. This is the claim the spec makes in User Story 1 scenario 3, and it is the reason trust is added to the image rather than only to the build.

**Checkpoint**: all six images build behind the proxy and running containers trust the authority. This is the MVP.

---

## Phase 4: User Story 2 — Build unchanged where no interception exists (Priority: P1)

**Goal**: an environment with nothing staged and nothing set builds exactly as it did
before this feature, trusting exactly the authorities it trusted before.

**Independent Test**: build all six images with no `CORP_CA_FILE`, and compare each
image's trusted-authority evidence against the T006 baseline. No authority added, none
removed.

⚠ **This story is mostly verification, and that is honest rather than thin.** Its
implementation is one design choice already made in Phase 3 — `${CORP_CA_FILE:+…}`
rather than an unconditional path. The work here is proving the no-change claim, which
is the claim most likely to be assumed rather than checked.

- [ ] T026 [US2] Build all six images with `CORP_CA_FILE` empty and `--no-cache`, and diff each image's trusted-authority evidence against `baseline-pre-change.txt` from T006. Any difference is a failure of FR-003, including an *addition*.
  - ⚠ **BLOCKED, NOT DONE (2026-08-25).** Requires a successful no-CA build, which is impossible on the affected workstation — every connection is intercepted, so a no-CA build fails for the expected reason. Recorded in `baseline-pre-change.txt`. Needs a non-intercepted network or CI.
- [X] T027 [US2] Assert that with the argument empty, `NODE_EXTRA_CA_CERTS` is the empty string and **not** a path to a non-existent file, in all four Node images. A dangling path is the silent fallback FR-005 exists to prevent.
- [ ] T028 [US2] Assert `infra/fragment-base` builds with the argument empty and that its bundle certificate count equals the T006 baseline exactly — the anchor `RUN` must be a genuine no-op, not a refresh that reorders or re-emits the bundle.
  - ⚠ **BLOCKED, NOT DONE (2026-08-25).** Requires a successful no-CA build, which is impossible on the affected workstation — every connection is intercepted, so a no-CA build fails for the expected reason. Recorded in `baseline-pre-change.txt`. Needs a non-intercepted network or CI.
- [ ] T029 [US2] Assert `infra/kestra` builds with the argument empty and its truststore entry count equals the T006 baseline, and that no `foundry-corp-ca` alias exists.
  - ⚠ **BLOCKED, NOT DONE (2026-08-25).** Requires a successful no-CA build, which is impossible on the affected workstation — every connection is intercepted, so a no-CA build fails for the expected reason. Recorded in `baseline-pre-change.txt`. Needs a non-intercepted network or CI.
- [X] T030 [US2] Verify a **fresh clone** builds with no staging step: clone to a temporary path, confirm `infra/certs/` exists with only `.gitkeep`, and confirm `COPY certs/ …` resolves. This is the failure mode that would make the repository unbuildable for everyone else.
- [ ] T031 [US2] ⚠ **Take the FR-003 no-interception measurement, which CANNOT be taken on this workstation.** Every connection here is intercepted, so "public TLS works with no certificate" fails for the expected reason. Run one no-argument build on a non-intercepted network or in CI, record the result in `baseline-pre-change.txt` under "deferred proofs", and if it cannot be run, record it as **NOT VERIFIED** naming the reason. **Do not mark FR-003 verified from this workstation alone.**
  - ⚠ **BLOCKED, NOT DONE (2026-08-25).** Requires a successful no-CA build, which is impossible on the affected workstation — every connection is intercepted, so a no-CA build fails for the expected reason. Recorded in `baseline-pre-change.txt`. Needs a non-intercepted network or CI.

**Checkpoint**: the feature is proven not to have relocated the breakage.

---

## Phase 5: User Story 3 — A misconfigured request fails loudly (Priority: P2)

**Goal**: a certificate requested but missing, unparseable, or named with a path
separator stops the build at the trust step, naming the file, the directory searched and
the fix.

**Independent Test**: build with `CORP_CA_FILE=does-not-exist.pem` and observe a failure
at the trust step, before any dependent fetch, with all three facts in the message.

⚠ **This guard must be built deliberately because the default behaviour is the
opposite.** Node treats an unreadable `NODE_EXTRA_CA_CERTS` as *absent* and falls back to
its bundled roots — so without an explicit refusal a typo reproduces
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` several steps later with nothing naming the cause.
That is the diagnosis this whole feature exists to stop anyone repeating.

- [X] T032 [P] [US3] Extend the trust `RUN` in `packages/server/Dockerfile` (both stages) so that when `CORP_CA_FILE` is non-empty it: refuses a value containing `/` stating a bare filename is expected; fails if the named file is absent, printing the filename, `/tmp/foundry-ca/` as the directory searched, and the `scripts/stage-corp-ca.sh` command; and fails if the file does not parse via `node -e` using `crypto.X509Certificate` — there is **no openssl** in these images (research R1).
- [X] T033 [P] [US3] Apply the identical guard to `packages/client/Dockerfile`, both stages.
- [X] T034 [P] [US3] Apply the identical guard to `packages/ops-api/Dockerfile`, both stages.
- [X] T035 [P] [US3] Apply the identical guard to `packages/mcp-bridge/Dockerfile`, both stages.
- [X] T036 [US3] Add the equivalent guard to `infra/fragment-base/Dockerfile` using `openssl x509 -noout -in`, which **is** present in that base image.
- [X] T037 [US3] Add the equivalent guard to `infra/kestra/Dockerfile` using `keytool -printcert -file`, and ensure the `keytool -importcert` step fails rather than warns when the alias already exists.
- [X] T038 [US3] Assert the missing-file refusal in every one of the six images: build each with `CORP_CA_FILE=does-not-exist.pem` and require a non-zero exit whose output contains the filename, the searched directory and the staging command. Add to `scripts/check-corp-ca-trust.sh`.
- [X] T039 [US3] Assert the unparseable-file refusal: stage PEM armour wrapping non-certificate bytes and require every image to fail naming the file as unparseable. Measured in research R6 to reject with `asn1 encoding routines::too long`.
- [X] T040 [US3] Assert the path-separator refusal: build with `CORP_CA_FILE=../corp-ca.pem` and require a refusal stating a bare filename is expected, rather than a `COPY`-style error naming a path the image cannot see.
- [X] T041 [US3] Assert the refusal happens **before** the dependent fetch: confirm the failing build's output contains no evidence of `corepack`/`pip`/`kestra plugins install` having started. A refusal that fires after the request has gone out is a log line, not a control.

**Checkpoint**: a misconfiguration costs one clear message instead of a re-diagnosis.

---

## Phase 6: User Story 4 — Certificate material stays out of version control (Priority: P2)

**Goal**: the staged certificate is not committed, is not offered for commit, and cannot
be committed by accident.

**Independent Test**: stage the certificate, inspect pending changes, and attempt an
explicit forced add. It does not appear, and the forced add is refused.

- [X] T042 [US4] Assert `git status --porcelain infra/certs/` lists no certificate after staging, and that `git check-ignore -v infra/certs/corp-ca.pem` names a matching rule.
- [X] T043 [US4] Assert `git add -f infra/certs/corp-ca.pem` is refused by the repository's existing pre-commit secret and key-material guards, and record which guard fired. If **none** fires, that is a finding to report — Constitution VIII's enforcement would then rest on the ignore rule alone.
- [X] T044 [US4] Assert `infra/certs/.gitkeep` **is** tracked while `infra/certs/*.pem` is not, so the ignore rule and the placeholder are verified as the pair they are (T001/T002).
- [X] T045 [US4] Assert `scripts/stage-corp-ca.sh` refuses to write anything with a `.crt` extension into `infra/certs/`, since `.gitignore` covers `*.pem` and not `*.crt` (research R7) — the one naming mistake that would place key material under a name git does not exclude.

**Checkpoint**: the material cannot reach history, and the guard that stops it is identified.

---

## Phase 7: Polish & cross-cutting concerns

- [X] T046 [P] Document `CORP_CA_FILE` and `CORP_CA_SOURCE` in `.env.example` as placeholders with no real value, including the `--env-file .env` (from the repo root) requirement and the note that an empty value means no corporate CA.
- [X] T047 [P] Add a CLAUDE.md section recording: the three mechanisms and why one is impossible; that `node:22-slim` has no system trust store; that `.gitignore` covers `*.pem` but not `*.crt`; that pulls are unaffected; and — explicitly — the two claims resting on a single environment (FR-003 and, if T020 did not complete, the Kestra fetch).
- [X] T048 [P] Add a `ca:check` script entry to the root `package.json` invoking `scripts/check-corp-ca-trust.sh`, matching the existing `kestra:check` convention so the verification is discoverable rather than folklore.
- [X] T049 Run `scripts/check-corp-ca-trust.sh --control` and confirm **every** assertion is observed failing against an untrusted image. An assertion that does not fail here is removed or fixed, never left passing.
- [X] T050 Walk [quickstart.md](./quickstart.md) end to end on a clean cache and correct any step that does not behave as written, including the troubleshooting table.
- [X] T051 Confirm no file in the diff contains `NODE_TLS_REJECT_UNAUTHORIZED`, `--trusted-host`, `checkRevocation=false`, `--no-check-certificate` or any other verification bypass (FR-007), and that the grep is shown finding something when run against a deliberately-inserted instance.
- [ ] T052 Run `/speckit-comply` and resolve any CRITICAL finding before requesting review (Constitution III).

---

## Dependencies & execution order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1. **BLOCKS all stories** — and T006–T008 capture state that is unrecoverable once Phase 3 edits land.
- **Phase 3 (US1)**: depends on Phase 2. The MVP.
- **Phase 4 (US2)**: depends on Phase 3 *and* on T006's baseline. Cannot be done first — there would be nothing to compare against.
- **Phase 5 (US3)**: depends on Phase 3, because the guard extends the `RUN` block Phase 3 creates.
- **Phase 6 (US4)**: depends on Phase 1 only. **Can run in parallel with Phase 3.**
- **Phase 7 (Polish)**: depends on the stories being delivered.

### Story dependencies

- **US1 (P1)**: after Phase 2. No dependency on another story.
- **US2 (P1)**: after US1, and needs T006. Its whole content is a comparison.
- **US3 (P2)**: after US1 — it edits the same `RUN` blocks, so US1 and US3 tasks touching one file are **not** parallel with each other.
- **US4 (P2)**: independent of US1–US3; needs only Phase 1.

### Within each story

- Image edits before the builds that verify them.
- The `COPY`/`ENV` mechanism (US1) before the validation guard (US3) in the same file.
- Compose wiring (T021–T023) before the full six-image build (T024).

---

## Parallel opportunities

```bash
# Phase 1 — different files
Task: "T002 Add infra/certs/ rule to .gitignore"
Task: "T003 Create scripts/stage-corp-ca.sh"

# Phase 3 — the four Node images are four separate files, identical block
Task: "T009 packages/server/Dockerfile"
Task: "T010 packages/client/Dockerfile"
Task: "T011 packages/ops-api/Dockerfile"
Task: "T012 packages/mcp-bridge/Dockerfile"

# Phase 5 — same four files again, but only after Phase 3 has landed in each
Task: "T032 packages/server/Dockerfile guard"
Task: "T033 packages/client/Dockerfile guard"
Task: "T034 packages/ops-api/Dockerfile guard"
Task: "T035 packages/mcp-bridge/Dockerfile guard"

# Cross-phase — US4 needs nothing from US1
Task: "Phase 6 (T042–T045)"  # alongside Phase 3
```

⚠ **`infra/fragment-base/Dockerfile` and `infra/kestra/Dockerfile` are NOT parallel with
each other's verification builds** if the host builds serially — and T020's Kestra proof
is the slowest task in the list (six plugin-download layers).

---

## Implementation strategy

### MVP first (US1 only)

1. Phase 1 → Phase 2 (**do not skip T006** — the baseline is unrecoverable later).
2. Phase 3.
3. **STOP and VALIDATE**: all six build behind the proxy; the control build still fails.
4. At this point `docker compose up -d` works on the affected workstation, which is the
   original request.

### Incremental delivery

1. Setup + Foundational → baseline captured, harness can fail.
2. **US1** → the proxy build works → *this is the deliverable*.
3. **US2** → proves every other environment is unharmed → required before merge, because
   without it the feature might have relocated the breakage.
4. **US3** → a misconfiguration costs one message instead of a re-diagnosis.
5. **US4** → the material provably cannot reach history.

### Suggested merge gate

US1 **and** US2 together. US1 alone is a fix that might have broken CI and nobody
checked; US2 is what makes the change defensible. US3 and US4 can follow, but US4 is
cheap and touches no image — there is little reason to defer it.

---

## Notes

- **52 tasks**: 4 setup · 4 foundational · 17 US1 · 6 US2 · 10 US3 · 4 US4 · 7 polish.
- Every `[P]` task touches a different file from its siblings.
- Commit after each phase; the two Dockerfile-comment corrections (T016, T019) must land
  in the **same commit** as the context move that invalidates them (T021), per
  Constitution VII.
- **Two tasks may legitimately end as NOT VERIFIED and must say so rather than be
  quietly dropped**: T031 (FR-003, needs a non-intercepted network) and T020 if the
  Kestra build cannot be completed. Recording an unproven claim as proven is the failure
  mode this feature's own research section was written to avoid.
