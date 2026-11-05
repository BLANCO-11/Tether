/**
 * What Foundry needs to know about a piece, in Foundry's own shapes.
 *
 * Each action becomes a would-be tool: its parameters in Foundry's FLAT paramsSchema
 * (`{name: {type, required, description}}` — never a JSON-Schema envelope, I-39), whether it writes, whether
 * repeating it is safe, and what in it this connector cannot serve. A listed value set is written into the
 * description as "One of: a, b, c", the convention Foundry's builder already reads (`declaredValues`).
 */

const TYPE = {
  SHORT_TEXT: "string",
  LONG_TEXT: "string",
  DATE_TIME: "string",
  COLOR: "string",
  STATIC_DROPDOWN: "string",
  DROPDOWN: "string",
  NUMBER: "number",
  CHECKBOX: "boolean",
  ARRAY: "array",
  MULTI_SELECT_DROPDOWN: "array",
  STATIC_MULTI_SELECT_DROPDOWN: "array",
  OBJECT: "object",
  JSON: "object",
  FILE: "file",
};
const DISPLAY_ONLY = new Set(["MARKDOWN"]);
const NON_WRITING = new Set(["READ", "SEARCH"]);
/** Prop types whose shape is decided at run time by code we do not run (or a UI we do not have). */
const UNSERVED = new Set(["DYNAMIC", "CUSTOM"]);

export function describePiece(piece, { name, version, integrity, license }) {
  const auths = piece.auth == null ? [] : Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  return {
    name,
    version,
    integrity,
    license,
    displayName: piece.displayName,
    description: piece.description ?? "",
    logoUrl: piece.logoUrl,
    categories: piece.categories ?? [],
    auth: auths.map(describeAuth),
    actions: Object.values(piece.actions()).map(describeAction),
    triggers: Object.keys(piece.triggers?.() ?? {}).length,
  };
}

/**
 * Every auth kind as one list of FIELDS, so a connection form is generated the same way for all of them: a key is one
 * field (`secret_text`), a username/password is two, a custom auth lists its own. `checks` says whether the piece
 * itself can test a connection (its `validate`), so a form never promises a test the piece cannot run.
 */
function describeAuth(a) {
  // An OAuth sign-in has no `validate`, but most pieces say who it signed in as (`getConnectionIdentifier`): a call to
  // the service with the token, which is a check of the token.
  const checks = typeof a.validate === "function" || (a.type === "OAUTH2" && typeof a.getConnectionIdentifier === "function");
  const out = { type: a.type, displayName: a.displayName ?? null, description: a.description ?? "", required: a.required !== false, checks };
  if (a.type === "SECRET_TEXT") {
    out.fields = [{ name: "secret_text", type: "SECRET_TEXT", required: true, secret: true, description: a.description ?? a.displayName ?? "The key", label: a.displayName ?? "Key" }];
  } else if (a.type === "BASIC_AUTH") {
    out.fields = [
      { name: "username", type: "SHORT_TEXT", required: true, secret: false, description: a.username?.description ?? "", label: a.username?.displayName ?? "Username" },
      { name: "password", type: "SECRET_TEXT", required: true, secret: true, description: a.password?.description ?? "", label: a.password?.displayName ?? "Password" },
    ];
  } else if (a.type === "CUSTOM_AUTH" || a.type === "OAUTH2" || a.type === "OIDC") {
    out.fields = Object.entries(a.props ?? {}).map(([n, p]) => ({
      name: n,
      type: p.type,
      required: !!p.required,
      secret: p.type === "SECRET_TEXT",
      description: p.description ?? p.displayName ?? "",
      label: p.displayName ?? n,
      ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
      ...(Array.isArray(p.options?.options) ? { options: p.options.options.map((o) => ({ label: String(o.label ?? o.value), value: o.value })) } : {}),
    }));
  }
  if (a.type === "OAUTH2") {
    out.oauth = {
      authUrl: a.authUrl ?? null,
      tokenUrl: a.tokenUrl ?? null,
      scope: a.scope ?? [],
      grantType: a.grantType ?? null,
      pkce: a.pkce === true,
      pkceMethod: a.pkceMethod === "S256" ? "S256" : a.pkce === true ? "plain" : null,
      // How the client proves itself at the token address: HTTP basic (HEADER) or in the form (BODY, the default).
      authorizationMethod: a.authorizationMethod === "HEADER" ? "HEADER" : "BODY",
      extra: a.extra && typeof a.extra === "object" ? Object.fromEntries(Object.entries(a.extra).map(([k, v]) => [k, String(v)])) : {},
      prompt: typeof a.prompt === "string" ? a.prompt : null,
    };
  }
  return out;
}

export function describeAction(action) {
  const params = {};
  const unsupported = [];
  for (const [n, p] of Object.entries(action.props ?? {})) {
    if (DISPLAY_ONLY.has(p.type)) continue;
    if (UNSERVED.has(p.type)) unsupported.push(`input "${n}" is a ${p.type} property`);
    params[n] = {
      type: TYPE[p.type] ?? "object",
      required: !!p.required,
      description: paramDescription(p),
    };
  }
  const classification = action.classification ?? action.aiMetadata?.classification ?? null;
  return {
    name: action.name,
    displayName: action.displayName,
    description: action.aiMetadata?.description ?? action.description ?? "",
    // READ | SEARCH | WRITE | DESTRUCTIVE (measured on S3, ServiceNow, Teams). Only the first two leave the outside
    // world as it was; anything else — including undeclared or a value added later — is a write (fail closed).
    classification,
    writes: !NON_WRITING.has(classification),
    destructive: classification === "DESTRUCTIVE",
    classificationDeclared: classification != null,
    idempotent: action.aiMetadata?.idempotent ?? null,
    requireAuth: action.requireAuth !== false,
    hasOutputSchema: !!action.outputSchema,
    outputSchema: action.outputSchema ?? null,
    params,
    unsupported,
  };
}

function paramDescription(p) {
  const parts = [p.description || p.displayName || ""];
  const listed = p.options?.options;
  if ((p.type === "STATIC_DROPDOWN" || p.type === "STATIC_MULTI_SELECT_DROPDOWN") && Array.isArray(listed) && listed.length) {
    parts.push(`One of: ${listed.map((o) => String(o.value)).join(", ")}.`);
  }
  if (p.type === "DROPDOWN" || p.type === "MULTI_SELECT_DROPDOWN") parts.push("A value from a list the service provides (an id).");
  if (p.type === "FILE") parts.push("A file: {name, base64}.");
  if (p.type === "DATE_TIME") parts.push("An ISO 8601 date-time.");
  if (p.defaultValue !== undefined) parts.push(`Default: ${JSON.stringify(p.defaultValue)}.`);
  return parts.filter(Boolean).join(" ");
}
