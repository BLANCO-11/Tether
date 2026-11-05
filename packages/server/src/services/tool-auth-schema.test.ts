/**
 * `createToolSchema` and `updateToolSchema` accept the SAME credential payload.
 * Task 1.9 · I-144.
 *
 * ── THE DEFECT, AND HOW IT SURVIVED EVERY GATE ──────────────────────────────
 *
 * Until 1.9, create had `.optional()` on `secretEnvName`/`authStyle`/
 * `authParamName` and update had `.optional().nullable()`. The tools form sends an
 * explicit `null` for "no credential" — `lib/tool-edit.ts`'s `authStyleToStore`
 * returns `null` rather than the literal `"none"` on purpose, because
 * `refFingerprints` hashes `authStyle ?? null` and rewriting one to the other
 * moves the fingerprint and suspends every armed flow using the tool.
 *
 * So **creating a tool with no credential answered 400** with three
 * `Expected string, received null` issues, while editing an existing tool with
 * the identical payload succeeded. Found in a real browser (I-80's walk), and
 * nothing else could have found it:
 *
 *   · `e2e:ui` speaks HTTP and never posts the form's own body
 *   · `ui-honesty-check.sh` greps source
 *   · `tools/page.test.tsx` runs in jsdom against a mocked API, so the client was
 *     verified to BUILD the payload and never to have it accepted
 *
 * That is the "renders but does not submit" class in its purest form: every field
 * appeared, the button enabled, the click did nothing a user could interpret.
 *
 * ── WHY THE TEST IS A COMPARISON, NOT AN ASSERTION ABOUT CREATE ─────────────
 *
 * A test that only pinned `create accepts null` would go green if someone later
 * relaxed update, or tightened create's regex, or added a fourth credential field
 * to one schema and not the other. The property that actually matters is that the
 * two agree about the credential — so the test parses the SAME object with both
 * and requires the same verdict. The fourth-field case is the likely next one:
 * Phase 4's `app` step kind adds credential modes.
 */
import { describe, expect, it } from "vitest";
import { createToolSchema, updateToolSchema } from "./tool.service.js";

/** A minimal valid tool, plus whatever credential shape is under test. */
const base = { name: "walk_tool", url: "https://api.example.com/x", method: "GET" as const };

/** The four credential-field combinations a form can legitimately produce. */
const CASES = [
  {
    what: "no credential at all, sent as explicit nulls (the form's own payload)",
    creds: { authStyle: null, secretEnvName: null, authParamName: null },
  },
  {
    what: "no credential, sent by omission",
    creds: {},
  },
  {
    what: "the literal 'none', which a row may already hold",
    creds: { authStyle: "none" as const, secretEnvName: null, authParamName: null },
  },
  {
    what: "a bearer credential with authParamName null",
    creds: { authStyle: "bearer" as const, secretEnvName: "WALK_KEY", authParamName: null },
  },
  {
    what: "a header credential with a name",
    creds: { authStyle: "header" as const, secretEnvName: "WALK_KEY", authParamName: "X-API-Key" },
  },
  {
    what: "an oauth2 client-credentials exchange with its full trio",
    creds: {
      authStyle: "oauth2_client_credentials" as const,
      secretEnvName: null,
      authParamName: null,
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "OAUTH2_CLIENT_ID",
      clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
    },
  },
];

describe("the create and update schemas agree about credentials (I-144)", () => {
  for (const c of CASES) {
    it(`create accepts ${c.what}`, () => {
      const r = createToolSchema.safeParse({ ...base, ...c.creds });
      expect(
        r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      ).toEqual([]);
    });

    it(`update accepts it identically — ${c.what}`, () => {
      // Update takes the same fields; `name`/`url` are optional there.
      const r = updateToolSchema.safeParse({ ...base, ...c.creds });
      expect(
        r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      ).toEqual([]);
    });
  }

  /**
   * ⚠ THE CONTROL. Every assertion above is "accepts", so all of them would pass
   * against a schema that accepts anything — including one where somebody replaced
   * the credential fields with `z.any()` to make this file green. These two
   * require the schema to still REFUSE the two misconfigurations its `superRefine`
   * exists for, both of which surface as a 401 from inside a container otherwise.
   */
  it("still refuses a style with no credential to present", () => {
    const r = createToolSchema.safeParse({ ...base, authStyle: "bearer", secretEnvName: null });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/requires a secretEnvName/);
    }
  });

  it("still refuses header/query with no parameter name", () => {
    const r = createToolSchema.safeParse({
      ...base,
      authStyle: "query",
      secretEnvName: "WALK_KEY",
      authParamName: null,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/requires authParamName/);
    }
  });

  /**
   * ⚠ `null` must survive parsing as `null`, not be coerced to `"none"` or `""`.
   * `refFingerprints` hashes `authStyle ?? null`, so a coercion here would move
   * the fingerprint of every credential-less tool the first time it was saved —
   * I-39's failure by a new road, and the reason `authStyleToStore` exists.
   */
  it("preserves null rather than normalising it", () => {
    const r = createToolSchema.parse({ ...base, authStyle: null, secretEnvName: null, authParamName: null });
    expect(r.authStyle).toBeNull();
    expect(r.secretEnvName).toBeNull();
    expect(r.authParamName).toBeNull();
  });
});

/**
 * Phase 7 — `oauth2_client_credentials`. The one style that does not read
 * `secretEnvName`: it exchanges the secrets named by `clientIdSecretRef` and
 * `clientSecretSecretRef` at `tokenUrl` for a bearer token. The pairing is
 * enforced in BOTH directions — the style demands the trio, and every other
 * style refuses it — so a trio cannot sit on a row whose style does not use it
 * and be silently ignored by `applyAuth` at execution.
 */
describe("oauth2_client_credentials — the trio is required and exclusive (Phase 7)", () => {
  const oauth2Base = { ...base, authStyle: "oauth2_client_credentials" as const };

  it("requires all three fields with the style", () => {
    const r = createToolSchema.safeParse(oauth2Base);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(" ");
      expect(msgs).toMatch(/requires tokenUrl/);
      expect(msgs).toMatch(/requires clientIdSecretRef/);
      expect(msgs).toMatch(/requires clientSecretSecretRef/);
    }
  });

  it("requires the trio as a whole — two of three is still refused", () => {
    const r = createToolSchema.safeParse({
      ...oauth2Base,
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "OAUTH2_CLIENT_ID",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/requires clientSecretSecretRef/);
    }
  });

  it("refuses secretEnvName alongside the style — the two client refs replace it", () => {
    const r = createToolSchema.safeParse({
      ...oauth2Base,
      secretEnvName: "OAUTH2_CLIENT_SECRET",
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "OAUTH2_CLIENT_ID",
      clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/secretEnvName is not used/);
    }
  });

  it("refuses the trio on every non-oauth2 style, including none and null", () => {
    for (const style of ["bearer", "none", null]) {
      const creds: Record<string, unknown> = {
        tokenUrl: "https://auth.example.com/token",
        clientIdSecretRef: "OAUTH2_CLIENT_ID",
        clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
        authStyle: style,
        secretEnvName: style === "bearer" ? "WALK_KEY" : null,
      };
      const r = createToolSchema.safeParse({ ...base, ...creds });
      expect(r.success, `style ${String(style)}`).toBe(false);
      if (!r.success) {
        expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(
          /only valid with authStyle "oauth2_client_credentials"/,
        );
      }
    }
  });

  it("accepts https tokenUrl, and http ONLY for localhost/127.0.0.1", () => {
    const trio = {
      clientIdSecretRef: "OAUTH2_CLIENT_ID",
      clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
    };
    for (const tokenUrl of [
      "https://auth.example.com/token",
      "https://auth.example.com:8443/token",
      "http://localhost:8080/token",
      "http://127.0.0.1:8080/token",
    ]) {
      const r = createToolSchema.safeParse({ ...oauth2Base, tokenUrl, ...trio });
      expect(r.success, tokenUrl).toBe(true);
    }
    for (const tokenUrl of [
      "http://auth.example.com/token",
      "ftp://auth.example.com/token",
      "not a url",
    ]) {
      const r = createToolSchema.safeParse({ ...oauth2Base, tokenUrl, ...trio });
      expect(r.success, tokenUrl).toBe(false);
    }
  });

  it("requires the client refs to be env-var identifiers", () => {
    const r = createToolSchema.safeParse({
      ...oauth2Base,
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "not a valid name",
      clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/env-var identifier/);
    }
  });

  it("enforces the pairing on update too — a PATCH cannot smuggle the trio onto a bearer tool", () => {
    const r = updateToolSchema.safeParse({
      authStyle: "bearer",
      secretEnvName: "WALK_KEY",
      tokenUrl: "https://auth.example.com/token",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(
        /only valid with authStyle "oauth2_client_credentials"/,
      );
    }
  });

  it("update refuses an oauth2 style without the trio", () => {
    const r = updateToolSchema.safeParse({ authStyle: "oauth2_client_credentials" });
    expect(r.success).toBe(false);
  });
});
