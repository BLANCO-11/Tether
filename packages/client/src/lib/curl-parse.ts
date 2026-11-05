// src/lib/curl-parse.ts — turn a pasted `curl` command into a tool draft.
// foundations Phase 1.7, D-118.
//
// ── WHY CURL AND NOT OPENAPI ────────────────────────────────────────────────
//
// A curl command is ONE endpoint with real values — method, URL, headers, query,
// body — mapping 1:1 onto `{url, method, params, authStyle, authParamName}`.
// Decisively, **the auth style falls out of the paste**, and that is the single
// hardest field for a person to fill in correctly; it is the field I-124 exists
// about. An OpenAPI import is a picker plus a `$ref` resolver plus a
// `requestBody`-vs-`parameters` mapper plus a `securitySchemes` mapper, and its
// output is still one tool per operation whose description a human has to write
// anyway, because the drafter reads descriptions (I-40).
//
// ── WHY THIS IS CLIENT-SIDE ─────────────────────────────────────────────────
//
// A server route taking a curl string is a route taking a CREDENTIAL in a
// request body that might be logged. `packages/redact` exists because a key sent
// as `?api_key=…` was written verbatim into 2000 rows of `api_call_log` and into
// demo screenshots. Nothing here crosses the wire: the parse happens in the
// browser and the only thing that leaves it is the tool body the person then
// submits, plus — separately and only if they ask — a `POST …/secrets` carrying
// the credential to the one endpoint whose job is to hold one.
//
// ── ⚠ THE RULE THAT SHAPES EVERY DECISION BELOW ─────────────────────────────
//
// **It must never silently produce a partial tool.** Anything this cannot read
// goes into `unread` BY NAME, and the form keeps requiring the field. A parser
// that guesses is `assembleConnectionString` emitting `s3://host:5432/bucket` —
// a plausible string for a target that cannot exist, and the reason
// `lib/connectors.test.ts` has a fourth assertion. So: an unrecognised flag is
// named, a body that is not JSON or form-encoded is named, a nested object
// parameter is named and NOT invented as a string, and a `Basic` header that
// does not decode to `user:pass` is named rather than stored as the wrong value.
import type { DataType, ToolParam } from "./types";
import type { AuthStyle, HttpMethod } from "./tool-edit";
import { HTTP_METHODS } from "./tool-edit";

/**
 * The credential the paste contained, lifted OUT of everything else.
 *
 * ⚠ `value` never reaches `params`, and there is a test for exactly that. A
 * credential that arrives as a query parameter (`?api_key=…`) is the case that
 * makes this a rule rather than an obvious property: it is syntactically
 * indistinguishable from a real parameter, and putting it in `paramsSchema`
 * would render the live key into the workspace manifest, which is fed verbatim
 * to a model.
 */
export type CurlCredential = {
  value: string;
  /** A name to offer, derived from the host and where the credential sat. */
  suggestedEnvName: string;
  /** Where it was found, in words, so the offer to store it is checkable. */
  foundIn: string;
};

export type CurlTool = {
  url: string | null;
  method: HttpMethod | null;
  /**
   * The form's shape, not the manifest's.
   *
   * ⚠ Deliberately `ToolParam[]` and not the flat `{name: {type, required,
   * description}}` record. `paramsToJsonSchema` in `adapters.ts` is the ONE
   * producer of the stored shape (I-39: an envelope renders two nonsense
   * parameters called `type` and `properties`), and a second emitter here would
   * be a second thing to keep in step with the manifest builder.
   */
  params: ToolParam[];
  authStyle: AuthStyle | null;
  authParamName: string | null;
  credential: CurlCredential | null;
  /**
   * What this could NOT read, by name. Never empty because of a shrug: every
   * entry is a specific thing the person now has to supply, and the form keeps
   * requiring it.
   */
  unread: string[];
};

/** Mirrors `packages/redact`'s `SECRET_KEY_RE` — the same question, asked earlier. */
const SECRET_KEY_RE =
  /^(x-)?(api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd|authorization|auth)$/i;

/**
 * Flags that change nothing about the tool: transport, retries, output
 * formatting, TLS verification. Dropped in SILENCE, deliberately — listing
 * `--compressed` as "could not read" trains a person to ignore the list, which
 * is where the one entry that mattered goes unread.
 */
const IGNORED_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-i", "--include", "-v", "--verbose",
  "-L", "--location", "-k", "--insecure", "--compressed", "-f", "--fail",
  "-#", "--progress-bar", "-N", "--no-buffer", "--http1.1", "--http2",
]);

/** Flags that take a value and are irrelevant once consumed. */
const IGNORED_FLAGS_WITH_VALUE = new Set([
  "-o", "--output", "-w", "--write-out", "-A", "--user-agent", "--connect-timeout",
  "-m", "--max-time", "--retry", "-e", "--referer",
]);

/**
 * Split a shell command into tokens, honouring quotes and line continuations.
 *
 * ⚠ A regex split on whitespace is the obvious version and it is wrong on the
 * first real paste: `-H 'Authorization: Bearer abc'` becomes three tokens and
 * the header is lost, or worse, half-read. Backslash-newline is handled because
 * every curl command copied out of documentation has them.
 */
export function tokenize(text: string): string[] {
  const src = text.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      // Only double quotes process escapes, exactly as a shell does. Inside
      // single quotes a backslash is a literal backslash — which matters,
      // because JSON bodies are usually pasted inside single quotes.
      if (quote === '"' && c === "\\" && i + 1 < src.length) {
        cur += src[i + 1];
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** `Bearer abc` → `abc`; anything else → null. */
function bearerValue(headerValue: string): string | null {
  const m = /^bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : null;
}

/**
 * `Basic <base64>` → `user:pass`, or null when it does not decode to a pair.
 *
 * ⚠ The base64 is NOT what gets stored. `applyAuth`'s `basic` branch
 * base64-encodes the stored value itself, so storing the encoded form produces a
 * double-encoded header — a 401 that looks exactly like a wrong password. When
 * the decode does not yield a `user:pass` pair this returns null and the caller
 * puts it in `unread`, because a value that cannot be checked must not be
 * guessed at.
 */
function basicPair(headerValue: string): string | null {
  const m = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(headerValue.trim());
  if (!m) return null;
  try {
    const decoded =
      typeof atob === "function"
        ? atob(m[1])
        : Buffer.from(m[1], "base64").toString("utf8");
    return decoded.includes(":") ? decoded : null;
  } catch {
    return null;
  }
}

/** A name to offer for the secret: `<HOST>_API_KEY`-shaped, always a valid env name. */
function suggestEnvName(url: string | null, hint: string): string {
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {
    host = "";
  }
  const base = (host.split(".").filter((p) => p && p !== "www" && p !== "api")[0] ?? "tool")
    .replace(/[^A-Za-z0-9]/g, "_")
    .toUpperCase();
  const tail = hint.replace(/[^A-Za-z0-9]/g, "_").toUpperCase().replace(/^X_/, "");
  const name = `${base}_${tail || "CREDENTIAL"}`.replace(/_+/g, "_");
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
}

/** JSON value → the closest of the five types the server accepts, or null. */
function dataTypeOf(v: unknown): DataType | null {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  if (Array.isArray(v)) return "array";
  // null and nested objects. `null` carries no type at all, and an object has no
  // representation in `DataType` — both are named in `unread` rather than
  // widened to `string`, which would declare a shape the endpoint will reject.
  return null;
}

export function parseCurl(text: string): CurlTool {
  const unread: string[] = [];
  const tokens = tokenize(text);
  if (tokens.length && /^curl$/i.test(tokens[0])) tokens.shift();

  let url: string | null = null;
  let explicitMethod: string | null = null;
  const headers: Array<[string, string]> = [];
  const bodies: string[] = [];
  let userPair: string | null = null;
  let forceGet = false;
  let multipart = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = () => tokens[i + 1];
    const take = () => {
      i += 1;
      return tokens[i];
    };

    // `--flag=value` is as common in pasted commands as `--flag value`.
    const eq = /^(--[^=]+)=(.*)$/.exec(t);
    const flag = eq ? eq[1] : t;
    const inlineValue = eq ? eq[2] : null;
    const readValue = () => (inlineValue !== null ? inlineValue : take());

    if (!t.startsWith("-")) {
      if (url === null) url = t;
      else unread.push(`a second URL (\`${t}\`) — a tool is one endpoint, so only the first was used`);
      continue;
    }

    if (IGNORED_FLAGS.has(flag)) continue;
    if (IGNORED_FLAGS_WITH_VALUE.has(flag)) {
      if (inlineValue === null && next() !== undefined) take();
      continue;
    }

    // ⚠ A BUNDLED short-flag cluster — `-sSL`, `-fsS`. Extremely common in pasted
    // commands, and a test caught this reporting the whole cluster as one
    // unrecognised flag. It is expanded only when EVERY letter in it is a flag
    // that takes no value and changes nothing about the tool; otherwise the
    // cluster is named, because guessing which letter swallowed the next token is
    // how a URL gets eaten as somebody's `--output` argument.
    if (/^-[A-Za-z#]{2,}$/.test(flag)) {
      const letters = flag.slice(1).split("").map((c) => `-${c}`);
      if (letters.every((l) => IGNORED_FLAGS.has(l))) continue;
      unread.push(
        `the bundled flags \`${flag}\` — Foundry does not know what they would change, and ` +
          "splitting them apart could consume the wrong argument",
      );
      continue;
    }

    switch (flag) {
      case "-X":
      case "--request":
        explicitMethod = readValue();
        break;
      case "--url":
        url = readValue();
        break;
      case "-H":
      case "--header": {
        const raw = readValue() ?? "";
        const idx = raw.indexOf(":");
        if (idx <= 0) {
          unread.push(`the header \`${raw}\` — it has no \`Name: value\` form`);
          break;
        }
        headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        bodies.push(readValue() ?? "");
        break;
      case "--data-urlencode":
        // Deliberately separate: the value may be `name=content` or bare
        // content, and curl percent-encodes it. Treated as a form field when it
        // has a name and named as unread when it does not.
        {
          const raw = readValue() ?? "";
          if (/^[^=]+=/.test(raw)) bodies.push(raw);
          else unread.push("a `--data-urlencode` value with no field name");
        }
        break;
      case "-F":
      case "--form":
        multipart = true;
        if (inlineValue === null && next() !== undefined) take();
        break;
      case "-u":
      case "--user":
        userPair = readValue() ?? "";
        break;
      case "-G":
      case "--get":
        forceGet = true;
        break;
      case "-b":
      case "--cookie":
        unread.push(
          "a cookie credential (`-b`) — Foundry presents a credential as bearer, a header, a " +
            "query parameter or basic auth, and none of those is a cookie jar",
        );
        if (inlineValue === null && next() !== undefined) take();
        break;
      case "-T":
      case "--upload-file":
      case "--cert":
      case "--key":
      case "--cacert":
        unread.push(`\`${flag}\` — a tool has no way to carry a file or a client certificate`);
        if (inlineValue === null && next() !== undefined) take();
        break;
      default:
        unread.push(`the flag \`${flag}\` — Foundry does not know what it would change`);
        break;
    }
  }

  if (multipart) {
    unread.push(
      "a multipart form body (`-F`) — a tool sends its parameters as a query string or a JSON " +
        "body, so these fields have to be re-entered as parameters",
    );
  }

  // ── the credential, before anything else looks at the same data ────────────
  //
  // Order matters: an explicit `Authorization` header beats `-u`, which beats a
  // credential-shaped custom header, which beats one on the query string. Each
  // is checked once and the rest are reported rather than silently dropped —
  // two credentials in one paste is a thing worth saying out loud, because
  // whichever we picked, the other one is missing from the tool.
  let authStyle: AuthStyle | null = null;
  let authParamName: string | null = null;
  let credential: CurlCredential | null = null;
  const otherCredentials: string[] = [];
  /** Header names consumed as the credential, so they are not re-read as anything else. */
  const usedHeaders = new Set<string>();

  const auth = headers.find(([k]) => k.toLowerCase() === "authorization");
  if (auth) {
    const bearer = bearerValue(auth[1]);
    const basic = /^basic\s/i.test(auth[1]) ? basicPair(auth[1]) : null;
    if (bearer) {
      authStyle = "bearer";
      credential = {
        value: bearer,
        suggestedEnvName: suggestEnvName(url, "token"),
        foundIn: "the `Authorization: Bearer …` header",
      };
    } else if (basic) {
      authStyle = "basic";
      credential = {
        value: basic,
        suggestedEnvName: suggestEnvName(url, "basic_auth"),
        foundIn: "the `Authorization: Basic …` header, decoded back to `user:password`",
      };
    } else if (/^basic\s/i.test(auth[1])) {
      // Present, recognised, and NOT stored. `applyAuth` base64-encodes what it
      // is given, so storing the encoded form double-encodes it — a 401 that
      // reads exactly like a wrong password.
      authStyle = "basic";
      unread.push(
        "the value of the `Authorization: Basic …` header — it did not decode to " +
          "`user:password`, and Foundry stores the pair rather than the encoded form, so it " +
          "cannot be lifted out of this paste",
      );
    } else {
      // `Authorization: token abc`, `Authorization: SSWS abc` — a real and
      // common scheme this product expresses exactly, as a named header.
      authStyle = "header";
      authParamName = auth[0];
      credential = {
        value: auth[1],
        suggestedEnvName: suggestEnvName(url, "authorization"),
        foundIn: `the \`${auth[0]}\` header, value included, because the scheme word is part of it`,
      };
    }
    usedHeaders.add(auth[0].toLowerCase());
  }

  if (userPair !== null) {
    if (!authStyle) {
      authStyle = "basic";
      credential = {
        value: userPair,
        suggestedEnvName: suggestEnvName(url, "basic_auth"),
        foundIn: "the `-u user:password` flag",
      };
    } else {
      otherCredentials.push("`-u user:password`");
    }
  }

  for (const [k, v] of headers) {
    if (usedHeaders.has(k.toLowerCase())) continue;
    if (!SECRET_KEY_RE.test(k)) continue;
    if (!authStyle) {
      authStyle = "header";
      authParamName = k;
      credential = {
        value: v,
        suggestedEnvName: suggestEnvName(url, k),
        foundIn: `the \`${k}\` header`,
      };
      usedHeaders.add(k.toLowerCase());
    } else {
      otherCredentials.push(`the \`${k}\` header`);
    }
  }

  // ── the URL's query string: parameters, minus any credential in it ─────────
  const params: ToolParam[] = [];
  let cleanUrl = url;
  if (url) {
    try {
      const u = new URL(url);
      const keys = Array.from(new Set(Array.from(u.searchParams.keys())));
      for (const key of keys) {
        if (SECRET_KEY_RE.test(key)) {
          if (!authStyle) {
            authStyle = "query";
            authParamName = key;
            credential = {
              value: u.searchParams.get(key) ?? "",
              suggestedEnvName: suggestEnvName(url, key),
              foundIn: `the \`${key}\` query parameter`,
            };
          } else {
            otherCredentials.push(`the \`${key}\` query parameter`);
          }
          // ⚠ Removed from the URL either way. A credential left on a stored
          // tool's URL is a credential in the workspace manifest, in the
          // generation prompt and in `api_call_log`'s `query` column — the
          // literal bug `redactSecrets` was written for.
          u.searchParams.delete(key);
          continue;
        }
        params.push({
          name: key,
          // A query string carries no types. `string` is the server's own
          // default for a descriptor and the only honest reading of `?page=2`,
          // which is as likely to be a string as a number.
          dataType: "string",
          required: true,
          description: "",
        });
      }
      // The path stays; the query goes. `invokeTool` builds the query string
      // from the step's parameters, so a stored `?` would be there twice.
      u.search = "";
      cleanUrl = u.toString();
    } catch {
      unread.push(
        `the endpoint URL — \`${url}\` is not a full \`http(s)://\` address, and that is what ` +
          "Foundry calls",
      );
      cleanUrl = null;
    }
  } else {
    unread.push("the endpoint URL — the paste contained no address");
  }

  // ── the body: parameters ──────────────────────────────────────────────────
  const body = bodies.join("&");
  if (body) {
    const parsed = safeJsonObject(body);
    if (parsed) {
      for (const [k, v] of Object.entries(parsed)) {
        const t = dataTypeOf(v);
        if (!t) {
          unread.push(
            `the type of the \`${k}\` field — it is ${v === null ? "null" : "a nested object"} in ` +
              "the paste, and a parameter is one of string, integer, float, boolean or array",
          );
          continue;
        }
        params.push({ name: k, dataType: t, required: true, description: "" });
      }
    } else if (isFormEncoded(body)) {
      for (const pair of body.split("&")) {
        const [k] = pair.split("=");
        const key = decodeURIComponent(k);
        if (!key) continue;
        if (SECRET_KEY_RE.test(key)) {
          otherCredentials.push(`the \`${key}\` form field`);
          continue;
        }
        params.push({ name: key, dataType: "string", required: true, description: "" });
      }
    } else {
      unread.push(
        "the request body's fields — it is neither JSON nor form-encoded, so the parameters " +
          "have to be entered by hand",
      );
    }
  }

  if (otherCredentials.length > 0) {
    unread.push(
      `a second credential (${otherCredentials.join(", ")}) — a tool presents exactly one, so ` +
        "this call needs splitting or the endpoint changing",
    );
  }

  // ── the method ────────────────────────────────────────────────────────────
  //
  // `-X` wins; then `-G` (which forces GET even with data); then the presence of
  // a body, which is curl's own rule. Never inferred from the tool's "type",
  // which is the inference this task deletes.
  let method: HttpMethod | null = null;
  if (explicitMethod) {
    const up = explicitMethod.toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(up)) method = up as HttpMethod;
    else
      unread.push(
        `the HTTP method — \`${explicitMethod}\` is not one of ${HTTP_METHODS.join(", ")}`,
      );
  } else if (forceGet) method = "GET";
  else if (body) method = "POST";
  else method = "GET";

  return {
    url: cleanUrl,
    method,
    params: dedupeByName(params),
    authStyle,
    authParamName,
    credential,
    unread,
  };
}

/** A top-level JSON OBJECT, or null. An array body has no named fields to map. */
function safeJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `a=1&b=2` — every segment a `key=value` with a non-empty key. */
function isFormEncoded(s: string): boolean {
  return s.split("&").every((p) => /^[^=&]+=[^&]*$/.test(p));
}

/**
 * The same name in the query string and the body is one parameter.
 *
 * First wins, so the query string's reading survives — and the alternative
 * matters: two rows with one name produce a `paramsSchema` with one key, so the
 * form would show two fields and store one.
 */
function dedupeByName(params: ToolParam[]): ToolParam[] {
  const seen = new Set<string>();
  return params.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}
