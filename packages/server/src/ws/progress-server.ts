import { WebSocketServer, WebSocket } from "ws";
import { flowProgressService, type ProgressEvent } from "../services/flow-progress.service.js";

// Parent-side progress WebSocket. ONE channel:
//
//   ws://<host>:<wsPort>/ws/flow-execution?ticket=<t>
//       per-step progress for one flow execution (phase-2.md 2.8).
//
// ── `/ws/generation` was deleted in Phase 4 (task 4.11), and good riddance ───
//
// It streamed a monolithic generation's stage events and it was authorised by
// **nothing** — `?scriptId=<uuid>` and you were subscribed. That is precisely
// the shape D-15 refuses for flow progress: a socket that takes a resource id
// directly is an unauthenticated read path, and knowing an id is not the same
// as being allowed to watch it. It survived only because the thing it streamed
// is gone in this phase; it was never made safe.
//
// The channel that remains redeems a single-use ticket minted by an
// API-key-authenticated route. Anything added here must do the same.
//
// The server is created WITHOUT a `path`, and the path is matched per connection.
// `new WebSocketServer({ path })` accepts exactly one path and 400s everything
// else, so a second channel would otherwise need a second port — and :4001 is the
// one already published by compose.

/** Everything after the path is untrusted input; a bad request is closed, never guessed at. */
const CLOSE_BAD_REQUEST = 1008; // policy violation

export function startProgressServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    switch (url.pathname) {
      case "/ws/flow-execution":
        return handleFlowExecution(ws, url);
      default:
        ws.send(JSON.stringify({ type: "error", message: `unknown channel ${url.pathname}` }));
        return ws.close(CLOSE_BAD_REQUEST, "unknown channel");
    }
  });

  wss.on("listening", () => {
    console.log(`[ws] progress server on :${port} (/ws/flow-execution)`);
  });

  return wss;
}

/**
 * Per-step progress for one flow execution.
 *
 * Authorised by a single-use ticket from `POST …/flow-executions/:id/watch`,
 * which IS parent-API-key authenticated — see the header of
 * `services/flow-progress.service.ts` for why the socket cannot simply take an
 * execution id. The ticket is redeemed here and immediately spent, so the URL in
 * a browser's network log is worthless the moment it has been used.
 *
 * The payload is `flowVisibilityService`'s view, so it is redacted by the same
 * code as the REST route (D-07). This channel must never grow its own assembly.
 */
function handleFlowExecution(ws: WebSocket, url: URL) {
  const ticket = url.searchParams.get("ticket");
  const claims = ticket ? flowProgressService.redeemTicket(ticket) : null;
  if (!claims) {
    // One answer for missing, unknown, expired and already-used. Distinguishing
    // them would say which tickets exist.
    ws.send(JSON.stringify({ type: "error", message: "invalid or expired ticket" }));
    ws.close(CLOSE_BAD_REQUEST, "invalid ticket");
    return;
  }

  const send = (e: ProgressEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  };

  const unsub = flowProgressService.subscribe(claims.workspaceId, claims.flowExecutionId, (e) => {
    send(e);
    // The execution is over; there is nothing further to stream. Closing here
    // rather than leaving the socket open is what stops a finished run from
    // holding a connection until the tab is closed.
    if (e.type === "end") ws.close(1000, "execution finished");
  });

  ws.on("close", unsub);
  ws.on("error", unsub);
}
