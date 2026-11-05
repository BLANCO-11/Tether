/**
 * Test-only. The route params a page's mocked `useParams()` returns.
 *
 * Record pages (`/flows/[id]`, `/runs/[id]`, …) read their id with `useParams()` from `next/navigation`, not from a `params`
 * prop (a plain object on Next 14, a Promise on 15, Promise-only on 16 — see `flows/[id]/page.tsx`). A test therefore says
 * WHICH record it is rendering by setting this before it renders: `render(atRoute("f-1", <FlowPage />))`.
 *
 * The mock is `vi.mock("next/navigation", async () => ({ useParams: () => (await import("@/lib/test-route-params")).routeParams.current }))`.
 */
export const routeParams: { current: Record<string, string> } = { current: {} };

/** Set the id the page under test will read, and hand the element back so it can be written inline in `render(...)`. */
export function atRoute<T>(id: string, element: T): T {
  routeParams.current = { id };
  return element;
}
