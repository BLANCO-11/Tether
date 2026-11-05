"""The executor: a workflow's nodes, run in order — steps, loops, branches, approvals (pi-runtime P5/P7, 2026-10-10).

Pure: what a step does, how a result is reported and how a check is made are handed in, so the control flow — which
items ran, which branch was taken, where a run paused — is testable without processes or a server.

A workflow is a list of NODES. Each node is one of:

  step      {id, entry, params?, inputs?, outputs?, uses?, allow_empty?}
  loop      {id, foreach: <binding to a list>, as?: "item", steps: [nodes]}
  branch    {id, branch: [{if: <condition>, steps: [nodes], set?: {name: binding}}, ..., {else: true, steps, set?}],
             outputs?: [names]}
  approval  {id, approval: {title, review?: <binding>}}

Bindings (a param or input value that is a string):
  "$input.<name>"                a value the run was started with
  "$index"                       the current item's number (1-based) in the nearest loop
  "$<as>" / "$<as>.<field>"      the current item of the loop declared `as` (`$item` always means the nearest)
  "<stepId>.<output>"            an output of a step that already ran — in this item, or outside the loop
  anything else                  a literal

Conditions (declared, never code — a reviewer reads them, and the run records the values that decided them):
  {value: <binding>, op: eq|ne|gt|gte|lt|lte|empty|not_empty|in|contains, to?: <binding or literal>}
  {all: [conditions]} | {any: [conditions]} | {not: condition}

Behaviour (agreed with the user, 2026-10-10):
  - A loop runs its items one at a time, in order, numbered. An item that fails does not stop the others; the run
    ends "partial". At most MAX_ITEMS items.
  - A branch runs exactly one arm: the first whose condition holds, else the `else` arm, else none. Steps in the arms
    not taken are recorded as `not_taken`. After the branch, only what it declares in `outputs` (set by every arm) is
    read — never a step inside an arm.
  - An approval pauses the run before everything after it. Approve → the rest runs; reject → nothing after it runs.
    Never inside a loop: thousands of items would be thousands of approvals.
  - Resuming after an approval REPLAYS the workflow with `memo` (the outputs of every step that already ran): a
    memoised step is not run again, conditions see the same values so the same arms are taken, and execution goes
    past the approval with its decision.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

MAX_ITEMS = 1000
MAX_DEPTH = 3  # loops inside loops


class RunError(Exception):
    """The run cannot continue (a step outside any loop failed, a binding cannot be resolved, a malformed node)."""


class ItemError(Exception):
    """One loop item failed — its loop carries on with the next item."""


@dataclass
class Paused(Exception):
    step_id: str
    title: str
    preview: Any
    ahead: list[str]


class Rejected(Exception):
    """An approval was not given — `decision` is "rejected" or "expired". Nothing after it runs."""

    def __init__(self, step_id: str, decision: str) -> None:
        super().__init__(f"{step_id} was {decision}")
        self.step_id = step_id
        self.decision = decision


@dataclass
class Frame:
    outputs: dict[str, dict] = field(default_factory=dict)
    parent: "Frame | None" = None
    loop_as: str | None = None
    item: Any = None
    index: int | None = None
    depth: int = 0  # loops this frame is inside

    def find_output(self, step_id: str) -> dict | None:
        f: Frame | None = self
        while f is not None:
            if step_id in f.outputs:
                return f.outputs[step_id]
            f = f.parent
        return None

    def find_loop(self, name: str | None) -> "Frame | None":
        f: Frame | None = self
        while f is not None:
            if f.loop_as is not None and (name is None or f.loop_as == name):
                return f
            f = f.parent
        return None


def kind_of(node: dict) -> str:
    if "foreach" in node:
        return "loop"
    if "branch" in node:
        return "branch"
    if "approval" in node:
        return "approval"
    return "step"


def ids_in(nodes: list) -> list[str]:
    """Every node id in `nodes`, recursively — a loop's body, a branch's arms."""
    out: list[str] = []
    for n in nodes:
        out.append(n["id"])
        k = kind_of(n)
        if k == "loop":
            out += ids_in(n.get("steps") or [])
        elif k == "branch":
            for arm in n["branch"]:
                out += ids_in(arm.get("steps") or [])
    return out


def describe(node: dict) -> str:
    """A node in a phrase — what an approval says lies ahead."""
    k = kind_of(node)
    if k == "loop":
        inner = ", ".join(describe(n) for n in node.get("steps") or [])
        return f"for each item in {node['foreach']}: {inner}"
    if k == "branch":
        return f"{node['id']} (a choice between {len(node['branch'])} paths)"
    if k == "approval":
        return f"approval: {node['approval'].get('title', node['id'])}"
    return node["id"]


def _field(value: Any, path: str, what: str) -> Any:
    for part in path.split("."):
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise RunError(f"{what} has no field '{part}'")
    return value


class Executor:
    def __init__(
        self,
        workflow: dict,
        run_inputs: dict,
        run_step: Callable[[dict, dict, dict, str], dict],
        report: Callable[..., None],
        check: Callable[[dict, dict], tuple[list, str | None]] | None = None,
        memo: dict | None = None,
        decisions: dict | None = None,
    ) -> None:
        self.workflow = workflow
        self.run_inputs = run_inputs
        self.run_step = run_step  # (step, params, inputs, scope) -> result dict; raises on failure
        self.report = report  # (step_id, scope, status, output=None, error=None, given=None, checks=None, logs=None)
        self.check = check or (lambda step, result: ([], None))
        self.memo: dict[str, dict] = dict(memo or {})  # "stepId@scope" -> output, for steps that already ran
        self.decisions = decisions or {}  # approval step id -> {decision, by, note, at}
        self.item_failures = 0

    # ── bindings and conditions ─────────────────────────────────────────────────────────────────────────────────

    def resolve(self, value: Any, frame: Frame, where: str) -> Any:
        if not isinstance(value, str):
            return value
        v = value.strip()
        if v.startswith("$input."):
            name = v[len("$input."):]
            if name not in self.run_inputs:
                raise RunError(f"{where} needs run input '{name}', which this run was not given")
            return self.run_inputs[name]
        if v == "$index":
            loop = frame.find_loop(None)
            if loop is None:
                raise RunError(f"{where} reads $index outside a loop")
            return loop.index
        if v.startswith("$"):
            head, _, rest = v[1:].partition(".")
            loop = frame.find_loop(None if head == "item" else head)
            if loop is None:
                raise RunError(f"{where} reads ${head}, but no loop around it is named '{head}'")
            return _field(loop.item, rest, f"{where}: the current {head}") if rest else loop.item
        head, dot, rest = v.partition(".")
        if dot and rest:
            out = frame.find_output(head)
            if out is not None:
                return _field(out, rest, f"{where}: step {head}'s output")
        return value

    def holds(self, cond: Any, frame: Frame, where: str) -> tuple[bool, str]:
        """Whether a condition holds, and the sentence saying why — the values that decided it."""
        if not isinstance(cond, dict):
            raise RunError(f"{where}: a condition must be an object, got {cond!r}")
        if "all" in cond:
            parts = [self.holds(c, frame, where) for c in cond["all"]]
            return all(p[0] for p in parts), " and ".join(p[1] for p in parts)
        if "any" in cond:
            parts = [self.holds(c, frame, where) for c in cond["any"]]
            return any(p[0] for p in parts), " or ".join(p[1] for p in parts)
        if "not" in cond:
            ok, why = self.holds(cond["not"], frame, where)
            return not ok, f"not ({why})"
        name = cond.get("value")
        value = self.resolve(name, frame, where)
        op = cond.get("op")
        to = self.resolve(cond.get("to"), frame, where) if "to" in cond else None
        try:
            if op == "eq":
                ok = value == to
            elif op == "ne":
                ok = value != to
            elif op in ("gt", "gte", "lt", "lte"):
                a, b = _num(value), _num(to)
                ok = {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
            elif op == "empty":
                ok = value is None or value == "" or (hasattr(value, "__len__") and len(value) == 0)
            elif op == "not_empty":
                ok = not (value is None or value == "" or (hasattr(value, "__len__") and len(value) == 0))
            elif op == "in":
                ok = value in (to or [])
            elif op == "contains":
                ok = to in (value or [])
            else:
                raise RunError(f"{where}: unknown comparison '{op}'")
        except (TypeError, ValueError) as e:
            raise RunError(f"{where}: cannot compare {name} ({value!r}) {op} {to!r}: {e}") from None
        sym = {"eq": "=", "ne": "≠", "gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}.get(op, op)
        shown = _short(value)
        why = f"{name} ({shown}) {sym} {_short(to)}" if "to" in cond else f"{name} ({shown}) is {op.replace('_', ' ')}"
        return ok, why

    # ── running nodes ───────────────────────────────────────────────────────────────────────────────────────────

    def run(self) -> None:
        self.execute(self.workflow.get("steps") or [], Frame(), "", [])

    def execute(self, nodes: list, frame: Frame, scope: str, after: list[str]) -> None:
        for i, node in enumerate(nodes):
            rest = [describe(n) for n in nodes[i + 1:]] + after
            k = kind_of(node)
            try:
                if k == "loop":
                    self.loop(node, frame, scope, rest)
                elif k == "branch":
                    self.branch(node, frame, scope, rest)
                elif k == "approval":
                    self.approval(node, frame, scope, rest)
                else:
                    self.step(node, frame, scope)
            except (RunError, Rejected) as e:
                # Whatever comes after, at this level, did not run — and says why, so "never ran because of X" reads
                # differently from "not reported". The failure then passes up (a loop catches it per item).
                why = (f"not run: {node['id']} was {e.decision}" if isinstance(e, Rejected) else f"not run: {node['id']} failed")
                self.mark(nodes[i + 1:], scope, "skipped", why)
                raise

    def step(self, node: dict, frame: Frame, scope: str) -> None:
        sid = node["id"]
        key = f"{sid}@{scope}"
        if key in self.memo:  # ran before the pause — its output, not a second run
            frame.outputs[sid] = self.memo[key]
            return
        given: dict = {}
        try:
            given["params"] = {k: self.resolve(v, frame, f"step {sid}: param {k}") for k, v in (node.get("params") or {}).items()}
            given["inputs"] = {k: self.resolve(v, frame, f"step {sid}: input {k}") for k, v in (node.get("inputs") or {}).items()}
            result = self.run_step(node, given["params"], given["inputs"], scope)
        except RunError as e:
            self.report(sid, scope, "failed", error=str(e), given=given or None)
            raise
        findings, hollow = self.check(node, result)
        if hollow:
            self.report(sid, scope, "failed", output=result, error=hollow, given=given, checks=findings)
            raise RunError(hollow)
        frame.outputs[sid] = result
        self.memo[key] = result
        self.report(sid, scope, "succeeded", output=result, given=given, checks=findings)

    def loop(self, node: dict, frame: Frame, scope: str, after: list[str]) -> None:
        lid = node["id"]
        if frame.depth >= MAX_DEPTH:
            raise RunError(f"loop {lid}: loops nest at most {MAX_DEPTH} deep")
        items = self.resolve(node["foreach"], frame, f"loop {lid}")
        if not isinstance(items, list):
            raise RunError(f"loop {lid}: {node['foreach']} is not a list (got {type(items).__name__})")
        if len(items) > MAX_ITEMS:
            raise RunError(f"loop {lid}: {len(items)} items, over the limit of {MAX_ITEMS}")
        name = node.get("as") or "item"
        results: list[dict] = []
        for idx, item in enumerate(items, 1):
            item_scope = f"{scope}.{idx}" if scope else str(idx)
            f = Frame(parent=frame, loop_as=name, item=item, index=idx, depth=frame.depth + 1)
            try:
                self.execute(node.get("steps") or [], f, item_scope, after)
                results.append({"index": idx, "status": "succeeded", "outputs": f.outputs})
            except (RunError, ItemError) as e:  # this item only — the next one still runs
                self.item_failures += 1
                results.append({"index": idx, "status": "failed", "error": str(e)[:2000], "outputs": f.outputs})
        failed = sum(1 for r in results if r["status"] == "failed")
        out = {"items": results, "count": len(results), "succeeded": len(results) - failed, "failed": failed}
        frame.outputs[lid] = out
        status = "succeeded" if failed == 0 else ("failed" if failed == len(results) else "partial")
        summary = {k: v for k, v in out.items() if k != "items"}
        summary["body"] = ids_in(node.get("steps") or [])  # which records are this loop's items (the run view)
        self.report(lid, scope, status, output=summary,
                    error=f"{failed} of {len(results)} items failed" if failed else None)
        if failed and failed == len(results):
            raise RunError(f"loop {lid}: every item failed ({failed})")

    def branch(self, node: dict, frame: Frame, scope: str, after: list[str]) -> None:
        bid = node["id"]
        arms = node["branch"]
        chosen, why = None, "no condition held and there is no else"
        for i, arm in enumerate(arms):
            if arm.get("else"):
                chosen, why = i, "no earlier condition held"
                break
            ok, reason = self.holds(arm.get("if"), frame, f"branch {bid}, path {i + 1}")
            if ok:
                chosen, why = i, reason
                break
        label = None if chosen is None else ("else" if arms[chosen].get("else") else f"path {chosen + 1}")
        for i, arm in enumerate(arms):
            if i != chosen:
                self.mark(arm.get("steps") or [], scope, "not_taken", f"{bid} took {label or 'no path'}")
        result: dict = {"taken": label, "why": why}
        if chosen is not None:
            arm = arms[chosen]
            self.execute(arm.get("steps") or [], frame, scope, after)
            for name, binding in (arm.get("set") or {}).items():
                result[name] = self.resolve(binding, frame, f"branch {bid}: set {name}")
        frame.outputs[bid] = result
        self.report(bid, scope, "succeeded", output=result)

    def approval(self, node: dict, frame: Frame, scope: str, after: list[str]) -> None:
        aid = node["id"]
        if frame.depth > 0:
            raise RunError(f"approval {aid}: an approval cannot be inside a loop — put one before the loop")
        spec = node.get("approval") or {}
        decided = self.decisions.get(aid)
        if decided is None:
            preview = self.resolve(spec.get("review"), frame, f"approval {aid}: review") if spec.get("review") else None
            raise Paused(aid, spec.get("title") or aid, preview, after)
        out = {k: decided.get(k) for k in ("decision", "by", "note", "at")}
        if decided.get("decision") != "approved":
            decision = "expired" if decided.get("decision") == "expired" else "rejected"
            self.report(aid, scope, decision, output=out, error=decided.get("note") or None)
            raise Rejected(aid, decision)
        frame.outputs[aid] = out
        self.report(aid, scope, "succeeded", output=out)

    # ── records for what did not run ───────────────────────────────────────────────────────────────────────────

    def mark(self, nodes: list, scope: str, status: str, why: str) -> None:
        """Record every node in `nodes` (recursively) as not run — `not_taken` or `skipped`, with the reason."""
        for node in nodes:
            self.report(node["id"], scope, status, error=why)
            k = kind_of(node)
            if k == "loop":
                self.mark(node.get("steps") or [], scope, status, why)
            elif k == "branch":
                for arm in node["branch"]:
                    self.mark(arm.get("steps") or [], scope, status, why)


def _num(v: Any) -> float:
    if isinstance(v, bool):
        raise TypeError("a yes/no is not a number")
    return float(v)


def _short(v: Any) -> str:
    s = repr(v) if isinstance(v, str) else str(v)
    return s if len(s) <= 60 else s[:57] + "…"
