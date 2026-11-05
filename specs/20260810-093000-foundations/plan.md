# Implementation plan — pointer

⚠ **The real plan is [`plans/foundations-2026-08-10/plan.md`](../../plans/foundations-2026-08-10/plan.md).**
Read [`findings.md`](../../plans/foundations-2026-08-10/findings.md) first — it carries what was
investigated and what turned out to be true, with the command or the row each claim came from.

This file exists only because `scripts/spec-gate-core.sh` requires a `plan.md` beside `spec.md` and
`tasks.md` before it will permit a source write. See `spec.md` in this directory for why that
mechanism was used. **Do not maintain this file in parallel with the real one** — a second copy of a
plan is how the two drift and a reader trusts the wrong one.

## Order, and why it is this order

```
I-120  (standalone, hours)   ──▶  everything else
        │
        ▼
0  make the record true          ──▶  everything else
        │
        ▼
1  onboarding + Tether shrink    ──▶  2  chat mode  ─────────┐
   (a tool that cannot                    │                  │
    authenticate makes every         2.0 SPIKE first:        ├──▶ 6  mode-journey
    later phase untestable            does the model         │       coherence
    by hand)                          return one correct     │
        │                             op? If not, STOP       │
        │                                   ▲                │
        │                               3  branch (If)  ─────┘
        │                                   ▲
        ├──▶  4  capability catalogue ──────┘  (learn kind-addition here first)
        │           │
        └───────────┴──▶  5  named writes
```

- **0 and 1 first.** Phase 1 is the cheapest work with the largest effect: today no tool created
  through the UI can ever authenticate (I-124), so every later phase would be tested with
  seeder-created tools and every credential bug report would be unfalsifiable.
- **2, 4 and 5 are independent** and can run in parallel.
- **4 before 5.** Both add a step kind — sixteen files — and Phase 4's worst failure is a lost
  message where Phase 5's is an irreversible write to a tenant's database.
- **3 before 6**, and 3 owes 2 one constraint up front (D-123: the step id space stays flat).
- **6 is last and is not optional.**

## Gate set, run after every phase

```
pnpm typecheck                                   # 0 in all three packages
pnpm --filter @foundry/server test
pnpm --filter @foundry/client test
bash scripts/ui-honesty-check.sh                 # 0 FAIL
pnpm kestra:check                                # 0 SKIP
pnpm --filter @foundry/server e2e:ui             # at TWO periods
pnpm --filter @foundry/server scenarios:verify   # 13/13
pnpm --filter @foundry/server finance:verify
pnpm demo:verify && pnpm demo:rehearse
pnpm backup:verify                               # after EVERY migration
pnpm --filter @foundry/server showcase:seed && … showcase:verify   # seed IMMEDIATELY before (I-33)
```

⚠ **Any `DRAFT_RULES` edit owes `outline:measure` AND `draft:measure` re-taken in the same commit.**
It is the byte-identical cached prefix every `kestra:refusal` and `outline:measure` number was taken
against.

⚠ **The containers run `dist/`** — a server change needs `docker compose build server web`. A stale
build reads exactly like a missing route.

⚠ **Do not run `slate:clear` while a report is outstanding.** The 2026-08-07 investigation destroyed
its own evidence that way.
