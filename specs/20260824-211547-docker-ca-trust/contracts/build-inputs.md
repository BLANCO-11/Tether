# Contract: build inputs for corporate CA trust

**Feature**: `20260824-211547-docker-ca-trust`

This is the interface this feature exposes. It is consumed by three callers — a
person running `docker compose`, a person running `docker build` directly, and CI —
so it is written down rather than left implicit in six Dockerfiles.

## 1. The build argument

| Name | Type | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `CORP_CA_FILE` | filename, no path separators | `` (empty) | Name of a certificate file inside the staged certificate directory. Empty means **no corporate CA**. |

**Declared by**: all six Dockerfiles, in every stage that performs a network fetch.

### Why a filename and not a path

A path lets a caller point outside the build context, which fails with a `COPY`
error naming a path the image cannot see — a confusing failure for a
misconfiguration. A bare filename keeps the Dockerfile in control of *where* it
looks, so the refusal can name both the file and the directory searched (FR-006).

**Contract**: a value containing `/` MUST be refused with a message saying a bare
filename is expected.

### Why empty rather than absent

`ARG CORP_CA_FILE=` gives the argument an empty default so that
`ENV NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+…}` expands to the empty string when no
certificate is requested. Measured: Docker expands `:+` in `ENV`, and an empty
`NODE_EXTRA_CA_CERTS` is treated by Node as unset (research R5).

## 2. The staged certificate directory

| Path | Tracked? | Contents |
| :--- | :--- | :--- |
| `infra/certs/` | directory yes, contents no | Certificate files, conventionally `corp-ca.pem` |
| `infra/certs/.gitkeep` | **yes** | Empty. Exists so `COPY certs/ …` resolves in a fresh clone. |
| `infra/certs/*.pem` | **no** | Excluded by `.gitignore`'s existing `*.pem` rule plus an explicit `infra/certs/` rule. |

**Read as** `infra/certs/` from the repo-root build context (the four Node images),
and as `certs/` from the `infra/` build context (fragment-base, kestra).

⚠ **The staged file MUST carry a `.pem` extension.** `.gitignore` covers `*.pem` and
does **not** cover `*.crt` (research R7), so a `.crt` here would be untracked by
intent but not by rule — a Constitution VIII exposure. Where a `.crt` extension is
required inside an image (Debian's anchor directory only processes `*.crt`), the
rename happens in the `COPY`, not in the staging.

## 3. In-image paths and per-runtime mechanism

The three mechanisms are not interchangeable; each image uses the one its own
runtime honours (research R1–R3).

| Image(s) | Mechanism | In-image path |
| :--- | :--- | :--- |
| server, client, ops-api, mcp-bridge | `NODE_EXTRA_CA_CERTS` (appends to Node's built-in roots) | `/etc/foundry/corp-ca.pem` |
| fragment-base | anchor dir + `update-ca-certificates`; `PIP_CERT` → full system bundle | `/usr/local/share/ca-certificates/corp-ca.crt` |
| kestra | `keytool -importcert -cacerts` + anchor dir + refresh | truststore `/opt/java/openjdk/lib/security/cacerts`, alias `foundry-corp-ca` |

⚠ `PIP_CERT` and `NODE_EXTRA_CA_CERTS` differ in kind: Node **appends**, pip
**replaces**. `PIP_CERT` therefore names the full system bundle after the refresh,
never the lone corporate root — naming the root alone would break public TLS
(FR-004).

## 4. The compose surface

Each of the six services gains:

```yaml
build:
  args:
    CORP_CA_FILE: ${CORP_CA_FILE:-}
```

**Contract**: the value comes from `.env` and defaults to absent, so a deployment
that has never heard of this feature builds exactly as before (FR-003).

⚠ Compose resolves `${VAR}` interpolation from the **project directory** (the
directory holding the compose file, i.e. `infra/`), not the repo root. The repo-root
`.env` therefore reaches it only via `--env-file .env` (run from the repo root) or an equivalent. This is
the same trap the compose file already documents for `env_file` versus
`environment:`; `.env.example` records it.

### Build-context change

| Service | Before | After |
| :--- | :--- | :--- |
| fragment-base | `context: ./fragment-base` | `context: .`, `dockerfile: fragment-base/Dockerfile` |
| kestra | `context: ./kestra` | `context: .`, `dockerfile: kestra/Dockerfile` |

Consequence for direct builds, documented in each Dockerfile's own header comment:

```
# before: docker build -t foundry/fragment-base:py3.12-pandas2.2.3 infra/fragment-base
# after:  docker build -f infra/fragment-base/Dockerfile -t foundry/fragment-base:py3.12-pandas2.2.3 infra
```

## 5. Failure contract

| Condition | Behaviour |
| :--- | :--- |
| `CORP_CA_FILE` empty | No trust added. Build proceeds. Image behaviour unchanged. |
| `CORP_CA_FILE` set, file present and parses | Trust added by the per-image mechanism. Build proceeds. |
| `CORP_CA_FILE` set, file **absent** | **Build FAILS** at the trust step, before any dependent fetch. Message names the filename, the directory searched, and the staging command. |
| `CORP_CA_FILE` set, file present but **not a certificate** | **Build FAILS** at the trust step. Message identifies the file as unparseable. |
| `CORP_CA_FILE` contains a path separator | **Build FAILS** with a message stating a bare filename is expected. |
| Certificate staged but `CORP_CA_FILE` empty | **No trust added** (FR-010). The file is copied and ignored. |

⚠ **The failure cases are the point of the contract, not an afterthought.** Node
treats an unreadable `NODE_EXTRA_CA_CERTS` as *absent* and falls back to its bundled
roots — so without an explicit refusal a typo in a filename reproduces the original
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` at a later step, with nothing naming the cause.
That is the exact diagnosis this feature exists to prevent anyone having to repeat.

**Validation is performed by the runtime already in the image**: Node's
`crypto.X509Certificate` in the Node images (there is **no openssl** there — research
R1), `openssl` where it exists. Measured to reject PEM-armoured junk and empty
content, and to accept the real certificate (research R6).

## 6. What this contract does NOT cover

- **Image pulls.** The Docker daemon already validates registry TLS against the
  host's own trust configuration and pulls succeed (research R8). Only `RUN`-step
  fetches are in scope.
- **Multiple simultaneous intercepting authorities.** One authority is assumed. The
  contract extends to a set by naming a directory rather than a file, but nothing is
  built for it.
- **Runtime trust for `code`-step fragments.** They run with `networkMode: none` and
  make no outbound connection, so trust is irrelevant there. The fragment-base
  mechanism serves its **build** only.
