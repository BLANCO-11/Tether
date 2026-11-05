# Phase 0 Research — Prompt-Boundary Guardrails

All spec clarifications were resolved before planning (Q1 → option C). This
document records the design decisions the plan depends on, the alternatives that
were rejected, and the two findings about the existing code that changed the
shape of the feature.

---

## Findings about the current code

### F1 — The audit has never seen the operator's task

`generationAuditService.audit(workspaceId, code, declaredWarnings, warnings)` and
`collectFacts(workspaceId)` derive every fact from **tools and datasources only**.
No code path passes the task string into the audit.

This is why the existing findings can say *"this host is not in the manifest"*
(`invented_endpoint`) but cannot say *"and nothing you were asked to do explains
it."* US3's finding is not a new pattern match — it is a new **input**. The task
is already persisted on the script row as `description`, so it is available at
`finalizeRun` without a schema change.

Consequence for the plan: slice 5 is mostly threading, and its risk is not the
regex but the double-counting interaction described in D2.

### F2 — Two of the four untrusted sources named by the standard do not exist

Established while writing the spec, restated here because it drives FR-002:

- `schema-introspector.service.ts` stores **no comment or description field**, so
  no column or table comment can reach the manifest.
- Live tool responses reach the model inside the Tether sandbox, not through a
  prompt this repository composes. Only a dummy tool's `dummyResponseTemplate`
  reaches the manifest.

Consequence: every detector in this feature is exercised by content a real
workspace can hold. That is the point of option C — a detector for a source that
cannot produce content is a detector whose deletion breaks no test.

### F3 — The escaping that exists already gives delimiter integrity

`xmlEscape()` escapes `&`, `<`, `>`, `"`. A third party who types
`</untrusted-data>` into a tool description has it rendered as
`&lt;/untrusted-data&gt;`, which cannot close an element.

This is load-bearing for D5 and is the reason no nonce is needed. It is also
fragile in the way that matters: nothing today would fail if someone narrowed
`xmlEscape`. The delimiter-forgery test added by this feature becomes the thing
that protects it.

---

## Decisions

### R1 — Framing at prompt composition, not in the manifest XML

**Decision**: wrap the manifest blocks in the composed prompt; leave
`manifestXml` / `summaryXml` bytes and the content hash untouched.

**Rationale**: the hashed body determines the manifest version. Framing inside it
changes the hash for every existing workspace, bumping every version and forcing a
full manifest re-delivery on the next generation — real cost, zero added
protection, since the prompt is where the model reads it. It would also break
FR-021's "unchanged for benign workspaces".

**Alternatives considered**:
- *Per-field envelopes inside the manifest XML.* Most precise labelling; rejected
  for the hash change, and because it would make the manifest file itself carry
  guardrail markup that the agent must then write verbatim to disk.
- *A separate "untrusted appendix" block listing all spans, with the manifest left
  unframed.* Rejected: it duplicates the manifest in the prompt, roughly doubling
  the manifest's token cost, and leaves the original copy unlabelled — the worst
  of both.

**Known limit, carried into the plan**: content the agent re-reads from
`.foundry/manifest.xml` is outside the parent's envelope. Mitigated by declaring
the manifest untrusted **by identity** rather than by delimiter. Not fully closed;
recorded in Complexity Tracking rather than left implicit.

### R2 — New finding severity `medium`

**Decision**: `unrequested_action` is `medium`, and is **excluded** from the set
counted by the `undeclared_invention` meta-finding.

**Rationale**: `high` escalates the verdict to `fail`, and V5 intends `fail` to
block enable/schedule. Blocking an irreversible action on an intent heuristic is
exactly the asymmetry V5 is supposed to reason about carefully; making that choice
here, by a severity constant, would pre-empt it. The exclusion from
`undeclared_invention` prevents one underlying fact producing two findings and
manufacturing a `fail` indirectly.

**Alternatives considered**:
- *`high`.* Rejected per above. If experience later shows the finding is precise,
  raising it is a one-line change with a recorded reason — the reverse is not, once
  V5 has shipped gating on top of it.
- *A fourth severity below `low`.* Rejected: it changes the verdict function for
  every existing finding to solve a problem `medium` already solves (Article IV).

### R3 — Warnings derived per build, not persisted

**Decision**: `buildAndPersist` returns `warnings` on its result; nothing is
written.

**Rationale**: FR-009 wants a warning to be a standing property of the content, so
recomputation *is* the correct semantics — a stored warning would need
invalidation on every registered-field edit, which is more machinery and less
accuracy. No migration, no table, no cascade (Articles IV, XII).

**Alternatives considered**:
- *A `manifest_warnings` table.* Rejected: staleness, invalidation, and a
  workspace-cascade obligation, for no gain.
- *Log-only.* Rejected outright by FR-009 — an operator must be able to see it
  without shell access to the server.

### R4 — Deterministic patterns, standard library only

**Decision**: a small hand-written pattern set over a normalised string. No
dependency.

**Rationale**: Article IV, and more specifically Article X — a guardrail's inputs
should be inspectable. A pattern list in the repository can be read, argued with
and tested; a third-party classifier cannot. Node's `normalize("NFKC")` and
`RegExp` are sufficient.

**Alternatives considered**:
- *An off-the-shelf prompt-injection detection library.* Rejected: a new runtime
  dependency (Article IV) in the security path, most such libraries are
  model-based, and a model-based detector cannot be a gate under Article X — the
  spec already rules that out as OOS-001.
- *Heuristic scoring rather than pattern matching.* Rejected for this slice: a
  score needs a threshold, a threshold needs calibration data this project does not
  have, and an uncalibrated threshold is a false-positive generator that operators
  learn to ignore.

**Pattern families** (each shipping with a negative test, FR-013):

| Family | Catches | Negative case that must NOT fire |
|---|---|---|
| instruction override | "ignore all previous instructions", "disregard the above" | "Ignore rows where status is null" — a legitimate column description |
| role reassignment | "you are now", "system:", "assistant:" | a table named `system_prompts`, a tool named `assistant_api` |
| exfiltration directive | "send/post/email … to \<url or address\>" | "Use this endpoint to send a ticket to the queue" |
| delimiter mimicry | `<|im_start|>`, ` ```system `, "### Instruction" | markdown in a legitimate long description |
| secret-directed | "print/reveal/output … api key\|password\|token" | a column named `password_last_changed_at`, a tool named `token_refresh` |

The negative column is the deliverable, not commentary. `security.md` §5 says so
about the audit's determiner lookaheads — *"Keep the negative tests"* — and the
same failure mode applies here: a detector that fires on `execute_at` gets
narrowed by whoever is on call, and nothing records what it used to catch.

### R5 — Normalise before matching, report the raw value

**Decision**: match against NFKC-normalised text with zero-width
(`U+200B`–`U+200D`, `U+FEFF`) and bidirectional control characters removed; put
the **original** text in the warning.

**Rationale**: without normalisation, one zero-width space between two letters
evades every pattern — a trivially cheap bypass for an attacker and an invisible
one for a reviewer. Reporting the normalised value instead of the raw one would be
the mirror mistake: the operator searches their own tool registry for text that
does not appear there.

### R6 — One span collector shared by framing and detection

**Decision**: `collectUntrustedSpans(workspaceId) → UntrustedSpan[]`, consumed by
both the envelope renderer and the detector.

**Rationale**: framing and detection must agree on what is untrusted. Two lists
drift, and the drift is silent — a span added to one and not the other is either
labelled but unscanned or scanned but unlabelled, and nothing fails. It is also
what makes the deferred column-comment feature (OOS-005) a registration rather
than a rewrite, which the plan was explicitly asked to ensure.

---

## Open questions for `/speckit-tasks`

None blocking. Two to size rather than decide:

1. **Which client surface hosts the warning list.** The workspace detail view is
   the obvious home since it already reads the manifest; confirm against
   `design.md` §3 during task breakdown.
2. **The warning cap value** (FR-014). Any bounded number works; pick one, state
   it in the response when reached, and test the truncation is announced rather
   than silent.
