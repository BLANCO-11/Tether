// A project's files (0132): documents its members share, which every chat in the project can open. Seen by the
// project's members and Admins only. Not the workspace's Files: a workflow cannot open a project file when it runs.
import { resolveWorkspaceId } from "@/lib/foundry-client";
import { signInIfEnded } from "@/lib/session-expiry";
import { FILE_ACCEPT, fileRefusal } from "@/lib/workspace-files";

const PROXY = "/api/foundry";

/** The same types and per-file limit as workspace Files. */
export const PROJECT_FILE_ACCEPT = FILE_ACCEPT;
export const projectFileRefusal = fileRefusal;

export type ProjectFile = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedByEmail: string | null;
  createdAt: string;
  /** Whoever added it, the project's owner, or an Admin. */
  canRemove: boolean;
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

const base = async (projectId: string) => `${PROXY}/workspaces/${await resolveWorkspaceId()}/projects/${projectId}/files`;

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const res = await fetch(await base(projectId), { cache: "no-store" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { files: ProjectFile[] }).files;
}

export async function addProjectFile(projectId: string, file: File): Promise<ProjectFile> {
  const res = await fetch(await base(projectId), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { file: ProjectFile }).file;
}

export async function removeProjectFile(projectId: string, fileId: string): Promise<void> {
  const res = await fetch(`${await base(projectId)}/${fileId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await said(res));
}

export async function projectFileUrl(projectId: string, fileId: string): Promise<string> {
  return `${await base(projectId)}/${fileId}/content`;
}

/** "PDF", "XLSX"… for the file's badge. */
export function fileBadge(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "";
  return ext.slice(0, 4) || "FILE";
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
