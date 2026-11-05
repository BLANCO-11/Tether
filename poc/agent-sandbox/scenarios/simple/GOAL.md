# Goal

Read overdue invoices from fixtures and, for each, produce a notification payload
`{ to, subject, body }` into the fixture outbox (`outbox.json`).

Subject must be exactly: `Invoice {id} is overdue`.
Body may include amount and due date.

**Do not invent columns.** Use only columns described in `context/`.

**Ambiguity:** fixtures have both `customer_email` and `billing_email`. This goal
does **not** say which to use for `to`. If unclear, write `questions.json` and
stop — do not guess.
