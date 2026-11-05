# Personal Foundry — feature roadmap (thin fork)

Branch: `personal/foundry-thin`  
Updated: 2026-11-04  

This is the implementable plan for the **personal** product (not enterprise Admin/RBAC).  
Memory is specified separately below so other features can ship without waiting on vectors.

---

## North star

> Personal AI control plane: chat + projects + durable workflows + thin integrations,  
> with optional hands on your machines later.

One-sitting success: sign in → project → chat that uses a tool → turn it into a scheduled run → see it live / approve when needed.

---

## Already done (do not redo)

- Enterprise surface cut (Admin / Org / Incidents / Reports UI gone; redirects remain)
- Local login; personal Docker project name
- Character palette + prompt jump rail + Canvas icon rail
- Auto **Personal** home workspace (no `/no-access` dead-end)
- Thin **People** + email invites
- Merged `origin/prod` through **beta-2.37.4**

---

## Features in scope (apart from memory)

| # | Feature | Why it matters |
| :--- | :--- | :--- |
| A | **Chat → schedule** | One control: successful chat/flow → “run this on a cadence” |
| B | **Asks inbox** | One morning surface for Forge questions + gate approvals |
| C | **Live long-run watch** | Pause / steer / kill / latest artifact for long jobs |
| D | **Demo recipe on existing plugins** | Not “build GitHub” — it already ships (`piece-github`). Prove schedule + Needs you on a real connection |
| E | **Share a chat or run** | Link/invite to one artifact — not workspace RBAC |
| F | **Edge agent** | Local process: command + path I/O after OTP pair |
| G | **Project memory** | Ledger first; RAG later (see Memory section) |
| H | **Next life connector (only if needed)** | Calendar/mail *if* missing or painful — do not rebuild GitHub |

---

## Devil’s advocate (per feature)

### A — Chat → schedule
- **Pushback:** Scheduling without a trustworthy dry-run arms dangerous automations. Cron UI is a swamp; users want “every morning,” not crontab.
- **Pushback:** You already have triggers/flows — another entry point is product confusion.
- **Response:** Only offer schedule **after a succeeded gate-1 / draft run**. Copy is plain-language presets (daily / weekday / weekly), maps to existing schedule machinery. One button on the chat/flow that already worked — not a new authoring surface.

### B — Asks inbox
- **Pushback:** Duplicate of `/approvals` and in-chat questions; a third inbox trains nobody.
- **Pushback:** Empty inbox feels broken; noisy inbox feels like Jira.
- **Response:** **Unify**, don’t add. Single “Needs you” view that is a filtered merge of existing approval + agent-question queues. Default sort: oldest pending. Empty state: “You’re clear.” No new backend domain if the APIs already list both.

### C — Live long-run watch
- **Pushback:** “Live” without websockets is polling theatre; with websockets it’s another auth surface (D-15).
- **Pushback:** Steering mid-run without a contract causes half-applied chaos.
- **Response:** v1 = **run detail that always shows current step + last artifact + Stop**, using existing progress ticket/poll. Steer = send a follow-up only where the runtime already supports pause/question. No free-form “inject bash” until edge.

### D — Demo recipe (existing plugins)
- **Pushback (valid):** GitHub is already available (`@activepieces/piece-github`, OAuth path, Forge run-as). “Build a GitHub connector” was a mistaken roadmap item.
- **Pushback:** A “recipe” without productizing it is just a blog post nobody runs.
- **Response:** Phase 3 is **prove the loop**, not new plugin work: connect GitHub in the personal UI → chat or schedule does one real action → Needs you if approval is required. New connectors (calendar/mail) only if a recipe is blocked by a missing piece.

### E — Share a chat or run
- **Pushback:** Accidental secret leakage in shared transcripts; enterprise redaction assumptions may be missing.
- **Pushback:** “Share” without accounts reopens allowlist/invite design.
- **Response:** v1 = invite **existing allowed user** (People) to **read** a chat or run. Redact using existing server redaction. No public unlisted links until audited.

### F — Edge agent
- **Pushback:** Biggest security blast radius; OTP/device identity is a full product.
- **Pushback:** Without killer recipes it feels like “SSH with extra steps.”
- **Response:** **Last** among A–F. Requires A (something to run) and C (watch). v1 capabilities capped: `run_command`, `read_path`/`write_path`, approval required for write/command. Pairing OTP → device credential as already designed in session notes.

### G — Memory (summary; full plan below)
- **Pushback:** Ledger becomes an empty wiki; RAG becomes sludge; dual truth with chat.
- **Response:** Promotion from compact + “Remember this”; evidence links; capped inject; vectors only for search over curated residue.

---

## Final implementation sequence

Ordered by **usefulness ÷ risk** for the thin fork. Each phase has a kill/skip criterion.

### Phase 1 — Close the loop (A + B)  
**Goal:** Daily habit without new infra dogma.

| Todo | Detail |
| :--- | :--- |
| 1.1 | On a succeeded chat-bound flow (or explicit “this worked”), show **Schedule…** with 3 presets → existing schedule/trigger path |
| 1.2 | Refuse schedule until a successful draft/live dry-run exists (reuse gate-1 mindset) |
| 1.3 | **Needs you** page or topbar badge: merge pending approvals + agent questions; deep-link into existing decide UIs |
| 1.4 | Empty and error states honest (no fake counts) |

**Done when:** User can go chat → success → weekday 7:00 armed, and see a pending ask in one inbox.  
**Kill if:** Presets can’t map cleanly to current schedule model — fix the model first, don’t invent a second scheduler.

### Phase 2 — Watchability (C)  
**Goal:** Long work feels alive.

| Todo | Detail |
| :--- | :--- |
| 2.1 | Run/chat live panel: engine status, current step, Stop, link to artifacts |
| 2.2 | Reuse flow-progress ticket + poll fallback; no new unauthenticated socket |
| 2.3 | Optional: “notify when done” using existing mail/tool if already configured |

**Done when:** A multi-minute run can be left and resumed from one screen without digging logs.  
**Kill if:** Progress APIs can’t expose step/artifact reliably — fix visibility before UI chrome.

### Phase 3 — Prove plugins in the personal loop (D)  
**Goal:** Use what already exists; don’t rebuild GitHub.

| Todo | Detail |
| :--- | :--- |
| 3.1 | Confirm GitHub connect + one action works on the personal stack (Connectors UI / Forge) — fix friction only |
| 3.2 | One **seeded or documented** recipe: schedule or chat → GitHub action → Needs you when gated |
| 3.3 | Only if blocked: add/fix the *missing* life connector (calendar/mail), not a second GitHub |

**Done when:** A personal user completes a real GitHub action via Foundry without enterprise Admin.  
**Skip** building any new GitHub plugin surface.

### Phase 4 — Project memory v1 (G, no vectors)  
**Goal:** One measured “it remembered.”

| Todo | Detail |
| :--- | :--- |
| 4.1 | Table/API: project memory items (`decision` / `preference` / `open_loop` / `note`), status, source message ids |
| 4.2 | Write: “Remember this” on a message; compact proposes ≤3 promotions to accept |
| 4.3 | Read: inject active items capped (~2k tokens) into project chats |
| 4.4 | Project UI panel: list / edit / supersede |

**Done when:** New chat in same project obeys ≥1 accepted memory without re-prompt.  
**Kill if:** Users never accept promotions — improve compact UX before building RAG.

### Phase 5 — Share narrowly (E)  
**Goal:** Personal collaboration without tenants.

| Todo | Detail |
| :--- | :--- |
| 5.1 | Grant People-listed user read access to a chat or a run |
| 5.2 | Server-side redaction on shared payload |
| 5.3 | No public links in v1 |

**Done when:** Second allowed user opens a shared chat read-only.  
**Defer** public links and edit shares.

### Phase 6 — Edge agent (F)  
**Goal:** Hands on the machine.

| Todo | Detail |
| :--- | :--- |
| 6.1 | Pairing OTP in UI; device credential on host |
| 6.2 | Agent capabilities: `run_command`, `read_path`, `write_path` + approval |
| 6.3 | Recipe: schedule/chat asks edge to act; progress visible via Phase 2 |

**Done when:** One approved local command/file write from a Foundry chat.  
**Do not start** until Phases 1–2 exist.

### Phase 7 — Memory retrieval (G optional)  
Only if Phase 4 succeeds and “find that old discussion” remains painful.

| Todo | Detail |
| :--- | :--- |
| 7.1 | Embed memory notes + compact summaries + project files (not raw turns) |
| 7.2 | Retrieve on explicit recall / search intents only |
| 7.3 | Hybrid: id/keyword first, vectors second |

---

## Memory (locked decisions)

- Chat transcript = canonical narrative  
- Memory store = promoted index with evidence links  
- No dual unpublished truths  
- No embedding of every turn in v1  
- Vectors = search over curated residue, not default context  

(See discussion 2026-11-04: ledger first, RAG later.)

---

## Out of scope (explicit)

- Restoring enterprise Admin / Org / Incidents / Reports UI  
- Workspace RBAC as the primary share model  
- Connector marketplace  
- Spec-kit enforcement for personal-fork spikes (owner preference; revisit for shared prod merges)  
- Public unauthenticated share links  

---

## Working todos (checklist)

Copy into issues or a sprint board as needed:

- [ ] **1.1** Schedule CTA after successful chat/flow  
- [ ] **1.2** Gate schedule on successful run  
- [ ] **1.3** Needs you unified inbox + badge  
- [ ] **1.4** Honest empty/error states for inbox  
- [ ] **2.1** Live run watch panel (status / step / stop / artifact)  
- [ ] **2.2** Progress via existing ticket + poll only  
- [ ] **2.3** Optional done notification  
- [ ] **3.1** GitHub (existing plugin) works on personal stack — friction only  
- [ ] **3.2** One real recipe: schedule/chat → GitHub → Needs you  
- [ ] **3.3** New connector only if a recipe is blocked (not GitHub)  
- [ ] **4.1** Project memory schema + API  
- [ ] **4.2** Remember + compact promotion  
- [ ] **4.3** Capped inject into project chats  
- [ ] **4.4** Project memory panel UI  
- [ ] **5.1** Share chat/run with allowed user (read)  
- [ ] **5.2** Redaction on share  
- [ ] **5.3** Block public links  
- [ ] **6.1** Edge pairing OTP + device credential  
- [ ] **6.2** Edge capabilities + approval  
- [ ] **6.3** Edge recipe wired to watch  
- [ ] **7.x** RAG only after 4.x succeeds  

---

## Suggested next implement

Start **Phase 1.1–1.3** (schedule CTA + Needs you). Highest habit value, lowest new security surface, reuses schedule/approval machinery already in the tree.
