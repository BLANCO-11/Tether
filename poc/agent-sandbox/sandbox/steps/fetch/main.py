"""Load overdue invoice rows from the configured fixture."""

from __future__ import annotations

from pathlib import Path
import sys
from typing import Any

# The workflow runner executes step files by path; add the sandbox template
# directory so the shared fixture loader can be imported consistently.
_TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "templates"
if str(_TEMPLATE_DIR) not in sys.path:
    sys.path.insert(0, str(_TEMPLATE_DIR))
from db_query import filter_eq, load_rows  # noqa: E402


def run(params: dict, inputs: dict) -> dict:
    rows: list[dict[str, Any]] = load_rows(params["fixture_path"])
    return {
        "rows": filter_eq(
            rows,
            params["status_column"],
            params["overdue_value"],
        )
    }
