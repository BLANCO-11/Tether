"""Fetch overdue invoices from the fixture table."""

from __future__ import annotations

import sys
from pathlib import Path

# sandbox root = parents[2] from steps/fetch/main.py
SANDBOX = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SANDBOX / "templates"))

from db_query import filter_eq, load_rows  # noqa: E402


def run(params: dict, inputs: dict) -> dict:
    fixture = params.get("fixture", str(SANDBOX / "fixtures" / "invoices.json"))
    status = params.get("status", "overdue")
    rows = filter_eq(load_rows(fixture), "status", status)
    return {"rows": rows}
