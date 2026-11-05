"""The out-of-memory sentence states what is known — the limit and what the step was handed — and does not blame
the read's SQL when the step was handed little (the measured case was a spreadsheet built with pandas' to_excel)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from runner.run_one import RUN_MEMORY_BYTES, oom_message  # noqa: E402


class OomMessage(unittest.TestCase):
    def test_handed_little_says_it_grew_in_the_step(self):
        m = oom_message("build_report", 3 * 1024**2)
        self.assertIn(f"may use {RUN_MEMORY_BYTES // 1024**2} MB", m)
        self.assertIn("handed 3.0 MB", m)
        self.assertIn("grew inside the step", m)
        self.assertIn("foundry.write_xlsx", m)
        self.assertIn("load_workbook", m)
        self.assertIn("several sheets", m)

    def test_handed_much_says_earlier_steps_pass_too_much(self):
        m = oom_message("build_report", RUN_MEMORY_BYTES // 2)
        self.assertIn("Earlier steps pass it too much", m)
        self.assertNotIn("grew inside the step", m)
        self.assertNotIn("load_workbook", m)


if __name__ == "__main__":
    unittest.main()
