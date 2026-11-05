# The component panel — the design standard for a step's properties

> **⚠ Describes the compiled builder's step panel, which now opens only for flows not built by Forge.**
> The current rules for panes, pages and components are in [`README.md`](README.md); kept for that history.

**Status:** adopted 2026-09-03. First instance: `components/flow/builder/StepIO.tsx`.

Asked for from use, holding Dify's node panel up beside ours:

> *"the inspector / properties section doesn't clearly show what input node and
> output node are there for a component … see how clearly and well laid out the
> node properties tab it is for dify, no textual mess, just clean properties and
> lack of confusing description spam. we should probably define the ui ux design
> for these components so that it stays consistent for future development."*

This is that definition. It binds every panel that describes a step, a
component, a resource or a trigger — anything with declared fields.

---

## The one rule

**A property panel is a table of fields, not an essay about them.**

Everything below follows from it. The failure it is written against is not long
sentences; it is sentences *between the rows*, which is what stops the rows
being scannable at all.

---

## 1. Anatomy, in order

```
┌──────────────────────────────────────────────┐
│  <title>                            ⋯   ✕    │   the step's address
│  <one-line description>                      │   optional; see §4
├──────────────────────────────────────────────┤
│  INPUTS                    3   the endpoint  │   label · count · ONE hint
│  to_email     overdue / work_email   string  │
│  period       input / month          string  │
│  cc           not set                string  │
├──────────────────────────────────────────────┤
│  <the body: the kind's own form>             │
├──────────────────────────────────────────────┤
│  OUTPUTS                   1   the endpoint  │
│  response     the endpoint's answer  object  │
│  json(outputs.send.body)                     │
├──────────────────────────────────────────────┤
│  ⚠ <caution, when the catalogue has one>     │
└──────────────────────────────────────────────┘
```

## 2. A row is NAME · SOURCE · TYPE, and nothing else

- **Name** — mono. It is an identifier the person will type somewhere else.
- **Source** — a pill naming *where the value comes from*: `<step> / <field>`,
  `input / <name>`, `the whole of <step>`, or a quoted literal. `the whole of`
  is the whole-object feed: every input fed by one read of an upstream step,
  and it reads per row as well as on the card's inlet (§10). This is the
  column the old panel did not have, and the reason the complaint was filed.
- **Type** — a chip, plus `req` when required. Chips, so neither reads as prose.
- **Editable only where the value can be re-emitted.** A row offers its picker
  exactly when the writer can rebuild the expression with the change and
  nothing else moved. `unknown` gets the convert action, never a picker — a
  picker on an unreadable expression rebuilds from a blank map and silently
  discards the hand-written logic the row just showed.

An output row carries **name · description · type**, and beneath it the
expression a later step reads it by — mono and selectable, because it exists to
be copied.

## 3. Where the words go instead

| The sentence is about | Put it |
| :--- | :--- |
| one FIELD | the row's `title` tooltip |
| the SECTION (who owns this shape, what the call fans over) | the head hint — **at most one, three words** |
| the STEP | the description line under the title (§4) |
| a real hazard | one warn-tinted block **below** the rows |
| the DESIGN of the panel | a code comment — never the screen |

That last row is the one that was being broken. *"This shape belongs to the
endpoint, so there is nothing to edit here. Typing one would not change what
comes back."* explains a design decision to somebody who did not ask. The head
hint `the endpoint` carries the same fact in two words.

## 4. The description line is earned, not default

Render it only when it is **the step's own** text and is **not restating a row
below it**. A `code` step's `contract.purpose` qualifies: it is written per
step, and no row repeats it. A per-*kind* sentence does not — it is the same
text on every panel of that kind, which makes it furniture.

## 5. ⚠ Three states, and collapsing two of them is a bug

A field's source is `bound`, `unset`, or **`unknown`**.

`unknown` means *the value was not written by this builder and the screen will
not guess* — a hand-authored or imported expression. It must never render as
`unset`. They are opposite claims, and the wrong one is confident: it tells
somebody a wired parameter is empty, and the obvious response is to re-bind it,
which rewrites an expression that worked.

Say **"set in the expression"**, not "not set". `lib/flow-params.ts` fails
closed so this distinction is available; a panel that discards it puts the
failure back.

## 6. ⚠ Never invent a field

A `tool` step's response body is whatever the endpoint returns and this client
has never seen it. The panel shows **one** `response` row and the expression to
read it — not a guessed column list. Same rule the run surface already follows.

## 7. ⚠ Cautions stay

`GET …/catalogue` serves `outputs.<kind>.caution`, and every one is written from
a real failure — I-42 (a timestamp cannot cross into an HTTP body via `jq`),
I-44 (`.vars.result`, not `.value`), an agent's answer not being a shape to
depend on. **Tidying a panel must not delete the warning and leave the bug.**

Read them through `outputSummary()`, never off `catalogue.outputs` directly — a
second reading in the client is how a screen goes on quoting I-44 after the
server has learned something newer.

## 8. Only offer a control that persists

Output names are editable for `code` because they become `outputKeys`, which the
compiler-emitted wrapper checks inside the container. Types and descriptions are
shown and **marked as not saved**, because the stored model has nowhere for
them. A `datasource`/`tool` output is not editable at all, and the panel says
whose it is rather than offering a box that discards what is typed into it.

A form that half-works is worse than one that offers less: green on save, old
value on reload, nothing having said why.

## 9. Two heads must not say the same word

`StepIO` has an **Outputs** table; the editor beneath it is headed **"Rename
what it returns"**, not "Outputs". Two identically-named heads on one screen is
what made the previous panel read as a pile.

## 10. One whole-object feed draws one labelled inlet

A step whose inputs all come from one upstream step's whole output gets a
single inlet row — `all inputs ← the whole of <step>` — and per-port dots
exist only where a drop can bind. A drop onto a param row of a hand-written
step would rebuild the expression from a blank map, so those dots are not
drawn at all: the edge lands on the inlet, and the card cannot invite an edit
that destroys what it shows.

---

## Applying this to a new panel

1. List the fields. If you cannot name them, the panel is not ready — do not
   fill the gap with a paragraph.
2. For each, answer name / source / type. An unanswerable source is `unknown`,
   never `unset`.
3. Move every sentence to its row in §3's table.
4. Keep the catalogue's caution.
5. Put the *rules* in a `lib/` module and let the component stay a table — the
   rules are the part worth asserting, and rendering is not.
