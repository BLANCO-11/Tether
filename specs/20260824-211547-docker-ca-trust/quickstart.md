# Quickstart & Validation: Corporate CA trust for Docker builds

**Feature**: `20260824-211547-docker-ca-trust`

How to use the feature, and how to prove it works. Every validation below is paired
with a **control** — a check that only ever passes tells you nothing.

---

## Prerequisites

- Docker running. Measured against Engine **29.7.2**.
- Behind an intercepting proxy: the corporate root certificate exported to a file on
  the host. On the reference workstation this is `$HOME/zscaler-ca.pem`.
- Not behind one: nothing. That is the point of the feature.

---

## Use — behind an intercepting proxy

```bash
# 1. Stage the certificate into the build context (one action, all six images)
CORP_CA_SOURCE="$HOME/zscaler-ca.pem" ./scripts/stage-corp-ca.sh

# 2. Tell the build to use it
echo 'CORP_CA_FILE=corp-ca.pem' >> .env

# 3. Build
docker compose --env-file .env -f infra/docker-compose.yml build
```

⚠ **`--env-file .env` (run from the repo root) is not optional.** Compose resolves `${VAR}` interpolation
from the directory holding the compose file (`infra/`), not the repo root. Without
it `CORP_CA_FILE` expands to empty and the build silently proceeds **without** trust
— which then fails at the first fetch, looking exactly like the original bug.

## Use — anywhere else

```bash
docker compose -f infra/docker-compose.yml build
```

Nothing staged, nothing set, no change from today.

---

## Validation

### V1 — the mechanism discriminates (the core claim)

Proves the certificate is what fixes the fetch, rather than something else having
changed. Run on the affected network.

```bash
# CONTROL: expect failure naming the original error
docker run --rm node:22-slim node -e '
fetch("https://registry.npmjs.org/pnpm").then(function(r){console.log("HTTP",r.status)}).catch(function(e){console.log("FAILED -",(e.cause&&e.cause.code)||e.message)})'

# TREATMENT: expect HTTP 200
docker run --rm -v "$HOME/zscaler-ca.pem:/tmp/ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/tmp/ca.pem node:22-slim node -e '
fetch("https://registry.npmjs.org/pnpm").then(function(r){console.log("HTTP",r.status)}).catch(function(e){console.log("FAILED -",(e.cause&&e.cause.code)||e.message)})'
```

**Expected**: `FAILED - UNABLE_TO_GET_ISSUER_CERT_LOCALLY` then `HTTP 200`.
**Measured 2026-08-24**: exactly that. The control reproduces the error from the
original build log verbatim.

### V2 — the real failing command

`fetch` is a stand-in; this is the command that actually broke.

```bash
# CONTROL
docker run --rm node:22-slim sh -c 'corepack enable && corepack prepare pnpm@10.29.2 --activate'
# TREATMENT
docker run --rm -v "$HOME/zscaler-ca.pem:/tmp/ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/tmp/ca.pem \
  node:22-slim sh -c 'corepack enable && corepack prepare pnpm@10.29.2 --activate && pnpm --version'
```

**Expected**: control fails; treatment prints `10.29.2`.
**Measured 2026-08-24**: as expected. `10.29.2` matches `packageManager` in the repo
root `package.json`, so the version fetched is the version real builds fetch.

### V3 — Python, with a TRUE control

⚠ **The obvious control here is worthless**, and this is recorded because the first
attempt made the mistake: running the "without `PIP_CERT`" arm *after* the
certificate is already in the system store succeeds, and proves nothing. The control
must have **no certificate anywhere**.

```bash
PY=python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

# TRUE CONTROL: no certificate at all — expect CERTIFICATE_VERIFY_FAILED
docker run --rm "$PY" sh -c 'pip download --no-deps --dest /tmp/d numpy==2.1.3 --quiet'

# TREATMENT: certificate in the anchor dir, refreshed — expect success
docker run --rm -v "$HOME/zscaler-ca.pem:/usr/local/share/ca-certificates/corp-ca.crt:ro" "$PY" sh -c '
update-ca-certificates && pip download --no-deps --dest /tmp/d numpy==2.1.3 --quiet && echo TREATMENT_OK'
```

**Expected**: control fails with `CERTIFICATE_VERIFY_FAILED`; treatment prints
`TREATMENT_OK`. **Measured 2026-08-25**: as expected, bundle **150 → 151** certificates.
(An earlier draft said 129 → 151; 129 was the host's combined bundle, a different
artifact. The image baseline is 150, recorded in `baseline-pre-change.txt`.)

⚠ Note the mount target ends in **`.crt`**. `update-ca-certificates` only processes
`*.crt` in the anchor directory; a `.pem` there is **silently ignored** — a failure
with no error message.

### V4 — the JVM truststore

```bash
docker run --rm --user root -v "$HOME/zscaler-ca.pem:/tmp/ca.pem:ro" \
  --entrypoint sh kestra/kestra:v1.3.29-no-plugins -c '
keytool -list -cacerts -storepass changeit | grep -c trustedCertEntry
keytool -importcert -cacerts -storepass changeit -noprompt -alias foundry-corp-ca -file /tmp/ca.pem
keytool -list -cacerts -storepass changeit | grep -c trustedCertEntry
keytool -list -cacerts -storepass changeit -alias foundry-corp-ca'
```

**Expected**: count increases by exactly one; the alias is listed as
`trustedCertEntry`. **Measured 2026-08-24**: 144 → 145.

⚠ **This is NOT the end-to-end proof.** It shows the certificate is in the truststore,
not that a plugin fetch succeeds.

**The end-to-end proof HAS now been taken (T020, 2026-08-25), both arms:**

```
TREATMENT  docker build --build-arg CORP_CA_FILE=corp-ca.pem -f infra/kestra/Dockerfile infra
           → all seven jars downloaded from Maven Central, all six RUN layers DONE
CONTROL    docker build --build-arg CORP_CA_FILE= -f infra/kestra/Dockerfile infra
           → FAILS at the FIRST plugin layer with the JVM's own error:
             PKIX path building failed: SunCertPathBuilderException:
             unable to find valid certification path to requested target
```

The control fires, so the `keytool` import is demonstrably what fixes it.

### V5 — the no-CA path leaves images unchanged

```bash
docker build --no-cache --build-arg CORP_CA_FILE= -f packages/server/Dockerfile -t t-noca .
docker run --rm t-noca sh -c 'echo "[${NODE_EXTRA_CA_CERTS}]"'
```

**Expected**: `[]` — empty, not a dangling path. Docker's `${VAR:+…}` expansion in
`ENV` yields the empty string, which Node treats as unset.
**Measured 2026-08-24**: `[]` with no argument, `[/etc/foundry/corp-ca.pem]` with one.

⚠ **FR-003 CANNOT BE FULLY PROVEN ON AN INTERCEPTED NETWORK.** "Public TLS still
works with no certificate" fails on the reference workstation for the *expected*
reason — everything is intercepted. What was measured is that empty and unset behave
**identically** (both give `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` there), which is the
part that was in doubt. The claim itself needs one build on a non-intercepted network
or a CI run. **Do not mark FR-003 verified from this workstation alone.**

### V6 — a requested-but-absent certificate fails loudly

```bash
docker build --no-cache --build-arg CORP_CA_FILE=does-not-exist.pem \
  -f packages/server/Dockerfile -t t-missing .
```

**Expected**: build **fails** at the trust step with a message naming
`does-not-exist.pem`, the directory searched, and the staging command. Not a warning,
and not a later failure at `pnpm install`.

**Why this check earns its place**: Node treats an unreadable `NODE_EXTRA_CA_CERTS`
as *absent* and falls back to bundled roots. Without an explicit refusal, a typo
reproduces the original error several steps later with nothing naming the cause.

### V7 — a staged-but-unrequested certificate is ignored

```bash
# certificate staged, argument empty
docker build --no-cache --build-arg CORP_CA_FILE= -f packages/server/Dockerfile -t t-ignored .
docker run --rm t-ignored sh -c 'echo "[${NODE_EXTRA_CA_CERTS}]"'
```

**Expected**: `[]`. Trust follows the explicit request, never the presence of a file
(FR-010).

### V8 — the certificate is not committable

```bash
git status --porcelain infra/certs/          # expect: no .pem listed
git check-ignore -v infra/certs/corp-ca.pem  # expect: a matching ignore rule
git add -f infra/certs/corp-ca.pem           # expect: refused by the repo's guards
```

⚠ `.gitignore` covers `*.pem` and **not** `*.crt`. The staged file must be `.pem`;
the rename to `.crt` happens inside the image where the anchor directory needs it.

### V9 — the validator rejects non-certificates

```bash
docker run --rm node:22-slim node -e '
const {X509Certificate}=require("crypto");
const junk=Buffer.from("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n");
try{new X509Certificate(junk);console.log("VALID (unexpected)")}catch(e){console.log("REJECTED");process.exit(1)}'
```

**Expected**: `REJECTED`, exit 1. **Measured 2026-08-24**: rejected
(`asn1 encoding routines::too long`); empty content also rejected; the real
certificate accepted. Discriminates in both directions.

---

## Full-stack acceptance

```bash
./scripts/stage-corp-ca.sh
echo 'CORP_CA_FILE=corp-ca.pem' >> .env
docker compose --env-file .env -f infra/docker-compose.yml build --no-cache
pnpm ca:check
```

**Expected**: all six images build; `ca:check` reports **15 passed, 0 failed**.
**Measured 2026-08-25**: exactly that, on the affected workstation.

⚠ **`pnpm ca:check --control` does NOT cover every assertion in one run**, and
assuming it does is the mistake the mode exists to catch. `check_node_image` returns
early on its first failure, so a control against a bare base image exercises "the
variable is set" and never reaches "the file exists" or "it parses". Full coverage
needs three runs against three images — no CA, a dangling path, and a junk file —
using the `NODE_IMAGES` / `FRAGMENT_IMAGE` / `KESTRA_IMAGE` overrides. All three were
observed failing on 2026-08-25. In runs 2 and 3 the earlier assertions correctly
pass, so the script reports "CONTROL DID NOT FIRE" and exits 2; that is expected for
a targeted probe.

---

## Troubleshooting

| Symptom | Cause |
| :--- | :--- |
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` with a certificate staged | `CORP_CA_FILE` not reaching the build. Almost always the missing `--env-file .env` (run from the repo root) (Compose interpolates from `infra/`). |
| Build fails naming a file you did stage | Filename mismatch, or a path separator in `CORP_CA_FILE` — a bare filename is required. |
| Python image builds, `pip` still fails | Anchor file not named `*.crt`, so `update-ca-certificates` ignored it silently. |
| Kestra builds but plugin fetch fails | `keytool` import ran against a different `JAVA_HOME`, or the alias already existed. |
| `COPY certs/ …` fails on a fresh clone | `infra/certs/.gitkeep` missing. The ignore rule and the tracked placeholder are a pair. |

---

## Measurement provenance

Every "Measured 2026-08-24" above was taken on the affected workstation (macOS,
Docker Engine 29.7.2, behind the intercepting proxy) against
`node:22-slim` (Node 22.23.2), `python@sha256:57cd7c…` (Python 3.12.13, pip 25.0.1)
and `kestra/kestra:v1.3.29-no-plugins` (Ubuntu 24.04.4, OpenJDK 25.0.3).

⚠ **Two claims rest on a single environment and are flagged rather than assumed**:
FR-003 (no-interception builds unchanged) needs a build elsewhere, and the Kestra
plugin fetch needs the end-to-end run deferred out of Phase 0.
