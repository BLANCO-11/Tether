// src/components/ops/AllowRequest.tsx — "an automation cannot use this yet, and
// here is exactly what to ask an admin for."
//
// ── ⚠ WHY THIS IS NOT A "REQUEST ACCESS" BUTTON ─────────────────────────────
//
// There is no `allowed_plugins` table yet, so nothing server-side could receive a
// request, queue one, or tell anybody it arrived. A button labelled "Request" over
// that hole is the exact
// defect this codebase names twice — the `/apps` mock and the connector
// catalogue's inert entries — and its own plan says it a third time: *half of
// Phase 8 is worse than none of it*, because an admin surface that grants a
// capability nobody has is worse than a page that says the capability is
// missing.
//
// ── WHERE THAT DESIGN LIVES ─────────────────────────────────────────────────
//
// The design this panel sits in front of was "Phase 8 — plugins as workflow
// components", and its home MOVED. It was `plans/platform-coherence/plan.md`,
// which had been deleted from the working tree — this comment cited a path that
// did not exist, which is what made the panel read as unfinished work rather
// than as a deliberate refusal. Two current pointers, both of which exist:
//
//   · `platform-coherence/plan.md` — the original Phase 8
//     design, restored 2026-08-10 and unedited.
//   · `plans/foundations-2026-08-10/phase-4-plugins/` — the CURRENT plan, which
//     supersedes it. Read `decisions.md` D-124 before touching this file: the
//     `allowed_plugins` table gains two credential modes, and anything
//     credentialed is `foundry_proxied` rather than emitting the plugin class.
//
// ⚠ Phase 4 also records that the obvious claim about it is FALSE: `plugin-slack`
// and `plugin-email` are the only inline-shaped groups and both are credentialed,
// so `credential_mode:'none'` has zero members on day one. "The six installed
// plugin groups become usable" is not what ships — do not write that copy here.
//
// **So this panel does the one honest thing that is also genuinely useful: it
// composes the request and hands it to the person.** Copying text to a clipboard
// is real functionality with no backend behind it, and the person carries it to
// whoever owns the deployment. Nothing here claims a ticket was filed.
//
// ── ⚠ WHAT IT MUST KEEP SAYING ──────────────────────────────────────────────
//
// Enabling a plugin is **two** changes, not one, and a person who is told only
// the first will be surprised by the second:
//
//   1. the capability has to be allowed for automations to emit it, and
//   2. for a plugin not in the engine's image at all, the image has to be
//      rebuilt and redeployed — the same for every workspace, because the engine
//      has ONE build and not one per tenant.
//
// The plugins on this page are already installed, so only (1) applies to them —
// and the copy says which case it is rather than issuing a generic warning.
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Check } from "@/components/ui/icons";

/**
 * The request text. Pure, exported, and deliberately built from DATA the page
 * was already given — the plugin's own name, version and package.
 *
 * ⚠ Nothing here hardcodes a class or package name. `ui-honesty-check.sh`
 * asserts no `io.kestra.plugin.` literal appears under `app/(app)/apps`, and the
 * reason survives the move into this file: a capability list written down in the
 * client is a second copy of the compiler's own answer, and it drifts silently.
 */
export function requestText(a: {
  label: string;
  group: string | null;
  version: string | null;
  capability?: string | null;
}): string {
  const lines = [
    `Please allow a Kestra plugin capability for automations.`,
    ``,
    `Plugin:     ${a.label}`,
    `Package:    ${a.group ?? "(not reported by the engine)"}`,
    `Version:    ${a.version ?? "ships with the engine"}`,
  ];
  if (a.capability) lines.push(`Capability: ${a.capability}`);
  lines.push(
    ``,
    `This plugin is already installed in the engine's image, so this is a request`,
    `to make the capability emittable by automations — not a request to install`,
    `anything. It applies to every workspace on this deployment, because the`,
    `engine has one build rather than one per tenant.`,
  );
  return lines.join("\n");
}

/**
 * Shown wherever a plugin has nothing an automation can reach.
 *
 * `compact` is the card-footer form — one line, no controls. The full form is
 * the drill-in panel.
 */
export function AllowRequest({
  label,
  group,
  version,
  capability,
}: {
  label: string;
  group: string | null;
  version: string | null;
  capability?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  // ⚠ `navigator.clipboard` is absent in jsdom and over plain HTTP on a remote
  // host. The failure is caught and reported in place rather than thrown: a
  // copy button that silently does nothing is indistinguishable from one that
  // worked, which is the whole failure mode this panel exists to avoid.
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(requestText({ label, group, version, capability }));
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    // ⚠ No heading of its own. This is the BODY of step 3 in `PluginCredentials`
    // — as a titled panel beside that list it read as an alternative to setting
    // the plugin up, rather than as the last step of doing so.
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">
        {label} is already installed in the engine, so this is not a request to install anything —
        it is a request to make one of its capabilities emittable by automations. It applies to
        every workspace on this deployment, because the engine has one build rather than one per
        tenant.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="subtle" size="sm" onClick={copy}>
          {copied ? (
            <span className="flex items-center gap-1.5">
              <Check s={13} /> Copied
            </span>
          ) : (
            "Copy the request for an admin"
          )}
        </Button>
        {/* ⚠ States what the button DID, not what it promised. There is no
            ticket, no queue and no notification — see this file's header. */}
        <span className="text-xs text-dim">
          Copies the plugin&rsquo;s details to your clipboard. Nothing is sent from here.
        </span>
      </div>

      {failed && (
        <p className="mt-2 text-xs text-danger">
          Could not reach the clipboard in this browser. The details are: {label} ·{" "}
          {group ?? "no package reported"} · {version ?? "ships with the engine"}
          {capability ? ` · ${capability}` : ""}.
        </p>
      )}
    </div>
  );
}
