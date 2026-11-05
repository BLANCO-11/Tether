"""One workflow run, in its own process. Reads the job from stdin (see server.py for why not argv/env).

Job: {flowExecutionId, token, serverBase, workflow, files: {relpath: text}, inputs, stepTimeoutSeconds?}

The workflow is Forge's `workflow.json`:
  reads: {name: {datasource, sql, params?: [..]} | {ref, kind: "operation"|"query"}}
  steps: [nodes] — steps, loops, branches and approvals; the grammar and bindings are in engine.py.

A run that reaches an approval hands its state back to the server (`/pause`) and exits; the server starts it again with
the decision and `resume.memo`, and engine.py replays to where it stopped (P5, 2026-10-10).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from runner.checks import check_outputs, failure_text
from runner.isolation import (
    claim_uid,
    hand_over,
    RUN_MEMORY_BYTES,
    kill_group,
    make_group,
    oom_kills,
    prepare_run_dir,
    reap,
    release_uid,
    remove_group,
    step_popen_kwargs,
    sweep,
)
# A step's result is its ONE stdout line, read in chunks on a thread. The old 1 MB cap on it (D-20's, from the Kestra
# era) was a policy, not a limit of the channel, and a month of attendance rows is ~13 MB (2026-10-11). A file in the
# run's directory was tried and is the wrong channel: the directory is the run uid's, 0700, and the runner holds no
# DAC_OVERRIDE (isolation.py) — it cannot read it, by design. RESULT_CAP is the ceiling that stops a runaway read; RECORD_CAP is what the run RECORD keeps of one value — larger values are kept as
# a preview (count + first rows), because the server's callback takes 5 MB and the record is for reading, not replay.
RESULT_CAP = 100_000_000
RECORD_CAP = 256_000
RECORD_ROWS = 20
MEMO_CAP = 4_000_000  # what a run waiting at an approval may hold for its replay — under the server's 5 MB callback
LOG_CAP = 40_000  # characters of one step's printed output kept on its record (the tail — where an error is)


from runner.engine import Executor, Paused, Rejected, RunError  # noqa: E402 — the one RunError

PREVIEW_ROWS = 20  # an approval shows the count and this many rows of what it reviews


def log(**fields: object) -> None:
    print(json.dumps({"svc": "flow-runner", **fields}, default=str), flush=True)


def write_files(root: str, files: dict) -> None:
    for rel, text in (files or {}).items():
        norm = os.path.normpath(rel)
        if norm.startswith("..") or os.path.isabs(norm):
            raise RunError(f"file path escapes the run directory: {rel}")
        dest = os.path.join(root, norm)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(text)


def step_logs(job: dict, stderr: str) -> str:
    """What a step printed, as kept on its record: the tail, with the run's token masked.

    Logs are free text, so key-name redaction cannot see into them. The execution token is the one secret a step
    can reach (the foundry module holds it), and only the runner knows its value — so it is masked here.
    """
    text = stderr.replace(job["token"], "[redacted]") if job.get("token") else stderr
    return text[-LOG_CAP:]


def run_step(step: dict, workflow: dict, job: dict, workdir: str, params: dict, inputs: dict, captured: dict,
             uid: int, group: str | None = None) -> dict:
    payload = {
        "entry": os.path.join(workdir, step["entry"]),
        "params": params,
        "inputs": inputs,
        "ctx": {
            "serverBase": job["serverBase"],
            "token": job["token"],
            "flowExecutionId": job["flowExecutionId"],
            "stepId": step["id"],
            "uses": step.get("uses") or [],
            "reads": workflow.get("reads") or {},
        },
    }
    timeout = int(job.get("stepTimeoutSeconds") or 300)
    # As the run's own uid, in its own process group, under rlimits (isolation.py). The token travels on stdin.
    proc = subprocess.Popen(
        [sys.executable, "/app/runner/step_entry.py"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **step_popen_kwargs(uid, workdir, timeout, group),
    )
    kills_before = oom_kills(group)
    # Output is read on threads, and the wait is on the STEP, not on its pipes: a child that escaped the step's
    # process group keeps the pipes open, and waiting for them to close would wait for as long as it lives.
    chunks: dict[str, list[bytes]] = {"out": [], "err": []}
    readers = [threading.Thread(target=_drain, args=(proc.stdout, chunks["out"]), daemon=True),
               threading.Thread(target=_drain, args=(proc.stderr, chunks["err"]), daemon=True)]
    for t in readers:
        t.start()
    assert proc.stdin is not None
    try:
        proc.stdin.write(json.dumps(payload, default=str).encode())
        proc.stdin.close()
    except BrokenPipeError:
        pass
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(proc.pid)  # the step and anything in its group
        proc.wait()
    reap(uid)  # and anything it left outside the group
    for t in readers:
        t.join(timeout=2)
    if timed_out:
        raise subprocess.TimeoutExpired(proc.args, timeout)
    if oom_kills(group) > kills_before:
        raise RunError(
            f"step {step['id']}: ran out of memory — a run may use {RUN_MEMORY_BYTES // 1024**2} MB. "
            "Filter, group or total in the read's SQL so the step holds less data at once."
        )
    out = b"".join(chunks["out"]).decode("utf-8", "replace").strip().splitlines()
    err = b"".join(chunks["err"]).decode("utf-8", "replace")
    captured["logs"] = step_logs(job, err)
    last = out[-1] if out else ""
    if len(last) > RESULT_CAP:
        raise RunError(
            f"step {step['id']}: returned {len(last) / 1e6:.1f} MB, over the {RESULT_CAP / 1e6:.0f} MB a step may pass on. "
            "Filter, group or total in the read's SQL so the step returns only what later steps need."
        )
    try:
        msg = json.loads(last)
    except json.JSONDecodeError:
        raise RunError(f"step {step['id']}: no result (exit {proc.returncode}). stderr tail: {err[-1500:]}")
    if not msg.get("ok"):
        # The traceback is kept for whoever debugs it (the logs), never put in the sentence a person reads.
        if msg.get("trace"):
            captured["logs"] = (captured.get("logs", "") + "\n" + step_logs(job, str(msg["trace"]))).strip()[-LOG_CAP:]
        raise RunError(f"step {step['id']}: {msg.get('error', 'failed')}")
    result = msg.get("result")
    captured["reads"] = msg.get("reads") or []
    if not isinstance(result, dict):
        raise RunError(f"step {step['id']}: run() must return a dict, got {type(result).__name__}")
    missing = [k for k in step.get("outputs") or [] if k not in result]
    if missing:
        raise RunError(f"step {step['id']}: declared outputs not returned: {', '.join(missing)}")
    return result


def _drain(pipe, into: list) -> None:
    for chunk in iter(lambda: pipe.read(65536), b""):
        into.append(chunk)


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def _record_headers(job: dict) -> dict:
    """The run's token AND the runner's own key for its record (server: runner-report-key.ts). The key is never put
    in a step's context, so a step's code cannot write results, pause or complete its run — only this process can."""
    h = {"authorization": f"Bearer {job['token']}", "content-type": "application/json"}
    if job.get("reportKey"):
        h["x-runner-report"] = job["reportKey"]
    return h


def report_step(job: dict, step_id: str, status: str, started: float, output: object = None, error: str | None = None,
                given: dict | None = None, logs: str | None = None, checks: list | None = None, scope: str = "") -> None:
    """Write one step's result to Foundry (runner_step_results). Best effort, retried; never fails the run itself —
    the run's own status is what `complete` carries. `given` is what the step was called with, after binding."""
    body: dict = {"status": status, "startedAt": _iso(started), "endedAt": _iso(time.time())}
    if scope:
        body["scope"] = scope
    if output is not None:
        body["output"] = for_record(output)
    if given is not None:
        body["input"] = for_record(given)
    if logs:
        body["logs"] = logs
    if checks is not None:
        body["checks"] = checks
    if error:
        body["error"] = error[:20000]
    url = f"{job['serverBase']}/api/executions/{job['flowExecutionId']}/steps/{step_id}/result"
    data = json.dumps(body, default=str).encode()
    for attempt in range(1, 4):
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers=_record_headers(job))
        try:
            with urllib.request.urlopen(req, timeout=30):
                return
        except urllib.error.HTTPError as e:
            log(event="report_failed", flowExecutionId=job["flowExecutionId"], stepId=step_id, http=e.code, body=e.read()[:300])
            if e.code < 500:
                return
        except (urllib.error.URLError, OSError) as e:
            log(event="report_failed", flowExecutionId=job["flowExecutionId"], stepId=step_id, error=str(e)[:200])
        time.sleep(attempt)


def _post(job: dict, path: str, body: dict, attempts: int = 5) -> bool:
    """POST to the server with the run's token, retried on 5xx / no connection. False when it never landed."""
    url = f"{job['serverBase']}/api/executions/{job['flowExecutionId']}{path}"
    data = json.dumps(body, default=str).encode()
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers=_record_headers(job))
        try:
            with urllib.request.urlopen(req, timeout=60):
                return True
        except urllib.error.HTTPError as e:
            log(event="post_failed", path=path, flowExecutionId=job["flowExecutionId"], http=e.code, body=e.read()[:300])
            if e.code < 500:
                return False
        except (urllib.error.URLError, OSError) as e:
            log(event="post_failed", path=path, flowExecutionId=job["flowExecutionId"], error=str(e)[:200])
        time.sleep(min(2 ** attempt, 20))
    return False


def for_record(value: object) -> object:
    """What the run RECORD keeps of one value: itself, or — past RECORD_CAP — a preview a person can still read.

    The full value went to the next step; the record is what the run page shows and the server stores, and the
    server's callback takes 5 MB. A list keeps its count and first rows; a long string its start; anything else its size.
    """
    try:
        size = len(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return value
    if size <= RECORD_CAP:
        return value
    if isinstance(value, list):
        return {"preview": True, "count": len(value), "rows": value[:RECORD_ROWS], "bytes": size}
    if isinstance(value, str):
        return {"preview": True, "text": value[:2000], "bytes": size}
    if isinstance(value, dict):
        return {k: for_record(v) for k, v in value.items()}
    return {"preview": True, "bytes": size}


def preview_of(value: object) -> object:
    """What an approval shows of what it reviews: a list as its count and first rows; anything else as it is."""
    if isinstance(value, list):
        return {"count": len(value), "rows": value[:PREVIEW_ROWS]}
    return value


def complete(job: dict, status: str) -> None:
    """Close the run on the server. Retried: a run nobody closes stays `running` and holds an M3 slot (I-10).

    A 4xx is final (the token was refused — retrying cannot change that); a 5xx or no connection is retried.
    """
    url = f"{job['serverBase']}/api/executions/{job['flowExecutionId']}/complete"
    for attempt in range(1, 6):
        req = urllib.request.Request(
            url,
            data=json.dumps({"status": status}).encode(),
            headers=_record_headers(job),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                log(event="completed", flowExecutionId=job["flowExecutionId"], status=status, http=r.status)
                return
        except urllib.error.HTTPError as e:
            log(event="complete_failed", flowExecutionId=job["flowExecutionId"], attempt=attempt, http=e.code,
                body=e.read()[:500])
            if e.code < 500:
                return
        except (urllib.error.URLError, OSError) as e:
            log(event="complete_failed", flowExecutionId=job["flowExecutionId"], attempt=attempt, error=str(e)[:200])
        time.sleep(min(2 ** attempt, 20))
    log(event="complete_gave_up", flowExecutionId=job["flowExecutionId"], status=status)


def main() -> None:
    job = json.load(sys.stdin)
    execution_id = job["flowExecutionId"]
    workflow = job["workflow"]
    resume = job.get("resume") or {}
    status = "failed"
    t0 = time.time()
    uid: int | None = None
    workdir: str | None = None
    group: str | None = None
    try:
        uid = claim_uid()
        group = make_group(uid)
        workdir = prepare_run_dir(execution_id, uid)
        log(event="run_started", flowExecutionId=execution_id, uid=uid, resumed=bool(resume))
        write_files(workdir, job.get("files") or {})
        hand_over(workdir, uid)
        # Declared defaults first, then what the run was started with — a value given always wins.
        declared = workflow.get("inputs") or {}
        run_inputs = {k: d["default"] for k, d in declared.items() if isinstance(d, dict) and "default" in d}
        run_inputs.update(job.get("inputs") or {})
        if not workflow.get("steps"):
            raise RunError("workflow has no steps")

        started: dict[tuple[str, str], float] = {}
        logs: dict[tuple[str, str], str] = {}
        last_reads: dict[str, list] = {}
        last_inputs: dict[str, dict] = {}

        def do_step(node: dict, params: dict, inputs: dict, scope: str) -> dict:
            started[(node["id"], scope)] = time.time()
            captured: dict = {}
            try:
                return run_step(node, workflow, job, workdir, params, inputs, captured, uid, group)
            except subprocess.TimeoutExpired:
                raise RunError(f"step {node['id']}: did not finish within {int(job.get('stepTimeoutSeconds') or 300)}s") from None
            finally:
                if captured.get("logs"):
                    logs[(node["id"], scope)] = captured["logs"]
                last_reads[node["id"]] = captured.get("reads") or []
                last_inputs[node["id"]] = inputs

        def report(step_id: str, scope: str, status_: str, output=None, error=None, given=None, checks=None, logs_=None):
            report_step(job, step_id, status_, started.get((step_id, scope), time.time()), output=output, error=error,
                        given=given, logs=logs.get((step_id, scope)), checks=checks, scope=scope)

        def check(node: dict, result: dict):
            findings = check_outputs(node, result)
            return findings, failure_text(node["id"], findings, last_reads.get(node["id"]), last_inputs.get(node["id"]))

        ex = Executor(workflow, run_inputs, do_step, report, check,
                      memo=resume.get("memo"), decisions=resume.get("decisions"))
        try:
            ex.run()
            status = "partial" if ex.item_failures else "succeeded"
        except Paused as p:
            # Hand the run back: the server records the approval and starts it again once someone decides. The memo
            # is every output so far, unredacted — what the replay needs, kept server-side until the run ends.
            memo_size = len(json.dumps(ex.memo, default=str))
            if memo_size > MEMO_CAP:
                why = (
                    f"approval {p.step_id}: the data held while it waits is {memo_size / 1e6:.1f} MB, over the "
                    f"{MEMO_CAP / 1e6:.0f} MB a waiting run can keep. Summarise it in the reads before the approval "
                    "(count, group or total), so less is carried across the wait."
                )
                report_step(job, p.step_id, "failed", time.time(), error=why)
                raise RunError(why)
            report_step(job, p.step_id, "waiting", time.time(), output={"title": p.title, "ahead": p.ahead})
            landed = _post(job, "/pause", {
                "stepId": p.step_id,
                "title": p.title,
                "preview": preview_of(p.preview),
                "ahead": p.ahead,
                "memo": ex.memo,
            })
            if landed:
                status = "waiting"
                log(event="run_paused", flowExecutionId=execution_id, stepId=p.step_id)
            else:
                log(event="pause_failed", flowExecutionId=execution_id, stepId=p.step_id)
        except Rejected as r:
            status = r.decision
            log(event="run_stopped", flowExecutionId=execution_id, stepId=r.step_id, decision=r.decision)
    except RunError as e:
        log(event="run_failed", flowExecutionId=execution_id, error=str(e)[:2000])
    except Exception as e:  # noqa: BLE001 — a runner bug must still close the run
        log(event="runner_error", flowExecutionId=execution_id, error=repr(e)[:2000])
    finally:
        if uid is not None and workdir is not None:
            sweep(uid, workdir)
        if group is not None:
            remove_group(group)
        if uid is not None:
            release_uid(uid)
        log(event="run_done", flowExecutionId=execution_id, status=status, ms=int((time.time() - t0) * 1000))
        if status != "waiting":  # a paused run is closed by whoever decides, not here
            complete(job, status)


if __name__ == "__main__":
    main()
