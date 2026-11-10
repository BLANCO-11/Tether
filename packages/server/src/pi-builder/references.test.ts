/**
 * Workflow references: the card is built by code from the saved version only, the copy is code only, and the folder is
 * only ever removed and rewritten. The fixture is the shape of a real saved workflow (Monthly Attendance Report, HR).
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { readBundle } from "./sandbox-fs.js";
import {
  buildCard,
  cardsBlock,
  clearReferences,
  safeCodePath,
  slugFor,
  versionLabel,
  writeReferences,
  type CardSource,
  type FolderReference,
} from "./references.js";

const attendance: CardSource = {
  name: "Monthly Attendance Report + Pivot",
  description: "i want a workflow",
  revision: 1,
  savedAt: new Date("2026-10-12T09:00:00Z"),
  approvedAs: null,
  bundle: {
    workflow: {
      name: "Monthly Attendance Report",
      inputs: {
        month: { type: "string", default: "2026-09", description: "Month to report, as YYYY-MM" },
        email_address: { type: "string", default: "report.requester@mock.example", description: "Email address to receive the report" },
      },
      steps: [
        {
          id: "report",
          uses: ["file:Temporary Employee Muster Report- 1 to 30 Sep.csv", "file:HC_12th Oct.xlsx"],
          entry: "steps/report/main.py",
          outputs: ["rows", "summary", "report_file", "has_rows"],
          allow_empty: [{ output: "rows", reason: "No muster records exist for the chosen month." }],
          description: "Build the monthly attendance report from the muster and headcount files.",
        },
        {
          id: "has_report",
          branch: [
            {
              if: { op: "eq", to: true, value: "report.has_rows" },
              steps: [{ id: "send_report", uses: ["tool:tether_email_send"], entry: "steps/send_report/main.py", description: "Email the report." }],
            },
            { else: true, steps: [] },
          ],
          outputs: ["email_body"],
        },
      ],
    },
    files: {
      "steps/report/main.py": "present_threshold = 9.0 if six_day else 9.5\nprint('x')\n",
      "steps/send_report/main.py": "send()\n",
    },
  },
};

describe("buildCard", () => {
  const card = buildCard(attendance);

  it("states the saved version and that it was never approved", () => {
    expect(card).toContain("# Monthly Attendance Report + Pivot");
    expect(card).toContain("Saved version 1, saved 2026-10-12, not approved.");
  });

  it("lists inputs, steps with the branch, tools, and the code with its line counts", () => {
    expect(card).toContain('- month (string, default "2026-09"): Month to report, as YYYY-MM');
    expect(card).toContain("- report: Build the monthly attendance report from the muster and headcount files. [code: steps/report/main.py]");
    expect(card).toContain('  - if report.has_rows eq true:');
    expect(card).toContain("    - send_report: Email the report.");
    expect(card).toContain("  - otherwise: nothing");
    expect(card).toContain("- Tools it calls: tether_email_send");
    expect(card).toContain("- steps/report/main.py (3 lines)");
    expect(card).toContain("- report.rows may be empty: No muster records exist for the chosen month.");
  });

  it("names the data files and says they are NOT copied (decision 4)", () => {
    expect(card).toContain('"HC_12th Oct.xlsx"');
    expect(card).toContain("These files are NOT copied here.");
  });

  it("never puts the code's rules on the card — it points at the code instead (decision 5)", () => {
    expect(card).not.toContain("9.5");
    expect(card).toContain("The exact rules (thresholds, statuses, how files are parsed) are in this code.");
  });

  it("marks an approved version with the workflows list's approval number", () => {
    expect(buildCard({ ...attendance, approvedAs: 2 })).toContain("approved (as v2 on the workflows list)");
  });
});

describe("versionLabel", () => {
  it('says "saved N", never a bare vN', () => {
    expect(versionLabel(3, null)).toBe("saved 3 · not approved");
    expect(versionLabel(3, 1)).toBe("saved 3 · approved as v1");
  });
});

describe("slugFor", () => {
  it("is a plain folder name, unique within the chat", () => {
    const taken = new Set<string>();
    expect(slugFor("Monthly Attendance Report + Pivot", taken)).toBe("monthly-attendance-report-pivot");
    expect(slugFor("Monthly Attendance Report + Pivot", taken)).toBe("monthly-attendance-report-pivot-2");
    expect(slugFor("../../etc", taken)).toBe("etc");
    expect(slugFor("!!!", taken)).toBe("workflow");
  });
});

describe("safeCodePath", () => {
  it("admits only step .py files with no way out", () => {
    expect(safeCodePath("steps/report/main.py")).toBe(true);
    expect(safeCodePath("steps/../../x.py")).toBe(false);
    expect(safeCodePath("/etc/passwd.py")).toBe(false);
    expect(safeCodePath("data/muster.csv")).toBe(false);
    expect(safeCodePath("steps/report/.hidden.py")).toBe(false);
  });
});

describe("the folder", () => {
  const ws = `test-${randomUUID()}`;
  const sid = randomUUID();
  const sbx = join(SANDBOXES_ROOT, ws, sid, "sandbox");
  mkdirSync(join(sbx, "steps", "own"), { recursive: true });
  writeFileSync(join(sbx, "steps", "own", "main.py"), "own()\n");
  writeFileSync(join(sbx, "workflow.json"), JSON.stringify({ steps: [{ id: "own", entry: "steps/own/main.py" }] }));
  const outside = join(SANDBOXES_ROOT, ws, "outside.txt");
  writeFileSync(outside, "untouched");
  afterAll(() => rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true }));

  const ref = (bundle = attendance.bundle): FolderReference => ({
    slug: "monthly-attendance-report-pivot",
    name: attendance.name,
    label: versionLabel(1, null),
    cardMd: buildCard(attendance),
    bundle,
    deleted: false,
  });
  const dir = join(sbx, "references", "monthly-attendance-report-pivot");

  it("holds the card, workflow.json and the step code — and nothing else", () => {
    writeReferences(ws, sid, [ref({ ...attendance.bundle, files: { ...attendance.bundle.files, "data/muster.csv": "secret,rows" } })]);
    expect(readFileSync(join(dir, "CARD.md"), "utf8")).toContain("# Monthly Attendance Report + Pivot");
    expect(JSON.parse(readFileSync(join(dir, "workflow.json"), "utf8")).steps[0].id).toBe("report");
    expect(readFileSync(join(dir, "steps", "report", "main.py"), "utf8")).toContain("9.5");
    expect(existsSync(join(dir, "data"))).toBe(false);
  });

  it("is removed and rewritten: a change Forge made and a link it planted are both gone, the link's target untouched", () => {
    writeFileSync(join(dir, "steps", "report", "main.py"), "tampered");
    rmSync(join(dir, "CARD.md"));
    symlinkSync(outside, join(dir, "CARD.md"));
    writeReferences(ws, sid, [ref()]);
    expect(readFileSync(join(dir, "steps", "report", "main.py"), "utf8")).toContain("9.5");
    expect(lstatSync(join(dir, "CARD.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });

  it("is never part of the workflow that gets saved", () => {
    writeReferences(ws, sid, [ref()]);
    expect(Object.keys(readBundle(ws, sid).files)).toEqual(["steps/own/main.py"]);
  });

  it("goes away when cleared or when no references remain", () => {
    writeReferences(ws, sid, [ref()]);
    clearReferences(ws, sid);
    expect(existsSync(join(sbx, "references"))).toBe(false);
    writeReferences(ws, sid, [ref()]);
    writeReferences(ws, sid, []);
    expect(readdirSync(sbx)).not.toContain("references");
  });
});

describe("cardsBlock", () => {
  it("is empty with no references, and names folder, label and card otherwise", () => {
    expect(cardsBlock([])).toEqual([]);
    const text = cardsBlock(
      [{ slug: "m", name: "M", label: "saved 1 · not approved", cardMd: "# M\nline\n", bundle: attendance.bundle, deleted: true }],
      ["Reference updated: M, saved 1 → 2."],
    ).join("\n");
    expect(text).toContain("- references/m/ — M, saved 1 · not approved (this workflow has since been deleted");
    expect(text).toContain("  # M\n  line");
    expect(text).toContain("Reference updated: M, saved 1 → 2.");
  });
});
