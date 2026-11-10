/**
 * Personal Foundry fork — product mode.
 *
 * Always on in this repository. Enterprise bootstrap dead-ends (empty workspace
 * list → "no access" / SUPER_ADMIN_EMAILS lectures) must not fire: a signed-in
 * person gets a home workspace instead.
 */
export const PERSONAL_PRODUCT = true;

export const PERSONAL_HOME_NAME = "Personal";
export const PERSONAL_HOME_PURPOSE =
  "Your personal Tether space — chats, projects, and workflows.";
