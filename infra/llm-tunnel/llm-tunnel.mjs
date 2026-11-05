/**
 * llm-tunnel — LOCAL DEVELOPMENT ONLY (infra/docker-compose.local-proxy.yml). Never part of a production build.
 *
 * The containers that call the AI gateway (server, forge-egress) are pointed at this one by a hosts entry
 * for the gateway's own name, so nothing in the app changes and TLS stays end to end: this forwards bytes, it never
 * sees the traffic. For EACH new connection it uses the first SOCKS5 proxy on the developer's machine that answers
 * (office, home — whichever is running), and when none does it connects to the gateway directly. Moving between
 * networks needs no restart.
 *
 *   LLM_BASE_URL         the gateway (from .env): its host and port are what is forwarded to
 *   LLM_GATEWAY_HOST     must name the same host — it is what the hosts entries map; a mismatch refuses to start
 *   LLM_SOCKS_PROXIES    host:port,… tried in order (default: the office then the home proxy on the host)
 */
import { createServer, connect } from "node:net";

const log = (event, detail = {}) => console.log(JSON.stringify({ svc: "llm-tunnel", event, ...detail }));

let gateway;
try {
  gateway = new URL(process.env.LLM_BASE_URL ?? "");
} catch {
  log("refusing_to_start", { why: "LLM_BASE_URL is not a URL" });
  process.exit(3);
}
const HOST = gateway.hostname;
const PORT = Number(gateway.port || (gateway.protocol === "http:" ? 80 : 443));
if ((process.env.LLM_GATEWAY_HOST ?? "").toLowerCase() !== HOST.toLowerCase()) {
  log("refusing_to_start", { why: `LLM_GATEWAY_HOST (${process.env.LLM_GATEWAY_HOST ?? ""}) must equal the host of LLM_BASE_URL (${HOST})` });
  process.exit(3);
}
const PROXIES = String(process.env.LLM_SOCKS_PROXIES || "host.docker.internal:1082,host.docker.internal:1081")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => ({ host: s.slice(0, s.lastIndexOf(":")), port: Number(s.slice(s.lastIndexOf(":") + 1)), name: s }));
const CONNECT_MS = 2000;

/** A connection to the gateway through one SOCKS5 proxy (the proxy resolves the name), or a rejection. */
function viaSocks(p) {
  return new Promise((resolve, reject) => {
    const sock = connect(p.port, p.host);
    let buf = Buffer.alloc(0);
    let stage = "greet";
    const fail = (why) => {
      sock.destroy();
      reject(new Error(why));
    };
    sock.setTimeout(CONNECT_MS, () => fail("timeout"));
    sock.on("error", (e) => fail(e.code ?? e.message));
    sock.on("connect", () => sock.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail("socks: no acceptable auth method");
        buf = buf.subarray(2);
        stage = "connect";
        const name = Buffer.from(HOST);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([PORT >> 8, PORT & 255])]));
      }
      if (stage === "connect") {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(`socks: connect refused (code ${buf[1]})`);
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        sock.off("data", onData);
        sock.setTimeout(0);
        sock.removeAllListeners("error");
        resolve({ sock, rest: buf.subarray(len) });
      }
    };
    sock.on("data", onData);
  });
}

function direct() {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, HOST);
    sock.setTimeout(CONNECT_MS * 5, () => {
      sock.destroy();
      reject(new Error("timeout"));
    });
    sock.once("error", (e) => reject(new Error(e.code ?? e.message)));
    sock.once("connect", () => {
      sock.setTimeout(0);
      sock.removeAllListeners("error");
      resolve({ sock, rest: Buffer.alloc(0) });
    });
  });
}

let lastRoute = "";
async function open() {
  for (const p of PROXIES) {
    try {
      return { ...(await viaSocks(p)), route: `socks ${p.name}` };
    } catch {
      // not running here — try the next one
    }
  }
  return { ...(await direct()), route: "direct" };
}

createServer({ pauseOnConnect: true }, async (client) => {
  client.on("error", () => {});
  let upstream;
  try {
    upstream = await open();
  } catch (e) {
    log("unreachable", { why: e.message });
    client.destroy();
    return;
  }
  if (upstream.route !== lastRoute) {
    lastRoute = upstream.route;
    log("route", { via: upstream.route, to: `${HOST}:${PORT}` });
  }
  const { sock } = upstream;
  sock.on("error", () => client.destroy());
  client.on("error", () => sock.destroy());
  if (upstream.rest.length) client.write(upstream.rest);
  sock.pipe(client);
  client.pipe(sock);
  client.resume();
}).listen(PORT, () => log("listening", { port: PORT, gateway: `${HOST}:${PORT}`, proxies: PROXIES.map((p) => p.name) }));
