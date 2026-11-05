/**
 * The columns a DB operation returns, in its spec's own order.
 *
 * `specJson.columns[].alias` IS the key set of every row the operation returns
 * (`alias` is what the compiled SQL says `AS`; `column` is the fallback for a spec
 * that named no alias). ONE derivation for every reader of it — the manifest's
 * ref interfaces, the drafter's catalogue and the skeleton's — so the three
 * cannot disagree about what an operation gives.
 *
 * `undefined` when the spec carries no `columns` array at all, which is not the
 * same as an operation that returns nothing.
 */
export function operationColumns(specJson: unknown): string[] | undefined {
  const cols = (specJson ?? {}) as { columns?: Array<{ alias?: string; column?: string }> };
  if (!Array.isArray(cols.columns)) return undefined;
  return cols.columns
    .map((c) => c?.alias ?? c?.column)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}
