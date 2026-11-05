# Feature Specification: Corporate CA trust for Docker builds

**Feature Branch**: `20260824-211547-docker-ca-trust`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "Every Docker image in this repo fails to build behind the corporate TLS-intercepting proxy with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Each image must accept an OPTIONAL corporate CA certificate as a build input and import it into the image's own trust store when supplied, so builds succeed behind the proxy AND continue to succeed unchanged where no CA is supplied. The CA material must never be committed to git. A missing-but-requested certificate must fail the build loudly rather than silently falling back to untrusted."

## Overview

`docker compose up -d` cannot build any image in this repository on a workstation
whose network re-signs TLS with a private root certificate authority. Every image
performs at least one network fetch during its build — each one retrieving a
pinned dependency from an external registry — and every such fetch fails
certificate validation because the build container does not trust the re-signing
authority.

The failure is **not** a reachability problem, and that distinction is what makes
it hard to diagnose: the connection succeeds, the certificate arrives, and
validation rejects it because the issuing authority is absent from the container's
trust store. No proxy setting, mirror or retry addresses it.

The host already trusts the authority, through environment variables that name
exported certificate files. Neither the variables nor the files cross into a build
container: a build's environment is constructed from the image definition and its
declared build inputs alone, and its filesystem contains only the build context.
So the trust that makes every other tool on the workstation work is structurally
unavailable to the thing that is failing.

This feature makes the certificate an explicit, optional build input for every
image, so a workstation behind an intercepting proxy can supply it and every other
build environment is unaffected.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build the stack behind an intercepting proxy (Priority: P1)

A developer on the corporate network, whose workstation already trusts the
intercepting authority for ordinary command-line work, stages the certificate once
and brings the stack up. Every image builds. They do not edit any image definition,
and they do not disable certificate verification anywhere.

**Why this priority**: This is the entire reason the feature exists. Today the
stack cannot be built at all on such a workstation, which blocks every other kind
of work. Nothing else in this specification matters if this does not hold.

**Independent Test**: On a workstation behind the proxy, stage the certificate and
run a full build from a clean image cache. Every image completes and no build step
reports a certificate validation failure.

**Acceptance Scenarios**:

1. **Given** a workstation whose network re-signs TLS with a private authority, and
   the certificate has been staged, **When** the developer builds every image from
   a clean cache, **Then** all builds complete successfully.
2. **Given** the same workstation and staged certificate, **When** the developer
   inspects the build output, **Then** no step reports a certificate validation
   failure and no step reports having skipped or disabled verification.
3. **Given** a successful build, **When** a container from any built image performs
   an outbound request to a host reached through the intercepting proxy, **Then**
   the request succeeds, because the trust was added to the image rather than
   applied only during the build.

---

### User Story 2 - Build unchanged where no interception exists (Priority: P1)

A developer at home, a continuous-integration runner, and a cloud builder all
build the same images without supplying any certificate, exactly as they do today.
They are not required to stage anything, set anything, or know that this feature
exists.

**Why this priority**: Equal to P1 because a fix that only works on one network is
not a fix — it relocates the breakage. If supplying a certificate becomes
mandatory, every build environment without one breaks, which is a strictly worse
outcome than the problem being solved.

**Independent Test**: With no certificate staged and no build input supplied, build
every image from a clean cache in an environment that does not intercept TLS. All
builds complete, and the resulting images trust exactly the public authorities they
trusted before this feature.

**Acceptance Scenarios**:

1. **Given** an environment that does not intercept TLS and no certificate staged,
   **When** every image is built from a clean cache, **Then** all builds complete
   successfully.
2. **Given** that same build, **When** the resulting images are compared against
   images built before this feature, **Then** their trusted-authority sets are
   equivalent — no authority has been added and none removed.
3. **Given** a repository clone containing no certificate material, **When** a
   developer builds without reading any documentation, **Then** the build succeeds
   without prompting, warning, or requiring a decision.

---

### User Story 3 - A misconfigured request fails loudly (Priority: P2)

A developer asks for a certificate to be trusted but the certificate is missing,
unreadable, or not a certificate. The build stops immediately, naming what it
looked for and where. It does not continue and fail later at a network fetch.

**Why this priority**: Lower than P1 because it concerns a misconfiguration rather
than the primary journey, but it is the difference between a five-minute fix and
re-deriving the original diagnosis. The default behaviour of the affected toolchain
is to treat an unreadable certificate file as absent, which reproduces the original
error with nothing pointing at the cause — so the loud failure has to be built
deliberately.

**Independent Test**: Request a certificate by a name that is not staged. The build
fails at the trust step with a message naming the expected filename and location,
and no network fetch is attempted.

**Acceptance Scenarios**:

1. **Given** a certificate is requested by name but no such file is staged, **When**
   the image is built, **Then** the build fails at the trust step with a message
   naming the expected filename and the directory searched.
2. **Given** a staged file that is not a valid certificate, **When** the image is
   built, **Then** the build fails with a message identifying the file as
   unparseable, rather than proceeding with it ignored.
3. **Given** either failure above, **When** the developer reads the build output,
   **Then** the message states the corrective action, and no later step has run.

---

### User Story 4 - Certificate material stays out of version control (Priority: P2)

A developer stages the certificate, builds, and commits unrelated work. The
certificate is not committed, is not offered for commit, and cannot be committed by
accident.

**Why this priority**: The material is organisation-specific and is key material.
Committing it would place it permanently in history where removal requires
rewriting that history. The project constitution prohibits it outright, so this is
a constraint the feature must satisfy rather than a preference.

**Independent Test**: Stage the certificate, then inspect pending changes. The
certificate does not appear. Attempt to commit it explicitly; the attempt is
refused.

**Acceptance Scenarios**:

1. **Given** a staged certificate, **When** the developer inspects pending changes,
   **Then** no certificate file appears among them.
2. **Given** a staged certificate, **When** the developer attempts to commit it
   explicitly, **Then** the commit is refused by the repository's existing secret
   and key-material guards.
3. **Given** a fresh clone by a developer on the same corporate network, **When**
   they follow the documented setup, **Then** they obtain the certificate from their
   own workstation rather than from the repository.

---

### Edge Cases

- **A certificate is staged but not requested.** The build must ignore it and
  produce an image identical to one built with no certificate present. Presence of
  a file is not a request to trust it; trust follows an explicit request only, so
  that a leftover file cannot silently change what an image trusts.
- **The trust mechanism differs per image.** The images do not share one runtime,
  and the affected toolchains disagree about how trust is established: one *adds*
  to a bundled set, one *replaces* the set entirely, and one ignores the
  environment altogether and reads its own store. A single mechanism applied
  uniformly will silently fail on at least one image, and replacing rather than
  adding will break trust in the public authorities. Each image must establish
  trust by the means its own toolchain honours, and the result must be verified
  per image rather than assumed from one success.
- **The images do not share one build context.** Certificate material must be
  reachable from every build context. A single location that only some contexts can
  see produces a partial fix whose symptom is that a subset of images still fail,
  which reads as an unrelated problem.
- **A cached layer hides a change.** Restaging a different certificate must not
  silently reuse a layer built with the previous one; a rebuild must reflect the
  material actually staged.
- **Two certificates in a chain.** Where the intercepting authority presents an
  intermediate as well as a root, supplying the material must trust the chain, not
  only the leaf-most file.
- **Verification must be able to fail.** A check that confirms trust was
  established must be shown to report failure when trust is absent — otherwise a
  passing check is indistinguishable from a check that examines nothing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every image built by this repository MUST accept a corporate CA
  certificate as an optional build input.
- **FR-002**: When a certificate is supplied, each image MUST import it into the
  trust store its own runtime consults, such that network fetches during the build
  and outbound requests from the running container both validate certificates
  issued by that authority.
- **FR-003**: When no certificate is supplied, every image MUST build successfully
  and MUST trust exactly the set of authorities it trusted before this feature —
  no additions, no removals.
- **FR-004**: Supplying a certificate MUST NOT remove or replace trust in the
  public authorities an image already trusted.
- **FR-005**: When a certificate is requested but cannot be found or cannot be
  parsed as a certificate, the build MUST fail at the point of import, before any
  network fetch that depends on it.
- **FR-006**: A failure under FR-005 MUST name the filename expected, the location
  searched, and the corrective action.
- **FR-007**: The system MUST NOT disable, bypass, or weaken certificate
  verification in any image, under any configuration, as a means of allowing a
  build to proceed.
- **FR-008**: Certificate material MUST NOT be committed to version control, and
  the repository's existing key-material guards MUST refuse it if attempted.
- **FR-009**: Certificate material MUST be stageable into every build context used
  by this repository, by a single documented action.
- **FR-010**: A certificate present in a build context but not requested MUST NOT
  be trusted, and MUST produce an image equivalent to one built with no certificate
  present.
- **FR-011**: The repository MUST provide a means of verifying, per image, that
  trust was established when requested and not established when not requested.
- **FR-012**: The verification under FR-011 MUST be demonstrated to fail when trust
  is absent, so that a passing result is evidence rather than assumption.
- **FR-013**: Documentation MUST state how to obtain and stage the certificate, and
  MUST record that the material is workstation-local and deliberately untracked.
- **FR-014**: Rebuilding after staging different certificate material MUST produce
  an image reflecting the material actually staged, rather than reusing a cached
  result from earlier material.

### Key Entities

- **Corporate CA certificate**: The public certificate of the authority that
  re-signs intercepted TLS connections. Public material, but organisation-specific
  and deliberately untracked. Obtained from the developer's own workstation, where
  it is already trusted.
- **Build context**: The set of files an image build can read. This repository uses
  three distinct ones, so certificate material must reach all three.
- **Trust store**: The collection of authorities a runtime consults when validating
  a certificate chain. Each image runtime has its own, reached by its own means.
- **Build input**: The declared, per-build value by which a certificate is
  requested. Its absence is the default and means "no corporate certificate".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a workstation behind an intercepting proxy, a developer builds
  every image from a clean cache with zero certificate-related failures, having
  performed exactly one staging action and edited no image definition.
- **SC-002**: In an environment with no interception and nothing staged, every
  image builds from a clean cache with no additional steps — a measured no-change
  outcome against the pre-feature baseline.
- **SC-003**: 100% of the repository's images accept the certificate input; none is
  left needing a manual workaround.
- **SC-004**: A requested-but-absent certificate stops the build within the trust
  step in every image, with a message that names the file, the location and the fix.
- **SC-005**: Zero certificate files appear in version control at any point, and an
  explicit attempt to commit one is refused.
- **SC-006**: A developer new to the corporate network reaches a fully built stack
  by following the documentation alone, without reading any image definition.
- **SC-007**: Every trust claim is verified per image by a check demonstrated to
  fail when trust is absent.
- **SC-008**: No image, in any configuration, disables or weakens certificate
  verification.

## Assumptions

- **The certificate is already available on the affected workstation.** It is
  already exported and trusted there for ordinary command-line work, so this
  feature consumes existing material rather than obtaining or generating it.
- **Trust is added to the image, not applied only to the build.** This costs
  nothing extra and additionally fixes outbound requests from running containers
  through the same proxy. Build-time-only trust would leave a second failure to
  diagnose later.
- **The certificate is requested explicitly rather than detected.** Auto-detecting
  a staged file would make a leftover file silently change what an image trusts,
  and would make two developers' builds differ by the contents of an untracked
  directory.
- **Certificate material lives in a repository-local, untracked location** rather
  than being read from a developer's home directory during the build. A build can
  only read its own context, so material has to be staged into it; the repository's
  existing key-material exclusions already cover the file type.
- **Certificate material is public.** A CA's public certificate is not a secret;
  it is excluded from version control because it is organisation-specific and
  because the constitution prohibits committing key material, not because
  disclosure is harmful.
- **This feature does not change what the images fetch, or from where.** Reducing
  network dependency during builds would shrink the affected surface and is
  deliberately out of scope here.
- **This feature does not introduce an internal image registry or package mirror.**
  Pre-trusted base images would remove the need for this feature entirely, but that
  is an organisational capability outside this repository's control.
- **One intercepting authority.** If a deployment needed several unrelated
  authorities simultaneously, the design would extend to a set; that is not built
  now.
- **Verification runs against real built images.** Trust cannot be confirmed by
  reading image definitions, because the toolchains disagree about which mechanism
  they honour.
