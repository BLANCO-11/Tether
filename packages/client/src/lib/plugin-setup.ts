// src/lib/plugin-setup.ts — the setup story for a plugin, as data.
//
// Pure, so the three-step panel's rules are checkable without rendering: which
// steps a person can do today, which are blocked, and what the credential would
// be called if they stored one.

import type { PluginCredentials } from "./types";

/**
 * A workspace-secret name suggested for one of a plugin's connection fields.
 *
 * ⚠ **A SUGGESTION, and it must be presented as one.** Foundry references a
 * credential by its env-var NAME — that one identifier is what the manifest
 * renders, what a tool row stores and what gets injected at execution, so the
 * name is load-bearing wherever a binding exists. For plugins there IS no
 * binding yet: nothing reads a plugin credential, so nothing can be wrong about
 * this name today, and a UI that presented it as required would be inventing a
 * convention the server has never agreed to.
 *
 * The shape follows what the product already does elsewhere — an upper
 * `SNAKE_CASE` env-var name — so a person who stores one now has a name that
 * will read correctly when the binding lands.
 *
 *   ("Slack", "url")        → SLACK_URL
 *   ("AWS", "accessKeyId")  → AWS_ACCESS_KEY_ID
 *   ("Azure", "connectionString") → AZURE_CONNECTION_STRING
 */
export function secretNameFor(pluginLabel: string, field: string): string {
  const snake = (s: string) =>
    s
      // camelCase and PascalCase both split here; `accessKeyId` → ACCESS_KEY_ID.
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  const plugin = snake(pluginLabel);
  const name = snake(field);
  // ⚠ Not `SLACK_SLACK_URL`. A plugin whose field already carries its own name
  // is common enough that the doubled prefix would be the usual case, not an
  // edge one.
  return name.startsWith(`${plugin}_`) || name === plugin ? name : `${plugin}_${name}`;
}

/** One step of the three, and whether a person can actually do it now. */
export type SetupStep = {
  n: number;
  title: string;
  /**
   * ⚠ `blocked` is not `done`'s opposite and there is deliberately no `done`.
   * This product cannot tell whether somebody has obtained a Slack token, and a
   * tick beside a step nobody verified is the false green this whole page is
   * about. A step is either something you can go and do, or something that is
   * waiting on someone else.
   */
  blocked: boolean;
  /** Why it is blocked. Null when it is not — never a generic "unavailable". */
  because: string | null;
};

/**
 * The three steps, in order, with the blocked ones named.
 *
 * ⚠ **Step 3 is blocked for every plugin on this engine today**, and that is the
 * honest shape of the product rather than a temporary UI state. Foundry's
 * compiler is the sole YAML emitter (R8) and emits seven class types, none from
 * a plugin — so no automation can call one, whatever credential is stored.
 *
 * ⚠ Step 2 is NOT blocked, and the distinction matters. A workspace secret is a
 * real, existing thing with real storage; a person may legitimately want the
 * credential in place before the capability is switched on. What the panel must
 * never do is imply that storing it completes the setup, which is why step 3
 * exists as its own step rather than as a footnote under step 2.
 */
export function setupSteps(creds: PluginCredentials | null, label: string): SetupStep[] {
  const usable = creds?.usableToday === true;
  const needsCredential = (creds?.fields.length ?? 0) > 0;

  return [
    {
      n: 1,
      title: needsCredential
        ? `Get the credential from ${label}`
        : `Check whether ${label} needs a credential`,
      blocked: false,
      because: null,
    },
    {
      n: 2,
      title: "Store it in this workspace",
      blocked: false,
      because: null,
    },
    {
      n: 3,
      title: "Have an administrator enable it",
      blocked: !usable,
      because: usable
        ? null
        : `No automation can call ${label} yet. Foundry writes every automation's ` +
          `definition itself and emits a fixed set of step types, none of them from ` +
          `this plugin — so this step is not something this screen can do.`,
    },
  ];
}
