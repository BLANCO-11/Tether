"""The `foundry` module — the ONLY way a Pi-built step touches the world.

Every verb is an HTTP call to Foundry's existing step API, authorised by this run's execution token. The server —
never this module and never the step — decides whether a read hits mock data or production and whether an email is
captured or delivered (D-52). The same module runs in a test and in production; that is the whole point.

A step may only use what its `uses` declares (`read:<name>`, `tool:<name>`). An undeclared use is refused here
by name, so what a reviewer approves in workflow.json is what the code can do.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import zipfile
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

__all__ = ["FoundryError", "read", "call", "file", "save_file"]

_ctx: dict[str, Any] | None = None
# What this step read: [{"read": name, "rows": n}] — reported with the step's result, so "no rows came back" can say
# where the rows went (read 10, kept 0) instead of leaving a person to guess between empty data and blank values.
_reads: list[dict[str, Any]] = []

# The server's limits, checked here first so a step learns what went wrong in a sentence rather than as a dropped
# connection halfway through an upload (config.steps.callbackMaxBytes / fileMaxBytes on the server).
CALL_MAX_BYTES = 5 * 1024 * 1024
FILE_MAX_BYTES = 50 * 1024 * 1024
# Rows handed to a tool as data past this size are built into the file HERE, in the step, and sent as a file:
# 108k rows × 24 columns are 73 MB as JSON and 7 MB as Excel (measured 2026-10-12).
ROWS_AS_FILE_BYTES = 1 * 1024 * 1024
# A table in a message BODY past this many rows is a report, not a summary: it goes as an attached file and the body
# says so. Mirrors BODY_TABLE_MAX_ROWS in the server's mail-attachments.ts (the safety net behind this one).
BODY_TABLE_MAX_ROWS = 50
BODY_MOVED_TO_FILE = "The full results are in the attached file."
# Excel holds at most 1,048,576 rows (one is the header).
XLSX_MAX_ROWS = 1_048_575


class FoundryError(Exception):
    """A step-API call refused or failed. The message is the server's, verbatim; `path` and `status` say which call."""

    def __init__(self, message: str, path: str | None = None, status: int | None = None) -> None:
        super().__init__(message)
        self.path = path
        self.status = status


def _configure(ctx: dict[str, Any]) -> None:
    global _ctx
    _ctx = ctx


def _need(kind: str, name: str) -> dict[str, Any]:
    if _ctx is None:
        raise FoundryError("foundry is not configured — steps only run inside the Foundry runner")
    if f"{kind}:{name}" not in (_ctx.get("uses") or []):
        raise FoundryError(
            f"step '{_ctx.get('stepId')}' does not declare '{kind}:{name}' in its uses — add it to workflow.json"
        )
    return _ctx


def _mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(body, default=str).encode()
    if len(data) > CALL_MAX_BYTES:
        raise FoundryError(
            f"{path}: this call carries {_mb(len(data))} and a step can send at most {_mb(CALL_MAX_BYTES)} at once. "
            "Send a summary or only the rows that matter — or, for a report, write the file in the step and attach "
            'it by path: {"name": "report.xlsx", "path": "report.xlsx"}.'
        )
    return _send(path, data, {"content-type": "application/json"})


def _send(path: str, data: bytes, headers: dict[str, str]) -> dict[str, Any]:
    ctx = _ctx or {}
    req = urllib.request.Request(
        f"{ctx['serverBase']}{path}",
        data=data,
        headers={"authorization": f"Bearer {ctx['token']}", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        # The server's own sentence. Step routes answer {"error": "..."}, the generic handler {"message": "..."} —
        # reading only "message" put a raw JSON body in front of the person (chat 8d7e37dc, 2026-10-13).
        try:
            body = json.loads(raw)
            msg = (body.get("message") or body.get("error") or raw) if isinstance(body, dict) else raw
        except json.JSONDecodeError:
            msg = raw
        raise FoundryError(str(msg)[:1500], path=path, status=e.code) from None


def _one(resp: dict[str, Any], what: str) -> Any:
    results = resp.get("results") or []
    if not results:
        raise FoundryError(f"{what}: the server returned no result")
    first = results[0]
    if not first.get("ok"):
        raise FoundryError(f"{what}: {first.get('error', 'failed')}")
    return first.get("data")


def read(name: str, **params: Any) -> list[dict[str, Any]]:
    """Run the read declared as `reads.<name>` in workflow.json and return its rows."""
    ctx = _need("read", name)
    decl = (ctx.get("reads") or {}).get(name)
    if not isinstance(decl, dict):
        raise FoundryError(f"read '{name}' is not declared under reads in workflow.json")
    if decl.get("ref"):
        path = "/api/steps/datasource" if decl.get("kind") == "query" else "/api/steps/query"
        body: dict[str, Any] = {"ref": decl["ref"], "params": [params], "stepId": ctx["stepId"]}
    else:
        ds = decl.get("datasource")
        sql = decl.get("sql")
        if not ds or not sql:
            raise FoundryError(f"read '{name}' needs either ref, or datasource + sql")
        # ONE declaration of the parameters — an ordered list of {name, type}, $1 first. Both the binding order and
        # the per-parameter descriptor the executor requires are derived from it, so they cannot disagree.
        declared = decl.get("params") or []
        if not isinstance(declared, list) or not all(isinstance(p, dict) and p.get("name") and p.get("type") for p in declared):
            raise FoundryError(
                f"read '{name}': params must be a list of {{\"name\": ..., \"type\": ...}} in $1, $2 … order"
            )
        order = [p["name"] for p in declared]
        types = {p["name"]: p["type"] for p in declared}
        missing = [n for n in order if n not in params]
        if missing:
            raise FoundryError(f"read '{name}' needs {', '.join(missing)} — pass them: foundry.read('{name}', {missing[0]}=...)")
        body = {
            # `pi:` cannot be a saved operation's name, so the executor can never mistake this statement for a
            # stored reader and bind it with that reader's parameter order.
            "ref": f"{ds}.pi:{name}",
            "datasourceRef": ds,
            "sql": sql,
            **({"sqlParamOrder": order} if order else {}),
            **({"sqlParamsSchema": {k: {"type": v} for k, v in types.items()}} if types else {}),
            "params": [params],
            "stepId": ctx["stepId"],
        }
        path = "/api/steps/query"
    data = _one(_post(path, body), f"read '{name}'")
    if isinstance(data, dict) and "rows" in data:
        data = data["rows"]
    rows = data if isinstance(data, list) else [data]
    _reads.append({"read": name, "rows": len(rows)})
    return rows


_opened: dict[str, str] = {}


def file(name: str) -> str:
    """Open one of the workspace's Files (Resources → Files) and return its local path.

    The step must list "file:<name>" in its uses. Read it like any file: `pd.read_excel(foundry.file("rates.xlsx"))`,
    `open(foundry.file("policy.txt")).read()`.
    """
    ctx = _need("file", name)
    if name in _opened:
        return _opened[name]
    req = urllib.request.Request(
        f"{ctx['serverBase']}/api/steps/files/workspace/{urllib.parse.quote(name, safe='')}",
        headers={"authorization": f"Bearer {ctx['token']}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw).get("message") or raw
        except json.JSONDecodeError:
            msg = raw
        raise FoundryError(f"file '{name}': {msg[:500]}") from None
    folder = tempfile.mkdtemp(prefix="foundry-workspace-file-")
    path = os.path.join(folder, os.path.basename(name))
    with open(path, "wb") as f:
        f.write(data)
    _opened[name] = path
    return path


def save_file(path: str, name: str | None = None) -> str:
    """Save a file this step wrote (a report it built) with Foundry and return its id, for a tool call to attach.

    Most steps never call this: an attachment given as {"name": ..., "path": ...} in `call` is saved automatically.
    """
    ctx = _ctx
    if ctx is None:
        raise FoundryError("foundry is not configured — steps only run inside the Foundry runner")
    name = name or os.path.basename(path)
    size = os.path.getsize(path)
    if size > FILE_MAX_BYTES:
        raise FoundryError(
            f"{name} is {_mb(size)} and a file can be at most {_mb(FILE_MAX_BYTES)}. Send a summary or fewer rows."
        )
    with open(path, "rb") as f:
        data = f.read()
    resp = _send(
        "/api/steps/files",
        data,
        {
            "content-type": "application/octet-stream",
            "x-file-name": urllib.parse.quote(name),
            "x-step-id": str(ctx.get("stepId") or ""),
        },
    )
    return resp["file"]


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, (dict, list)):
        return json.dumps(v, default=str)
    return str(v)


def _base_name(name: str | None, fallback: str = "report") -> str:
    base = re.sub(r"\.(xlsx|csv)$", "", (name or "").strip(), flags=re.I)
    base = re.sub(r"[^A-Za-z0-9 ._-]+", " ", base).strip(" ._-")
    return (base or fallback)[:80]


def _rows_file(rows: list[dict[str, Any]], name: str | None, fmt: str | None) -> tuple[str, str]:
    """Build the file a tool would have built from `rows`, in this step. Returns (path, attachment name).

    Excel when asked (it is compressed already); CSV otherwise. A file still over the limit, or rows past Excel's
    row limit, becomes a zipped CSV — a CSV of repetitive data shrinks about twentyfold.
    """
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    base = _base_name(name)
    folder = tempfile.mkdtemp(prefix="foundry-file-")
    want = (fmt or ("xlsx" if (name or "").lower().endswith(".xlsx") else "csv")).lower()
    if want == "xlsx" and len(rows) <= XLSX_MAX_ROWS:
        import xlsxwriter

        path = os.path.join(folder, base + ".xlsx")
        wb = xlsxwriter.Workbook(path, {"strings_to_numbers": False, "strings_to_formulas": False, "strings_to_urls": False})
        ws = wb.add_worksheet()
        ws.write_row(0, 0, cols)
        for i, r in enumerate(rows, 1):
            ws.write_row(i, 0, [_cell(r.get(c)) for c in cols])
        wb.close()
        if os.path.getsize(path) <= FILE_MAX_BYTES:
            return path, base + ".xlsx"
    import csv

    csv_path = os.path.join(folder, base + ".csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow(["" if r.get(c) is None else _cell(r.get(c)) for c in cols])
    if want == "csv" and os.path.getsize(csv_path) <= FILE_MAX_BYTES:
        return csv_path, base + ".csv"
    zip_path = csv_path + ".zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.write(csv_path, base + ".csv")
    return zip_path, base + ".csv.zip"


def _big(v: Any) -> bool:
    return (
        isinstance(v, list)
        and bool(v)
        and all(isinstance(r, dict) for r in v)
        and len(json.dumps(v, default=str).encode()) > ROWS_AS_FILE_BYTES
    )


def _rows_in(v: Any) -> list[dict[str, Any]] | None:
    """Records, whether given as a list or as JSON text of one (or of a step envelope's data). None for anything else."""
    if isinstance(v, str):
        t = v.strip()
        if not t or t[0] not in "[{":
            return None
        try:
            v = json.loads(t)
        except ValueError:
            return None
    if isinstance(v, dict):
        if isinstance(v.get("rows"), list):
            v = v["rows"]
        elif isinstance(v.get("results"), list) and v["results"] and isinstance(v["results"][0], dict):
            v = v["results"][0].get("data")
    if isinstance(v, list) and v and all(isinstance(r, dict) for r in v):
        return v
    return None


def _content_file(content: str | bytes, name: str | None) -> tuple[str, str]:
    """An attachment's text written as the file it is (zipped past the file limit). Returns (path, attachment name)."""
    data = content.encode("utf-8") if isinstance(content, str) else bytes(content)
    fname = os.path.basename((name or "").strip()) or "attachment.txt"
    folder = tempfile.mkdtemp(prefix="foundry-file-")
    path = os.path.join(folder, fname)
    with open(path, "wb") as f:
        f.write(data)
    if len(data) <= FILE_MAX_BYTES:
        return path, fname
    zip_path = path + ".zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.write(path, fname)
    return zip_path, fname + ".zip"


def _with_saved_files(params: dict[str, Any]) -> dict[str, Any]:
    """Data travels as FILES, whatever shape a step hands it over in (2026-10-13).

    A step's rows reached a mail call as 22.5 MB of CSV text in `attachments[].content` — a spelling nothing here
    converted — and the call was refused at the 5 MB limit after a successful build. The rule is now one rule, not a
    list of spellings a step must happen to use:
      - an attachment by `path` is saved and sent as its id (as before);
      - rows past ROWS_AS_FILE_BYTES — `attach_rows`, an attachment's `rows` — are built into the file here (as before);
      - an attachment's `content` (its text) past ROWS_AS_FILE_BYTES is written as that file and saved;
      - a `body` that is a TABLE (records, or JSON text of them) past BODY_TABLE_MAX_ROWS rows or ROWS_AS_FILE_BYTES
        becomes an attached file, and the body says the results are attached. A message body is a summary or prose;
        a report is a file. Small tables stay in the body (the mail route renders them as a table).
    """
    params = dict(params)
    items = list(params.get("attachments") or []) if isinstance(params.get("attachments"), list) else None

    rows = params.get("attach_rows")
    if isinstance(rows, str):
        try:
            rows = json.loads(rows)
        except ValueError:
            rows = None
    if isinstance(rows, dict) and isinstance(rows.get("rows"), list):
        rows = rows["rows"]
    if _big(rows):
        path, name = _rows_file(rows, params.get("attach_name"), params.get("attach_format"))
        items = (items or []) + [{"name": name, "file": save_file(path, name)}]
        for k in ("attach_rows", "attach_name", "attach_format"):
            params.pop(k, None)

    body_rows = _rows_in(params.get("body"))
    if body_rows is not None and (
        len(body_rows) > BODY_TABLE_MAX_ROWS or len(json.dumps(body_rows, default=str).encode()) > ROWS_AS_FILE_BYTES
    ):
        attached = bool(items) or params.get("attach_rows") is not None
        if not attached:
            # The same name and format the mail route's own fallback uses: the subject, as Excel.
            path, name = _rows_file(body_rows, str(params.get("subject") or "report"), "xlsx")
            items = [{"name": name, "file": save_file(path, name)}]
        params["body"] = BODY_MOVED_TO_FILE

    if items is not None:
        out = []
        for a in items:
            if isinstance(a, dict) and "path" in a:
                a = dict(a)
                path = a.pop("path")
                a.setdefault("name", os.path.basename(path))
                a["file"] = save_file(path, a["name"])
            elif isinstance(a, dict) and _big(a.get("rows")):
                path, name = _rows_file(a["rows"], a.get("name"), a.get("format"))
                a = {"name": name, "file": save_file(path, name)}
            elif isinstance(a, dict) and isinstance(a.get("content"), (str, bytes)) and len(
                a["content"].encode("utf-8") if isinstance(a["content"], str) else a["content"]
            ) > ROWS_AS_FILE_BYTES:
                path, name = _content_file(a["content"], a.get("name"))
                a = {"name": name, "file": save_file(path, name)}
            out.append(a)
        params["attachments"] = out
    return params


def call(tool: str, params: dict[str, Any] | None = None) -> Any:
    """Call the workspace tool `tool` once and return its response body.

    An attachment may be a file the step wrote: {"name": "report.xlsx", "path": "report.xlsx"}. It is saved with
    Foundry and attached as the file itself — the way to send a large report.
    """
    ctx = _need("tool", tool)
    params = _with_saved_files(params or {})
    return _one(_post("/api/steps/tool", {"ref": tool, "params": [params], "stepId": ctx["stepId"]}), f"tool '{tool}'")
