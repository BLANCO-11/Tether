"""Template: load a JSON fixture table and optionally filter rows."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_rows(fixture_path: str | Path) -> list[dict[str, Any]]:
    path = Path(fixture_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise TypeError(f"fixture must be a JSON array: {path}")
    return data


def filter_eq(rows: list[dict[str, Any]], field: str, value: Any) -> list[dict[str, Any]]:
    return [r for r in rows if r.get(field) == value]
