/**
 * "What each role can do" — the rows of the read-only Roles table (admin simplify, 2026-10-30).
 *
 * Each row is a plain sentence and the workspace permissions it stands for. Whether a role has the row is never
 * written down: the client works it out from the permissions the server says each built-in role holds, and the
 * server's `role-matrix.test.ts` checks every row against `role-presets.ts`. Here so both packages read ONE list.
 */
export interface MatrixRow {
  label: string;
  /** Every one must be held for the row to apply. */
  needs: readonly string[];
  /** The one qualification that changes the answer, shown beside the row. */
  note?: string;
}

export const MATRIX_ROWS: readonly MatrixRow[] = [
  { label: "See what is shared in the workspace, and its live runs", needs: ["flows.read", "runs.read"] },
  { label: "See who is in the workspace", needs: ["members.read"] },
  { label: "Build and test their own workflows", needs: ["flows.write", "flows.run"] },
  { label: "Connect a database and write the reads that use it", needs: ["datasources.write", "datasources.query.write"] },
  {
    label: "Connect their own account to a service and switch on actions for themselves",
    needs: ["plugins.read"],
    note: "Unless an Admin has turned personal use off for that service.",
  },
  { label: "Approve or reject a paused step", needs: ["approvals.decide"], note: "Only in runs of workflows they own." },
  { label: "Review workflows, put them live and manage their schedules", needs: ["flows.approve", "flows.arm"], note: "Not their own work, unless they are a super admin." },
  { label: "Run a past run again", needs: ["runs.replay"] },
  { label: "Connect a service for the whole workspace and choose its actions", needs: ["plugins.enable"] },
  { label: "Add and remove people, and change their roles", needs: ["members.grant"] },
  { label: "See everyone's private work, usage and cost", needs: ["content.read.others", "reports.read"] },
  { label: "Manage credentials, tools, limits and the audit history", needs: ["secrets.write", "tools.write", "budget.write", "audit.read"] },
];

export type Cell = "yes" | "no" | "partly";

export function cellFor(row: MatrixRow, held: readonly string[]): Cell {
  const have = row.needs.filter((p) => held.includes(p)).length;
  return have === row.needs.length ? "yes" : have === 0 ? "no" : "partly";
}
