"""What a step returned, checked against what it declared — on every run, for every step (pi-runtime, 2026-10-10).

Why this exists: a prod run of "Monthly Employee Work Hours" returned 3,387 employees with every average NULL and
went green. Nothing looked at a step's output — a step "succeeded" when its code exited cleanly — so the next step
emailed a spreadsheet of blanks. These checks look at the data, whatever produced the hole: a bad bind, a date
format, a join, a wrong field name in code, or a period the data does not cover.

The rule, catalogue-agnostic (no table, field or goal is named here):

  - a declared output that is EMPTY (None, "", [], {}) fails the step
  - an output that is a list of rows, in which a field is empty in EVERY row, fails the step
  - unless the step DECLARES it, with a reason:
        "allow_empty": [{"output": "employees", "reason": "a month may have no one below the threshold"},
                        {"output": "employees", "field": "manager_email", "reason": "contractors have no manager"}]
    An entry with no "field" allows the output itself to be empty; with a "field", that field in every row.
  - a field empty in SOME rows is reported, never failed: partly-empty data is ordinary, and stating the count is
    what makes it visible.

Bound, stated: fields are checked on a list of rows (dicts) at the top of an output. A single dict is a result (a
tool's reply carries legitimately-null keys like `message_id` on a captured mail), so only its emptiness is checked.
Zero and False are values, not empty.

Pure: data in, findings out.
"""

from __future__ import annotations


def is_empty(v: object) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return not v.strip()
    if isinstance(v, (list, dict, tuple)):
        return len(v) == 0
    return False


def allowances(step: dict) -> list[dict]:
    raw = step.get("allow_empty") or []
    return [a for a in raw if isinstance(a, dict) and isinstance(a.get("output"), str)]


def _allowed(allows: list[dict], output: str, field: str | None) -> dict | None:
    for a in allows:
        if a.get("output") == output and (a.get("field") or None) == field:
            return a
    return None


def check_outputs(step: dict, result: dict) -> list[dict]:
    """One finding per output and per notable field. `verdict`: "failed" | "allowed" | "partial" | "ok"."""
    allows = allowances(step)
    findings: list[dict] = []
    for name in step.get("outputs") or []:
        if name not in result:
            continue  # a missing output is already a failure of its own (declared outputs not returned)
        value = result[name]
        if is_empty(value):
            a = _allowed(allows, name, None)
            findings.append({
                "output": name,
                "rows": len(value) if isinstance(value, (list, dict, tuple)) else None,
                "verdict": "allowed" if a else "failed",
                **({"reason": str(a.get("reason", ""))} if a else {}),
            })
            continue
        if not (isinstance(value, list) and all(isinstance(r, dict) for r in value)):
            findings.append({"output": name, "rows": len(value) if isinstance(value, list) else None, "verdict": "ok"})
            continue
        rows = len(value)
        fields: list[str] = []
        for r in value:
            for k in r:
                if k not in fields:
                    fields.append(k)
        bad = False
        for f in fields:
            empty = sum(1 for r in value if is_empty(r.get(f)))
            if empty == 0:
                continue
            if empty < rows:
                findings.append({"output": name, "field": f, "rows": rows, "empty": empty, "verdict": "partial"})
                continue
            a = _allowed(allows, name, f)
            bad = bad or not a
            findings.append({
                "output": name, "field": f, "rows": rows, "empty": empty,
                "verdict": "allowed" if a else "failed",
                **({"reason": str(a.get("reason", ""))} if a else {}),
            })
        if not bad:
            findings.append({"output": name, "rows": rows, "verdict": "ok"})
    return findings


def where_rows_went(reads: list | None, inputs: dict | None) -> str:
    """What the step had to work with: rows each read returned, rows each list input carried. Empty when nothing is
    known (a step that neither reads nor is given a list)."""
    had = [f'{r.get("rows", 0)} row(s) from read {r.get("read")}' for r in (reads or []) if isinstance(r, dict)]
    had += [f"{len(v)} row(s) in input {k}" for k, v in (inputs or {}).items() if isinstance(v, list)]
    return "; ".join(had)


def failure_text(step_id: str, findings: list[dict], reads: list | None = None, inputs: dict | None = None) -> str | None:
    """The step's error when a check failed — every failure, with its numbers, and how to declare a real one.

    An output with NO rows says what the step had: "it had 10 row(s) from read X and kept none" is a different problem
    from "its read returned nothing", and both differ from a field left blank — three things that used to share one
    sentence, so a person answering about blank values was answering a different question (2026-10-12).

    When one source was empty and another was not, the empty source is named instead: a match against an empty list
    keeps nothing, and that is not the step's conditions at fault (2026-11-03).
    """
    failed = [f for f in findings if f["verdict"] == "failed"]
    if not failed:
        return None
    parts = []
    whole = False
    for f in failed:
        if "field" in f:
            parts.append(f'"{f["output"]}": field "{f["field"]}" is empty in {f["empty"]} of {f["rows"]} rows')
        else:
            whole = True
            parts.append(f'"{f["output"]}" came back with nothing in it')
    text = f"step {step_id} returned empty data: " + "; ".join(parts) + "."
    if whole:
        had = where_rows_went(reads, inputs)
        sources = [(f'read {r.get("read")}', int(r.get("rows", 0))) for r in (reads or []) if isinstance(r, dict)]
        sources += [(f"input {k}", len(v)) for k, v in (inputs or {}).items() if isinstance(v, list)]
        total = sum(n for _, n in sources)
        empty = [name for name, n in sources if n == 0]
        if had and total > 0 and empty:
            names = ", ".join(f"'{n}'" for n in empty)
            verb = "was" if len(empty) == 1 else "were"
            pron = "it" if len(empty) == 1 else "them"
            which = "that source" if len(empty) == 1 else "those sources"
            text += (f" The step had {had}. {names} {verb} empty, so nothing could be matched against {pron}: check "
                     f"why {which} found nothing before changing this step's conditions.")
        elif had and total > 0:
            text += (f" The step had {had}, and kept none of them: its own conditions (a filter, a match between "
                     "tables) removed every row. On test data that usually means the test rows do not meet those "
                     "conditions or do not connect to each other; on real data, check the conditions.")
        elif had:
            text += (f" Its data was empty before the step did anything ({had}): the read found nothing for these "
                     "values.")
    text += (" If it can genuinely be empty, the step must declare it under \"allow_empty\" with a reason;"
             " otherwise the read or the code is not returning what the step is for.")
    return text
