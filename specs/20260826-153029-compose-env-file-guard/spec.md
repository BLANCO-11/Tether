# Feature Specification: A build that cannot reach its dependencies says so

**Feature Branch**: `20260826-153029-compose-env-file-guard`

**Created**: 2026-08-26

**Status**: Draft

**Input**: User description: "fix the above thing also" — following a real `docker compose up -d` failure in which every image build died at `corepack` with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, indistinguishable from the defect the corporate-CA feature had already fixed.

---

## Context: what actually happened

The corporate-CA feature (`20260824-211547-docker-ca-trust`) made build-time trust
follow an **explicit build argument**, `CORP_CA_FILE`. That decision is correct and
this feature does not revisit it: trust must never follow the accidental presence
of a file in an untracked directory.

What the feature did not do is make the *absence* of that argument distinguishable
from a deliberate choice. Measured on 2026-08-26 with `docker compose config`:

| Invocation | `CORP_CA_FILE` resolves to |
| :--- | :--- |
| `docker compose up -d` run from `infra/` | `""` |
| `pnpm infra:up` | `""` |
| `docker compose -f infra/docker-compose.yml --env-file .env …` | `corp-ca.pem` |

Compose interpolates `${VAR}` from the **project directory** — the directory
holding the compose file, i.e. `infra/`. There is no `infra/.env`, and the
repository's `.env`, which does carry `CORP_CA_FILE=corp-ca.pem`, is never read.
So the trust step became a no-op *exactly as designed*, the build proceeded
untrusted, and it failed at the first dependency fetch.

⚠ **The resulting error names `corepack` and a TLS certificate, and mentions
neither the variable nor the flag.** It is byte-for-byte the error the CA feature
exists to fix, which is the worst possible symptom: the person reading it
reasonably concludes the fix does not work.

⚠ **The scope is wider than the two `package.json` scripts.** Six invocations in
the repository print or run a build-triggering compose command with no
`--env-file`, and only one gets it right:

| Site | Command | Triggers a build? |
| :--- | :--- | :--- |
| `package.json` `infra:up` | `up -d` | **yes** |
| `scripts/kestra-boundary-check.sh:39` | `up -d kestra` | **yes** |
| `scripts/kestra-boundary-check.sh:324` | `build fragment-base` | **yes** |
| `scripts/kestra-ui-url.sh:15` | `up -d kestra` | **yes** |
| `scripts/restore.sh:180` | `up -d` | **yes** |
| `scripts/kestra-env.sh:29` | `up -d` | **yes** |
| `scripts/stage-corp-ca.sh:121` | `--env-file .env … build` | correct |
| `package.json` `infra:down` | `down` | no — harmless |

Every one of the six is a documented instruction that leads a developer into this
failure. `CLAUDE.md` already carries the warning; a warning in prose is not a
control, which is the lesson this repository has recorded repeatedly.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A failed build names its own cause (Priority: P1)

A developer on a TLS-intercepting corporate network runs a build without supplying
the corporate CA. Instead of a certificate stack trace from a package manager, they
get a refusal that names what is missing, why the build cannot proceed, and the
exact command that fixes it.

**Why this priority**: this is the whole defect. The other stories reduce how often
it is reached; this one makes it survivable when it is. It is also the only story
that helps someone who invoked compose by hand, in a way no script fix can reach.

**Independent Test**: on the affected workstation, run a build with the argument
empty. The build must fail, the message must name the argument and the flag, and
the failure must occur **before** any dependency-fetching step runs.

**Acceptance Scenarios**:

1. **Given** an intercepting network and no corporate CA requested, **When** any of
   the six images is built, **Then** the build fails at the trust step with a
   message naming `CORP_CA_FILE`, `--env-file .env`, and the staging script — and
   the output contains no `corepack`, `pnpm`, `pip` or `keytool` fetch error,
   because none of them ran.
2. **Given** the same network and the CA correctly requested, **When** the images
   are built, **Then** every build succeeds, exactly as it does today.
3. **Given** a non-intercepting network and no corporate CA requested, **When** the
   images are built, **Then** every build **succeeds** and no trust is added.
4. **Given** a developer who reads only the refusal message, **When** they follow
   it verbatim, **Then** the next build succeeds without further diagnosis.

---

### User Story 2 — Every documented command works as printed (Priority: P1)

Every command this repository tells a developer to run — in `package.json`, in a
script's remediation hint, in a check's failure output — either builds with trust
established or does not build at all. No printed command leads into the failure in
Story 1.

**Why this priority**: also P1, and for a reason worth stating: Story 1 turns a
confusing failure into a clear one, but a clear failure is still a failure. This
story is what stops the six known paths reaching it. The two together are the
feature; either alone leaves half the problem.

**Independent Test**: enumerate every compose invocation in the repository that can
trigger a build, and assert each resolves the argument to a non-empty value on a
workstation whose `.env` requests a CA. A single site that resolves to empty fails
the story.

**Acceptance Scenarios**:

1. **Given** a workstation with `CORP_CA_FILE` set in the repository `.env`, **When**
   `pnpm infra:up` is run, **Then** the build receives the CA and succeeds.
2. **Given** the same, **When** any remediation command printed by
   `kestra-boundary-check.sh`, `kestra-ui-url.sh`, `kestra-env.sh` or `restore.sh`
   is copied and run verbatim, **Then** the build receives the CA.
3. **Given** a **new** build-triggering compose invocation added anywhere in the
   repository without the flag, **When** the test suite runs, **Then** it fails and
   names the offending file and line.

---

### User Story 3 — The choice not to trust a CA stays available (Priority: P2)

A developer on a network with no interception, or in CI, can still build with no
corporate CA and get an image whose trusted-authority set is unchanged.

**Why this priority**: P2 because it is a property to be **preserved**, not built —
but it is the constraint that rules out the obvious implementation. An
unconditional refusal when no CA is requested would make every un-intercepted build
fail, and would make `FR-003` of the previous feature permanently unverifiable.

**Independent Test**: this is the previous feature's `T026`/`T028`/`T029`/`T031`,
which are **still open and blocked** on exactly the network this story describes.
The same `verify-fr003.sh` run must continue to pass after this feature lands.

**Acceptance Scenarios**:

1. **Given** a network with no interception, **When** a build runs with no CA
   requested, **Then** it succeeds and adds no certificate to any trust store.
2. **Given** the same, **When** the previous feature's blocked verification script
   is run, **Then** it reaches its measurements rather than being refused by this
   feature's new behaviour.

---

### Edge Cases

- **The variable is set but the file is absent** — already handled by the previous
  feature and must keep working; this feature must not shadow it with a different
  message for the same state.
- **A non-build command** (`down`, `stop`, `logs`, `ps`) run without the flag —
  must **not** be refused. Nothing is being built, and refusing here would make the
  guard something people route around.
- **A build of an image that fetches nothing** — if such a target is ever added, the
  guard must not refuse it for lacking trust it does not need.
- **CI with no `.env` file at all** — must behave as "no CA requested", i.e. Story 3,
  and must not fail for a missing file.
- **A partially-cached build** where the trust step is a cache hit — the guard must
  still be correct, and must not pass merely because it did not re-run.
- **The developer's network changes between builds** (office to home, VPN on/off)
  with an unchanged `.env` — behaviour must be correct in both, without editing
  configuration.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When no corporate CA is requested and the build's network cannot
  validate public TLS, the build MUST fail at the trust step, before any
  dependency-fetching step executes.
- **FR-002**: That failure message MUST name (a) the build argument, (b) how to
  supply it including the `--env-file` flag and the directory to run from, and
  (c) the staging step for the certificate itself.
- **FR-003**: When no corporate CA is requested and the network **can** validate
  public TLS, the build MUST proceed and MUST add no certificate to any trust
  store. Behaviour is unchanged from today.
- **FR-004**: When a corporate CA is requested and valid, behaviour MUST be
  unchanged from today, in all six images.
- **FR-005**: The refusal MUST be distinguishable from the previous feature's
  existing refusals (argument set but file missing; file present but unparseable).
  Three different causes MUST produce three different messages.
- **FR-006**: Every compose invocation in the repository that can trigger a build
  MUST supply the environment file — in `package.json` scripts, in script
  remediation output, and in check failure output.
- **FR-007**: A test MUST fail if a build-triggering compose invocation is added
  anywhere in the repository without the environment file, and MUST name the file
  and line. The test MUST itself be proven capable of failing.
- **FR-008**: Non-build compose commands MUST NOT be refused or altered.
- **FR-009**: The feature MUST NOT introduce a way to request trust other than the
  existing explicit argument. In particular it MUST NOT infer trust from the
  presence of a staged certificate.
- **FR-010**: The feature MUST NOT require a new secret, credential or key.
- **FR-011**: Documentation that currently warns about this in prose MUST be updated
  to state what is now enforced, and MUST NOT continue to describe the warning as
  the control.

### Key Entities

- **Trust request** — the existing `CORP_CA_FILE` build argument. Unchanged in
  meaning: empty means "no corporate CA", never "look and see".
- **Network reachability** — whether the build environment can validate a public TLS
  certificate chain without help. Observable at build time; not configuration, and
  not something a developer should have to declare.
- **Invocation site** — any place in the repository that runs or prints a compose
  command capable of triggering a build. Eight are known; the register must be
  derived by a check rather than transcribed, or it goes stale.

---

## Success Criteria *(mandatory)*

- **SC-001**: On an intercepting network with no CA requested, a developer reaches a
  correct diagnosis from the build output alone, with no reference to any document.
- **SC-002**: The time from failed build to successful build, for a developer who
  has never seen this failure, is under two minutes and requires no help.
- **SC-003**: Zero build-triggering invocations in the repository resolve the trust
  argument to empty on a workstation configured to use a CA. Verified by a check,
  not by inspection.
- **SC-004**: All six images continue to build successfully with the CA requested,
  and the corporate-CA verification suite continues to report 15 of 15.
- **SC-005**: The three distinct failure causes produce three distinct messages,
  each naming its own remedy.
- **SC-006**: A build on a non-intercepting network with no CA requested succeeds and
  leaves every image's trusted-authority set identical to its base image.
- **SC-007**: Every control added by this feature is demonstrated failing at least
  once, and that demonstration is recorded.

---

## Assumptions

1. **The build environment's network is a reliable enough signal.** A build that
   cannot validate public TLS cannot install its dependencies either, so the
   condition being tested is the condition that matters. This is preferred over a
   new "I am behind a proxy" declaration, which would be a second source of truth
   about the same fact and could disagree with reality after a VPN change.
2. **Adding one reachability check per build is acceptable.** The build already
   makes the equivalent request one step later; the cost is a duplicated handshake
   on the success path, bought in exchange for a named failure.
3. **The corporate CA certificate remains public material** — a CA's public
   certificate is not a secret. It stays untracked because it is
   organisation-specific, not because it is sensitive.
4. **`.env` remains the source of the trust request.** This feature does not
   introduce a second configuration location, and specifically does not create
   `infra/.env`, which would put a second environment file in play and make which
   one won depend on how compose was invoked.
5. **Deployments other than local development are out of scope.** No CI pipeline
   currently builds these images; when one exists it inherits Story 3's behaviour.

---

## Dependencies

- Depends on `specs/20260824-211547-docker-ca-trust/`, whose build argument,
  per-image trust mechanisms and staging script this feature relies on and does not
  change.
- ⚠ **That feature has four open, blocked tasks** — `T026`, `T028`, `T029`, `T031` —
  all requiring a build on a non-intercepting network. This feature must not make
  them harder to take; Story 3 exists to guarantee that, and its acceptance is
  measured with that feature's own `verify-fr003.sh`.

---

## Out of Scope

- Revisiting the decision that trust follows an explicit argument (FR-009).
- Reducing what the build fetches from the network, or vendoring dependencies. That
  is a real and larger option, and it is a different feature.
- Pre-trusted internal base images — the durable organisational answer, and outside
  this repository's control.
- Any change to runtime (as opposed to build-time) certificate handling.
- Making the certificate itself easier to obtain or distribute.

---

## Backfilled additions 2026-08-26 — `.env.example` values emptied

⚠ **This section documents a change made OUTSIDE the spec-kit workflow.** It was
reverse-engineered from the staged diff, not from a prior specification. Author's
stated intent: *"I have updated .env.example, removed all dummy secrets."*

### What the diff actually does

One file, `.env.example`, 22 insertions and 22 deletions. Every one is the same
edit: an assignment's **value** is replaced with nothing. No key was added, no key
was removed, and every explanatory comment is untouched.

After the change **all 29 keys in the file carry an empty value** — the 22 changed
here plus 7 (`RUNTIME_JWT_SECRET`, `SUPER_ADMIN_EMAILS`, the five `MAIL_*`) that
were already empty.

### User Story B1 — The example file cannot be mistaken for a working config (Priority: P2)

Someone reading `.env.example`, or copying it to `.env`, gets no value that could
be taken for a usable credential or silently work by accident. Every value must be
supplied deliberately.

**Independent Test**: no assignment in `.env.example` has a non-empty value.

**Acceptance Scenarios**:

1. **Given** the committed `.env.example`, **When** every assignment is read,
   **Then** each has an empty value.
2. **Given** the same file, **When** it is copied to `.env` and the stack is
   started, **Then** nothing starts with a working default — every value must be
   filled in first.
3. **Given** the diff, **When** its removed lines are scanned against the
   repository's own secret-content patterns, **Then** none matches, so no
   credential requires rotation.

### Functional Requirements (as built)

- **FR-B1**: No assignment in `.env.example` carries a non-empty value.
- **FR-B2**: Every variable name previously documented remains documented. The
  file is still the register of what the deployment reads.
- **FR-B3**: Every explanatory comment is preserved verbatim.
- **FR-B4**: No file other than `.env.example` is modified.

### Findings — read these before treating the change as complete

- ⚠ **F1 — THIS DOES NOT UNBLOCK THE PUSH, and it is likely to be assumed that it
  does.** `git push` is refused over `packages/client/.env.local.example`, a
  **different file**, rejected for its **name** (`ci/secret-policy.sh:14` matches
  `.env.*`, and the exemption on line 13 lists only three literal names). It is not
  a content rule, so emptying values in `.env.example` cannot affect it. That block
  needs the exemption widened, which is a separate change to enforcement machinery.
- ⚠ **F2 — NON-SECRET OPERATIONAL DEFAULTS WERE BLANKED TOO, and the file now
  contradicts itself.** `PORT`, `WS_PORT`, `NODE_ENV`, `TETHER_BASE_URL`,
  `KESTRA_RETENTION_DAYS`, `KESTRA_PURGE_CRON`, `KESTRA_FRAGMENT_IMAGE`,
  `KESTRA_NAMESPACE_PREFIX`, `BUDGET_DEFAULT_*` and the model names are not
  secrets. Their surviving comments still describe values that are no longer there
  — the header says *"Host ports form one block: 4000 API, 4001 WS, 4002 web, 4003
  mcp-bridge"* directly above `PORT=`, and *"Matches infra/docker-compose.yml (host
  port 5433)"* above an empty `DATABASE_URL`. Several are load-bearing per
  `CLAUDE.md`: the port block, Postgres's `+1` offset, and `KESTRA_RETENTION_DAYS`,
  which **is** the replay window. **[BACKFILLED — verify with author]** whether
  blanking the non-secret defaults was intended, or only the credential-shaped ones.
- **F3 — Nothing needs rotating.** Every removed value was checked against the
  repository's own `SECRET_CONTENT_PATTERNS`; **none matched**. The removed values
  were development placeholders (`dev-parent-key`, `<your-tether-api-key>`, a
  loopback DSN with `foundry:foundry`). This is the one question that would have
  been expensive to get wrong, and the answer is clean.
- ⚠ **F4 — an empty value is a WEAKER placeholder than a shaped one.**
  `TETHER_API_KEY=<your-tether-api-key>` told a reader what to supply; `=` does not.
  Article VIII requires every variable be *"documented as a placeholder"*, and a
  bare `=` is the least informative form of that. The comments carry much of the
  loss, but not for the variables whose comments describe rationale rather than shape.
- **F5 — no runtime or build impact.** Nothing reads `.env.example`
  programmatically; compose loads `.env`, and the six references to the filename in
  `scripts/`, `ci/` and `.githooks/` are all error-message text.
