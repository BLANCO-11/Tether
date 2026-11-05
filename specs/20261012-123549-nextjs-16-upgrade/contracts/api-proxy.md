# Contract: the API proxy route

`packages/client/src/app/api/foundry/[...path]/route.ts`. It is the only place in the client that holds
`PARENT_API_KEY`, and every browser call to the API goes through it. Its **behaviour** must not change; only how it
receives its path segments does (`ctx.params` becomes a Promise from Next 15).

## Must remain true

| # | Behaviour | How it is checked |
| :--- | :--- | :--- |
| P-1 | An **unsigned** request is answered `401` JSON **by the route itself**, even when the gate is bypassed (the handler is called directly). | `proxy.test.ts`, existing case — kept green and extended |
| P-2 | The deny-list segments are refused: `test-oracle`, `steps`, `executions`, `mail` (each with its reason). | new case per segment, reaching the handler with a **Promise-shaped** `ctx.params` |
| P-3 | Any other path is forwarded with `PARENT_API_KEY` and the signed `x-foundry-identity` header; **never** `authorization`. | existing forwarding cases |
| P-4 | All six verbs (`GET POST PUT PATCH DELETE` and any other exported) read the path the same way. | one case per exported verb |
| P-5 | The route stays `runtime = "nodejs"` and `dynamic = "force-dynamic"`. | source assertion |
| P-6 | `PARENT_API_KEY` never appears in a response body or header. | existing case |

## Shape change (the only one)

```text
before:  type Ctx = { params: { path: string[] } };            handler: forward(req, ctx.params.path)
after:   type Ctx = { params: Promise<{ path: string[] }> };   handler: async → forward(req, (await ctx.params).path)
```

## Transitional rule

During phase 1 the tests call the handler with **both** shapes (plain object and Promise) so a mistake is attributable;
after phase 1 only the Promise shape is valid and the plain-object case is deleted, not left skipped.

## What fails the contract

- `path` reaching `forward` as `undefined` (an unsigned or signed request then reaches the wrong upstream path or throws).
- A deny-list segment forwarded.
- The route answering a redirect or HTML for an unsigned call.
