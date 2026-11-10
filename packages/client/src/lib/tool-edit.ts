// src/lib/tool-edit.ts — a tool's credential, and what editing one costs, as
// pure functions. foundations Phase 1.2, I-124.
//
// ── WHY THESE ARE NOT IN THE COMPONENT ──────────────────────────────────────
//
// Same seam as `lib/secret-edit.ts`, for the same reason: two of these decide
// whether a live automation stops, and jsdom cannot watch a person fill in a
// form. The component reports intents; the rules live somewhere a test can
// reach them, and `toolInputToFA` uses the identical functions as a backstop so
// the form and the body it produces cannot disagree about what is valid.
//
// ⚠ **None of this is the control.** `createToolSchema.superRefine`
// (`services/tool.service.ts`) refuses an auth style with no credential and a
// `header`/`query` style with no parameter name. What lives here is the readable
// half — the same refusal, arriving beside the field instead of as a 400 whose
// `path` nothing renders.
import type { Tool, ToolParam } from "./types";

/**
 * ⚠ A MIRROR of `AUTH_STYLES` in `services/tool.service.ts`, and it says so for
 * the reason `lib/connectors.test.ts`'s `REGISTRABLE` set says so: a client list
 * that runs AHEAD of the server offers a style the server refuses (a dead end
 * shipped), and one that runs BEHIND hides a style that works (something
 * somebody complains about). The first is the failure worth catching, so the
 * mirror is named rather than implied.
 *
 * `oauth2_client_credentials` joined both sides in Phase 7.
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
 * The seven verbs `createToolSchema` accepts.
 *
 * ⚠ This is a real field and must stay one. It used to be INFERRED from the
 * three-value "type" dropdown — `type === "changes data" ? "POST" : "GET"` — so
 * PUT, PATCH, DELETE, HEAD and OPTIONS were unreachable from the UI entirely.
 * Two things key off the stored value: `applyAuth` (a `query`-style credential
 * goes on the URL) and `invokeTool`'s GET/HEAD branch, which decides whether the
 * step's parameters become a query string or a JSON body. An inferred method is
 * therefore not a cosmetic loss — it silently picks where the parameters go.
 */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Verbs `toolFromFA` reads back as "changes data". Kept in step with it. */
const WRITE_METHODS = new Set<string>(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A tool's `type` is DERIVED from its method, on the way in and on the way out.
 *
 * `toolFromFA` computes it from the stored method, so a form that let someone
 * choose "changes data" beside a `GET` offered a value that could not survive a
 * reload — the I-39 shape (a field that saves and shows something else). The
 * type is now shown, not asked for.
 */
export function typeForMethod(method: string): Tool["type"] {
  return WRITE_METHODS.has(method.toUpperCase()) ? "changes data" : "read-only";
}

/** An env-var identifier — the vocabulary for every NAME that resolves into a
    workspace secret. Ours, not the shared package's: the shared list predates
    the Phase 7 styles (merge ruling, D-28) and this file's mirror stays
    self-contained. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ToolAuthDraft = {
  authStyle?: AuthStyle | null;
  secretEnvName?: string | null;
  authParamName?: string | null;
  /** The oauth2_client_credentials trio — tokenUrl plus two secret refs. */
  tokenUrl?: string | null;
  clientIdSecretRef?: string | null;
  clientSecretSecretRef?: string | null;
};

/** One refusal, addressed to the field that has to change to satisfy it. */
export type AuthFinding = {
  field:
    | "secretEnvName"
    | "authParamName"
    | "tokenUrl"
    | "clientIdSecretRef"
    | "clientSecretSecretRef";
  message: string;
};

/**
 * `createToolSchema`'s cross-field rules, in the same order, worded for
 * whoever is looking at the form.
 *
 * ⚠ The `path` on the server's issue is what makes those refusals useful, and a
 * 400 body's `path` is not something this UI renders anywhere. So the finding
 * carries its field: a message that says "authStyle bearer requires a
 * secretEnvName" at the bottom of a modal makes a person re-read the auth
 * dropdown, which is the field that was already right.
 *
 * ⚠ The oauth2 style is its own branch: it reads its credentials from
 * `clientIdSecretRef` + `clientSecretSecretRef` (two env-var names) and a
 * `tokenUrl`, and has NO single `secretEnvName` — the server refuses one for
 * it, so this branch neither demands nor reads `secretEnvName`. The reverse
 * prohibition (the trio on any other style) is NOT mirrored here on purpose:
 * the form only ever sends the trio for the oauth2 style and the payload
 * builder nulls it otherwise, so a finding about it could only fire on stale
 * state the person cannot see — the I-38 shape. The server's `superRefine`
 * remains the backstop for a caller that bypasses the payload builder.
 */
export function authFindings(d: ToolAuthDraft): AuthFinding[] {
  const style = d.authStyle ?? "none";
  const secret = (d.secretEnvName ?? "").trim();
  const param = (d.authParamName ?? "").trim();
  const tokenUrl = (d.tokenUrl ?? "").trim();
  const clientId = (d.clientIdSecretRef ?? "").trim();
  const clientSecret = (d.clientSecretSecretRef ?? "").trim();
  const out: AuthFinding[] = [];

  if (style === "oauth2_client_credentials") {
    if (!tokenUrl) {
      out.push({
        field: "tokenUrl",
        message:
          "Client credentials need somewhere to be exchanged. Give the token endpoint — the " +
          "URL Tether calls with the client id and secret to receive a token.",
      });
    } else if (
      !/^https:\/\//i.test(tokenUrl) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(tokenUrl)
    ) {
      out.push({
        field: "tokenUrl",
        message:
          "The token endpoint must be an https URL — the client credentials cross the wire " +
          "there, so a plain http endpoint is refused (a localhost one excepted, where a " +
          "development server has no wire). That is the address Tether will POST the client " +
          "credentials to.",
      });
    }
    if (!clientId) {
      out.push({
        field: "clientIdSecretRef",
        message:
          "Name the workspace secret holding the client id. Without it Tether has nothing to " +
          "exchange at the token endpoint.",
      });
    } else if (!ENV_NAME_RE.test(clientId)) {
      out.push({
        field: "clientIdSecretRef",
        message:
          "A secret is referenced by its env-var NAME — letters, digits and underscores, " +
          "starting with a letter or underscore. That identifier is what the store is keyed on.",
      });
    }
    if (!clientSecret) {
      out.push({
        field: "clientSecretSecretRef",
        message:
          "Name the workspace secret holding the client secret. Without it Tether has nothing " +
          "to exchange at the token endpoint.",
      });
    } else if (!ENV_NAME_RE.test(clientSecret)) {
      out.push({
        field: "clientSecretSecretRef",
        message:
          "A secret is referenced by its env-var NAME — letters, digits and underscores, " +
          "starting with a letter or underscore. That identifier is what the store is keyed on.",
      });
    }
    return out;
  }

  if (style !== "none" && !secret) {
    out.push({
      field: "secretEnvName",
      message:
        `Presenting a credential "${style}" needs a credential to present. Name the workspace ` +
        `secret this tool reads — without it every call this tool makes signs in with nothing ` +
        `and the endpoint answers 401, at execution, inside a run.`,
    });
  } else if (style !== "none" && !ENV_NAME_RE.test(secret)) {
    out.push({
      field: "secretEnvName",
      message:
        "A credential is referenced by its env-var NAME — letters, digits and underscores, " +
        "starting with a letter or underscore. That one identifier is what the manifest renders " +
        "and what the store is keyed on, so anything else cannot resolve.",
    });
  }

  if ((style === "header" || style === "query") && !param) {
    out.push({
      field: "authParamName",
      message:
        style === "header"
          ? "Which header carries it? `X-API-Key`, `X-Auth-Token` — a header style with no header name has nowhere to put the credential."
          : "Which query parameter carries it? `api_key`, `token` — a query style with no parameter name has nowhere to put the credential.",
    });
  }

  return out;
}

/** True when `authParamName` is a field the chosen style actually uses. */
export function needsAuthParamName(style: AuthStyle | null | undefined): boolean {
  return style === "header" || style === "query";
}

/**
 * ⚠ **`null` and `"none"` mean the same thing to `applyAuth` and DIFFERENT things
 * to `refFingerprints`.** This function is what stops that costing a suspension.
 *
 * `applyAuth` starts `if (!style || style === "none") return;` — so both are "no
 * credential". But the fingerprint payload hashes `t.authStyle ?? null`, so a row
 * holding `null` and a row holding `"none"` fingerprint differently.
 *
 * The form has to show something in the dropdown, and the honest word for a tool
 * with no credential is "none". Emitting that literally would mean **opening a
 * credential-less tool and pressing Save with no edits at all moved its
 * fingerprint and unarmed every flow using it** — precisely the defect I-39 was,
 * arriving by a new road on the same screen.
 *
 * So the STORED value is preserved when the meaning has not changed, and the
 * choice is only written when it actually differs. A caller that stored the
 * literal `"none"` keeps it; a caller that stored `null` keeps that.
 *
 * ⚠ Found by `tools/page.test.tsx`, not by review: the "an edit that changes
 * nothing must not warn" test went red on a description-only save.
 */
export function authStyleToStore(
  chosen: AuthStyle,
  stored: AuthStyle | null | undefined,
): AuthStyle | null {
  if (chosen !== "none") return chosen;
  return stored === "none" ? "none" : null;
}

/**
 * The credential names the form's picker offers: everything stored, plus the one
 * already on the tool.
 *
 * ⚠ The union is what stops the picker LOSING a value. A tool may reference a
 * name with nothing stored under it — that is precisely the state `/keys`'s
 * audit and `applyAuth`'s 424 exist to report — and a select built from stored
 * names alone would render that tool as having no credential and then quietly
 * clear the field on save, which is the I-39 class again.
 *
 * ⚠ And it is a PICKER rather than a text box for a reason that is not
 * convenience: a typo'd env name is a tool that fails 424 naming a credential
 * nobody ever stored, and the whole point of referencing a secret by its env-var
 * name is that the manifest, the prompt and the row cannot disagree about it.
 * Free text stays reachable — a name has to be typeable before it is stored —
 * but it is the second option, not the only one.
 */
export function secretNameOptions(stored: string[], current?: string | null): string[] {
  const set = new Set(stored);
  if (current?.trim()) set.add(current.trim());
  // Sorted so the list does not reorder itself as secrets are added.
  return Array.from(set).sort();
}

/**
 * Is there a VALUE behind this name in this workspace?
 *
 * Presence, never content — `listSecrets` returns `hasValue` and there is
 * deliberately no endpoint that returns a secret's value and no `?reveal=`.
 */
export function hasStoredValue(
  secrets: Array<{ name: string; hasValue: boolean }>,
  envName: string,
): boolean {
  const n = envName.trim();
  return secrets.some((s) => s.name === n && s.hasValue);
}

// ─────────────────────── what an edit is about to unarm ─────────────────────

/**
 * Exactly the fields `manifestBuilderService.refFingerprints()` hashes for a
 * tool, minus the two that cannot move (`kind: "tool"` and the hardcoded
 * `isDummy: false`).
 *
 * ⚠ It is SIX fields, not the two the plan named. `checkpoint.md` 1.2 warns
 * about `authStyle` and `authParamName` because those are what this task adds —
 * but the hash payload is `{method, url, params, isDummy, authStyle,
 * authParamName, secretEnvName}`, and `url` and `params` have been editable in
 * this form since it was written, with no warning of any kind. So the trap this
 * task was told to avoid introducing was already half present: changing a tool's
 * endpoint or renaming one of its parameters has always unarmed every flow
 * approved against it, silently, on a later sweep tick. Warning about only the
 * new two would have been the smaller half of a check that already had a
 * subject.
 */
export type FingerprintFields = {
  method: string | null;
  url: string | null;
  /** The FLAT map, as `paramsToJsonSchema` emits it — never a JSON-Schema envelope. */
  paramsSchema: Record<string, unknown> | null;
  authStyle: AuthStyle | null;
  authParamName: string | null;
  secretEnvName: string | null;
};

/** What moved, in the words the confirmation shows. One label per hashed field. */
const FIELD_LABEL: Record<keyof FingerprintFields, string> = {
  method: "the HTTP method",
  url: "the endpoint URL",
  paramsSchema: "the parameters",
  authStyle: "how the credential is presented",
  authParamName: "the header or query-parameter name",
  secretEnvName: "which credential it presents",
};

/**
 * Key order is not part of the fingerprint, so it must not be part of the
 * comparison either.
 *
 * `refFingerprints` runs the payload through the server's `canonical()` before
 * hashing. A plain `JSON.stringify` here would report a move for a save that
 * reordered two parameters and changed nothing — a warning that fires when
 * nothing happens is how a warning stops being read (I-38, from the other end).
 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`).join(",")}}`;
}

/**
 * Which of the hashed fields this save moves. Empty means the fingerprint holds
 * and nothing will be unarmed.
 */
export function movedFingerprintFields(
  before: FingerprintFields,
  after: FingerprintFields,
): string[] {
  const keys = Object.keys(FIELD_LABEL) as Array<keyof FingerprintFields>;
  return keys
    .filter((k) => stableJson(before[k] ?? null) !== stableJson(after[k] ?? null))
    .map((k) => FIELD_LABEL[k]);
}

/**
 * The sentence shown before the write, or null when the save moves nothing.
 *
 * ⚠ **It names no flow and no count, and that is not an omission.** A named
 * query has `GET …/queries/:name/impact`, and
 * `datasourceQueryService.impact`'s own docblock says why: the list has to be
 * computed from `manifest_refs_json` on the ARMED revision, which no client can
 * see, so "a UI would have to infer the answer from the flow list … and would
 * produce a confidently wrong list". **There is no equivalent route for a tool**
 * (`GET /tools/:id/impact` does not exist), so this text states the consequence
 * and refuses to guess at its size. Filed as I-132.
 *
 * The confirmation exists at all because the consequence is invisible after the
 * fact and is not undone by putting the old value back: the approval is closed
 * by the time the sweep runs, and each flow needs approving again.
 */
export function suspensionWarning(moved: string[]): string | null {
  if (moved.length === 0) return null;
  return (
    `This changes ${moved.join(", ")} — all of which are inside this tool's ref ` +
    `fingerprint. Every automation that was approved against the old shape will be unarmed ` +
    `by the next staleness sweep and its Kestra schedule removed; each one needs approving ` +
    `again. Putting the old value back afterwards does not restore the approval — it is ` +
    `already closed by then. ` +
    `Tether cannot list which automations those are: the answer depends on the manifest refs ` +
    `recorded on each armed revision, which no browser can read. A guessed list would be worse than this sentence.`
  );
}

/** The hashed fields as they stand on a stored tool. */
export function fingerprintFieldsOf(
  t: Pick<Tool, "method" | "endpoint" | "secretEnvName" | "authStyle" | "authParamName"> & {
    params?: ToolParam[];
  },
  paramsSchema: Record<string, unknown> | null,
): FingerprintFields {
  return {
    method: t.method ? String(t.method).toUpperCase() : null,
    url: t.endpoint ?? null,
    paramsSchema,
    authStyle: t.authStyle ?? null,
    authParamName: t.authParamName ?? null,
    secretEnvName: t.secretEnvName ?? null,
  };
}
