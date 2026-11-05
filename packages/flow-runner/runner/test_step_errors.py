"""What a person reads when a step fails (2026-10-13): one sentence, never a traceback or a raw JSON body.

Chat 8d7e37dc's run showed `FoundryError: /api/steps/query → 504: {"error":"…"}` followed by a Python traceback. The
server's sentence was in there, under two layers of noise: the SDK read only `message` (step routes answer `error`),
and the step entry put the traceback in the error itself.
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk"))
sys.path.insert(0, os.path.dirname(__file__))
import foundry  # noqa: E402
from step_entry import failure_message  # noqa: E402

SAID = 'operation "hr_data.pi:muster_rows": The read took longer than 2 minutes and was stopped.'


class Refuses(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["content-length"]))
        key = "message" if self.path.endswith("/message") else "error"
        data = json.dumps({key: SAID}).encode()
        self.send_response(504)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class ServerSentence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Refuses)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        foundry._configure({"serverBase": f"http://127.0.0.1:{cls.server.server_port}", "token": "t", "stepId": "s", "uses": []})

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_an_error_body_is_the_message(self):
        with self.assertRaises(foundry.FoundryError) as c:
            foundry._post("/api/steps/query", {})
        self.assertEqual(str(c.exception), SAID)
        self.assertEqual((c.exception.path, c.exception.status), ("/api/steps/query", 504))

    def test_a_message_body_still_is(self):
        with self.assertRaises(foundry.FoundryError) as c:
            foundry._post("/api/x/message", {})
        self.assertEqual(str(c.exception), SAID)


class FailureMessage(unittest.TestCase):
    def test_a_platform_refusal_is_its_own_sentence(self):
        self.assertEqual(failure_message(foundry.FoundryError(SAID, path="/p", status=504), "/w/main.py"), SAID)

    def test_a_code_error_names_the_line_of_the_steps_file_and_no_traceback(self):
        entry = "/w/steps/build/main.py"
        code = compile("def run():\n    x = 1\n    raise ValueError('There are no muster rows for that month.')\n", entry, "exec")
        ns: dict = {}
        exec(code, ns)
        try:
            ns["run"]()
        except ValueError as e:
            msg = failure_message(e, entry)
        self.assertEqual(msg, "ValueError (main.py, line 3): There are no muster rows for that month.")
        self.assertNotIn("Traceback", msg)

    def test_an_error_outside_the_step_file_has_no_line(self):
        try:
            {}["missing"]
        except KeyError as e:
            self.assertEqual(failure_message(e, "/w/steps/build/main.py"), "KeyError: 'missing'")


if __name__ == "__main__":
    unittest.main()
