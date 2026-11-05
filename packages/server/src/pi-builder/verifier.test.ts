import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Runs the REAL verifier (pi-builder-template/verifier/verify.mjs) against a sandbox laid out the way Pi writes one. */
function verify(step: Record<string, unknown>, opts: { mine?: unknown; code?: string; reads?: Record<string, unknown> } = {}): { ok: boolean; out: string } {
  // realpath: macOS's tmpdir is a symlink, and the verifier only runs as a program when argv[1] is its real path —
  // otherwise it prints nothing and exits 0, which reads as a pass.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-verify-")));
  mkdirSync(join(root, "verifier"));
  mkdirSync(join(root, "sandbox/steps/load"), { recursive: true });
  copyFileSync(resolve(__dirname, "../../pi-builder-template/verifier/verify.mjs"), join(root, "verifier/verify.mjs"));
  writeFileSync(join(root, "sandbox/steps/load/main.py"), opts.code ?? "def run(params, inputs):\n    return {'rows': []}\n");
  writeFileSync(join(root, "sandbox/catalogue.json"), JSON.stringify({ entries: [], datasources: [] }));
  if (opts.mine !== undefined) writeFileSync(join(root, "sandbox/catalogue.mine.json"), JSON.stringify(opts.mine));
  writeFileSync(
    join(root, "sandbox/workflow.json"),
    JSON.stringify({ ...(opts.reads ? { reads: opts.reads } : {}), steps: [{ id: "load", description: "Loads the rows.", entry: "steps/load/main.py", outputs: ["rows"], ...step }] }),
  );
  const r = spawnSync(process.execPath, [join(root, "verifier/verify.mjs")], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

describe("the person's own actions (catalogue.mine.json)", () => {
  const code = "def run(params, inputs):\n    foundry.call(\"azure_devops_list_branches\", {})\n    return {'rows': []}\n";
  const step = { uses: ["tool:azure_devops_list_branches"] };
  it("control: a tool in neither catalogue is refused", () => {
    expect(verify(step, { code }).out).toContain("is not a tool in this workspace's catalogue");
  });
  it("a tool in catalogue.mine.json may be called like any tool", () => {
    expect(verify(step, { code, mine: { entries: [{ ref: "azure_devops_list_branches", kind: "tool" }] } }).ok).toBe(true);
  });
  it("only TOOLS come from it — a saved reader named there is not one", () => {
    const r = verify({}, { reads: { leavers: { ref: "hr.leavers" } }, mine: { entries: [{ ref: "hr.leavers", kind: "operation" }] } });
    expect(r.out).toContain('"hr.leavers" is not a saved reader');
  });
});

describe("the verifier's allow_empty rules", () => {
  it("control: a step with no allowance verifies", () => {
    const r = verify({});
    expect(r.ok).toBe(true);
    expect(r.out).toContain("VERIFY OK");
  });

  it("accepts an allowance that names the step's own output and says why", () => {
    const r = verify({ allow_empty: [{ output: "rows", reason: "a month may have nobody to report" }, { output: "rows", field: "manager", reason: "contractors have none" }] });
    expect(r.out).toContain("VERIFY OK");
  });

  it("refuses one with no reason — the reason is what a person reads", () => {
    expect(verify({ allow_empty: [{ output: "rows" }] }).out).toContain('needs a "reason"');
  });

  it("refuses one naming an output the step does not declare, and an unknown key", () => {
    const r = verify({ allow_empty: [{ output: "rowz", reason: "r", why: "x" }] });
    expect(r.out).toContain('names output "rowz", which this step does not declare');
    expect(r.out).toContain('unknown key "why"');
  });
});

/** The real verifier on a whole workflow — every step's file written with a run() that reads what it is given. */
function verifyWorkflow(workflow: Record<string, unknown>): { ok: boolean; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-verify-")));
  mkdirSync(join(root, "verifier"));
  mkdirSync(join(root, "sandbox"), { recursive: true });
  copyFileSync(resolve(__dirname, "../../pi-builder-template/verifier/verify.mjs"), join(root, "verifier/verify.mjs"));
  const steps: Array<Record<string, unknown>> = [];
  const collect = (nodes: unknown) => {
    for (const n of (nodes as Array<Record<string, unknown>>) ?? []) {
      if (n.foreach) collect(n.steps);
      else if (n.branch) for (const arm of n.branch as Array<Record<string, unknown>>) collect(arm.steps);
      else if (!n.approval) steps.push(n);
    }
  };
  collect(workflow.steps);
  for (const st of steps) {
    mkdirSync(join(root, `sandbox/steps/${st.id}`), { recursive: true });
    const reads = [
      ...Object.keys((st.inputs as object) ?? {}).map((k) => `inputs["${k}"]`),
      ...Object.keys((st.params as object) ?? {}).map((k) => `params["${k}"]`),
    ].join(", ");
    writeFileSync(join(root, `sandbox/steps/${st.id}/main.py`), `def run(params, inputs):\n    _ = [${reads}]\n    return {}\n`);
    st.entry = `steps/${st.id}/main.py`;
    st.description ??= `Does ${st.id}.`;
  }
  writeFileSync(join(root, "sandbox/catalogue.json"), JSON.stringify({ entries: [], datasources: [] }));
  writeFileSync(join(root, "sandbox/workflow.json"), JSON.stringify(workflow));
  const r = spawnSync(process.execPath, [join(root, "verifier/verify.mjs")], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const flow = (steps: unknown[]) => ({ inputs: {}, steps });

describe("the verifier's loops, branches and approvals", () => {
  const good = flow([
    { id: "find", outputs: ["rows"] },
    { id: "ok_to_send", approval: { title: "Send these?", review: "find.rows" } },
    { id: "each", foreach: "find.rows", as: "person", steps: [
      { id: "route", outputs: ["via"], branch: [
        { if: { value: "$person.late", op: "gte", to: 10 }, steps: [{ id: "escalate", inputs: { who: "$person.name" }, outputs: ["ref"] }], set: { via: "escalate.ref" } },
        { else: true, steps: [{ id: "remind", inputs: { who: "$person", n: "$index" }, outputs: ["ref"] }], set: { via: "remind.ref" } },
      ] },
      { id: "log", inputs: { via: "route.via" }, outputs: ["ok"] },
    ] },
    { id: "summary", inputs: { n: "each.succeeded" }, outputs: ["done"] },
  ]);

  it("control: a workflow with a loop, a branch inside it and an approval before it verifies", () => {
    const r = verifyWorkflow(good);
    expect(r.out).toContain("VERIFY OK");
  });

  it("refuses an approval inside a loop", () => {
    const r = verifyWorkflow(flow([{ id: "find", outputs: ["rows"] }, { id: "each", foreach: "find.rows", steps: [{ id: "ask", approval: { title: "t" } }] }]));
    expect(r.out).toContain("an approval cannot be inside a loop");
  });

  it("an approval may name its decider by email — and only by email (sharing-boundaries P1-I3)", () => {
    const named = (decider: string) => verifyWorkflow(flow([{ id: "find", outputs: ["rows"] }, { id: "ask", approval: { title: "t", decider } }])).out;
    expect(named("priya@acme.example")).toContain("VERIFY OK");
    expect(named("Priya")).toContain('"decider" is the email of the workspace member');
  });

  it("refuses reading a step inside a loop or a branch path from outside it", () => {
    const g = JSON.parse(JSON.stringify(good));
    g.steps[3].inputs = { n: "remind.ref" };
    expect(verifyWorkflow(g).out).toContain("remind is inside a loop or a branch path");
  });

  it("refuses a branch whose path does not set a declared output, or that declares outputs with no else", () => {
    const g = JSON.parse(JSON.stringify(good));
    delete g.steps[2].steps[0].branch[1].set;
    expect(verifyWorkflow(g).out).toContain('every path must set it under "set"');
    const h = JSON.parse(JSON.stringify(good));
    h.steps[2].steps[0].branch[1] = { if: { value: "$person.late", op: "gt", to: 0 }, steps: [], set: { via: "x" } };
    expect(verifyWorkflow(h).out).toContain('it needs an "else" path');
  });

  it("refuses $item outside a loop and a loop name that is not around it", () => {
    expect(verifyWorkflow(flow([{ id: "a", inputs: { x: "$item.name" }, outputs: [] }])).out).toContain('"$item" exists only inside a loop');
    const g = JSON.parse(JSON.stringify(good));
    g.steps[2].steps[0].branch[0].steps[0].inputs = { who: "$employee.name" };
    expect(verifyWorkflow(g).out).toContain('no loop around it is named "employee"');
  });
});

describe("the verifier's schedule", () => {
  it("accepts a cron with a timezone, and refuses a bad one or an input with no default", () => {
    expect(verifyWorkflow({ schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" }, inputs: {}, steps: [{ id: "a", outputs: [] }] }).out).toContain("VERIFY OK");
    expect(verifyWorkflow({ schedule: { cron: "0 9 * *" }, inputs: {}, steps: [{ id: "a", outputs: [] }] }).out).toContain("must be 5 fields");
    expect(verifyWorkflow({ schedule: { cron: "0 9 * * *", timezone: "Mars/Base" }, inputs: {}, steps: [{ id: "a", outputs: [] }] }).out).toContain("is not a timezone");
    const r = verifyWorkflow({
      schedule: { cron: "0 9 * * *" },
      inputs: { month: { type: "integer", description: "Which month" } },
      steps: [{ id: "a", params: { month: "$input.month" }, outputs: [] }],
    });
    expect(r.out).toContain('input "month" needs a "default"');
  });
});

describe("the verifier names the fix for a binding that is not one", () => {
  it("a read written as a binding is told to call foundry.read in the code", () => {
    const r = verifyWorkflow({ inputs: {}, reads: {}, steps: [{ id: "a", params: { telemetry: "$read.latest" }, outputs: [] }] });
    expect(r.out).toContain('call foundry.read("latest") in the step\'s code');
  });
});


describe("the verifier's step descriptions", () => {
  it("refuses a code step with no description — it is what a person reads when they click the step", () => {
    const r = verify({ description: undefined });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('step load: needs a "description"');
  });
});

describe("the verifier's cases — every choice the request describes is a branch path", () => {
  const choice = (cases: unknown) => ({
    inputs: {},
    cases,
    steps: [
      { id: "find", outputs: ["rows"] },
      {
        id: "each",
        foreach: "find.rows",
        as: "p",
        steps: [
          {
            id: "decide",
            branch: [
              { if: { value: "$p.leave", op: "eq", to: "LOP" }, steps: [{ id: "tell_head", inputs: { p: "$p" }, outputs: [] }] },
              { if: { value: "$p.level", op: "in", to: ["P4", "P5"] }, steps: [{ id: "note_senior", inputs: { p: "$p" }, outputs: [] }] },
              { else: true, steps: [] },
            ],
          },
        ],
      },
    ],
  });

  it("control: every case pointing at a real path verifies", () => {
    const r = verifyWorkflow(choice([
      { says: "LOP → tell the department head", path: "decide.1" },
      { says: "P4/P5 → senior list", path: "decide.2" },
      { says: "otherwise nothing", path: "decide.else" },
    ]));
    expect(r.out).toContain("VERIFY OK");
  });

  it("refuses a case pointing at no branch — the choice was decided in code", () => {
    const r = verifyWorkflow(choice([{ says: "LOP → tell the department head", path: "review.1" }]));
    expect(r.out).toContain('there is no branch "review" — build this choice as a branch step');
  });

  it("refuses a path number the branch does not have, and else on a branch with no else", () => {
    expect(verifyWorkflow(choice([{ says: "x", path: "decide.3" }])).out).toContain("has no condition path 3 (it has 2)");
    const noElse = choice([{ says: "x", path: "decide.else" }]);
    ((noElse.steps[1] as { steps: Array<{ branch: unknown[] }> }).steps[0]!.branch).pop();
    expect(verifyWorkflow(noElse).out).toContain('has no "else" path');
  });

  it("⚠ refuses a case marked missing — the person is asked, never built around", () => {
    const r = verifyWorkflow(choice([{ says: "sick leave → email the employee", missing: "no employee email address in the data" }]));
    expect(r.ok).toBe(false);
    expect(r.out).toContain('case 1 ("sick leave → email the employee") cannot be built: no employee email address in the data — ask the person');
  });

  it("refuses a case with no words or no path", () => {
    const r = verifyWorkflow(choice([{ path: "decide.1" }, { says: "y" }]));
    expect(r.out).toContain('case 1 needs "says"');
    expect(r.out).toContain('case 2 ("y") needs "path"');
  });
});

describe("the verifier's relative dates", () => {
  const withInput = (d: Record<string, unknown>) => ({ inputs: { week_start: { type: "date", description: "Week starting", ...d } }, steps: [{ id: "load", params: { week_start: "$input.week_start" }, outputs: ["rows"] }] });
  it("control: a date relative to the run day, with a test default, verifies", () => {
    expect(verifyWorkflow(withInput({ relative: "last_week_start", default: "2026-06-01" })).out).toContain("VERIFY OK");
  });
  it("refuses an unknown anchor, a non-date input, and a relative date with no test default", () => {
    expect(verifyWorkflow(withInput({ relative: "fortnight_ago", default: "2026-06-01" })).out).toContain('relative "fortnight_ago" — one of');
    expect(verifyWorkflow(withInput({ type: "string", relative: "today", default: "x" })).out).toContain('"relative" is for a date input');
    expect(verifyWorkflow(withInput({ relative: "today" })).out).toContain("a relative date still needs a \"default\"");
  });
});

/** A step reading a workspace file (Resources → Files): declared in uses, present in the catalogue. */
function verifyFileUse(uses: string[], code: string, files: string[], chat: { files?: string[]; out?: string[] } = {}): { ok: boolean; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-verify-")));
  mkdirSync(join(root, "verifier"));
  mkdirSync(join(root, "sandbox/steps/load"), { recursive: true });
  copyFileSync(resolve(__dirname, "../../pi-builder-template/verifier/verify.mjs"), join(root, "verifier/verify.mjs"));
  writeFileSync(join(root, "sandbox/steps/load/main.py"), code);
  for (const [dir, names] of Object.entries(chat)) {
    mkdirSync(join(root, "sandbox", dir), { recursive: true });
    for (const n of names ?? []) writeFileSync(join(root, "sandbox", dir, n), "a,b\n");
  }
  writeFileSync(
    join(root, "sandbox/catalogue.json"),
    JSON.stringify({ entries: [], datasources: [], files: files.map((name) => ({ name, type: "text/csv", size_bytes: 10 })) }),
  );
  writeFileSync(
    join(root, "sandbox/workflow.json"),
    JSON.stringify({ steps: [{ id: "load", description: "Loads the rates.", entry: "steps/load/main.py", outputs: ["rows"], uses }] }),
  );
  const r = spawnSync(process.execPath, [join(root, "verifier/verify.mjs")], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

describe("a workspace file in uses", () => {
  const code = "import foundry\n\ndef run(params, inputs):\n    open(foundry.file('Rates.csv')).read()\n    return {'rows': [1]}\n";

  it("control: a file in the workspace, declared and opened, verifies", () => {
    expect(verifyFileUse(["file:Rates.csv"], code, ["Rates.csv"]).out).toContain("VERIFY OK");
  });

  it("refuses a file the workspace does not have", () => {
    expect(verifyFileUse(["file:Rates.csv"], code, []).out).toContain('there is no file "Rates.csv" in this workspace\'s Files');
  });

  it("a file in THIS chat counts: one the person attached, or one Forge made", () => {
    expect(verifyFileUse(["file:Rates.csv"], code, [], { files: ["Rates.csv"] }).out).toContain("VERIFY OK");
    expect(verifyFileUse(["file:Rates.csv"], code, [], { out: ["Rates.csv"] }).out).toContain("VERIFY OK");
    expect(verifyFileUse(["file:Rates.csv"], code, [], { files: ["Other.csv"] }).out).toContain("or in this chat");
  });

  it("refuses opening a file the step does not declare", () => {
    expect(verifyFileUse([], code, ["Rates.csv"]).out).toContain('the code calls foundry.file("Rates.csv") but uses does not list "file:Rates.csv"');
  });
});

/**
 * Data must REACH a step's code (chat 5e491c36, 2026-11-03). The runner hands a step exactly the params and inputs it
 * binds; a fix turn left a report step with `"inputs": {}`, code reading inputs.get("attendance"), and two reads it
 * listed and never called — the verifier said OK and the run failed later as "returned empty data".
 */
function verifyData(steps: Array<Record<string, unknown>>, code: Record<string, string>, inputs: Record<string, unknown> = {}): { ok: boolean; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-verify-")));
  mkdirSync(join(root, "verifier"));
  copyFileSync(resolve(__dirname, "../../pi-builder-template/verifier/verify.mjs"), join(root, "verifier/verify.mjs"));
  for (const st of steps) {
    mkdirSync(join(root, `sandbox/steps/${st.id}`), { recursive: true });
    writeFileSync(join(root, `sandbox/steps/${st.id}/main.py`), code[st.id as string] ?? "def run(params, inputs):\n    return {}\n");
    st.entry ??= `steps/${st.id}/main.py`;
    st.description ??= `Does ${st.id}.`;
  }
  writeFileSync(join(root, "sandbox/catalogue.json"), JSON.stringify({ entries: [], datasources: [{ name: "HR", dialect: "postgres" }] }));
  const reads = {
    attendance: { datasource: "HR", sql: "SELECT employee_no FROM employee_time_information WHERE attendance_date >= $1::date", params: [{ name: "month", type: "string" }] },
    leaves: { datasource: "HR", sql: "SELECT employee_id FROM employee_times_overview", params: [] },
  };
  writeFileSync(join(root, "sandbox/workflow.json"), JSON.stringify({ inputs, reads, steps }));
  const r = spawnSync(process.execPath, [join(root, "verifier/verify.mjs")], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

describe("the verifier: data reaches the code", () => {
  const month = { month: { type: "string", default: "2026-10", description: "Month, YYYY-MM" } };
  const report = (over: Record<string, unknown>) => ({ id: "report", uses: ["read:attendance", "read:leaves"], params: { month: "$input.month" }, outputs: ["rows"], ...over });
  const readsInCode =
    'import foundry\n\ndef run(params, inputs):\n    a = foundry.read("attendance", month=params["month"])\n    l = foundry.read("leaves")\n    return {"rows": a + l}\n';
  const readsFromInputs = 'def run(params, inputs):\n    _ = params["month"]\n    return {"rows": (inputs.get("attendance") or []) + (inputs.get("leaves") or [])}\n';

  it("control: a step that calls its reads verifies", () => {
    const r = verifyData([report({})], { report: readsInCode }, month);
    expect(r.out).toContain("VERIFY OK");
  });

  it("control: a step given its rows by earlier read steps verifies, even with a leftover read: in uses", () => {
    const steps = [
      { id: "attendance", uses: ["read:attendance"], params: { month: "$input.month" }, outputs: ["rows"] },
      { id: "leaves", uses: ["read:leaves"], outputs: ["rows"] },
      report({ inputs: { attendance: "attendance.rows", leaves: "leaves.rows" } }),
    ];
    const r = verifyData(steps, {
      attendance: 'import foundry\n\ndef run(params, inputs):\n    return {"rows": foundry.read("attendance", month=params["month"])}\n',
      leaves: 'import foundry\n\ndef run(params, inputs):\n    return {"rows": foundry.read("leaves")}\n',
      report: readsFromInputs,
    }, month);
    expect(r.out).toContain("VERIFY OK");
  });

  it("refuses the chat's state: code reads inputs nothing binds, and the step's reads are never called", () => {
    const r = verifyData([report({ inputs: {} })], { report: readsFromInputs }, month);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('reads inputs["attendance"] but the step binds no input "attendance", so it never has a value');
    expect(r.out).toContain('reads inputs["leaves"] but the step binds no input "leaves"');
    expect(r.out).toContain('uses lists "read:attendance" but steps/report/main.py never calls foundry.read("attendance") and the step is bound no inputs');
  });

  it("refuses an input read with a default that nothing binds — the default is a fixed value in disguise", () => {
    const code = 'import foundry\n\ndef run(params, inputs):\n    path = inputs.get("report_path", "report.xlsx")\n    return {"rows": foundry.read("leaves") + [path]}\n';
    const r = verifyData([{ id: "report", uses: ["read:leaves"], outputs: ["rows"] }], { report: code });
    expect(r.out).toContain('reads inputs["report_path"] but the step binds no input "report_path"');
  });

  it("refuses a param read that nothing binds", () => {
    const code = 'import foundry\n\ndef run(params, inputs):\n    return {"rows": foundry.read("attendance", month=params["month"])}\n';
    const r = verifyData([{ id: "report", uses: ["read:attendance"], outputs: ["rows"] }], { report: code });
    expect(r.out).toContain('reads params["month"] but the step binds no param "month"');
  });

  it("does not count a comment as a read (I-62)", () => {
    const code = '# inputs["attendance"] would be wrong here; read it instead\n' + readsInCode;
    const r = verifyData([report({})], { report: code }, month);
    expect(r.out).toContain("VERIFY OK");
  });

  it("does not call a step starved when it reads by a computed name", () => {
    const code = 'import foundry\n\ndef run(params, inputs):\n    _ = params["month"]\n    return {"rows": [r for n in ("attendance", "leaves") for r in foundry.read(n)]}\n';
    const r = verifyData([report({})], { report: code }, month);
    expect(r.out).not.toContain("so it has no data");
  });

  it("names the fix when a read's bare name is used as a binding", () => {
    const r = verifyData([report({ inputs: { attendance: "attendance", leaves: "leaves" } })], { report: readsFromInputs }, month);
    expect(r.out).toContain(`input attendance is "attendance" — that is a read's name, and a read is not a binding; call foundry.read("attendance")`);
    expect(r.out).not.toContain('input attendance must be "$input.<name>"');
  });
});

describe("the verifier: a read in step form, and a step running another's code (chat 934d4254)", () => {
  const month = { month: { type: "string", default: "2026-10", description: "Month, YYYY-MM" } };
  const code = 'def run(params, inputs):\n    _ = params["month"]\n    return {"rows": inputs["attendance"]}\n';

  it('"<read>.rows" as an input names the read and the fix, not a missing step', () => {
    const r = verifyData(
      [{ id: "report", uses: ["read:attendance"], params: { month: "$input.month" }, inputs: { attendance: "attendance.rows" }, outputs: ["rows"] }],
      { report: code },
      month,
    );
    expect(r.out).toContain('attendance is a read, not a step');
    expect(r.out).toContain('call foundry.read("attendance", ...)');
    expect(r.out).not.toContain("no EARLIER step is called attendance");
  });

  it("CONTROL: a missing step that is not a read keeps the plain message", () => {
    const r = verifyData(
      [{ id: "report", params: { month: "$input.month" }, inputs: { attendance: "fetch.rows" }, outputs: ["rows"] }],
      { report: code },
      month,
    );
    expect(r.out).toContain("no EARLIER step is called fetch");
  });

  it("a step running another step's code file is refused, naming whose file it is", () => {
    const r = verifyData(
      [
        { id: "attendance", entry: "steps/report/main.py", params: { month: "$input.month" }, outputs: ["rows"] },
        { id: "report", params: { month: "$input.month" }, inputs: { attendance: "attendance.rows" }, outputs: ["rows"] },
      ],
      { report: code },
      month,
    );
    expect(r.out).toContain("step attendance: runs steps/report/main.py, which is step report's code");
    expect(r.out).not.toContain("step report: runs");
  });
});

describe("the verifier: a workbook written by foundry.write_xlsx is not re-opened (run 12e1a455)", () => {
  const wrap = (body: string) => `def run(params, inputs):\n    foundry.write_xlsx("r.xlsx", [])\n${body}    return {"rows": []}\n`;

  it("a full-mode load_workbook after write_xlsx is refused", () => {
    const r = verify({}, { code: wrap("    wb = openpyxl.load_workbook(\"r.xlsx\")\n") });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("re-opens a workbook");
  });
  it("read_only = True verifies", () => {
    expect(verify({}, { code: wrap("    wb = openpyxl.load_workbook(p, read_only = True)\n") }).ok).toBe(true);
  });
  it("load_workbook in a step that never calls write_xlsx verifies", () => {
    const code = 'def run(params, inputs):\n    wb = load_workbook("template.xlsx")\n    return {"rows": []}\n';
    expect(verify({}, { code }).ok).toBe(true);
  });
  it("control: the load_workbook line only in a comment verifies", () => {
    expect(verify({}, { code: wrap("    # wb = openpyxl.load_workbook(out)\n") }).ok).toBe(true);
  });
  it("write_xlsx imported by name (from foundry import write_xlsx) is caught too", () => {
    const code = 'def run(params, inputs):\n    write_xlsx("r.xlsx", [])\n    wb = load_workbook("r.xlsx")\n    return {"rows": []}\n';
    const r = verify({}, { code });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("re-opens a workbook");
  });
  it("a multi-line call is refused", () => {
    const r = verify({}, { code: wrap("    wb = load_workbook(\n        out,\n    )\n") });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("re-opens a workbook");
  });
});
