import { z } from "zod";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolParamsSchema } from "./param-descriptor.js";
import { isPlatformToolName, PLATFORM_TOOL_NAMES } from "./platform-tool-names.js";
/**
 * The tested marker (tool-probe P3 · T21).
 *
 * ⚠ **From `tool-probe-mark.ts`, NOT from `tool-probe.service.ts`.** T21's own
 * note says there is no cycle because the probe service reads tools through
 * `toolRepo` — true of the rows, false of the schema: it imports
 * `createToolSchema` from THIS module (Decision 3). Importing the marker from the
 * service closed the loop and every draft probe answered `500` while the service's
 * own unit tests stayed green. Measured; see that module's header.
 */
import { dropMark, markFor } from "./tool-probe-mark.js";
import { assertNotConnectionCredential } from "./plugin-credentials.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * WS-B.4 — how a tool's credential is presented. Rendered into the manifest as
 * `<auth style=… name=… env=…/>`; the generation prompt documents each style once
 * so the agent does not have to infer it from the tool description.
 *
 * `oauth2_client_credentials` (Phase 7) is the one style that does not present a
 * stored value directly: it exchanges the client-id/client-secret workspace
 * secrets for a short-lived bearer token at `tokenUrl` and presents THAT as
 * `bearer` (see `resolveOAuth2Bearer` in step-execution.service.ts). It is the
 * only style for which `secretEnvName` is refused — the two secrets are named by
 * `clientIdSecretRef` / `clientSecretSecretRef` instead.
 */
export const AUTH_STYLES = [
  "bearer",
  "header",
  "query",
  "basic",
  "none",
  "oauth2_client_credentials",
] as const;
export type AuthStyle = (typeof AUTH_STYLES)[number];

/**
 * An env-var identifier — the vocabulary for every NAME that resolves into
 * `workspace_secrets` (`secretEnvName` and the OAuth2 client refs). Same shape
 * as `createSecretSchema`'s ENV_NAME in workspace-secret.service.ts; kept as a
 * shared const here so the three tool fields cannot drift apart.
 */
const ENV_NAME = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an env-var identifier (A-Z, 0-9, _)")
  .max(255);

/**
 * OAuth2 token endpoint. HTTPS-only, with a localhost/127.0.0.1 exception for
 * development — the same shape as the repo's datasource-host posture (loopback
 * is where this deployment's own services live; see datasource-target.service.ts
 * I-36), and deliberately stricter than `url`'s bare `http(s)://` check because
 * a token endpoint receives a CLIENT SECRET, which no dev-machine exception
 * other than the explicit two hosts may widen.
 */
const TOKEN_URL = z
  .string()
  .max(2048)
  .refine(
    (u) => {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return false;
      }
      if (parsed.protocol === "https:") return true;
      if (parsed.protocol === "http:") {
        return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      }
      return false;
    },
    "tokenUrl must be https:// (http allowed only for localhost/127.0.0.1 development endpoints)",
  );

/**
 * ⚠ This was `z.record(z.any()).optional()` — a jsonb column with nothing in
 * front of it (**I-125**), so a harness, an import or any API caller could store
 * a JSON-Schema envelope and `manifest-builder` would render two nonsense
 * parameters called `type` and `properties` into the drafter's prompt. The shape
 * is the FLAT `{name: {type, required, description}}` map, and it now says so
 * where it is accepted rather than only in a comment on the reader.
 *
 * It deliberately does not `.default({})`: an absent `paramsSchema` means "this
 * tool takes no parameters", and writing `{}` where the caller sent nothing is
 * one more key inside `refFingerprints()`'s hash payload.
 *
 * `services/param-descriptor.ts` holds the shape, the two type vocabularies and
 * the envelope refusal, shared with `datasource-query.service.ts` so both kinds
 * of callable ref describe a parameter the same way. Read its header before
 * changing either vocabulary — they differ for a measured reason.
 *
 * A descriptor's optional `format` (`month` | `date` | `datetime` | `text`)
 * rides inside this value untouched: create/update write `paramsSchema`
 * verbatim to `tools.params_schema` and `toPublic` echoes it back, so no
 * picking or stripping here — accepting the key in the schema is what persists
 * it, and `refFingerprints()` hashes the column whole, format included.
 */
const paramsSchema = toolParamsSchema;

export const createToolSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "name must be a valid identifier (used in the manifest)"),
    description: z.string().max(10_000).optional(),
    url: z.string().max(2048).optional(),
    method: z.enum(HTTP_METHODS).optional(),
    paramsSchema,
    /**
     * ⚠ **`.nullable()` as well as `.optional()`, and `updateToolSchema` has said
     * so since it was written.** Until task 1.9 these three were `optional()`
     * only, and the asymmetry meant **no tool with `authStyle: "none"` could be
     * created through the UI at all** (I-144). The form sends an explicit `null`
     * for "no credential" — which is the honest encoding, and exactly what
     * `applyAuth` already treats as none (`if (!style || style === "none")
     * return;`) — so create answered 400 with three `Expected string, received
     * null` issues while update accepted the identical payload.
     *
     * ⚠ **`null` must stay meaningful rather than being normalised to `"none"`.**
     * `refFingerprints` hashes `authStyle ?? null`, so `null` and the literal
     * `"none"` hash differently — `lib/tool-edit.ts`'s `authStyleToStore` exists
     * to preserve whichever one a row already holds, because rewriting one to the
     * other moves the fingerprint and the staleness sweep then suspends every
     * armed flow using the tool. Coercing here would defeat that from the far end.
     */
    secretEnvName: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "secretEnvName must be an env-var identifier")
      .max(255)
      .optional()
      .nullable(),
    // WS-B.4 — how to present the credential (rendered as <auth> in the manifest).
    authStyle: z.enum(AUTH_STYLES).optional().nullable(),
    authParamName: z.string().max(128).optional().nullable(),
    /**
     * OAuth2 client-credentials (Phase 7) — the token endpoint and the
     * env-var NAMES of the two workspace secrets holding the client id and
     * client secret. Only valid together with
     * `authStyle: "oauth2_client_credentials"`; the superRefine below enforces
     * the pairing in both directions.
     */
    tokenUrl: TOKEN_URL.optional().nullable(),
    clientIdSecretRef: ENV_NAME.optional().nullable(),
    clientSecretSecretRef: ENV_NAME.optional().nullable(),
    isActive: z.boolean().optional().default(true),
  })
  .superRefine((val, ctx) => {
    refineAuthStyle(val, ctx);
    // Every tool is a real HTTP endpoint. The `isDummy` alternative — a tool whose
    // "response" was a template interpolated by `routes/stubs.ts` — is gone; see the
    // note on `toPublic` below.
    if (!val.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a tool requires a url",
        path: ["url"],
      });
    } else if (!/^https?:\/\//i.test(val.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool url must be http(s)://",
        path: ["url"],
      });
    }
    if (!val.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a tool requires an HTTP method",
        path: ["method"],
      });
    }
  });
/**
 * The credential rules both schemas enforce — one function so create and update
 * cannot disagree (the I-144 asymmetry this file exists to keep shut).
 *
 * ── The oauth2 carve-out ────────────────────────────────────────────────────
 *
 * `oauth2_client_credentials` is the only style that does not read
 * `secretEnvName`: it exchanges the secrets named by `clientIdSecretRef` and
 * `clientSecretSecretRef` at `tokenUrl` for a bearer token. So the old
 * "a style requires secretEnvName" rule skips it, and it in turn refuses
 * `secretEnvName` (a value there would be dead weight — nothing reads it — and
 * a row that has both has one of them by mistake). Every OTHER style refuses
 * the oauth2 trio, so the trio cannot sit on a row whose style does not use it
 * and later be silently ignored by execution.
 */
function refineAuthStyle(
  val: {
    authStyle?: string | null;
    secretEnvName?: string | null;
    authParamName?: string | null;
    tokenUrl?: string | null;
    clientIdSecretRef?: string | null;
    clientSecretSecretRef?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const oauth2 = val.authStyle === "oauth2_client_credentials";
  if (oauth2) {
    if (!val.tokenUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authStyle "oauth2_client_credentials" requires tokenUrl (the token endpoint)',
        path: ["tokenUrl"],
      });
    }
    if (!val.clientIdSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'authStyle "oauth2_client_credentials" requires clientIdSecretRef (the env-var name of the client-id secret)',
        path: ["clientIdSecretRef"],
      });
    }
    if (!val.clientSecretSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'authStyle "oauth2_client_credentials" requires clientSecretSecretRef (the env-var name of the client-secret secret)',
        path: ["clientSecretSecretRef"],
      });
    }
    if (val.secretEnvName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'authStyle "oauth2_client_credentials" reads the client id and secret by their own refs; secretEnvName is not used',
        path: ["secretEnvName"],
      });
    }
  } else {
    // Every other style — including `none` and `null`, which are "no credential".
    for (const field of ["tokenUrl", "clientIdSecretRef", "clientSecretSecretRef"] as const) {
      if (val[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is only valid with authStyle "oauth2_client_credentials"`,
          path: [field],
        });
      }
    }
  }

  // An auth style with no secret to present is a misconfiguration that would
  // otherwise surface as a 401 from inside a container.
  if (val.authStyle && val.authStyle !== "none" && val.authStyle !== "oauth2_client_credentials" && !val.secretEnvName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `authStyle "${val.authStyle}" requires a secretEnvName to read the credential from`,
      path: ["secretEnvName"],
    });
  }
  // `header` and `query` are meaningless without the name to use.
  if ((val.authStyle === "header" || val.authStyle === "query") && !val.authParamName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `authStyle "${val.authStyle}" requires authParamName (the header or query-param name)`,
      path: ["authParamName"],
    });
  }
}

export const updateToolSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    url: z.string().max(2048).optional(),
    method: z.enum(HTTP_METHODS).optional(),
    paramsSchema,
    secretEnvName: z.string().max(255).optional().nullable(),
    authStyle: z.enum(AUTH_STYLES).nullable().optional(),
    authParamName: z.string().max(128).nullable().optional(),
    tokenUrl: TOKEN_URL.optional().nullable(),
    clientIdSecretRef: ENV_NAME.optional().nullable(),
    clientSecretSecretRef: ENV_NAME.optional().nullable(),
    isActive: z.boolean().optional(),
  })
  // The SAME credential rules as create, deliberately. Update has no
  // url/method requirements (a PATCH may move only the credential), but the
  // style↔field pairing rules are properties of the style, not of the verb:
  // a PATCH that sets `authStyle: "oauth2_client_credentials"` must carry the
  // trio, and one that keeps any other style must not. `toolService.update`
  // clears the trio columns when the final style is not oauth2, so a rule
  // enforced only at create would leave the pairing breakable one request later.
  .superRefine(refineAuthStyle);

export type CreateToolInput = z.infer<typeof createToolSchema>;

/**
 * ── DUMMY TOOLS ARE GONE ────────────────────────────────────────────────────
 *
 * A "dummy" tool stored a `dummyResponseTemplate` and pointed at
 * `routes/stubs.ts`, which interpolated `{{body.x}}` / `{{query.x}}` into it. So it
 * returned the same shape whatever you asked: it could not filter, join, paginate,
 * or return a different row count for a different query. An agent handed one learnt
 * nothing about whether its parameters were right — which is the only thing a test
 * call is for.
 *
 * Nothing in the repo ever created one. Every registered tool, including all 14 in
 * the HR dataset, was `isDummy: false` and pointed at an endpoint running real SQL.
 * The capability was dead code with a schema column, a zod branch, a generator
 * endpoint and a public route behind it.
 *
 * `kind` survives as the literal `"real"` rather than being dropped, and that is
 * deliberate — see the note in `manifest-builder.service.ts` about the manifest
 * hash and `refFingerprints`.
 */
function toPublic(t: Tool) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    kind: "real" as const,
    url: t.url,
    method: t.method,
    description: t.description,
    paramsSchema: t.paramsSchema,
    secretEnvName: t.secretEnvName,
    authStyle: t.authStyle,
    authParamName: t.authParamName,
    tokenUrl: t.tokenUrl,
    clientIdSecretRef: t.clientIdSecretRef,
    clientSecretSecretRef: t.clientSecretSecretRef,
    isActive: t.isActive,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function assertWorkspace(workspaceId: string) {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) {
    const err = new Error("workspace not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
}

/**
 * Refuse a write that would create, repoint or delete a PLATFORM-managed tool.
 * email-send-tool T046
 *
 * ── What this protects, and what it deliberately does not ────────────────────
 *
 * The tools page offers **Edit** and **Remove** on every row and `routes/tools.ts`
 * backs both with no exemptions. So `foundry_email_send` could be deleted —
 * breaking every armed flow that references it by name — or repointed at another
 * host, which the executor would then hand `FOUNDRY_MAIL_KEY` to.
 *
 * ⚠ This is **not** a new class of problem and is not solved here: any workspace
 * admin can already repoint any tool and read any secret. That is why the answer
 * is a cheap, greppable name check rather than a permissions redesign. The likely
 * event is accidental deletion of a tool nobody realised was platform-managed, and
 * that is worth refusing.
 *
 * ⚠ `create` is guarded too, so a user cannot pre-empt the name with their own
 * tool — which would otherwise make `mail:register` update THEIR row and point the
 * mail key wherever they chose.
 *
 * The one legitimate writer is `registerPlatformTools`, which passes
 * `{ platform: true }`. That is an explicit, greppable opt-in rather than an
 * ambient flag: `grep -n "platform: true"` finds every caller.
 */
function assertNotPlatformManaged(name: string | null | undefined, action: string) {
  if (!isPlatformToolName(name)) return;
  const err = new Error(
    `"${name}" is a platform-managed tool and cannot be ${action}. Tether registers and ` +
      "maintains it; run `pnpm --filter @foundry/server platform:tools` to restore or refresh it. " +
      `Platform-managed names: ${PLATFORM_TOOL_NAMES.join(", ")}.`,
  ) as Error & { statusCode?: number };
  err.statusCode = 409;
  throw err;
}

/**
 * The fields a probe actually DIALS with (tool-probe P3 · T21).
 *
 * ⚠ Exactly the eight the task names. `name` is absent because renaming a tool
 * does not change the call; `description` because it changes nothing at all;
 * `paramsSchema` because a probe's verdict is about the endpoint and the
 * credential — the sample values a live probe sends are typed into the panel for
 * that one press and are never stored (P2 · T16). ⚠ If a future probe mode starts
 * deriving what it sends from the schema, `paramsSchema` joins this list.
 */
const DIALLED_FIELDS = [
  "url",
  "method",
  "authStyle",
  "authParamName",
  "secretEnvName",
  "tokenUrl",
  "clientIdSecretRef",
  "clientSecretSecretRef",
] as const;

/**
 * ⚠ **Compared BEFORE and AFTER the write, not read off the PATCH body.** A patch
 * that mentions `method: "GET"` on a tool that is already `GET` has moved nothing,
 * and dropping the mark for it would make "tested" disappear on an edit that
 * changed the description. The other direction matters more: `update` derives the
 * OAuth2 trio from the STYLE rather than from the payload (a switch away from
 * oauth2 clears `tokenUrl` and both refs even though the body never named them),
 * so a check against the request body would miss a dial that genuinely moved.
 */
const dialledShape = (t: Tool): string =>
  JSON.stringify(DIALLED_FIELDS.map((f) => (t as Record<string, unknown>)[f] ?? null));

/**
 * A hand-made tool cannot be a connected service's action, nor use one's credential (plugins 8.1): either would let a
 * person who may edit tools reach an account they were never given — the workspace's, or another person's own.
 */
async function assertNotConnectedService(
  workspaceId: string,
  input: { url?: string | null; secretEnvName?: string | null; clientIdSecretRef?: string | null; clientSecretSecretRef?: string | null },
): Promise<void> {
  if (input.url && /^plugin:/i.test(input.url.trim())) {
    throw Object.assign(new Error("a connected service's action is switched on from the service's Apps page, not made by hand"), { statusCode: 403 });
  }
  await assertNotConnectionCredential(workspaceId, [input.secretEnvName, input.clientIdSecretRef, input.clientSecretSecretRef], "cannot be used by a hand-made tool");
}

export const toolService = {
  /**
   * usedBy — distinct flows (across revisions) whose steps reference the tool
   * by name, counted from `flow_steps.manifest_refs_json` (see
   * `toolRepo.usedByIn`). Attached per row from one bulk query; a tool no flow
   * references reads 0, never absent, so a client can render the column
   * without a null branch.
   *
   * lastProbe — the last probe of this tool **in this process** (tool-probe P3).
   *
   * ⚠ **The opposite convention to `usedBy`, deliberately: `null` when there is
   * no marker, never a zero-value stand-in.** `usedBy: 0` is a real count — no
   * flow references the tool. There is no equivalent for "has this been tested":
   * the process genuinely has no record after a restart, and a client has to be
   * able to render NOTHING rather than render a word. T22 makes that the rule.
   */
  async list(workspaceId: string) {
    await assertWorkspace(workspaceId);
    const usedBy = await toolRepo.usedByIn(workspaceId);
    return (await toolRepo.listByWorkspace(workspaceId)).map((t) => ({
      ...toPublic(t),
      usedBy: usedBy[t.name] ?? 0,
      lastProbe: markFor(workspaceId, t.id) ?? null,
    }));
  },

  async get(workspaceId: string, id: string) {
    const t = await toolRepo.get(workspaceId, id);
    if (!t) return undefined;
    const usedBy = await toolRepo.usedByIn(workspaceId);
    return {
      ...toPublic(t),
      usedBy: usedBy[t.name] ?? 0,
      lastProbe: markFor(workspaceId, t.id) ?? null,
    };
  },

  async create(
    workspaceId: string,
    input: CreateToolInput,
    opts: { platform?: boolean } = {},
  ) {
    await assertWorkspace(workspaceId);
    if (!opts.platform) {
      assertNotPlatformManaged(input.name, "created by hand");
      await assertNotConnectedService(workspaceId, input);
    }
    const t = await toolRepo.create({
      workspaceId,
      name: input.name,
      description: input.description ?? null,
      url: input.url!,
      method: input.method ?? "GET",
      paramsSchema: input.paramsSchema ?? null,
      secretEnvName: input.secretEnvName ?? null,
      authStyle: input.authStyle ?? null,
      authParamName: input.authParamName ?? null,
      tokenUrl: input.tokenUrl ?? null,
      clientIdSecretRef: input.clientIdSecretRef ?? null,
      clientSecretSecretRef: input.clientSecretSecretRef ?? null,
      isActive: input.isActive,
    });
    // A freshly created row cannot be referenced by any written revision —
    // unless a deleted tool of the same name left old revisions behind, in
    // which case a subsequent GET reads the real count. Not computed here so a
    // write path does not pay for a read it cannot meaningfully answer.
    return { ...toPublic(t), usedBy: 0 };
  },

  async update(
    workspaceId: string,
    id: string,
    input: z.infer<typeof updateToolSchema>,
    opts: { platform?: boolean } = {},
  ) {
    /**
     * ⚠ Read UNCONDITIONALLY now, where it used to be read only on the
     * non-platform path. Two callers need it: the rename refusal below, and the
     * before/after comparison that decides whether the tested marker survives —
     * and a platform update is precisely one that repoints a URL (`mail:register`),
     * so exempting it from the drop would leave the stalest mark of all.
     */
    const existing = await toolRepo.get(workspaceId, id);
    if (!opts.platform) {
      // Read the TARGET row's name, not the input's — a PATCH that renames the
      // platform tool must be refused just as firmly as one that repoints it.
      assertNotPlatformManaged(existing?.name, "edited");
      assertNotPlatformManaged(input.name, "renamed to");
      if (existing && /^plugin:/i.test(existing.url ?? "")) {
        throw Object.assign(new Error(`"${existing.name}" is a connected service's action; it is switched on, off and connected on the service's Apps page`), { statusCode: 403 });
      }
      await assertNotConnectedService(workspaceId, input);
    }
    const t = await toolRepo.update(workspaceId, id, {
      ...input,
      secretEnvName: input.secretEnvName ?? undefined,
      /**
       * The trio follows the STYLE, not the payload. A PATCH that lands on
       * oauth2 writes them (the schema required them); one that lands anywhere
       * else clears them, so a style switch away from oauth2 cannot leave a
       * dead tokenUrl/refs pair on the row; one that never mentions authStyle
       * leaves them exactly as they are (a rename-only PATCH must not wipe the
       * exchange config).
       */
      ...(input.authStyle === "oauth2_client_credentials"
        ? {
            tokenUrl: input.tokenUrl,
            clientIdSecretRef: input.clientIdSecretRef,
            clientSecretSecretRef: input.clientSecretSecretRef,
          }
        : input.authStyle !== undefined
          ? { tokenUrl: null, clientIdSecretRef: null, clientSecretSecretRef: null }
          : {}),
    });
    if (!t) return undefined;
    /**
     * ⚠ The mark describes a configuration, so it dies with the configuration. A
     * verdict kept across a repointed URL is worse than no verdict: it looks
     * current, and it is the one thing on the row a person would trust.
     */
    if (existing && dialledShape(existing) !== dialledShape(t)) dropMark(workspaceId, id);
    const usedBy = await toolRepo.usedByIn(workspaceId);
    return {
      ...toPublic(t),
      usedBy: usedBy[t.name] ?? 0,
      lastProbe: markFor(workspaceId, t.id) ?? null,
    };
  },

  async remove(workspaceId: string, id: string, opts: { platform?: boolean } = {}) {
    if (!opts.platform) {
      const existing = await toolRepo.get(workspaceId, id);
      assertNotPlatformManaged(existing?.name, "removed");
    }
    /**
     * ⚠ Unconditionally, and BEFORE the delete's own result is known. A tool id is
     * not reused, so dropping a mark for a row that turned out not to exist costs
     * nothing — while leaving one behind would make a recreated tool of the same
     * id (a restored backup, a re-seed) inherit a verdict about a different row.
     */
    dropMark(workspaceId, id);
    return toolRepo.remove(workspaceId, id);
  },
};
