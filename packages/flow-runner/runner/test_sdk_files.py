"""An attachment given by path is saved first and sent as the file's id (2026-10-12); an oversized call is refused
here with a sentence, before anything is sent."""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk"))
import foundry  # noqa: E402

SEEN: list[tuple[str, dict, bytes]] = []


class Stub(BaseHTTPRequestHandler):
    def do_GET(self):
        SEEN.append((self.path, {k.lower(): v for k, v in self.headers.items()}, b""))
        if self.path == "/api/steps/files/workspace/Rate%20card.csv":
            data, code = b"band,rate\nP1,10\n", 200
        else:
            data, code = json.dumps({"message": "There is no file named that"}).encode(), 404
        self.send_response(code)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        SEEN.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if self.path == "/api/steps/files":
            out = {"file": "f-1", "name": self.headers["x-file-name"], "bytes": len(body)}
        else:
            out = {"results": [{"ok": True, "data": {"status": "sent"}}]}
        data = json.dumps(out).encode()
        self.send_response(201 if self.path == "/api/steps/files" else 200)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class SavedFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        foundry._configure({
            "serverBase": f"http://127.0.0.1:{cls.server.server_port}",
            "token": "t", "stepId": "email_report", "uses": ["tool:foundry_email_send", "file:Rate card.csv", "file:missing.csv"],
        })

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        SEEN.clear()

    def test_a_path_attachment_is_saved_and_sent_as_its_id(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "report.xlsx")
            with open(p, "wb") as f:
                f.write(b"PK\x03\x04" + b"x" * 1000)
            foundry.call("foundry_email_send", {"subject": "s", "attachments": [{"name": "LOP report.xlsx", "path": p}]})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/files", "/api/steps/tool"])
        self.assertEqual(len(SEEN[0][2]), 1004)
        self.assertEqual(SEEN[0][1]["x-step-id"], "email_report")
        sent = json.loads(SEEN[1][2])["params"][0]["attachments"]
        self.assertEqual(sent, [{"name": "LOP report.xlsx", "file": "f-1"}])

    def test_an_oversized_call_is_refused_before_sending(self):
        with self.assertRaisesRegex(foundry.FoundryError, r"at most 5\.0 MB.*attach it by path"):
            foundry.call("foundry_email_send", {"subject": "s", "body": "x" * (6 * 1024 * 1024)})
        self.assertEqual(SEEN, [])

    def test_large_rows_become_an_excel_file_built_in_the_step(self):
        rows = [{"emp": f"E{i}", "hours": i % 9, "note": None, "tags": ["a"]} for i in range(30_000)]
        foundry.call("foundry_email_send", {"subject": "s", "attach_rows": rows, "attach_name": "Muster Report.xlsx",
                                            "attach_format": "xlsx"})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/files", "/api/steps/tool"])
        self.assertTrue(SEEN[0][2].startswith(b"PK"))  # an xlsx is a zip
        self.assertLess(len(SEEN[0][2]), 1024 * 1024)
        sent = json.loads(SEEN[1][2])["params"][0]
        self.assertEqual(sent["attachments"], [{"name": "Muster Report.xlsx", "file": "f-1"}])
        self.assertNotIn("attach_rows", sent)

    def test_rows_past_the_file_limit_become_a_zipped_csv(self):
        old = foundry.FILE_MAX_BYTES
        foundry.FILE_MAX_BYTES = 100_000
        try:
            rows = [{"emp": f"E{i}", "dept": "Operations"} for i in range(40_000)]
            foundry.call("foundry_email_send", {"subject": "s", "attach_rows": rows, "attach_format": "xlsx"})
        finally:
            foundry.FILE_MAX_BYTES = old
        sent = json.loads(SEEN[-1][2])["params"][0]
        self.assertEqual(sent["attachments"][0]["name"], "report.csv.zip")

    def test_small_rows_still_go_as_data(self):
        foundry.call("foundry_email_send", {"subject": "s", "attach_rows": [{"a": 1}], "attach_format": "csv"})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/tool"])

    def test_attachment_text_past_the_limit_travels_as_the_file(self):
        # The shape that failed a real run (2026-10-13): the whole report as CSV text in `content`.
        csv_text = "emp,hours\n" + "".join(f"E{i},{i % 9}\n" for i in range(150_000))
        foundry.call("foundry_email_send", {"subject": "s", "attachments": [{"name": "Muster.csv", "content": csv_text}]})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/files", "/api/steps/tool"])
        self.assertEqual(SEEN[0][2].decode(), csv_text)
        self.assertEqual(json.loads(SEEN[1][2])["params"][0]["attachments"], [{"name": "Muster.csv", "file": "f-1"}])

    def test_small_attachment_text_still_goes_as_text(self):
        foundry.call("foundry_email_send", {"subject": "s", "attachments": [{"name": "a.csv", "content": "a\n1\n"}]})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/tool"])

    def test_a_table_in_the_body_becomes_an_attached_file(self):
        rows = [{"emp": f"E{i}", "status": "Present"} for i in range(60)]
        foundry.call("foundry_email_send", {"subject": "Monthly muster", "body": json.dumps(rows)})
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/files", "/api/steps/tool"])
        self.assertTrue(SEEN[0][2].startswith(b"PK"))
        sent = json.loads(SEEN[1][2])["params"][0]
        self.assertEqual(sent["body"], foundry.BODY_MOVED_TO_FILE)
        self.assertEqual(sent["attachments"], [{"name": "Monthly muster.xlsx", "file": "f-1"}])

    def test_a_body_table_beside_an_attachment_is_not_attached_twice(self):
        rows = [{"emp": f"E{i}"} for i in range(60)]
        foundry.call("foundry_email_send", {"subject": "s", "body": rows, "attachments": [{"name": "a.csv", "content": "a\n"}]})
        sent = json.loads(SEEN[-1][2])["params"][0]
        self.assertEqual([s[0] for s in SEEN], ["/api/steps/tool"])
        self.assertEqual((sent["body"], sent["attachments"]), (foundry.BODY_MOVED_TO_FILE, [{"name": "a.csv", "content": "a\n"}]))

    def test_CONTROL_a_short_table_and_prose_stay_in_the_body(self):
        small = json.dumps([{"dept": "Ops", "absent": 3}])
        foundry.call("foundry_email_send", {"subject": "s", "body": small})
        foundry.call("foundry_email_send", {"subject": "s", "body": "Hi team,\n\n3 people were absent today."})
        bodies = [json.loads(x[2])["params"][0]["body"] for x in SEEN]
        self.assertEqual(bodies, [small, "Hi team,\n\n3 people were absent today."])

    def test_a_workspace_file_opens_as_a_local_path(self):
        path = foundry.file("Rate card.csv")
        with open(path) as f:
            self.assertEqual(f.read(), "band,rate\nP1,10\n")
        self.assertEqual(SEEN[0][1]["authorization"], "Bearer t")

    def test_a_file_the_step_does_not_declare_is_refused_by_name(self):
        with self.assertRaisesRegex(foundry.FoundryError, r"does not declare 'file:other.csv'"):
            foundry.file("other.csv")

    def test_a_missing_file_says_so(self):
        with self.assertRaisesRegex(foundry.FoundryError, r"file 'missing.csv': There is no file named that"):
            foundry.file("missing.csv")

if __name__ == "__main__":
    unittest.main()
