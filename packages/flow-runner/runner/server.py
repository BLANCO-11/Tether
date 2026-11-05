"""flow-runner — Foundry's own executor for Pi-built workflows (plans/pi-runtime-2026-10-09, option A).

One HTTP endpoint the API server calls to start a run. Each accepted run becomes ONE child process
(`runner.run_one`), and each step inside it ONE more (`runner.step_entry`) — P1-D1's isolation model.

⚠ The job (which carries the run's execution token) travels to the child over STDIN, never argv or env:
`/proc/<pid>/cmdline` and `/proc/<pid>/environ` are readable by the same uid. And children get a MINIMAL
environment, so this process's FLOW_RUNNER_SECRET never reaches step code.
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("FLOW_RUNNER_SECRET", "")
PORT = int(os.environ.get("FLOW_RUNNER_PORT", "4006"))
MAX_BODY = 8 * 1024 * 1024

# What a child may see. Nothing secret, nothing from this process's own configuration.
CHILD_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}


def _log(**fields: object) -> None:
    print(json.dumps({"svc": "flow-runner", **fields}), flush=True)


def _reap(proc: subprocess.Popen, execution_id: str) -> None:
    code = proc.wait()
    _log(event="run_exit", flowExecutionId=execution_id, code=code)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: object) -> None:  # quiet default access log
        return

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/runs":
            return self._send(404, {"error": "not_found"})
        presented = self.headers.get("x-runner-secret", "")
        # Constant-time, and an unset secret refuses everything rather than accepting everything.
        if not SECRET or not hmac.compare_digest(presented.encode(), SECRET.encode()):
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413 if length > MAX_BODY else 400, {"error": "bad_length"})
        try:
            job = json.loads(self.rfile.read(length))
            execution_id = str(job["flowExecutionId"])
            assert isinstance(job.get("token"), str) and job["token"]
            assert isinstance(job.get("workflow"), dict)
        except Exception as e:  # noqa: BLE001 — any malformed job is one 400
            return self._send(400, {"error": "bad_job", "message": str(e)[:200]})

        proc = subprocess.Popen(
            [sys.executable, "-m", "runner.run_one"],
            cwd="/app",
            env=CHILD_ENV,
            stdin=subprocess.PIPE,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(job).encode())
        proc.stdin.close()
        threading.Thread(target=_reap, args=(proc, execution_id), daemon=True).start()
        _log(event="run_accepted", flowExecutionId=execution_id, pid=proc.pid)
        return self._send(202, {"accepted": True, "flowExecutionId": execution_id})


def main() -> None:
    if not SECRET:
        _log(event="refusing_to_start", reason="FLOW_RUNNER_SECRET is not set")
        sys.exit(2)
    _log(event="listening", port=PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
