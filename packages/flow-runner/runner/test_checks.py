"""python -m unittest runner.test_checks — the output checks, against the shape of the run that motivated them."""

import unittest

from runner.checks import check_outputs, failure_text

STEP = {"id": "list_employee_hours", "outputs": ["employees"]}


def rows(n: int, hours: object) -> list[dict]:
    return [{"employee_id": str(i), "name": f"e{i}", "avg_working_hours_per_day": hours} for i in range(n)]


class OutputChecks(unittest.TestCase):
    def test_the_prod_run_a_field_empty_in_every_row_fails_the_step(self):
        f = check_outputs(STEP, {"employees": rows(3387, None)})
        text = failure_text("list_employee_hours", f)
        self.assertIsNotNone(text)
        self.assertIn('field "avg_working_hours_per_day" is empty in 3387 of 3387 rows', text)

    def test_control_the_same_rows_with_values_pass(self):
        f = check_outputs(STEP, {"employees": rows(3387, 7.5)})
        self.assertIsNone(failure_text("x", f))
        self.assertEqual([x["verdict"] for x in f], ["ok"])

    def test_a_field_empty_in_some_rows_is_reported_never_failed(self):
        data = rows(10, 7.5)
        for r in data[:3]:
            r["avg_working_hours_per_day"] = None
        f = check_outputs(STEP, {"employees": data})
        self.assertIsNone(failure_text("x", f))
        self.assertIn({"output": "employees", "field": "avg_working_hours_per_day", "rows": 10, "empty": 3, "verdict": "partial"}, f)

    def test_an_empty_list_fails_unless_declared(self):
        self.assertIsNotNone(failure_text("x", check_outputs(STEP, {"employees": []})))
        allowed = {**STEP, "allow_empty": [{"output": "employees", "reason": "nobody may be below the threshold"}]}
        f = check_outputs(allowed, {"employees": []})
        self.assertIsNone(failure_text("x", f))
        self.assertEqual(f[0]["verdict"], "allowed")
        self.assertEqual(f[0]["reason"], "nobody may be below the threshold")

    def test_a_declared_field_passes_and_the_declaration_is_per_field(self):
        step = {**STEP, "allow_empty": [{"output": "employees", "field": "avg_working_hours_per_day", "reason": "r"}]}
        self.assertIsNone(failure_text("x", check_outputs(step, {"employees": rows(5, None)})))
        # control: allowing the OUTPUT to be empty does not allow a field in its rows to be
        output_only = {**STEP, "allow_empty": [{"output": "employees", "reason": "r"}]}
        self.assertIsNotNone(failure_text("x", check_outputs(output_only, {"employees": rows(5, None)})))

    def test_zero_and_false_are_values_and_blank_text_is_empty(self):
        step = {"id": "s", "outputs": ["r"]}
        self.assertIsNone(failure_text("s", check_outputs(step, {"r": [{"n": 0, "ok": False}]})))
        self.assertIsNotNone(failure_text("s", check_outputs(step, {"r": [{"name": "  "}]})))

    def test_a_single_result_object_is_checked_for_emptiness_only(self):
        # a captured mail's reply carries message_id: null by design — that is not hollow data
        step = {"id": "send", "outputs": ["email_result"]}
        self.assertIsNone(failure_text("send", check_outputs(step, {"email_result": {"status": "captured", "message_id": None}})))
        self.assertIsNotNone(failure_text("send", check_outputs(step, {"email_result": None})))



class WhereRowsWent(unittest.TestCase):
    """An output with no rows says what the step had, so "kept none" is not confused with "read none" or blanks."""

    STEP = {"id": "classify", "outputs": ["report_rows"]}

    def test_rows_read_and_none_kept(self):
        text = failure_text("classify", check_outputs(self.STEP, {"report_rows": []}), [{"read": "muster", "rows": 10}], {})
        self.assertIn("The step had 10 row(s) from read muster, and kept none of them", text)

    def test_the_read_found_nothing(self):
        text = failure_text("classify", check_outputs(self.STEP, {"report_rows": []}), [{"read": "muster", "rows": 0}], {})
        self.assertIn("Its data was empty before the step did anything (0 row(s) from read muster)", text)

    def test_rows_given_as_input(self):
        text = failure_text("email", check_outputs({"id": "email", "outputs": ["sent"]}, {"sent": []}), [], {"rows": [{}] * 4})
        self.assertIn("4 row(s) in input rows", text)

    def test_a_blank_field_says_nothing_about_rows(self):
        f = check_outputs(self.STEP, {"report_rows": [{"remark": ""}]})
        self.assertNotIn("row(s) from read", failure_text("classify", f, [{"read": "muster", "rows": 10}], {}))


if __name__ == "__main__":
    unittest.main()
