"""Template: append a notification payload to a JSON outbox file."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def append_message(outbox_path: str | Path, message: dict[str, Any]) -> dict[str, Any]:
    path = Path(outbox_path)
    existing: list[Any] = []
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(existing, list):
            raise TypeError(f"outbox must be a JSON array: {path}")
    existing.append(message)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    return {"sent": True, "message": message}
