/**
 * connector-egress — the only way out of `connector-net`. A piece's run reaches a host only if its signed proxy
 * credentials name it (egress-token.mjs), and never a private / internal address — with no exception: there is no
 * setting that opens one (the POC's stand-in allowlist is gone). Same shape as forge-egress, with a per-run allowlist.
 *
 * Two request forms, because pieces use both: CONNECT (Node's fetch and https with NODE_USE_ENV_PROXY) and an
 * absolute-form request (`GET https://host/…`, what axios sends to a proxy). Either way the proxy resolves the host,
 * checks EVERY address, and dials the checked address itself — the address classified is the address dialled.
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { hostAllowed, verifyProxyAuth } from "./egress-token.mjs";

const PORT = Number(process.env.CONNECTOR_EGRESS_PORT ?? 3128);
const SECRET = process.env.CONNECTOR_EGRESS_SECRET ?? "";
const log = (event, detail) => console.log(JSON.stringify({ svc: "connector-egress", event, ...detail }));

/**
 * What was refused, per run, for a few minutes — so the connector can tell the person WHY a call failed. A piece only
 * ever sees "fetch failed" or a 403 it cannot read; the reason lives here. Bounded: oldest runs dropped first.
 */
const REFUSALS_KEEP_MS = 10 * 60_000;
const REFUSALS_MAX_RUNS = 2000;
const refusals = new Map(); // runId → {at, items: [{host, port, why}]}
export function recordRefusal(runId, host, port, why) {
  if (!runId) return;
  const now = Date.now();
  const r = refusals.get(runId) ?? { at: now, items: [] };
  if (r.items.length < 20 && !r.items.some((i) => i.host === host && i.port === port)) r.items.push({ host, port, why });
  refusals.delete(runId);
  refusals.set(runId, r);
  while (refusals.size > REFUSALS_MAX_RUNS) refusals.delete(refusals.keys().next().value);
  for (const [k, v] of refusals) {
    if (now - v.at < REFUSALS_KEEP_MS) break;
    refusals.delete(k);
  }
}
export function refusalsFor(runId) {
  return refusals.get(runId)?.items ?? [];
}
function secretOk(header) {
  const got = Buffer.from(String(header ?? ""));
  const want = Buffer.from(SECRET);
  return SECRET.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

/** Addresses no connector may reach: loopback, private, link-local (cloud metadata), CGNAT, ULA, multicast, unspecified. */
const reserved = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]]) {
  reserved.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) reserved.addSubnet(net, bits, "ipv6");

export function isReserved(ip) {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) return reserved.check(v4mapped[1], "ipv4");
  const fam = isIP(ip);
  return fam === 4 ? reserved.check(ip, "ipv4") : fam === 6 ? reserved.check(ip, "ipv6") : true;
}

/** Resolve and decide. Returns the address to dial, or a reason. */
async function decide(auth, host, port) {
  if (!auth) return { refuse: "no valid run credentials" };
  if (!hostAllowed(auth.hosts, host, port)) return { refuse: `host ${host}:${port} is not allowed for this run` };
  let addrs;
  try {
    addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    return { refuse: `${host} does not resolve` };
  }
  if (!addrs.length) return { refuse: `${host} does not resolve` };
  // Every address must pass, or a name with one public and one private address picks its own outcome.
  if (addrs.some((a) => isReserved(a.address))) {
    return { refuse: `${host} resolves to a private or internal address` };
  }
  return { ip: addrs[0].address };
}

const server = createServer(async (req, res) => {
  // Origin-form is not proxying: it is the connector asking what was refused (`GET /refusals?run=`), with the secret.
  if (String(req.url).startsWith("/")) {
    const u = new URL(String(req.url), "http://egress");
    if (req.method === "GET" && u.pathname === "/refusals" && secretOk(req.headers["x-egress-secret"])) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refusals: refusalsFor(u.searchParams.get("run") ?? "") }));
    } else {
      res.writeHead(404).end();
    }
    return;
  }
  // Absolute-form: GET https://host/path (axios). The proxy makes the request itself, to the checked address.
  let target;
  try {
    target = new URL(String(req.url));
  } catch {
    res.writeHead(400).end("absolute URL required\n");
    return;
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const auth = verifyProxyAuth(SECRET, req.headers["proxy-authorization"]);
  const d = await decide(auth, target.hostname, port);
  if (d.refuse) {
    log("refused", { run: auth?.runId ?? null, host: target.hostname, port, why: d.refuse });
    recordRefusal(auth?.runId, target.hostname, port, d.refuse);
    res.writeHead(auth ? 403 : 407, { "content-type": "text/plain" }).end(`connector-egress: ${d.refuse}\n`);
    return;
  }
  log("allowed", { run: auth.runId, host: target.hostname, port, form: "absolute" });
  const headers = { ...req.headers, host: target.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(
    { host: d.ip, port, method: req.method, path: target.pathname + target.search, headers, servername: target.hostname },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    log("upstream_error", { host: target.hostname, why: e.message });
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  req.pipe(upstream);
});

server.on("connect", async (req, client, head) => {
  const target = String(req.url ?? "").toLowerCase();
  const at = target.lastIndexOf(":");
  const host = target.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(target.slice(at + 1));
  const auth = verifyProxyAuth(SECRET, req.headers["proxy-authorization"]);
  const d = at > 0 ? await decide(auth, host, port) : { refuse: "bad CONNECT target" };
  if (d.refuse) {
    log("refused", { run: auth?.runId ?? null, host, port, why: d.refuse });
    recordRefusal(auth?.runId, host, port, d.refuse);
    client.end(`HTTP/1.1 ${auth ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\ncontent-type: text/plain\r\n\r\nconnector-egress: ${d.refuse}\n`);
    return;
  }
  log("allowed", { run: auth.runId, host, port, form: "connect" });
  const upstream = connect(port, d.ip, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", (e) => {
    log("upstream_error", { host, why: e.message });
    if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  client.on("error", close);
  upstream.setTimeout(10 * 60_000, close);
});

if (process.argv[1]?.endsWith("egress.mjs")) {
  if (SECRET.length < 16) {
    log("refusing_to_start", { why: "CONNECTOR_EGRESS_SECRET must be set (16+ characters)" });
    process.exit(3);
  }
  server.listen(PORT, () => log("listening", { port: PORT }));
}
