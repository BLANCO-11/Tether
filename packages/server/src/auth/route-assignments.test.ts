import { describe, it, expect } from "vitest";
import { ROUTE_PERMISSIONS, EXEMPT, requirementFor } from "./route-permissions.js";

/**
 * The assignments that are NOT obvious, pinned one by one.
 *
 * ⚠ The map is generated, so a wrong *assignment* is still perfectly possible — the
 * generator guarantees completeness, not correctness. These are the cells where a
 * reasonable person would have chosen differently, and each one is a decision recorded
 * in `contracts/route-permissions.md` and in the task list's route sweep (T028–T045a).
 * Without this file those decisions live only in a markdown table nothing checks.
 */

function permOf(method: string, path: string): string | undefined {
  const req = requirementFor(method, path);
  return req && (req.kind === "workspace" || req.kind === "platform") ? req.permission : undefined;
}

const WS = "/api/workspaces/:workspaceId";

describe("the assignments a reasonable person would get wrong", () => {
  it("an email Forge drafted is sent or cancelled only by a signed-in person, never by Forge's key", () => {
    for (const verb of ["send", "cancel"]) {
      const p = `${WS}/pi-builder/sessions/:sessionId/mail/:proposalId/${verb}`;
      expect(permOf("POST", p)).toBe("flows.write");
      expect(requirementFor("POST", p)?.kind).toBe("workspace");
    }
    expect([...EXEMPT.keys()].filter((k) => k.startsWith("POST /api/forge") && k.includes("mail"))).toEqual(["POST /api/forge/mail"]);
  });

  it("a WRITE that looks like a read: testing a datasource dials the tenant's database", () => {
    // It connects with the stored credential. That is not a read of Foundry's own data.
    expect(permOf("POST", `${WS}/datasources/:dsId/test`)).toBe("datasources.write");
  });

  it("a WRITE that looks like a read: probing a tool dials the endpoint with its credential", () => {
    expect(permOf("POST", `${WS}/tools/probe`)).toBe("tools.write");
  });

  it("deleting a REVISION is `flows.approve`, not `flows.write`", () => {
    // ⚠ Deleting a revision can unmake an approval — it is an approval-surface act
    // wearing an editing verb.
    expect(permOf("DELETE", `${WS}/flows/:flowId/revisions/:revision`)).toBe("flows.approve");
    // While deleting the FLOW is ordinary editing.
    expect(permOf("DELETE", `${WS}/flows/:flowId`)).toBe("flows.write");
  });

  it("firing a manual trigger is `flows.run`, not `flows.arm`", () => {
    // ⚠ Arming is putting a schedule in front of real data; firing once is running it.
    // Conflating them means anybody who may run a flow may also leave it running.
    expect(permOf("POST", `${WS}/flows/:flowId/triggers/:tid/fire`)).toBe("flows.run");
    // ...while creating, editing and deleting one is `flows.arm`.
    expect(permOf("POST", `${WS}/flows/:flowId/triggers`)).toBe("flows.arm");
    expect(permOf("DELETE", `${WS}/flows/:flowId/triggers/:tid`)).toBe("flows.arm");
  });

  it("instantiating a template is `flows.write`, not `templates.write`", () => {
    // It creates an automation, through the same `importFlow` path a pasted bundle takes.
    expect(permOf("POST", `${WS}/flow-templates/:id/instantiate`)).toBe("flows.write");
  });

  it("a chat turn is `flows.write` — it writes a revision", () => {
    expect(permOf("POST", `${WS}/flow-chat/threads/:threadId/turns`)).toBe("flows.write");
  });

  it("T045a: reading active break-glass is `breakglass.read`, NOT `breakglass.activate`", () => {
    // ⚠ The hand-written map gated a READ behind an ACTIVATION permission. Effective
    // access is unchanged — both sit in `admin` and nowhere else — but the name stops
    // lying about what holding it lets you do.
    expect(permOf("GET", `${WS}/break-glass/active`)).toBe("breakglass.read");
  });

  it("the two big gaps this feature closes are guarded at all", () => {
    // ⚠ Before this feature these were reachable by anybody who could sign in.
    expect(permOf("DELETE", `${WS}/flows/:flowId`)).toBeDefined();
    expect(permOf("POST", `${WS}/flows/:flowId/test-run`)).toBe("flows.run");
    expect(permOf("POST", `${WS}/flows/:flowId/duplicate`)).toBe("flows.write");
  });

  it("secrets: a NAME list is a read; there is no permission that returns a VALUE", () => {
    expect(permOf("GET", `${WS}/secrets`)).toBe("secrets.read");
    expect(permOf("GET", `${WS}/secrets/audit`)).toBe("secrets.read");
    // INV-3 — no route returns a value, so no permission grants one.
    for (const [key, req] of ROUTE_PERMISSIONS) {
      if (req.kind !== "workspace" || req.permission !== "secrets.read") continue;
      expect(key, "a secrets.read route that looks like it reveals a value").not.toMatch(
        /reveal|value|decrypt/i,
      );
    }
  });
});

describe("the exemptions, each for its own stated reason", () => {
  it("the public receivers stay exempt — their credential is the token in the URL", () => {
    expect(requirementFor("POST", "/api/triggers/:token/webhook")?.kind).toBe("exempt");
    expect(requirementFor("POST", "/api/triggers/:token/api")?.kind).toBe("exempt");
  });

  it("the step callbacks stay exempt — they carry an execution token, not a session", () => {
    for (const p of ["tool", "approval", "datasource", "query", "llm", "http"]) {
      const req = requirementFor("POST", `/api/steps/${p}`);
      expect(req?.kind, `/api/steps/${p} is no longer exempt`).toBe("exempt");
      if (req?.kind === "exempt") expect(req.reason).toMatch(/execution token/i);
    }
  });

  it("`begin` stays exempt — it is the engine's own callback", () => {
    // ⚠ I-65: putting this behind the parent key kills every flow at `begin`, with no
    // `flow_executions` row and nothing naming the cause.
    const req = requirementFor("POST", "/api/executions/begin");
    expect(req?.kind).toBe("exempt");
    if (req?.kind === "exempt") expect(req.reason).toMatch(/Kestra callback secret/i);
  });

  it("the liveness probes stay open — a credential there turns a busy moment into a restart loop", () => {
    expect(requirementFor("GET", "/api/health")?.kind).toBe("exempt");
    expect(requirementFor("GET", "/api/health/strict")?.kind).toBe("exempt");
  });

  it("local sign-in stays exempt — it answers before anybody has a session", () => {
    const req = requirementFor("POST", "/api/local-auth/verify");
    expect(req?.kind).toBe("exempt");
    if (req?.kind === "exempt") expect(req.reason).toMatch(/before anybody has a session/i);
  });

  it("the runner's callbacks are exempt from the PERSON guard, not open — the execution token authenticates them", () => {
    // The argument for 17 and 18 (pi-runtime P2 and P5): Foundry's runner reports a step's result and hands back a
    // run paused at an approval. Neither has a person; both carry the run's execution token, checked by
    // requireStepToken and bound to that one execution — exactly `POST /api/executions/:id/complete`'s position.
    for (const path of ["/api/executions/:id/steps/:stepId/result", "/api/executions/:id/pause"]) {
      const req = requirementFor("POST", path);
      expect(req?.kind).toBe("exempt");
      if (req?.kind === "exempt") expect(req.reason).toMatch(/execution token/i);
    }
  });

  it("and the exempt list is EXACTLY thirty-nine — a fortieth needs a decision (edge setup + Forge edge tools)", () => {
    // ⚠ This is the shortest and most security-relevant list in the feature: it is the
    // set of routes an unauthenticated caller can reach. Growing it should cost somebody
    // an argument, not a line. (17 and 18: the runner's token-authenticated callbacks, above.
    // 19 and 20: a step's saved files and its workspace files, the same execution token (2.26.28,
    // 2.26.32). 21 and 22: Forge's data and file tools, its per-conversation key (2.26.36, 2.26.42).)
    // The 23rd (2026-10-27): Forge's connector tool, its conversation key like data and file; writes refused in the service.
    // 25 and 26 (2026-10-28): listing the connected services' actions, and proposing to switch one on or off. Same key,
    // Forge Agent only; the list changes nothing and the proposal applies nothing — the person's click, under their own
    // identity on a guarded route, does, and only where their permissions allow (agent-grants.ts `mayDecide`).
    // 27–29 (beta-2.36.0): `POST /api/llm/complete` and `POST /api/web/fetch`, the built-in tools moved into the
    // server, each behind its own derived key exactly as `POST /api/mail/send` is; and `POST /api/forge/fetch`, Forge
    // reading a public address while building, behind its per-conversation key like the other Forge tools.
    // 30–36: public edge setup / pair / claim / complete / agent.mjs (personal thin; setup token or device Bearer).
    // 37–39: Forge edge devices / enqueue / job (personal thin; per-conversation tool key).
    // 41–42: edge plugin relay POST/GET (device Bearer).
    // 43–45: email sign-in code request/verify/status (pre-session, API key + throttles).
    // 46: Forge emailing the chat's owner (personal thin; per-conversation tool key; recipient resolved in the service).
    expect(EXEMPT.size).toBe(46);
    expect(EXEMPT.get("POST /api/llm/complete")?.reason).toBe("requireLlmKey");
    expect(EXEMPT.get("POST /api/web/fetch")?.reason).toBe("requireWebKey");
    for (const path of [
      "/api/forge/data",
      "/api/forge/file",
      "/api/forge/plugin",
      "/api/forge/propose",
      "/api/forge/actions",
      "/api/forge/propose-setting",
      "/api/forge/fetch",
      "/api/forge/edge/devices",
      "/api/forge/edge/enqueue",
      "/api/forge/edge/job",
      "/api/forge/mail",
    ]) {
      const req = requirementFor("POST", path);
      expect(req?.kind).toBe("exempt");
      if (req?.kind === "exempt") expect(req.reason).toMatch(/per-conversation tool key|edge/);
    }
  });
});

describe("email sign-in and the allowlist admin", () => {
  it("the email-otp routes answer before a session; the allowlist admin routes are identity-gated", () => {
    for (const p of ["request", "verify", "status"]) {
      const req = requirementFor("POST", `/api/email-otp/${p}`);
      expect(req?.kind).toBe("exempt");
      if (req?.kind === "exempt") expect(req.reason).toMatch(/before anybody has a session/i);
    }
    expect(requirementFor("GET", "/api/allowed-users")?.kind).toBe("identity");
  });
});

describe("the deployment tier keeps its own vocabulary", () => {
  it("the model connection is identity-scoped (personal BYOK); pricing stays platform", () => {
    // Personal thin: /api/runtime-model/* is each subject's own connection (identity), not platform.toolmodel.*.
    // Prices remain a separate platform decision.
    expect(requirementFor("PUT", "/api/runtime-model/provider")?.kind).toBe("identity");
    expect(requirementFor("GET", "/api/runtime-model/provider")?.kind).toBe("identity");
    expect(permOf("PUT", "/api/generation/pricing")).toBe("platform.generation.write");
  });

  it("ops-api is gone (beta-2.36.0): nothing is mapped under /api/ops", () => {
    // The outbox and call log these routes served left with ops-api; a run's calls are read per run
    // (GET …/flow-executions/:id/calls). A route reappearing here needs its own decision, not this old one.
    const keys = [...ROUTE_PERMISSIONS.keys(), ...EXEMPT.keys()];
    expect(keys.length).toBeGreaterThan(100); // CONTROL: the scan sees the map
    expect(keys.filter((k) => / \/api\/ops\//.test(k))).toEqual([]);
  });

  it("signals answers 'is the system working', so it is not `platform.audit.read`", () => {
    expect(permOf("GET", "/api/signals")).toBe("platform.signals.read");
  });

  it("local-account ACCESS routes take platform.members.grant, not localusers.write", () => {
    // ⚠ These write `workspace_members`. A third permission that grants workspace access
    // is exactly the duplication D-6 deletes `requireDeploymentAdmin` to avoid — and
    // they are also the counter-example to FR-024: DEPLOYMENT-level routes that carry a
    // `:workspaceId`, which is why the guard takes its parameter name explicitly.
    expect(permOf("PUT", "/api/local-users/:id/access/:workspaceId")).toBe("platform.members.grant");
    expect(permOf("DELETE", "/api/local-users/:id/access/:workspaceId")).toBe(
      "platform.members.grant",
    );
    expect(permOf("GET", "/api/local-users/:id/access")).toBe("platform.users.read");
    // While the account lifecycle is its own thing.
    expect(permOf("POST", "/api/local-users")).toBe("platform.localusers.write");
  });

  it("and those two are NOT treated as workspace-scoped despite carrying :workspaceId", () => {
    // The failure this prevents: inferring scope from the presence of a parameter.
    expect(requirementFor("PUT", "/api/local-users/:id/access/:workspaceId")?.kind).toBe("platform");
  });

  it("the two workspace reads on `:id` are workspace-scoped on THEIR parameter", () => {
    expect(requirementFor("GET", "/api/workspaces/:id")).toEqual({
      kind: "workspace",
      permission: "flows.read",
      param: "id",
    });
    expect(requirementFor("GET", "/api/workspaces/:id/manifest")).toEqual({
      kind: "workspace",
      permission: "flows.read",
      param: "id",
    });
  });
});
