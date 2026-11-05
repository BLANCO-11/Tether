# Workflow diagrams

**Feature**: `20260827-053157-proposed-db-operations` · **Spec**: [spec.md](./spec.md) ·
**Plan**: [plan.md](./plan.md) · **Contract**: [contracts/operation-proposal.md](./contracts/operation-proposal.md)

Eight diagrams. Each shows one mechanism the plan argues about, and each is cross-referenced to the
`FR-nnn` / `D-nnn` it draws. Colour is never the only carrier — every node says what it is.

| Fill | Meaning |
| :--- | :--- |
| `#3f3f46` grey | exists today, unchanged by this feature |
| `#1e3a5f` blue | an inference call |
| `#14532d` green | deterministic code — the half that cannot be talked into anything |
| `#7c2d12` brown | a person |
| `#4c1d95` purple | new in this feature |
| `#450a0a` red | a dead end, or an answer nobody can act on |

---

## 1. Today — the dead end

The asymmetry inside a single draft prompt: the manifest shows the tables, CALLABLE STEPS says
*"anything not listed does not exist"*, and **nothing joins those two facts**. The right-hand path is the
likely one, and it ends somewhere nobody can act on.

```mermaid
flowchart TB
    ON["person onboards billing_db"] --> INTRO["refreshSchema<br/>introspects tables + columns"]
    INTRO --> ROWS["schemas rows stored<br/>ZERO callable refs created"]

    ROWS --> MAN["MANIFEST XML<br/>renders EVERY datasource's schema"]
    ROWS --> CAT["CALLABLE STEPS<br/>built only from tools + named queries + DB operations"]

    MAN -->|"the tables ARE visible"| P["draft prompt"]
    CAT -->|"nothing readable is listed"| P

    P --> M{"drafter<br/>one inference call"}
    M -->|"correct answer"| REF["insufficient_catalogue<br/>200 · names the boundary"]
    M -->|"likely — it just read the schema"| INV["emits ref billing_db.customers"]

    INV --> UR["unknownRefs refuses<br/>'does not exist in this workspace'<br/>— misleading: the datasource DOES exist"]
    UR -->|"fed back · attempts 2 and 3"| P
    UR -->|"MAX_DRAFT_ATTEMPTS exhausted"| DEAD["FlowDraftError<br/>'could not draft a valid flow in 3 attempts'<br/>no missing list · no boundary named<br/>~90s of inference spent"]

    style MAN fill:#3f3f46,color:#fff
    style CAT fill:#3f3f46,color:#fff
    style M fill:#1e3a5f,color:#fff
    style REF fill:#14532d,color:#fff
    style INV fill:#7c2d12,color:#fff
    style UR fill:#450a0a,color:#fff
    style DEAD fill:#450a0a,color:#fff
```

---

## 2. Phase 0 — the honest refusal *(no model authors anything)*

Two edits close the dead end. **This ships alone** and is most of the reported pain.
`FR-001` is the prompt half of the I-118 pairing; `FR-002` is the check half, which already existed and
only needed to know more.

```mermaid
flowchart TB
    P["draft prompt<br/>+ FR-001 — a MANIFEST table is NOT callable.<br/>Data is readable only through a named query,<br/>a DB operation or a tool in CALLABLE STEPS"] --> M{"drafter"}

    M -->|"attempt 1"| REF["insufficient_catalogue — FR-003<br/>missing names billing_db"]
    M -->|"invents a ref anyway"| UR{"unknownRefs — FR-002<br/>which of FOUR situations?"}

    UR -->|"real ds · schema · NO readers"| S1["'billing_db IS a datasource in this workspace,<br/>with 14 introspected tables, but it has no<br/>readable components. A table is not callable —<br/>create a DB operation or a named query for it.'"]
    UR -->|"real ds · has OTHER readers"| S2["'…but it has no readable component named<br/>invoices. Its readable components are — …'<br/>a MISTYPED reader name, not a missing one"]
    UR -->|"real ds · NOTHING introspected"| S3["'…but nothing has been introspected from it.<br/>Refresh its schema, then create a DB<br/>operation or a named query.'"]
    UR -->|"names nothing at all"| S4["UNCHANGED<br/>'…which does not exist in this workspace'"]

    S1 --> FB["fed back to the redraft —<br/>which now has the words to refuse WITH"]
    S2 --> FB
    S3 --> FB
    S4 --> FB
    FB --> REF

    REF --> SCREEN["screen states the real gap<br/>on the FIRST attempt"]
    SCREEN --> OFFER["offers: propose an operation<br/>Phase 2 — NOT a Retry button"]

    style M fill:#1e3a5f,color:#fff
    style P fill:#4c1d95,color:#fff
    style UR fill:#1e3a5f,color:#fff
    style S1 fill:#4c1d95,color:#fff
    style S2 fill:#4c1d95,color:#fff
    style S3 fill:#4c1d95,color:#fff
    style S4 fill:#334155,color:#fff
    style FB fill:#4c1d95,color:#fff
    style REF fill:#14532d,color:#fff
    style SCREEN fill:#14532d,color:#fff
    style OFFER fill:#7c2d12,color:#fff
```

⚠ **`OFFER` is not a Retry.** It offers a *different action*, exactly as the `policy_transform` confirm
button does. The regenerate button's existing disabled-until-the-goal-changes rule is untouched.

⚠ **Four sentences, not two** (`D-181`, taken during P0 — this diagram showed one until then). `S2` and
`S3` are not decoration; **each one keeps `S1` honest**:

* without `S2`, a **mistyped reader name** on a datasource with three readers is told it has none — a
  fresh false sentence standing exactly where the old one stood, and worse, because a redraft can fix a
  wrong reader name and could never fix *"does not exist"*;
* without `S3`, a datasource whose schema refresh failed is sent to build an operation against a schema
  that is not there. That state is **common, not exotic**: `addDatasource` runs create → test →
  refreshSchema with the last two `.catch(() => null)`, so "onboarded with no schema" is a *successful*
  onboarding.

⚠ `S1`'s **14** is a count of **distinct entities**, never of `schemas` rows — one row per *column* would
report six tables where there are two (`D-182`).

---

## 3. Phase 1 — the proposal loop

The fragment generator's shape, one subject along: **two channels**, findings retried, refusal never
(`D-171`). The model fills in a form; `compileOperation` — deterministic, existing — is the only thing
that produces SQL.

```mermaid
sequenceDiagram
    actor Person
    participant Route as POST /operations/propose
    participant Prop as db-operation-proposal.service NEW
    participant Model
    participant Check as dbOperationService.check

    Person->>Route: need statement
    Route->>Prop: workspaceId, dsId, need
    Prop->>Prop: read schemas rows + names already taken

    loop bounded attempts
        Prop->>Model: schema + need + taken names ONLY
        Model-->>Prop: DbOperationSpec OR insufficient_schema

        alt insufficient_schema
            Note over Prop: FR-008 — loop ENDS. Never retried.
            Prop-->>Route: refusal, HTTP 200, a SUCCESS
        else a spec
            Prop->>Check: compile WITHOUT saving
            alt findings
                Check-->>Prop: code + message + identifier + available
                Note over Prop: FR-009 — fed back VERBATIM, nothing added
            else ok
                Check-->>Prop: compiledSql + paramsSchema
                Prop-->>Route: proposal
            end
        end
    end

    Route-->>Person: proposal — FR-010, NOTHING WRITTEN
```

| | Retried? | Why |
| :--- | :--- | :--- |
| `check()` finding — unknown column, invalid join | ✅ bounded | Mechanical. Names the identifier *and* what was available. |
| `insufficient_schema` | ❌ **never** | §6.7. Re-asking is how *"there is no due date"* becomes a plausible `created_at` on attempt 2. |

---

## 4. The isolation boundary — `FR-005`, asserted against the module's own source

Modelled on `buildFragmentPrompt`: **what it cannot see is the value.** `FR-006` asserts this by reading
the module's source, not its behaviour — because a behavioural test passes just as well when a field is
present and merely unused, and the next person to touch the function will use it.

```mermaid
flowchart LR
    subgraph IN["IN — the proposer's whole world"]
        S["ONE datasource's introspected schema<br/>tables · columns · types · nullability · PKs · FKs"]
        N["one need statement"]
        T["operation + query names already taken<br/>so a 409 is avoided before it happens"]
    end

    subgraph OUT["EXCLUDED — each for its own reason"]
        D1["DSN · connection string · any DB handle<br/>Article VIII, and nothing to connect FOR"]
        D2["ANY ROW OF DATA<br/>D-54 — shown rows to imitate, a proposal stops<br/>being derived from the schema"]
        D3["other datasources' schemas<br/>a spec is single-datasource by construction"]
        D4["the goal · the flow model · sibling steps<br/>a reader is a function of schema and need"]
    end

    IN --> PR["proposer"]
    OUT -.->|"never reaches it"| PR
    PR --> SPEC["DbOperationSpec<br/>NO SQL — the model supplies<br/>none of the SQL's words"]
    SPEC --> COMP["compileOperation<br/>emits SELECT only · unchanged"]

    style S fill:#14532d,color:#fff
    style N fill:#14532d,color:#fff
    style T fill:#14532d,color:#fff
    style D1 fill:#450a0a,color:#fff
    style D2 fill:#450a0a,color:#fff
    style D3 fill:#450a0a,color:#fff
    style D4 fill:#450a0a,color:#fff
    style PR fill:#1e3a5f,color:#fff
    style SPEC fill:#4c1d95,color:#fff
    style COMP fill:#14532d,color:#fff
```

Two properties survive **unchanged** (`D-169`):

1. **Identifiers are metadata, never input** — every table, column and join side resolves against the
   introspected rows, or is a structured finding naming what *was* available.
2. **Values are positional parameters** — a filter binds to `$n` in spec order; `params_schema` is
   *derived*. A parameter cannot become SQL.

---

## 5. Phase 2 — the write boundary

`D-170`. Nothing exists until a person saves, and **the save re-verifies the submitted spec** rather than
trusting that a proposal was approved — because the dialog is editable by design, so what arrives at save
is frequently not what was proposed.

```mermaid
flowchart TB
    PROP["proposal in hand<br/>name · description · spec<br/>compiledSql · paramsSchema"] --> SHOW["review surface — FR-011<br/>plain English · the COMPILED SQL<br/>derived params · tables and columns touched"]

    SHOW --> EDIT["person may edit the NAME — FR-012<br/>validated against the identifier regex"]
    EDIT --> WARN["dialog states: this name becomes part of<br/>every automation that uses it and CANNOT<br/>be changed later — D-173"]

    WARN --> DECIDE{"person decides"}
    DECIDE -->|"abandon"| GONE["nothing exists<br/>no row · no manifest version · no ref"]
    DECIDE -->|"save"| REV["POST /operations — FR-013<br/>re-runs check AND create on the<br/>SUBMITTED spec. A proposal id is<br/>NOT authorisation"]

    REV -->|"findings"| SHOW
    REV -->|"name taken"| C409["409 — the atomic backstop, kept"]
    REV -->|"ok"| CREATE["db_operations row created"]

    CREATE --> MV["manifest gains a VERSION"]
    CREATE --> FP["ZERO existing ref fingerprints move<br/>SC-003 · FR-015 — measured, as I-40's change was"]
    FP --> ARMED["no armed flow anywhere is disturbed"]

    CREATE --> REFOK["billing_db.overdue_invoices<br/>is now in CALLABLE STEPS"]

    style PROP fill:#4c1d95,color:#fff
    style SHOW fill:#7c2d12,color:#fff
    style EDIT fill:#7c2d12,color:#fff
    style WARN fill:#7c2d12,color:#fff
    style DECIDE fill:#7c2d12,color:#fff
    style GONE fill:#3f3f46,color:#fff
    style REV fill:#14532d,color:#fff
    style C409 fill:#450a0a,color:#fff
    style CREATE fill:#14532d,color:#fff
    style FP fill:#14532d,color:#fff
    style REFOK fill:#14532d,color:#fff
```

⚠ **A proposal is never persisted "so the person can come back to it."** A stored proposal is a
half-created ref with a lifecycle, and the review it waits on is exactly what makes it safe.

---

## 6. Phase 3 — chat: a setup step that does not spend the op

`D-175`, and the subtlety is that the one-op bound is **not a prompt rule** — it is
`CHAT_TURN_MAX_TOKENS = 1024`, a hard output ceiling chosen so a flow does not fit. Widening the turn's
response to carry an op *and* a spec would raise that ceiling, which is how *"a turn cannot be a
redesign"* stops being structural.

So: **two calls with two budgets.** The turn stays one op.

```mermaid
sequenceDiagram
    actor Person
    participant Chat as flow-chat.service
    participant TurnM as Model — turn call
    participant Prop as proposer — SEPARATE call
    participant Author as authorFlow

    Person->>Chat: email me last month's overdue invoices
    Chat->>TurnM: turn prompt · MAX 1024 tokens · unchanged
    TurnM-->>Chat: ONE op — add_step ref billing_db.overdue

    Chat->>Author: apply op, then validate
    Author-->>Chat: refused — unknownRefs

    Note over Chat: ref prefix names a real datasource<br/>with a schema and no readers
    Chat->>Prop: need derived from the op · OWN token budget
    Prop-->>Chat: proposal
    Chat-->>Person: PROPOSAL response kind — FR-017, no revision written

    Person->>Chat: approve (+ optional name edit)
    Chat->>Author: re-attempt the ORIGINAL op
    Author-->>Chat: accepted
    Chat-->>Person: exactly ONE revision written
```

Invariants a test holds (`SC-005`, `FR-016`, `FR-018`):

- a turn still carries **at most one op**
- `CHAT_TURN_MAX_TOKENS` is still **1024**
- the proposer imports **nothing** from `flow-generation.service.ts`
- `flow-chat-imports.test.ts` is **extended** to pin the chat service's import of the proposer — the
  existing test only reads symbols from `flow-generation.service.js` and would not have seen a new module

---

## 7. Where it sits in the whole lifecycle — `D-174`

⚠ **The catalogue changes BETWEEN generations, never inside one.** Proposing during `draftFlow`'s redraft
loop would mutate the catalogue while the loop runs, so attempt 2's prompt would describe a workspace
attempt 1 never saw — breaking *"a retry appends; it never rewrites"*, and breaking it invisibly, because
the model would simply return a different plausible answer.

```mermaid
flowchart TB
    G1["generation attempt<br/>draftFlow"] -->|"insufficient_catalogue"| PROPOSE["propose an operation"]
    PROPOSE --> APPROVE["person approves and saves"]
    APPROVE --> CATCHG["CALLABLE STEPS now contains<br/>billing_db.overdue_invoices"]
    CATCHG --> G2["REGENERATE — a NEW generation"]

    G2 --> DRAFT["draft + generate fragments"]
    DRAFT --> WR["writeRevision<br/>expressions · caps · refs · compile<br/>Kestra validates · deploy to DRAFT namespace"]
    WR --> TEST["test run — gate 1"]
    TEST --> APP["approve a REVISION"]
    APP --> ARM["live namespace + schedule trigger<br/>armed"]

    PROPOSE -.->|"FORBIDDEN — feeding a new ref back into<br/>the generation still running: attempt 2 would<br/>describe a workspace attempt 1 never saw"| G1

    style G1 fill:#1e3a5f,color:#fff
    style G2 fill:#1e3a5f,color:#fff
    style DRAFT fill:#1e3a5f,color:#fff
    style PROPOSE fill:#4c1d95,color:#fff
    style APPROVE fill:#7c2d12,color:#fff
    style CATCHG fill:#14532d,color:#fff
    style WR fill:#14532d,color:#fff
    style TEST fill:#7c2d12,color:#fff
    style APP fill:#7c2d12,color:#fff
    style ARM fill:#14532d,color:#fff
```

Three user actions, deliberately: **refuse → approve → regenerate.** Not one button.

---

## 8. Phase dependency

Every phase ships value alone. Phase 4 is the exception that is **not optional** — Phase 0 moves
`DRAFT_RULES`, which is the cached prefix, so every draft measurement on record goes stale for this path
the moment it lands (`D-176`).

```mermaid
flowchart LR
    P0["PHASE 0<br/>the honest refusal<br/>2 edits · NO model<br/>FR-001..004"] --> P1["PHASE 1<br/>the proposer<br/>1 service · 1 route<br/>FR-005..011"]
    P1 --> P2["PHASE 2<br/>approval surface<br/>FR-012..015"]
    P2 --> P3["PHASE 3<br/>chat setup step<br/>FR-016..019"]
    P0 --> P4["PHASE 4<br/>re-take measurements<br/>+ docs · Article VII"]
    P3 --> P4

    P0 -.->|"ships alone —<br/>most of the reported pain"| V0["value"]
    P1 -.->|"ships alone —<br/>API-reachable"| V0
    P2 -.->|"ships alone —<br/>completes US2"| V0
    P3 -.->|"ships alone —<br/>completes US3"| V0

    style P0 fill:#14532d,color:#fff
    style P1 fill:#4c1d95,color:#fff
    style P2 fill:#7c2d12,color:#fff
    style P3 fill:#1e3a5f,color:#fff
    style P4 fill:#450a0a,color:#fff
    style V0 fill:#3f3f46,color:#fff
```

⚠ Until Phase 4 re-takes them, **no number from `kestra:refusal`, `outline:measure`, `draft:measure` or
`chat:measure` may be quoted for this path** — the same rule the 2026-08-21 chat prompt edits were left
under.

---

## What no diagram here can show

⚠ **A proposal can be valid SQL and semantically wrong** — wrong join direction, wrong filter operator, a
missing `COALESCE`. This is the units trap one subject along, and **nothing in this feature catches it**:
not `check()`, not `compileOperation`, not `checkSq⚠ A proposal can be valid SQL and semantically wrong — wrong join direction, wrong filter operator, a missing COALESCE. This is the units trap one subject along, and nothing in this feature catches it: not check(), not compileOperation, not checkSqlShape.

The person in diagram 5 is reviewing intent, and the compiled SQL is shown precisely so it can be reviewed. FR-021 forbids any surface calling an approved operation correct, and SC-006 requires a measured acceptance rate before anyone describes this as reliable.

⚠ And that measurement has a sharp edge worth stating beside the diagram it belongs to: a high unedited-acceptance rate is ambiguous — the proposals are good, or nobody is reading them, and the two are identical in the data.

at what step the sql is getting generated 
is it during data source onboarding where named queries approved by the user will be generated and stored or 
is it when user starts using the chat builder?
lShape`.

The person in diagram 5 is reviewing **intent**, and the compiled SQL is shown precisely so it can be
reviewed. `FR-021` forbids any surface calling an approved operation *correct*, and `SC-006` requires a
measured acceptance rate before anyone describes this as reliable.

⚠ And that measurement has a sharp edge worth stating beside the diagram it belongs to: a **high
unedited-acceptance rate is ambiguous** — the proposals are good, *or* nobody is reading them, and the two
are identical in the data.
