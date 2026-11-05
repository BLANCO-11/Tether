/**
 * `rbac:verify` — SC-001 and SC-002, measured at the wire.
 *
 * Every workspace-scoped route is called with three identities against two throwaway
 * workspaces:
 *
 *   GRANTED    — an `admin` member of workspace A and of nothing in B
 *   UNGRANTED  — a valid signed-in identity with no membership anywhere
 *   ALLOWLIST  — a `SUPER_ADMIN_EMAILS` holder, member of nothing
 *
 * ⚠ **THE POSITIVE CONTROL IS MANDATORY AND THE SCRIPT FAILS WITHOUT IT.** It reports
 * permitted and refused SEPARATELY and exits non-zero if `permitted` is zero — because
 * "refuse everything" scores 100% on every refusal assertion, and a guard that refuses
 * everything is exactly what a bug in the resolver would produce. A green run over zero
 * permitted calls is the failure this whole repo keeps rediscovering (I-38).
 *
 * ⚠ **IT CREATES AND DELETES ITS OWN WORKSPACES.** Taking `list()[0]` picks up another
 * suite's fixture and deletes it mid-run — that exact mistake made
 * `workspace-member.test.ts` fail nine ways once.
 *
 * ⚠ A refusal here is a **403 or 401**. Anything else — a 500, a 404 from a missing
 * fixture, a 400 from a body this script did not send — is reported as INCONCLUSIVE
 * rather than counted as a refusal. A control that cannot tell "refused" from "blew up"
 * is not measuring authorisation.
 */
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { createApp } from "../app.js";
import { mountedRoutes } from "../auth/route-stack.js";
import { ROUTE_PERMISSIONS, routeKey } from "../auth/route-permissions.js";

const GRANTED = { subject: "oid-rbacverify-granted", email: "granted@acme-hr.example" };
const UNGRANTED = { subject: "oid-rbacverify-ungranted", email: "ungranted@acme-hr.example" };

async function token(who: { subject: string; email: string }): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

/** A body good enough to get past validation on the routes that take one. */
const BODY = JSON.stringify({});

async function main() {
  const stamp = Date.now().toString(36);
  const wsA = await workspaceRepo.create({
    name: `rbac-verify A ${stamp}`,
    tenantSlug: "rbacverify",
    slug: `rbacverify-a-${stamp}`,
  });
  const wsB = await workspaceRepo.create({
    name: `rbac-verify B ${stamp}`,
    tenantSlug: "rbacverify",
    slug: `rbacverify-b-${stamp}`,
  });
  if (!wsA || !wsB) {
    console.error("could not create throwaway workspaces — is the database reachable?");
    process.exit(2);
  }

  // GRANTED is an admin of A only.
  await db.insert(workspaceMembers).values({
    workspaceId: wsA.id,
    subject: GRANTED.subject,
    email: GRANTED.email,
    role: "admin",
    grantedBy: "rbac-verify",
  });

  // ALLOWLIST: added for the run and removed after, so the script does not depend on
  // this deployment's SUPER_ADMIN_EMAILS being set to anything in particular.
  const ALLOWLIST = { subject: "oid-rbacverify-super", email: "super-rbacverify@acme-hr.example" };
  config.superAdminEmails.add(ALLOWLIST.email);

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const tokens = {
    granted: await token(GRANTED),
    ungranted: await token(UNGRANTED),
    allowlist: await token(ALLOWLIST),
  };

  const targets = mountedRoutes(app).filter(
    (r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.path))?.kind === "workspace",
  );

  const tally = {
    permittedInA: 0,
    refusedInB: 0,
    refusedUngranted: 0,
    permittedAllowlist: 0,
    inconclusive: [] as string[],
    leaked: [] as string[],
  };

  const UUID = "00000000-0000-0000-0000-000000000001";

  async function call(method: string, path: string, ws: string, tok: string) {
    const url =
      base +
      path
        .replace(/:workspaceId/g, ws)
        .replace(/:id(?=\/|$)/g, ws)
        .replace(/:[A-Za-z]+/g, UUID);
    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": config.parentApiKey,
        "x-foundry-identity": tok,
        "content-type": "application/json",
      },
      ...(method === "GET" || method === "DELETE" ? {} : { body: BODY }),
    });
    return res.status;
  }

  for (const r of targets) {
    const key = routeKey(r.method, r.path);

    // 1. UNGRANTED must be refused everywhere.
    const un = await call(r.method, r.path, wsA.id, tokens.ungranted);
    if (un === 401 || un === 403) tally.refusedUngranted += 1;
    else tally.leaked.push(`${key} → ${un} for a person with no grant anywhere`);

    // 2. GRANTED must be refused in the workspace they are NOT in.
    const inB = await call(r.method, r.path, wsB.id, tokens.granted);
    if (inB === 401 || inB === 403) tally.refusedInB += 1;
    else tally.leaked.push(`${key} → ${inB} in a workspace the caller is not a member of`);

    // 3. GRANTED must get PAST the guard in the workspace they administer.
    //    ⚠ "Past the guard" is not "200": most of these routes address a fixture that
    //    does not exist, so 404/400/409/500 all mean the guard let them through and the
    //    handler had its own opinion. Only 401/403 means the guard refused.
    const inA = await call(r.method, r.path, wsA.id, tokens.granted);
    if (inA !== 401 && inA !== 403) tally.permittedInA += 1;
    else tally.inconclusive.push(`${key} → ${inA} for an ADMIN of that workspace`);

    // 4. The allowlist holder passes without a membership row anywhere.
    const sup = await call(r.method, r.path, wsA.id, tokens.allowlist);
    if (sup !== 401 && sup !== 403) tally.permittedAllowlist += 1;
  }

  await new Promise<void>((r) => server.close(() => r()));
  config.superAdminEmails.delete(ALLOWLIST.email);
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, wsA.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsA.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, wsB.id));

  const n = targets.length;
  console.log("");
  console.log(`rbac:verify — ${n} workspace-scoped routes × 4 probes`);
  console.log("");
  console.log("SC-001  a person with no grant is refused everywhere");
  console.log(`          refused ................ ${tally.refusedUngranted} / ${n}`);
  console.log("SC-002  a grant in A is not a grant in B");
  console.log(`          refused in B .......... ${tally.refusedInB} / ${n}`);
  console.log("CONTROL an admin of A is PERMITTED there (this is the half that matters)");
  console.log(`          permitted ............. ${tally.permittedInA} / ${n}`);
  console.log("        an allowlist holder passes with no membership row");
  console.log(`          permitted ............. ${tally.permittedAllowlist} / ${n}`);
  console.log("");

  let exit = 0;

  if (tally.leaked.length) {
    console.log(`⚠ ${tally.leaked.length} ROUTE(S) ANSWERED SOMEBODY WHO SHOULD HAVE BEEN REFUSED:`);
    for (const l of tally.leaked.slice(0, 25)) console.log(`   ${l}`);
    if (tally.leaked.length > 25) console.log(`   … and ${tally.leaked.length - 25} more`);
    exit = 1;
  }

  // ⚠ THE MANDATORY CONTROL. Without it, "refuse everything" scores 100% above.
  if (tally.permittedInA === 0) {
    console.log("⚠ THE POSITIVE CONTROL DID NOT FIRE.");
    console.log("   An admin of workspace A was permitted ZERO of its routes, so every");
    console.log("   refusal reported above is satisfied by a resolver that refuses");
    console.log("   everybody. This run proves nothing. Exiting non-zero.");
    exit = 1;
  }

  if (tally.inconclusive.length) {
    console.log("");
    console.log(`${tally.inconclusive.length} route(s) refused an ADMIN of the workspace:`);
    for (const i of tally.inconclusive.slice(0, 25)) console.log(`   ${i}`);
    if (tally.inconclusive.length > 25) {
      console.log(`   … and ${tally.inconclusive.length - 25} more`);
    }
    exit = 1;
  }

  process.exit(exit);
}

main().catch((err) => {
  console.error("rbac:verify failed:", err);
  process.exit(2);
});
