/**
 * Workflow references (2026-10-17): a Workflow Builder chat learns from up to MAX_REFERENCES saved workflows of its own
 * workspace. Plan: plans/workflow-references-2026-10-16/ (a label — plans/ is gitignored).
 *
 * Two halves, both written by the SERVER, never by a model:
 * - the CARD — a summary built by code from the saved version only, put in the prompt every turn;
 * - the CODE — that version's workflow.json and step files, copied read-only into `references/<slug>/`.
 *
 * ⚠ The card does not try to pull rules (thresholds, statuses) out of the code: a code-built extractor for that would
 * be a guess dressed as fact. It points Forge at the code instead. And it never carries the old conversation.
 * ⚠ Data files are never copied — the card names the files the workflow read and says they are not here.
 * ⚠ `references/` is only ever removed and rewritten, never read back: Forge can leave a link in it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { sandboxDir } from "./sandbox-fs.js";
import { kindOf, type PiArm, type PiCondition, type PiStep, type PiWorkflow } from "./types.js";

export const MAX_REFERENCES = 3;
export const REFERENCES_DIR = "references";

/** What a reference's copy holds: the saved bundle's workflow and its step files (`steps/...py`). */
export type ReferenceBundle = { workflow: PiWorkflow & { reads?: Record<string, unknown> }; files: Record<string, string> };

export type CardSource = {
  name: string;
  description: string | null;
  revision: number;
  savedAt: Date | null;
  /** The approval number the workflows list shows for this revision, when it was approved. */
  approvedAs: number | null;
  bundle: ReferenceBundle;
};

/** "saved 3" — and "saved 3 · approved as v1" when that saved version was approved. Never a bare "v3" (plan §7). */
export function versionLabel(revision: number, approvedAs: number | null): string {
  return approvedAs ? `saved ${revision} · approved as v${approvedAs}` : `saved ${revision} · not approved`;
}

function day(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "on an unrecorded date";
}

function conditionText(c: PiCondition | undefined): string {
  if (!c) return "otherwise";
  if ("all" in c) return c.all.map(conditionText).join(" and ");
  if ("any" in c) return c.any.map(conditionText).join(" or ");
  if ("not" in c) return `not (${conditionText(c.not)})`;
  return c.to === undefined ? `${c.value} ${c.op}` : `${c.value} ${c.op} ${JSON.stringify(c.to)}`;
}

function stepLines(nodes: PiStep[] | undefined, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  for (const n of nodes ?? []) {
    const kind = kindOf(n);
    if (kind === "loop") {
      out.push(`${pad}- ${n.id}: for each item of ${n.foreach}${n.as ? ` (as ${n.as})` : ""}`);
      stepLines(n.steps, depth + 1, out);
    } else if (kind === "branch") {
      out.push(`${pad}- ${n.id}: a choice`);
      for (const arm of n.branch as PiArm[]) {
        const steps = arm.steps ?? [];
        out.push(`${pad}  - ${arm.else ? "otherwise" : `if ${conditionText(arm.if)}`}: ${steps.length ? "" : "nothing"}`.trimEnd());
        stepLines(steps, depth + 2, out);
      }
    } else if (kind === "approval") {
      out.push(`${pad}- ${n.id}: waits for a person's approval (${n.approval?.title ?? "approval"})`);
    } else {
      out.push(`${pad}- ${n.id}${n.description ? `: ${n.description}` : ""}${n.entry ? ` [code: ${n.entry}]` : ""}`);
    }
  }
}

function allStepNodes(nodes: PiStep[] | undefined): PiStep[] {
  const out: PiStep[] = [];
  for (const n of nodes ?? []) {
    out.push(n);
    out.push(...allStepNodes(n.steps));
    for (const arm of n.branch ?? []) out.push(...allStepNodes(arm.steps));
  }
  return out;
}

/** The card for one saved version, built by code from the bundle alone. */
export function buildCard(src: CardSource): string {
  const wf = src.bundle.workflow;
  const nodes = allStepNodes(wf.steps);
  const uses = (prefix: string) => [...new Set(nodes.flatMap((n) => (n.uses ?? []).filter((u) => u.startsWith(prefix)).map((u) => u.slice(prefix.length))))];
  const files = uses("file:");
  const reads = [...new Set([...uses("read:"), ...Object.keys(wf.reads ?? {})])];
  const tools = uses("tool:");

  const lines: string[] = [`# ${src.name}`, `Saved version ${src.revision}, saved ${src.savedAt ? day(src.savedAt) : day(null)}, ${src.approvedAs ? `approved (as v${src.approvedAs} on the workflows list)` : "not approved"}.`];
  const purpose = src.description?.trim();
  if (purpose) lines.push("", `Purpose (as saved): ${purpose}`);

  const inputs = Object.entries(wf.inputs ?? {});
  lines.push("", "## Inputs");
  if (!inputs.length) lines.push("none");
  for (const [k, d] of inputs) {
    const bits = [d.type, d.default !== undefined ? `default ${JSON.stringify(d.default)}` : null, d.relative ? `real runs: ${d.relative}` : null].filter(Boolean);
    lines.push(`- ${k}${bits.length ? ` (${bits.join(", ")})` : ""}${d.description ? `: ${d.description}` : ""}`);
  }
  if (wf.schedule) lines.push("", `## Schedule`, `${wf.schedule.cron}${wf.schedule.timezone ? ` (${wf.schedule.timezone})` : ""}`);

  lines.push("", "## Steps");
  const steps: string[] = [];
  stepLines(wf.steps, 0, steps);
  lines.push(...(steps.length ? steps : ["none"]));

  lines.push("", "## What it reaches");
  lines.push(`- Data it reads: ${reads.length ? reads.join(", ") : "none"}`);
  lines.push(`- Tools it calls: ${tools.length ? tools.join(", ") : "none"}`);
  lines.push(
    `- Files it read: ${files.length ? files.map((f) => JSON.stringify(f)).join(", ") : "none"}${
      files.length ? ". These files are NOT copied here. If the new workflow needs them, ask the person, or use them if they are in the workspace's Files." : ""
    }`,
  );

  const outs = nodes.filter((n) => n.outputs?.length);
  if (outs.length) {
    lines.push("", "## Outputs");
    for (const n of outs) lines.push(`- ${n.id}: ${n.outputs!.join(", ")}`);
    for (const n of nodes) for (const a of n.allow_empty ?? []) lines.push(`- ${n.id}.${a.output}${a.field ? `.${a.field}` : ""} may be empty: ${a.reason}`);
  }

  const code = Object.entries(src.bundle.files).sort(([a], [b]) => a.localeCompare(b));
  lines.push("", "## Code");
  if (!code.length) lines.push("none");
  for (const [path, text] of code) lines.push(`- ${path} (${text.split("\n").length} lines)`);
  if (code.length) lines.push("The exact rules (thresholds, statuses, how files are parsed) are in this code. Open it before reusing any of them.");
  return lines.join("\n") + "\n";
}

/** A folder name for a reference, unique among `taken`. */
export function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "workflow";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}

/** A reference as the folder and the prompt see it. */
export type FolderReference = { slug: string; name: string; label: string; cardMd: string; bundle: ReferenceBundle; deleted: boolean };

/** Only a step file under steps/ ending .py, with no way out of its folder: anything else in a bundle is not copied. */
export function safeCodePath(p: string): boolean {
  const n = normalize(p);
  return n === p && p.startsWith("steps/") && p.endsWith(".py") && !p.split("/").some((seg) => seg === ".." || seg === "" || seg.startsWith("."));
}

/**
 * Remove `references/` and write it again from the rows. Never reads it: whatever Forge left there (a changed file, a
 * link) is removed with the folder, and nothing is written through it.
 */
export function writeReferences(workspaceId: string, sessionId: string, refs: FolderReference[]): void {
  const root = join(sandboxDir(workspaceId, sessionId), REFERENCES_DIR);
  rmSync(root, { recursive: true, force: true });
  if (!refs.length) return;
  for (const r of refs) {
    const dir = join(root, r.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CARD.md"), r.cardMd);
    writeFileSync(join(dir, "workflow.json"), JSON.stringify(r.bundle.workflow, null, 2) + "\n");
    for (const [path, text] of Object.entries(r.bundle.files)) {
      if (!safeCodePath(path)) continue;
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
}

/** Remove `references/` (Forge Agent turns, a chat with none left). */
export function clearReferences(workspaceId: string, sessionId: string): void {
  rmSync(join(sandboxDir(workspaceId, sessionId), REFERENCES_DIR), { recursive: true, force: true });
}

/** The prompt section: each reference's folder, label and card. Empty when there are none. */
export function cardsBlock(refs: FolderReference[], moved: string[] = []): string[] {
  if (!refs.length) return [];
  const lines = ["", "Referenced workflows (read-only examples the person chose, in references/; see SYSTEM.md, Referenced workflows):"];
  for (const r of refs) {
    lines.push(`- ${REFERENCES_DIR}/${r.slug}/ — ${r.name}, ${r.label}${r.deleted ? " (this workflow has since been deleted; the copy is as it was saved)" : ""}`);
    lines.push(r.cardMd.trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
  }
  for (const m of moved) lines.push(m);
  return lines;
}
