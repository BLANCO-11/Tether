/**
 * `pnpm --filter @foundry/server builder:replay` — Strategy B Phase 0 harness.
 *
 * Replays frozen rewrite-corpus goals through builderStart/builderAnswer
 * (and builderStart+flowId for `then` edits) and records per-turn collateral
 * signals (spec signature diffs). Measurement: exits non-zero only when it
 * cannot run; failures are the output.
 *
 *   --baseline          write plan/builder-rewrite/baseline.json
 *   --out=<file>        write full results JSON
 *   --only=RW-HR-A01     subset (comma-separated ids)
 *   --corpus=<relpath>  under scenarios/ (default: conversations/rewrite-corpus.json)
 *   --intent-ir         set BUILDER_INTENT_IR=1 (pin + band code-emit + assistant)
 *   --no-intent-ir      set BUILDER_INTENT_IR=0 (legacy path; Intent IR is default ON)
 *   --band-emit         deprecated alias for --intent-ir (Phase 7 folded the flag)
 *
 * HR absence bands (Attendance_DB): conversations/hr-absence-bands-corpus.json
 *
 * ⚠ Completing a build calls `writeRevision` → Kestra validate. On macOS the
 * host cannot reach Kestra (`ECONNREFUSED 127.0.0.1:8080`). Run from the
 * server's network position:
 *
 *   ./scripts/harness-in-net.sh packages/server/src/scenarios/builder-replay.ts \
 *     --corpus=conversations/hr-absence-bands-corpus.json
 *
 * Incomplete / asks / cannot paths do not need Kestra; a complete path does.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builderStart, builderAnswer, builderRebuild, type BuilderTurn } from "../services/builder/conversation.js";
import { EDIT_NOT_ADDITIVE } from "../services/builder/goal-spec.js";
import { intentIrEnabled } from "../services/builder/intent-ir.js";
import { systemAuthor } from "../services/revision-author.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { config } from "../config/index.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const OUT = arg("out");
const CORPUS_REL = arg("corpus") ?? "conversations/rewrite-corpus.json";
const BASELINE = process.argv.includes("--baseline");
if (process.argv.includes("--no-intent-ir")) {
  process.env.BUILDER_INTENT_IR = "0";
} else if (process.argv.includes("--intent-ir") || process.argv.includes("--band-emit")) {
  process.env.BUILDER_INTENT_IR = "1";
}

interface ReplayCase {
  id: string;
  workspace: string;
  goal: string;
  then?: string[];
  answers?: Array<{ when: string; say: string }>;
  expect?: { outcome?: string; maxQuestions?: number; has?: string[] };
  notes?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, CORPUS_REL);
const corpus = (JSON.parse(readFileSync(corpusPath, "utf8")) as ReplayCase[])
  .filter((c) => !ONLY.length || ONLY.includes(c.id));

function isKestraUnreachable(msg: string): boolean {
  return /ECONNREFUSED|UND_ERR_CONNECT|fetch failed|kestra rejected/i.test(msg)
    && (/127\.0\.0\.1:8080|kestra|flows\/validate/i.test(msg) || /ECONNREFUSED/i.test(msg));
}

async function kestraReachable(): Promise<boolean> {
  const base = config.kestra.baseUrl;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/configs`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

const provider = await resolveGenerationProvider();
const model = (provider as { model?: string }).model ?? "unknown";
const kestraOk = await kestraReachable();
console.log(
  `builder:replay · model ${model} · intentIr=${intentIrEnabled() ? "1" : "0"} · corpus ${CORPUS_REL} · ${corpus.length} case(s)` +
    ` · kestra=${kestraOk ? "ok" : "UNREACHABLE"} (${config.kestra.baseUrl})`,
);
if (!kestraOk) {
  console.log(
    "⚠ Kestra is unreachable from this process. Builds that reach `complete` will error with ECONNREFUSED.\n" +
      "  Re-run via: ./scripts/harness-in-net.sh packages/server/src/scenarios/builder-replay.ts --corpus=…",
  );
}

type Row = {
  id: string;
  workspace: string;
  status: string;
  questions: number;
  calls: number;
  seconds: number;
  readbackSigs: string[];
  collateralHints: number;
  unmet?: string[];
  said?: string;
  error?: string;
  fileBacked: boolean;
};

const workspaces = await workspaceRepo.list();
const author = systemAuthor("foundry-test-lead@microland.com");
const made: Array<{ ws: string; flow: string }> = [];
const rows: Row[] = [];

function answerFor(ask: string, c: ReplayCase, options?: string[]): string {
  // Prefer more-specific answer matchers first (longer `when`), so a grouped body+to ask does not
  // collapse to the recipient-only reply because "email address" matched first.
  const answers = [...(c.answers ?? [])].sort((a, b) => b.when.length - a.when.length);
  const a = answers.find((x) => new RegExp(x.when, "i").test(ask));
  if (a) return a.say;
  // Reader choice: pick .new_read / write when listed; never invent an HR attendance band script in other workspaces.
  if (/choose one|new read|written read|bands compute|which read|which (one|reader)/i.test(ask)) {
    const nr = options?.find((o) => /\.new_read\b|new read|write a new/i.test(o));
    if (nr) return nr;
    if (options?.length) return options[0]!;
    if (/attendance|absence|hours.?worked/i.test(ask) || c.workspace === "HR") {
      return "write a new read of the attendance data with the half / full / present bands in SQL";
    }
    return "write a new read that fits what I asked for";
  }
  // Email ports the goal already settled in prose.
  if (/what should the to be/i.test(ask)) return "me";
  if (/what should the (body|subject|text) be/i.test(ask)) {
    return "use the columns / summary from the goal";
  }
  if (/what should the channel be/i.test(ask) && options?.length) return options[0]!;
  if (options?.length) {
    const prefer = options.find((o) => /\.new_read\b/i.test(o));
    return prefer ?? options[0]!;
  }
  return "leave it";
}

function sig(lines: string[]): string {
  return lines.map((l) => l.toLowerCase().replace(/\s+/g, " ").trim()).join("|").slice(0, 500);
}

for (const c of corpus) {
  const ws = workspaces.find((w: { name: string }) => w.name === c.workspace);
  const row: Row = {
    id: c.id,
    workspace: c.workspace,
    status: "error",
    questions: 0,
    calls: 0,
    seconds: 0,
    readbackSigs: [],
    collateralHints: 0,
    fileBacked: (c as { kinds?: string[] }).kinds?.includes("file-backed") ?? false,
  };
  const t0 = Date.now();
  if (!ws) {
    row.error = `no workspace ${c.workspace}`;
    rows.push(row);
    console.log(`· ${c.id} SKIP — ${row.error}`);
    continue;
  }
  let last: BuilderTurn | undefined;
  try {
    let t: BuilderTurn = await builderStart(ws.id, c.goal, author);
    last = t;
    row.calls += t.calls;
    row.readbackSigs.push(sig(t.readback));
    if (t.flowId) made.push({ ws: ws.id, flow: t.flowId });
    const settleAsks = async () => {
      for (let i = 0; i < 6 && t.status === "asks" && t.question && t.flowId; i++) {
        const say = answerFor(t.question.ask, c, t.question.options);
        console.log(`  ask[${i}]: ${JSON.stringify(t.question.ask).slice(0, 240)} → ${JSON.stringify(say).slice(0, 120)}`);
        row.questions++;
        t = await builderAnswer(ws.id, t.flowId, say, author);
        last = t;
        row.calls += t.calls;
        const s = sig(t.readback);
        if (row.readbackSigs.length && row.readbackSigs[row.readbackSigs.length - 1] !== s) {
          const prev = row.readbackSigs[row.readbackSigs.length - 1]!;
          if (Math.abs(prev.length - s.length) > 80) row.collateralHints++;
        }
        row.readbackSigs.push(s);
      }
    };
    await settleAsks();
    // `then` is an edit of the completed draft — same entry as chat (`builderStart` with flowId),
    // never `builderAnswer` (that path requires a pending question). Non-additive changes fall
    // through to `builderRebuild`, matching `flow-chat-builder` (EDIT_NOT_ADDITIVE → restate+rebuild).
    for (const msg of c.then ?? []) {
      if (!t.flowId || t.status !== "complete") break;
      const flowId = t.flowId;
      console.log(`  then: ${JSON.stringify(msg).slice(0, 160)}`);
      t = await builderStart(ws.id, msg, author, flowId);
      if (t.status === "cannot" && [t.said ?? "", ...(t.unmet ?? [])].some((l) => l.includes(EDIT_NOT_ADDITIVE))) {
        console.log(`  then→rebuild (non-additive)`);
        const rb = await builderRebuild(ws.id, flowId, msg, author);
        t = { ...rb, calls: rb.calls + t.calls };
      }
      last = t;
      row.calls += t.calls;
      row.readbackSigs.push(sig(t.readback));
      await settleAsks();
    }
    row.status = t.status;
    if (t.status === "incomplete" || t.status === "asks") {
      console.log(`  terminal=${t.status} said=${JSON.stringify(t.said ?? "").slice(0, 200)} unmet=${JSON.stringify(t.unmet ?? []).slice(0, 300)}`);
    }
    if (t.unmet?.length) row.unmet = t.unmet.slice(0, 8);
    if (t.said) row.said = t.said.slice(0, 300);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400);
    row.error = msg;
    if (isKestraUnreachable(msg)) {
      row.status = "infra_kestra";
      row.error = `Kestra unreachable (not a builder verdict): ${msg}`;
    }
    if (last?.unmet?.length) row.unmet = last.unmet.slice(0, 8);
    if (last?.said) row.said = last.said.slice(0, 300);
  }
  row.seconds = Math.round((Date.now() - t0) / 1000);
  rows.push(row);
  const extra = [
    row.error ? ` · ${row.error}` : "",
    row.unmet?.length ? ` · unmet=${JSON.stringify(row.unmet)}` : "",
    row.said ? ` · said=${JSON.stringify(row.said)}` : "",
  ].join("");
  console.log(`· ${c.id} ${row.status} · q=${row.questions} · calls=${row.calls} · ${row.seconds}s${extra}`);
}

for (const m of made) {
  try {
    const { flowService } = await import("../services/flow.service.js");
    await flowService.remove(m.ws, m.flow);
  } catch (e) {
    const msg = (e as Error).message;
    if (isKestraUnreachable(msg)) {
      // Drop the Foundry row when Kestra cannot be reached — otherwise harness junk accumulates.
      try {
        await flowRepo.remove(m.ws, m.flow);
        console.log(`cleanup ${m.flow}: removed from Foundry only (Kestra unreachable)`);
      } catch (e2) {
        console.log(`cleanup ${m.flow}: ${(e2 as Error).message}`);
      }
    } else {
      console.log(`cleanup ${m.flow}: ${msg}`);
    }
  }
}

const summary = {
  at: new Date().toISOString(),
  model,
  intentIr: intentIrEnabled(),
  kestraReachable: kestraOk,
  cases: rows.length,
  byStatus: rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
  fileBackedPresent: rows.some((r) => r.fileBacked),
  rows,
};

if (BASELINE) {
  const dir = join(here, "../../../../plan/builder-rewrite");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "baseline.json");
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`wrote baseline ${path}`);
}
if (OUT) {
  mkdirSync(dirname(OUT.startsWith("/") ? OUT : join(process.cwd(), OUT)), { recursive: true });
  writeFileSync(OUT.startsWith("/") ? OUT : join(process.cwd(), OUT), JSON.stringify(summary, null, 2));
}

console.log(JSON.stringify({
  byStatus: summary.byStatus,
  intentIr: summary.intentIr,
  kestraReachable: summary.kestraReachable,
  fileBackedPresent: summary.fileBackedPresent,
}, null, 2));
process.exit(0);
