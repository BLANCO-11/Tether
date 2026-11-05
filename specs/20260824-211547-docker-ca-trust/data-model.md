# Phase 1 Data Model: Corporate CA trust for Docker builds

**Feature**: `20260824-211547-docker-ca-trust`

⚠ **This feature has no persisted data, no database table, no migration and no
schema.** This document exists because the spec named four entities and they have
real attributes, states and validation rules that the implementation must honour.
It is a model of build-time artifacts, not of stored records. There is nothing here
to back up, retain, or restore.

---

## Entity: Corporate CA certificate

The public certificate of the authority that re-signs intercepted TLS connections.

| Attribute | Value / rule |
| :--- | :--- |
| Form | X.509 certificate, PEM-encoded |
| Sensitivity | **Public material.** A CA's public certificate is not a secret. |
| Tracked in git | **No** — organisation-specific, and Constitution VIII prohibits committing key material regardless of sensitivity |
| Canonical staged name | `corp-ca.pem` |
| Staged location | `infra/certs/` |
| Source of truth | The developer's own workstation, where it is already trusted |
| Cardinality | Exactly one, or none |

**Validation rules**:

1. MUST parse as an X.509 certificate. Verified by the runtime already present in
   the image — Node's `crypto.X509Certificate` in the Node images, which have no
   openssl (research R1, R6).
2. MUST carry a `.pem` extension when staged, because `.gitignore` covers `*.pem`
   and not `*.crt` (research R7).
3. MUST NOT be validated by extension, filename or size alone — a file named
   `corp-ca.pem` containing anything else is refused with a message saying so.

**Measured**: real certificate accepted (`C=US`); PEM armour around junk rejected
(`asn1 encoding routines::too long`); empty content rejected. The validator
discriminates in both directions.

**Why one and not a set**: a single intercepting authority is the assumption in the
spec. The model extends to a set by naming a directory rather than a file; nothing
is built for it now.

---

## Entity: Build context

The set of files a single image build can read.

| Instance | Path | Serves | Certificate visible as |
| :--- | :--- | :--- | :--- |
| Repo root | `..` from `infra/` | server, client, ops-api, mcp-bridge | `infra/certs/` |
| Infra | `.` (i.e. `infra/`) | fragment-base, kestra | `certs/` |

**Relationship to the certificate**: a build reads **only** its own context. The
certificate must be inside every context that needs it — this is the constraint that
drives the whole structure of the change.

**State change introduced by this feature**: `fragment-base` and `kestra` move from
their own directories up to `infra/`, reducing three contexts to two so that one
staged certificate serves all six images (research R4).

⚠ **Invariant**: `infra/certs/` must **exist** in a fresh clone or `COPY certs/ …`
fails the build. The contents are ignored; the directory is tracked via
`infra/certs/.gitkeep`. Ignoring the directory outright would make a fresh clone
unbuildable — the ignore rule and the tracked placeholder are a pair, and removing
either breaks it.

---

## Entity: Trust store

The collection of authorities a runtime consults when validating a certificate chain.
**Three instances, and they are not interchangeable** — this is the finding that
shaped the design.

| Instance | Runtime | Location | Semantics | Present in image? |
| :--- | :--- | :--- | :--- | :--- |
| Node built-in roots | Node 22.23.2 | compiled in | `NODE_EXTRA_CA_CERTS` **appends** | n/a (no files) |
| Debian system bundle | pip / OpenSSL | `/etc/ssl/certs/ca-certificates.crt` | anchor dir + `update-ca-certificates`; `PIP_CERT` **replaces** | Python: **yes**; Node: **NO** |
| JDK truststore | OpenJDK 25.0.3 | `/opt/java/openjdk/lib/security/cacerts` | `keytool -importcert`, password `changeit` | Kestra: yes |

**Measured absences in `node:22-slim`** — no `ca-certificates` package, no system
bundle, no `update-ca-certificates`, no anchor directory, no openssl. Node needs
none of them.

**Measured counts**: Debian bundle **150 → 151** certificates after the refresh; JDK
truststore **144 → 145** entries after import.

⚠ **This line read "129 → 151" until 2026-08-25 and 129 was the wrong number** — it
was the certificate count of the *host's* combined bundle, not the image's. The image
baseline is 150, recorded in `baseline-pre-change.txt` as `fragment-base.bundle_certs`
and read from there by the verification helper rather than hardcoded, so a base-image
refresh cannot turn a correct build into a false failure.

**Validation rule — append versus replace is load-bearing**: `PIP_CERT` replaces the
bundle, so it MUST name the full system bundle and never the lone corporate root.
Naming the root alone would remove trust in every public authority (FR-004).

---

## Entity: Build input

The declared value by which a certificate is requested.

| Attribute | Value |
| :--- | :--- |
| Name | `CORP_CA_FILE` |
| Type | Bare filename — no path separators |
| Default | `` (empty) |
| Meaning of default | No corporate CA. Not "look and see". |
| Declared in | Every stage of all six images that performs a network fetch |

**State transitions** — the whole behaviour of the feature, in four rows:

| `CORP_CA_FILE` | File staged? | Outcome |
| :--- | :--- | :--- |
| empty | no | No trust added. Build proceeds. Image unchanged. |
| empty | **yes** | **No trust added** (FR-010). File copied, ignored. |
| set | yes, parses | Trust added by the image's own mechanism. |
| set | absent, or does not parse | **Build fails** at the trust step, before any dependent fetch. |

⚠ **Row 2 is a decision, not an oversight.** Trust follows the explicit request, never
the presence of a file. Auto-detection would let two developers' builds differ by the
contents of an untracked directory, and let a forgotten file silently change what an
image trusts.

⚠ **Row 4's failure must be constructed deliberately.** The default behaviour of an
unreadable `NODE_EXTRA_CA_CERTS` is for Node to *ignore it* and fall back to bundled
roots — reproducing the original error later with nothing naming the cause.

**Why the value is a filename and not the certificate content**: `ARG` values appear
in image history and `docker history` output. A filename references material already
in the context; content would copy it into metadata for no benefit.

---

## Relationships

```
Corporate CA certificate ──staged into──> Build context (2 instances)
         │                                        │
         │                                   read by
         │                                        ▼
         └──requested by──> Build input ──selects──> Trust store (3 instances)
                                 │
                            absent (default)
                                 │
                                 ▼
                        no trust added, image unchanged
```

**The cardinality that matters**: one certificate, two contexts, three trust-store
mechanisms, six images. The mismatch between two and three and six is why this is a
model rather than a single `COPY` line.

---

## Non-entities, recorded to prevent invention

- **No certificate registry, inventory or rotation record.** The material is one
  file replaced by re-running the staging step. Version history is the host's, not
  this repository's.
- **No expiry tracking.** A CA certificate expires, and nothing here watches for it;
  the symptom would be the original build failure returning. Out of scope, and named
  so its absence is a known bound rather than an assumed capability.
- **No per-workspace or per-tenant scoping.** This is build infrastructure. It has no
  relationship to the product's workspace model, and nothing here reads or writes
  tenant data.
