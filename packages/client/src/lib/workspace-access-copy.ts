// src/lib/workspace-access-copy.ts — the words the workspace-access screens use.
//
// ⚠ **The strings live here, out of the components, so the RULES about them can
// be asserted.** Same idiom as `generation-findings.ts`, `policy-copy.ts` and
// `prompt-boundary-copy.ts`, and for the same reason: what matters about this
// copy is not how it reads but what it must never claim — that a role proves who
// somebody is, or that this list is a set of accounts. A test can hold a module
// to that; it cannot hold JSX to it.

/**
 * The bound both panels carry. ⚠ It must keep saying that a role is granted
 * ACCESS and not a verified person: anything holding the deployment's identity
 * signing secret can present any identity (I-13), so "verified" is the one word
 * these screens may not use about a person.
 */
export const ACCESS_IS_NOT_IDENTITY =
  "A role decides what someone may do here; it is not proof of who they are. Anything holding " +
  "this deployment’s identity signing secret can present any identity, so treat a role as " +
  "“granted access”, not as a verified person.";

/**
 * What `platform_users` is. ⚠ Named "seen", never "users" or "accounts", because
 * a row means exactly one thing: this identity presented a token this API could
 * verify. It is also not a list of who is signed in — there is no session here.
 */
export const SEEN_USERS_TITLE = "People who have signed in";

export const SEEN_USERS_EXPLAINER =
  "Every identity this API has seen present a token it could verify. It is not a list of " +
  "accounts, not a record of who is signed in right now, and not proof of who anyone is. " +
  "Somebody appears here after their first request, not at the instant they sign in.";

/** ⚠ Renders when the list could not be read. Never collapsed into "nobody has signed in". */
export const SEEN_USERS_UNREADABLE =
  "The list of people who have signed in could not be read, so this is not “nobody has signed " +
  "in yet” — the check did not run.";

/** The genuinely empty case. Distinct from the one above, deliberately. */
export const SEEN_USERS_EMPTY =
  "Nobody has been seen yet. A person appears here after they sign in and their browser makes " +
  "its first request.";

/** What assignment does, stated where the button is. */
export const ASSIGN_EXPLAINER =
  "Assigning somebody gives them access to this workspace. “admin” is full access to it, " +
  "including approving what runs.";

/**
 * ⚠ Why the free-text fallback exists, said on screen. Refusing to assign
 * somebody who has never called the API would make a fresh deployment
 * un-onboardable — the picker cannot list an identity it has never seen.
 */
export const ASSIGN_UNSEEN_HINT =
  "Not in the list? Someone who has never signed in here can still be assigned, but you have to " +
  "know their identity subject — the “sub” their sign-in token carries. It is not their email.";

/** Super admin, for the screens that have to explain their own gate. */
export const NOT_SUPER_ADMIN =
  "Managing workspaces and deciding who works in them is restricted to a super admin on this " +
  "deployment. Ask whoever administers it.";

/**
 * ⚠ The other refusal, and it must name the variable. Nobody configured means
 * nothing can be assigned by anyone, which reads as a broken product unless the
 * screen says what to set.
 */
export const NO_SUPER_ADMIN_CONFIGURED =
  "This deployment has no super admin configured, so nobody can create workspaces or assign " +
  "people to them. Set SUPER_ADMIN_EMAILS on the API server — a comma-separated list of " +
  "identity subjects or emails — and restart it.";

/** ⚠ `GET /api/me` failed. Not "you are not allowed": we do not know. */
export const ACCESS_UNKNOWN =
  "Your access could not be checked, so this page is not saying you are or are not allowed — " +
  "the check did not run. Reload, or check that the API is reachable.";

/**
 * Explains a `bootstrap` row. ⚠ Kept because those rows still exist: they were
 * written by the deleted self-claim endpoint, where the first person to ask
 * became a workspace's admin, so for them there genuinely is no answer to "who
 * let this person in".
 */
export const BOOTSTRAP_EXPLAINER =
  "“claimed” marks a member who was not assigned by anyone: they took the workspace themselves " +
  "through a self-claim step that no longer exists.";

// ── Access for one LOCAL account, set where the account is created ───────────

/** The section heading on a local account's row. */
export const LOCAL_ACCESS_TITLE = "Workspace access";

/**
 * Why this control is here at all, and it is worth saying on screen.
 *
 * ⚠ It must keep stating that access can be given BEFORE a first sign-in. That
 * is the difference between this and the members panel: the picker there is
 * built from identities the API has seen, so a freshly created account is
 * absent from it, and the old answer was to copy the subject by hand.
 */
export const LOCAL_ACCESS_EXPLAINER =
  "Give this account access to the workspaces it needs. You can do this before they have ever " +
  "signed in — the role is keyed on the account, so it applies the first time they use it.";

/** ⚠ Renders when the list could not be read. Never collapsed into "no access". */
export const LOCAL_ACCESS_UNREADABLE =
  "This account’s access could not be read, so this is not “no access” — the check did not run.";

/** The genuinely empty case. Distinct from the one above, deliberately. */
export const LOCAL_ACCESS_NONE =
  "No access to any workspace yet. They can sign in, and every workspace will refuse them.";

/** The "not a member" option in the role picker. */
export const NO_ACCESS_LABEL = "No access";

/**
 * ⚠ Said beside the picker, because the consequence is not visible in it: these
 * roles are the SAME rows an Entra user's assignment writes, so a local account
 * granted `admin` is a workspace admin in exactly the same sense.
 */
export const LOCAL_ACCESS_SAME_AS_AD =
  "These are the same workspace roles a work account gets. There is no separate, lesser kind of " +
  "access for a local account.";
