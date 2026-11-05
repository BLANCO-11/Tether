/**
 * `rbac:platform-verify` — SC-010 and SC-015, measured at the wire.
 *
 * Two identities, each holding exactly one built-in platform role and **no membership
 * row anywhere** (`support` was merged into `auditor` by 0100, 2026-10-15):
 *
 *   auditor         reads the audit record, ops and signals; sees NO workspace; refused every workspace route
 *   platform-admin  permitted EXACTLY TWO workspace-scoped routes, and refused every other
 *
 * ## ⚠ "EXACTLY 2" IS THE WHOLE POINT, AND A FLOOR WOULD BE WORTHLESS
 *
 * D-9 confers `members.read` + `members.grant` into every workspace. That conferral is
 * the entire cost of the decision, and this number is the entire bound on it. Written as
 * "at least 2" the check passes while somebody adds `flows.read` to `PLATFORM_CONFERS`,
 * at which point a platform administrator can read every tenant's automations and the
 * standards amendment's sentence stops being true with nothing to say so.
 *
 * ⚠ The sentence this verifies is: **a platform administrator cannot see a tenant's
 * data, but can give themselves the ability to, and doing so leaves an audit entry
 * naming them.** Never the unqualified "a platform admin cannot access tenant data".
 *
 * ⚠ An auditor seeing **zero** workspaces is CORRECT, not a bug. They read across
 * tenants through `GET /api/platform/audit`; the workspace list is tenant metadata they
 * hold no permission for.
 */
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformRoleAssignments, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import { config } from "../config/index.js";
import { createApp } from "../app.js";
import { mountedRoutes } from "../auth/route-stack.js";
import { ROUTE_PERMISSIONS, routeKey } from "../auth/route-permissions.js";

const WHO = {
  auditor: { subject: "oid-pv-auditor", email: "auditor@acme-hr.example", roleKey: "auditor" },
  admin: { subject: "oid-pv-admin", email: "platadmin@acme-hr.example", roleKey: "platform-admin" },
} as const;

/** The only two workspace-scoped routes a platform administrator may reach. */
const EXPECTED_FOR_PLATFORM_ADMIN = [
  "GET /api/workspaces/:workspaceId/members",
  "POST /api/workspaces/:workspaceId/members",
  "DELETE /api/workspaces/:workspaceId/members/:subject",
  "GET /api/workspaces/:workspaceId/member-capabilities",
  "PUT /api/workspaces/:workspaceId/member-capabilities/:subject/:capability",
  "DELETE /api/workspaces/:workspaceId/member-capabilities/:subject/:capability",
  "GET /api/workspaces/:workspaceId/roles",
  "GET /api/workspaces/:workspaceId/roles/:roleId",
  "GET /api/workspaces/:workspaceId/roles/:roleId/members",
  "POST /api/workspaces/:workspaceId/roles/:roleId/members",
  "DELETE /api/workspaces/:workspaceId/roles/:roleId/members/:subject",
];

async function token(who: { subject: string; email: string }): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

async function main() {
  const stamp = Date.now().toString(36);
  const ws = await workspaceRepo.create({
    name: `rbac-platform-verify ${stamp}`,
    tenantSlug: "pverify",
    slug: `pverify-${stamp}`,
  });
  if (!ws) {
    console.error("could not create a throwaway workspace — is the database reachable?");
    process.exit(2);
  }

  for (const w of Object.values(WHO)) {
    await platformRoleRepo.assign({
      subject: w.subject,
      email: w.email,
      roleKey: w.roleKey,
      grantedBy: "rbac-platform-verify",
    });
  }

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const UUID = "00000000-0000-0000-0000-000000000001";
  const all = mountedRoutes(app);
  const wsRoutes = all.filter(
    (r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.path))?.kind === "workspace",
  );

  async function call(method: string, path: string, tok: string) {
    const url =
      base +
      path.replace(/:workspaceId/g, ws!.id).replace(/:id(?=\/|$)/g, ws!.id).replace(/:[A-Za-z]+/g, UUID);
    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": config.parentApiKey,
        "x-foundry-identity": tok,
        "content-type": "application/json",
      },
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    return res.status;
  }

  const tokens = {
    auditor: await token(WHO.auditor),
    admin: await token(WHO.admin),
  };

  const permitted: Record<string, string[]> = { auditor: [], admin: [] };
  for (const r of wsRoutes) {
    for (const who of ["auditor", "admin"] as const) {
      const status = await call(r.method, r.path, tokens[who]);
      if (status !== 401 && status !== 403) permitted[who]!.push(routeKey(r.method, r.path));
    }
  }

  // The workspace list each one sees (FR-015 / T069a).
  async function workspaceCount(tok: string): Promise<number> {
    const res = await fetch(`${base}/api/workspaces`, {
      headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": tok },
    });
    if (!res.ok) return -1;
    const body = (await res.json()) as { workspaces: unknown[] };
    return body.workspaces.length;
  }
  const seen = {
    auditor: await workspaceCount(tokens.auditor),
    admin: await workspaceCount(tokens.admin),
  };

  // The platform reads each one is entitled to.
  const platformProbes: Array<[string, string, keyof typeof tokens, boolean]> = [
    // `support` was merged into `auditor` (0100, 2026-10-15): one read-only platform profile.
    ["GET", "/api/platform/audit", "auditor", true],
    ["GET", "/api/ops/status", "auditor", true],
    ["GET", "/api/signals", "auditor", true],
    ["GET", "/api/ops/llm/provider", "auditor", false],
    // Personal BYOK: runtime-model is identity-scoped (any signed-in person may save their own key).
    ["PUT", "/api/runtime-model/provider", "auditor", true],
  ];
  const platformResults: string[] = [];
  for (const [method, path, who, shouldPass] of platformProbes) {
    const status = await call(method, path, tokens[who]);
    const passed = status !== 401 && status !== 403;
    const ok = passed === shouldPass;
    platformResults.push(
      `${ok ? "  ok " : "  ⚠  "} ${who.padEnd(8)} ${method} ${path} → ${status}` +
        (ok ? "" : `  EXPECTED ${shouldPass ? "permitted" : "refused"}`),
    );
  }

  await new Promise<void>((r) => server.close(() => r()));
  for (const w of Object.values(WHO)) {
    await db.delete(platformRoleAssignments).where(eq(platformRoleAssignments.subject, w.subject));
  }
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id));

  console.log("");
  console.log(`rbac:platform-verify — ${wsRoutes.length} workspace-scoped routes`);
  console.log("");
  console.log("SC-010  an auditor reads the record and NO tenant data");
  console.log(`          workspace routes permitted ... ${permitted.auditor!.length}  (expect 0)`);
  console.log(`          workspaces visible ........... ${seen.auditor}  (expect 0 — correct, not a bug)`);
  console.log("SC-015  a platform admin, member of NOTHING");
  console.log(`          workspace routes permitted ... ${permitted.admin!.length}  (expect ${EXPECTED_FOR_PLATFORM_ADMIN.length}, EXACTLY)`);
  console.log(`          workspaces visible ........... ${seen.admin}  (expect all)`);
  console.log("");
  console.log("the platform reads:");
  for (const line of platformResults) console.log(line);
  console.log("");

  let exit = 0;
  for (const who of ["auditor"] as const) {
    if (permitted[who]!.length !== 0) {
      console.log(`⚠ ${who} reached ${permitted[who]!.length} workspace route(s) and must reach none:`);
      for (const p of permitted[who]!.slice(0, 15)) console.log(`   ${p}`);
      exit = 1;
    }
    if (seen[who] !== 0) {
      console.log(`⚠ ${who} can see ${seen[who]} workspace(s) and must see none.`);
      exit = 1;
    }
  }

  const got = [...permitted.admin!].sort();
  const want = [...EXPECTED_FOR_PLATFORM_ADMIN].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.log("⚠ THE D-9 BOUND HAS MOVED. A platform administrator reaches a different set:");
    for (const extra of got.filter((g) => !want.includes(g))) console.log(`   EXTRA:   ${extra}`);
    for (const missing of want.filter((w) => !got.includes(w))) console.log(`   MISSING: ${missing}`);
    console.log("");
    console.log("   Every route here resolves to `members.read` or `members.grant`, which is");
    console.log("   what PLATFORM_CONFERS grants. If this list grew, the conferral grew, and");
    console.log("   the sentence 'a platform administrator cannot see a tenant's data' is no");
    console.log("   longer true. Check `auth/platform-conferral.ts` and INV-18.");
    exit = 1;
  }

  // ⚠ The positive control: a platform admin must reach SOMETHING, or "refuse everything"
  // scores 100% on the auditor assertions above.
  if (permitted.admin!.length === 0) {
    console.log("⚠ THE POSITIVE CONTROL DID NOT FIRE — a platform admin reached nothing at all.");
    console.log("   Every refusal reported above is satisfied by a resolver that refuses");
    console.log("   everybody, so this run proves nothing.");
    exit = 1;
  }
  if (platformResults.some((l) => l.startsWith("  ⚠"))) exit = 1;

  process.exit(exit);
}

main().catch((err) => {
  console.error("rbac:platform-verify failed:", err);
  process.exit(2);
});
