"""Build a notification for one invoice row and append to the outbox."""

from __future__ import annotations

import sys
from pathlib import Path

SANDBOX = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SANDBOX / "templates"))

from outbox_append import append_message  # noqa: E402


def run(params: dict, inputs: dict) -> dict:
    row = inputs.get("row") or {}
    email_field = params.get("email_field", "customer_email")
    subject_tmpl = params.get("subject", "Invoice {id} is overdue")
    outbox = params.get("outbox", str(SANDBOX / "outbox.json"))

    to = row.get(email_field)
    if not to:
        raise ValueError(f"row missing email field {email_field!r}: {row!r}")

    inv_id = row.get("id", "?")
    amount = row.get("amount_cents", 0)
    due = row.get("due_date", "?")
    message = {
        "to": to,
        "subject": subject_tmpl.format(id=inv_id),
        "body": f"Invoice {inv_id} for {amount} cents was due {due}.",
    }
    result = append_message(outbox, message)
    return {"sent": result["sent"], "message": message}
