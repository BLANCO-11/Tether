/**
 * UAT LIFECYCLE PROBE — can a workflow be built by conversing, tested, armed,
 * fired four ways, and its outputs read back?
 *
 * ⚠ **HTTP ONLY, and that is the whole method.** Every call here is one the
 * client makes, with the key the Next proxy injects and an identity minted the
 * way `e2e:ui` mints one. A harness calling services directly grants itself
 * access no browser has — which is exactly the question being asked.
 *
 * Stages are separate so a failure stops at the stage that failed and leaves the
 * state behind for inspection:
 *
 *   build   — a conversation, turn by turn, until an automation exists
 *   test    — a draft run, then its outputs
 *   arm     — assign a member, approve, confirm the live namespace
 *   fire    — manual, api, webhook, schedule
 *   outputs — every execution this probe caused, with per-step results
 */
import { SignJWT } from "jose";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const BASE = (process.env.E2E_BASE_URL ?? "http://server:4000").replace(/\/$/, "");
const API_KEY = process.env.PARENT_API_KEY ?? "dev-parent-key";
const AUTHOR = "uat-author@acme-hr.example";
const APPROVER = "uat-approver@acme-hr.example";
const SUPER = (process.env.SUPER_ADMIN_EMAILS ?? "local-admin").split(",")[0]!.trim();

const STATE = ".harness-results/uat-lifecycle.json";

type State = {
  workspaceId?: string; threadId?: string; flowId?: string;
  revision?: number; triggers?: Record<string, string>; executions?: string[];
  notes?: string[];
};
function load(): State {
  if (!existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function save(s: State) {
  mkdirSync(".harness-results", { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

const ids = new Map<string, Promise<string>>();
function identity(email: string): Promise<string> {
  if (!ids.has(email)) {
    const secret = process.env.RUNTIME_JWT_SECRET ?? process.env.AUTH_SECRET ?? "";
    if (!secret) throw new Error("RUNTIME_JWT_SECRET is not set — approvals would 401.");
    ids.set(email, new SignJWT({ sub: email, email, name: email.split("@")[0] })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h")
      .sign(new TextEncoder().encode(secret)));
  }
  return ids.get(email)!;
}

async function http<T = any>(verb: string, path: string, body?: unknown, as: string | null = AUTHOR) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: verb,
    headers: {
      "x-api-key": API_KEY,
      ...(as ? { "x-foundry-identity": await identity(as) } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed as T, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(...a: unknown[]) { console.log(...a); }
function head(t: string) { log(`\n${"=".repeat(74)}\n${t}\n${"=".repeat(74)}`); }

export { http, load, save, log, head, sleep, AUTHOR, APPROVER, SUPER, identity, BASE, API_KEY };
