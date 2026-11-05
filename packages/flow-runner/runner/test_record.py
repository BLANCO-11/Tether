"""What the run RECORD keeps of a large value (2026-10-11): the full value goes to the next step, the record a preview."""

import json
import unittest

from runner.run_one import RECORD_CAP, RECORD_ROWS, for_record


class ForRecord(unittest.TestCase):
    def test_small_values_are_kept_whole(self):
        v = {"rows": [{"a": 1}] * 10, "total": 3}
        self.assertEqual(for_record(v), v)

    def test_a_big_list_keeps_its_count_and_first_rows(self):
        rows = [{"emp_id": i, "work_date": "2026-08-01", "hours_worked": 8.5, "emp_name": "x" * 40} for i in range(70_000)]
        out = for_record({"rows": rows, "month": 8})
        self.assertEqual(out["month"], 8)  # a small sibling stays as it is
        self.assertTrue(out["rows"]["preview"])
        self.assertEqual(out["rows"]["count"], 70_000)
        self.assertEqual(len(out["rows"]["rows"]), RECORD_ROWS)
        self.assertLess(len(json.dumps(out)), RECORD_CAP)  # what reaches the server fits its callback

    def test_a_long_string_keeps_its_start(self):
        out = for_record("y" * (RECORD_CAP + 10))
        self.assertTrue(out["preview"])
        self.assertEqual(len(out["text"]), 2000)


if __name__ == "__main__":
    unittest.main()
