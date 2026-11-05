/**
 * Paste-a-curl — foundations Phase 1.7, D-118.
 *
 * ── The two properties worth testing, and neither is "it parses a URL" ───────
 *
 *  1. **The credential value never reaches `params`.** A credential that arrives
 *     as `?api_key=…` is syntactically indistinguishable from a real parameter,
 *     and `paramsSchema` is rendered into the workspace manifest, which is fed
 *     verbatim to a model. So the interesting assertion is an ABSENCE, in every
 *     place the value could have leaked to: the parameter list, and the stored
 *     URL.
 *
 *  2. **It never silently produces a partial tool.** A paste it cannot fully read
 *     yields what it read PLUS a named list of what it did not. The failure this
 *     guards against is `assembleConnectionString` emitting
 *     `s3://host:5432/bucket` — a plausible-looking value for something that
 *     cannot work, which is why `lib/connectors.test.ts` has a fourth assertion.
 *     Every "cannot read" case below therefore asserts the ENTRY, not just that
 *     the field came back empty.
 */
import { describe, expect, it } from "vitest";
import { parseCurl, tokenize } from "./curl-parse";

describe("tokenize", () => {
  it("keeps a quoted header together", () => {
    // The whitespace split is the obvious version and loses the header on the
    // first real paste.
    expect(tokenize(`curl -H 'Authorization: Bearer abc' https://x.example/y`)).toEqual([
      "curl",
      "-H",
      "Authorization: Bearer abc",
      "https://x.example/y",
    ]);
  });

  it("joins backslash-newline continuations", () => {
    expect(tokenize("curl \\\n  -X POST \\\n  https://x.example/y")).toEqual([
      "curl", "-X", "POST", "https://x.example/y",
    ]);
  });

  it("leaves a backslash alone inside single quotes", () => {
    // JSON bodies are pasted in single quotes, where a shell does not process
    // escapes. Processing them here would corrupt `{"re":"\\d+"}`.
    expect(tokenize(`-d '{"re":"\\d+"}'`)).toEqual(["-d", '{"re":"\\d+"}']);
  });

  it("keeps an empty quoted argument rather than dropping it", () => {
    expect(tokenize(`-d ''`)).toEqual(["-d", ""]);
  });
});

describe("the auth style falls out of the paste", () => {
  it("reads a bearer token and strips its value", () => {
    const r = parseCurl(`curl https://api.example.com/tickets -H "Authorization: Bearer sk-live-123"`);
    expect(r.authStyle).toBe("bearer");
    expect(r.authParamName).toBeNull();
    expect(r.credential?.value).toBe("sk-live-123");
    expect(r.credential?.suggestedEnvName).toBe("EXAMPLE_TOKEN");
    // The value is lifted OUT: nothing in the tool draft carries it.
    expect(JSON.stringify(r.params)).not.toContain("sk-live-123");
    expect(r.url).not.toContain("sk-live-123");
    expect(r.unread).toEqual([]);
  });

  it("reads a custom credential header as `header` plus the header's name", () => {
    const r = parseCurl(`curl https://ops.example/hr/employees -H 'X-API-Key: hr-tok-9'`);
    expect(r.authStyle).toBe("header");
    expect(r.authParamName).toBe("X-API-Key");
    expect(r.credential?.value).toBe("hr-tok-9");
  });

  it("reads a query credential, removes it from the URL, and keeps the real parameters", () => {
    // The case that makes stripping a rule rather than an obvious property.
    const r = parseCurl(`curl 'https://api.example.com/search?api_key=secret9&q=laptop&page=2'`);
    expect(r.authStyle).toBe("query");
    expect(r.authParamName).toBe("api_key");
    expect(r.credential?.value).toBe("secret9");
    expect(r.params.map((p) => p.name)).toEqual(["q", "page"]);
    expect(r.url).toBe("https://api.example.com/search");
    expect(JSON.stringify(r)).toContain("secret9"); // only on `credential`…
    expect(JSON.stringify(r.params)).not.toContain("secret9"); // …and never here
    expect(r.url).not.toContain("api_key");
  });

  it("reads `-u user:pass` as basic and stores the PAIR", () => {
    // `applyAuth`'s basic branch base64-encodes what it is given, so the stored
    // value is the raw pair. Storing the encoded form double-encodes it.
    const r = parseCurl(`curl -u svc_reports:hunter2 https://legacy.example/report`);
    expect(r.authStyle).toBe("basic");
    expect(r.credential?.value).toBe("svc_reports:hunter2");
  });

  it("decodes an `Authorization: Basic` header back to the pair", () => {
    const b64 = Buffer.from("svc:pw", "utf8").toString("base64");
    const r = parseCurl(`curl https://legacy.example/report -H "Authorization: Basic ${b64}"`);
    expect(r.authStyle).toBe("basic");
    expect(r.credential?.value).toBe("svc:pw");
  });

  it("⚠ refuses to guess a Basic value it cannot decode, and NAMES the gap", () => {
    // The alternative — storing the undecodable string — is a 401 that reads
    // exactly like a wrong password.
    const r = parseCurl(`curl https://legacy.example/r -H "Authorization: Basic ####"`);
    expect(r.authStyle).toBe("basic");
    expect(r.credential).toBeNull();
    expect(r.unread.join(" ")).toMatch(/did not decode to/);
  });

  it("treats an unknown Authorization scheme as a named header, value and all", () => {
    // `Authorization: token abc` (GitHub) and `SSWS abc` (Okta) are real. The
    // scheme word is part of the credential, and `header` expresses that exactly.
    const r = parseCurl(`curl https://api.example.com/u -H "Authorization: token gh-1"`);
    expect(r.authStyle).toBe("header");
    expect(r.authParamName).toBe("Authorization");
    expect(r.credential?.value).toBe("token gh-1");
  });

  it("names a SECOND credential rather than dropping it", () => {
    const r = parseCurl(
      `curl https://api.example.com/x -H "Authorization: Bearer a" -H "X-API-Key: b"`,
    );
    expect(r.authStyle).toBe("bearer");
    expect(r.unread.join(" ")).toMatch(/second credential/);
    expect(r.unread.join(" ")).toContain("X-API-Key");
  });

  it("finds no credential in a paste that has none, and says nothing about one", () => {
    const r = parseCurl(`curl https://api.example.com/public`);
    expect(r.authStyle).toBeNull();
    expect(r.credential).toBeNull();
    expect(r.unread).toEqual([]);
  });
});

describe("the method is read, never inferred from what the tool 'is'", () => {
  it("honours -X for the verbs the old type dropdown could not express", () => {
    for (const m of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(parseCurl(`curl -X ${m} https://x.example/y`).method).toBe(m);
    }
  });

  it("defaults to POST when there is a body and GET when there is not", () => {
    expect(parseCurl(`curl https://x.example/y -d '{"a":1}'`).method).toBe("POST");
    expect(parseCurl(`curl https://x.example/y`).method).toBe("GET");
  });

  it("honours -G, which forces GET even with data", () => {
    expect(parseCurl(`curl -G https://x.example/y -d 'q=1'`).method).toBe("GET");
  });

  it("names a verb Foundry cannot call rather than falling back to GET", () => {
    const r = parseCurl(`curl -X TRACE https://x.example/y`);
    expect(r.method).toBeNull();
    expect(r.unread.join(" ")).toMatch(/is not one of GET, POST/);
  });
});

describe("parameters come from the body and the query string", () => {
  it("types a JSON body's fields", () => {
    const r = parseCurl(
      `curl -X POST https://api.example.com/incidents -d '{"title":"x","priority":2,"ratio":0.5,"urgent":true,"tags":["a"]}'`,
    );
    expect(r.params).toEqual([
      { name: "title", dataType: "string", required: true, description: "" },
      { name: "priority", dataType: "integer", required: true, description: "" },
      { name: "ratio", dataType: "float", required: true, description: "" },
      { name: "urgent", dataType: "boolean", required: true, description: "" },
      { name: "tags", dataType: "array", required: true, description: "" },
    ]);
  });

  it("⚠ names a nested object instead of widening it to a string", () => {
    // A widened type declares a shape the endpoint will reject, and it does it
    // silently. The person is told which field and why.
    const r = parseCurl(`curl -X POST https://x.example/y -d '{"who":{"id":1},"note":"hi"}'`);
    expect(r.params.map((p) => p.name)).toEqual(["note"]);
    expect(r.unread.join(" ")).toMatch(/the type of the `who` field/);
  });

  it("reads a form-encoded body", () => {
    const r = parseCurl(`curl -X POST https://x.example/y -d 'name=ada&dept=eng'`);
    expect(r.params.map((p) => p.name)).toEqual(["name", "dept"]);
  });

  it("⚠ names a body it cannot read at all", () => {
    const r = parseCurl(`curl -X POST https://x.example/y -d '<xml><a/></xml>'`);
    expect(r.params).toEqual([]);
    expect(r.unread.join(" ")).toMatch(/neither JSON nor form-encoded/);
  });

  it("collapses a name that appears in both the query and the body", () => {
    // Two rows with one name produce a `paramsSchema` with one key, so the form
    // would show two fields and store one.
    const r = parseCurl(`curl -X POST 'https://x.example/y?id=1' -d '{"id":"2"}'`);
    expect(r.params.map((p) => p.name)).toEqual(["id"]);
  });

  it("does not put a credential-shaped form field in the parameters", () => {
    const r = parseCurl(`curl -X POST https://x.example/y -d 'token=abc&q=1'`);
    expect(r.params.map((p) => p.name)).toEqual(["q"]);
  });
});

describe("⚠ it never silently produces a partial tool", () => {
  it("names the URL when the paste has none", () => {
    const r = parseCurl(`curl -X POST -H "Content-Type: application/json"`);
    expect(r.url).toBeNull();
    expect(r.unread.join(" ")).toMatch(/the endpoint URL — the paste contained no address/);
  });

  it("names the URL when it is not a full http(s) address", () => {
    const r = parseCurl(`curl /api/incidents`);
    expect(r.url).toBeNull();
    expect(r.unread.join(" ")).toMatch(/not a full `http\(s\):\/\/` address/);
  });

  it("names a flag it does not understand instead of ignoring it", () => {
    const r = parseCurl(`curl https://x.example/y --negotiate`);
    expect(r.unread.join(" ")).toContain("--negotiate");
  });

  it("names a multipart body, which a tool cannot express", () => {
    const r = parseCurl(`curl -X POST https://x.example/y -F file=@a.pdf`);
    expect(r.unread.join(" ")).toMatch(/multipart form body/);
  });

  it("names a cookie credential, which is not one of the six styles", () => {
    const r = parseCurl(`curl https://x.example/y -b 'session=abc'`);
    expect(r.authStyle).toBeNull();
    expect(r.unread.join(" ")).toMatch(/cookie credential/);
  });

  it("stays SILENT about flags that change nothing about the tool", () => {
    // The other half of the same rule. Listing `--compressed` as "could not read"
    // trains a person to skip the list, which is where the entry that mattered is.
    const r = parseCurl(`curl -sSL --compressed -o /dev/null https://api.example.com/x`);
    expect(r.unread).toEqual([]);
    expect(r.url).toBe("https://api.example.com/x");
  });

  it("reads a whole realistic paste with no leftovers", () => {
    const r = parseCurl(`curl -X PATCH 'https://api.tickets.example/v2/incidents/42?expand=owner' \\
  -H 'Authorization: Bearer sk-abc' \\
  -H 'Content-Type: application/json' \\
  --compressed \\
  -d '{"status":"resolved","note":"fixed"}'`);
    expect(r.method).toBe("PATCH");
    expect(r.url).toBe("https://api.tickets.example/v2/incidents/42");
    expect(r.authStyle).toBe("bearer");
    expect(r.credential?.value).toBe("sk-abc");
    expect(r.params.map((p) => p.name)).toEqual(["expand", "status", "note"]);
    expect(r.unread).toEqual([]);
    // `Content-Type` is not a parameter and not a credential — it is the one
    // header this product decides for itself, from the method.
    expect(r.params.map((p) => p.name)).not.toContain("Content-Type");
  });
});

describe("bundled short flags", () => {
  it("expands a cluster whose every letter is irrelevant", () => {
    // Found by the test above: `-sSL` was reported as one unrecognised flag, which
    // is the noisiest possible false positive — it fires on most real pastes.
    expect(parseCurl(`curl -fsS https://x.example/y`).unread).toEqual([]);
  });

  it("⚠ names a cluster it cannot account for, and then fails LOUDLY", () => {
    // `-so out.txt` — `-o` takes a value and `-s` does not, so the cluster cannot
    // be expanded without deciding which letter swallowed `out.txt`. What happens
    // instead is the honest failure: the cluster is named, `out.txt` is read as
    // the address, and it is REFUSED for not being an http(s) URL — three entries
    // in `unread` and no tool. The wrong outcome would have been silently storing
    // a tool that calls `out.txt`.
    const r = parseCurl(`curl -so out.txt https://x.example/y`);
    expect(r.url).toBeNull();
    const said = r.unread.join(" ");
    expect(said).toMatch(/bundled flags `-so`/);
    expect(said).toMatch(/not a full `http\(s\):\/\/` address/);
    expect(said).toMatch(/a second URL/);
  });
});
