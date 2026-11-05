#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

function expectedPath() {
  return process.env.ORACLE_EXPECTED
    ? resolve(process.env.ORACLE_EXPECTED)
    : join(__dirname, "expected.json");
}

export function checkOracle() {
  const expected = JSON.parse(readFileSync(expectedPath(), "utf8"));
  const outboxPath = join(SANDBOX, "outbox.json");
  if (!existsSync(outboxPath)) {
    return { ok: false, errors: ["missing outbox.json — run the runner first"] };
  }
  const outbox = JSON.parse(readFileSync(outboxPath, "utf8"));
  const errors = [];

  if (outbox.length !== expected.outbox.length) {
    errors.push(`outbox length ${outbox.length} !== expected ${expected.outbox.length}`);
  }

  const n = Math.min(outbox.length, expected.outbox.length);
  for (let i = 0; i < n; i++) {
    const got = outbox[i];
    const exp = expected.outbox[i];
    if (got.to !== exp.to) errors.push(`msg[${i}].to: got ${got.to} want ${exp.to}`);
    if (exp.subject != null) {
      if (got.subject !== exp.subject) {
        errors.push(
          `msg[${i}].subject: got ${JSON.stringify(got.subject)} want ${JSON.stringify(exp.subject)}`,
        );
      }
    }
    for (const frag of exp.subjectContains || []) {
      if (!String(got.subject || "").includes(frag)) {
        errors.push(`msg[${i}].subject missing ${JSON.stringify(frag)}`);
      }
    }
    for (const frag of exp.bodyContains || []) {
      if (!String(got.body || "").includes(frag)) {
        errors.push(`msg[${i}].body missing ${JSON.stringify(frag)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, outboxCount: outbox.length };
}

function main() {
  const r = checkOracle();
  if (r.ok) {
    console.log(`ORACLE OK — ${r.outboxCount} messages`);
    process.exit(0);
  }
  console.error("ORACLE FAIL");
  for (const e of r.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
