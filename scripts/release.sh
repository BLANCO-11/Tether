#!/usr/bin/env bash
# Cut a release: set the version, commit what is staged with it, and tag it — one step, so the version the app shows (the root
# package.json's, beside "Beta"), the commit and the tag never disagree.
#
#   scripts/release.sh 2.6.10 "what changed, one line"  [message-file]
#
# Version scheme: beta-2.x.y — the last digit for a fix or small feature, the middle for a substantial one, never the 2.
# Commits what is STAGED plus package.json; pushing stays yours: git push origin <branch> beta-<version>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
v="${1:?usage: scripts/release.sh <2.x.y> \"title\" [message-file]}"
title="${2:?usage: scripts/release.sh <2.x.y> \"title\" [message-file]}"
[[ "$v" =~ ^2\.[0-9]+\.[0-9]+$ ]] || { echo "version must be 2.x.y (got $v)" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/beta-$v" >/dev/null && { echo "tag beta-$v already exists" >&2; exit 1; }
node -e 'const f="package.json",p=require("./"+f);p.version=process.argv[1];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$v"
git add package.json
if [[ -n "${3:-}" ]]; then { echo "beta-$v: $title"; echo; cat "$3"; } | git commit -q -F -; else git commit -q -m "beta-$v: $title"; fi
git tag "beta-$v"
echo "released beta-$v at $(git rev-parse --short HEAD) — push with: git push origin $(git branch --show-current) beta-$v"
