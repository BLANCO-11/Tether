import { describe, it, expect } from "vitest";
import express from "express";
import { mountedRoutes } from "./route-stack.js";
import { mountPermissionGuards } from "../middleware/mount-permission-guards.js";
import { ROUTE_PERMISSIONS, EXEMPT, routeKey, requirementFor } from "./route-permissions.js";
import { isPermission, isWorkspacePermission, isPlatformPermission } from "./permissions.js";

const { createApp } = await import("../app.js");
const app = createApp();
const routes = mountedRoutes(app);

/**
 * The completeness check.
 *
 * ⚠ **THIS IS THE ASSERTION THE WHOLE FEATURE RESTS ON.** FR-003: a route that nobody
 * remembered to declare must fail a test, not ship open. 106 of the 142 workspace-scoped
 * routes carried no authorisation check at all before this feature, and the reason that
 * was possible for months is that nothing anywhere could tell you the number.
 *
 * ⚠ **It runs in ONE DIRECTION: routes are checked against the map, never the map
 * against routes.** A permission with no route is legal — `roles.write` guards routes
 * this feature adds, and `realdata.use` is enforced inside a service rather than at a
 * route. A route with no permission is not legal. Reversing the check would make
 * declaring a permission early an error.
 *
 * ⚠ **Walks the STACK, never greps source.** A regex over route files reports nine false
 * positives on `local-users.ts` alone, which is guarded at the router (research M-5).
 */
describe("every mounted route is declared", () => {
  it("walks a non-trivial number of routes — CONTROL", () => {
    // ⚠ Without this, a walker that returned [] would make every assertion below pass
    // over an empty set. A test over no rows reads exactly like a test that passed.
    expect(routes.length).toBeGreaterThan(150);
  });

  it("declares every (method, path) in the map or in EXEMPT", () => {
    const undeclared = routes
      .map((r) => routeKey(r.method, r.path))
      .filter((k) => !ROUTE_PERMISSIONS.has(k) && !EXEMPT.has(k));
    expect(
      undeclared,
      `${undeclared.length} mounted route(s) declare no permission and no exemption. ` +
        `A route nobody declared ships OPEN — add it to gen-map.py and regenerate ` +
        `(see contracts/README.md), or exempt it WITH A REASON.`,
    ).toEqual([]);
  });

  it("holds no stale entries — every declared route is actually mounted", () => {
    const mounted = new Set(routes.map((r) => routeKey(r.method, r.path)));
    const stale = [...ROUTE_PERMISSIONS.keys(), ...EXEMPT.keys()].filter((k) => !mounted.has(k));
    expect(
      stale,
      `${stale.length} declared route(s) are not mounted. A stale entry is a permission ` +
        `guarding nothing, and it makes the map's counts lie about the surface.`,
    ).toEqual([]);
  });

  it("names only real permissions, on the right tier", () => {
    for (const [key, req] of ROUTE_PERMISSIONS) {
      if (req.kind === "workspace") {
        expect(isWorkspacePermission(req.permission), `${key} -> ${req.permission}`).toBe(true);
        expect(req.param, `${key} declares no workspace parameter`).toBeTruthy();
      } else if (req.kind === "platform") {
        expect(isPlatformPermission(req.permission), `${key} -> ${req.permission}`).toBe(true);
      } else if (req.kind === "identity") {
        expect(req.why.trim(), `${key} is identity-only with no stated reason`).not.toBe("");
      }
      if (req.kind === "workspace" || req.kind === "platform") {
        expect(isPermission(req.permission)).toBe(true);
      }
    }
  });

  it("every workspace entry names a parameter the path actually contains", () => {
    // ⚠ Scope is DECLARED, never inferred. `GET /api/workspaces/:id` is workspace-scoped
    // on `:id`; `PUT /api/local-users/:id/access/:workspaceId` is deployment-level and
    // carries a `:workspaceId`. Inferring from presence gets one wrong in each direction.
    for (const [key, req] of ROUTE_PERMISSIONS) {
      if (req.kind !== "workspace") continue;
      const path = key.slice(key.indexOf(" ") + 1);
      expect(path.includes(`:${req.param}`), `${key} names :${req.param}, which is not in it`).toBe(
        true,
      );
    }
  });

  it("every exemption carries a reason — FR-005", () => {
    // An exemption with no reason is indistinguishable from an oversight, and both look
    // like a passing test.
    for (const [key, { reason }] of EXEMPT) {
      expect(reason.trim(), `${key} is exempt with no stated reason`).not.toBe("");
      expect(reason.length, `${key}'s reason is a stub`).toBeGreaterThan(8);
    }
  });

  it("the two maps are disjoint — nothing is both guarded and exempt", () => {
    const both = [...EXEMPT.keys()].filter((k) => ROUTE_PERMISSIONS.has(k));
    expect(both, "a route cannot be both permission-guarded and exempt").toEqual([]);
  });

  /**
   * ⚠ **THESE NUMBERS ARE A TRIPWIRE, NOT A FACT ABOUT THE DESIGN — do not "fix" them by
   * reading the arrays.** Their whole value is that a route appearing or disappearing
   * makes somebody look. Deriving them from `ROUTE_PERMISSIONS.size` would make this test
   * true by construction and silent about the thing it exists to notice.
   *
   * 2026-09-14: 214 → 216, when `release/beta` merged in with two new mock-data reads
   * (`GET …/datasources/:dsId/mock` and `…/mock/rows`). Both were UNDECLARED on arrival —
   * the sibling assertion above went red with *"a route nobody declared ships OPEN"* —
   * and both are `datasources.read`, the same as every other read on that datasource.
   *
   * 2026-09-15: 216 → 218, when beta-1.0.24…1.0.29 merged in. Again two, again
   * undeclared, again caught by the assertion above rather than by anybody reading:
   * `POST …/flows/generate/clarify` (`flows.write`, like its siblings) and
   * `DELETE …/email-box/simulated` (`flows.run` — see `gen-map.py`, which records why
   * that is the least bad of the available options rather than a good fit).
   *
   * ⚠ **Twice in two days is the pattern, not the exception.** Every merge from the
   * release line should expect this test to be the thing that notices.
   */
  /**
   * ⚠ 219, was 218 — `POST …/datasources/:dsId/mock/rebuild` added 2026-09-17, so a
   * failed mock build stops being a dead end a person can read and not fix. It is
   * `datasources.write`, the same tier as `/schema/refresh`.
   *
   * ⚠ **These numbers exist so a route surface change cannot be silent, so do NOT
   * update one to make a run green.** Regenerate the map first (contracts/README.md);
   * if the count moved and you did not add a route, that is the finding.
   */
  // +1 workspace, +1 identity 2026-10-13: chat modes — `POST …/sessions/:sessionId/mode` and `PUT /api/me/forge-default-mode`.
  // +1 workspace 2026-10-13: `DELETE …/sessions/:sessionId/files/:name` (remove a chat file).
  // +1 workspace 2026-10-13: `PATCH …/pi-builder/chats/:chatId` (rename a saved chat).
  // rbac-observability (2026-10-15): + `PUT /api/generation/pricing` (platform) and `GET …/pricing` (identity).
  // +1 workspace 2026-10-29: `POST …/sessions/:sessionId/thinking` (Forge Agent's thinking level).
  // +2 workspace 2026-11-03: `POST …/sessions/:sessionId/model` (a chat's model) and `POST …/sessions/:sessionId/steer` (Send now on a queued message).
  // −5 2026-11-04: one model connection — GET/PUT/DELETE /api/generation/llm/provider, POST …/llm/models and …/llm/test removed (2 platform, 3 identity); /api/runtime-model/* is the one model API.
  it("the counts are the ones the design states: 351 = 266 + 37 + 27 + 39", () => {
    const byKind = { workspace: 0, platform: 0, identity: 0 };
    for (const req of ROUTE_PERMISSIONS.values()) {
      if (req.kind === "workspace") byKind.workspace += 1;
      else if (req.kind === "platform") byKind.platform += 1;
      else byKind.identity += 1;
    }
    expect(byKind.workspace).toBe(267); // +12 edge device routes (+ reject) (personal thin); prior 255: + 4 project files (list, add, download, remove — 0132), + 8 projects (list, create, read, change, delete, add member, remove member, hand over) and 4 moves (a workflow's and a chat's preview and move — sharing-boundaries phase 5), + 2 readiness and my account (phase 4), + 2 turn on for me (read, set — sharing-boundaries phase 3), + 1 read a chat without opening it, + 2 own notices (list, mark read), + 2 ask a reviewer to approve / withdraw (sharing-boundaries), + 5 personal actions (mine, mine actions, mine pack, mine call off, personal-use), + 4 declared API calls (list, declare, pack, switch off), + 3 restricted workspaces (restrict, list and end emergency access), + PUT flows/:flowId/owner (rbac-observability), + 7 connector routes (plugins), + 2 sign-in routes (start, callback), + 1 confirm-a-proposed-change, + 1 clear a chat's chosen connection, + 2 a workflow's run-as (read, change), + 3 a workflow's visibility, switch on, switch off (plugins phase 9)
    expect(byKind.platform).toBe(37); // −5 runtime-model routes → identity (personal BYOK); prior 42: − PUT and DELETE /api/generation/llm/provider (one model connection, 2026-11-04); − the 10 /api/ops routes, + the 5 runtime-model routes (ops-api retired 2026-10-30), + the People list (admin simplify phase 3), + start emergency access (restricted workspaces), + the deployment-wide observability summary (P-OBS), + model pricing, + spend by model, + the access grid, + 6 connector install routes, + 3 OAuth app routes
    expect(byKind.identity).toBe(27); // +5 runtime-model (personal BYOK); prior 22: + GET /api/reports/forecast (the report dashboard, PR 1542; same per-workspace check as /runs); − GET /api/generation/llm/provider, POST …/llm/models, POST …/llm/test (2026-11-04); + the four cost-report routes (2026-10-26), + the four invitation routes (admin simplify phase 2)
    expect(EXEMPT.size).toBe(39); // +10 edge public + Forge edge (personal thin); prior 29 included llm/web/forge fetch
    expect(routes.length).toBe(351); // +3 Forge edge tools (devices/enqueue/job); edge workspace/public were already mounted
  });
});

/**
 * FR-003's control.
 *
 * ⚠ Without this, the completeness check above could be satisfied by a walker that finds
 * nothing, a map that contains everything, or a comparison that never fails — and all
 * three would be green. This proves the check can go RED, which is the only thing that
 * makes the green runs mean anything (I-38).
 */
describe("FR-003 CONTROL: an undeclared route makes the check fail", () => {
  it("a synthetic router with one undeclared handler is caught", () => {
    const probe = express();
    probe.get("/api/workspaces/:workspaceId/a-route-nobody-declared", (_req, res) => res.end());
    const probeRoutes = mountedRoutes(probe);

    expect(probeRoutes.length).toBe(1);
    const undeclared = probeRoutes
      .map((r) => routeKey(r.method, r.path))
      .filter((k) => !ROUTE_PERMISSIONS.has(k) && !EXEMPT.has(k));

    // Exactly the failure the real check reports, reproduced on purpose.
    expect(undeclared).toEqual(["GET /api/workspaces/:workspaceId/a-route-nobody-declared"]);
  });

  it("and a DECLARED route on the same synthetic router is not", () => {
    // The other half: the check must not simply flag everything.
    const probe = express();
    probe.get("/api/health", (_req, res) => res.end());
    const undeclared = mountedRoutes(probe)
      .map((r) => routeKey(r.method, r.path))
      .filter((k) => !ROUTE_PERMISSIONS.has(k) && !EXEMPT.has(k));
    expect(undeclared).toEqual([]);
  });
});

describe("requirementFor", () => {
  it("resolves an exempt route to its exemption, not to undefined", () => {
    const req = requirementFor("POST", "/api/executions/begin");
    expect(req?.kind).toBe("exempt");
    if (req?.kind === "exempt") expect(req.reason).toMatch(/Kestra callback secret/i);
  });

  it("resolves a workspace route to its permission and parameter", () => {
    expect(requirementFor("DELETE", "/api/workspaces/:workspaceId/flows/:flowId")).toEqual({
      kind: "workspace",
      permission: "flows.write",
      param: "workspaceId",
    });
  });

  it("resolves the two `:id` workspace reads on their own parameter name", () => {
    expect(requirementFor("GET", "/api/workspaces/:id")).toEqual({
      kind: "workspace",
      permission: "flows.read",
      param: "id",
    });
  });

  it("is case-insensitive on the method and returns undefined for an unknown route", () => {
    expect(requirementFor("get", "/api/workspaces/:id")).toBeDefined();
    expect(requirementFor("GET", "/api/nope")).toBeUndefined();
  });
});

/**
 * ⚠ The gap this feature exists to close, asserted as NUMBERS so it cannot quietly
 * reopen.
 *
 * ⚠ **THESE COUNT NAMELESS HANDLER CHAINS, NOT "ROUTES WITHOUT A ROLE GUARD", AND THE
 * DIFFERENCE BIT ME WHILE WRITING THIS FILE.** `asyncHandler` returns an anonymous
 * arrow, so `requireWorkspaceRole` — which is built through it — appears in the layer
 * stack with **no name at all**. A test asking "does this route carry a role guard?" by
 * matching handler names finds five (`requireSuperAdmin`, which is not wrapped) out of
 * 142 and reports 137 routes as unguarded, which is wrong and would have been reported
 * as a finding. The honest, detectable facts are the three below.
 */
describe("the measured gap", () => {
  const ws = routes.filter(
    (r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.path))?.kind === "workspace",
  );

  /**
   * ⚠ **154 = 142 + 8 + 4, and the arithmetic is the point.** 142 workspace-scoped routes
   * existed when this feature measured the gap, it added 8 role routes of its own, and
   * `release/beta` brought 4 more across two merges — 2 on 2026-09-14 (the mock-data
   * reads) and 2 on 2026-09-15 (clarify, and the simulated-outbox clear). The historical
   * measurement — **106 of the original 142 carried no authorisation check at all** — is
   * unchanged by anything arriving later, and is what this describe block is about.
   *
   * ⚠ Do not collapse this into `ws.length` read back from the map. The number is a
   * tripwire: a route joining the workspace tier should make somebody decide which
   * permission it takes, and a self-derived count decides nothing.
   */
  // +1 2026-09-24: `POST …/flows/generate/jobs/:jobId/confirm` (phased-typed-build phase 4
  // task 6), decided `flows.write` — the same permission that starts the job it answers.
  // +4 2026-09-26: the one builder (compiled-builder phase 4) — `POST …/flows/builder/{understand,correct,build}` and
  // `POST …/flows/:flowId/incomplete/answer`, all `flows.write`: each drafts or completes a flow, as `/generate` does.
  // +3 2026-09-28: the manual builder (compiled-builder phase 7, D-329) — `GET …/flows/:flowId/canvas` (`flows.read`), and
  // `POST …/flows/canvas` (create) and `POST …/canvas/{act,save}` (`flows.write`: acting is editing, even though only save writes).
  // +1 2026-10-07: `POST …/flows/:flowId/duplicate` (`flows.write`) — copy draft to new unarmed draft.
  // +3 2026-10-12: saved chats — list and file download (`flows.read`), and delete (`flows.read` at the route: the
  // handler then requires the chat's creator or a workspace admin, which no permission expresses).
  // +5 2026-10-17: workflow references — `GET …/referenceable` and `GET …/references` (`flows.read`), add / move a pin /
  // remove (`flows.write`). The title said 187 against an asserted 193 before this; it now states the asserted number.
  // +1 2026-10-15: `PUT …/flows/:flowId/owner` (`content.read.others`) — an Admin moves a workflow to another member.
  it("202 workspace-scoped routes — 142 that existed, 8 role routes, 4 from release/beta, 1 mock rebuild, 1 skeleton confirm, 1 chat thread bind, 1 incomplete working copy read (D-319), 4 builder routes, 4 canvas routes, 1 choice readback, 1 SQLite file upload, 1 duplicate, minus 7 generation routes deleted at the cutover (phase 8), 13 Forge builder routes (pi-runtime), 1 live run of a Forge workflow (P5), 1 observability summary (P-OBS), 2 Email box clears (all undelivered, one message), 2 Forge chat attachments (attach, remove), 4 workspace Files (list, upload, download, delete), 3 saved chats (list, delete, file download), 1 chat mode switch, 1 chat file removal, 1 chat rename, 1 held attachment (Email box), 5 workflow references (referenceable, list, add, move a pin, remove), 1 owner change (rbac-observability), 7 connector routes (marketplace, list, connect, rotate, test, remove, choose actions), 2 sign-in routes (start, callback), 1 confirm-a-proposed-change, 1 clear a chat's chosen connection, 2 a workflow's run-as (read, change), 3 a workflow's visibility, switch on, switch off (plugins phase 9), 3 restricted workspaces, 4 declared API calls, 5 personal actions, 1 chat thinking level, 2 ask for approval (ask, withdraw), 2 own notices (list, mark read), 1 read a chat, 1 chat model, 1 steer a running turn", () => {
    expect(ws.length).toBe(255);
  });

  it("109 of them carry no named middleware at all", () => {
    // ⚠ A floor, not an equality, because Phase 3 mounts `requirePermission` on these
    // and the number is meant to fall. When it reaches 0 this assertion should be
    // rewritten to say so rather than deleted.
    // ⚠ 109, not 107. The 142 the MAP calls workspace-scoped is not the same set as the
    // 142 sitting under the `/api/workspaces/:workspaceId/` prefix: `me/attendance` and
    // `me/exceptions` live under that prefix but are identity-only (own data, subject
    // from the token), and `GET /api/workspaces/:id` and `/:id/manifest` are
    // workspace-scoped on a DIFFERENT parameter name. Two out, two in — and the two
    // going out carry `requireIdentity` while the two coming in are bare, which moves
    // both counts by two in opposite directions. Counting by path prefix instead of by
    // the map is how that gets reported as a discrepancy that is not one.
    const bare = ws.filter((r) => r.guards.length === 0 && !r.rbac);
    expect(bare.length).toBeLessThanOrEqual(109);
  });

  it("CONTROL: the walker CAN see a guard — `requireIdentity` is visible on 33+", () => {
    // Without this, "109 routes have no named guard" could be produced by a walker that
    // never reads guards at all.
    const withIdentity = ws.filter((r) => r.guards.includes("requireIdentity"));
    expect(withIdentity.length).toBeGreaterThanOrEqual(33);
  });

  it("⚠ `requireSuperAdmin` is now on ZERO workspace-scoped routes, deliberately", () => {
    // ⚠ It was on FIVE — the membership and member-capability writes — and this
    // assertion used to pin that number. Removing it is spec behaviour change 3, the
    // AND/OR resolution: assigning a member is super admin **OR** `members.grant`, not
    // AND. Keeping the super-admin guard beside the spliced permission guard would have
    // meant AND, which is NARROWER than before and would stop a workspace administrator
    // managing their own workspace — and would refuse a platform administrator outright,
    // breaking D-9's conferral at the only route it exists to reach.
    //
    // An allowlist holder still passes, because `config.isSuperAdmin` short-circuits the
    // resolver to the entire catalogue before any row is read. Verified end to end by
    // `rbac:verify`: an allowlist holder with no membership row anywhere is permitted
    // 142 of 142 workspace-scoped routes.
    //
    // ⚠ This test going red is the correct alarm if somebody re-adds it "for safety".
    const superAdmin = ws.filter((r) => r.guards.includes("requireSuperAdmin"));
    expect(
      superAdmin.map((r) => routeKey(r.method, r.path)),
      "a workspace route regained requireSuperAdmin — that makes it AND, not OR",
    ).toEqual([]);
  });
});

/**
 * T027 — THE MOUNT ASSERTION.
 *
 * ⚠ **Without this, a complete map plus an unmounted guard passes every check above
 * while enforcing absolutely nothing.** The completeness test proves the map covers the
 * surface; this proves the surface actually carries the map. I-38 exactly, and the most
 * important assertion in the feature: it is the difference between a document and a
 * control.
 *
 * ⚠ It checks the guard's DECLARED PERMISSION against the map, not merely that some
 * guard is present. Presence alone is satisfied by every route carrying the same wrong
 * guard, which is a state that would pass a count and fail every user.
 */
describe("T027: the declared guard is actually mounted", () => {
  const ws = routes.filter(
    (r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.path))?.kind === "workspace",
  );

  it("every workspace-scoped route carries a permission guard", () => {
    const unguarded = ws.filter((r) => !r.rbac).map((r) => routeKey(r.method, r.path));
    expect(
      unguarded,
      `${unguarded.length} workspace-scoped route(s) declare a permission and do not ` +
        `carry its guard. They are OPEN to anybody who can sign in.`,
    ).toEqual([]);
  });

  it("and the guard it carries declares the SAME permission the map does", () => {
    const mismatched: string[] = [];
    for (const r of ws) {
      const req = ROUTE_PERMISSIONS.get(routeKey(r.method, r.path));
      if (req?.kind !== "workspace" || !r.rbac) continue;
      if (r.rbac.permission !== req.permission || r.rbac.param !== req.param) {
        mismatched.push(
          `${routeKey(r.method, r.path)}: mounted ${r.rbac.permission}/:${r.rbac.param}, ` +
            `map says ${req.permission}/:${req.param}`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("a count floor against the real app — the walk is not a silent no-op", () => {
    // ⚠ The `wrapAsyncRoutes` idiom. A walk that spliced nothing would leave 106 routes
    // exactly as open while the boot log read as if they were closed. The floor is
    // deliberately below the real number so ordinary route work does not edit a test,
    // but far above zero.
    expect(ws.filter((r) => r.rbac).length).toBeGreaterThanOrEqual(140);
  });

  it("CONTROL: the splice returns a non-zero count on a fresh app", () => {
    // Proves the mechanism runs, separately from the marker being readable — the marker
    // survives two wrappers to get here, and a break in either would look identical.
    const probe = express();
    probe.get("/api/workspaces/:workspaceId/flows", (_req, res) => res.end());
    expect(mountPermissionGuards(probe)).toBe(1);
  });

  it("CONTROL: it splices NOTHING onto a route the map does not declare", () => {
    // The other direction: a walk that guarded everything it saw would also pass the
    // assertions above, and would put a permission in front of the Kestra callbacks.
    const probe = express();
    probe.post("/api/executions/begin", (_req, res) => res.end());
    probe.get("/api/health", (_req, res) => res.end());
    probe.get("/api/workspaces/:workspaceId/undeclared-thing", (_req, res) => res.end());
    expect(mountPermissionGuards(probe)).toBe(0);
  });

  it("is idempotent — a second walk splices nothing", () => {
    const probe = express();
    probe.get("/api/workspaces/:workspaceId/flows", (_req, res) => res.end());
    expect(mountPermissionGuards(probe)).toBe(1);
    expect(mountPermissionGuards(probe)).toBe(0);
  });

  it("EXEMPT routes carry no permission guard — the callbacks stay reachable", () => {
    // ⚠ I-65: `app.use("/api", guard)` silently put the Kestra step callbacks behind the
    // parent key, after which every flow died at `begin` with no `flow_executions` row.
    // This is the assertion that would catch that shape returning.
    const exemptMounted = routes.filter((r) => EXEMPT.has(routeKey(r.method, r.path)));
    expect(exemptMounted.length).toBe(39); // +10 edge setup/pair/claim + Forge edge tools (personal thin); prior 29 as above
    for (const r of exemptMounted) {
      expect(r.rbac, `${routeKey(r.method, r.path)} is exempt but carries a guard`).toBeUndefined();
    }
  });

  it("identity-only routes carry no permission guard either", () => {
    // Needing a permission to discover you have none is a bootstrap nobody can escape.
    for (const r of routes) {
      const req = ROUTE_PERMISSIONS.get(routeKey(r.method, r.path));
      if (req?.kind !== "identity") continue;
      expect(r.rbac, `${routeKey(r.method, r.path)} is identity-only but carries a guard`).toBeUndefined();
    }
  });
});
