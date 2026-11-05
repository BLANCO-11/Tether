/**
 * The permission catalogue — the complete set of things this system knows how to
 * authorise. CODE, deliberately, and never a table.
 *
 * FR-001 requires that no administrator can invent, rename or delete a permission. A
 * `permissions` table makes all three possible, and additionally allows a row naming a
 * permission the code does not implement — a grant that reads as real and enforces
 * nothing. So the catalogue is a frozen array, the `Permission` type is *derived* from
 * it, and a row anywhere else that fails to name a member of this array is refused by a
 * CHECK constraint generated from this same array (INV-2).
 *
 * ⚠ **Read the number from the array; never write it down twice.** This is the
 * `FOUNDRY_EMITS` idiom. There are counts in the prose below and they are there to be
 * read by a person; `permissions.test.ts` reads `.length`. If the two disagree, the
 * array is right.
 *
 * Naming is `<domain>.<action>`, lower-case, dot-separated. **Read is always separate
 * from write** because "can see the credential list" and "can add a credential" are the
 * two questions administrators actually ask apart.
 *
 * ⚠ **INV-3 — no permission grants read access to a secret VALUE.** `secrets.read` is the
 * NAME list and the collision audit. That is not a restraint this file imposes: there is
 * no endpoint that returns a secret value, `GET …/secrets/audit` returns
 * `{configured, missing, collisions}`, and there is deliberately no `?reveal=`. This
 * feature adds none. If one is ever added, it needs its own permission and its own
 * argument — do not let it ride in on this one.
 */

export type PermissionTier = "workspace" | "platform";

export interface PermissionEntry {
  /** The stored string. This is what appears in a grant row and in a CHECK constraint. */
  readonly key: string;
  /**
   * `workspace` permissions are answered against a `(person, workspace)` pair.
   * `platform` permissions are answered against a person alone — there is no workspace
   * in the question. The partition is exhaustive and disjoint, asserted in the test.
   */
  readonly tier: PermissionTier;
  /** Shown in a role editor. Sentence case, no trailing full stop. */
  readonly label: string;
  /** Shown beside the label. What holding this actually lets somebody do. */
  readonly description: string;
}

const CATALOGUE = [
  // ── automations ───────────────────────────────────────────────────────────────
  {
    key: "flows.read",
    tier: "workspace",
    label: "Read automations",
    description:
      "List and open automations, their revisions, steps, canvas positions, phases and flags.",
  },
  {
    key: "flows.write",
    tier: "workspace",
    label: "Build automations",
    description:
      "Create, edit, delete and import automations; save a draft; generate, refine or build one in chat. A chat turn writes a revision, so it needs this.",
  },
  {
    key: "flows.run",
    tier: "workspace",
    label: "Run automations",
    description:
      "Start a draft or test run, and fire a manual trigger. Gate 1 requires a successful run before a flow can be armed, so this is the permission that makes arming reachable.",
  },
  {
    key: "flows.approve",
    tier: "workspace",
    label: "Approve revisions",
    description:
      "Approve a revision, revoke an approval, re-arm and recheck. An approval binds to one revision — approving is what puts a schedule in front of real data.",
  },
  {
    key: "flows.arm",
    tier: "workspace",
    label: "Manage triggers",
    description:
      "Create, enable, disable and delete triggers. An enabled trigger fires the approved live revision unattended.",
  },
  // ── runs ──────────────────────────────────────────────────────────────────────
  {
    key: "runs.read",
    tier: "workspace",
    label: "Read run history",
    description:
      "Executions, step runs, run history and the email box. Step output is served redacted; this permission does not change that.",
  },
  {
    key: "runs.replay",
    tier: "workspace",
    label: "Replay a run",
    description:
      "Re-execute a past run in whole or in part. A replay re-applies the approval gate, mints execution credentials and takes a budget slot — it is an execution, not a read.",
  },
  // ── reports ───────────────────────────────────────────────────────────────────
  {
    key: "reports.read",
    tier: "workspace",
    label: "Read cost reports",
    description:
      "Open the cost and usage report for this workspace, download it, and email it. The report covers everyone's usage in the workspace, and an emailed copy goes to people who may hold no access here, so it is an Admin's.",
  },
  // ── approvals (gate 3) ────────────────────────────────────────────────────────
  {
    key: "approvals.read",
    tier: "workspace",
    label: "Read the approval inbox",
    description: "See paused steps waiting on a person, and open one of them.",
  },
  {
    key: "approvals.decide",
    tier: "workspace",
    label: "Decide a paused step",
    description:
      "Approve or reject a paused step. Rejecting kills the run rather than resuming it with a no — resuming would execute the step the gate exists to stop.",
  },
  // ── data ──────────────────────────────────────────────────────────────────────
  {
    key: "datasources.read",
    tier: "workspace",
    label: "Read data sources",
    description:
      "List data sources and read their schema, named queries and DB operations.",
  },
  {
    key: "datasources.write",
    tier: "workspace",
    label: "Manage data sources",
    description:
      "Register, edit and delete a data source; refresh its schema; provision or rebuild a sandbox. Includes testing a connection, which dials the tenant's database with the stored credential.",
  },
  {
    key: "datasources.query.write",
    tier: "workspace",
    label: "Author readers",
    description:
      "Create, edit and delete named queries and DB operations — the only things a step can actually read a database through.",
  },
  // ── tools ─────────────────────────────────────────────────────────────────────
  {
    key: "tools.read",
    tier: "workspace",
    label: "Read tools",
    description: "List and open tool registrations and their parameters.",
  },
  {
    key: "tools.write",
    tier: "workspace",
    label: "Manage tools",
    description:
      "Register, edit and delete a tool, and probe one. A probe dials the endpoint with the stored credential, which is why it is not a read.",
  },
  // ── credentials ───────────────────────────────────────────────────────────────
  {
    key: "secrets.read",
    tier: "workspace",
    label: "Read credential names",
    description:
      "The list of declared credential NAMES and the collision audit. ⚠ Never a value — no permission grants a value, because no endpoint returns one (INV-3).",
  },
  {
    key: "secrets.write",
    tier: "workspace",
    label: "Manage credentials",
    description: "Declare, edit and delete a credential, and write its value.",
  },
  // ── plugins (connectors) ──────────────────────────────────────────────────────
  {
    key: "plugins.read",
    tier: "workspace",
    label: "See connected services",
    description:
      "Which connectors are installed on this deployment and switched on here, their actions, and the NAMES of this workspace's connections. ⚠ Never a connection's value — no endpoint returns one (INV-3).",
  },
  {
    key: "plugins.enable",
    tier: "workspace",
    label: "Connect services",
    description:
      "Connect a service in this workspace (store, test, rotate and remove a connection) and choose which of its actions automations may use. A connection's value is written, never read back.",
  },
  // ── catalogue ─────────────────────────────────────────────────────────────────
  {
    key: "catalogue.read",
    tier: "workspace",
    label: "Read the callable catalogue",
    description:
      "The refs, parameter descriptions, expression allowlist and caps that the builder reads.",
  },
  {
    key: "catalogue.write",
    tier: "workspace",
    label: "Request catalogue items",
    description: "Register a catalogue item and raise an access request for one.",
  },
  {
    key: "templates.read",
    tier: "workspace",
    label: "Read templates",
    description: "List and open this workspace's saved automation templates.",
  },
  {
    key: "templates.write",
    tier: "workspace",
    label: "Manage templates",
    description:
      "Save, rename and delete a template. A template is a snapshot — a second save under an existing name is refused, never an upsert.",
  },
  {
    key: "resources.read",
    tier: "workspace",
    label: "Read resources",
    description: "The unified resource list and a resource's detail and impact view.",
  },
  // ── governance ────────────────────────────────────────────────────────────────
  {
    key: "audit.read",
    tier: "workspace",
    label: "Read the audit history",
    description: "This workspace's audit history and its export.",
  },
  {
    key: "members.read",
    tier: "workspace",
    label: "See who has access",
    description:
      "See who is in this workspace and what they hold. A member who cannot approve still has to be able to find out who can.",
  },
  {
    /**
     * The one line between the two regions (rbac-observability, 2026-10-15). PRIVATE work — chats, drafts, test
     * runs, files, and a person's usage and cost — is its owner's; PUBLISHED work (an approved automation and its
     * live runs) is the whole workspace's. This is what lets somebody see everyone's private work. Admins hold it.
     */
    key: "content.read.others",
    tier: "workspace",
    label: "See everyone's private work",
    description:
      "Open other people's chats, drafts, test runs and files, and see everyone's usage and cost. Without it a person sees their own private work and the published automations.",
  },
  {
    key: "members.grant",
    tier: "workspace",
    label: "Grant access",
    description:
      "Add and remove members, and change what they hold. The last administrator cannot be removed — a workspace with members and no administrator can never grant again.",
  },
  {
    key: "roles.write",
    tier: "workspace",
    label: "Compose roles",
    description:
      "Create, edit and retire custom roles in this workspace. A role can never carry a permission its author does not hold.",
  },
  {
    key: "incidents.read",
    tier: "workspace",
    label: "Read incidents",
    description: "Incidents raised in this workspace and their history.",
  },
  {
    key: "incidents.write",
    tier: "workspace",
    label: "Manage incidents",
    description: "Raise, update and close an incident.",
  },
  {
    key: "gates.read",
    tier: "workspace",
    label: "Read release gates",
    description: "See which publish review gates are in force.",
  },
  {
    key: "gates.write",
    tier: "workspace",
    label: "Change release gates",
    description:
      "Turn a publish review gate on or off. Turning one off removes a review somebody else is relying on.",
  },
  {
    key: "budget.read",
    tier: "workspace",
    label: "Read the run budget",
    description: "This workspace's concurrent-execution budget and what is using it.",
  },
  {
    key: "budget.write",
    tier: "workspace",
    label: "Change the run budget",
    description:
      "Change the concurrent-execution budget. It is a fairness control across tenants, not a performance setting.",
  },
  {
    key: "breakglass.read",
    tier: "workspace",
    label: "See emergency access",
    description: "See which break-glass sessions are currently active.",
  },
  {
    key: "breakglass.activate",
    tier: "workspace",
    label: "Use emergency access",
    description:
      "Activate or revoke a break-glass session — deliberately loud, deliberately recorded.",
  },
  {
    key: "realdata.use",
    tier: "workspace",
    label: "Act on production data",
    description:
      "Act against production rather than sandbox data. ⚠ Enforced inside break-glass and the catalogue service rather than at a route, because it qualifies what a call does rather than whether it is allowed.",
  },
  // ── the remaining scoped reads ────────────────────────────────────────────────
  {
    key: "search.read",
    tier: "workspace",
    label: "Search this workspace",
    description:
      "Search across automations, steps, runs, resources, approvals and people. ⚠ Each kind is additionally filtered by the permission for that kind, so this is a floor and not a bypass.",
  },
  {
    key: "bootstrap.read",
    tier: "workspace",
    label: "Read workspace bootstrap state",
    description: "The setup state a freshly opened workspace renders from.",
  },
  {
    key: "scenarios.read",
    tier: "workspace",
    label: "Read scenarios",
    description: "The worked scenarios registered in this workspace.",
  },
  {
    key: "steps.try",
    tier: "workspace",
    label: "Try a step",
    description:
      "Run a single step in isolation while building, without running the automation.",
  },

  // ── the platform tier ─────────────────────────────────────────────────────────
  // Answered against a PERSON, with no workspace in the question. These live in the
  // same catalogue under one prefix so that "what is this string" has one answer
  // everywhere, rather than two vocabularies that have to be told apart by context.
  {
    key: "platform.workspaces.write",
    tier: "platform",
    label: "Create and remove workspaces",
    description:
      "Create, rename and delete a workspace anywhere on this deployment. ⚠ On its own this creates a workspace the holder cannot put anybody into; see `platform.members.grant`.",
  },
  {
    key: "platform.members.grant",
    tier: "platform",
    label: "Grant workspace access anywhere",
    description:
      "Add and remove members in EVERY workspace on this deployment. ⚠ This is the one platform permission that confers workspace permissions — exactly `members.read` and `members.grant`, and nothing else. Its holder cannot read a tenant's data, but can give themselves the ability to, and doing so leaves an audit entry naming them.",
  },
  {
    key: "platform.users.read",
    tier: "platform",
    label: "Read the people list",
    description:
      "Every identity that has presented a verified token. ⚠ Not a user directory, not an entitlement, and not a record of who is signed in.",
  },
  {
    key: "platform.roles.write",
    tier: "platform",
    label: "Compose platform roles",
    description:
      "Create, edit and retire platform-tier roles, and assign them. The built-in three cannot be edited.",
  },
  {
    key: "platform.generation.write",
    tier: "platform",
    label: "Change the generation model",
    description:
      "Change the model that drafts and refines automations. ⚠ Deliberately NOT the same setting as the `llm_complete` tool model — see `platform.toolmodel.write`.",
  },
  {
    key: "platform.audit.read",
    tier: "platform",
    label: "Read audit history everywhere",
    description:
      "Audit history across every workspace, plus the platform record, in one time order. ⚠ Confers nothing inside a workspace: its holder reads the record, not the data the record is about.",
  },
  {
    key: "platform.localusers.write",
    tier: "platform",
    label: "Manage local accounts",
    description:
      "Create, edit, disable and delete local credential accounts. ⚠ Scoped to local accounts by construction — it cannot be pointed at a federated identity.",
  },
  {
    key: "platform.ops.read",
    tier: "platform",
    label: "Read the tool layer",
    description:
      "The outbox, the call log and the tool layer's status. Reads what tools did, never a credential.",
  },
  {
    key: "platform.toolmodel.read",
    tier: "platform",
    label: "Read the tool model setting",
    description:
      "The provider and model behind the `llm_complete` tool. ⚠ A different setting from the generation model — D-115, and it has confused a user twice. One permission over both would merge them at the authorisation layer.",
  },
  {
    key: "platform.toolmodel.write",
    tier: "platform",
    label: "Change the tool model",
    description:
      "Change the provider and model behind the `llm_complete` tool, and test one. ⚠ Not the generation model.",
  },
  {
    key: "platform.plugins.install",
    tier: "platform",
    label: "Install connectors",
    description:
      "Install, upgrade and uninstall connectors (Activepieces pieces) for the whole deployment, and approve which hosts each may reach. ⚠ Installing adds code once; it does nothing in a workspace until someone holding `plugins.enable` there switches it on.",
  },
  {
    key: "platform.signals.read",
    tier: "platform",
    label: "Read system signals",
    description:
      "The silent-failure signals — a schedule that stopped firing, a stalled poller, a sweep that went quiet, leaked budget slots. ⚠ Answers 'is the system still doing its job', not 'is this process alive', and it is read by a scheduler as well as by a person.",
  },
] as const satisfies readonly PermissionEntry[];

/**
 * INV-1 — frozen at module load, entries included. A catalogue a caller can mutate is a
 * catalogue a caller can widen, and it would widen it for every request the process
 * subsequently serves.
 */
export const PERMISSIONS: readonly PermissionEntry[] = Object.freeze(
  CATALOGUE.map((entry) => Object.freeze({ ...entry })),
);

/** Every permission string in the catalogue. Derived — never written down twice. */
export type Permission = (typeof CATALOGUE)[number]["key"];

/** A permission answered against a `(person, workspace)` pair. */
export type WorkspacePermission = Extract<
  (typeof CATALOGUE)[number],
  { tier: "workspace" }
>["key"];

/** A permission answered against a person, with no workspace in the question. */
export type PlatformPermission = Extract<
  (typeof CATALOGUE)[number],
  { tier: "platform" }
>["key"];

export const WORKSPACE_PERMISSIONS: readonly WorkspacePermission[] = Object.freeze(
  CATALOGUE.filter((e): e is Extract<typeof e, { tier: "workspace" }> => e.tier === "workspace").map(
    (e) => e.key,
  ),
);

export const PLATFORM_PERMISSIONS: readonly PlatformPermission[] = Object.freeze(
  CATALOGUE.filter((e): e is Extract<typeof e, { tier: "platform" }> => e.tier === "platform").map(
    (e) => e.key,
  ),
);

const BY_KEY: ReadonlyMap<string, PermissionEntry> = Object.freeze(
  new Map(PERMISSIONS.map((e) => [e.key, e])),
);

/** Narrowing guard. The ONLY way a string from outside becomes a `Permission`. */
export function isPermission(value: string): value is Permission {
  return BY_KEY.has(value);
}

export function isWorkspacePermission(value: string): value is WorkspacePermission {
  return BY_KEY.get(value)?.tier === "workspace";
}

export function isPlatformPermission(value: string): value is PlatformPermission {
  return BY_KEY.get(value)?.tier === "platform";
}

export function permissionEntry(key: Permission): PermissionEntry {
  const entry = BY_KEY.get(key);
  // Unreachable through the type, reachable through a cast or a stored string.
  if (!entry) throw new Error(`unknown permission ${key}`);
  return entry;
}

/**
 * The CHECK-constraint body for a column holding a permission string (INV-2).
 *
 * ⚠ **Generated from the catalogue, so the constraint and the code cannot drift.** The
 * migrations paste the output of this function; `permissions.test.ts` regenerates it and
 * compares against the migration text on disk, so adding a permission without touching
 * the constraint fails a test rather than failing a row insert in production six weeks
 * later. The `FOUNDRY_EMITS` idiom, applied to SQL.
 *
 * `tier` narrows the list — `workspace_role_permissions` must refuse `platform.*`
 * (INV-8), so it takes the workspace list rather than the whole catalogue.
 */
export function permissionCheckSql(column: string, tier?: PermissionTier): string {
  const keys = tier
    ? PERMISSIONS.filter((e) => e.tier === tier).map((e) => e.key)
    : PERMISSIONS.map((e) => e.key);
  const list = keys.map((k) => `'${k}'`).join(", ");
  return `${column} IN (${list})`;
}
