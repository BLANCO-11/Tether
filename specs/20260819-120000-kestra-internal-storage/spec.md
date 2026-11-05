# Feature Specification: large step payloads travel by reference, not through the execution record

**Feature Branch**: `20260819-120000-kestra-internal-storage` (not started)

**Created**: 2026-08-19

**Status**: **STUB — recorded, not planned.** Written so the mechanism is not re-rejected from the false
premise that produced the first rejection. Do not start this without reading "Scope questions" below.

**Input**: Raised while reviewing `specs/20260819-045902-step-payload-bounds` — *"Kestra has an internal
storage 'built-in bucket' mechanism to handle large amounts of data from APIs. Can we use it?"*

---

## The answer that made this a spec

**Yes, the mechanism is real and in-architecture.** Measured against the running engine
(`GET {KESTRA_BASE_URL}/api/v1/plugins/io.kestra.plugin.scripts.python.Script` — ⚠ note the path is **not**
under `/main`, see I-150):

* `inputFiles` — *"Each file can be defined: Inline with its content; **As a URI, supported schemes are
  `kestra` for internal storage files**, `file` for host local files, and `nsfile` for namespace files."*
* `outputFiles` — *"Declares files produced by the script that should be uploaded to Kestra's internal
  storage."*

Kestra **stages** the file into the container it is already starting. Nothing is fetched over a network, so
this composes with `networkMode: none` without tension.

⚠ **Two prior arguments must not be re-used against it, because both are about something else.**

* *"A fragment has no network, so it cannot read a bucket."* True of network fetches, irrelevant to
  staging. This was the reasoning in the first rejection and it was wrong.
* *"I-128 — internal-storage URIs are unreadable by the product."* I-128 is about URIs surfacing in step
  **outputs** that Foundry's read surface must render (an R5/R6 question). Handing a file to a container is
  not that.

And the pinned design already asks for it — `docs/kestra-migration/04-generation-model.md` §5.3.2: *"step
outputs above a threshold (start at ~1 MB) are written to Kestra's internal storage and passed by
reference, not inline."* **D-20** declined it for a `code` step's **output** channel only, on the "pick one
and never mix" rule. That says nothing about inputs.

---

## What it would actually buy

### 1. The execution record stops carrying the payload (the real problem)

Measured on execution `05aca859-…`: the `fetch` taskrun's output is **8,403,023 B**, persisted in
**Kestra's database** — *"task outputs travel through the execution context, which is persisted in Kestra's
database"* ([flow-compiler.service.ts:1069-1074](../../packages/server/src/services/flow-compiler.service.ts#L1069)) —
and re-served on every graph read of that run for the 30 days before retention purges it. `step-payload-bounds`
does **not** fix this: it bounds what a step may POST to Foundry, and this payload never went near that hop.

### 2. `code` → `code` chains stop round-tripping megabytes

A producing fragment's `outputFiles` and a consuming fragment's `kestra://` `inputFiles` would keep a large
intermediate out of the execution context entirely.

---

## What it does NOT buy — state this before anyone starts

* **It does not fix the 413 incident.** That hop was `llm_complete`, whose 32,000-character ceiling is a
  *semantic* limit, and whose service (ops-api) is deliberately unreachable from Kestra — `kestra:check`
  asserts the DENY at the wire. A pointer resolves to nothing there.
* **It does not remove the need to reduce.** A report over 4,722 rows is produced by a `code` step
  aggregating them and `llm_complete` narrating the aggregate (`step-payload-bounds` Decision 9). That is
  true with or without internal storage.
* **It does not currently reach the tool leg.** `io.kestra.plugin.core.http.Request` — the task **every**
  tool step compiles to — has properties `allowFailed, body, contentType, encryptBody, formData, headers,
  method, options, params, pluginDefaultsRef, sslOptions, uri` and **no `store`/`saveAs`** (measured). Only
  `http.Download` stores (`saveAs` → `uri` + `length`) and it dials a URL itself. Routing a tool response
  into internal storage therefore needs **Foundry to hold the payload and serve it for a Download**, which
  is a new store with retention, tenancy and redaction questions and cuts against R6. Tool calls cannot move
  into Kestra instead — they need tenant credentials (R2).

---

## Scope questions to answer BEFORE planning

1. **Which leg?** `code` → `code` only (cheap, no new surface, no Foundry involvement) or the `tool` leg
   too (needs the Foundry-side payload store above)? These are different features; the first is small.
2. **What does the run view show?** A step whose output is a `kestra://` URI has nothing a person can read
   and nothing `flow-expectation.service.ts` can evaluate a claim against. **`unevaluable` must not read as
   passing** — that rule already exists and this would newly exercise it.
3. **Replay.** Phase 6 replay depends on the engine's copy of upstream step outputs. A URI whose file was
   purged is a replay that fails differently — worth being explicit rather than discovered.
4. **D-20's "never mix".** If a fragment can emit *either* a marker payload *or* a file, that is the second
   output channel D-20 refused. Either widen D-20 deliberately and in writing, or make it one channel with
   a size-based rule the compiler applies — not a fragment-level choice.
5. **Does the drafter ever choose this?** Recommended answer: **no.** The compiler decides from size; a
   model choosing a transport is a model choosing a thing it cannot verify.

---

## Non-goals

* External object storage (S3/GCS/Blob) as the backend. Kestra supports it; nothing here needs it, and it
  imports a cloud credential. Local filesystem backend only unless someone states a reason.
* Any change to `llm_complete`'s 32,000-character cap. See `step-payload-bounds` FR-014.
* Removing the reduction step. See `step-payload-bounds` Decision 9.
