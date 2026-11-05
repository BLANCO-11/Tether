# Agent sandbox POC

Closed-environment proof: **linked script steps** + **code verifier** + **thin runner** + **oracle**, with **openredaction** for agent context and a **file-based clarification** channel.

No Kestra. No `@foundry/redact`. **No speckit** (explicit for this exploration).

## Layout

```text
sandbox/          # agent working directory
  SYSTEM.md       # agent instructions
  GOAL.md         # ambiguous goal (which email column?)
  context/        # openredaction-scrubbed (npm run build-context)
  fixtures/       # ground truth (oracle/runner only)
  templates/      # reusable helpers
  steps/          # script functions
  workflow.json
  questions.json / answers.json
verifier/
runner/
oracle/
golden/           # control snapshot
scripts/
RESULTS.md        # measured outcomes
```

## Quick start

```bash
cd poc/agent-sandbox
npm install
npm run build-context    # openredaction → context/
npm run control          # restore golden → verify → run → oracle
npm run loop:complex     # Pi clarify→build→fix loop (threshold routing)
```

Clarification (file channel):

```bash
node scripts/agent-stub-clarify.mjs ask   # or real Pi
node scripts/clarify.mjs answer q1=customer_email
node scripts/agent-stub-clarify.mjs apply
npm run control
```

Pi (when API key works):

```bash
# binary: /Users/himanshu/.local/node/bin/pi
bash scripts/spawn-pi.sh
# or: SKIP_PI=1 bash scripts/run-poc.sh
```

See [RESULTS.md](./RESULTS.md) for pass/fail record.

## Edits & Q&A

Snapshot → apply → verify/run/oracle → **accept** or **revert**:

```bash
# Ask about the current workflow (must not touch files)
node scripts/edit-loop.mjs --qa --request="How is the recipient chosen?"

# Surgical edit; pass oracle expected if behaviour changes
node scripts/edit-loop.mjs   --request="Change notify params.large_threshold_cents to 150000"   --expected=scenarios/edit-threshold/expected.json

# Manual snapshot / restore
node scripts/snapshot.mjs take "before-experiment"
node scripts/snapshot.mjs restore latest
node scripts/snapshot.mjs list
```

Failed edits (empty workflow, broken bindings, oracle miss) **revert** to the pre-edit snapshot automatically.
