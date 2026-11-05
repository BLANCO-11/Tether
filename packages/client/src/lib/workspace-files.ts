// A workspace's Files (Resources → Files): documents, sheets, images and text a workflow reads when it RUNS.
// Not chat attachments (context for Forge while building) and not a SQLite data source (read by queries).
import { resolveWorkspaceId } from "@/lib/foundry-client";
import { signInIfEnded } from "@/lib/session-expiry";
import { ATTACH_ACCEPT, attachRefusal } from "@/lib/pi-builder";

const PROXY = "/api/foundry";

export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** The same types chat attachments take: one rule for what Forge can be shown and what a workflow can read. */
export const FILE_ACCEPT = ATTACH_ACCEPT;

export type WorkspaceFile = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
  /** Workflows whose working draft lists `file:<name>` in a step's uses. */
  usedBy: Array<{ id: string; name: string }>;
};

/** Why this file cannot be uploaded, checked before sending (the server still decides), or null. */
export function fileRefusal(file: File): string | null {
  return attachRefusal(file);
}

async function said(res: Response): Promise<string> {
  const text = await res.text();
  signInIfEnded(res.status, text);
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || `The request failed (${res.status}).`;
  }
}

export async function listWorkspaceFiles(): Promise<WorkspaceFile[]> {
  const ws = await resolveWorkspaceId();
  const res = await fetch(`${PROXY}/workspaces/${ws}/files`, { cache: "no-store" });
  if (!res.ok) throw new Error(await said(res));
  return ((await res.json()) as { files: WorkspaceFile[] }).files;
}

export async function deleteWorkspaceFile(id: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  const res = await fetch(`${PROXY}/workspaces/${ws}/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await said(res));
}

export async function workspaceFileUrl(id: string): Promise<string> {
  const ws = await resolveWorkspaceId();
  return `${PROXY}/workspaces/${ws}/files/${id}/content`;
}

/** Upload with progress; `abort` cancels it. */
export function uploadWorkspaceFile(
  wsId: string,
  file: File,
  onProgress: (fraction: number) => void,
): { done: Promise<WorkspaceFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<WorkspaceFile>((resolve, reject) => {
    xhr.open("POST", `${PROXY}/workspaces/${wsId}/files`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { file: WorkspaceFile }).file);
        } catch {
          reject(new Error("The upload finished but its answer could not be read."));
        }
        return;
      }
      signInIfEnded(xhr.status, xhr.responseText);
      let msg = xhr.responseText;
      try {
        msg = (JSON.parse(xhr.responseText) as { message?: string }).message ?? msg;
      } catch {
        /* plain text */
      }
      reject(new Error(msg || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the server."));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
