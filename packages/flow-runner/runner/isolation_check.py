"""The P5b exit check: can one run reach another's token, files or processes? Run INSIDE the flow-runner container.

    docker exec foundry-flow-runner python -m runner.isolation_check

Two runs at once, through the real run_one: run A's step writes its own execution token into its run directory and
then holds it in memory; run B's step — knowing A's execution id and the token's prefix, the worst case — tries to read
that file, list A's processes, read their environment and scan their memory for the token. Then three limit checks:
memory, process count, and a timeout that must kill what the step started.

⚠ The CONTROL is the point: the same two runs with FLOW_RUNNER_ISOLATION=off (every step as one shared uid) must let
B read A's token. Without it, "B found nothing" could mean B's probes are broken, not that A is protected.

Server calls go to a local stub that records them; nothing reaches Foundry. Exit 0 = isolated AND the control leaked.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECORDED: dict[str, list] = {}

HOLDER = """
import os, time, foundry
def run(params, inputs):
    with open(os.path.join(os.getcwd(), "left_here.txt"), "w") as f:
        f.write(foundry._ctx["token"])
    time.sleep(params["hold"])
    return {"done": True}
"""

PROBER = """
import os
def run(params, inputs):
    found = {}
    try:
        found["file"] = open(f"/runs/{params['target']}/left_here.txt").read()
    except Exception as e:
        found["file"] = "refused: " + type(e).__name__
    me = os.getpid()
    others = []
    for p in os.listdir("/proc"):
        if p.isdigit() and int(p) != me:
            try:
                if b"step_entry" in open(f"/proc/{p}/cmdline", "rb").read():
                    others.append(p)
            except Exception:
                pass
    found["other_steps_visible"] = len(others)
    environ, memory = [], []
    for p in others:
        try:
            environ.append(open(f"/proc/{p}/environ", "rb").read()[:40].decode("latin1"))
        except Exception as e:
            environ.append("refused: " + type(e).__name__)
        try:
            hit = False
            with open(f"/proc/{p}/maps") as maps, open(f"/proc/{p}/mem", "rb") as mem:
                for line in maps:
                    if "rw-p" not in line:
                        continue
                    a, b = (int(x, 16) for x in line.split()[0].split("-"))
                    if b - a > 64_000_000:
                        continue
                    try:
                        mem.seek(a)
                        if params["needle"].encode() in mem.read(b - a):
                            hit = True
                            break
                    except Exception:
                        continue
            memory.append("token found" if hit else "read, token not found")
        except Exception as e:
            memory.append("refused: " + type(e).__name__)
    found["environ"] = environ
    found["memory"] = memory
    return {"found": found}
"""

HOG = """
def run(params, inputs):
    out = {}
    try:
        bytearray(3 * 1024**3)
        out["memory"] = "allocated 3 GiB"
    except MemoryError:
        out["memory"] = "refused"
    import subprocess
    procs = []
    try:
        for _ in range(100):
            procs.append(subprocess.Popen(["sleep", "30"]))
        out["processes"] = "started 100"
    except Exception as e:
        out["processes"] = f"stopped at {len(procs)}: {type(e).__name__}"
    for p in procs:
        p.kill()
    return out
"""

RUNAWAY = """
import subprocess, time
def run(params, inputs):
    subprocess.Popen(["sleep", "600"])  # a child it never waits for — dies with the step's process group
    subprocess.Popen(["sleep", "601"], start_new_session=True)  # one that ESCAPES the group; only the sweep can end it
    time.sleep(600)
    return {"never": True}
"""


class Stub(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        RECORDED.setdefault(self.path, []).append(json.loads(body or b"{}"))
        self.send_response(200)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a: object) -> None:
        return


def start_run(base: str, exec_id: str, token: str, step_id: str, code: str, params: dict, isolation: str,
              timeout: int = 60) -> subprocess.Popen:
    job = {
        "flowExecutionId": exec_id,
        "token": token,
        "serverBase": base,
        "workflow": {"steps": [{"id": step_id, "entry": f"steps/{step_id}/main.py", "params": params,
                                "outputs": [], "uses": []}]},
        "files": {f"steps/{step_id}/main.py": code},
        "inputs": {},
        "stepTimeoutSeconds": timeout,
    }
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "FLOW_RUNNER_ISOLATION": isolation}
    p = subprocess.Popen([sys.executable, "-m", "runner.run_one"], cwd="/app", env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert p.stdin is not None
    p.stdin.write(json.dumps(job).encode())
    p.stdin.close()
    return p


def finish(p: subprocess.Popen) -> str:
    assert p.stdout is not None
    out = p.stdout.read().decode("utf-8", "replace")
    p.wait(120)
    return out


def result_of(exec_id: str, step_id: str) -> dict:
    rows = RECORDED.get(f"/api/executions/{exec_id}/steps/{step_id}/result") or [{}]
    return rows[-1]


def uid_of(log: str) -> int | None:
    for line in log.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("event") == "run_started":
            return int(ev["uid"])
    return None


def uid_has_processes(uid: int) -> bool:
    """As the uid itself, list /proc — hidepid still shows a uid its own processes.

    ⚠ Not kill(-1, 0): Linux reports success for it whenever ANY other process exists, even ones it may not signal
    (the EPERMs are counted, not returned), so it cannot tell "this uid has a process" from "something exists".
    """
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            me = os.getpid()
            mine = [p for p in os.listdir("/proc") if p.isdigit() and int(p) != me]
            os._exit(1 if mine else 0)
        except BaseException:
            os._exit(2)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) == 1


def attempt(base: str, isolation: str) -> dict:
    tag = secrets.token_hex(4)
    a_id, b_id = f"iso-a-{tag}", f"iso-b-{tag}"
    token_a = f"tokA-{secrets.token_hex(16)}"
    a = start_run(base, a_id, token_a, "hold", HOLDER, {"hold": 6}, isolation)
    time.sleep(2)
    b = start_run(base, b_id, f"tokB-{secrets.token_hex(16)}", "probe", PROBER, {"target": a_id, "needle": token_a},
                  isolation)
    b_log, a_log = finish(b), finish(a)
    if os.environ.get("ISO_DEBUG"):
        print(a_log, b_log, json.dumps(RECORDED)[:2000])
    found = (result_of(b_id, "probe").get("output") or {}).get("found") or {}
    leaked = found.get("file") == token_a or any("token found" == m for m in found.get("memory", []))
    return {"isolation": isolation, "found": found, "B read A's token": leaked,
            "A's directory gone": not os.path.exists(f"/runs/{a_id}")}


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    print(f"/proc mount: {next(l for l in open('/proc/mounts') if ' /proc ' in l).strip()}")

    on = attempt(base, "on")
    off = attempt(base, "off")
    for r in (on, off):
        print(json.dumps(r, indent=2))

    tag = secrets.token_hex(4)
    hog = start_run(base, f"iso-hog-{tag}", "tokH", "hog", HOG, {}, "on")
    finish(hog)
    hog_out = result_of(f"iso-hog-{tag}", "hog")
    print("limits:", json.dumps(hog_out.get("output") or hog_out.get("error", "")[:300]))

    run_id = f"iso-run-{tag}"
    runaway = start_run(base, run_id, "tokR", "runaway", RUNAWAY, {}, "on", timeout=3)
    log = finish(runaway)
    uid = uid_of(log)
    # A killed process lingers until PID 1 reaps it; give that a moment before calling it a survivor.
    left = None
    if uid is not None:
        for _ in range(30):
            left = uid_has_processes(uid)
            if not left:
                break
            time.sleep(0.1)
    print(f"timeout: step error = {result_of(run_id, 'runaway').get('error', '')[:120]!r}; uid {uid} still has processes: {left}")

    ok = (
        not on["B read A's token"]
        and on["found"].get("other_steps_visible") == 0
        and off["B read A's token"]
        and on["A's directory gone"]
        and (hog_out.get("output") or {}).get("memory") == "refused"
        and str((hog_out.get("output") or {}).get("processes", "")).startswith("stopped at")
        and left is False
    )
    print("ISOLATION CHECK:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
