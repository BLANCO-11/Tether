# Session handout — why named-query beats chat on absence bands (and what to fix)

**Date**: 2026-10-07  
**For**: next agent / human session  
**Do not start by patching pin/catalogue again.** The failure mode below is architectural.

---

## 1. One-line verdict

Chat under Intent IR **short-circuits the proven DB-operation proposer** and runs **`emitBandedSpec`**, which can ship **wrong SQL while coverage marks the goal “done”**. The named-query / operations proposer is slower and sometimes refuses, but when it succeeds it produces the column shape the person asked for — because it still goes through **form → compile → findings**.

---

## 2. Evidence flows (this deployment)

| Artifact | Id |
| :--- | :--- |
| Failed chat flow | `dc7356aa-f5d7-4bc2-a416-345a31f595c1` |
| Workspace | HR `136d24c7-b5b3-4d71-a2ce-5f61f720042f` |
| Datasource | `Attendance_DB` `397ad5e9-851a-4129-8e93-9c8459ba7316` |
| Prior related fail | `e7412613-…` (reader drop — T13 addressed; **not** today’s root) |

### Chat turn 1 (same prompt as UAT)

Goal (verbatim): full/half absence bands + email Excel.

**Persisted plan looked correct**: `band_count` arms 9.5→0, 4.75→0.5, 4.74→1; source `Attendance_DB.query.banded_absences`; `covered` credited every band clause.

**Emitted SQL was wrong**:

- Columns: `emp_id`, `band_count_half_day_absences_and_full_day` only  
- CASE: `≥9.5 → 0`, `≥4.75 → 1`, `else → 0` (half counted as 1; full as 0)  
- No `emp_name`, no separate half/full/total  

Status: **`applied` / complete** — false complete.

### Chat turn 2

User: `the output of report should be - emp_id, emp_name, half days, full days, total`

Incomplete still had the same source + same plan arms (T13 pin held). **`covered` empty** → gaps re-asked “full day = 0 to 4.74 hours — nothing built”, while summary still described band_count. Coverage amnesia on edit, on top of bad SQL.

---

## 3. Live comparison (ran 2026-10-07 on this machine)

Script: `packages/server/tmp/compare-propose-vs-band.mjs` (+ ad-hoc `proposeOperation` calls).

### A — `emitBandedSpec` (chat Intent IR path)

Same arms the chat plan stores → **same broken SQL** as flow `dc7356aa` rev1 (one indicator column, wrong then-values).

Cause in code (`band-read.ts`): one measure whose words match `\bhalf\b` and not `\btotal\b` goes through **`indicatorCompute(..., 0.5)`**, not three weighted outputs. Chat often plans **one** `band_count` measure named “half-day absences and full-day absences”.

### B — `proposeOperation` (named-query / operations UI path)

| Need | Result |
| :--- | :--- |
| Exact chat goal (weights + “return half/full/total”) | **3 attempts → 422** (compile findings: aggregate-join alias vs `hours_worked`; unused params). Honest refuse. |
| Clearer column-shaped need (emp_id, name, half_days, full_days, total) | **`ok` in ~23s** — aliases `emp_id`, `employee_name`, `half_days`, `full_days`, `total_absences`; joins `employee` + two filtered aggregates on `attendance_day`. |

So: proposer is **not magic on the identical sentence**, but it is **architecturally safer** (refuse > false complete), and with a need that names outputs it **beats** band emit on the shape the user actually wants.

---

## 4. Architectural gap (the thing to fix — not more pin patches)

```
Chat Intent IR write path today
───────────────────────────────
plan.band_count arms
        │
        ▼
readWriter() ──if bandEmitEnabled()──► emitBandedSpec() ──► LocalReader
        │                                    ▲
        │                                    └── SKIPS proposeOperation
        │
        └── else ► proposeOperation(form) ► compile ► findings loop ► LocalReader

Named-query / operations UI
───────────────────────────
need text ──► proposeOperation ──► compile ► findings ──► person reviews readback
```

**Intentional short-circuit** (docblock in `band-read.ts`): band emit was folded into Intent IR to avoid propose latency on HR bands. That trade **bought speed and lost the only loop that checks the form against the compiler**.

### Three systems of truth that disagree

| Layer | What it believes | What it does not check |
| :--- | :--- | :--- |
| Plan / Intent IR / `covered` / `bandClauseCovers` | Band meaning is “done” from words + arms | Emitted column list / CASE weights |
| `emitBandedSpec` | One measure → one aggregate (often indicator) | User-facing half/full/total + name |
| `proposeOperation` + `compileOperation` | Form that compiles | Skipped entirely when bands present |

Until chat’s accepted read is gated by **the same compile/accounting surface as propose** (or chat stops short-circuiting), pin/clarify/MEM3 patches will keep producing green then “what should it do for full day?” cycles.

---

## 5. Why named-query “feels” better (even when it refuses)

1. **Person reviews a readback of the form** before it becomes a callable reader — chat promotes a written local into the flow without that UX.  
2. **Findings loop** on compile errors; chat band emit treats compile success of a *wrong* CASE as done.  
3. **Need is the output contract** (“return columns X”) — chat need is the whole automation goal, then a parallel plan invents `band_count` words that mis-steer emit.  
4. Escape hatch exists: **`queries/propose`** (raw SELECT) when the form cannot express the read (`db-query-proposal.service.ts`). Chat never takes that hatch for bands.

---

## 6. What NOT to do next session

- Do not treat this as another T13-style “preserve local readers” bug.  
- Do not add more `covered` heuristics without binding them to **compiled aliases / CASE**.  
- Do not re-enable MEM3 stripping to “force rewrite” under Intent IR without a measured SQL check.  
- Do not claim band emit is “the same as propose” — measured otherwise.

---

## 7. Candidate directions (choose deliberately; measure)

Ordered by “fix the architecture, not the symptom”:

1. **Stop short-circuiting on success-without-proof**  
   After `emitBandedSpec`, require the same class of checks propose gets: projected aliases must include the goal’s return clauses (or plan must emit **three** measures: half / full / total), else fall through to `proposeOperation`.

2. **Plan shape for bands**  
   Force three `band_count` measures (or one measure + explicit `outputs: [half, full, total]`) so emit cannot collapse half+full into one indicator.

3. **Prefer propose for banded writes; keep emit as optional fast path**  
   Flip the default: propose first; emit only when a harness proves column parity. Latency cost is real (~20–40s/attempt) — document it.

4. **Coverage from SQL, not only from plan words**  
   `bandClauseCovers` / `covered` must not clear “full day = …” unless compiled SQL contains a matching weight/arm (or named alias). False complete is worse than incomplete.

5. **Edit path: carry `covered` or re-derive from compiled locals**  
   Turn 2 emptied `covered` while measures still held the arms — that alone produces the “utter failure” question UX.

---

## 8. Suggested first experiments (next session)

```bash
# A — reproduce emit vs propose (Attendance_DB)
cd packages/server && pnpm exec tsc -p tsconfig.build.json
# load .env carefully (quotes); then:
node tmp/compare-propose-vs-band.mjs

# B — propose with column-shaped need (known green shape)
# emp_id, emp_name, half_days, full_days, total_absences — see section 3

# C — inspect false complete
# flow dc7356aa rev1: goal_spec.covered vs model_json.steps[0].sql
```

Perturbation that must turn red if the fix is real: accept a band emit whose CASE weights ≠ plan arms → must not reach `status: complete` / must not add those clauses to `covered`.

---

## 9. Files to open first

| File | Why |
| :--- | :--- |
| `services/builder/builder.service.ts` `readWriter` (~181–218) | Band emit short-circuit |
| `services/builder/band-read.ts` | Indicator vs weight; one measure → one column |
| `services/db-operation-proposal.service.ts` | Form proposer + findings loop |
| `services/db-query-proposal.service.ts` | SQL escape hatch the UI has; chat does not for bands |
| `services/builder/plan.ts` `bandClauseCovers` / `withBandForms` | Coverage without SQL |
| Flow `dc7356aa-…` in DB | Ground truth for false complete + edit gaps |

---

## 10. Prompt quality

The UAT prompt is **clear enough**. Failure is not “user should name tables”. The product accepted a draft that did not implement the stated weights/columns, then asked the person to redefine rules already in the plan.

---

*Measurement note: propose/emit numbers above are n=1 on `gpt-6-luna` via this deployment’s gateway — readings, not properties. The architectural claim (short-circuit skips compile loop) is code-true regardless of model.*
