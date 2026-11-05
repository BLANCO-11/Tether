"""Append one threshold-routed overdue-invoice notice per sorted row."""

from __future__ import annotations

from pathlib import Path
import sys

_TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "templates"
if str(_TEMPLATE_DIR) not in sys.path:
    sys.path.insert(0, str(_TEMPLATE_DIR))
from outbox_append import append_message  # noqa: E402


def run(params: dict, inputs: dict) -> dict:
    sent = []
    for invoice in inputs["rows"]:
        invoice_id = invoice[params["id_column"]]
        amount = invoice[params["amount_column"]]
        recipient_column = (
            params["billing_email_column"]
            if amount >= params["large_threshold_cents"]
            else params["customer_email_column"]
        )
        message = {
            "to": invoice[recipient_column],
            "subject": params["subject_template"].format(id=invoice_id),
            "body": f"Invoice {invoice_id} for {amount} cents was due {invoice[params['due_date_column']]}.",
        }
        sent.append(append_message(params["outbox_path"], message)["sent"])
    return {"sent": sent}
