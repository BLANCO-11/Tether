import { test } from "node:test";
import assert from "node:assert/strict";
import { mintProxyAuth, verifyProxyAuth, normalisePattern, hostAllowed } from "../src/egress-token.mjs";
import { isReserved } from "../src/egress.mjs";
import { connectionHosts, suggestHosts } from "../src/hosts.mjs";

const SECRET = "s".repeat(32);
const header = ({ user, pass }) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

test("proxy credentials round-trip: run id and normalised hosts", () => {
  const got = verifyProxyAuth(SECRET, header(mintProxyAuth(SECRET, { runId: "r1", hosts: ["API.example.com", "https://s3:8333/x", "not a host"] })));
  assert.deepEqual(got, { runId: "r1", hosts: ["api.example.com", "s3:8333"] });
});

test("forged, altered, wrong-secret, expired and absent credentials are refused", () => {
  const good = mintProxyAuth(SECRET, { runId: "r1", hosts: ["a.example.com"] });
  assert.ok(verifyProxyAuth(SECRET, header(good)), "control: the genuine credential passes");
  // A run that widens its own allowlist: new user, old signature.
  const widened = Buffer.from(JSON.stringify({ r: "r1", h: ["a.example.com", "postgres:5432"], e: Date.now() + 60_000 })).toString("base64url");
  assert.equal(verifyProxyAuth(SECRET, header({ user: widened, pass: good.pass })), null);
  assert.equal(verifyProxyAuth("t".repeat(32), header(good)), null);
  assert.equal(verifyProxyAuth(SECRET, header(mintProxyAuth(SECRET, { runId: "r1", hosts: ["a.example.com"], ttlMs: -1 }))), null);
  assert.equal(verifyProxyAuth(SECRET, undefined), null);
  assert.equal(verifyProxyAuth(SECRET, "Bearer x"), null);
  assert.equal(verifyProxyAuth(SECRET, "Basic !!!"), null);
  assert.equal(verifyProxyAuth("", header(good)), null);
});

test("patterns: a bare host is 80/443 only, a port is that port only, a wildcard is subdomains only", () => {
  assert.ok(hostAllowed(["api.example.com"], "api.example.com", 443));
  assert.ok(hostAllowed(["api.example.com"], "API.example.com", 80));
  assert.ok(!hostAllowed(["api.example.com"], "api.example.com", 8443));
  assert.ok(!hostAllowed(["api.example.com"], "other.example.com", 443));
  assert.ok(hostAllowed(["s3:8333"], "s3", 8333));
  assert.ok(!hostAllowed(["s3:8333"], "s3", 443));
  assert.ok(hostAllowed(["*.example.com"], "a.b.example.com", 443));
  assert.ok(!hostAllowed(["*.example.com"], "example.com", 443));
  assert.ok(!hostAllowed(["*.example.com"], "evilexample.com", 443));
  assert.ok(!hostAllowed([], "api.example.com", 443));
});

test("normalisePattern keeps host[:port] and wildcards, drops anything else", () => {
  assert.equal(normalisePattern("https://Api.Example.com/path?q"), "api.example.com");
  assert.equal(normalisePattern("*.example.com"), "*.example.com");
  assert.equal(normalisePattern("s3:8333"), "s3:8333");
  for (const bad of ["", "a b", "*", "*.*", "example.com:", "user@example.com", null]) assert.equal(normalisePattern(bad), "", String(bad));
});

test("reserved addresses: private, loopback, metadata, CGNAT, ULA, link-local, v4-mapped — and public ones are not", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
    assert.ok(isReserved(ip), ip);
  }
  for (const ip of ["1.1.1.1", "140.82.112.3", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) {
    assert.ok(!isReserved(ip), ip);
  }
});

test("connectionHosts: URL values and host-like fields; non-default ports kept; secrets ignored", () => {
  assert.deepEqual(
    connectionHosts({ instanceUrl: "https://dev1.service-now.com/", endpoint: "http://s3:8333", username: "admin", password: "https://not.a.host.because.password", region: "us-east-1", host: "db.example.org" }).sort(),
    ["db.example.org", "dev1.service-now.com", "s3:8333"].sort(),
  );
  assert.deepEqual(connectionHosts({ token: "https://x.example.com", apiKey: "https://y.example.com", host: "" }), []);
  assert.deepEqual(connectionHosts(undefined), []);
});

test("suggestHosts drops the bundled framework's hosts and keeps the service's own", () => {
  const src = `fetch("https://api.github.com/repos"); x = "https://api.x.ai/v1"; y='https://json-schema.org/draft'; z="https://uploads.github.com"`;
  assert.deepEqual(suggestHosts(src), ["api.github.com", "uploads.github.com"]);
});

import { recordRefusal, refusalsFor } from "../src/egress.mjs";

test("refusals are kept per run, deduplicated, and never mixed between runs", () => {
  recordRefusal("run-a:1", "graph.microsoft.com", 443, "not allowed");
  recordRefusal("run-a:1", "graph.microsoft.com", 443, "not allowed");
  recordRefusal("run-a:1", "postgres", 5432, "private");
  recordRefusal("run-b:2", "example.org", 443, "not allowed");
  assert.deepEqual(refusalsFor("run-a:1").map((r) => `${r.host}:${r.port}`), ["graph.microsoft.com:443", "postgres:5432"]);
  assert.deepEqual(refusalsFor("run-b:2").map((r) => r.host), ["example.org"]);
  assert.deepEqual(refusalsFor("run-c:3"), []);
  recordRefusal(undefined, "x", 1, "no run");
  assert.deepEqual(refusalsFor("undefined"), []);
});
