import { describe, expect, it } from "vitest";
import {
  flowExecutionSummaryFromFA,
  runFromFlowExecution,
  runLabel,
  runWorkflowId,
  toolFromFA,
  toolInputToFA,
  triggerFireFromFA,
} from "./adapters";
import type { FAFlowExecutionSummary, FATriggerFire } from "./foundry-client";

/**
 * The client half of I-23, and the reason it needs its own suite.
 *
 * An execution's `flowId` was the Kestra SLUG in both `list()` and `get()` while
 * `flowId` everywhere else in the API is a uuid. The server fix is only half the
 * work: this client rendered that field as a LABEL in two places — `/runs/[id]`'s
 * page title and History's automation column — so returning the uuid without
 * touching them replaces "the wrong id space" with "a uuid where a name was".
 *
 * That makes the property here a pair, not a single assertion: the id must be an
 * id, AND the label must still be a name. Either one alone passes against a
 * broken version of the other.
 */

const summary: FAFlowExecutionSummary = {
  id: "fe-1",
  workspaceId: "ws-1",
  flowId: "3f2b9a4c-0000-4000-8000-000000000001",
  flowName: "attendance-monitoring",
  flowNameSnapshot: null,
  flowIdSnapshot: null,
  status: "running",
  engineStatus: "success",
  startedAt: "2026-06-01T10:00:00.000Z",
  endedAt: "2026-06-01T10:00:07.000Z",
  durationMs: 7000,
  inputs: { period: "2026-06" },
  replayOfId: null,
  replayFromStep: null,
};

describe("a flow execution carries an id AND a name, and they are different fields", () => {
  it("keeps the Foundry uuid on `flowId` — the thing a client could filter by", () => {
    expect(flowExecutionSummaryFromFA(summary).flowId).toBe(
      "3f2b9a4c-0000-4000-8000-000000000001",
    );
  });

  it("keeps the slug on `flowName`", () => {
    expect(flowExecutionSummaryFromFA(summary).flowName).toBe("attendance-monitoring");
  });

  /**
   * ⚠ The regression guard for the FIX, not for the bug. Passing `flowId` to
   * `runFromFlowExecution` compiled perfectly before and after; only the value
   * changed, from a readable slug to a uuid, on every row of History and the
   * dashboard.
   */
  it("labels a History row with the name, never with the uuid", () => {
    const run = runFromFlowExecution(
      flowExecutionSummaryFromFA(summary),
      runLabel(flowExecutionSummaryFromFA(summary)),
    );
    expect(run.automation).toBe("attendance-monitoring");
    expect(run.automation).not.toContain("3f2b9a4c");
  });

  it("survives an orphaned run — no flow, but still a name", () => {
    // `flow_executions.flow_id` is nullable (`ON DELETE SET NULL`, plus Phase-1
    // history that predates the `flows` table). The slug is copied onto the row
    // at `begin` and is NOT NULL, so it outlives the flow.
    const orphan = flowExecutionSummaryFromFA({ ...summary, flowId: null });
    expect(orphan.flowId).toBeNull();
    expect(runLabel(orphan)).toBe("attendance-monitoring");
  });

  it("degrades to a phrase, not to a uuid, when the server sends no name", () => {
    // An older server simply does not have the field. Printing the id instead
    // would be the same class of mistake in the other direction: a page title
    // that is a 36-character hex string tells a person nothing.
    const nameless = flowExecutionSummaryFromFA({
      ...summary,
      flowName: undefined as unknown as string,
    });
    expect(runLabel(nameless)).toBe("Unnamed run");
    expect(runLabel(nameless)).not.toContain("3f2b9a4c");
  });

  /**
   * The name-at-run-time snapshot: a second, frozen label copied onto the row
   * at `begin`, the same way `flowName` (the slug) already is. It must win
   * over the slug whenever present, because it is the more accurate answer to
   * "what was this flow called when it ran" — the slug never changes and so
   * cannot answer that question at all.
   */
  it("prefers `flowNameSnapshot` over the slug when both are present", () => {
    const renamed = flowExecutionSummaryFromFA({
      ...summary,
      flowNameSnapshot: "Rachit V1",
    });
    expect(runLabel(renamed)).toBe("Rachit V1");
  });

  it("falls back to the slug when `flowNameSnapshot` is null", () => {
    // Every run before this column existed has no snapshot at all — History
    // must keep behaving exactly as it did before this field was added.
    const preSnapshot = flowExecutionSummaryFromFA({
      ...summary,
      flowNameSnapshot: null,
    });
    expect(runLabel(preSnapshot)).toBe("attendance-monitoring");
  });

  it("keeps the snapshot on an orphaned run — no flow, but still the name it ran under", () => {
    const orphan = flowExecutionSummaryFromFA({
      ...summary,
      flowId: null,
      flowNameSnapshot: "Rachit V1",
    });
    expect(orphan.flowId).toBeNull();
    expect(runLabel(orphan)).toBe("Rachit V1");
  });
});

/**
 * `runWorkflowId` mirrors `runLabel`'s fallback chain one identifier over —
 * `flowIdSnapshot` (frozen at `begin`-time) preferred, then the live `flowId`
 * pointer, then `null`. Same reasoning as the name: `flowId` alone goes null
 * the moment the workflow is deleted (`ON DELETE SET NULL`), so a run that
 * already happened must not lose its Workflow ID column value to a later
 * deletion — see spec.md User Story 5.
 */
describe("runWorkflowId — the flow's id AT THE MOMENT this run began", () => {
  it("prefers `flowIdSnapshot` over the live `flowId` when both are present", () => {
    const snapshotted = flowExecutionSummaryFromFA({
      ...summary,
      flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009",
    });
    expect(runWorkflowId(snapshotted)).toBe("9e9e9e9e-0000-4000-8000-000000000009");
    // The live pointer is unaffected — the two fields are independent copies
    // made at `begin`, not one derived from the other.
    expect(snapshotted.flowId).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });

  it("falls back to the live `flowId` when `flowIdSnapshot` is null", () => {
    // Every run before this column existed has no snapshot at all — the
    // Workflow ID column must keep behaving exactly as it did before.
    const preSnapshot = flowExecutionSummaryFromFA({ ...summary, flowIdSnapshot: null });
    expect(runWorkflowId(preSnapshot)).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });

  it("is null when neither the snapshot nor the live id is available", () => {
    // A pre-snapshot run whose flow has SINCE been deleted: there is no way
    // to reconstruct its true historical id, so `null` — never a fabricated
    // value — is the honest answer.
    const orphanPreSnapshot = flowExecutionSummaryFromFA({
      ...summary,
      flowId: null,
      flowIdSnapshot: null,
    });
    expect(runWorkflowId(orphanPreSnapshot)).toBeNull();
  });

  it("survives an orphaned run when a snapshot exists — the whole point of the field", () => {
    const orphanWithSnapshot = flowExecutionSummaryFromFA({
      ...summary,
      flowId: null,
      flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009",
    });
    expect(orphanWithSnapshot.flowId).toBeNull();
    expect(runWorkflowId(orphanWithSnapshot)).toBe("9e9e9e9e-0000-4000-8000-000000000009");
  });
});

/**
 * The fire audit trail's one load-bearing distinction (GAPS §3.3).
 *
 * A fire that started nothing still writes a row. `startedRunId: null` is what
 * says so, and it is the finding the screen exists for — coercing it to anything
 * else, or defaulting it, erases the only evidence that a trigger fired and was
 * refused.
 */
const fire = (over: Partial<FATriggerFire> = {}): FATriggerFire => ({
  id: "fire-1",
  triggerId: "t-1",
  firedBy: "manual",
  firedAt: "2026-06-01T10:00:00.000Z",
  payload: null,
  flowExecutionId: null,
  flowExecutionStatus: null,
  ...over,
});

describe("a trigger fire says whether anything actually started", () => {
  it("reports a fire that started nothing as exactly that", () => {
    expect(triggerFireFromFA(fire()).startedRunId).toBeNull();
  });

  it("links a fire that did start a run to Foundry's execution id", () => {
    // The control: without it, a mapper that returned null unconditionally would
    // score full marks above.
    const linked = triggerFireFromFA(
      fire({ flowExecutionId: "fe-9", flowExecutionStatus: "succeeded" }),
    );
    expect(linked.startedRunId).toBe("fe-9");
    expect(linked.startedRunStatus).toBe("succeeded");
  });

  it("puts the firing mechanism into words a person reads", () => {
    expect(triggerFireFromFA(fire({ firedBy: "webhook" })).how).toBe("by a webhook");
    // An unknown mechanism passes through rather than being mapped to a guess.
    expect(triggerFireFromFA(fire({ firedBy: "quantum" })).how).toBe("quantum");
  });
});

/**
 * A tool created in the UI can authenticate — foundations Phase 1.2, I-124.
 *
 * ── What was measured before this suite existed ──────────────────────────────
 *
 * `toolInputToFA` sent `{name, description, url, method, paramsSchema}` and
 * nothing else, with `method` INFERRED from a three-value type dropdown. So no
 * tool created through the UI carried an auth style, a credential reference or an
 * auth parameter name, and PUT/PATCH/DELETE/HEAD/OPTIONS were unreachable.
 *
 * The compounding part is why the round trip is asserted for all six styles
 * rather than for one: `GET …/secrets/audit` computes `missing` by walking
 * DECLARATIONS, so a workspace whose tools were all created in the UI audited
 * perfectly clean while every tool signed in with nothing. A test that only
 * covered `bearer` would have left three styles able to reach the server in a
 * shape `createToolSchema` refuses — which is a 400 nobody sees the `path` of.
 */
describe("a tool body carries its credential, in every style the server accepts", () => {
  const base = { name: "ticket_create", endpoint: "https://api.example.com/incidents" };

  it("round-trips bearer", () => {
    const { body } = toolInputToFA({
      ...base, method: "POST", authStyle: "bearer", secretEnvName: "TICKETING_TOKEN",
    });
    expect(body).toMatchObject({
      method: "POST", authStyle: "bearer", secretEnvName: "TICKETING_TOKEN",
      // ⚠ Explicitly null, not absent. `authParamName` means nothing to `bearer`,
      // and an omitted key on a PATCH leaves whatever was stored in place — so
      // switching header→bearer would leave a stale header name inside the ref
      // fingerprint, which is a suspension for a field nothing reads.
      authParamName: null,
    });
  });

  it("round-trips header, with the name that carries the value", () => {
    const { body } = toolInputToFA({
      ...base, method: "GET", authStyle: "header",
      secretEnvName: "HR_DIRECTORY_TOKEN", authParamName: "X-API-Key",
    });
    expect(body).toMatchObject({
      authStyle: "header", authParamName: "X-API-Key", secretEnvName: "HR_DIRECTORY_TOKEN",
    });
  });

  it("round-trips query", () => {
    const { body } = toolInputToFA({
      ...base, method: "GET", authStyle: "query",
      secretEnvName: "OPS_KEY", authParamName: "api_key",
    });
    expect(body).toMatchObject({ authStyle: "query", authParamName: "api_key" });
  });

  it("round-trips basic", () => {
    const { body } = toolInputToFA({
      ...base, method: "PUT", authStyle: "basic", secretEnvName: "LEGACY_BASIC",
    });
    expect(body).toMatchObject({ method: "PUT", authStyle: "basic", authParamName: null });
  });

  it("round-trips none, and sends null rather than omitting the fields", () => {
    // The only way a credential can be REMOVED from a tool. `updateToolSchema`
    // declares all three nullable; an omitted key is "leave it alone", so a form
    // that omitted them could add auth and never take it away.
    const { body } = toolInputToFA({ ...base, method: "GET", authStyle: "none" });
    expect(body.authStyle).toBe("none");
    expect(body.secretEnvName).toBeNull();
    expect(body.authParamName).toBeNull();
  });

  it("keeps all seven verbs, which the old type inference could not express", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(toolInputToFA({ ...base, method: m }).body.method).toBe(m);
    }
  });

  it("falls back to the OLD inference only when no method is given", () => {
    // A compatibility shim for non-form callers, not the mechanism. Defaulting to
    // GET instead would turn a "changes data" tool into a read.
    expect(toolInputToFA({ ...base, type: "changes data" }).body.method).toBe("POST");
    expect(toolInputToFA({ ...base, type: "read-only" }).body.method).toBe("GET");
  });

  it("refuses a method the server would not accept, naming the seven", () => {
    expect(() => toolInputToFA({ ...base, method: "TRACE" })).toThrow(/OPTIONS/);
  });

  // ── the two cross-field rules, mirrored from `createToolSchema.superRefine` ──
  //
  // Asserted here as well as in the form because this is the backstop: a future
  // caller that does not render `authFindings` per field still cannot post a
  // body the server will refuse with a 400 whose `path` nothing displays.

  it("refuses an auth style with no credential to present", () => {
    expect(() =>
      toolInputToFA({ ...base, method: "GET", authStyle: "bearer" }),
    ).toThrow(/needs a credential to present/);
  });

  it("refuses header/query with no parameter name", () => {
    expect(() =>
      toolInputToFA({ ...base, method: "GET", authStyle: "header", secretEnvName: "K" }),
    ).toThrow(/Which header/);
    expect(() =>
      toolInputToFA({ ...base, method: "GET", authStyle: "query", secretEnvName: "K" }),
    ).toThrow(/Which query parameter/);
  });

  it("refuses a credential name that is not an env-var identifier", () => {
    // The manifest renders this identifier and the store is keyed on it, so
    // "my key" cannot resolve anywhere.
    expect(() =>
      toolInputToFA({ ...base, method: "GET", authStyle: "bearer", secretEnvName: "my key" }),
    ).toThrow(/env-var NAME/);
  });

  it("reads both credential fields back off a stored tool", () => {
    // The other half: the form cannot warn that changing the auth moves the ref
    // fingerprint if it cannot see what the auth currently is.
    const t = toolFromFA({
      id: "t1", workspaceId: "w1", name: "hr_directory", kind: "real",
      url: "http://ops.example/hr/employees", method: "GET", description: "",
      paramsSchema: null, secretEnvName: "HR_DIRECTORY_TOKEN",
      authStyle: "header", authParamName: "X-API-Key",
      tokenUrl: null, clientIdSecretRef: null, clientSecretSecretRef: null,
      usedBy: 0, isActive: true, createdAt: "", updatedAt: "",
    });
    expect(t.authStyle).toBe("header");
    expect(t.authParamName).toBe("X-API-Key");
    expect(t.secretEnvName).toBe("HR_DIRECTORY_TOKEN");
  });

  it("round-trips oauth2_client_credentials, with the trio and no single secret", () => {
    const { body } = toolInputToFA({
      ...base, method: "GET", authStyle: "oauth2_client_credentials",
      tokenUrl: "https://auth.example.com/oauth2/token",
      clientIdSecretRef: "SWAPI_CLIENT_ID",
      clientSecretSecretRef: "SWAPI_CLIENT_SECRET",
    });
    expect(body).toMatchObject({
      authStyle: "oauth2_client_credentials",
      tokenUrl: "https://auth.example.com/oauth2/token",
      clientIdSecretRef: "SWAPI_CLIENT_ID",
      clientSecretSecretRef: "SWAPI_CLIENT_SECRET",
      // The oauth2 style has no single credential name — the server refuses
      // one — so the body must not carry the stale value of one.
      secretEnvName: null,
      authParamName: null,
    });
  });

  it("clears the trio (nulls, not omission) when a save leaves oauth2", () => {
    // On a PATCH an omitted key leaves the stored value in place, so switching
    // oauth2→bearer must null the trio explicitly or the stale refs sit inside
    // the row for a style that does not read them.
    const { body } = toolInputToFA({
      ...base, method: "GET", authStyle: "bearer", secretEnvName: "SWAPI_CLIENT_ID",
      tokenUrl: "https://auth.example.com/oauth2/token",
      clientIdSecretRef: "SWAPI_CLIENT_ID",
      clientSecretSecretRef: "SWAPI_CLIENT_SECRET",
    });
    expect(body).toMatchObject({
      authStyle: "bearer",
      secretEnvName: "SWAPI_CLIENT_ID",
      tokenUrl: null,
      clientIdSecretRef: null,
      clientSecretSecretRef: null,
    });
  });

  it("refuses an oauth2 body missing any of the trio", () => {
    expect(() =>
      toolInputToFA({
        ...base, method: "GET", authStyle: "oauth2_client_credentials",
        tokenUrl: "https://auth.example.com/oauth2/token",
      }),
    ).toThrow(/holding the client id/);
    expect(() =>
      toolInputToFA({
        ...base, method: "GET", authStyle: "oauth2_client_credentials",
        tokenUrl: "https://auth.example.com/oauth2/token",
        clientIdSecretRef: "A", clientSecretSecretRef: "B",
      }),
    ).not.toThrow();
  });

  it("reads the oauth2 fields back off a stored tool", () => {
    const t = toolFromFA({
      id: "t2", workspaceId: "w1", name: "swapi", kind: "real",
      url: "https://api.swapi.dev/", method: "GET", description: "",
      paramsSchema: null, secretEnvName: null,
      authStyle: "oauth2_client_credentials", authParamName: null,
      tokenUrl: "https://auth.swapi.dev/oauth2/token",
      clientIdSecretRef: "SWAPI_CLIENT_ID",
      clientSecretSecretRef: "SWAPI_CLIENT_SECRET",
      usedBy: 2, isActive: true, createdAt: "", updatedAt: "",
    });
    expect(t.authStyle).toBe("oauth2_client_credentials");
    expect(t.tokenUrl).toBe("https://auth.swapi.dev/oauth2/token");
    expect(t.clientIdSecretRef).toBe("SWAPI_CLIENT_ID");
    expect(t.clientSecretSecretRef).toBe("SWAPI_CLIENT_SECRET");
    expect(t.usedBy).toBe(2);
  });
});

describe("flowFromFA keeps the flow's runtime (2026-10-10)", () => {
  const base = { id: "f", workspaceId: "w", name: "n", description: null, kestraFlowId: "k", draftRevision: 1, armedRevision: null, status: "draft", createdAt: "", updatedAt: "" };
  it("a Pi flow says foundry — or /builder opens it in the compiled builder, which cannot read it", async () => {
    const { flowFromFA } = await import("./adapters");
    expect(flowFromFA({ ...base, runtime: "foundry" } as never).runtime).toBe("foundry");
    expect(flowFromFA({ ...base, runtime: "kestra" } as never).runtime).toBe("kestra");
  });
  it("CONTROL: an unknown or absent runtime is left unknown, never guessed", async () => {
    const { flowFromFA } = await import("./adapters");
    expect(flowFromFA({ ...base } as never).runtime).toBeUndefined();
    expect(flowFromFA({ ...base, runtime: "other" } as never).runtime).toBeUndefined();
  });
});

describe("flowFromFA keeps the schedule the list sends (2026-10-11)", () => {
  const base = { id: "f", workspaceId: "w", name: "n", description: null, kestraFlowId: "k", draftRevision: 1, armedRevision: 1, status: "armed", createdAt: "", updatedAt: "" };
  it("reads `schedule` off the row — it read only the argument, so every list said Not scheduled", async () => {
    const { flowFromFA } = await import("./adapters");
    expect(flowFromFA({ ...base, schedule: "0 7 * * 1" } as never).schedule).toBe("0 7 * * 1");
  });
  it("an explicit argument still wins, and no schedule anywhere is null — the control", async () => {
    const { flowFromFA } = await import("./adapters");
    expect(flowFromFA({ ...base, schedule: "0 7 * * 1" } as never, "0 9 * * *").schedule).toBe("0 9 * * *");
    expect(flowFromFA({ ...base } as never).schedule).toBeNull();
  });
});

describe("a runner run's output checks and its automatic-test label survive the adapters (2026-10-10)", () => {
  it("a step's checks are copied — they are the numbers that say a green-looking step returned empty data", async () => {
    const { stepRunFromFA } = await import("./adapters");
    const checks = [{ output: "employees", field: "hours", rows: 3387, empty: 3387, verdict: "failed" as const }];
    const step = { stepId: "load", status: "failed", output: null, error: "x", logs: [], checks } as never;
    expect(stepRunFromFA(step).checks).toEqual(checks);
    // control: an engine step with no checks carries none, never an empty "passed" list
    expect(stepRunFromFA({ stepId: "load", status: "success", output: null, error: null, logs: [] } as never).checks).toBeUndefined();
  });

  it("an automatic test is labelled, in the summary AND in the history row", () => {
    expect(flowExecutionSummaryFromFA({ ...summary, autoTest: true }).autoTest).toBe(true);
    expect(runFromFlowExecution(flowExecutionSummaryFromFA({ ...summary, autoTest: true }), "n").autoTest).toBe(true);
    // control: a person's run is not
    expect(flowExecutionSummaryFromFA(summary).autoTest).toBe(false);
  });
});
