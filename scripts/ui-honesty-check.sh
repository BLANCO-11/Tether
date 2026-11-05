#!/usr/bin/env bash
# Asserts that the UI cannot show data no server produced.
#
# ── WHY THIS EXISTS AS A CHECK RATHER THAN A NOTE ───────────────────────────
#
# `packages/client` used to carry a second, invisible backend: `lib/mockdb.ts`, a
# localStorage database seeded from `src/mocks/data.ts` with fabricated apps, API
# keys, employees, runs, automations, organizations and members. 66 of the 71
# exported functions in `lib/api.ts` read or wrote it.
#
# The dangerous part was `faFallback(real, mock)`:
#
#     try { return await real() } catch { console.warn(…); return mock() }
#
# Ten call sites. Any server error — a 500, a 404 from a route deleted three
# phases earlier, an expired session, a stopped container — was answered with
# plausible fabricated rows and a `console.warn`. Two consequences, and the second
# is why a grep is not enough on its own:
#
#   1. In a demo, nobody reads the console. The product and a browser cache were
#      indistinguishable.
#   2. It hid its own cause. Deleting a server route did not break a page; it
#      silently re-pointed that page at localStorage, so the typecheck and the
#      click-through both stayed green.
#
# "Nobody will add a fallback back" is not a control. This is.
#
# Usage:  ./scripts/ui-honesty-check.sh
# Exit 0 iff every expectation holds.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/packages/client/src"
fails=0

pass() { printf '  \033[32mPASS\033[0m  %-34s %s\n' "$1" "${2:-}"; }
fail() { printf '  \033[31mFAIL\033[0m  %-34s %s\n' "$1" "$2"; fails=$((fails + 1)); }

# ── ⚠ EVERY absence check below is defeated by ONE NUL byte ─────────────────
#
# `absent_code`/`absent_code_in` decide "no references" from grep printing no
# LINE-NUMBERED hits. Given a file containing a NUL, grep declares it binary and
# prints `<path>: binary file matches` — no line number — which the comment
# filter (`^[^:]+:[0-9]+:`) then strips. So the hit vanishes and the assertion
# passes **vacuously**, for the whole file.
#
# This is not hypothetical. `app/(app)/tools/page.tsx` acquired
# `const NAME_A_NEW_SECRET = "\0new"` on 2026-08-10 — a deliberate sentinel, chosen
# as "a value no env-var name can collide with", which is true. One invisible byte
# turned 47 KB of page into a blind spot, and **nothing else could see it**: `tsc`
# and `vitest` do not care about NULs, so every other gate stayed green. It was
# found only because a `usedBy` assertion was being narrowed and the "clean" answer
# looked too clean. See onboarding issue I-136 (foundations programme, closed;
# record removed 2026-09-11 — the story above is the surviving record).
#
# So this runs FIRST and is a hard fail: a blind spot in a check is worse than a
# failing check, because a failing check is read (I-38's shape).
# ⚠ The test is `grep -qI . <file>`, NOT a search for `\x00`, and that is
# deliberate. `-I` is grep's own "skip binary" flag, so this asks grep the exact
# question that matters — *do YOU consider this file binary?* — rather than
# guessing which bytes make it so. A `\x00` pattern was tried first and **silently
# did not work**: `grep -lP '\x00'` exits 1 on a file that demonstrably contains a
# NUL, so the first version of this guard passed its own perturbation test. A guard
# that cannot fail is worse than none (I-38), and this one nearly shipped that way.
no_binary_sources() {
  local label="no source file is binary to grep" hits="" f
  while IFS= read -r f; do
    # An EMPTY file also fails `grep -q .` while being perfectly readable, so skip
    # zero-byte files rather than reporting them as blind spots.
    [ -s "$f" ] || continue
    grep -qI . "$f" 2>/dev/null || hits="$hits$f"$'\n'
  done < <(find "$SRC" -type f \( -name '*.ts' -o -name '*.tsx' \))
  if [ -n "$hits" ]; then
    fail "$label" "every absence assertion on these is VACUOUS:"
    printf '%s' "$hits" | head -5 | sed "s|^$SRC/|          |"
  else
    pass "$label" "all readable"
  fi
}

echo
echo "The absence checks below can actually see the files"
no_binary_sources

# A file must not exist.
absent_file() {
  local label="$1" path="$2"
  if [ -e "$SRC/$path" ]; then fail "$label" "$path exists again"; else pass "$label" "gone"; fi
}

# No source file may match a pattern. Comments are excluded, because every one of
# these names is deliberately DISCUSSED in the comments explaining its removal —
# a check that forbade mentioning them would force those explanations out.
absent_code() {
  local label="$1" pattern="$2"
  local hits
  hits=$(grep -rn --include=\*.ts --include=\*.tsx -E "$pattern" "$SRC" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
    | head -5)
  if [ -n "$hits" ]; then
    fail "$label" "still referenced:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "$label" "no references"
  fi
}

# Same as absent_code, but scoped to one path under $SRC rather than the whole
# tree — for checks that apply to one page, not the product.
#
# ⚠ `-H` is load-bearing. Given a SINGLE FILE rather than a directory, grep omits
# the filename prefix, so the `^[^:]+:[0-9]+:` comment-exclusion below matches
# nothing and every comment mentioning the pattern is reported as a hit. That is
# not a false alarm you can shrug at: these checks exist precisely because the
# code EXPLAINS what it removed, so a file-scoped assertion without `-H` can
# never pass on any file honest enough to say why. Found in Phase 9.
absent_code_in() {
  local label="$1" pattern="$2" path="$3"
  local hits
  hits=$(grep -rnH --include=\*.ts --include=\*.tsx -E "$pattern" "$SRC/$path" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
    | head -5)
  if [ -n "$hits" ]; then
    fail "$label" "still referenced:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "$label" "no references"
  fi
}

# The inverse of absent_code_in: a pattern that MUST appear (in real code, not
# just a comment) somewhere under one path. Used to pin a stated caveat so a
# future edit cannot quietly delete it and leave the surrounding claim intact.
present_code_in() {
  local label="$1" pattern="$2" path="$3"
  local hits
  hits=$(grep -rnH --include=\*.ts --include=\*.tsx -E "$pattern" "$SRC/$path" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)')
  if [ -n "$hits" ]; then
    pass "$label" "present"
  else
    fail "$label" "missing — $path no longer states this on screen"
  fi
}

# ── ⚠ $ROOT-relative twins of the two above, for code the client SHARES ──────
#
# `absent_code_in`/`present_code_in` resolve their path under `$SRC`, which is
# `packages/client/src`. That was every subject this script had until foundations
# Phase 2.1 moved `lib/flow-authoring.ts` into `@foundry/flow-edit` (D-121) and
# left a re-export shim behind.
#
# The move is exactly the case where a $SRC-only helper becomes dangerous. The
# "no `code:` field on a canvas step" assertion still ran, still named a real
# file, and still printed PASS — over a shim that contains no fields at all. A
# check that cannot fail is worse than no check, because a failing check gets
# read (I-38). Its twin, `present_code_in … 'blocking: false'`, would at least
# have failed loudly; the absence one would not.
#
# So these take a path relative to the REPO ROOT and are otherwise identical —
# same `-H`, same line-numbered-hit filter (`^[^:]+:[0-9]+:`), same
# comment-exclusion. ⚠ Read the NUL-byte warning at the top of this file before
# using `absent_code_at` on anything: it decides "no references" the same way,
# so one NUL in the target makes it pass vacuously too. `no_binary_sources`
# walks `$SRC` only, so a shared package is NOT covered by it — hence
# `no_binary_shared_sources` below.
absent_code_at() {
  local label="$1" pattern="$2" path="$3"
  local hits
  hits=$(grep -rnH --include=\*.ts --include=\*.tsx -E "$pattern" "$ROOT/$path" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
    | head -5)
  if [ -n "$hits" ]; then
    fail "$label" "still referenced:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "$label" "no references"
  fi
}

present_code_at() {
  local label="$1" pattern="$2" path="$3"
  local hits
  hits=$(grep -rnH --include=\*.ts --include=\*.tsx -E "$pattern" "$ROOT/$path" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)')
  if [ -n "$hits" ]; then
    pass "$label" "present"
  else
    fail "$label" "missing — $path no longer states this on screen"
  fi
}

# The `no_binary_sources` guard above walks `$SRC`. Every subject of
# `absent_code_at` is outside it, so it needs the same guard or the blind spot
# simply moves to the shared package — which is the file the canvas's own rules
# now live in.
SHARED_SRC="$ROOT/packages/flow-edit/src"
no_binary_shared_sources() {
  local label="no shared source is binary to grep" hits="" f
  while IFS= read -r f; do
    [ -s "$f" ] || continue
    grep -qI . "$f" 2>/dev/null || hits="$hits$f"$'\n'
  done < <(find "$SHARED_SRC" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)
  if [ -n "$hits" ]; then
    fail "$label" "every absence assertion on these is VACUOUS:"
    printf '%s' "$hits" | head -5 | sed "s|^$ROOT/|          |"
  else
    pass "$label" "all readable"
  fi
}
no_binary_shared_sources

echo "The mock backend is gone"
absent_file "no mockdb"                 "lib/mockdb.ts"
absent_file "no mock-rows"              "lib/mock-rows.ts"
absent_file "no mocks/ directory"       "mocks"
absent_file "no runstream (fake live)"  "lib/runstream.ts"
absent_file "no virtual-tables page"    "app/(app)/virtual-tables"

echo
echo "/apps lists what the ENGINE reports, and says what it cannot do"
# ── ⚠ THESE FOUR REPLACE FOUR OTHERS, AND THAT IS THE POINT ─────────────────
#
# `/apps` was deleted in away-from-demo-mode Stage 1 for being entirely
# mock-backed — `listApps` was `faFallback` over `lib/mockdb.ts`. It returned on
# 2026-08-05 as a DECLARED PLACEHOLDER, held to that shape by four assertions:
#
#   apps page has no data-fetching hook        absent  useAsync(
#   apps page calls no server                  absent  foundryApi|fetch(
#   apps page uses no browser storage          absent  localStorage|sessionStorage
#   apps page still declares itself a placeholder  present  "placeholder rows"
#
# ui-upgrade Phase 9 gives the page a real server read, so the first two now
# describe the OPPOSITE of what should be true and the fourth describes a banner
# that has correctly gone. They are **replaced, not deleted** (`plan.md` 9.4):
# the property each protected — *this page shows no data a server did not
# produce* — has not stopped applying, it has changed form. Removing them and
# leaving nothing is how `/apps` becomes mock-backed a third time. D-111.
#
# The browser-storage one is the exception: it is kept verbatim below, because
# that property did not change at all.
# ⚠ **A CLAIM ABOUT A CONTROL THAT DID NOT EXIST — corrected 2026-09-06.**
# The triggers page told a reader a webhook was "signed by the webhook secret".
# `routes/triggers.ts`'s receiver resolves the token out of the PATH and fires:
# no signature, no secret, no header. Measured at the wire — a bare POST to the
# URL, no headers at all, started a run. So the screen described a second factor
# on the one endpoint in the product that answers an anonymous caller and then
# does work, which is the most expensive place in the UI to be wrong.
#
# Both halves are asserted: the false claim must not come back, and the true one
# must be present. An absence check alone would pass against a page that said
# nothing at all (I-38).
absent_code_in  "no claim that a webhook is signed"      'signed by the webhook' "app/(app)/triggers"
present_code_in "the webhook URL is named as the credential" 'token in the path is the credential' "app/(app)/triggers"
# ⚠ REPLACED 2026-10-27, not removed (plugins, plans/plugins-2026-10-27): `/apps` read Kestra's registry and Kestra
# left the stack on 2026-10-21. It is the Connectors page now. The property is unchanged — this page shows no row a
# server did not produce, and a failed read renders as a failure — so the two checks name the new reads.
present_code_in "apps rows come from the server"  'useAsync\((listWorkspaceConnectors|connectorMarketplace)' "app/(app)/apps"
present_code_in "apps reports its own failure"    'res\.error' "app/(app)/apps"
absent_code_in  "apps page uses no browser storage" '(localStorage|sessionStorage)\.' "app/(app)/apps"
# ⚠ The old placeholder rows, by their own names. A grep for `SEED_APPS` alone
# would pass the moment somebody renamed the constant.
#
# ⚠ Scoped to the registry page, NOT to `app/(app)/apps`. The first version was
# directory-wide and went red on `apps/connect/page.tsx`, which holds its own
# hardcoded list — and that is a DIFFERENT page with a different claim: a wizard
# that has always said, on its last step, that it connected nothing. It is a
# declared placeholder, which is not the defect this check is for, and widening
# this assertion to cover it would be asserting the wrong property in the wrong
# place. See I-98 for the tension it leaves on screen.
absent_code_in  "no hardcoded rows on the registry" '(SEED_APPS|ServiceNow|Microsoft 365)' "app/(app)/apps/page.tsx"
# ⚠ `apps/connect` had an assertion here — *it must keep saying it creates
# nothing* — and the page is now DELETED (platform-coherence Phase 7.3, I-98).
# Replaced rather than removed, per the rule the four assertions above already
# follow: the property did not stop applying, it took its strongest possible
# form. A five-step wizard that connects nothing, sitting under a page that says
# installing a plugin is a deployment change, was a promise the product cannot
# keep — and an absent file cannot make it.
absent_file "no connect wizard"          "app/(app)/apps/connect"
# ⚠ **A registered plugin is not a capability an automation has.** Kestra
# registers 60-odd task types; the compiler emits seven. A page listing all of
# them as capabilities is a catalogue of things nobody can ask for — the
# placeholder defect again, with real data instead of literals. The page must
# distinguish the two, and the number must come from the server.
# ⚠ REPLACED 2026-10-27: the Kestra form of this was "a registered plugin is not a capability". The connector form is
# the same claim one layer down — LISTED in the marketplace is not INSTALLED, and installed is not CONNECTED here —
# so every marketplace card states its install, and every installed card its state in this workspace.
present_code_in "apps says what automations can actually use" 'installedVersion' "app/(app)/apps/page.tsx"
present_code_in "  and what is connected here"   'workspaceState\(' "app/(app)/apps/page.tsx"
# ⚠ A connection's value is never put on screen: the change form starts EMPTY and says why. A form seeded from the
# connection would be the first place in the product to display a stored credential.
present_code_in "a stored credential is never shown" 'Stored values are never shown' "components/connectors/ConnectionForm.tsx"
absent_code_in  "  and the form is never seeded from it" 'existing\??\.(fields|values)' "components/connectors"
# ⚠ Untested is not connected: the state comes from one pure function whose test pins it.
present_code_in "a connection's state is one rule"  'connectionState\(' "app/(app)/apps/[piece]/page.tsx"
absent_code_in  "the seven are not hardcoded in the client"  'io\.kestra\.plugin\.' "app/(app)/apps"
# ⚠ The browser does not reach Kestra and must not learn how: it publishes no
# port, and `kestra-ui` has no tenant isolation — never proxy it, never iframe
# it, never give a client the URL.
absent_code "no client-side Kestra address" '(kestra-ui|KESTRA_BASE_URL|:8080)'

echo
echo "Nothing imports it"
absent_code "no mockdb import"           '@/lib/mockdb'
absent_code "no mocks/ import"           '@/mocks/'
absent_code "no mock-rows import"        '@/lib/mock-rows'
absent_code "no runstream import"        '@/lib/runstream'

echo
echo "No silent fallback to fabricated data"
# The one that matters most. `faFallback` is named in comments explaining why it
# was removed; only real code counts.
absent_code "faFallback is not defined"  '(export )?(async )?function faFallback'
absent_code "faFallback is not called"   'faFallback[[:space:]]*(<|\()'
# The mock paths all slept to fake latency. A `wait(` helper in the data seam is
# the fingerprint of a simulated call.
absent_code "no simulated latency"       'const wait = \(ms'

echo
echo "The browser holds no shadow database"
#
# Browser storage is not banned outright — it is banned for DOMAIN STATE.
#
# Legitimate: which workspace I am looking at (`lib/workspace.tsx`). That is a UI
# preference; losing it costs a dropdown selection.
#
# Illegitimate: anything answering "what exists in this tenant?". `lib/mockdb.ts`
# persisted whole tables that way, and `lib/validation.ts` kept the go-live gate's
# verdicts per browser — a gate that had already moved server-side to
# `triggerService.enableReadiness()`, leaving a store nothing wrote and nothing read.
#
# So: an ALLOWLIST with a named reason, not a blanket rule. A new file appearing
# here is the thing to look at.
#
# Each entry carries its reason, and the reason is the same test in both cases:
# losing this value costs a preference, never a fact about the tenant.
#   lib/workspace-choice.ts — which workspace I am looking at.
#                       ⚠ This entry MOVED in platform-coherence Phase 1 and the
#                       list is narrower for it: it used to read `lib/workspace
#                       .tsx`, which resolved identity AND stored it. Splitting
#                       storage into a leaf module let `resolveWorkspaceId()`
#                       become the single resolver (I-103), and this check
#                       noticed the move on the first run — which is the whole
#                       point of an allowlist over a blanket rule.
#   lib/theme.ts      — dark or earth. Added with the light theme; the value is
#                       one of two literal strings, is read by the pre-paint
#                       script in `app/layout.tsx`, and its absence falls back to
#                       the OS preference rather than to anything remembered.
# ⚠ A NAMED SET, and adding to it is a deliberately visible edit. Every entry is
# a UI PREFERENCE — a theme, a menu width, which workspace you last picked. The
# defect this guards is the deleted `lib/mockdb.ts`, which answered from
# localStorage whenever the server errored; nothing here may hold anything the
# server also knows.
# ⚠ A NAMED SET, and every entry carries the same test as the first three:
# losing the value costs a preference or an unsubmitted draft, never a fact
# about the tenant. A new file appearing here is the thing to look at.
#   app/(app)/flows/[id]/builder/page.tsx — builder mode + chat-collapsed
#     overlay toggle, per flow. Which panel layout I left this flow in.
#   components/flow/FlowCanvas.tsx — overlay toggle for data-ref display.
#   components/flow/builder/StepPanel.tsx — inspector pane width.
#   components/flow/ChatWorkbench.tsx — chat-collapsed overlay toggle, per
#     flow (or per thread before a flow exists).
#   app/(app)/resources/new/page.tsx — unsubmitted onboarding wizard draft
#     (type + field mapping). Nothing the server knows yet.
#   components/onboarding/SafeDataStudio.tsx — the same draft's safe-data
#     rows, mid-wizard.
#   lib/search.ts — recent searches per browser, keyed by subject. A
#     convenience list, never an answer about what exists.
#   components/pi-builder/ChatResizer.tsx — the chat column's dragged width.
STORAGE_ALLOWED="lib/workspace-choice.ts
lib/theme.ts
lib/rail-preference.ts
app/(app)/flows/[id]/builder/page.tsx
components/flow/FlowCanvas.tsx
components/flow/builder/StepPanel.tsx
components/flow/ChatWorkbench.tsx
components/flow/builder/BuilderComposer.tsx
app/(app)/resources/new/page.tsx
components/onboarding/SafeDataStudio.tsx
lib/search.ts
components/pi-builder/ChatResizer.tsx"
# ⚠ Test files are excluded, and narrowly: a suite proving that a missing stored
# preference falls back to the OS has to call `setItem` to set up the case it is
# testing. Excluding them does not weaken the rule — the defect this guards is a
# SHIPPED shadow database, and a `.test.ts` ships nowhere. Excluding anything
# else would.
storage_hits=$(grep -rln --include=\*.ts --include=\*.tsx \
  -E '(localStorage|sessionStorage)\.(get|set|remove)Item' "$SRC" 2>/dev/null \
  | grep -vE '\.test\.tsx?$' \
  | sed "s#^$SRC/##" | grep -vxF "$STORAGE_ALLOWED")
if [ -n "$storage_hits" ]; then
  fail "browser storage is allowlisted" "unexpected users:"
  echo "$storage_hits" | sed 's/^/          /'
  echo "          (allowed: $(echo "$STORAGE_ALLOWED" | tr '\n' ' ')— UI preferences, not tenant data)"
else
  pass "browser storage is allowlisted" "only $(echo "$STORAGE_ALLOWED" | tr '\n' ' ')"
fi
absent_file "no per-browser gate store" "lib/validation.ts"

echo
echo "Every fetched surface can report a failure"
# `useAsync` returns { data, loading, error, reload }. A component that destructures
# it but never reads `error` renders an empty list when the server is unreachable —
# which is the same lie as a mock, just quieter: "you have no flows" instead of
# "we could not ask".
missing=""
while IFS= read -r f; do
  # Only components that actually consume useAsync's result.
  grep -q 'useAsync(' "$f" || continue
  grep -qE '\berror\b' "$f" || missing="$missing $(realpath --relative-to="$SRC" "$f")"
done < <(grep -rl 'useAsync(' "$SRC/app" "$SRC/components" --include=\*.tsx 2>/dev/null)

if [ -n "$missing" ]; then
  fail "all useAsync callers read error" "these ignore it:"
  for m in $missing; do echo "          $m"; done
else
  pass "all useAsync callers read error" "$(grep -rl 'useAsync(' "$SRC/app" "$SRC/components" --include=\*.tsx | wc -l | tr -d ' ') components"
fi

echo
echo "The data seam only talks to the server"
# Every exported async function in lib/api.ts must reach `foundryApi` — directly or
# via a helper in the same file. Checked as "the file imports foundryApi and has no
# other data source", which is what the absences above already establish; this
# asserts the positive so a future rewrite cannot quietly drop the dependency.
if grep -q 'from "@/lib/foundry-client"' "$SRC/lib/api.ts"; then
  pass "api.ts uses foundry-client" "$(grep -c 'foundryApi\.' "$SRC/lib/api.ts") call sites"
else
  fail "api.ts uses foundry-client" "lib/api.ts no longer imports foundryApi"
fi

# The connector catalogue is static FORM SCHEMA, not tenant state, and is allowed —
# but it must stay the only local data module, and must stay type-only + literals.
if [ -f "$SRC/lib/connectors.ts" ]; then
  if grep -qE 'localStorage|fetch\(|foundryApi' "$SRC/lib/connectors.ts"; then
    fail "connectors.ts is static only" "it gained I/O — it must stay a literal catalogue"
  else
    pass "connectors.ts is static only" "form schemas, no I/O"
  fi
fi

echo
echo "The data-source wizard offers nothing that reaches no server"
# ── ⚠ THE SAME RULE AS `/apps/connect`, ONE SUBJECT ALONG (D-117, I-122) ─────
#
# `/data-sources/new` offered "Fetch from a vault" beside direct entry, with
# complete field sets for HashiCorp Vault, AWS Secrets Manager and Azure Key
# Vault (`lib/vault-fields.ts`), and `CredentialForm` on `/keys` carried a second
# copy. Nothing served either: `buildPayload` dropped the connector's secret
# fields and attached `_vault` + `_credential_source`, and
# `grep -rn "_vault\|_credential_source" packages/server/src` returned **zero
# hits**. So picking it assembled a PASSWORD-LESS DSN and the person got
# `400 could not verify that this credential is read-only` — a true message that
# reads as a bug in the gate rather than as an unsupported choice.
#
# It is refused rather than implemented because it cannot pass the gates:
# `assertRegistrableTarget` (D-64) and `assertReadOnly` (D-40) connect at
# REGISTRATION, from the registering process, and a vault-sourced DSN is not known
# until execution — so the row that existed would be the one unverified row in the
# system, on the path holding the strongest control in the codebase.
#
# Two assertions, exactly the shape `/apps/connect` left behind: the file is gone,
# and the page cannot name what it named. Plus a third, because a deletion with no
# explanation on screen is how the option gets re-added by someone who assumes it
# was an oversight — `archive/GAPS.md` records it DELIBERATE for the same reason.
absent_file "no vault provider fields"   "lib/vault-fields.ts"
absent_code_in "the wizard offers no vault mode" '(_vault|_credential_source|VAULT_PROVIDER)' \
  "app/(app)/data-sources"
present_code_in "the wizard says WHY vault is refused" 'not offered, deliberately' \
  "app/(app)/data-sources/new"
# ⚠ A refusal from either datasource gate carries per-rule `findings`, and the
# `message` is only their sentence-joined summary. The wizard must render the
# findings themselves: a refusal means NOTHING was stored, so they are the whole
# next step, and a summarised refusal sends the reader to the wrong fix. I-123.
#
# ⚠ Matched on the SENTENCE the panel puts on screen, not on `normaliseFindings`.
# Perturbation-tested: replacing every call with `[]` left the import line intact,
# so the function-name version passed with the panel gone — a control that cannot
# fail (I-38). What is asserted is the claim a person reads.
present_code_in "a refused registration renders its findings" 'Nothing was stored' \
  "app/(app)/data-sources/new"
# ⚠ And it must send the two fields the server has always accepted. Without
# `schemaAllowlist` every UI-registered datasource introspects `public` alone, so
# a table in a named schema is invisible to the manifest and to the drafter.
present_code_in "the wizard names the schemas to read" 'schema_allowlist' "app/(app)/data-sources/new"
present_code_in "createConnection sends both accepted fields" \
  'schemaAllowlist' "lib/api.ts"

echo
echo "Seeded flows cannot hijack a verification harness"
# `POST /api/executions/begin` resolves a Foundry `flows` row by its Kestra slug.
# A seeded flow reusing a harness slug therefore makes `begin` resolve the seeded
# row and refuse the harness's own run with "flow has no approved revision" —
# `kestra:prove` scenario A fails and nothing in the output points at the cause.
# That happened once and cost a confusing session, so it is a check now.
SHOWCASE="$ROOT/packages/server/src/showcase/flows.ts"
if [ -f "$SHOWCASE" ]; then
  reserved="hr-attendance-screening hr-screening-compiled e2e-ui-journey"
  # Only the `id:` lines of the exported models — the reserved names also appear
  # in the file's own explanation of why they are reserved, and a check that
  # forbade naming them would force that explanation out of the code.
  ids=$(grep -oE '^  id: "[a-z0-9-]+"' "$SHOWCASE" | sed 's/.*"\(.*\)"/\1/')
  clash=""
  for id in $ids; do
    for r in $reserved; do [ "$id" = "$r" ] && clash="$clash $id"; done
  done
  if [ -n "$clash" ]; then
    fail "no showcase flow reuses a harness slug" "clashes:$clash"
  else
    pass "no showcase flow reuses a harness slug" "$(echo "$ids" | wc -w | tr -d ' ') flow id(s) checked"
  fi

  unprefixed=""
  for id in $ids; do
    case "$id" in showcase-*) ;; *) unprefixed="$unprefixed $id" ;; esac
  done
  if [ -n "$unprefixed" ]; then
    fail "showcase flow ids are namespaced" "not prefixed \"showcase-\":$unprefixed"
  else
    pass "showcase flow ids are namespaced" "all showcase-*"
  fi
fi

# A named query is a SQL authoring surface, so its shape rules are load-bearing:
# a zero-parameter query runs through pg's simple protocol, where every statement
# in the string executes (measured). Deleting the check would reopen that.
QSVC="$ROOT/packages/server/src/services/datasource-query.service.ts"
if [ -f "$QSVC" ]; then
  if grep -q 'multiple_statements' "$QSVC" && grep -q 'not_a_read' "$QSVC"; then
    pass "named-query shape rules present" "single-statement + read-only"
  else
    fail "named-query shape rules present" "a write or a second statement could now be saved"
  fi
fi

# A page that cannot render is the loudest possible dishonesty, and it is the one
# thing this net could not see: `e2e:ui` only speaks HTTP, everything else here
# greps source, and the vitest suites are server-side. Nothing renders a React
# page — so `use(params)` on Next 14 broke EVERY /flows/[id] and /runs/[id] load
# for two days with React error #438 while 400+ assertions stayed green.
#
# `params` is a plain object on Next 14 and a Promise only from Next 15. This
# check is therefore version-aware: it fails the Next 15 form while the pinned
# major is 14, and stops applying by itself on a real upgrade rather than
# becoming a rule nobody remembers the reason for.
NEXT_MAJOR="$(grep -o '"next": *"[^"]*"' "$ROOT/packages/client/package.json" \
  | head -1 | sed 's/.*"\^*\([0-9]*\)\..*/\1/')"
if [ "${NEXT_MAJOR:-0}" -lt 15 ] 2>/dev/null; then
  # ⚠ Test files are excluded, and the reason is not convenience. The grep is a
  # STRING match, so `routes.smoke.test.tsx` — whose whole purpose is to render
  # every page and catch exactly this — fails it by describing the bug in a
  # comment. Excluding it swaps a source grep for something strictly stronger:
  # that suite reproduces the defect and asserts on the exception, which was
  # verified by reintroducing `use(params)` and watching /flows/[id] go red.
  offenders="$(grep -rln 'use(params)' "$ROOT/packages/client/src/app" 2>/dev/null \
    | grep -v '\.test\.tsx$' \
    | sed "s|$ROOT/packages/client/src/app/||" | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$offenders" ]; then
    fail "params is unwrapped for Next $NEXT_MAJOR" \
         "use(params) throws React #438 on Next <15: $offenders"
  else
    pass "params is unwrapped for Next $NEXT_MAJOR" "no use(params) — plain object, as 14 passes it"
  fi
else
  # ⚠ From Next 15 `params` is a Promise (Promise-only from 16), so a page taking it as a plain `{ id: string }` PROP reads
  # `undefined` for every field — it renders, asks for record "undefined", and shows an empty or "not found" state. The form this
  # repo uses is `useParams()` from `next/navigation` in the client pages (valid on 14, 15 and 16, no React 19 needed).
  # The rule stops being a no-op here: it names the pages that still take the plain-object prop. Test files are excluded
  # (`--include=page.tsx`): `record-pages.test.tsx` is what proves each page actually USES the id.
  offenders="$(grep -rlE 'params\??: *\{ *id: *string' "$ROOT/packages/client/src/app" --include=page.tsx 2>/dev/null \
    | sed "s|$ROOT/packages/client/src/app/||" | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$offenders" ]; then
    fail "params is read the Next $NEXT_MAJOR way" "a plain-object params prop (a Promise on 15+): $offenders"
  else
    pass "params is read the Next $NEXT_MAJOR way" "no page takes a plain-object params prop"
  fi
  # `use(params)` needs React 19; this repo pins React 18, which has no `use` — it would throw on every load, in the tests and in
  # a build whose React is the one in node_modules. Remove this half when react in package.json says 19.
  REACT_MAJOR="$(grep -o '"react": *"[^"]*"' "$ROOT/packages/client/package.json" | head -1 | sed 's/.*"\^*\([0-9]*\)\..*/\1/')"
  if [ "${REACT_MAJOR:-0}" -lt 19 ] 2>/dev/null; then
    # ⚠ A USE, not a mention: comment lines are dropped first, or the comment explaining why this is banned trips the ban (I-62).
    offenders="$(grep -rn 'use(params)' "$ROOT/packages/client/src/app" 2>/dev/null | grep -v '\.test\.tsx:' \
      | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' | cut -d: -f1 \
      | sed "s|$ROOT/packages/client/src/app/||" | sort -u | tr '\n' ' ' | sed 's/ $//')"
    if [ -n "$offenders" ]; then
      fail "use(params) is not used on React $REACT_MAJOR" "React <19 has no use(): $offenders"
    else
      pass "use(params) is not used on React $REACT_MAJOR" "useParams() instead — no React 19 dependency"
    fi
  fi
fi

# ── The canvas (programme 3, Stage 2) ────────────────────────────────────────
echo
echo "The canvas can only draw what the server sent"

# 1. Every page is rendered by the smoke suite.
#
# This is the check that would have caught `use(params)` — not by knowing about
# Next versions, but by noticing that two routes existed which nothing rendered.
# A new page added without a line in `routes.smoke.test.tsx` is a page with zero
# render coverage, and the failure mode is silent: the suite stays green because
# it never loads the file.
SMOKE="$SRC/app/routes.smoke.test.tsx"
if [ ! -f "$SMOKE" ]; then
  fail "every page is smoke-rendered" "routes.smoke.test.tsx is gone"
else
  missing=""
  while IFS= read -r page; do
    rel="${page#"$SRC/app/"}"          # e.g. (app)/tools/page.tsx
    imp="./${rel%.tsx}"                 # e.g. ./(app)/tools/page
    grep -qF "import(\"$imp\")" "$SMOKE" || missing="$missing ${rel%/page.tsx}"
  done < <(find "$SRC/app/(app)" -name page.tsx 2>/dev/null | sort)
  if [ -n "$missing" ]; then
    fail "every page is smoke-rendered" "no render test for:$missing"
  else
    n="$(find "$SRC/app/(app)" -name page.tsx 2>/dev/null | wc -l | tr -d ' ')"
    pass "every page is smoke-rendered" "$n page(s)"
  fi
fi

# 2. The model-seam rule has exactly one implementation.
#
# ⚠ The badge saying "this step sends your data to a model" is a safety claim,
# and a second copy of the rule is how one of them silently stops matching. Same
# reasoning as `kestra:check` asserting TETHER_API_KEY is read in exactly three
# files: a fourth reader would work perfectly and report nothing.
# Matches the name as CODE — a quoted literal or an identifier being compared —
# and not as prose. `/ai-provider` says the word in a sentence twice, correctly,
# and a check that cannot tell a sentence from a comparison is a check somebody
# turns off. Comments and tests are excluded for the same reason.
seam_files="$(grep -rnE '"llm_complete"|llm_complete.*[!=]==|[!=]==.*llm_complete' \
  "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v '\.test\.tsx\?:' | grep -vE ':[0-9]+: *(//|\*)' \
  | cut -d: -f1 | sed "s|$SRC/||" | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ "$seam_files" = "lib/canvas-model.ts" ]; then
  pass "one model-seam rule" "lib/canvas-model.ts only"
else
  fail "one model-seam rule" "llm_complete is compared in: $seam_files"
fi

# 3. A canvas node is never invented.
#
# The empty graph must render a message, not a placeholder node — the faFallback
# lesson one component along. Asserted as the presence of the empty branch,
# because its absence is what would let a default node through.
if grep -q 'graph.nodes.length' "$SRC/components/flow/FlowCanvas.tsx" 2>/dev/null; then
  pass "empty graph renders empty" "no placeholder node"
else
  fail "empty graph renders empty" "FlowCanvas has no empty branch — a drawn box could be fabricated"
fi

# 4. The text equivalent survives.
#
# ⚠ REPOINTED 2026-09-11: the reworked run page has no canvas — it is all
# text (`TraceList`, `ReplayRow`, `EvidenceRow`, `RunOutput`) — so "the strip
# is on the run page" now fails for the right file being correct. What the
# check was really asserting is that the run's trace is readable without the
# picture, and that is what it checks now: the page renders its trace as
# text. `StepStrip.tsx` is still asserted not-deleted beside it, since the
# file survives and a deleted strip is the tidy-up this guards against.
# ⚠ 2026-10-11: `StepStrip.tsx` is DELETED with the compiled builder (it had no live caller), so the
# not-deleted half of this check went with it. The property that matters is unchanged: the trace reads as text.
if grep -q 'TraceList' "$SRC/app/(app)/runs/[id]/page.tsx" 2>/dev/null; then
  pass "the canvas has a text equivalent" "the run trace renders as text"
else
  fail "the canvas has a text equivalent" "the run page no longer renders its trace as text"
fi

# 5. The graph is never built inline in JSX.
#
# ⚠ This is the FLASHING, pinned. `graph={canvasFromExecution(run.graph,
# run.steps)}` builds a new graph object on every render, so dagre re-laid-out
# the whole DAG on every stream update, on every keystroke in the outline, and
# on every click that changed a selection. The picture visibly shimmered, and
# the cause read as "React Flow is janky" rather than as a missing `useMemo`.
#
# A grep rather than a render test because the symptom is a re-render count,
# which jsdom will not show you — and because the fix is one word that a later
# refactor removes without noticing.
# Test files are exempt and that is not a loophole: a test renders once, so
# there is no re-render to avoid, and forcing a `useMemo` into a test body would
# only make the fixture harder to read.
inline_graph="$(grep -rn 'graph={canvasFrom' "$SRC" --include=*.tsx 2>/dev/null \
  | grep -v '\.test\.tsx:' || true)"
if [ -n "$inline_graph" ]; then
  fail "the canvas graph is memoised, never built in JSX" \
    "built inline (dagre re-runs every render): $(echo "$inline_graph" | head -3 | tr '\n' ' ')"
else
  pass "the canvas graph is memoised, never built in JSX" "no adapter call inside a graph= prop"
fi

# 6. ⚠ RETIRED with outline mode (compiled-builder phase 8, D-333). The sketch
# keyed its nodes by position so a keystroke did not remount a card (I-59);
# with the outline form gone, `canvasFromOutline` went too. Pinned as an absence
# so a second sketch adapter is a decision, not a leftover.
absent_code_in "the outline sketch went with outline mode" 'canvasFromOutline' "lib"

echo
echo "The editable canvas cannot reach a weaker path than the drafter"

# 5. The canvas has NO write path of its own.
#
# ⚠ This is the whole safety argument of Stage 5 as a grep. CLAUDE.md kept
# `POST /workspaces/:ws/flows` a deliberate GAP because *"a `createFlow` taking
# arbitrary JSON would be a step palette by another route"*. The palette exists
# now, and what makes that acceptable is that a canvas-authored flow is posted as
# `authored` to the GENERATION route — through `authorFlow`, which is the
# drafter's own parse, allowlist, `splitDraft` and `validateModel`.
#
# A `foundryApi.createFlow` appearing later would work perfectly and route around
# every one of those. So its absence is asserted, not assumed.
if grep -rn "createFlow" "$SRC/lib/foundry-client.ts" "$SRC/lib/api.ts" 2>/dev/null | grep -q .; then
  fail "the canvas has no second write path" \
    "a createFlow appeared in the client — a hand-authored model must go through \`authored\`"
else
  pass "the canvas has no second write path" "authored → the generation route only"
fi

# 6. The expression allowlist is SERVED, never hardcoded in the browser.
#
# D-22's five roots and seven callables are a security boundary. A client copy
# drifts silently in both directions: a name the server never allowed shows green
# and fails on save, and a missing name refuses valid expressions with the server
# disagreeing. `lib/flow-expr.ts` takes the list as an argument and
# `GET …/catalogue` supplies it.
if grep -nE '"(secret|json|jq|first|tostring|tonumber)"' "$SRC/lib/flow-expr.ts" 2>/dev/null \
   | grep -vE ':[0-9]+: *(//|\*)' | grep -q .; then
  fail "the allowlist is served, not hardcoded" \
    "lib/flow-expr.ts names allowlist members — it must take them as an argument"
else
  pass "the allowlist is served, not hardcoded" "flow-expr.ts takes the list from the catalogue"
fi

# 7. There is no code box on a `code` step.
#
# A `code` step is a function of its CONTRACT (D-19): the fragment is generated
# from it and its output keys are checked in-container against it. A body typed
# on the canvas would be code no contract describes, and `outputKeys` — derived
# server-side in `splitDraft` — would be describing something else entirely.
#
# ⚠ REPOINTED in foundations Phase 2.1 (D-121). This greped
# `$SRC/lib/flow-authoring.ts` until the edit vocabulary moved into
# `@foundry/flow-edit` and that file became a re-export shim. A shim declares no
# fields, so the grep would have found nothing and printed PASS for ever — a
# check that cannot fail (I-38), on the one rule that keeps a fragment body
# unauthorable. It now names the file the type actually lives in.
# ⚠ AND WIDENED, because the mandated perturbation of the repointed check found a
# blind spot the original pattern had all along. It was `\bcode\s*:`, which does
# not match `code?: string` — and OPTIONAL is exactly how this field would arrive,
# because a required one breaks every existing call site and an optional one
# compiles on the first try. Measured, both ways round: `code: string` FAILs,
# `code?: string` PASSed. One `\??` closes it. Perturb both forms if you touch
# this.
absent_code_at "a canvas code step carries a contract, never code" \
  '\bcode\s*\??\s*:' "packages/flow-edit/src/index.ts"

# 7a1. Chat mode says what changed, and offers no way to re-ask.
#
# ⚠ Foundations Phase 2.12. Eight assertions on one component, because chat is
# the surface where every rule this programme protects is easiest to undo by
# accident.
#
# The first three are the same rule from three sides: **the model writes nothing
# that reaches this screen.** The change line is `describeOp` computed
# server-side over the op that was applied; the diff is `flowApprovalService
# .diff`, the same function the approval screen reads; and there is no text
# field on a turn to render even if someone wanted to. A stored narration would
# sit beside a diff it could contradict while looking like the record of the
# edit — which is `generation-audit.service.ts` with a new name, and that service
# marked `clean` a script that emailed 0 of 11 people.
#
# The fourth is §6.7: a refusal must have NO control that resubmits it, because
# re-asking is how a correct `insufficient_contract` becomes an invented
# `period="2023-10"`. `/flows/new`'s refusal panel already obeys this; chat is
# where it would be undone, because a chat box is a resubmit control by nature.
#
# The fifth is the `ambiguous_referent` candidate actually re-POSTING. A list
# that only displayed the candidates renders identically and answers nothing —
# the classic renders-but-does-not-submit case.

# 7a2. The chat gate op SPLICES; it does not build a gate of its own.
#
# ⚠ Foundations Phase 2.3. `applyOp`'s `add_gate` delegates to `spliceApproval`
# and does nothing else, and `add_step` REFUSES `kind: "approval"` with a message
# naming `add_gate`. The reason is the one this repo has already paid for twice:
# Kestra runs tasks in emission order, so a gate appended after its target
# satisfies every assertion about a pause existing and stops nothing — the email
# has already gone. `spliceApproval` is deliberately the single gate-placement
# implementation (D-121), and an `add_gate` that assembled its own approval step
# would be the second one.
#
# Two assertions, because either alone is satisfiable by the defect: the module
# could name `spliceApproval` in a comment while building its own step, or drop
# the call and keep the construction.
present_code_at "the chat gate op splices, never appends" 'spliceApproval\(' \
  "packages/flow-edit/src/ops.ts"
absent_code_at "the chat op module builds no gate of its own" 'kind:\s*"approval"' \
  "packages/flow-edit/src/ops.ts"

# 7b. Reading a stored flow back into the editable shape has ONE implementation.
#
# ⚠ Foundations Phase 2.2 (I-130). `authoredFromModel` is the inverse of the
# server's `splitDraft`, and it has two consumers with different reasons to want a
# shortcut: the canvas reopen here, and chat's per-turn read on the server. A
# second implementation is how those two come to disagree about what a stored flow
# IS — and the disagreement is invisible, because each half round-trips fine
# against itself. Same argument `spliceApproval` gets (D-121): two implementations
# of one conversion is one implementation and one bug.
#
# The count is of DEFINITIONS, so the re-export in `index.ts` and the client's
# shim do not register.
n=$(grep -rn 'export function authoredFromModel' "$ROOT/packages" --include=\*.ts 2>/dev/null \
  | grep -v '/dist/' | grep -v node_modules | wc -l | tr -d ' ')
if [ "$n" -eq 1 ]; then
  pass "reading a flow back has one implementation" "authoredFromModel, in @foundry/flow-edit"
else
  fail "reading a flow back has one implementation" \
    "$n definitions of authoredFromModel — the canvas and chat can now disagree about what a stored flow is"
fi

# 7c. ⚠ RETIRED (D-333). "Open a copy in the manual builder" posted an
# authored model to the generation route, which is deleted. A copy is made from
# the flow's Share panel (export → import), which goes through `importFlow` like
# any bundle. Pinned as an absence: a `?from=` reopen here would post to a route
# that no longer exists.
absent_code_in "no reopen-as-copy onto a deleted route" 'searchParams\.get\("from"\)' "app/(app)/flows/new/page.tsx"

echo
echo "A test run says which data it read"

# 8. The sandbox/production answer is RENDERED, not inferred in the browser.
#
# `StepRun.readFrom` is stamped server-side at callback time, because the answer
# depends on whether a sandbox existed AT THE TIME OF THE RUN. A client that
# worked it out from the datasource's current state would silently rewrite the
# history of every draft run that read production the moment somebody provisions
# a sandbox — turning the record of an exposure into a record of there never
# having been one.
# ⚠ REPOINTED 2026-10-11: `StepDetail.tsx` is deleted (no live caller); the run page states it as a figure.
if grep -q 'label: "Read from"' "$SRC/app/(app)/runs/[id]/page.tsx" 2>/dev/null; then
  pass "a step says which database it read" "the run page states Read from"
else
  fail "a step says which database it read" \
    "the run page does not say what it read from — a test run that read production would say nothing"
fi

# 9. BOTH answers are rendered, and the production one is not the quiet case.
#
# The tempting shape is a badge when a sandbox exists and nothing otherwise —
# which reads as "fine" for every datasource that has never been given one, i.e.
# all of them on day one. Same failure as `faFallback`: the absence of a warning
# standing in for the absence of a problem.
# ⚠ Matched on the RENDERED expression, not on the word appearing anywhere in
# the file. The first version grepped for "exposure" and passed against the
# docblock that explains why the field is rendered — so blanking the render left
# the check green. Proven by perturbation both ways.
if grep -q '{data.exposure}' "$SRC/components/data/SandboxPanel.tsx" 2>/dev/null \
   && grep -q '"production data"' "$SRC/components/data/SandboxPanel.tsx" 2>/dev/null; then
  pass "no sandbox is stated, not left blank" "SandboxPanel renders the server's exposure sentence"
else
  fail "no sandbox is stated, not left blank" \
    "SandboxPanel does not render the production case — absence of a badge is not a warning"
fi

# 10. The browser cannot provision a sandbox.
#
# Provisioning generates rows with a model, drops and recreates a database and
# creates a login role. That is the shape of `POST /api/demo/provision`, which
# Stage 1 deleted for being a destructive reseed from one authenticated request.
# Comment lines are excluded the same way check 6 does it — `foundry-client.ts`
# names `provisionSandbox` in a docblock explaining why it is absent, and a check
# that fails on its own justification teaches people to delete the justification.
if grep -rnE "provisionSandbox|sandbox/provision" "$SRC/lib/foundry-client.ts" "$SRC/lib/api.ts" 2>/dev/null \
   | grep -vE ':[0-9]+: *(//|\*)' | grep -q .; then
  fail "the browser cannot provision a sandbox" \
    "a provision call appeared in the client — it drops a database and creates a role"
else
  pass "the browser cannot provision a sandbox" "read-only over HTTP; provisioning is a CLI command"
fi


# 12. The expectation editor BUILDS a claim; it never takes one as text.
#
# D-50's rule, applied to the second declarative vocabulary in the product. A
# raw JSON box here would be an expression language by the back door, with none
# of the server-side schema's bounds visible to the person typing into it.
if grep -rnE "JSON\.parse\(|assertJson|rawAssert" "$SRC/components/flow/ExpectationEditor.tsx" 2>/dev/null \
   | grep -vE ':[0-9]+: *(//|\*)' | grep -q .; then
  fail "the expectation editor builds a claim, never parses one" \
    "a JSON escape hatch appeared — the vocabulary is safe because it cannot express computation"
else
  pass "the expectation editor builds a claim, never parses one" "form fields only, no raw box"
fi


echo
echo "A DB operation is approved on a readback, and the readback's bound is stated"
#
# ── proposed-db-operations · T17 · FR-012 / FR-025 / SC-008 ─────────────────
#
# `DbOperationsPanel` asks a person to approve a spec they did not write, on the
# strength of an English description of it. Three things have to be on that
# screen, and each of them is one edit from silently gone.

# 13a. The name is a DECISION, and this is the last moment it can be made.
#
# An operation's name is half of every `<datasource>.<operation>` ref, so
# renaming after save breaks every flow referencing it — which is why there is no
# rename in the product at all (FR-012, D-173). The sentence has to be in front
# of the person while the field is still editable; stating it afterwards is
# stating it to somebody who can no longer act on it.
#
# ⚠ A short fragment on purpose, matching check 13's reasoning: JSX wraps prose
# across source lines, so a whole-sentence grep fails on Prettier reflow rather
# than on meaning — and a check that fires when a paragraph is re-wrapped gets
# deleted rather than fixed.
#
# ⚠ **BOTH FILES, and the pair is the assertion.** `OperationReview.tsx` holds
# the sentence for the two PROPOSED paths (the panel's and the chat turn's, one
# component — D-195); `DbOperationsPanel.tsx` holds it for the HAND-BUILT spec,
# which is a different form on a different screen. One file having it is one
# author being warned. The review component was extracted mid-P3 and this check
# went red immediately, which is the behaviour wanted: moving a control's subject
# must not quietly leave it scanning nothing.
name_note_files=0
for f in components/data/OperationReview.tsx components/data/DbOperationsPanel.tsx; do
  grep -q "cannot be changed later" "$SRC/$f" 2>/dev/null && name_note_files=$((name_note_files + 1))
done
if [ "$name_note_files" -eq 2 ]; then
  pass "an operation's name says it is permanent" "stated for both the proposed and the hand-built spec"
else
  fail "an operation's name says it is permanent" \
    "only $name_note_files of 2 surfaces warn that the name is half of every ref and cannot be renamed"
fi

# 13b. What approving the readback does NOT establish.
#
# FR-025, and it is the honest half of this gate. The readback is decidable from
# the spec alone; units and business meaning are not. `finance_demo`'s
# `amount_cents`-versus-`amount` trap is a perfectly correct readback over a spec
# that reports Engineering as 62x over budget — so a screen implying that
# approving the sentence verified the data is the false green this product exists
# to avoid, arriving on a new surface.
#
# ⚠ It must also point at the thing that CAN check it. "This is not verified" with
# no next step is a warning nobody can act on.
# ⚠ Asserted where the sentence is DEFINED (`OperationReview.tsx`'s
# `REVIEW_CAVEAT`) and where the hand-built path RENDERS it, so neither the
# definition nor a use can go alone. Every proposed path renders it through
# `ProposalReview`, which is the one component all three surfaces share.
if grep -q "not checked here" "$SRC/components/data/OperationReview.tsx" 2>/dev/null \
   && grep -q "add an expectation" "$SRC/components/data/OperationReview.tsx" 2>/dev/null \
   && grep -q "REVIEW_CAVEAT" "$SRC/components/data/DbOperationsPanel.tsx" 2>/dev/null; then
  pass "the readback states what it cannot check" "units and business meaning, and where they ARE checked"
else
  fail "the readback states what it cannot check" \
    "FR-025's caveat is gone from its definition or from the hand-built builder — approving a readback now reads as verifying the data"
fi

# 13c. SC-008 — no surface renders a row of data that did not come from the
#      tenant's database.
#
# ⚠ THIS IS THE `faFallback` RULE ON THE NEWEST SURFACE, and it very nearly
# shipped: `lib/mock-rows.ts` was built during this feature and deleted as
# *"invented values wearing a real table's column names"*. There is no endpoint on
# this path that returns a row — `check()` and `/operations/propose` serve schema
# metadata only — so a sample row on this screen could ONLY be invented, and it
# would be invented directly beneath a real table's real column names, which is
# the most convincing possible form of it.
#
# Same shape as the `createFlow` absence: pinned as an absence, in the client,
# because the moment one exists somebody will render it.
#
# ⚠ Test files are excluded, for the reason the browser-storage check states at
# line 332 and for one more: `DbOperationsPanel.test.tsx` asserts this same
# absence, so without the exclusion this check fires on its own justification —
# and a check that goes red because somebody wrote the matching test teaches
# people to delete the test (I-62). The defect guarded here is a SHIPPED row
# builder, and a `.test.tsx` ships nowhere.
if grep -rnE --include=\*.ts --include=\*.tsx "mock-rows|mockRows|sampleRows|previewRows|fakeRows" \
     "$SRC/components/data" "$SRC/lib/foundry-client.ts" "$SRC/lib/api.ts" 2>/dev/null \
   | grep -vE '\.test\.tsx?:' | grep -vE ':[0-9]+: *(//|\*)' | grep -q .; then
  fail "no invented rows on a data surface" \
    "a sample-row builder appeared — these screens are served schema metadata only, so any row here is fabricated"
else
  pass "no invented rows on a data surface" "schema metadata only; nothing on this path returns a row"
fi

echo
echo "Colour comes from the token map, and only from there"
#
# 14. No colour literal anywhere in `src/**` outside `globals.css`.
#
# ── WHY THIS IS A CHECK AND NOT A CONVENTION ────────────────────────────────
#
# Foundry now ships TWO themes. A hex or an `rgba()` written into a component is
# a value that cannot follow the theme: it is correct in whichever theme the
# author happened to be looking at and wrong in the other, and it fails
# SILENTLY — nothing errors, nothing logs, the element is simply invisible or
# illegible for half the users. That is the same shape as the deleted
# `faFallback`: a screen that looks fine to whoever wrote it.
#
# It is also what keeps the token map load-bearing rather than decorative. A
# design system nobody is forced to use is a stylesheet with good intentions;
# the reason `globals.css` is worth maintaining is that there is nowhere else to
# put a colour.
#
# Before this landed, the literals were: the React Flow minimap mask (twice —
# once in the CSS and once inline in `FlowCanvas.tsx`, already drifting apart),
# the login page's focal glow, `/outbox`'s `bg-[#111]` modal, and the primary
# button's glow. Each is now a token.
#
# ⚠ ONE FILE IS EXEMPT, BY NAME, AND THE EXEMPTION IS THE POINT.
# `components/ui/MicrosoftMark.tsx` holds four hexes because they are Microsoft's
# registered brand mark, not Foundry's palette: fixed by someone else's brand
# guidelines, identical in both themes, and actively wrong to "harmonise" with
# the earthy theme. It is quarantined in a file that holds nothing else, so the
# exemption cannot silently widen to cover a real defect. If a second file ever
# needs exempting, that is a decision to write down — not a pattern to loosen.
theme_literals=$(grep -rn --include=\*.ts --include=\*.tsx -E '#[0-9a-fA-F]{3,8}\b|rgba?\(' "$SRC" 2>/dev/null \
  | grep -v '/MicrosoftMark\.tsx:' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
  | head -5)
if [ -n "$theme_literals" ]; then
  fail "no colour literal outside globals.css" "a hardcoded colour cannot follow the theme:"
  echo "$theme_literals" | sed 's/^/          /'
else
  pass "no colour literal outside globals.css" "every colour resolves through a token"
fi

# 15. Both light-theme application blocks stay in step.
#
# `globals.css` applies the light map twice — once under the OS media query and
# once under the explicit `[data-theme="light"]` attribute — because CSS cannot
# share one declaration block between the two. The VALUES live once (`--l-*`),
# so they cannot drift; the ASSIGNMENT LISTS can, and a token added to only one
# of them is the worst kind of half-bug: the theme is correct for whoever chose
# it explicitly and broken for whoever got it from their OS, which is exactly
# the population least likely to report it.
#
# `theme.test.ts` compares the two bodies properly. This is the cheap guard that
# fires without the test runner: the two blocks must declare the same NUMBER of
# custom properties.
#
# ⚠ It counts DECLARATIONS, not lines, and the difference is not pedantry — the
# first version counted lines and was proven unable to fail. Several tokens share
# a line, so deleting one from a shared line left the line counts equal and the
# check green over a genuinely broken theme. That is I-38's shape: a control that
# cannot fail is worse than no control, because it is also reassuring. The
# perturbation that exposed it is recorded in evidence.md §4.
css="$SRC/app/globals.css"
media_block=$(awk '/^@media \(prefers-color-scheme: light\)/,/^}/' "$css" | grep -oE '\--[a-z0-9-]+:' | wc -l)
attr_block=$(awk '/^:root\[data-theme="light"\]/,/^}/' "$css" | grep -oE '\--[a-z0-9-]+:' | wc -l)
if [ "$media_block" -gt 0 ] && [ "$media_block" -eq "$attr_block" ]; then
  pass "both light blocks apply the same tokens" "$media_block declarations in each"
else
  fail "both light blocks apply the same tokens" \
    "media query has $media_block, [data-theme=light] has $attr_block — one theme path is missing tokens"
fi

# 16 & 17. NO page owns its width, and no page owns a row grid.
#
# `plan.md` Phase 4's exit criterion. Until Phase 4 these were scoped to a LIST
# of migrated pages, because a blanket version would have failed seventeen times
# for pages nobody had touched yet — and a check that fails for the right reason
# at the wrong time gets commented out, not fixed. All eighteen pages are
# migrated now, so the list collapses into the blanket form it was always
# heading for, and the third assertion that kept the list honest is gone with
# the list (D-99).
#
#   width  — `<Page measure>` chooses it by ARCHETYPE. Eleven pages were 5xl,
#            four were 4xl and two were 3xl, with no rule saying which.
#   grid   — a row shape is a NAMED SET in `DataTable.tsx`. There were nine
#            bespoke templates, no two agreeing, for the same shape of row.
#
# ⚠ Both greps are deliberately BLUNT and match anywhere in a page file, not
# just on an outer container. That cost three real edits during the migration — a
# search box, a paragraph and a wizard panel each capping their own width — and
# every one of them was better off for it: two became plain widths and the third
# became `<Page measure>` chosen per mode. A narrower grep would have let all
# three stand, and "the page does not choose its width" would have been true of
# the outer div only.
PAGES="$(find "$SRC/app/(app)" -name page.tsx 2>/dev/null | sort)"

width_offenders=""
grid_offenders=""
pane_offenders=""
for f in $PAGES; do
  rel="${f#"$SRC/"}"
  if grep -nE 'max-w-' "$f" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' | grep -q .; then
    width_offenders="$width_offenders $rel"
  fi
  if grep -nE 'grid-cols-\[' "$f" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' | grep -q .; then
    grid_offenders="$grid_offenders $rel"
  fi
  # ── D-104: a canvas needs a pane, and the form measure is not one ──────────
  #
  # `MIN_CANVAS_W` is 840 — three nodes and the two gaps between them, which is
  # the narrowest a graph can be and still show a RELATIONSHIP. `--w-form` is
  # 680. So a page that declares `measure="form"` and draws a `FlowCanvas` is
  # drawing a picture nobody can read and presenting it as if they could, which
  # is exactly what D-79 decided against. The answer there is `CanvasStrip`.
  #
  # ⚠ Static, and it has to be: jsdom performs no layout (I-75) and a canvas
  # cannot know its container's width without measuring, so "is this wide
  # enough" is a question no client test can ask. What IS checkable is the
  # choice the page already made in source. This was red on `/flows/new`.
  if grep -q 'measure=.*"form"' "$f" && grep -qE '<FlowCanvas' "$f"; then
    pane_offenders="$pane_offenders $rel"
  fi
done

# ⚠ A guard on the guard. If the walk ever returns nothing — a moved directory, a
# renamed route group — both loops iterate an empty list and report green for
# ever. That is I-38's shape, and it is exactly what the scoped version's third
# assertion existed to catch before the list it guarded went away.
page_count="$(echo "$PAGES" | wc -w | tr -d ' ')"
if [ "$page_count" -lt 10 ]; then
  fail "the page walk finds pages" "only $page_count page(s) under app/(app) — the walk is broken, not the tree"
else
  pass "the page walk finds pages" "$page_count page(s) scanned for width and grid"
fi

if [ -n "$width_offenders" ]; then
  fail "no page sets its own width" "<Page measure> owns it, not the page:$width_offenders"
else
  pass "no page sets its own width" "the measure is chosen by archetype"
fi

# ⚠ REPOINTED 2026-09-11, not weakened: both hits were content + sidebar
# detail splits, not DataTable row shapes, so "a new shape is a named set in
# DataTable.tsx" failed for the right pages being the wrong kind of shape.
# The property is unchanged — a page declares no grid of its own — and the
# shape a detail split takes is the shared `MainAside` primitive, which is
# pinned where it is used below. A row shape is still a named set in
# `DataTable.tsx`; a detail split was never one.
if [ -n "$grid_offenders" ]; then
  fail "no page declares a row grid" "a detail split is MainAside, a row shape is a named set in DataTable.tsx:$grid_offenders"
else
  pass "no page declares a row grid" "no page-local grid template"
fi
present_code_in "detail splits share one primitive" '<MainAside' "app/(app)/approvals/[id]/page.tsx"
present_code_in "detail splits share one primitive" '<MainAside' "app/(app)/runs/[id]/page.tsx"

if [ -n "$pane_offenders" ]; then
  fail "a canvas gets a pane, or the page gets the strip" "a form column is 680px and a graph needs 840:$pane_offenders"
else
  pass "a canvas gets a pane, or the page gets the strip" "no FlowCanvas inside a form measure"
fi

echo
echo "The authoring journey is derived, and has one way forward"
# ⚠ Phase 6.2. `lib/authoring-rail.ts`'s whole argument is that a TRACKED
# current-step variable can disagree with what is actually happening. `step` and
# `panel` are both derived on `/flows/new` — from whether a job exists and
# whether an approach has been chosen — and a `useState` holding either is the
# one edit that would quietly undo it.
absent_code_in "the wizard's step is derived, never tracked" 'useState<(Step|Panel)' "app/(app)/flows/new"
# ⚠ D-105/D-79. `FlowBuilder` had `lg:grid-cols-[1fr_360px]` — a canvas and an
# inspector in a hand-rolled two-column grid, with no fold and no minimum. That
# is the squeeze the workbench exists to replace, and it is the shape it would
# come back in.
absent_code "no hand-rolled canvas + inspector grid" 'grid-cols-\[1fr_[0-9]+px\]'

# ⚠ RETIRED (D-333): the single-action-surface rule. `WizardFooter` was the one
# place `/flows/new` advanced a generation job — refusal, failure and "design it
# again" all lived behind it. There is no job now: chat and the engine canvas
# each own their one action, and a refusal is answered inside the conversation.
# Pinned as an absence, so a footer that re-appears has to bring its reason.
absent_code_in "the door has no wizard footer — each builder owns its action" '<WizardFooter' "app/(app)/flows/new/page.tsx"

echo
echo "One thing draws a step, and its size is a name"
# ⚠ D-101. The plan's own exit criterion for this was `absent_code` on the old
# SVG renderer's `node-box` class — and that renderer went with `StepGraph.tsx`
# in programme 3, so the check could never have failed. That is I-38 arriving
# inside the phase whose caveat warns about it. What is checked instead is the
# property worth holding: exactly one thing in this product draws a step.
#
# Two scopes, neither redundant: the first says a flow component may not grow
# its own picture, the second says a page may not. `components/ui/icons.tsx` is
# deliberately outside both — an icon set is where raw SVG belongs, and
# forbidding it there just pushes icons into images.
#
# ⚠ `builder/FlagMark.tsx` is exempted BY NAME, icons.tsx-shaped: it draws
# 16px status glyphs in `currentColor` and theme tokens with aria-labels —
# icons, not a step renderer. The exemption names the file so a second inline
# picture anywhere else in `components/flow` still fails; widening it to the
# directory would be deleting the ban.
flag_svg=$(grep -rnH --include=\*.tsx -E '<(svg|rect|polyline)\b' "$SRC/components/flow" 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
  | grep -v 'builder/FlagMark\.tsx:' \
  | grep -v '\.test\.tsx:' \
  | head -5)
if [ -n "$flag_svg" ]; then
  fail "no second step renderer (flow components)" "still referenced:"
  echo "$flag_svg" | sed 's/^/          /'
else
  pass "no second step renderer (flow components)" "one renderer; FlagMark glyphs exempted by name"
fi
absent_code_in "no second step renderer (pages)"           '<(svg|rect|polyline)\b' "app/(app)"
# ⚠ D-102. `height` was removed from `FlowCanvasProps`, so the typecheck already
# refuses it — once. This is what keeps it gone: left as an escape hatch beside
# the named densities, the six literals (220 · 200 · 280 · 320 · 400 · 420) come
# straight back, each chosen by someone who could not see the other five.
absent_code "canvas size is a name, not a number" 'height=\{[0-9]+\}'

echo
echo "A trigger says what it will actually do"
# ⚠ I-95. The Triggers page carried three claims that firing a trigger was safe —
# the purpose line ("testing never touches real data"), the button label
# ("Test"), and a green banner over the result ("This was a safe test — no real
# data was touched"). Firing runs the automation's APPROVED LIVE REVISION against
# the real datasource. All three were accurate about a mock fire that was deleted
# in the away-from-demo-mode programme; the copy outlived the code path, which is
# the shape that survives review indefinitely because nothing about it looks new.
absent_code_in "no safe-test claim on /triggers" \
  '(safe test|never touches real data|no real data was touched)' "app/(app)/triggers"
# ⚠ I-94. Seven kinds were offered against a server that accepts three, and
# `iconToAType` was the funnel: Email and File upload became webhooks, Kafka and
# RabbitMQ became `poll` triggers with no url. `lib/trigger-kinds.ts` is the one
# catalogue now, and `lib/trigger-kinds.test.ts` mirrors it against the server's
# own list. This keeps the funnel from coming back under any name.
absent_code "no icon-to-type funnel"      'iconToAType'
# ⚠ The first version of this asserted that `lib/trigger-kinds.ts` contains the
# word `CREATABLE` — which is a file mentioning its own export, and it stayed
# green through a rename that broke nothing else. A control that cannot fail is
# worse than none (I-38), so it was replaced rather than kept. The property that
# matters is that BOTH pickers read the ONE catalogue: two lists would drift, and
# the drift that already happened is I-94.
present_code_in "the /triggers picker reads the shared catalogue" \
  'from "@/lib/trigger-kinds"' "app/(app)/triggers"
# ⚠ I-92. `config` is not a flat map — its one load-bearing key is `inputs`, an
# object — so rendering it as label/value rows printed `[object Object]` on every
# trigger that carried any. `declaredInputs` replaced it and says more: which
# inputs exist, and who supplies each.
absent_code "trigger config is not rendered raw" 'Object\.entries\(t\.config'

echo
echo "Gate 1 and gate 2 stay TWO sentences"
# ⚠ D-88, and Phase 7 moved them from the card to the automation's group header
# without merging them. "It has never run" is fixed by running it; "it has no
# approved revision" is fixed by a second person. One merged sentence can only be
# right about one of them, and a switch that silently does nothing is the mistake
# the deleted localStorage go-live gate made.
present_code_in "gate 1 is stated on /triggers"        'enableBlockedReason' "app/(app)/triggers"
present_code_in "gate 2 is stated on /triggers"        'approvalBlockedReason' "app/(app)/triggers"
# ⚠ D-108. The THIRD sentence is a WARNING and must not be dressed as a refusal:
# its fix is typing a value, and nothing refuses on it. `inputsWarning` is the
# name precisely so no reader takes it for a gate — a `*BlockedReason` here would
# read as one.
absent_code "the input warning is not named a block" 'inputsBlockedReason'

echo
echo "A secret can be edited and still never read"
# ── ui-upgrade Phase 8 (D-110) ───────────────────────────────────────────────
#
# Phase 8 makes a secret's NAME editable, which is the first time anything but
# its value could move. What it must not make editable is READABLE. `CLAUDE.md`:
# *"there is deliberately no endpoint that returns a secret value, and no
# `?reveal=`."* The plan states it as non-negotiable, and a rule stated only in
# prose is one the next feature walks past — so these are the assertions.
SECSVC="$ROOT/packages/server/src/services/workspace-secret.service.ts"
SECRTE="$ROOT/packages/server/src/routes/workspace-secrets.ts"
if [ -f "$SECSVC" ] && [ -f "$SECRTE" ]; then
  # ⚠ THREE, and the number is the check. A stored value is decrypted in exactly
  # three places, all inside `resolveForExecution`/`resolveForGeneration` — the
  # two server-side-only paths that put it on a container as a `-e` flag or into
  # a Tether tenant. A fourth call site is how a value acquires a way out, and it
  # would work perfectly and report nothing. Same shape as `kestra:check`'s
  # "TETHER_API_KEY is read in exactly three files".
  # Mock-data programme: one of the three moved behind `decryptDsnIfPresent` in
  # `repositories/datasource.repo.ts` (null-DSN skip for mock-only rows — same
  # sink, no new one). The count is over both files and the helper is named.
  n=$(grep -c 'decrypt(' "$SECSVC")
  m=$(grep -c 'decrypt(' "$ROOT/packages/server/src/repositories/datasource.repo.ts")
  if [ "$n" -eq 2 ] && [ "$m" -eq 1 ] && grep -q 'decryptDsnIfPresent' "$ROOT/packages/server/src/repositories/datasource.repo.ts"; then
    pass "a secret value is decrypted 3× " "resolve-for-execution / -generation only (2 + helper)"
  else
    fail "a secret value is decrypted 3× " "found $n + $m decrypt call sites (want 2 + 1) — a value has a new way out"
  fi
  # `?reveal=` by name, in either file, outside comments. Both files DISCUSS it
  # in their docblocks explaining why it does not exist.
  if grep -vE '^\s*(//|\*|/\*)' "$SECSVC" "$SECRTE" | grep -qE 'reveal'; then
    fail "no ?reveal= escape hatch" "reveal appears in real code"
  else
    pass "no ?reveal= escape hatch" "named only in the comments explaining its absence"
  fi
  # The impact route is a GET that answers with names and booleans. If it ever
  # learns to return the thing it is describing, this goes red.
  if grep -q 'valueEnc' "$SECRTE"; then
    fail "the routes file holds no ciphertext" "workspace-secrets.ts references valueEnc"
  else
    pass "the routes file holds no ciphertext" "presence only"
  fi
fi
# The browser half. `CredentialModal` writes kind, name, label and a REPLACEMENT
# value; there is no field, state or prop carrying a stored one, because there is
# nothing to put in it (its Show toggle displays only what the person typed).
absent_code_in "the editor reads no stored value" '(reveal|currentValue|s\.value\b)' "components/keys"
# ⚠ A ref rename is a breaking change that presents as nothing — no suspension,
# no fingerprint move, no manifest change, and a 401 inside a run hours later.
# D-01 (Phase 5) rekeyed the surface: the seam's upsert is BY NAME, so a changed
# ref creates a NEW credential while the old ref keeps its value — there is no
# id-keyed impact route to ask, and the modal states the consequence statically
# instead. Pin the caveat, not the old call.
present_code_in "the modal states what a ref rename breaks" 'Renaming a ref breaks flows' "components/keys"
# ⚠ The flag is SENT from one place. The server refuses an orphaning rename
# without it, so a second call site hardcoding `true` turns that refusal off from
# the outside — and a flag that exists and never refuses reads exactly like one
# that works (I-38's shape).
#
# ⚠ The first version of this check counted every file NAMING `confirmOrphans`
# and went red at 4: `lib/api.ts` and `lib/foundry-client.ts` DECLARE the
# optional field, which they must before anyone can pass it, and `SecretEditor`
# explains in a comment why the refusal is the server's. That is I-62 exactly —
# a guard with three false positives and no real one gets widened, and the
# widening people reach for permits the defect. State what is forbidden (writing
# the literal), not a pattern that resembles it.
n=$(grep -rn 'confirmOrphans: *true' "$SRC" --include=\*.ts --include=\*.tsx 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | grep -v '\.test\.ts:' | wc -l | tr -d ' ')
if [ "$n" -eq 1 ]; then
  pass "confirmOrphans is sent from one place" "lib/secret-edit.ts, and only when acknowledged"
else
  fail "confirmOrphans is sent from one place" "$n call sites — the server's refusal can be bypassed from a second one"
fi
# ⚠ I-97. `audit.missing` is `{envName, neededBy}[]` and was typed `string[]`, so
# `/keys` rendered it with `.join(", ")` — the banner counted correctly and then
# printed "[object Object]" where the names belonged. The typecheck could not see
# it: `.join` is defined on every array. Same defect as I-92, in a second place.
#
# ⚠ **SCOPED to `/keys` in platform-coherence Phase 4, and it was tree-wide.** It
# went red on `InputValuesPanel`, whose own `missing` is a `string[]` of input
# ids and joins perfectly well — a TRUE match on the wrong subject, which is
# I-98's shape exactly. The two available responses were to rename a correct
# variable somewhere else in the product, or to say which `missing` this is
# about. The second is the one that keeps meaning what it says: this assertion
# is about `SecretAudit.missing`, and nothing else was ever in its remit.
absent_code_in "the missing-secrets list is not joined" 'missing\.join\(' "app/(app)/keys"
# ⚠ D-110. However closely this mirrors the named-query impact (D-84), the
# consequence is different in kind: an edited query moves a ref fingerprint and
# the sweep unarms the flows using it, so they STOP. A renamed secret moves no
# fingerprint — every armed automation stays armed, keeps running, and signs in
# with nothing. A `willSuspendFlows` here would promise a stop that never comes.
absent_code_in "the rename promises no suspension" 'willSuspendFlows' "components/keys"

echo
echo "Refinement is an edit, and a refusal is still not retryable"
# ── ⚠ ui-upgrade Phase 10 (D-112) ───────────────────────────────────────────
#
# §6.7 and D-38: **a refusal ends the loop immediately and is never retried.**
# Re-asking is precisely how a correct `insufficient_contract` becomes an
# invented `period="2023-10"` on attempt two — the measured failure this whole
# migration exists to fix, where a generated script emailed 0 of 11 people and
# exited 0 with `tests_passed=true` and audit `clean`.
#
# A "refine" box is the most natural place in the product for that rule to be
# quietly undone: type the goal again, slightly differently, and it is a retry
# with a friendlier label. These assertions are what stop the box moving.
#
# ⚠ RETIRED (D-333): `refineFlow` and `RefinePanel` went with the refine route.
# The rule they pinned — a refine is an INSTRUCTION, never a goal, because a goal
# parameter is the retry channel — is now the chat builder's: its edits are
# additive and a refusal is never re-asked. Pinned as an absence so a refine box
# cannot come back without that argument being made again.
absent_code_in "no refine box, anywhere" 'refineFlow|RefinePanel' "."
# ⚠ D-38's other half, unchanged since Phase 7: the refusal screen's
# "design it again" is disabled until the goal actually changes, and there is no
# Retry button anywhere on it.
absent_code_in "no Retry on the refusal arm" '>\s*Retry\s*<' "app/(app)/flows/new"
# ⚠ RETIRED (D-333): the failure screen and the findings normaliser. Both read a
# generation job's result, and there are no jobs. I-100's rule — a `failed`
# draft is not a refusal — now belongs to the builder's conversation.

echo
echo "The demo outbox is gone, and the EVIDENCE it held is not"
# ── ⚠ platform-coherence Phase 7 · I-110 ────────────────────────────────────
#
# `/outbox` had four tabs. Email, Chat and Tickets were the demo stub services
# and went with the page — a screen showing them is a screen showing the demo
# rather than the product.
#
# ⚠ **The fourth was not a demo service.** "Tool activity" reads `api_call_log`,
# which `CLAUDE.md` names as the evidence surface: *"which tools an automation
# actually called … never by SQL"*. It is the answer to **"the run went green,
# but did it do anything?"** — the question this product exists to answer, and
# the one a script that emailed 0 of 11 people and reported `clean` got wrong.
# Deleting all four would have removed the only non-trust-based evidence a tool
# call happened, so it MOVED, scoped to one run.
absent_file "no demo outbox page"        "app/(app)/outbox"
present_code_in "the call log lives on the run page" 'ToolActivity' "app/(app)/runs/[id]"
# ⚠ Scoped by `run_id`, never by a time window. On an instance where harnesses
# run concurrently a timestamp correlation attributes another run's emails to
# the one on screen — a plausible answer nobody reading the page can falsify,
# which is the exact failure mode this whole product is built against.
present_code_in "run activity is scoped by run id" 'callsForRun\(runId\)' "components/flow/ToolActivity.tsx"
# The unscoped list is gone with the page. A global "every call anything made"
# beside a scoped one is an invitation to answer "did THIS run do anything?" by
# filtering a list by eye.
absent_code "no unscoped tool-call list" 'demoCalls\('

echo
echo "The builder says what a step still needs, and layout stays derived"
# ── ⚠ platform-coherence Phase 5 · I-106 ────────────────────────────────────
#
# The canvas builder was careful about what it PRODUCES — the inspector builds
# expressions rather than asking for one, so what it emits is inside D-22's
# allowlist by construction — and said almost nothing about what a step still
# needs. "no parameters set" was the ONLY thing ever said about a call's
# arguments, so a tool with three required parameters and one mapped read as
# finished.
#
# ⚠ The check that matters is the one about BLOCKING. `missingParams` matches a
# parameter name against the expression, which is exact for anything the form
# wrote and cannot see a name built by concatenation in D-50's raw escape hatch.
# A guard with false positives gets widened, and the widening is what permits the
# defect (I-62) — so it must stay a warning.
# ⚠ Also repointed by D-121's move — `missingParams` now lives in
# `@foundry/flow-edit`. This one would have failed loudly rather than passing
# vacuously, which is the difference between the two halves of that move.
present_code_at "the missing-parameter finding is a warning" 'blocking: false' \
  "packages/flow-edit/src/index.ts"
# One computation, several renderings — the node's count, the list under the
# canvas, the inspector's own block, and the review page's inspector. Several
# OPINIONS is what this forbids.
#
# ⚠ The single caller is `lib/local-findings.ts` (`useLocalFindings`), NOT
# `FlowBuilder`. It moved there when this assertion fired for real: `FlowReview`
# had grown its own identical call plus its own copy of the `requiredParams` map,
# so the builder and the review page could describe the same flow differently
# with nothing to report it. The message below used to name `FlowBuilder` and is
# corrected rather than left, because a passing check that names the wrong file
# sends the next reader to the wrong place.
n=$(grep -rn 'localFindings(' "$SRC" --include=\*.ts --include=\*.tsx 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | grep -v '\.test\.ts' \
  | grep -v 'export function localFindings' | cut -d: -f1 | sort -u | wc -l | tr -d ' ')
# ⚠ D-51, REVERSED by plan decision ② (2026-08-12, D-150/D-151): full free
# positioning, persisted OUTSIDE the revision. The reversal is still narrow —
# `nodesDraggable` is NEVER a literal `true`: it is gated on the surface owning
# arrangement (`onMoveStep` present ⇒ the page persists or session-keeps the
# result). A read-only surface (run page) passes positions WITHOUT the handler,
# so the same arrangement renders with the cards pinned. That gate is the whole
# safety of the reversal; a hardcoded `true` would hand every surface drag.
present_code_in "dragging is gated on the move handler" 'nodesDraggable=\{\!\!onMoveStep\}' "components/flow/FlowCanvas.tsx"
if grep -q 'nodesDraggable={true}' "$SRC/components/flow/FlowCanvas.tsx"; then
  fail "nodesDraggable is never a literal true" "hardcoded true would hand every surface drag"
fi

echo
echo "Nothing writes a value nobody supplied"
# ── ⚠ platform-coherence Phase 4.5 · I-107 ──────────────────────────────────
#
# **A value comes from the person, from a step's output, or it does not exist.**
# Never from a model's judgement about what would be reasonable. The measured
# failure behind that sentence is a generated script that hardcoded
# `period="2023-10"`, emailed 0 of 11 people, and exited 0 with
# `tests_passed=true` and audit `clean`.
#
# Before Phase 4 a drafted `defaults` went into the model and out into the
# compiled YAML, so a scheduled run used the model's guess for ever — and nothing
# downstream could tell that from a value the goal actually stated. Defaults are
# now stripped server-side and arrive as SUGGESTIONS.
#
# ⚠ Both assertions here are about ABSENCES, which is why they are checks: the
# defect is something NOT happening, and a screenshot of a working form proves
# nothing about it.


INPSVC="$ROOT/packages/server/src/services/flow-inputs.ts"
if [ -f "$INPSVC" ]; then
  # The schema's own field list. `goal` is DISCUSSED at length in the docblock
  # explaining why it is absent, so comments are excluded — the file has to be
  # able to say why (I-62).
  if grep -vE '^\s*(//|\*|/\*)' "$INPSVC" | grep -qE '\bgoal\b|\binstruction\b'; then
    fail "the confirm schema has no goal" "flow-inputs.ts names one in real code — that is the retry channel"
  else
    pass "the confirm schema has no goal" "named only in the comments explaining its absence"
  fi
fi

echo
echo "Scoping an automation narrows a PROMPT, and refuses nothing"
# ⚠ RETIRED (D-333): I-111's attribution ("The designer said…") was on the
# drafter's refusal screen, which is deleted with the drafter.
# ⚠ The rule with the easy wrong answer: nothing ticked must OMIT the field, not
# send `{}` or `{datasourceIds: []}`. The server refuses the first and would
# narrow the catalogue to nothing on the second — so "design against everything"
# would become a 400 or "design against nothing". One implementation, tested.
# ⚠ The declaration lines (`datasourceIds?:`) are excluded, not the name. Both
# `lib/foundry-client.ts` and `lib/flow-scope.ts`'s own return type MUST declare
# the field before anyone can pass one — flagging that is I-62's false positive,
# and a guard that cries wolf gets widened until it permits the defect.
# ⚠ The name-count proxy counted a READER: `flows/new` reads
# `result?.selection` to render chips, which names the field without building
# a body. The one builder is `selectionFor` in `lib/flow-scope.ts`, so the
# check counts builders of it — definitions, not mentions. A second
# implementation is how the canvas and chat come to disagree about what a
# stored flow IS, and the disagreement is invisible.
n=$(grep -rn --include=\*.ts --include=\*.tsx -E 'function selectionFor' "$SRC" 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | grep -v '\.test\.ts' | wc -l | tr -d ' ')
# The server half. ⚠ Stated as what is FORBIDDEN (I-62): the selection module
# must never name a ref validator. A pattern resembling one would flag the
# comments that explain why it does not.
SELSVC="$ROOT/packages/server/src/services/flow-selection.ts"
if [ -f "$SELSVC" ]; then
  if grep -vE '^\s*(//|\*|/\*)' "$SELSVC" | grep -qE 'unknownRefs|checkFlowRefs|validateModel'; then
    fail "the selection refuses no refs" "flow-selection.ts calls a ref validator — that is the second path"
  else
    pass "the selection refuses no refs" "named only in the comments explaining why"
  fi
fi

echo
echo "A column carries a fact or it does not exist"
# ── ⚠ platform-coherence Phase 2.3 · I-104 — LANDED in Phase 7 ──────────────
#
# `/tools` had a "Used by" column that was a hardcoded "—" on every row in every
# workspace — `toolFromFA` wrote the dash and there was no server-side ref count
# to write anything else. A header promising information nobody was going to get.
#
# It is an assertion rather than a comment because a comment already lost this
# argument once. `Tool.usedBy`'s docblock said *"the page no longer renders it"*
# — true of the card view, and false from the moment the table was restored on
# 2026-08-05, with nobody noticing for two days.
#
# **Phase 7 makes the count real**: the server computes `tool.usedBy` (distinct
# flows referencing the tool, from `flow_steps.manifest_refs_json`) and the
# client renders it. The guard's principle NEVER was "no `usedBy` identifier"
# anywhere — it is **no column whose only content is a hardcoded dash** — so
# the pin FLIPS from absence to presence, the same principled flip the Phase 5
# worker made to the rename-caveat guard when the surface it forbade came back
# rekeyed (D-01). Rendering real data is the state the absence pin existed to
# protect, so the absence pin's job is done and keeping it would forbid the
# feature it was written to wait for.
#
# What is now forbidden is the PLACEHOLDER returning, and the two pins name the
# two ways it could. The first pins the page to the real `usedBy` field — a
# revert to `toolFromFA`'s constant dash, or a column that stops reading the
# server count, fails it. The second pins that the "—" a zero-count row shows
# is a RENDERING of a genuine zero, guarded by the count itself — a hardcoded
# dash beside a real number fails it. The rendering half lives in
# `page.test.tsx`, which asserts the column, the real count and the
# data-derived dash reach the DOM.
#
# ⚠ Scoped to `page.tsx`, NOT the directory, for the same reason the absence
# pin was: `page.test.tsx` builds a `Tool` fixture that must set the REQUIRED
# `usedBy` field, so a directory-wide present pin would pass on the fixture
# alone — exactly the I-62 shape where a guard that cries wolf gets widened and
# the widening permits the defect. What is being pinned is the PAGE reading the
# count, so the grep names the page.
present_code_in "used by counts come from the server" 'usedBy' "app/(app)/tools/page.tsx"
present_code_in "a dash is a rendering of a genuine zero" 'usedBy > 0' "app/(app)/tools/page.tsx"

# ── ⚠ tool-probe T14 — the Test panel states what the SERVER measured ────────
#
# The panel's whole value is that a person can believe it, and its most dangerous
# possible output is the word "Working" — because the default probe of a mutating
# tool is `reachability`, which means the host answered a `HEAD` and **the tool's
# own call was never made**. "Working" over that verdict is the false green this
# feature exists to remove, and it is the phrasing a well-meaning edit reaches for.
#
# Three pins, each naming a different way the panel could start inventing:
#
#   1. no literal verdict word in the page — the words live in `lib/tool-probe.ts`,
#      where they are asserted (`tool-probe.test.ts` checks all ten verdicts and
#      that none of them says "working");
#   2. the page renders `probeCopy(...)` — so a hand-rolled tone/title beside it is
#      visible as a second opinion;
#   3. the un-sent-method caveat is on screen, keyed off the server's `invoked`
#      field rather than off anything the page decides.
#
# ⚠ These are `page.tsx`-scoped, not directory-scoped, for the same reason the
# `usedBy` pins are: `page.test.tsx` legitimately builds probe fixtures containing
# verdict words, and a directory-wide pin would pass on the fixture alone (I-62).
absent_code_in  "the tool page invents no probe verdict" '"(Working|Healthy|All good|Tool works)"' "app/(app)/tools/page.tsx"
present_code_in "probe words come from the shared copy module" 'probeCopy\(' "app/(app)/tools/page.tsx"
present_code_in "the un-sent method is stated from the server's field" 'probe\.invoked' "app/(app)/tools/page.tsx"

# ── P2: the live send is confirmed, and the confirmation's words are shared ──
#
# A live probe of a mutating tool sends a real `POST` to somebody else's system.
# Two pins:
#
#   4. the confirmation's sentence comes from `liveConfirmBody(...)`, where
#      `tool-probe.test.ts` asserts it names the method, the host and the
#      parameter KEYS and promises nothing about what the endpoint will do. A
#      sentence assembled inline in JSX is the one that acquires "this is safe".
#   5. the escalation button opens the confirmation rather than dialling — the
#      handler is `setConfirmLive(`, so a straight `runProbe("live")` on that
#      button is visible here as well as red in `page.test.tsx`.
present_code_in "the live-probe confirmation's words are shared, not inline" 'liveConfirmBody\(' "app/(app)/tools/page.tsx"
present_code_in "the real-send button asks before it dials" 'setConfirmLive\(true\)' "app/(app)/tools/page.tsx"

# ── P3: an absent tested-marker renders NOTHING ─────────────────────────────
#
# The marker is in-process by design (no schema), so it is genuinely absent after
# a restart and absent on the other container. Two pins:
#
#   6. no invented tested-state word in the page — "never tested" / "untested" /
#      "unknown" would each turn a real absence into a claim, and a column of
#      mostly-absent health words is the deleted "Used by" mistake with a tick on
#      it (I-104);
#   7. the line itself comes from `markLine(...)`, where `tool-probe.test.ts`
#      asserts every word — including the `endpoint not invoked` clause that stops
#      "tested · host reachable" being read weeks later as "it works".
absent_code_in  "the row invents no tested state" '"(never tested|not tested|Untested|Unknown|unknown)"' "app/(app)/tools/page.tsx"
present_code_in "the tested line comes from the shared copy module" 'markLine\(' "app/(app)/tools/page.tsx"

echo
echo "There is ONE answer to \"which workspace am I in\""
# ── ⚠ platform-coherence Phase 1.5 · I-103 · D-113 ──────────────────────────
#
# The client used to hold TWO implementations of workspace identity that did not
# know about each other:
#
#   • `lib/workspace.tsx`'s `activeWorkspaceId()` read localStorage, which the
#     topbar switcher wrote — with ZERO consumers outside its own file, while its
#     header claimed it scoped "every list/create call";
#   • `resolveWorkspaceId()` read `/api/foundry-config` and cached the answer in
#     a module-level `_wsId` that was never invalidated — with **58** call sites.
#
# So the switcher was a control that appeared to work. `app/(app)/layout.tsx`
# keys `<main>` on the switched id, so picking a workspace visibly remounted the
# page and refetched, and every refetch resolved to the workspace pinned at load.
#
# ⚠ And it was not a display bug. `createTool`, `registerDatasource`,
# `createSecret` and 53 others resolve the same way, so a tool added after a
# switch landed in the workspace switched AWAY from, with the topbar naming the
# other one throughout. Silent data misplacement.
#
# These are counting assertions on purpose — the `TETHER_API_KEY`-in-three-files
# shape. A second reader of either seam would work perfectly and report nothing,
# which is exactly how this survived review for two programmes.

# 1. The storage key is named in one file, and that file resolves nothing.
n=$(grep -rl 'foundry\.workspace' "$SRC" --include=\*.ts --include=\*.tsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -eq 1 ]; then
  pass "the workspace key has one reader" "lib/workspace-choice.ts"
else
  fail "the workspace key has one reader" "$n files name foundry.workspace — a second opinion about identity"
fi

# 2. The cache has one writer. ⚠ ASSIGNMENT, not mention: `workspace-choice.ts`
# and the test both DISCUSS `_wsId` in comments explaining what it did, and a
# check that forbade naming it would force those explanations out (I-62's shape).
n=$(grep -rlE '^[^/*]*_wsId\s*=' "$SRC" --include=\*.ts --include=\*.tsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -eq 1 ]; then
  pass "the resolved id has one writer" "lib/foundry-client.ts"
else
  fail "the resolved id has one writer" "$n files assign _wsId — the cache can be repointed from elsewhere"
fi

# 3. The losing resolver is gone rather than rewired. Two functions answering the
# same question is the defect; keeping the unused one is how a third consumer
# finds it. Named freely in the comments that explain its removal.
absent_code "the second resolver is gone" 'activeWorkspaceId'

# 4. The survivor actually consults the person's choice. Without this the check
# above passes against a resolver that ignores the switcher entirely — which is
# the pre-Phase-1 state with one fewer function in it.
present_code_in "the resolver reads the choice" 'storedWorkspaceChoice' "lib/foundry-client.ts"

# 5. ⚠ The half most likely to be missed. Teaching the resolver to read the
# stored choice fixes a FRESH LOAD and changes nothing about a switch made inside
# a live page, because `_wsId` is assigned once for the life of that page. A test
# that reloads between the two calls passes without this.
present_code_in "a switch repoints the cache now" 'adoptWorkspaceId' "lib/workspace.tsx"

echo
echo "The alpha stage is a disclosure, not a word in a name"
# 1. The name stopped carrying it. `Foundry-Alpha-v1` put the product's maturity
# in the one piece of text that follows it into screenshots and links, where it
# cannot be clicked and says nothing about WHICH parts are alpha.
absent_code "the product name has no stage in it" 'Foundry-Alpha'
# 2. The per-page banner is retired by product decision (beta-1.0.6): the stage
# lives ONLY in the sidebar chip. A remounted banner must fail loudly here
# rather than drift back one import at a time.
absent_code "no per-page banner mount" '<AlphaNotice'
# 3. ONE instance of the stage mark (D-86). The chip is a static word: if it
# ever grows its own "what is real here" copy there are two answers to one
# question on one screen, and they drift within a week.
present_code_in "the sidebar carries the Beta stage" '^ *Beta *$' \
  "components/shell/AlphaChip.tsx"
absent_code_in "the chip holds no copy of the notice" 'AlphaEntry|entry\.(real|notYet|soon)' \
  "components/shell/AlphaChip.tsx"

echo
echo "Background work announces itself, and silence is not evidence of quiet"
# 1. ONE poller. A second one would raise the same notification twice and there
# would be no single answer to "what is running".
# ⚠ The DEFINING module is excluded by name, not by a cleverer pattern. What is
# forbidden is a second CALLER, and `lib/work-items.ts` necessarily contains the
# string because it exports the function — I-62's rule: state what is forbidden,
# not a pattern that resembles it.
n=$(grep -rl 'diffWork(' "$SRC" --include=\*.ts --include=\*.tsx 2>/dev/null \
  | grep -vE '\.test\.tsx?$' | grep -v 'lib/work-items.ts' | wc -l | tr -d ' ')
if [ "$n" -eq 1 ]; then
  pass "one activity poller" "lib/activity.tsx"
else
  fail "one activity poller" "$n files diff work items — notifications would double"
fi
# 2. ⚠ The rule the whole surface depends on: the first look announces nothing.
# Without the `null` baseline, opening the app pops a toast for every run of the
# last hour and nobody reads any of them after the tenth time.
# ⚠ The pattern names the RETURN, not the condition. `prev === null` alone
# passed a perturbation that kept the test and changed the body to
# `prev = new Map()` — which announces everything on the first look, the exact
# defect. A guard that matches the shape of a check rather than its effect is
# a guard that cannot fail (I-38).
present_code_in "the first poll raises nothing" 'prev === null\) return \[\]' "lib/work-items.ts"
present_code_in "the baseline starts unset" 'useRef<Map<string, WorkItem> \| null>\(null\)' "lib/activity.tsx"
# 3. A failed poll is SHOWN. A notification area that goes quiet because it
# cannot reach the server looks exactly like one with nothing to say — the
# faFallback shape on the surface whose whole job is to say when something
# happened.
present_code_in "a failed check is reported"  'error' "components/shell/NotificationBell.tsx"
present_code_in "the check time is shown"     'checkedAt' "components/shell/NotificationBell.tsx"
# 4. ⚠ A refusal is never called a failure, and never offered a retry — §6.7 and
# D-38, arriving on a new surface. Re-asking is how a correct
# `insufficient_contract` becomes an invented value on attempt two.
absent_code_in "no retry is offered for a refusal" 'try again|Try again|retry' "lib/work-items.ts"

echo
echo "A page refetches on a transition, not on a timer"
# The epoch changes only when the set of in-flight work changes. A counter that
# moved per poll would turn one shell request into every open page refetching
# every few seconds — load nobody chose and nothing on screen would explain.
present_code_in "the epoch is derived from what is in flight" 'inFlightSignature' "lib/activity.tsx"
# ⚠ The pattern requires `epoch` IN A DEPENDENCY ARRAY, not merely imported.
# `useActivityEpoch` alone passed a perturbation that deleted the call and left
# the import — the page stops updating and the check stays green.
for p in flows history approvals triggers dashboard; do
  # `epoch` anywhere in the deps list: /history reads `[epoch, auto, when, query]`.
  present_code_in "  /$p updates itself" '\[([^]]*, )?epoch(, [^]]*)?\]' "app/(app)/$p/page.tsx"
done

echo
echo "An automation is not started by existing"

echo
echo "A plugin is not a capability an automation has"
# 1. The display rules are pure, so they are testable without a browser. (Was `pluginGroups` on the Kestra page —
# REPLACED 2026-10-27 with the connector rules' module; the property is the same.)
present_code_in "the plugin grouping is a pure module" 'from "@/lib/connector-ui"' "app/(app)/apps/page.tsx"
# 2. ⚠ Every installed card says what is switched on HERE — "installed" alone reads as "my automations can use it".
present_code_in "a card states what is reachable" 'workspaceState\(' "app/(app)/apps/page.tsx"
# 3. ⚠ The credentials panel says nothing reads them yet. A form is the strongest
# possible claim that filling it in makes something work; `usableToday` is what
# stops that claim being made, and dropping it leaves the appearance behind.
present_code_in "the credentials panel states its own reach" 'usableToday' \
  "components/ops/PluginCredentials.tsx"
# ⚠ And how each field was ESTABLISHED. `$group: "connection"` is the plugin
# author's own classification and Slack uses it; AWS uses it for nothing, so its
# `accessKeyId`/`secretKeyId` are matched by NAME. Measured — the first version
# filtered on the group alone and reported that AWS needs nothing to sign in. A
# guess presented as the author's word is the failure mode, and a footnote does
# not fix it: the distinction is on the field.
present_code_in "a guessed field says it was guessed" 'f\.source' \
  "components/ops/PluginCredentials.tsx"
# 4. It stores nothing. An inert credential surfaces weeks later as a broken
# automation; a refusal names its reason in front of the person who chose it.
absent_code_in "the credentials panel writes nothing" 'createSecret|updateSecret|saveFlowModel' \
  "components/ops/PluginCredentials.tsx"
# ⚠ And NO sibling writes one either. The assertion above names one file, so the
# obvious way to satisfy a request for a credential box is to put the write in
# the component next door — at which point the guard is still green and the
# credential is still read by nothing. That is I-62's shape: a control that
# cannot fail is worse than none. Scoped to the panels, not to the whole client,
# because `/keys` is exactly where a secret SHOULD be written.
absent_code_in "no plugin panel writes a credential" 'createSecret|updateSecret' \
  "components/ops"
# 5. The setup story names the step nobody here can do. Two of the three steps
# are real today (get the credential, store it as a workspace secret); the third
# is blocked until a capability is emittable. A panel that showed all three
# alike would read as a procedure you can finish, which is the form's claim
# arriving by another route.
present_code_in "the setup panel marks its blocked step" 'setupSteps' \
  "components/ops/PluginCredentials.tsx"
present_code_in "and blockage is decided by what the engine can emit" 'usableToday' \
  "lib/plugin-setup.ts"

echo
echo "A selection prioritises; it never hides"

echo
echo "Two AI providers, and the page must not read as one"
# ⚠ F2. The page said "the language model behind the llm_complete tool" and was
# the only AI settings screen — so a model changed there had no effect on
# generation and nothing said so. Measured at the wire: the ops row read
# `gpt-5.4-mini` while flow generation ran the environment's model.
#
# 1. The generation panel exists at all.
# ⚠ The JSX USE, not the import — proven by perturbation: deleting the element
# and keeping the import satisfied the first version of this. Same flaw as the
# `useActivityEpoch` guard that passed on an import line alone.
present_code_in "the designing model is configurable" '<GenerationModelPanel' \
  "app/(app)/ai-provider/page.tsx"
# 2. ⚠ And the page no longer describes itself as the one provider. Adding the
# second panel without correcting this sentence leaves the same trap with one
# more place to fall into it (I-95: copy accurate about one path, over another).
absent_code_in "the page does not claim to be one provider" \
  'purpose="The language model behind the llm_complete tool' "app/(app)/ai-provider/page.tsx"
# 3. ⚠ The endpoint is READ-ONLY here and the two can therefore drift. That
# sentence is the whole cost of not giving generation its own URL — it is paid
# in copy, so it has to be present.
# ⚠ 2026-10-12: the sentence moved from the builder panel to the page's notices, above BOTH models.
present_code_in "a drifted gateway is named on screen" 'different gateways' \
  "app/(app)/ai-provider/page.tsx"
# 4. No key box, ever. There is deliberately no endpoint that returns a secret
# value and no `?reveal=`; a settings page is where that rule gets broken.
absent_code_in "the generation panel takes no credential" 'apiKey|type="password"' \
  "components/ops/GenerationModelPanel.tsx"
# 5. ⚠ A model list is not evidence — the documented `llmConnected: true` false
# green is a probe that "verifies" an LLM by listing models. The caveat comes
# with the payload and must be rendered rather than paraphrased.
# ⚠ That it is STORED and RENDERED, not merely named. The first version matched
# `const [caveat]`, so a version that fetched the models and dropped the caveat
# on the floor passed — and the caveat is the whole point, since a model list is
# the same false green as `llmConnected: true`.
present_code_in "listing models is not called evidence" 'setCaveat\(r\.caveat\)' \
  "components/ops/GenerationModelPanel.tsx"

echo
echo "A generation you walk away from is findable again — RETIRED"
# ⚠ F5 is RETIRED with the generation job (D-333). The job row had an address
# (`?job=`), the page read it back, and `/flows` listed unfinished designs. The
# builder saves as it goes — an unfinished flow is a working copy on a flow that
# exists — so there is no job to lose. Pinned as ABSENCES: a `?job=` address or a
# job list would point at routes that no longer exist.
absent_code_in "no generation-job address on /flows/new" 'searchParams\.get\("job"\)' "app/(app)/flows/new/page.tsx"
absent_code_in "no generation-job list anywhere" 'listFlowGenerationJobs|getFlowGenerationJob|startFlowGeneration' "."

echo
echo "The D-15..D-24 bold sweep pins its own contract"
# The mock round (docs/ui-mock/DECISIONS.md D-15..D-24) froze the new baseline:
# skeletons + closure empty states, the dashboard run-volume pane, the flow-detail
# editor rail, run-strip timing, the rail-free data-source wizard, collapsible
# inspectors, and honest trigger cards. These pins lock the CONTRACT items that
# would otherwise regress silently — the copy is the mock's, and the absences are
# the fictions the round removed.

# ── Cross-page patterns (D-16) ─────────────────────────────────────────────
present_code_in "a skeleton primitive exists" 'skel-bar' \
  "components/ui/Skeleton.tsx"
# ⚠ THE WORD MOVED WITH THE PAGE, AND THE ASSERTION DID NOT. `/flows` was
# rebuilt to the design pack's `S-28` on 2026-09-01, and `mapping.md`'s UX-001 is
# that the UI speaks the PACK's vocabulary — `Workflow` is the pack's word for
# Foundry's `flows`. So the pinned copy is now "No workflows match your search."
#
# The CONTROL is unchanged: this page's filtered-empty state must still say why
# the list is empty rather than rendering as an empty workspace. What changed is
# one noun, and it changed here in the same commit as the page — a pin and the
# copy it guards edited in two commits is a red check somebody deletes.
#
# ⚠ The other two pins on this page did NOT move and must not: the page still
# calls `listFlowGenerationJobs()` and still says "Still being designed".
present_code_in "workflows search empties honestly" 'No workflows match your search\.' \
  "app/(app)/flows/page.tsx"
present_code_in "tools search empties honestly" 'No tools match your search\.' \
  "app/(app)/tools/page.tsx"
present_code_in "history search empties honestly" 'No history entries match your search\.' \
  "app/(app)/history/page.tsx"
# ⚠ RE-PINNED 2026-09-11: the literal `Nothing waiting on you` was superseded
# by per-tab empty states that say more, not less — the pin follows the copy,
# it does not hold the old sentence.
present_code_in "approvals empty says what is left" "You're all caught up\. Nothing needs your approval\." \
  "app/(app)/approvals/page.tsx"
present_code_in "data sources empty says what to do" 'No data sources connected in this workspace\.' \
  "app/(app)/data-sources/page.tsx"

# ⚠ RE-PINNED 2026-10-23: "Needs you" was removed from the dashboard (it counted failing automations and linked to
# approvals, which it did not count). The figures are "Runs and health" now, in `components/home/RunsHealth.tsx`, and
# each is a link to the runs it counts. The control is unchanged — a figure must still go somewhere.
present_code_in "the tiles are links" 'href="/history"' \
  "components/home/RunsHealth.tsx"




# ── Triggers (D-22) — the real ready word, and no invented next run ────────
present_code_in "a trigger says it ran successfully" 'Ran successfully' \
  "app/(app)/triggers/page.tsx"
absent_code_in "no invented next-run times" 'next run' \
  "app/(app)/triggers"

# ── Fictions the round removed (D-21/D-23) ─────────────────────────────────
absent_code_in "the connect wizard has no stepper" 'Stepper' \
  "app/(app)/data-sources/new"
absent_code_in "the datasource table has no tables column" '\{ key: "tables"' \
  "components/ui/DataTable.tsx"
absent_code_in "history has no actor filter" 'Filter actor' \
  "app/(app)/history"

# ── Workspace access: assignment replaced self-claiming ─────────────────────
#
# ⚠ **The claim button was this UI's single most consequential control**, and it
# sat on the state an operator saw first: a workspace with no members refuses the
# member list, and the panel offered "Claim this workspace" beside the refusal.
# Clicking it made you that workspace's admin. Assignment by a super admin
# replaced it, and the regression is somebody restoring the button as a
# convenience — so its absence is asserted here rather than only in a vitest file.
absent_code "no self-claim path in the client" 'claimWorkspace'

# The bound the people screens carry. Anything holding the identity signing secret can present any identity, so
# "verified person" is the one claim these screens may not make.
# ⚠ **REPOINTED ON 2026-10-30 (admin simplify, phase 6), NOT DROPPED.** `MembersPanel` and `BulkAssignPanel` stated
# the bound in a paragraph and both are deleted with People & access; the People screens state no caveat paragraphs
# by rule. So the claim is now asserted as an ABSENCE on every people screen — none says somebody is verified — and
# the third state as a presence: an unreadable list says it could not be loaded, never "nobody".
absent_code_in "no people screen calls somebody verified" \
  '[Vv]erified (person|people|user|identity|account)' "app/(app)/admin/people"
absent_code_in "and neither does Add person" \
  '[Vv]erified (person|people|user|identity|account)' "components/people"
present_code_in "an unreadable people list says it could not be loaded" \
  'Could not load people' "app/(app)/admin/people/page.tsx"

# ⚠ The client must not decide super-admin-ness locally. `src/auth.ts` already
# puts ["superadmin","admin"] in the browser session from a local password check,
# while the server decides from SUPER_ADMIN_EMAILS in its own environment —
# reading the session would be a second definition that can disagree with the
# only one that refuses anything, in the worse direction (a page that renders
# over routes that all 403).
absent_code_in "the workspace page does not read roles off the session" \
  '(user\.roles|session\.user\.roles|superadmin)' "app/(app)/organization"
present_code_in "it asks the server instead" 'getMe' "app/(app)/organization/page.tsx"
present_code_in "the nav row is gated on the server's answer" \
  'superAdminOnly' "components/shell/Sidebar.tsx"

# ── T8b · RBAC: the browser decides NOTHING about access ─────────────────────
#
# ⚠ **THE BAN IS WIDENED FROM ONE PAGE TO THE WHOLE CLIENT.** The rule above was
# scoped to `app/(app)/organization` because that was the only page reading the
# session's roles. Every page can now ask the server what it may do, so every page
# could get this wrong.
#
# ⚠ `superadmin` STAYS in the pattern: the local account still puts it on the
# session (`auth.ts`), so it is exactly the string somebody would reach for.
absent_code_in "no page reads its access off the sign-in session" \
  '(session\.user\.roles|useSession\(\)\.data\?\.user\?\.roles)' "app"
absent_code_in "no component reads its access off the sign-in session" \
  '(session\.user\.roles|useSession\(\)\.data\?\.user\?\.roles)' "components"
# ⚠ A widened pattern with no control is how a check gets weakened until it permits
# the defect (I-62). This is the one legitimate reader.
present_code_in "and the ONE legitimate reader exists — the server's own answer" \
  'myPermissions' "lib/foundry-client.ts"

# ── T8c · RBAC: no SECOND authority wearing a permitted shape ────────────────
#
# ⚠ **THE SESSION-ROLES BAN ABOVE DOES NOT COVER THE REAL DEFECT, AND MUST NOT BE
# PRESENTED AS IF IT DOES.** `lib/capabilities.ts` read no session at all. It read a
# SERVER answer and then applied its OWN policy to it — a client-side `ROLE_CAPS`
# that disagreed with the server's about whether an `approver` may publish, plus
# `CAP_NAV`/`CAP_CONTROLS` claiming what each capability unlocked. That is a second
# authority in a permitted shape, and FR-031 forbids it.
# ⚠ **STATE THE FORBIDDEN THING, NOT A PATTERN THAT RESEMBLES IT** — I-62, and the
# first version of these two got it wrong in exactly the documented way. The
# docblocks in `permission-catalogue.ts`, `MembersPanel.tsx` and
# `LocalAccountAccess.tsx` EXPLAIN at length why `ROLE_CAPS`, `CAP_NAV` and
# `CAP_CONTROLS` are gone — and a bare name match flagged every one of those
# explanations. A guard that cries wolf gets widened, and the widening is what
# permits the defect. So these match a USE: an import, an index, or a call.
absent_code_in "no page carries a client-side policy table" \
  '(from "@/lib/capabilities"|ROLE_CAPS[.[]|CAP_NAV[.[]|CAP_CONTROLS[.[]|filterByCapabilities\()' "app"
absent_code_in "no component carries a client-side policy table" \
  '(from "@/lib/capabilities"|ROLE_CAPS[.[]|CAP_NAV[.[]|CAP_CONTROLS[.[]|filterByCapabilities\()' "components"
present_code_in "and the catalogue is fetched from the server instead" \
  'permissionCatalogue' "components/access/permission-catalogue.ts"

# ── T8d · RBAC: the three-state gate, and the no-access page ─────────────────
#
# ⚠ A check that could not run is NEITHER answer. `unreadable` must be a real state
# in the provider, or "we could not check" renders as "you may not" — the
# `PromptBoundaryWarnings` rule, the `/organization` fourth state, and the deleted
# `faFallback`, all the same mistake.
present_code_in "the permission gate has a third state" 'unreadable' "lib/permissions.tsx"
present_code_in "and the components render it" 'unreadable' "components/access/PermissionGate.tsx"
present_code_in "a refused person is given a next step, not a dead end" \
  'SUPER_ADMIN_EMAILS' "lib/permission-copy.ts"
present_code_in "and there is a page to land on" \
  'could not check your access' "app/(app)/no-access/page.tsx"
















echo
if [ "$fails" -eq 0 ]; then
  echo "the UI shows server state or an error — nothing in between"
  exit 0
fi
echo "$fails check(s) failed"
exit 1
