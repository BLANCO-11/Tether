// Project memory ledger (Phase 4): curated facts a project's chats start with. Not vectors.
import { resolveWorkspaceId } from "@/lib/foundry-client";
import { signInIfEnded } from "@/lib/session-expiry";

const PROXY = "/api/foundry";

export type MemoryKind = "decision" | "preference" | "open_loop" | "note";
export type MemoryStatus = "active" | "superseded" | "discarded";
export type MemorySource = "manual" | "promoted" | "compact";

export type ProjectMemory = {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: MemoryKind;
  body: string;
  status: MemoryStatus;
  source: MemorySource;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
};

async function said(res: Response): Promise<string> {
  const text = await res.text();
  signInIfEnded(res.status, text);
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || `The request failed (${res.status}).`;
  }
}

const base = async (projectId: string) => `${PROXY}/workspaces/${await resolveWorkspaceId()}/projects/${projectId}/memories`;

export async function listProjectMemories(projectId: string, status: MemoryStatus | "all" = "active"): Promise<ProjectMemory[]> {
  const q = status === "active" ? "" : `?status=${status}`;
  const res = await fetch(`${await base(projectId)}${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { memories: ProjectMemory[] }).memories;
}

export async function addProjectMemory(
  projectId: string,
  input: {
    kind: MemoryKind;
    body: string;
    source?: MemorySource;
    sourceChatId?: string | null;
    sourceMessageId?: string | null;
  },
): Promise<ProjectMemory> {
  const res = await fetch(await base(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { memory: ProjectMemory }).memory;
}

export async function setProjectMemoryStatus(projectId: string, memoryId: string, status: "superseded" | "discarded"): Promise<ProjectMemory> {
  const res = await fetch(`${await base(projectId)}/${memoryId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { memory: ProjectMemory }).memory;
}

export async function proposeProjectMemories(
  projectId: string,
  messages: Array<{ role: string; text: string }>,
): Promise<string[]> {
  const res = await fetch(`${await base(projectId)}/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { candidates: string[] }).candidates;
}

/** Local mirror of the server heuristic — used before compact so candidates are from the pre-summary transcript. */
export function pickMemoryCandidatesLocal(messages: Array<{ role: string; text: string }>, limit = 3): string[] {
  const cues = /\b(always|never|prefer|remember|we decided|decision|from now on|don't|do not|please use|use my|call me)\b/i;
  const out: string[] = [];
  for (const m of [...messages].reverse()) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const t = m.text.replace(/\s+/g, " ").trim();
    if (t.length < 12 || t.length > 500) continue;
    if (m.role === "assistant" && !cues.test(t)) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t.slice(0, 500));
    if (out.length >= limit) break;
  }
  return out.reverse();
}
