/**
 * I-292 — the engine, the checker and the combinators read a component's TYPES and DECLARED flags, never its name. A rule
 * keyed on a name is a rule written from one failure: it is right for the tool it names and silent for the next one.
 * Names live in the server's `tool-declarations.ts` (the declaration of the tools the product ships) and nowhere here.
 * Excluded: the synthetic catalogue and fixtures (test data) and phase 2's re-expressed baseline transforms (`reexpress*.ts`,
 * E2.12's evidence — data about real flows, not rules). The tool list is the deployment's (the committed catalogue fixture).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["engine", "typecheck", "ir"];
/** The tools this deployment ships, and the families their names come from. */
const REFS = ["chat_list_channels", "chat_post_message", "flaky_probe", "foundry_email_send", "hr_attendance_daily", "hr_attendance_summary", "hr_get_employee", "hr_get_manager", "hr_list_departments", "hr_list_employees", "hr_list_offices", "http_request", "llm_complete", "mail_send", "mail_send_template", "page_oncall", "page_search", "test_email_send", "ticket_create", "ticket_search", "ticket_update"];
const NAMES = new RegExp(`["'\`](${REFS.join("|")})["'\`]`);
/** Source with comments removed — a docblock explaining a rule may name the tool it was written for. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("I-292: no component names in the engine, the checker or the combinators", () => {
  const files = DIRS.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !["synthetic.ts", "fixtures.ts", "reexpress.ts", "reexpress-types.ts"].includes(f)).map((f) => join(ROOT, d, f)));
  it("reads every source file (CONTROL)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("ops.ts"))).toBe(true);
    expect(NAMES.test(`const x = "llm_complete";`)).toBe(true); // the pattern can match
  });
  it("no source file compares against a component's name", () => {
    const hits = files.flatMap((f) => code(readFileSync(f, "utf8")).split("\n").filter((l) => NAMES.test(l)).map((l) => `${f.slice(ROOT.length)}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
});
