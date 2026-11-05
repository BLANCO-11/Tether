"""The runner's own key for a run's record (plugins phase 9, P9-I2): sent on its record calls, never given to a step.

The execution token reaches step code (the `foundry` library needs it), so the server also asks for this key before it
records a result, a pause or the end of a Forge run. What is pinned: the record calls carry it, and the context a step
is started with does not.
"""

import io
import json
import unittest
from unittest import mock

from runner import run_one

JOB = {"flowExecutionId": "e1", "token": "tok", "reportKey": "rk-secret", "serverBase": "http://server:4000"}


class RecordHeaders(unittest.TestCase):
    def test_the_record_calls_carry_the_token_and_the_key(self):
        h = run_one._record_headers(JOB)
        self.assertEqual(h["authorization"], "Bearer tok")
        self.assertEqual(h["x-runner-report"], "rk-secret")

    def test_no_key_no_header(self):
        self.assertNotIn("x-runner-report", run_one._record_headers({**JOB, "reportKey": None}))


class StepNeverSeesTheKey(unittest.TestCase):
    def test_the_step_context_has_the_token_and_not_the_key(self):
        written = io.BytesIO()

        class FakeProc:
            pid = 1
            stdin = written
            stdout = io.BytesIO(b'{"ok": true, "result": null}\n')
            stderr = io.BytesIO(b"")
            returncode = 0

            def wait(self, timeout=None):
                return 0

        written.close = lambda: None  # keep the bytes readable after run_step closes stdin
        with mock.patch.object(run_one.subprocess, "Popen", return_value=FakeProc()), \
                mock.patch.object(run_one, "step_popen_kwargs", return_value={}), \
                mock.patch.object(run_one, "oom_kills", return_value=0), \
                mock.patch.object(run_one, "reap"):
            try:
                run_one.run_step({"id": "s", "entry": "s.py", "uses": []}, {"steps": []}, JOB, "/tmp", {}, {}, {}, 30001)
            except Exception:  # noqa: BLE001 — only what reached the step's stdin is under test
                pass
        payload = json.loads(written.getvalue())
        self.assertEqual(payload["ctx"]["token"], "tok")
        self.assertNotIn("rk-secret", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
