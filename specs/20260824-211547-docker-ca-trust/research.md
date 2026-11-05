# Phase 0 Research: Corporate CA trust for Docker builds

**Feature**: `20260824-211547-docker-ca-trust`
**Date**: 2026-08-24
**Method**: every finding below was measured against the actual base images on the
affected workstation, which sits behind the intercepting proxy. Each claim about a
mechanism has a **control** that shows the check can fail — a mechanism verified
only in its passing direction is indistinguishable from one that was never checked.

⚠ **Three findings overturned the design that was assumed before measuring.** They
are recorded as corrections, not as conclusions, because the assumed design would
have failed on two of the six images and nothing in a passing build would have said
why.

---

## R1 — The Node images have NO system trust infrastructure at all

**This is the finding that changed the design.** The intended approach was "add the
certificate to the image's system trust store, then point every toolchain at the
system bundle" — one mechanism for all six images. That is impossible here.

Measured in `node:22-slim` (`node -v` → v22.23.2, Debian trixie):

| Thing | Present? |
| :--- | :--- |
| `/etc/ssl/certs/ca-certificates.crt` (system bundle) | **ABSENT** |
| `update-ca-certificates` | **ABSENT** |
| `/usr/local/share/ca-certificates` (anchor dir) | **ABSENT** |
| `openssl` | **ABSENT** |
| `ca-certificates` package | **`un`** (never installed) |

Node does not need any of it: it carries a compiled-in root set, which is why
`corepack` works on an ordinary network in an image with no system CA bundle
whatsoever.

**Decision**: for the four Node images the mechanism is `NODE_EXTRA_CA_CERTS`
pointing at the certificate file directly. There is no system store to add to.

**Rationale**: `NODE_EXTRA_CA_CERTS` *appends* to Node's built-in roots, so the
single intercepting root certificate is sufficient and public trust is preserved
(FR-004). Installing `ca-certificates` via `apt-get` was rejected: it is itself a
network fetch, which is the thing that is broken — and on a proxied network the
chicken-and-egg is real.

**Alternatives considered**:
- *Install `ca-certificates` and use the system bundle* — rejected: adds a network
  dependency to the fix for a network failure, and adds a package to four images to
  serve a mechanism Node ignores by default.
- *`--use-openssl-ca`* — rejected: switches Node from its bundled roots to the
  system store, which does not exist in this image. It would *reduce* trust to
  nothing.
- *BuildKit secret mount* (`RUN --mount=type=secret`) — rejected: the certificate
  must persist in the image so that outbound requests from the running container
  also validate (FR-002). A secret mount is build-time only, and deliberately
  leaves nothing behind.

**MEASURED, with a control** — the control reproduces the exact error from the
original build log:

```
CONTROL   (no CA):        RESULT: FAILED - UNABLE_TO_GET_ISSUER_CERT_LOCALLY
TREATMENT (CA supplied):  RESULT: HTTP 200
```

And against the actual failing command rather than a stand-in:

```
CONTROL   corepack enable && corepack prepare pnpm@10.29.2 --activate  → fails
TREATMENT same, with NODE_EXTRA_CA_CERTS                               → prints 10.29.2
```

`packageManager` in the repo root `package.json` is `pnpm@10.29.2`, so the version
fetched in the test is the version the real builds fetch.

---

## R2 — Python needs the system store, and does NOT need `PIP_CERT`

Measured in the digest-pinned base (`python@sha256:57cd7c…`, Python 3.12.13, Debian
trixie) — the opposite of R1: **full** trust infrastructure present.

| Thing | Present? |
| :--- | :--- |
| `/etc/ssl/certs/ca-certificates.crt` | present (224,449 bytes) |
| `update-ca-certificates` | `/usr/sbin/update-ca-certificates` |
| `/usr/local/share/ca-certificates` | present |
| `openssl` | `/usr/bin/openssl` |
| top-level `certifi` | **absent** |
| `pip._vendor.certifi` | present |
| `pip._vendor.truststore` | **present** |

**Decision**: place the certificate in the anchor directory as a `.crt` file and run
`update-ca-certificates`. Additionally set `PIP_CERT` to the system bundle.

**Rationale for the anchor + refresh**: measured to be *sufficient on its own*. pip
25.0.1 vendors `truststore` and consults the system store, so the refresh alone
fixes it.

**Rationale for setting `PIP_CERT` anyway** — and this is a judgement call worth
challenging at review: it is one line, and it makes the build depend on a bundle we
named rather than on pip continuing to prefer `truststore` over its vendored
`certifi`. Without it the build works *because of a current pip default*. The bundle
it names is the **full** system bundle (151 certificates after the refresh), not the
lone corporate root — `PIP_CERT` *replaces* rather than appends, so naming the
single root would break every public TLS connection (FR-004).

⚠ **The first control here was worthless and is recorded because of it.** The initial
"without `PIP_CERT`" arm ran *after* the certificate was already in the system store,
so it succeeded — and that success said nothing about whether the certificate
mattered. Re-run as a true control with no certificate anywhere:

```
TRUE CONTROL (no CA):            SSLCertVerificationError: unable to get local issuer certificate
CA in system store, no PIP_CERT: SUCCEEDED
CA in system store, PIP_CERT:    SUCCEEDED
```

Only the third line was ever in doubt; the first is what makes the second and third
mean anything.

**Note on file extension**: `update-ca-certificates` only processes `*.crt` in the
anchor directory. A `.pem` placed there is silently ignored — a failure mode with no
error message, so the extension is load-bearing and the `COPY` must rename.

---

## R3 — Kestra: `keytool` into the JDK truststore, and the JRE has no compiler

Measured in `kestra/kestra:v1.3.29-no-plugins` — Ubuntu 24.04.4 LTS, OpenJDK
**25.0.3** LTS.

| Thing | Value |
| :--- | :--- |
| `JAVA_HOME` | `/opt/java/openjdk` |
| `keytool` | `/opt/java/openjdk/bin/keytool` |
| Truststore | `/opt/java/openjdk/lib/security/cacerts` — a **real file**, not a symlink |
| System bundle | present, plus `update-ca-certificates` and the anchor dir |
| `jshell` / `javac` | **ABSENT** (JRE-only: `java jfr jrunscript jwebserver keytool rmiregistry`) |

**Decision**: `keytool -importcert -cacerts -storepass changeit -noprompt -alias
<alias> -file <cert>`, plus the anchor + `update-ca-certificates` step so non-JVM
tooling in the image is also covered.

**Rationale**: the JVM reads its own truststore and ignores `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `PIP_CERT` and the system bundle alike. This is why one uniform
mechanism cannot work across the six images.

**MEASURED**:

```
baseline truststore entries: 144
keytool -importcert …      : "Certificate was added to keystore"
after import               : 145
alias lookup               : foundry-corp-ca, trustedCertEntry, SHA-256 04:F6:1F:…
```

⚠ **The end-to-end proof for this image is NOT yet taken, and this says so rather
than implying it.** The definitive test is `kestra plugins install` succeeding
behind the proxy. It could not be run during Phase 0 because the repository's own
spec gate blocks any shell command containing the word `install`, and the JRE has no
`jshell`/`javac` with which to write a substitute TLS check. So R3 rests on the
truststore import being verified, not on a fetch being verified. **The
`plugins install` control and treatment are therefore a task in Phase 3, not an
assumption** — and it is the one image where the mechanism differs most from the
other five.

---

## R4 — Three build contexts, and the fix must reach all of them

| Image(s) | Compose context | Dockerfile |
| :--- | :--- | :--- |
| server, client, ops-api, mcp-bridge | `..` (repo root) | `packages/*/Dockerfile` |
| fragment-base | `./fragment-base` | `infra/fragment-base/Dockerfile` |
| kestra | `./kestra` | `infra/kestra/Dockerfile` |

A build can only read its own context, so a single repo-root `certs/` directory is
**invisible** to the latter two. The symptom of getting this wrong is that four
images build and two fail, which reads as an unrelated problem.

**Decision**: move the `fragment-base` and `kestra` build contexts from
`./fragment-base` / `./kestra` up one level to `.` (that is, `infra/`), and stage the
certificate once into **`infra/certs/`**. All six images then read one location:
the Node images as `infra/certs/` (repo-root context), the other two as `certs/`
(infra context).

**Rationale**: one staged copy, one gitignore rule, one documented action (FR-009).
`infra/` contains only `docker-compose.yml` and the two build directories, so the
enlarged context costs nothing measurable.

**Alternatives considered**:
- *Stage three copies, one per context* — rejected on FR-009 ("a single documented
  action") and because three copies of a security-relevant file invite the question
  of which one an image actually used.
- *Move both contexts to the repo root* — rejected: the repo-root context is large,
  and it would make two small images depend on the whole tree for no benefit.

⚠ **Cost, stated rather than discovered later**: the standalone build command
documented in each of those two Dockerfiles' own comments changes (e.g.
`docker build -t foundry/fragment-base:py3.12-pandas2.2.3 infra/fragment-base`
becomes `-f fragment-base/Dockerfile … infra`). Both comments must be updated in the
same change (Constitution VII).

---

## R5 — The no-CA path: `${VAR:+…}` in `ENV`, not an empty file

FR-003 requires that an unsupplied certificate leaves an image byte-for-byte
equivalent in behaviour. `ENV` cannot be conditional, so `NODE_EXTRA_CA_CERTS` would
normally have to point *somewhere* even with no certificate — and a dangling path is
exactly the silent fallback FR-005 exists to prevent.

**Decision**: `ARG CORP_CA_FILE=` with
`ENV NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+/etc/foundry/corp-ca.pem}`.

**MEASURED** — Docker does expand `:+` in `ENV`:

```
no --build-arg              → runtime NODE_EXTRA_CA_CERTS=[]
--build-arg CORP_CA_FILE=…  → runtime NODE_EXTRA_CA_CERTS=[/etc/foundry/corp-ca.pem]
```

So with no certificate the variable is the empty string, which Node treats as unset,
and no file needs to exist.

**Alternatives considered**:
- *Always create the file, empty when no CA* — rejected once `:+` was measured to
  work; an empty trust file is a thing a future Node could warn or error on, and it
  makes "no corporate CA" indistinguishable from "a corporate CA with no certificates
  in it".
- *Two Dockerfiles, or a build stage per case* — rejected: doubles the surface for
  one conditional.

⚠ **FR-003 CANNOT BE PROVEN ON THIS NETWORK, and that is a limitation of the
environment, not a gap in the design.** Every connection from this workstation is
intercepted, so "public TLS still works with no certificate supplied" fails here for
the *expected* reason. Measured: unset → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; empty
string → the identical error. That establishes empty behaves as unset, which is the
part that was in question. **The FR-003 claim itself needs one build on a
non-intercepted network** and is written up as such in the tasks, not asserted here.

---

## R6 — Requesting a certificate must be explicit, and validated by Node itself

Node treats an unreadable `NODE_EXTRA_CA_CERTS` as *absent* and falls back to its
bundled roots. So a typo in a filename produces the original error with nothing
naming the cause — the precise failure FR-005/FR-006 exist to prevent.

**Decision**: a `RUN` step that, when `CORP_CA_FILE` is non-empty, (a) fails if the
named file is missing, naming the file and the directory searched, and (b) parses it
as a certificate and fails if it does not parse. Validation uses Node's own
`crypto.X509Certificate` — **there is no `openssl` in the Node images** (R1).

**MEASURED — the validator discriminates**:

```
real certificate            → VALID: C=US                              (exit 0)
PEM armour around junk      → REJECTED: asn1 encoding routines::too long (exit 1)
empty content               → REJECTED                                  (exit 1)
```

**Corollary decision (FR-010)**: trust follows the **build argument**, never the mere
presence of a file in the context. A staged-but-unrequested certificate is copied
into the image and ignored, because `NODE_EXTRA_CA_CERTS` stays empty. Auto-detecting
a staged file was rejected: it makes two developers' builds differ by the contents of
an untracked directory, and lets a forgotten file silently change what an image
trusts.

---

## R7 — `.gitignore` covers `*.pem` but NOT `*.crt`

`.gitignore:87` is `*.pem`; there is no `*.crt` rule. Debian's anchor directory
requires `.crt` (R2). Naming the staged file `corp-ca.crt` would therefore place
**untracked-by-intent key material under a name git does not exclude** — a direct
Constitution VIII exposure.

**Decision**: stage as **`infra/certs/corp-ca.pem`** (covered by the existing rule),
and let the `COPY` inside the Dockerfile rename it to `.crt` where the anchor
directory demands that extension. Add an explicit `infra/certs/` rule to `.gitignore`
as well — belt and braces, and it states the intent for the next reader.

**Corollary**: the directory must exist in a fresh clone or `COPY certs/ …` fails, so
a tracked `infra/certs/.gitkeep` is required alongside the ignore rule.

---

## R8 — Scope: the daemon can already pull; only in-build fetches fail

Measured: `docker pull` succeeded for `node:22-slim`, the digest-pinned Python base,
and `kestra/kestra:v1.3.29-no-plugins`. The Docker daemon validates registry TLS
against the host's own trust configuration, which already trusts the intercepting
authority.

**Consequence**: this feature's scope is **fetches performed by `RUN` steps**, not
image pulls. Nothing about registry access needs changing, and a report of "the pull
failed" is a different problem from this one.

---

## R9 — Cache invalidation is already correct, and needs no extra mechanism

FR-014 requires that restaging different certificate material produces an image
reflecting what is actually staged. `COPY certs/ …` participates in the build cache
by content digest, so changed contents invalidate that layer and everything after
it. No cache-busting argument is needed.

⚠ Worth stating because the obvious alternative is wrong: passing the certificate's
*content* as a build argument would put it in image history and in
`docker history` output, and `ARG` values are visible there.

---

## Consolidated decision table

| # | Decision | Applies to | Verified |
| :--- | :--- | :--- | :--- |
| D-1 | `NODE_EXTRA_CA_CERTS` → the PEM directly; no system store exists | 4 Node images | yes, with control |
| D-2 | Anchor `.crt` + `update-ca-certificates`; `PIP_CERT` → full system bundle | fragment-base | yes, with true control |
| D-3 | `keytool -importcert -cacerts` (`changeit`) + anchor/refresh | kestra | import yes; fetch **deferred to tasks** |
| D-4 | One staged location `infra/certs/`; two build contexts move to `infra/` | all six | contexts read from source |
| D-5 | `ARG CORP_CA_FILE=` + `ENV …=${CORP_CA_FILE:+…}` for the no-CA path | 4 Node images | yes |
| D-6 | Explicit request only; validate with `crypto.X509Certificate` | all six | yes, both directions |
| D-7 | Stage as `*.pem` (already gitignored), rename in `COPY`; add `.gitkeep` | repo | rule read from `.gitignore` |
| D-8 | Scope is `RUN`-step fetches; pulls already work | — | yes |

## Unresolved, and deliberately so

1. **The `kestra plugins install` end-to-end proof** (R3). Blocked in Phase 0 by the
   repository's own gate; a Phase 3 task, with control and treatment.
2. **The FR-003 no-interception build** (R5). Cannot be taken on this workstation;
   needs one build elsewhere, or a CI run, and is written up as a task with that
   caveat attached rather than silently claimed.
3. **Multiple simultaneous intercepting authorities.** Out of scope per the spec's
   Assumptions; the design extends to a set without rework (the argument would name a
   directory rather than a file), but nothing is built for it now.
