/**
 * "Test this connection": the piece's OWN check (its auth declaration's `validate`), run in a worker like any action.
 *
 * The argument follows the framework's convention, measured on the installed pieces: a custom auth is validated as its
 * fields object, a key as the bare string, a username/password as {username, password}, OAuth as the whole value.
 * A piece with no `validate` is answered `checked: false` — never "valid": nothing was tried.
 */
import { connectionValue } from "./context.mjs";
import { RunError } from "./run.mjs";

const VALIDATE_TIMEOUT_MS = Number(process.env.CONNECTOR_VALIDATE_TIMEOUT_MS ?? 30_000);

export async function validateConnection(piece, { authType, auth }) {
  const auths = piece.auth == null ? [] : Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  const decl = authType ? auths.find((a) => a.type === authType) : auths[0];
  if (!decl) throw new RunError("validation", `this connector takes no ${authType ?? ""} connection`.replace("  ", " "));
  const value = connectionValue(decl, auth ?? {});
  if (typeof decl.validate !== "function") {
    if (decl.type === "OAUTH2" && typeof decl.getConnectionIdentifier === "function") return whoAmI(decl, value);
    return { checked: false };
  }
  const arg = decl.type === "CUSTOM_AUTH" ? value.props : decl.type === "SECRET_TEXT" ? value.secret_text : decl.type === "BASIC_AUTH" ? { username: value.username, password: value.password } : value;
  let timer;
  try {
    const r = await Promise.race([
      decl.validate({ auth: arg, server: { apiUrl: "", publicUrl: "", token: "" } }),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new RunError("timeout", `the check took longer than ${VALIDATE_TIMEOUT_MS} ms`)), VALIDATE_TIMEOUT_MS))),
    ]);
    return { checked: true, valid: r?.valid === true, error: r?.valid === true ? null : String(r?.error ?? "the service did not accept this connection") };
  } catch (e) {
    if (e instanceof RunError) throw e;
    return { checked: true, valid: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An OAuth sign-in, checked by asking the service who the token belongs to. ⚠ An EMPTY answer is a refusal: pieces
 * catch their own failure and return nothing (GitHub's does exactly that on a 401), so "no identity" is the only sign a
 * revoked token gives here — treating it as accepted would show a dead connection as Connected.
 */
async function whoAmI(decl, value) {
  let timer;
  try {
    const id = await Promise.race([
      decl.getConnectionIdentifier({ auth: value, server: { apiUrl: "", publicUrl: "", token: "" } }),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new RunError("timeout", `the check took longer than ${VALIDATE_TIMEOUT_MS} ms`)), VALIDATE_TIMEOUT_MS))),
    ]);
    if (id == null || String(id).trim() === "") return { checked: true, valid: false, error: "the service did not say who this sign-in belongs to (the token was refused or has no access)" };
    return { checked: true, valid: true, error: null, identity: String(id).slice(0, 200) };
  } catch (e) {
    if (e instanceof RunError) throw e;
    const status = e?.response?.status ?? e?.status;
    return { checked: true, valid: false, error: [status && `HTTP ${status}`, e?.message ?? String(e)].filter(Boolean).join(" — ") };
  }
}
