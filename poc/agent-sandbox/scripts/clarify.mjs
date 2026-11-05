#!/usr/bin/env node
/**
 * Clarification harness: status | answer | simulate-ask | resume-check
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX = resolve(__dirname, "..", "sandbox");
const Q = join(SANDBOX, "questions.json");
const A = join(SANDBOX, "answers.json");

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function status() {
  const q = readJson(Q, { status: "idle", questions: [] });
  const a = readJson(A, {});
  return { questions: q, answers: a, open: q.status === "open" };
}

export function simulateAsk() {
  writeJson(Q, {
    status: "open",
    questions: [
      {
        id: "q1",
        prompt: "Which column is the customer email for notification `to`?",
        choices: ["customer_email", "billing_email"],
      },
    ],
  });
  writeJson(A, {});
  return status();
}

export function answer(map) {
  const q = readJson(Q, { status: "idle", questions: [] });
  if (q.status !== "open") {
    throw new Error("no open questions to answer");
  }
  const answers = { ...readJson(A, {}), ...map };
  for (const qq of q.questions || []) {
    if (answers[qq.id] == null) {
      throw new Error(`missing answer for ${qq.id}`);
    }
  }
  writeJson(A, answers);
  writeJson(Q, { status: "answered", questions: q.questions || [] });
  return status();
}

function main() {
  const cmd = process.argv[2] || "status";
  try {
    if (cmd === "status") {
      const s = status();
      console.log(JSON.stringify(s, null, 2));
      process.exit(s.open ? 2 : 0);
    }
    if (cmd === "simulate-ask") {
      console.log(JSON.stringify(simulateAsk(), null, 2));
      process.exit(0);
    }
    if (cmd === "answer") {
      // clarify.mjs answer q1=customer_email
      const map = {};
      for (const arg of process.argv.slice(3)) {
        const [k, ...rest] = arg.split("=");
        map[k] = rest.join("=");
      }
      if (!Object.keys(map).length) {
        // default POC answer
        Object.assign(map, { q1: "customer_email" });
      }
      console.log(JSON.stringify(answer(map), null, 2));
      process.exit(0);
    }
    console.error("usage: clarify.mjs status|simulate-ask|answer [id=value...]");
    process.exit(1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
