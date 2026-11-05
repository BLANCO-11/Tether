#!/usr/bin/env node
/**
 * Deterministic stand-in when Pi cannot reach a model (auth/network).
 * Writes the same questions.json a correct agent would, then after answers
 * applies email_field to workflow.json — proves the channel without LLM.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

const phase = process.argv[2] || "ask";

if (phase === "ask") {
  writeFileSync(
    join(SANDBOX, "questions.json"),
    JSON.stringify(
      {
        status: "open",
        questions: [
          {
            id: "q1",
            prompt: "Which column is the customer email for notification `to`?",
            choices: ["customer_email", "billing_email"],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(SANDBOX, "answers.json"), "{}\n");
  console.log("STUB ASK — questions.json open");
  process.exit(0);
}

if (phase === "apply") {
  const answers = JSON.parse(readFileSync(join(SANDBOX, "answers.json"), "utf8"));
  const field = answers.q1;
  if (!field) {
    console.error("STUB APPLY FAIL — no answers.q1");
    process.exit(1);
  }
  const wf = JSON.parse(readFileSync(join(SANDBOX, "workflow.json"), "utf8"));
  const notify = wf.steps.find((s) => s.id === "notify");
  if (!notify) {
    console.error("no notify step");
    process.exit(1);
  }
  notify.params = { ...notify.params, email_field: field };
  writeFileSync(join(SANDBOX, "workflow.json"), JSON.stringify(wf, null, 2) + "\n");
  writeFileSync(
    join(SANDBOX, "questions.json"),
    JSON.stringify({ status: "answered", questions: [] }, null, 2) + "\n",
  );
  console.log(`STUB APPLY — email_field=${field}`);
  process.exit(0);
}

console.error("usage: agent-stub-clarify.mjs ask|apply");
process.exit(1);
