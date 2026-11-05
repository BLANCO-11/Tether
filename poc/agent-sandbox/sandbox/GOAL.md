# Goal (complex)

Build a chase workflow over invoice fixtures.

## Behaviour

1. Consider only invoices with `status == "overdue"` (ignore `open` / `paid`).
2. Sort the selected invoices by `amount_cents` **descending** (largest first).
3. For each invoice, choose the notification recipient by a **large-invoice threshold**:
   - if `amount_cents >= THRESHOLD` → send to `billing_email` (AP)
   - otherwise → send to `customer_email`
4. Append one `{ to, subject, body }` per invoice to `outbox.json` (order = sorted order).
5. Subject must be **exactly**: `Invoice {id} is overdue` (e.g. `Invoice INV-1001 is overdue`).
6. Body must include the invoice `id`, `amount_cents`, and `due_date`.

## Ambiguity — ask, do not invent

The GOAL mentions THRESHOLD but does **not** say whether “large” means
`>= 100000` cents ($1000) or `>= 1000` cents ($10).

Write `questions.json` with status `open` asking which threshold to use
(choices: `100000`, `1000`). STOP until answered. Put the chosen value in
workflow `params` (e.g. `large_threshold_cents`).
