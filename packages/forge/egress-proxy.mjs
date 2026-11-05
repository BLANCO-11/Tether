/**
 * forge-egress — the only way out of Forge's network (2026-10-13). Forge's network has no gateway, so a command that
 * ignores the proxy has no route at all; one that uses it reaches the hosts in FORGE_EGRESS_ALLOW (the AI gateway) and
 * nothing else: not Postgres, not the host, not the internet at large.
 *
 * HTTPS only, as a CONNECT tunnel: the proxy sees the host and port, never the traffic, and holds no credential.
 *   FORGE_EGRESS_ALLOW=llm-gateway.example.com:443[,other:443]   (default: the host of LLM_BASE_URL)
 */
import { createServer } from "node:http";
import { connect } from "node:net";

const PORT = Number(process.env.FORGE_EGRESS_PORT ?? 3128);
/** With no list, the AI gateway Foundry itself uses (LLM_BASE_URL): one setting, so the two cannot drift apart. */
function gatewayOf(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "http:" ? 80 : 443)}`;
  } catch {
    return "";
  }
}
const ALLOW = new Set(
  String(process.env.FORGE_EGRESS_ALLOW || gatewayOf(process.env.LLM_BASE_URL ?? ""))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.includes(":") ? s : `${s}:443`)),
);
const log = (event, detail) => console.log(JSON.stringify({ svc: "forge-egress", event, ...detail }));

if (ALLOW.size === 0) {
  log("refusing_to_start", { why: "FORGE_EGRESS_ALLOW is empty: Forge could not reach the AI service" });
  process.exit(3);
}

const server = createServer((req, res) => {
  // Plain HTTP is never forwarded: the gateway is HTTPS, and a plain request would let a command read whatever answers.
  log("refused", { method: req.method, url: String(req.url).slice(0, 200) });
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("Forge can reach the AI service only.\n");
});

server.on("connect", (req, client, head) => {
  const target = String(req.url ?? "").toLowerCase();
  if (!ALLOW.has(target)) {
    log("refused", { target: target.slice(0, 200) });
    client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nForge can reach the AI service only.\n");
    return;
  }
  const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
  const upstream = connect(port, host, () => {
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
    log("upstream_error", { target, why: e.message });
    if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  client.on("error", close);
  upstream.setTimeout(15 * 60_000, close);
});

server.listen(PORT, () => log("listening", { port: PORT, allow: [...ALLOW] }));
