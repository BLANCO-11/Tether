# Local run (Mac / Linux) — Docker

Runs the whole stack locally: Postgres, server, client, ops, Kestra.

## Prereqs

- Docker Desktop (Mac) or Docker Engine (Linux), `node 22`, `pnpm 9`.
- A repo-root `.env` — copy the template and fill the required values:
  `cp .env.example .env`

## Corporate proxy CA (only behind a TLS-intercepting proxy)

If your network intercepts TLS (fetch failures inside builds that work on the
host), stage your corporate root CA into the build context and point at it:

```sh
./scripts/stage-corp-ca.sh        # copies your CA to infra/certs/ as .pem (gitignored, never committed)
# then set CORP_CA_FILE=corp-ca.pem in .env
./scripts/check-corp-ca-trust.sh  # verifies the trust inside a build
```

No intercepting proxy → skip this entirely; the build is identical without it.

## Run

From the **repo root** (compose interpolates `${VAR}` from the project
directory, so the `--env-file` flag is load-bearing):

```sh
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

| Surface | URL |
|---|---|
| App (client) | http://localhost:4002 |
| Server API | http://localhost:4000 |
| Ops | http://localhost:4004 |
| Postgres | localhost:5433 (`foundry`/`foundry`) |

First boot runs DB migrations, then seeds. Stop with `Ctrl-C`;
`docker compose -f infra/docker-compose.yml down` removes containers
(volumes persist data; add `-v` to reset).

## Troubleshooting

- `CORP_CA_FILE silently empty` → you ran without `--env-file .env` from the
  repo root; the build proceeds with no trust and fails at the first fetch.
- Port clash on 4000–4002/5433 → an older local stack is still up; stop it first.
- Fresh DB weirdness → `down -v` and re-`up` (re-seeds from scratch).
