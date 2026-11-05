#!/usr/bin/env node
/**
 * Personal Foundry edge agent — secure setup (approve-then-credential) or legacy OTP pair.
 *
 *   # Prefer: paste curl from Devices, or:
 *   node scripts/edge-agent.mjs setup --token esetup_… [--url http://localhost:4000] [--name "MacBook"]
 *   node scripts/edge-agent.mjs run [--url http://localhost:4000]
 *
 *   # Legacy:
 *   node scripts/edge-agent.mjs pair --code 123456 [--name "MacBook"] [--url http://localhost:4000]
 *
 * Token is stored in ~/.foundry-edge/credentials.json.
 * Capabilities: read_path (immediate), run_command / write_path (after UI approval).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOME = join(homedir(), ".foundry-edge");
const CREDS = join(HOME, "credentials.json");
const AGENT_LABEL = "foundry-edge-agent/1";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function loadCreds() {
  try {
    return JSON.parse(await readFile(CREDS, "utf8"));
  } catch {
    return null;
  }
}

async function saveCreds(c) {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(CREDS, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Setup link → register → wait for owner Approve → save device token. */
async function setup() {
  const token = arg("--token");
  if (!token || !token.startsWith("esetup_")) {
    console.error("Usage: edge-agent.mjs setup --token esetup_… [--name Host] [--url http://localhost:4000]");
    process.exit(1);
  }
  const url = (arg("--url") || "http://localhost:4000").replace(/\/$/, "");
  const name = arg("--name") || undefined;

  console.log("Registering connect request…");
  const reg = await fetch(`${url}/api/edge/setup/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: token, name, agent: AGENT_LABEL }),
  });
  const regBody = await reg.json().catch(() => ({}));
  if (!reg.ok) {
    console.error(regBody.message || regBody.error || reg.status);
    process.exit(1);
  }
  console.log(`Device ${regBody.deviceId} (“${regBody.name}”) — awaiting Approve in Foundry → Devices (or Needs you).`);

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const wait = await fetch(`${url}/api/edge/setup/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: regBody.deviceId, waitSecret: regBody.waitSecret }),
    });
    const body = await wait.json().catch(() => ({}));
    if (wait.status === 202 || body.status === "waiting") {
      process.stdout.write(".");
      await sleep(2000);
      continue;
    }
    if (wait.status === 410 || body.status === "denied") {
      console.error("\nConnect was denied or expired.");
      process.exit(1);
    }
    if (!wait.ok || body.status !== "ready" || !body.token) {
      console.error("\n", body.message || body.error || wait.status);
      process.exit(1);
    }
    await saveCreds({
      url,
      deviceId: body.deviceId,
      workspaceId: body.workspaceId,
      token: body.token,
      name: body.name,
    });
    console.log(`\nConnected as “${body.name}” (${body.deviceId}). Token saved to ${CREDS}`);
    console.log(`Next: node scripts/edge-agent.mjs run --url ${url}`);
    return;
  }
  console.error("\nTimed out waiting for Approve (10 minutes). Mint a new setup curl in Devices.");
  process.exit(1);
}

async function pair() {
  const code = arg("--code");
  if (!code) {
    console.error("Usage: edge-agent.mjs pair --code 123456 [--name Host] [--url http://localhost:4000]");
    process.exit(1);
  }
  const url = (arg("--url") || "http://localhost:4000").replace(/\/$/, "");
  const name = arg("--name") || undefined;
  const res = await fetch(`${url}/api/edge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(body.message || body.error || res.status);
    process.exit(1);
  }
  await saveCreds({ url, deviceId: body.deviceId, workspaceId: body.workspaceId, token: body.token, name: body.name });
  console.log(`Paired as “${body.name}” (${body.deviceId}). Token saved to ${CREDS}`);
}

function runCmd(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: stdout.slice(0, 50_000), stderr: stderr.slice(0, 20_000) }));
  });
}

async function handleJob(job) {
  const { kind, payload = {} } = job;
  try {
    if (kind === "read_path") {
      const path = String(payload.path || "");
      if (!path || path.includes("..")) throw new Error("Refused path.");
      const text = await readFile(path, "utf8");
      return { ok: true, result: { bytes: Buffer.byteLength(text), preview: text.slice(0, 8_000) } };
    }
    if (kind === "write_path") {
      const path = String(payload.path || "");
      const contents = String(payload.contents ?? "");
      if (!path || path.includes("..")) throw new Error("Refused path.");
      await writeFile(path, contents, "utf8");
      return { ok: true, result: { bytes: Buffer.byteLength(contents) } };
    }
    if (kind === "run_command") {
      const command = String(payload.command || "");
      if (!command.trim()) throw new Error("Empty command.");
      const out = await runCmd(command, payload.cwd ? String(payload.cwd) : undefined);
      return { ok: out.exitCode === 0, result: out, error: out.exitCode === 0 ? undefined : `exit ${out.exitCode}` };
    }
    throw new Error(`Unknown kind ${kind}`);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runLoop() {
  const creds = await loadCreds();
  if (!creds?.token) {
    console.error("Not connected. Run: edge-agent.mjs setup --token esetup_…");
    process.exit(1);
  }
  const url = (arg("--url") || creds.url || "http://localhost:4000").replace(/\/$/, "");
  console.log(`Polling ${url} as device ${creds.deviceId}… (Ctrl+C to stop)`);
  for (;;) {
    const claim = await fetch(`${url}/api/edge/jobs/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const claimed = await claim.json().catch(() => ({}));
    if (!claim.ok) {
      console.error("claim failed", claim.status, claimed.message || claimed.error);
      await sleep(5000);
      continue;
    }
    const job = claimed.job;
    if (!job) {
      await sleep(2000);
      continue;
    }
    console.log(`Job ${job.id} ${job.kind}`, job.payload);
    const outcome = await handleJob(job);
    const body = outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error || "failed" };
    const done = await fetch(`${url}/api/edge/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`  → ${done.status} ${outcome.ok ? "ok" : outcome.error}`);
  }
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "pair") await pair();
else if (cmd === "run") await runLoop();
else {
  console.log(`Usage:
  node scripts/edge-agent.mjs setup --token esetup_… [--name Host] [--url http://localhost:4000]
  node scripts/edge-agent.mjs run [--url http://localhost:4000]
  node scripts/edge-agent.mjs pair --code 123456 [--name Host] [--url http://localhost:4000]   # legacy`);
  process.exit(cmd ? 1 : 0);
}
