// src/lib/runs-as-summary.ts — whose account a workflow acts as, in one line (sharing-boundaries phase 6).
//
// The three words for Runs as: Workspace, Owner, Each person. In My space there is no choice: its owner's own (Q3).
// Read from the server's Runs as view — the APPROVED choice when there is one (what runs unattended), else the draft's.
import type { FlowRunAs, FlowRunAsChoice } from "@/lib/foundry-client";

function word(c: FlowRunAsChoice): "Workspace" | "Owner" | "Each person" {
  if (c.each) return "Each person";
  // "Its owner's own" (My space) arrives `personal` too, so one test covers both.
  if (c.personal) return "Owner";
  return "Workspace";
}

/** "Workspace", "Owner (Ada's own accounts)", "Each person", or per service when they differ; null: no connected service. */
export function runsAsSummary(runAs: FlowRunAs | null | undefined, ownerName: string): string | null {
  const services = (runAs?.services ?? []).map((s) => ({ service: s.service, choice: s.approved ?? s.current }));
  if (!services.length) return null;
  const words = services.map((s) => (s.choice ? word(s.choice) : null));
  if (words.some((w) => w == null)) return "Not chosen yet";
  const one = new Set(words).size === 1 ? words[0]! : null;
  const say = (w: string) => (w === "Owner" ? `Owner (${ownerName}'s own account${services.length > 1 ? "s" : ""})` : w);
  if (one) return say(one);
  return services.map((s, i) => `${s.service}: ${say(words[i]!)}`).join(" · ");
}
