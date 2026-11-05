"use client";

// What a workspace is for and what Forge may do in it — one form, used when a workspace is created (Workspaces) and
// when it is changed (the workspace's Settings tab). Moved out of the Workspaces page in admin simplify phase 4 so the
// two places cannot drift.

import { Textarea } from "@/components/ui/Field";

export const PURPOSE_MIN = 10;

/** The server's sentence out of a refused request, or the error as it is. */
export function said(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const body = text.replace(/^\d{3}\s*/, "");
  try {
    const j = JSON.parse(body) as { message?: string; error?: unknown; issues?: Array<{ message?: string }> };
    return j.issues?.[0]?.message ?? j.message ?? (typeof j.error === "string" ? j.error : body);
  } catch {
    return text;
  }
}

/**
 * What a workspace is for, and what Forge does in it — asked when it is created, changeable later. The purpose is
 * given to Forge on every message to keep it on topic. Allowing Forge Agent (a permission) lets a person put a chat in
 * that mode (2026-10-13), where Forge does everyday tasks now, and lets Forge answer from the real data, read-only, in
 * any chat; email stays a draft.
 */
export function SetupFields({
  purpose,
  onPurpose,
  assistant,
  onAssistant,
  agentChanges,
  onAgentChanges,
  selfEnable,
  onSelfEnable,
  webAccess,
  onWebAccess,
}: {
  purpose: string;
  onPurpose: (v: string) => void;
  assistant: boolean;
  onAssistant: (v: boolean) => void;
  /** Only where an existing workspace is set up; a new one starts read-only. */
  agentChanges?: boolean;
  onAgentChanges?: (v: boolean) => void;
  /** Only where an existing workspace is set up; a new one starts with it on. */
  selfEnable?: boolean;
  onSelfEnable?: (v: boolean) => void;
  /** Only where an existing workspace is set up; a new one starts with it on. */
  webAccess?: boolean;
  onWebAccess?: (v: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-caption font-medium text-text">What is this workspace for?</span>
        <Textarea
          mono={false}
          rows={2}
          value={purpose}
          onChange={(e) => onPurpose(e.target.value)}
          placeholder="e.g. Attendance, leave and payroll checks for the HR team."
          aria-label="Workspace purpose"
          maxLength={500}
        />
        <span className="block text-caption text-dim">One sentence. Forge uses it to stay on topic.</span>
      </label>
      <div className="space-y-2">
        <span className="block text-caption font-medium text-text">What Forge may do here</span>
        <p className="text-caption text-muted">Forge always builds and edits workflows here, and the files that go with them.</p>
        <label className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${assistant ? "border-accent/60 bg-accent-bg-2/40" : "border-line"}`}>
          <input
            type="checkbox"
            aria-label="Also offer Forge Agent and read real data"
            checked={assistant}
            onChange={(e) => onAssistant(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-body font-medium text-text">Also offer Forge Agent, and read real data (read-only)</span>
            <span className="block text-caption text-muted">
              People can switch a chat to Forge Agent, where Forge answers questions, writes and summarises, and makes
              documents and sheets right away, without building a workflow. In any chat Forge may also answer from this
              workspace&apos;s real data, read-only (every read is logged). Emails are drafts it never sends.
            </span>
          </span>
        </label>
        {onAgentChanges && (
          <label className={`ml-6 flex gap-2.5 rounded-lg border p-3 ${!assistant ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${agentChanges && assistant ? "border-accent/60 bg-accent-bg-2/40" : "border-line"}`}>
            <input
              type="checkbox"
              aria-label="Let Forge Agent propose changes in connected services"
              checked={!!agentChanges && assistant}
              disabled={!assistant}
              onChange={(e) => onAgentChanges(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-body font-medium text-text">Let Forge Agent propose changes in connected services</span>
              <span className="block text-caption text-muted">
                Forge Agent may propose a change, like closing a task or opening an issue. It shows the exact change as a
                card, and only the person&apos;s own click does it, as them. Each one is recorded. Deleting is never done
                from chat.
              </span>
            </span>
          </label>
        )}
      </div>
      {onSelfEnable && (
        <div className="space-y-2">
          <span className="block text-caption font-medium text-text">Workflows</span>
          <label className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${selfEnable ? "border-accent/60 bg-accent-bg-2/40" : "border-line"}`}>
            <input
              type="checkbox"
              aria-label="Members may switch on their own workflows"
              checked={!!selfEnable}
              onChange={(e) => onSelfEnable(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-body font-medium text-text">Members may switch on their own workflows</span>
              <span className="block text-caption text-muted">
                A workflow that uses only its owner&apos;s own things (their own connections, the AI summary tool, steps
                that only work things out) can be switched on by its owner, with no reviewer. Anything that uses this
                workspace&apos;s data, files, mailbox or connections still needs a reviewer. Turned off, those already
                switched on stop running until a reviewer approves them.
              </span>
            </span>
          </label>
        </div>
      )}
      {onWebAccess && (
        <div className="space-y-2">
          <span className="block text-caption font-medium text-text">The web</span>
          <label className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${webAccess ? "border-accent/60 bg-accent-bg-2/40" : "border-line"}`}>
            <input
              type="checkbox"
              aria-label="Workflows and Forge may read the web"
              checked={!!webAccess}
              onChange={(e) => onWebAccess(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-body font-medium text-text">Workflows and Forge may read the web</span>
              <span className="block text-caption text-muted">
                Reads public web addresses: news and RSS feeds, web pages, public APIs. It only reads; it never signs in or
                sends anything, and private or internal addresses are always refused. Every read is recorded. Turned off,
                a workflow step that reads the web fails with a clear message.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
