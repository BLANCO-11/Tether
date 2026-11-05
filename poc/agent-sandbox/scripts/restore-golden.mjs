#!/usr/bin/env node
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const G = join(ROOT, "golden");
const S = join(ROOT, "sandbox");
mkdirSync(join(S, "steps/fetch"), { recursive: true });
mkdirSync(join(S, "steps/notify"), { recursive: true });
cpSync(join(G, "workflow.json"), join(S, "workflow.json"));
cpSync(join(G, "steps/fetch/main.py"), join(S, "steps/fetch/main.py"));
cpSync(join(G, "steps/notify/main.py"), join(S, "steps/notify/main.py"));
const simpleGoal = join(ROOT, "scenarios/simple/GOAL.md");
if (existsSync(simpleGoal)) cpSync(simpleGoal, join(S, "GOAL.md"));
console.log("restored golden → sandbox");
