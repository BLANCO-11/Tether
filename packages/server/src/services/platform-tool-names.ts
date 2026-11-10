/**
 * The names of tools Foundry itself manages.
 * email-send-tool · T046 · plan.md Decision 1 (applied a second time)
 *
 * ── Why a module of its own ──────────────────────────────────────────────────
 *
 * `tool.service.ts` has to refuse these names, and `platform-tool-catalogue.ts`
 * has to register them — but the catalogue imports the service, so the service
 * cannot import the catalogue back. One tiny constants module breaks the cycle
 * without either side reaching for a string literal, which is how the two would
 * eventually disagree.
 *
 * ── Why a reserved NAME rather than an `isPlatform` column ───────────────────
 *
 * A column would land in `refFingerprints`, `refInterfaces`, the tools UI and the
 * update schema, and would buy nothing the name check does not already give. The
 * name is the identity a flow step references (`ref: "tether_email_send"`), so it
 * is the thing that must be stable — and a check on it is greppable, needs no
 * migration, and cannot drift from the row it describes.
 */

/** REAL email delivery. Registered by `platformToolCatalogue()`, guarded in `tool.service.ts`. */
export const EMAIL_TOOL_NAME = "tether_email_send";

/**
 * Every platform-managed tool name.
 *
 * ⚠ Being in this list means: a user cannot create a tool with the name, and
 * cannot update or delete the row that carries it. `mail:register` is the only
 * writer, and it says so in the refusal.
 */
/** The summary tool: text in, text out, through the provider set on /ai-provider (ops-api `/llm/complete`). */
export const LLM_TOOL_NAME = "llm_complete";

/** Read one public web address (2026-10-30). Served by Foundry itself (`routes/web.ts`). */
export const WEB_FETCH_TOOL_NAME = "web_fetch";

/** The email tool's name before the Tether rebrand; still reserved so an old row cannot be hand-recreated. */
export const LEGACY_EMAIL_TOOL_NAME = "foundry_" + "email_send"; // split so a repo-wide grep for the old tool name stays empty

export const PLATFORM_TOOL_NAMES: readonly string[] = [EMAIL_TOOL_NAME, LEGACY_EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME];

export const isPlatformToolName = (name: string | null | undefined): boolean =>
  typeof name === "string" && PLATFORM_TOOL_NAMES.includes(name);

/**
 * Demo mail tools, hidden from every AUTHORING surface (chat catalogue, flow
 * catalogue/palette) but still executable: existing flows that call them keep
 * running, validating and saving — `checkFlowRefs` and the executor resolve by
 * ref and are untouched by this list.
 *
 * Why: the pair is simulated delivery (ops-api outbox, never a mailbox) and
 * reads like the real thing. Authors picked `mail_send_template` thinking
 * "template" means the email feature, then armed flows that can never deliver.
 * New email steps should be `tether_email_send` — captured to the Email box
 * on test runs, delivered on live ones — so the drafter and the palette no
 * longer offer the pair. Kept as names, not a column, for the same reason
 * `PLATFORM_TOOL_NAMES` is names: greppable, no migration, cannot drift.
 */
export const AUTHORING_HIDDEN_TOOL_NAMES: readonly string[] = ["mail_send", "mail_send_template"];

export const isAuthorableToolName = (name: string | null | undefined): boolean =>
  typeof name === "string" && !AUTHORING_HIDDEN_TOOL_NAMES.includes(name);
