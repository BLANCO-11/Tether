"""The executor's control flow, without processes: which items ran, which arm was taken, where a run paused."""

import unittest

from runner.engine import Executor, Paused, Rejected, RunError


def make(workflow, inputs=None, steps=None, memo=None, decisions=None):
    """steps: {step_id: fn(params, inputs) -> dict}. Records every report and every step call."""
    calls, reports = [], []

    def run_step(node, params, given_inputs, scope):
        calls.append((node["id"], scope, params, given_inputs))
        fn = (steps or {}).get(node["id"])
        if fn is None:
            return {"ok": True}
        out = fn(params, given_inputs)
        if isinstance(out, Exception):
            raise RunError(str(out))
        return out

    def report(step_id, scope, status, output=None, error=None, given=None, checks=None, logs=None):
        reports.append((step_id, scope, status, output, error))

    ex = Executor(workflow, inputs or {}, run_step, report, memo=memo, decisions=decisions)
    return ex, calls, reports


def status_of(reports, step_id, scope=""):
    hits = [r for r in reports if r[0] == step_id and r[1] == scope]
    return hits[-1][2] if hits else None


PEOPLE = [{"name": "A", "late": 5}, {"name": "B", "late": 0}, {"name": "C", "late": 12}]


class Loops(unittest.TestCase):
    def wf(self):
        return {"steps": [
            {"id": "find", "entry": "f.py", "outputs": ["rows"]},
            {"id": "each", "foreach": "find.rows", "as": "person", "steps": [
                {"id": "write", "entry": "w.py", "inputs": {"who": "$person.name", "n": "$index"}},
                {"id": "send", "entry": "s.py", "inputs": {"text": "write.text"}},
            ]},
            {"id": "after", "entry": "a.py", "inputs": {"sent": "each.succeeded"}},
        ]}

    def test_items_run_in_order_numbered_and_each_sees_its_own_outputs(self):
        ex, calls, reports = make(self.wf(), steps={
            "find": lambda p, i: {"rows": PEOPLE},
            "write": lambda p, i: {"text": f"hi {i['who']} #{i['n']}"},
        })
        ex.run()
        sends = [(c[1], c[3]["text"]) for c in calls if c[0] == "send"]
        self.assertEqual(sends, [("1", "hi A #1"), ("2", "hi B #2"), ("3", "hi C #3")])
        self.assertEqual(calls[-1][3], {"sent": 3})
        self.assertEqual(status_of(reports, "each"), "succeeded")

    def test_an_item_that_fails_does_not_stop_the_others(self):
        ex, calls, reports = make(self.wf(), steps={
            "find": lambda p, i: {"rows": PEOPLE},
            "write": lambda p, i: RuntimeError("bad") if i["who"] == "B" else {"text": "x"},
        })
        ex.run()
        self.assertEqual([c[1] for c in calls if c[0] == "send"], ["1", "3"])
        self.assertEqual(status_of(reports, "write", "2"), "failed")
        self.assertEqual(status_of(reports, "send", "2"), "skipped")
        self.assertEqual(status_of(reports, "each"), "partial")
        self.assertEqual(ex.item_failures, 1)
        self.assertEqual(status_of(reports, "after"), "succeeded")  # the rest of the run continues

    def test_an_empty_list_runs_nothing_and_succeeds(self):
        ex, calls, reports = make(self.wf(), steps={"find": lambda p, i: {"rows": []}})
        ex.run()
        self.assertFalse([c for c in calls if c[0] in ("write", "send")])
        self.assertEqual(status_of(reports, "each"), "succeeded")

    def test_not_a_list_and_over_the_limit_are_refused(self):
        ex, _, _ = make(self.wf(), steps={"find": lambda p, i: {"rows": "nope"}})
        self.assertRaises(RunError, ex.run)
        ex, _, _ = make(self.wf(), steps={"find": lambda p, i: {"rows": [{}] * 1001}})
        self.assertRaises(RunError, ex.run)

    def test_nested_loops_keep_their_own_items(self):
        wf = {"steps": [
            {"id": "depts", "entry": "d.py"},
            {"id": "per_dept", "foreach": "depts.list", "as": "dept", "steps": [
                {"id": "per_person", "foreach": "$dept.people", "as": "person", "steps": [
                    {"id": "note", "entry": "n.py", "inputs": {"d": "$dept.name", "p": "$person", "i": "$index"}},
                ]},
            ]},
        ]}
        ex, calls, _ = make(wf, steps={"depts": lambda p, i: {"list": [
            {"name": "X", "people": ["a", "b"]}, {"name": "Y", "people": ["c"]}]}})
        ex.run()
        self.assertEqual([(c[1], c[3]) for c in calls if c[0] == "note"], [
            ("1.1", {"d": "X", "p": "a", "i": 1}), ("1.2", {"d": "X", "p": "b", "i": 2}), ("2.1", {"d": "Y", "p": "c", "i": 1})])


class Branches(unittest.TestCase):
    def wf(self):
        return {"steps": [
            {"id": "check", "entry": "c.py"},
            {"id": "route", "outputs": ["channel"], "branch": [
                {"if": {"value": "check.total", "op": "gt", "to": 1000}, "steps": [{"id": "ticket", "entry": "t.py"}],
                 "set": {"channel": "ticket.ref"}},
                {"if": {"value": "check.total", "op": "gt", "to": 0}, "steps": [{"id": "email", "entry": "e.py"}],
                 "set": {"channel": "email.ref"}},
                {"else": True, "steps": [], "set": {"channel": "none"}},
            ]},
            {"id": "log", "entry": "l.py", "inputs": {"via": "route.channel"}},
        ]}

    def run_with(self, total):
        ex, calls, reports = make(self.wf(), steps={
            "check": lambda p, i: {"total": total},
            "ticket": lambda p, i: {"ref": "T-1"},
            "email": lambda p, i: {"ref": "mail"},
        })
        ex.run()
        return calls, reports

    def test_exactly_one_arm_runs_and_says_why(self):
        calls, reports = self.run_with(1250)
        ran = [c[0] for c in calls]
        self.assertIn("ticket", ran)
        self.assertNotIn("email", ran)
        self.assertEqual(status_of(reports, "email"), "not_taken")
        route = [r for r in reports if r[0] == "route"][-1][3]
        self.assertEqual(route["taken"], "path 1")
        self.assertIn("1250", route["why"])
        self.assertEqual(calls[-1][3], {"via": "T-1"})  # the tail reads what the branch declared

    def test_the_second_arm_and_the_else(self):
        calls, _ = self.run_with(5)
        self.assertEqual([c[0] for c in calls], ["check", "email", "log"])
        calls, reports = self.run_with(0)
        self.assertEqual([c[0] for c in calls], ["check", "log"])
        self.assertEqual(calls[-1][3], {"via": "none"})
        self.assertEqual([r for r in reports if r[0] == "route"][-1][3]["taken"], "else")

    def test_a_branch_inside_a_loop_chooses_per_item(self):
        wf = {"steps": [
            {"id": "find", "entry": "f.py"},
            {"id": "each", "foreach": "find.rows", "steps": [
                {"id": "route", "branch": [
                    {"if": {"value": "$item.late", "op": "gte", "to": 10}, "steps": [{"id": "escalate", "entry": "x.py"}]},
                    {"if": {"value": "$item.late", "op": "gt", "to": 0}, "steps": [{"id": "remind", "entry": "r.py"}]},
                ]},
            ]},
        ]}
        ex, calls, reports = make(wf, steps={"find": lambda p, i: {"rows": PEOPLE}})
        ex.run()
        self.assertEqual([(c[0], c[1]) for c in calls if c[0] != "find"], [("remind", "1"), ("escalate", "3")])
        self.assertEqual([r[3]["taken"] for r in reports if r[0] == "route"], ["path 2", None, "path 1"])

    def test_conditions_combine(self):
        ex, _, _ = make({"steps": []}, inputs={"a": 3, "b": "x"})
        from runner.engine import Frame
        ok, why = ex.holds({"all": [{"value": "$input.a", "op": "gte", "to": 3},
                                    {"any": [{"value": "$input.b", "op": "in", "to": ["x", "y"]},
                                             {"not": {"value": "$input.b", "op": "empty"}}]}]}, Frame(), "t")
        self.assertTrue(ok)
        self.assertIn("$input.a (3) ≥ 3", why)
        self.assertRaises(RunError, ex.holds, {"value": "$input.b", "op": "gt", "to": 1}, Frame(), "t")


class Approvals(unittest.TestCase):
    def wf(self):
        return {"steps": [
            {"id": "find", "entry": "f.py"},
            {"id": "ok_to_send", "approval": {"title": "Send these reminders?", "review": "find.rows"}},
            {"id": "each", "foreach": "find.rows", "steps": [{"id": "send", "entry": "s.py"}]},
        ]}

    def test_pauses_before_what_follows_with_a_preview(self):
        ex, calls, _ = make(self.wf(), steps={"find": lambda p, i: {"rows": PEOPLE}})
        with self.assertRaises(Paused) as p:
            ex.run()
        self.assertEqual(p.exception.step_id, "ok_to_send")
        self.assertEqual(p.exception.preview, PEOPLE)
        self.assertIn("send", p.exception.ahead[0])
        self.assertEqual([c[0] for c in calls], ["find"])
        self.assertIn("find@", ex.memo)

    def test_approved_resume_replays_without_rerunning_and_continues(self):
        ex, _, _ = make(self.wf(), steps={"find": lambda p, i: {"rows": PEOPLE}})
        with self.assertRaises(Paused):
            ex.run()
        ex2, calls, reports = make(self.wf(), memo=ex.memo, decisions={"ok_to_send": {"decision": "approved", "by": "x"}})
        ex2.run()
        self.assertEqual([c[0] for c in calls], ["send", "send", "send"])  # find is NOT run again
        self.assertEqual(status_of(reports, "ok_to_send"), "succeeded")

    def test_rejected_runs_nothing_after_it(self):
        ex, calls, reports = make(self.wf(), memo={"find@": {"rows": PEOPLE}},
                                  decisions={"ok_to_send": {"decision": "rejected", "note": "not today"}})
        self.assertRaises(Rejected, ex.run)
        self.assertEqual(calls, [])
        self.assertEqual(status_of(reports, "ok_to_send"), "rejected")
        self.assertEqual(status_of(reports, "each"), "skipped")

    def test_an_approval_inside_a_branch_pauses_only_on_that_path(self):
        wf = {"steps": [
            {"id": "count", "entry": "c.py"},
            {"id": "big", "branch": [
                {"if": {"value": "count.n", "op": "gt", "to": 500},
                 "steps": [{"id": "ask", "approval": {"title": "Many recipients"}}, {"id": "send_big", "entry": "b.py"}]},
                {"else": True, "steps": [{"id": "send_small", "entry": "s.py"}]},
            ]},
        ]}
        ex, calls, _ = make(wf, steps={"count": lambda p, i: {"n": 10}})
        ex.run()
        self.assertEqual([c[0] for c in calls], ["count", "send_small"])
        ex, _, _ = make(wf, steps={"count": lambda p, i: {"n": 900}})
        self.assertRaises(Paused, ex.run)

    def test_never_inside_a_loop(self):
        wf = {"steps": [{"id": "find", "entry": "f.py"},
                        {"id": "each", "foreach": "find.rows", "steps": [{"id": "ask", "approval": {"title": "t"}}]}]}
        ex, _, reports = make(wf, steps={"find": lambda p, i: {"rows": [1, 2]}})
        self.assertRaises(RunError, ex.run)  # every item fails → the loop fails
        self.assertEqual(status_of(reports, "each"), "failed")


if __name__ == "__main__":
    unittest.main()
