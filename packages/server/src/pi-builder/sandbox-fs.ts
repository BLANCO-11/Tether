import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { SANDBOXES_ROOT, TEMPLATE_ROOT } from "./paths.js";
import type { PiQuestionsFile, PiWorkflow } from "./types.js";
import { normaliseQuestions } from "./question-kinds.js";

const TRACKED = ["workflow.json", "questions.json", "answers.json", "GOAL.md", "steps"] as const;

/**
 * Per-workspace, per-session tree. Two workflows never share a directory —
 * paths are `.pi-sandboxes/<workspaceId>/<sessionId>/`.
 */
export function sessionRoot(workspaceId: string, sessionId: string): string {
  return join(SANDBOXES_ROOT, workspaceId, sessionId);
}

export function sandboxDir(workspaceId: string, sessionId: string): string {
  return join(sessionRoot(workspaceId, sessionId), "sandbox");
}

export function createSessionTree(workspaceId: string, sessionId: string, goal: string): string {
  mkdirSync(join(SANDBOXES_ROOT, workspaceId), { recursive: true });
  const root = sessionRoot(workspaceId, sessionId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  cpSync(TEMPLATE_ROOT, root, { recursive: true });
  const sbx = sandboxDir(workspaceId, sessionId);
  writeFileSync(join(sbx, "workflow.json"), JSON.stringify({ steps: [] }, null, 2) + "\n");
  writeFileSync(
    join(sbx, "questions.json"),
    JSON.stringify({ status: "idle", questions: [] }, null, 2) + "\n",
  );
  writeFileSync(join(sbx, "answers.json"), "{}\n");
  rmSync(join(sbx, "steps"), { recursive: true, force: true });
  mkdirSync(join(sbx, "steps"), { recursive: true });
  const goalBody = goal.trim()
    ? `# GOAL\n\n${goal.trim()}\n`
    : "# GOAL\n\n(describe the automation)\n";
  writeFileSync(join(sbx, "GOAL.md"), goalBody);
  return root;
}

export function destroySessionTree(workspaceId: string, sessionId: string): void {
  const root = sessionRoot(workspaceId, sessionId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/**
 * Whether a path in a conversation's folder really is inside that folder once links are followed (2026-10-13). Forge
 * can write anything in its folder, a symbolic link included, and the server reads that folder: a link to one of the
 * server's own files (its environment, its keys) would have the server read it out and show it, store it, or hand it
 * back to Forge. Every server read of a conversation's files goes through this. A path that does not exist is not
 * confined (there is nothing to read).
 */
export function confined(path: string): boolean {
  const rel = relative(SANDBOXES_ROOT, path);
  const [ws, sid] = rel.split(sep);
  if (!ws || !sid || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    const base = realpathSync(join(SANDBOXES_ROOT, ws, sid));
    const real = realpathSync(path);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path) || !confined(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readWorkflow(workspaceId: string, sessionId: string): PiWorkflow {
  return readJson(join(sandboxDir(workspaceId, sessionId), "workflow.json"), { steps: [] });
}

/** Forge's questions, normalised (question-kinds.ts): every reader sees the card the person will see. */
export function readQuestions(workspaceId: string, sessionId: string): PiQuestionsFile {
  const raw = readJson<PiQuestionsFile>(join(sandboxDir(workspaceId, sessionId), "questions.json"), {
    status: "idle",
    questions: [],
  });
  return { ...raw, questions: normaliseQuestions(raw?.questions) };
}

/** A `multi` answer is stored as a list and a `number` as a number (question-kinds.ts `toStored`). */
export function readAnswers(workspaceId: string, sessionId: string): Record<string, unknown> {
  return readJson(join(sandboxDir(workspaceId, sessionId), "answers.json"), {});
}

export function writeAnswers(
  workspaceId: string,
  sessionId: string,
  answers: Record<string, unknown>,
): void {
  writeFileSync(
    join(sandboxDir(workspaceId, sessionId), "answers.json"),
    JSON.stringify(answers, null, 2) + "\n",
  );
}

export function writeGoal(workspaceId: string, sessionId: string, goal: string): void {
  writeFileSync(
    join(sandboxDir(workspaceId, sessionId), "GOAL.md"),
    `# GOAL\n\n${goal.trim()}\n`,
  );
}

export function takeSnapshot(
  workspaceId: string,
  sessionId: string,
  label = "accept",
): { id: string; label: string } {
  const sbx = sandboxDir(workspaceId, sessionId);
  const snapRoot = join(sbx, ".snapshots");
  mkdirSync(snapRoot, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomBytes(3).toString("hex")}`;
  const dest = join(snapRoot, id);
  mkdirSync(dest, { recursive: true });
  for (const name of TRACKED) {
    const src = join(sbx, name);
    if (!existsSync(src) || !confined(src) || lstatSync(src).isSymbolicLink()) continue;
    const st = statSync(src);
    if (st.isDirectory()) cpSync(src, join(dest, name), { recursive: true });
    else cpSync(src, join(dest, name));
  }
  const meta = {
    id,
    label,
    createdAt: new Date().toISOString(),
    files: TRACKED.filter((n) => existsSync(join(dest, n))),
  };
  writeFileSync(join(dest, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(join(snapRoot, "LATEST"), `${id}\n`);
  return { id, label };
}

/**
 * The session's runnable bundle: `workflow.json` plus every file under `steps/` — exactly what flow-runner
 * executes and what a revision will store (P3). Nothing else in the sandbox travels: not the catalogue, not
 * GOAL.md, not anything Pi left lying around.
 */
export function readBundle(workspaceId: string, sessionId: string): {
  workflow: PiWorkflow & { reads?: Record<string, unknown> };
  files: Record<string, string>;
} {
  const sbx = sandboxDir(workspaceId, sessionId);
  const workflow = readJson(join(sbx, "workflow.json"), { steps: [] }) as PiWorkflow & { reads?: Record<string, unknown> };
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "__pycache__" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      // Never through a link (`confined`): a step file that is a link to a server file would be shown and stored.
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !confined(abs)) continue;
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile() && name.endsWith(".py")) files[r] = readFileSync(abs, "utf8");
    }
  };
  walk(join(sbx, "steps"), "steps");
  return { workflow, files };
}

/**
 * Put a saved bundle back into a session's sandbox (pi-runtime P3) — the inverse of `readBundle`.
 * Paths are re-checked: a stored bundle is data, and a path escaping `steps/` is refused rather than written.
 */
export function writeBundle(
  workspaceId: string,
  sessionId: string,
  bundle: { workflow: unknown; files: Record<string, string> },
  goal: string,
): void {
  const sbx = sandboxDir(workspaceId, sessionId);
  writeFileSync(join(sbx, "workflow.json"), JSON.stringify(bundle.workflow, null, 2) + "\n");
  for (const [rel, text] of Object.entries(bundle.files)) {
    const norm = rel.replace(/\\/g, "/");
    if (!norm.startsWith("steps/") || norm.split("/").includes("..")) {
      throw new Error(`stored bundle names a file outside steps/: ${rel}`);
    }
    const dest = join(sbx, norm);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, text);
  }
  if (goal.trim()) writeGoal(workspaceId, sessionId, goal);
}

/**
 * How many bytes a conversation's folder holds (everything under its session root, as the forge host counts it).
 * Links are counted as links, never followed. `chat` is the part the person can remove: the chat's files.
 */
export function folderUsage(workspaceId: string, sessionId: string): { bytes: number; chat: number } {
  let bytes = 0;
  let chat = 0;
  const sbx = sandboxDir(workspaceId, sessionId);
  const walk = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        return;
      }
      for (const n of names) walk(join(p, n));
    } else {
      bytes += st.size;
      if (p.startsWith(join(sbx, "files") + sep) || p.startsWith(join(sbx, "out") + sep)) chat += st.size;
    }
  };
  walk(sessionRoot(workspaceId, sessionId));
  return { bytes, chat };
}

/**
 * What a Forge Agent turn may not change (0097): the chat's workflow, `workflow.json` and `steps/`, as text. Taken
 * before the turn and compared after it; a difference is put back with `restoreWorkflowSnapshot`.
 */
export function workflowSnapshot(workspaceId: string, sessionId: string): string {
  return JSON.stringify(readBundle(workspaceId, sessionId));
}

/**
 * Put the workflow back as the snapshot had it. Each path is removed first and written fresh, never written through,
 * because Forge can leave a link in its place; GOAL.md is rewritten from the server's record of the goal, never read
 * back from the folder.
 */
export function restoreWorkflowSnapshot(workspaceId: string, sessionId: string, snapshot: string, goal: string): void {
  const bundle = JSON.parse(snapshot) as { workflow: unknown; files: Record<string, string> };
  const sbx = sandboxDir(workspaceId, sessionId);
  rmSync(join(sbx, "steps"), { recursive: true, force: true });
  rmSync(join(sbx, "workflow.json"), { force: true });
  rmSync(join(sbx, "GOAL.md"), { force: true });
  mkdirSync(join(sbx, "steps"), { recursive: true });
  writeBundle(workspaceId, sessionId, bundle, "");
  writeGoal(workspaceId, sessionId, goal.trim() || "(describe the automation)");
}

export function listSnapshots(workspaceId: string, sessionId: string): string[] {
  const snapRoot = join(sandboxDir(workspaceId, sessionId), ".snapshots");
  if (!existsSync(snapRoot)) return [];
  return readdirSync(snapRoot).filter(
    (n) => n !== "LATEST" && existsSync(join(snapRoot, n, "meta.json")),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * At server start, remove every session tree left by the last process, and the attachments of drafts that never
 * became a workflow. Sessions live in memory, so after a restart no tree belongs to anyone: a saved workflow's
 * conversation and Forge session are in the database and its tree is rebuilt on the next open. The 30-minute sweep
 * only ever cleaned up sessions this process knew about, so a restart used to leave every open draft's tree behind
 * for good. A workflow's attachments (`_attachments/flow-*`) and the catalogue (`_catalog`) are kept.
 *
 * Call it ONCE, before the server takes requests — never from a module a harness or test imports.
 */
export function removeOrphanedSessionTrees(root = SANDBOXES_ROOT): { trees: number; draftFiles: number } {
  let trees = 0;
  let draftFiles = 0;
  if (!existsSync(root)) return { trees, draftFiles };
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws);
    if (ws.startsWith("_") || !statSync(wsDir).isDirectory()) continue;
    // The first layout kept a session at the top level (`.pi-sandboxes/<session>/sandbox`), with no workspace above it.
    if (existsSync(join(wsDir, "sandbox"))) {
      rmSync(wsDir, { recursive: true, force: true });
      trees += 1;
      continue;
    }
    for (const name of readdirSync(wsDir)) {
      if (UUID.test(name)) {
        rmSync(join(wsDir, name), { recursive: true, force: true });
        trees += 1;
      }
    }
    const att = join(wsDir, "_attachments");
    if (existsSync(att)) {
      for (const scope of readdirSync(att)) {
        if (scope.startsWith("session-")) {
          rmSync(join(att, scope), { recursive: true, force: true });
          draftFiles += 1;
        }
      }
    }
  }
  return { trees, draftFiles };
}
